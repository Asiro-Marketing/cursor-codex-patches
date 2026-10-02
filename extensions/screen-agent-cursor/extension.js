// Screen Agent — Cursor extension
// v0.2: chats open as editor-column webview panels.
// Multiple panels can run in parallel, each with its own Claude Code process.

const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const CLAUDE_BIN = process.env.CLAUDE_BIN
  || path.join(os.homedir(), '.local/bin/claude');

// Screen Agent — readability nudge appended to every session's system prompt.
// Keep concise; Claude already obeys CLAUDE.md. This is about *display* in the chat panel.
const READABILITY_PROMPT = [
  '## Screen Agent chat — 出力スタイル',
  '応答は Cursor 内のチャット枠に Markdown でレンダリングされる。読みやすさを優先して：',
  '',
  '- 要点・重要語句は **太字** で強調する',
  '- 手順や複数項目は箇条書き（`-` / `1.`）で並べる',
  '- 比較・選択肢は表（`|`）にまとめる',
  '- セクションが変わる時は見出し（`##` / `###`）で区切る',
  '- コード・ファイル名・コマンドは `inline code` または ```` ```fence ```` で囲む',
  '- 長文になる時は先頭に結論の一文、続けて根拠/詳細の順に書く',
  '- 一文ダラダラを避け、短い文で意味を区切る',
].join('\n');

function buildPath(env) {
  return [
    env.PATH,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local/bin'),
  ].filter(Boolean).join(':');
}

// ---------- Per-panel Claude process wrapper ----------
class ClaudeSession {
  constructor() {
    this.proc = null;
    this.info = null;    // { cwd, resumeId, liveSessionId }
    this.listener = null;
    this.buffer = '';
  }

  setListener(fn) { this.listener = fn; }

  sameIdentity(cwd, resumeId, opts = {}) {
    if (!this.proc || this.proc.exitCode !== null) return false;
    if (this.info?.cwd !== cwd) return false;
    if (this.info.mode !== (opts.mode || 'acceptEdits')) return false;
    if (this.info.model !== (opts.model || null)) return false;
    if (this.info.effort !== (opts.effort || null)) return false;
    if (this.info.resumeId === resumeId) return true;
    if (this.info.resumeId == null && this.info.liveSessionId === resumeId) return true;
    return false;
  }

  spawn({ cwd, resumeId, mode, model, effort }) {
    this.kill();
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', mode || 'acceptEdits',
      // Nudge Claude toward readable, well-structured responses in the webview chat
      '--append-system-prompt', READABILITY_PROMPT,
    ];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (resumeId) args.push('--resume', resumeId);
    const env = { ...process.env, PATH: buildPath(process.env) };
    const proc = spawn(CLAUDE_BIN, args, { cwd, env });
    this.proc = proc;
    this.info = {
      cwd,
      resumeId,
      liveSessionId: null,
      mode: mode || 'acceptEdits',
      model: model || null,
      effort: effort || null,
    };
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
          this.info.liveSessionId = parsed.session_id;
        }
        const cb = this.listener;
        if (!cb) continue;
        if (parsed) cb({ kind: 'msg', data: parsed });
        else cb({ kind: 'log', data: line });
      }
    });
    proc.stderr.on('data', (c) => this.listener?.({ kind: 'stderr', data: c.toString('utf8') }));
    proc.on('close', (code) => {
      this.listener?.({ kind: 'done', code });
      if (this.proc === proc) { this.proc = null; this.info = null; }
    });
    proc.on('error', (err) => this.listener?.({ kind: 'error', data: err.message }));
  }

  send({ question, cwd, resumeId, editorContext, mode, model, effort, includeContext }) {
    if (!this.sameIdentity(cwd, resumeId, { mode, model, effort })) {
      this.spawn({ cwd, resumeId, mode, model, effort });
    }
    // Only inject editor context when the caller explicitly opts in (e.g., "Ask about selection").
    // Otherwise pass the raw question — Claude Code discovers context via its own tools, like the terminal app.
    let prompt = question;
    if (includeContext && editorContext?.file) {
      const parts = [`現在開いてるファイル: ${editorContext.file}`];
      if (editorContext.selection) {
        parts.push('', '選択中のコード:', '```', editorContext.selection, '```');
      }
      parts.push('', '## 質問', question);
      prompt = parts.join('\n');
    }
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    };
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      this.listener?.({ kind: 'error', data: `stdin write failed: ${e.message}` });
    }
  }

  kill() {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch {}
      this.proc = null;
      this.info = null;
    }
  }
}

