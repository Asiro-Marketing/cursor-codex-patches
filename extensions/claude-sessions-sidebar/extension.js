const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

const TAIL_BYTES = 64 * 1024; // tail seek size for state classification
const LIVE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // pid-reuse safety guard

// Tools that block on a user choice/selection. When one of these is the last
// unanswered tool_use, the session is waiting on the human (not the model),
// even though stop_reason is 'tool_use'. AskUserQuestion = multi-select / choice
// popup; ExitPlanMode = plan-approval popup. Both must land in the needs-input lane.
const PROMPT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// ===========================================================================
// State-detection core
// (engine validated against 9 live sessions; reused as-is from the TreeView build)
// ===========================================================================

/** /home/example/project -> -home-example-project */
function pathToProjectDir(fsPath) {
  return fsPath.replace(/\//g, '-');
}

/**
 * pid liveness check (POSIX). EPERM = process exists but owned by another user
 * (still alive). ESRCH / anything else = dead.
 */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Read the last `maxBytes` of a file and return its lines in reverse order
 * (most recent first). Drops the first (truncated) line unless we read from
 * the very start. fd always closed in finally.
 */
function readTailLinesReversed(filePath, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return [];
    const readSize = Math.min(maxBytes, stat.size);
    const position = stat.size - readSize;
    const buf = Buffer.alloc(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, position);
    let text = buf.toString('utf8', 0, bytesRead);
    if (position > 0) {
      const firstNl = text.indexOf('\n');
      text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
    }
    return text.split('\n').reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Classify a session's live state from the tail of its jsonl.
 * 'needs-input' : last conversation line is assistant w/ stop_reason=end_turn
 * 'working'     : user (tool_result) line, assistant w/ tool_use/null/missing
 *                 stop_reason, message-less assistant, or jsonl not flushed yet
 * 'unknown'     : jsonl non-empty but no valid conversation line in the tail
 */
function classifyState(sessionId, cwd) {
  const jsonlPath = path.join(PROJECTS_DIR, pathToProjectDir(cwd), `${sessionId}.jsonl`);
  // No jsonl = a shell that was opened but has no conversation yet (idle/empty).
  // Hide it instead of showing a phantom "working" card that never does anything.
  if (!fs.existsSync(jsonlPath)) return 'unknown';

  const lines = readTailLinesReversed(jsonlPath, TAIL_BYTES);
  if (lines.length === 0) return 'unknown';

  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    if (entry.type === 'assistant') {
      // message-less assistant = turn still in flight -> working (don't fall
      // through to an older end_turn line, which would read as needs-input).
      if (!entry.message) return 'working';
      const msg = entry.message;
      // An unanswered prompt tool (AskUserQuestion / ExitPlanMode) is the model
      // blocked on the user's selection. stop_reason is 'tool_use' here, so this
      // must be checked before the generic tool_use -> working fall-through.
      if (msg.stop_reason === 'tool_use' && Array.isArray(msg.content)
          && msg.content.some(b => b && b.type === 'tool_use' && PROMPT_TOOLS.has(b.name))) {
        return 'needs-input';
      }
      return msg.stop_reason === 'end_turn' ? 'needs-input' : 'working';
    }
    // message-less user entry = meta/internal row; keep scanning.
    if (!entry.message) continue;
    // user entry = tool_result sent, model is processing.
    return 'working';
  }
  return 'unknown';
}

/**
 * Scan ~/.claude/sessions/*.json and return alive sessions.
 * -> { pid, sessionId, cwd, entrypoint, startedAt }[]
 */
function readLiveSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const results = [];
  for (const file of files) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!rec || !rec.pid || !rec.sessionId || !rec.cwd) continue;
    const startedAt = rec.startedAt || 0;
    if (Date.now() - startedAt > LIVE_SESSION_MAX_AGE_MS) continue; // pid-reuse guard
    if (!isPidAlive(rec.pid)) continue;
    results.push({
      pid: rec.pid,
      sessionId: rec.sessionId,
      cwd: path.normalize(rec.cwd),
      entrypoint: rec.entrypoint || 'unknown',
      startedAt
    });
  }

  // The same sessionId can appear under multiple registry files (restart /
  // resume spawns a new pid for the same session). Keep one per sessionId,
  // preferring the most recently started process.
  const byId = new Map();
  for (const r of results) {
    const existing = byId.get(r.sessionId);
    if (!existing || r.startedAt > existing.startedAt) byId.set(r.sessionId, r);
  }
  return Array.from(byId.values());
}

