const vscode = require('vscode');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const https = require('node:https');
const { fetchCodexUsage } = require('./codex-usage');
const { createUsageState, refreshUsageState } = require('./usage-state');
const { buildHtml } = require('./usage-view');

const execFileAsync = promisify(execFile);
const states = { claude: createUsageState(), codex: createUsageState() };
const activeRequests = new Set();
let refreshTimer;
let disposed = false;

class UsageViewProvider {
  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: false };
    view.onDidDispose(() => { if (this._view === view) this._view = null; });
    this.render();
    fetchAndUpdate(this, false);
  }

  render() {
    if (!disposed && this._view) this._view.webview.html = buildHtml(states);
  }
}

async function getAccessToken() {
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-w',
    ], { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(stdout).claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

function fetchUsage(token, signal) {
  return new Promise((resolve, reject) => {
    const request = https.request('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', signal,
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    }, response => {
      let body = '';
      response.on('error', reject);
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1048576) request.destroy(new Error('応答サイズが大きすぎます'));
      });
      response.on('end', () => {
        if (response.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Claudeの応答を読み取れません')); }
        } else if (response.statusCode === 429) {
          const wait = parseInt(response.headers['retry-after'], 10);
          reject(Object.assign(new Error('レート制限中'), { code: 429, waitSec: wait > 0 ? wait : 900 }));
        } else {
          reject(new Error(response.statusCode === 401 ? 'Claude Codeでログインしてください' : `Claudeの取得に失敗（HTTP ${response.statusCode}）`));
        }
      });
    });
    request.on('error', error => reject(signal.aborted ? Object.assign(new Error('取得を中止しました'), { code: 'cancelled' }) : error));
    request.setTimeout(10000, () => request.destroy(new Error('Claudeの取得がタイムアウトしました')));
    request.end();
  });
}

async function readProvider(name) {
  const controller = new AbortController();
  activeRequests.add(controller);
  try {
    if (name === 'codex') {
      const executable = vscode.workspace.getConfiguration('claudeUsageBar').get('codexExecutablePath', '');
      return await fetchCodexUsage({ executable, signal: controller.signal });
    }
    const token = await getAccessToken();
    if (!token) throw new Error('Claude Codeの認証情報なし');
    return await fetchUsage(token, controller.signal);
  } finally { activeRequests.delete(controller); }
}

async function fetchAndUpdate(provider, force) {
  if (disposed) return;
  await Promise.all(Object.keys(states).map(name => refreshUsageState(
    states[name], () => readProvider(name), () => provider.render(), force,
  )));
}

function activate(context) {
  disposed = false;
  const provider = new UsageViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeUsageView', provider));
  context.subscriptions.push(vscode.commands.registerCommand('claudeUsage.refresh', () => fetchAndUpdate(provider, true)));
  const startTimer = () => {
    clearInterval(refreshTimer);
    const seconds = vscode.workspace.getConfiguration('claudeUsageBar').get('refreshIntervalSeconds', 120);
    refreshTimer = setInterval(() => fetchAndUpdate(provider, false), Math.max(Number(seconds) || 120, 60) * 1000);
  };
  startTimer();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('claudeUsageBar.refreshIntervalSeconds')) startTimer();
    if (event.affectsConfiguration('claudeUsageBar.codexExecutablePath')) {
      states.codex.backoffUntil = 0;
      fetchAndUpdate(provider, true);
    }
  }));
  context.subscriptions.push({ dispose: deactivate });
}

function deactivate() {
  disposed = true;
  clearInterval(refreshTimer);
  for (const request of activeRequests) request.abort();
}

module.exports = { activate, deactivate };