// ---------- ChatPanel: one webview editor panel ----------
const VIEW_TYPE = 'screenAgent.chat';
let panelCounter = 0;

class ChatPanel {
  constructor(panel, context) {
    this.panel = panel;
    this.context = context;
    this.claude = new ClaudeSession();
    this.disposables = [];
    panelCounter += 1;
    this.panelIndex = panelCounter;

    // Panel-local settings — defaults match Claude Code CLI defaults
    this.settings = {
      mode: 'default',  // Claude Code's default permission mode (asks before changes)
      model: null,      // null = inherit Claude Code default
      effort: null,     // null = inherit Claude Code default (don't force high)
    };

    this.claude.setListener((evt) => {
      this.post({ type: 'claudeEvent', payload: evt });
    });

    panel.webview.html = renderHtml(panel.webview, context);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Prewarm claude so the first send is instant
    this.prewarm();

    // Update title when panel receives a session title
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg'),
      dark:  vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg'),
    };
  }

  post(msg) {
    try { this.panel.webview.postMessage(msg); } catch {}
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'send': return this.onSend(msg);
      case 'stop': return this.claude.kill();
      case 'newChat': return this.onNewChat();
      case 'saveSession': return saveSession(this.context, msg.session);
      case 'listSessions': return this.post({ type: 'sessionsList', payload: listSessions(this.context) });
      case 'getSession': return this.post({ type: 'sessionData', payload: getSession(this.context, msg.id) });
      case 'deleteSession': return deleteSession(this.context, msg.id);
      case 'getEditorContext': return this.post({ type: 'editorContext', payload: captureEditorContext() });
      case 'setTitle': return this.updateTitle(msg.title);
      case 'updateSettings': return this.updateSettings(msg.settings);
      case 'prewarm': return this.prewarm();
    }
  }

  updateSettings(next) {
    const merged = { ...this.settings, ...(next || {}) };
    const changed = JSON.stringify(merged) !== JSON.stringify(this.settings);
    this.settings = merged;
    // Respawn only when the active process's config diverges
    if (changed) this.prewarm();
  }

  prewarm() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    if (this.claude.sameIdentity(cwd, null, this.settings)) return;
    this.claude.spawn({
      cwd,
      resumeId: null,
      mode: this.settings.mode,
      model: this.settings.model,
      effort: this.settings.effort,
    });
  }

  updateTitle(t) {
    const short = (t || '').slice(0, 32).replace(/\s+/g, ' ');
    this.panel.title = short ? `Chat · ${short}` : `Chat ${this.panelIndex}`;
  }

  onSend({ question, resumeId, includeContext }) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    const editorContext = includeContext ? captureEditorContext() : null;
    const { mode, model, effort } = this.settings;
    this.claude.send({ question, cwd, resumeId, editorContext, mode, model, effort, includeContext });
  }

  onNewChat() {
    // A Claude process is bound to one conversation; reset by respawning a fresh warm one.
    this.claude.kill();
    this.prewarm();
    this.post({ type: 'newChatAck' });
  }

  focus() {
    this.panel.reveal(this.panel.viewColumn, false);
    this.post({ type: 'focusInput' });
  }

  dispose() {
    this.claude.kill();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try { d?.dispose(); } catch {}
    }
  }
}

// ---------- Sessions in globalState ----------
const SESSIONS_KEY = 'screenAgent.sessions';

function listSessions(context) {
  const all = context.globalState.get(SESSIONS_KEY, {});
  return Object.values(all).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}
function saveSession(context, session) {
  const all = context.globalState.get(SESSIONS_KEY, {});
  all[session.id] = session;
  return context.globalState.update(SESSIONS_KEY, all);
}
function getSession(context, id) {
  const all = context.globalState.get(SESSIONS_KEY, {});
  return all[id] || null;
}
function deleteSession(context, id) {
  const all = context.globalState.get(SESSIONS_KEY, {});
  delete all[id];
  return context.globalState.update(SESSIONS_KEY, all);
}

// ---------- Editor context ----------
function captureEditorContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const doc = editor.document;
  if (doc.uri.scheme !== 'file') return null; // skip webview/untitled
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const rel = folder ? path.relative(folder, doc.uri.fsPath) : doc.uri.fsPath;
  const sel = editor.selection;
  const selectionText = sel && !sel.isEmpty ? doc.getText(sel) : null;
  return {
    file: rel,
    languageId: doc.languageId,
    selection: selectionText,
  };
}