// ===========================================================================
// History / display titles
// ===========================================================================

/**
 * Extract the first human user message from a jsonl to use as a display title.
 * Reads only the first 50KB. Handles both array and string `content` shapes.
 */
function extractFirstUserMessage(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(50 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const content = buf.toString('utf8', 0, bytesRead);
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.includes('"type":"user"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'user' || !entry.message || !entry.message.content) continue;

      const c = entry.message.content;
      // content can be a plain string (simple text input) ...
      if (typeof c === 'string') {
        const cleaned = c.replace(/<ide_[^>]*>[\s\S]*?<\/[^>]*>/g, '').trim();
        if (cleaned) return cleaned.slice(0, 100);
        continue;
      }
      // ... or an array of blocks.
      if (Array.isArray(c)) {
        for (const block of c) {
          if (block.type === 'text' && typeof block.text === 'string' && !block.text.startsWith('<ide_')) {
            return block.text.slice(0, 100);
          }
        }
        for (const block of c) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const t = block.text.replace(/<ide_[^>]*>[\s\S]*?<\/[^>]*>/g, '').trim();
            if (t) return t.slice(0, 100);
          }
        }
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

/**
 * Past conversations for a workspace: [{ sessionId, display, timestamp }]
 * (cheap stat pass, then a bounded first-message read on the newest files).
 */
function loadProjectHistory(workspacePath, limit = 60) {
  const dirPath = path.join(PROJECTS_DIR, pathToProjectDir(workspacePath));
  if (!fs.existsSync(dirPath)) return [];

  let entries = [];
  try {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const stat = fs.statSync(filePath);
        entries.push({ sessionId: path.basename(file, '.jsonl'), filePath, timestamp: stat.mtimeMs });
      } catch {}
    }
  } catch {
    return [];
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  if (Number.isFinite(limit)) entries = entries.slice(0, limit);

  return entries.map(e => ({
    sessionId: e.sessionId,
    display: extractFirstUserMessage(e.filePath) || 'Untitled',
    timestamp: e.timestamp
  }));
}

/**
 * Build the view model: live sessions split into needs-input / working lanes,
 * plus recent (non-live) past conversations.
 */
function buildModel(workspacePath, maxRecent) {
  if (!workspacePath) return { needsInput: [], working: [], recent: [] };

  const live = readLiveSessions().filter(s => s.cwd === workspacePath);
  const history = loadProjectHistory(workspacePath);
  const historyMap = new Map(history.map(s => [s.sessionId, s]));

  const needsInput = [];
  const working = [];
  for (const ls of live) {
    const state = classifyState(ls.sessionId, ls.cwd);
    if (state === 'unknown') continue; // don't surface ambiguous sessions
    const h = historyMap.get(ls.sessionId);
    const obj = {
      sessionId: ls.sessionId,
      display: h ? h.display : ls.sessionId.slice(0, 8),
      timestamp: h ? h.timestamp : ls.startedAt,
      entrypoint: ls.entrypoint,
      state
    };
    if (state === 'needs-input') needsInput.push(obj);
    else working.push(obj);
  }

  const liveIds = new Set(live.map(s => s.sessionId));
  const recent = history.filter(s => !liveIds.has(s.sessionId)).slice(0, maxRecent);

  return { needsInput, working, recent };
}

// ===========================================================================
// Session actions
// ===========================================================================

/**
 * Resume a session in the official Claude Code panel.
 *   target 'tab'   -> active editor group
 *   target 'split' -> beside the active group (a fresh editor column)
 *
 * Only `claude-vscode.editor.open(sessionId, initialPrompt, viewColumn)` actually
 * resumes a given session — `window.open` / `sidebar.open` take no args and just
 * start a new conversation, so we route every target through editor.open and vary
 * the ViewColumn instead. Terminal `claude -r` is the fallback if the command
 * isn't available (extension missing / older build).
 */
function resumeSession(sessionId, display, target) {
  if (!sessionId) {
    vscode.window.showWarningMessage('No session ID found');
    return;
  }
  const viewColumn = target === 'split' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, viewColumn)
    .then(undefined, () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const terminal = vscode.window.createTerminal({
        name: `Claude: ${truncate(display || sessionId, 30)}`,
        cwd
      });
      terminal.show();
      terminal.sendText(`claude -r ${sessionId}`);
    });
}

