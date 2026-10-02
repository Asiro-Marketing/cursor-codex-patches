const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function usageError(message, code, waitSec) {
  return Object.assign(new Error(message), { code, waitSec });
}

function findCodexExecutable(configured) {
  const candidates = configured ? [configured] : [
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    path.join(os.homedir(), '.local/bin/codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
  ];
  return candidates.find(candidate => {
    if (!path.isAbsolute(candidate)) return false;
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch { return false; }
  });
}

function normalizeCodexUsage(result) {
  const limit = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!limit || (limit.limitId && limit.limitId !== 'codex')) return [];
  return [limit.primary, limit.secondary].filter(window => Number.isFinite(window?.usedPercent)).map(window => {
    const minutes = window.windowDurationMins;
    const label = minutes === 10080 ? 'Weekly' : minutes > 0 && minutes < 1440 ? 'Session' : 'Usage';
    const tag = !Number.isFinite(minutes) || minutes <= 0 ? '' : minutes % 1440 === 0
      ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
    const reset = Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? new Date(window.resetsAt * 1000) : null;
    return { label, tag, utilization: Math.round(Math.min(100, Math.max(0, window.usedPercent))),
      resets_at: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null, accent: 'blue' };
  });
}

// Official app-server reads only. Codex owns authentication; no credentials or model turns here.
function fetchCodexUsage({ executable, signal, timeoutMs = 20000 } = {}) {
  const binary = findCodexExecutable(executable);
  if (!binary) return Promise.reject(usageError('Codex CLIが見つかりません。設定でパスを指定してください', 'missing-cli'));
  if (signal?.aborted) return Promise.reject(usageError('取得を中止しました', 'cancelled'));
  return new Promise((resolve, reject) => {
    let child;
    let done = false;
    let buffer = '';
    let deadline;
    const cancel = () => finish(usageError('取得を中止しました', 'cancelled'));
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      child?.stdin.destroy();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const cleanup = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 1000);
        cleanup.unref();
        child.once('close', () => clearTimeout(cleanup));
      }
      error ? reject(error) : resolve(result);
    };
    const send = message => {
      if (!done) child.stdin.write(JSON.stringify(message) + '\n', error => {
        if (error) finish(usageError('Codexとの通信に失敗しました', 'io'));
      });
    };
    const receive = message => {
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) {
        const detail = String(message.error.message || '').toLowerCase();
        if (/429|too many requests/.test(detail)) finish(usageError('レート制限中', 429, 900));
        else if (/auth|log in|401/.test(detail)) finish(usageError('Codexでログインしてください', 'auth'));
        else finish(usageError('Codexの使用量を取得できません', 'upstream'));
      } else if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else {
        const entries = normalizeCodexUsage(message.result);
        finish(entries.length ? null : usageError('このアカウントの利用枠は取得できません', 'no-limits'), entries);
      }
    };
    try {
      child = spawn(binary, ['app-server', '--stdio'], {
        cwd: os.homedir(), stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
      });
    } catch { finish(usageError('Codex CLIを起動できません', 'spawn')); return; }
    deadline = setTimeout(() => finish(usageError('Codexの取得がタイムアウトしました', 'timeout')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', () => finish(usageError('Codex CLIを起動できません', 'spawn')));
    child.stdin.on('error', () => finish(usageError('Codexとの通信に失敗しました', 'io')));
    child.on('close', () => finish(usageError('Codexの使用量を取得できません', 'closed')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > 1048576) { finish(usageError('Codexの応答を読み取れません', 'invalid')); return; }
      let newline;
      while (!done && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { receive(JSON.parse(line)); }
        catch { finish(usageError('Codexの応答を読み取れません', 'invalid')); }
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'claude_usage_cursor', title: 'Claude Usage', version: '0.4.0' },
    } });
  });
}

module.exports = { fetchCodexUsage, normalizeCodexUsage };