// ---------- Webview HTML ----------
function renderHtml(webview, context) {
  const file = (f) => webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'webview', f)
  );
  const nonce = Math.random().toString(36).slice(2);
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data: https:`,
    `media-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${file('style.css')}" />
  <title>Screen Agent</title>
</head>
<body>
  <header class="app-head">
    <div class="head-left">
      <svg class="mark-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
        <path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"/>
      </svg>
      <span class="head-title">screen agent</span>
    </div>
    <div class="head-right">
      <button class="icon-btn" id="btn-history" title="過去のセッション">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="5.5"/>
          <path d="M8 5v3.2l2.1 1.5"/>
        </svg>
      </button>
      <button class="icon-btn" id="btn-new" title="新しい会話 (⌘N)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3.5v9M3.5 8h9"/>
        </svg>
      </button>
    </div>
  </header>

  <div class="statusbar idle" id="statusbar">
    <span class="dot"></span>
    <span id="status-text">ready</span>
    <span class="meta" id="status-meta"></span>
  </div>

  <main class="chat">
    <div class="messages" id="messages">
      <div class="empty-state" id="empty-state">
        <video class="clawd-hero" id="clawd-hero" src="${file('clawd-laptop.webm')}" autoplay muted playsinline></video>
        <div class="empty-title">ask about your code</div>
        <div class="empty-sub">現在のファイル・選択範囲を自動でコンテキストに付けるデビ</div>
      </div>
    </div>

    <!-- History panel (slides over messages area) -->
    <div class="history-panel" id="history-panel" aria-hidden="true">
      <div class="history-inner">
        <div class="history-head">
          <div class="history-label">past sessions</div>
          <button class="icon-btn" id="history-close"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        </div>
        <div class="history-list" id="history-list"></div>
        <div class="history-hint">右クリで削除</div>
      </div>
    </div>

    <div class="composer" id="composer">
      <div class="context-chip" id="context-chip"></div>
      <div class="composer-row">
        <textarea id="question" rows="1" placeholder="何を頼む？  (⌘enter で送信 / / でコマンド)"></textarea>
        <button class="send-btn" id="btn-submit" disabled title="Send (⌘Enter)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>
          </svg>
        </button>
        <button class="send-btn stop" id="btn-stop" disabled title="Stop">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <rect x="4.5" y="4.5" width="7" height="7" rx="1"/>
          </svg>
        </button>
      </div>
      <div class="settings-row" id="settings-row">
        <button class="setting-pill" id="pill-mode"   data-setting="mode"></button>
        <button class="setting-pill" id="pill-model"  data-setting="model"></button>
        <button class="setting-pill" id="pill-effort" data-setting="effort"></button>
      </div>
      <!-- Slash command menu -->
      <div class="slash-menu" id="slash-menu" aria-hidden="true"></div>
      <!-- Setting popover menu -->
      <div class="setting-menu" id="setting-menu" aria-hidden="true"></div>
    </div>
  </main>

  <script nonce="${nonce}" src="${file('marked.js')}"></script>
  <script nonce="${nonce}" src="${file('renderer.js')}"></script>
</body>
</html>`;
}

// ---------- Factory + open logic ----------
function openChatPanel(context, { viewColumn } = {}) {
  const column = viewColumn || vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.Active;
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `Chat ${panelCounter + 1}`,
    column,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'webview'),
        vscode.Uri.joinPath(context.extensionUri, 'media'),
      ],
    }
  );
  return new ChatPanel(panel, context);
}

// ---------- Activation ----------
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('screenAgent.newChat', () => {
      openChatPanel(context);
    }),
    vscode.commands.registerCommand('screenAgent.sendSelection', async () => {
      // If a panel exists, just focus it; renderer pulls selection on send.
      // Otherwise open a new one.
      openChatPanel(context);
    }),
  );

  // Restore panels created before a reload (retainContextWhenHidden doesn't survive reload;
  // we just register a serializer so VS Code doesn't complain about ghost webviews)
  vscode.window.registerWebviewPanelSerializer?.(VIEW_TYPE, {
    async deserializeWebviewPanel(panel, _state) {
      new ChatPanel(panel, context);
    }
  });
}

function deactivate() {
  // Per-panel processes are cleaned up by their dispose handlers.
}

module.exports = { activate, deactivate };