/**
 * Delete a past session's jsonl (the conversation history file). Moves it to the
 * OS trash (useTrash) so it's recoverable, after a modal confirm. Only offered on
 * Recent cards — a live session keeps appending to its jsonl, so deleting it is
 * pointless and the file would just reappear. cwd is the current workspace (the
 * view is workspace-scoped). On success, re-render via the provider.
 */
async function deleteSession(sessionId, display, provider) {
  if (!sessionId) {
    vscode.window.showWarningMessage('No session ID found');
    return;
  }
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    vscode.window.showWarningMessage('No workspace open');
    return;
  }
  const jsonlPath = path.join(PROJECTS_DIR, pathToProjectDir(path.normalize(ws)), `${sessionId}.jsonl`);
  const label = truncate(display || sessionId, 40);
  const choice = await vscode.window.showWarningMessage(
    `セッション「${label}」を削除しますか？`,
    { modal: true, detail: 'jsonl履歴ファイルをゴミ箱に移動します（復元可能）。' },
    'Delete'
  );
  if (choice !== 'Delete') return;
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(jsonlPath), { useTrash: true });
    if (provider) provider.render();
  } catch (e) {
    vscode.window.showErrorMessage('セッション削除に失敗しました: ' + (e && e.message ? e.message : e));
  }
}

function continueSession() {
  vscode.commands.executeCommand('claude-vscode.editor.openLast').then(undefined, () => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({ name: 'Claude: Continue', cwd });
    terminal.show();
    terminal.sendText('claude -c');
  });
}

function truncate(str, len) {
  if (!str) return '';
  str = String(str).replace(/\[Pasted text.*?\]/g, '[paste]').replace(/\n/g, ' ').trim();
  return str.length > len ? str.slice(0, len) + '...' : str;
}

// ===========================================================================
// Webview provider (usage-bar design language: VS Code CSS vars, borders-only,
// tabular-nums, spinner. Lane colors follow the ui-dev palette.)
// ===========================================================================

class SessionsViewProvider {
  constructor() {
    this._views = new Set(); // supports both the activitybar view and the explorer view
  }

  resolveWebviewView(webviewView) {
    this._views.add(webviewView);
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = pageSkeleton();
    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'ready') this.renderOne(webviewView);
      else if (msg.type === 'resume') resumeSession(msg.sessionId, msg.display, msg.target);
      else if (msg.type === 'delete') deleteSession(msg.sessionId, msg.display, this);
      else if (msg.type === 'continue') continueSession();
      else if (msg.type === 'refresh') this.render();
    });
    webviewView.onDidDispose(() => this._views.delete(webviewView));
  }

  render() {
    for (const v of this._views) this.renderOne(v);
  }

  renderOne(view) {
    if (!view || !view.visible) {
      // still post; hidden webviews keep their last DOM via retainContextWhenHidden=false,
      // but posting to an invisible view is a no-op-safe call.
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cfg = vscode.workspace.getConfiguration('claudeSessions');
    const maxRecent = cfg.get('maxRecentSessions', 15);
    let model;
    try {
      model = buildModel(ws ? path.normalize(ws) : null, maxRecent);
    } catch (e) {
      model = { needsInput: [], working: [], recent: [] };
    }
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    try { view.webview.postMessage({ type: 'data', model, time, now: Date.now() }); } catch {}
  }
}

