// Claude Chat — minimal Cursor / VS Code extension that opens a webview panel
// with a chat against the `claude` CLI. Supports drag-and-drop file attachment
// (PDFs, images, anything Claude's Read tool can open) by writing the absolute
// paths into the prompt for Claude to load via its Read tool.

const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CLAUDE_BIN = process.env.CLAUDE_BIN
  || path.join(os.homedir(), '.local/bin/claude');

function buildPath(env) {
  return [
    env.PATH,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local/bin'),
  ].filter(Boolean).join(':');
}

// ------------- Prompt builder -------------

function buildPromptText({ attachments, question }) {
  const items = Array.isArray(attachments) ? attachments : [];
  if (items.length === 0) return question;
  const labelFor = (a) => {
    if (a.kind === 'image') return '画像';
    if (a.kind === 'video') return '動画';
    return `添付ファイル${a.name ? `（${a.name}）` : ''}`;
  };
  const assetLines = items.map((a) => `- ${labelFor(a)}: ${a.path}`);
  return [
    '以下の添付ファイルについて、ユーザーの質問に答えてください。',
    '',
    ...assetLines,
    '',
    '## ユーザーの質問',
    question || '（質問なし — 添付の内容を要約してください）',
    '',
    '## 指示',
    '- まずReadツールで各ファイルを読み込んで内容を把握してください（PDFはReadツールがそのまま読めます）',
    '- 必要に応じて関連ファイルを調査し、具体的な解決策を提示してください',
  ].join('\n');
}

// ------------- Claude session wrapper -------------

class ClaudeSession {
  constructor() {
    this.proc = null;
    this.cwd = null;
    this.resumeId = null;
    this.liveSessionId = null;
    this.listener = null;
    this.buffer = '';
  }
  setListener(fn) { this.listener = fn; }
  isAlive() { return this.proc && this.proc.exitCode === null; }

  spawn(cwd) {
    this.kill();
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      // Disable external MCP servers so OAuth prompts don't pop on every spawn.
      '--mcp-config', '{"mcpServers":{}}',
      '--strict-mcp-config',
    ];
    if (this.resumeId) args.push('--resume', this.resumeId);
    const env = { ...process.env, PATH: buildPath(process.env) };
    const proc = spawn(CLAUDE_BIN, args, { cwd, env });
    this.proc = proc;
    this.cwd = cwd;
    this.buffer = '';

    proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed = null;
        try { parsed = JSON.parse(line); } catch {}
        if (parsed && parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          this.liveSessionId = parsed.session_id;
        }
        if (this.listener) {
          this.listener(parsed ? { kind: 'msg', data: parsed } : { kind: 'log', data: line });
        }
      }
    });
    proc.stderr.on('data', (c) => {
      if (this.listener) this.listener({ kind: 'stderr', data: c.toString('utf8') });
    });
    proc.on('close', (code) => {
      if (this.listener) this.listener({ kind: 'done', code });
      this.proc = null;
    });
    proc.on('error', (err) => {
      if (this.listener) this.listener({ kind: 'error', data: err.message });
    });
  }

  send(prompt) {
    if (!this.isAlive()) throw new Error('claude process not running');
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  kill() {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch {}
      this.proc = null;
    }
  }
}

// ------------- Webview panel -------------

function getWorkspaceCwd() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return os.homedir();
}

function openPanel(context) {
  const panel = vscode.window.createWebviewPanel(
    'claudeChat',
    'Claude Chat',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'webview'))],
    },
  );

  const session = new ClaudeSession();
  panel.onDidDispose(() => session.kill());

  session.setListener((evt) => {
    try { panel.webview.postMessage({ kind: 'claude-event', evt }); } catch {}
  });

  panel.webview.html = renderHtml(panel.webview, context);

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.type === 'run') {
        const { question, attachments } = msg;
        const cwd = getWorkspaceCwd();
        if (!session.isAlive() || session.cwd !== cwd) session.spawn(cwd);
        const prompt = buildPromptText({ question, attachments });
        session.send(prompt);
      } else if (msg.type === 'stop') {
        session.kill();
      } else if (msg.type === 'read-image-data-url') {
        const p = msg.path;
        const dataUrl = readImageDataUrl(p);
        panel.webview.postMessage({ kind: 'image-data-url', requestId: msg.requestId, dataUrl });
      } else if (msg.type === 'open-path') {
        if (msg.path) vscode.env.openExternal(vscode.Uri.file(msg.path));
      }
    } catch (e) {
      panel.webview.postMessage({ kind: 'extension-error', message: e.message });
    }
  });
}

function readImageDataUrl(p) {
  try {
    const buf = fs.readFileSync(p);
    const ext = (path.extname(p) || '.png').slice(1).toLowerCase();
    const mime = ({ jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' })[ext] || 'png';
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function renderHtml(webview, context) {
  const base = vscode.Uri.file(path.join(context.extensionPath, 'webview'));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'style.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'renderer.js'));
  const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'marked.js'));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${cssUri}">
  <title>Claude Chat</title>
</head>
<body>
  <div id="root">
    <div id="messages"></div>
    <form id="composer" class="composer">
      <div id="chips" class="chips"></div>
      <div class="input-row">
        <textarea id="input" rows="2" placeholder="Claude に聞く... (PDF などを drag & drop して添付)"></textarea>
      </div>
      <div class="action-row">
        <span id="status" class="status idle">待機中</span>
        <div class="spacer"></div>
        <button type="button" id="btn-stop" disabled>停止</button>
        <button type="submit" id="btn-send" disabled>送信 ⌘↵</button>
      </div>
    </form>
  </div>
  <script src="${markedUri}"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
}

// ------------- Activation -------------

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeChat.open', () => openPanel(context)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