function pageSkeleton() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --dim: var(--vscode-descriptionForeground);
    --hover: rgba(255,255,255,0.035);
    --needs: #f05133;
    --working: rgba(91,141,239,0.95);
    --recent: #26a69a;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:var(--vscode-font-family); color:var(--fg); font-size:12px; padding:4px 0 8px; }
  .lane { margin-bottom:8px; }
  .lane-head {
    display:flex; align-items:center; gap:7px;
    padding:5px 12px 3px; margin-bottom:0;
    font-size:10px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase;
    color:var(--dim);
  }
  .lane-head .dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .lane-head .count {
    margin-left:auto; font-size:10px; font-weight:400;
    font-variant-numeric:tabular-nums; color:var(--dim);
  }
  .lane.needs   .dot { background:var(--needs); }
  .lane.working .dot { background:var(--working); }
  .lane.recent  .dot { background:var(--recent); }

  .card {
    position:relative;
    display:flex; flex-direction:column; gap:2px;
    padding:6px 12px;
    cursor:pointer; transition:background 120ms ease;
  }
  .card:hover { background:var(--hover); }
  .card .actions {
    position:absolute; top:50%; right:7px; transform:translateY(-50%);
    display:flex; gap:3px; opacity:0; transition:opacity 120ms ease;
  }
  .card:hover .actions { opacity:1; }
  .act {
    display:inline-flex; align-items:center; justify-content:center;
    width:19px; height:19px; border-radius:4px; flex-shrink:0; color:var(--dim);
  }
  .act:hover { color:var(--fg); background:rgba(255,255,255,0.09); }
  .act svg { width:13px; height:13px; }

  .card .title {
    font-size:11px; line-height:1.35;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  .card .meta {
    display:flex; align-items:center; gap:6px;
    font-size:9px; color:var(--dim);
  }
  .card .meta .state { font-weight:600; opacity:0.9; }
  .lane.needs .card .meta .state { color:var(--needs); }
  .card .meta .ricon { display:inline-flex; align-items:center; color:var(--needs); }
  .card .meta .ricon svg { width:12px; height:12px; }
  .card .meta .tag {
    opacity:0.6; padding:0 4px; border:1px solid rgba(128,128,128,0.25);
    border-radius:3px; font-size:8px; line-height:13px;
  }

  .spin {
    display:inline-block; width:9px; height:9px; flex-shrink:0;
    border:1.5px solid rgba(91,141,239,0.3);
    border-top-color:var(--working); border-radius:50%;
    animation:spin .7s linear infinite;
  }
  @keyframes spin { to { transform:rotate(360deg); } }

  .updated { font-size:9px; color:var(--dim); text-align:right; padding:6px 12px 0; opacity:0.5; }
  .empty { font-size:11px; color:var(--dim); text-align:center; padding:24px 12px; opacity:0.7; line-height:1.6; }
  .loading { display:flex; justify-content:center; padding:24px 0; }
</style></head>
<body>
  <div id="app"><div class="loading"><div class="spin"></div></div></div>
<script>
  const vscode = acquireVsCodeApi();
  let NOW = Date.now();

  // "split editor" icon (a pane divided by a vertical line) -> open beside
  const SPLIT_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.5" width="12" height="9" rx="1"/><line x1="8" y1="3.5" x2="8" y2="12.5"/></svg>';
  // reply / "your turn" mark for needs-input cards
  const REPLY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4 3 7.5 6.5 11"/><path d="M3 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v1.5"/></svg>';
  // trash icon -> delete a recent (non-live) session's history
  const TRASH_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10"/><path d="M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3"/><path d="M4.2 4.5l.6 8a.8.8 0 0 0 .8.75h4.8a.8.8 0 0 0 .8-.75l.6-8"/><path d="M6.7 7v4M9.3 7v4"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function relTime(ts) {
    if (!ts) return '';
    const d = NOW - ts;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h';
    if (d < 604800000) return Math.floor(d / 86400000) + 'd';
    return new Date(ts).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
  }
  function tag(s) {
    return (s.entrypoint && s.entrypoint !== 'unknown')
      ? '<span class="tag">' + esc(s.entrypoint) + '</span>' : '';
  }
  function card(s, cls) {
    let meta;
    const rt = relTime(s.timestamp);
    const age = rt ? '<span class="age">' + esc(rt) + '</span>' : '';
    if (cls === 'working') meta = '<span class="spin"></span><span class="state">Working</span>' + age + tag(s);
    else if (cls === 'needs') meta = '<span class="ricon">' + REPLY_SVG + '</span>' + age + tag(s);
    else meta = '<span>' + esc(rt) + '</span>' + tag(s);
    // Recent (non-live) cards also get a delete action. Live cards (working /
    // needs) don't — their jsonl is actively being written.
    const del = cls === 'recent'
      ? '<span class="act act-delete" title="削除">' + TRASH_SVG + '</span>' : '';
    return '<div class="card" data-sid="' + esc(s.sessionId) + '" data-display="' + esc(s.display) + '">'
      + '<div class="title">' + esc(s.display || 'Untitled') + '</div>'
      + '<div class="meta">' + meta + '</div>'
      + '<div class="actions"><span class="act act-split" title="右に分割して開く">' + SPLIT_SVG + '</span>' + del + '</div>'
      + '</div>';
  }
  function lane(cls, label, items) {
    if (!items.length) return '';
    return '<div class="lane ' + cls + '"><div class="lane-head"><span class="dot"></span>'
      + label + '<span class="count">' + items.length + '</span></div>'
      + items.map(s => card(s, cls)).join('') + '</div>';
  }
  function render(model, time) {
    const app = document.getElementById('app');
    const total = model.needsInput.length + model.working.length + model.recent.length;
    if (total === 0) {
      app.innerHTML = '<div class="empty">アクティブなセッションなし<br>Claude Codeを起動すると<br>ここに出ます</div>';
      return;
    }
    let h = '';
    h += lane('needs', 'Needs input', model.needsInput);
    h += lane('working', 'Working', model.working);
    h += lane('recent', 'Recent', model.recent);
    h += '<div class="updated">' + esc(time) + ' updated</div>';
    app.innerHTML = h;
  }
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'data') { NOW = m.now || Date.now(); render(m.model, m.time); }
  });
  document.addEventListener('click', e => {
    // hover action: delete this session's history (recent cards only).
    const del = e.target.closest('.act-delete');
    if (del) {
      const c = del.closest('.card');
      vscode.postMessage({ type: 'delete', sessionId: c.dataset.sid, display: c.dataset.display });
      e.stopPropagation();
      return;
    }
    // hover action: open beside (split). Card body click: open in a new tab.
    const split = e.target.closest('.act-split');
    if (split) {
      const c = split.closest('.card');
      vscode.postMessage({ type: 'resume', sessionId: c.dataset.sid, display: c.dataset.display, target: 'split' });
      e.stopPropagation();
      return;
    }
    const c = e.target.closest('.card');
    if (c) { vscode.postMessage({ type: 'resume', sessionId: c.dataset.sid, display: c.dataset.display, target: 'tab' }); }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}

// ===========================================================================
// Activation
// ===========================================================================

function activate(context) {
  const provider = new SessionsViewProvider();

  const cfg = vscode.workspace.getConfiguration('claudeSessions');
  const pollingMs = Math.max(1000, cfg.get('pollingInterval', 2500));
  const timer = setInterval(() => provider.render(), pollingMs);

  // fs.watch gives near-instant refresh when a message lands; polling covers
  // pid liveness, which fs.watch cannot observe.
  let watcher;
  try {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
      const projDir = path.join(PROJECTS_DIR, pathToProjectDir(ws));
      if (fs.existsSync(projDir)) {
        watcher = fs.watch(projDir, () => provider.render());
      }
    }
  } catch (e) {
    console.error('Claude Sessions: watcher setup failed', e);
  }

  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    { dispose: () => { if (watcher) watcher.close(); } },
    vscode.window.registerWebviewViewProvider('claudeSessions', provider),
    vscode.window.registerWebviewViewProvider('claudeSessionsExplorer', provider),
    vscode.commands.registerCommand('claudeSessions.refresh', () => provider.render()),
    vscode.commands.registerCommand('claudeSessions.resume', (s) => resumeSession(s?.sessionId, s?.display)),
    vscode.commands.registerCommand('claudeSessions.delete', (s) => deleteSession(s?.sessionId, s?.display, provider)),
    vscode.commands.registerCommand('claudeSessions.continue', () => continueSession())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
// Exposed for offline unit testing (no vscode runtime needed for the core).
module.exports._test = {
  classifyState, readLiveSessions, extractFirstUserMessage,
  loadProjectHistory, buildModel, isPidAlive, readTailLinesReversed, pathToProjectDir
};
