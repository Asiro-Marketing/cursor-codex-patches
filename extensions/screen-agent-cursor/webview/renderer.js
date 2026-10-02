// Screen Agent webview renderer (for Cursor/VS Code)
// Talks to the extension host via vscode.postMessage.

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (sel) => document.querySelector(sel);

  const els = {
    messages: $('#messages'),
    emptyState: $('#empty-state'),
    clawdHero: $('#clawd-hero'),
    composer: $('#composer'),
    contextChip: $('#context-chip'),
    question: $('#question'),
    btnSubmit: $('#btn-submit'),
    btnStop: $('#btn-stop'),
    btnNew: $('#btn-new'),
    btnHistory: $('#btn-history'),
    historyPanel: $('#history-panel'),
    historyList: $('#history-list'),
    historyClose: $('#history-close'),
    slashMenu: $('#slash-menu'),
    statusbar: $('#statusbar'),
    statusText: $('#status-text'),
    statusMeta: $('#status-meta'),
    pillMode: $('#pill-mode'),
    pillModel: $('#pill-model'),
    pillEffort: $('#pill-effort'),
    settingMenu: $('#setting-menu'),
  };

  // ---------- Setting options with SVG icons ----------
  // Claude "flower" mark — 4-petal spark used as brand across model options
  const flowerSvg = (size = 14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">
    <path d="M12 1 Q13 9 21 10.5 Q23 12 21 13.5 Q13 15 12 23 Q11 15 3 13.5 Q1 12 3 10.5 Q11 9 12 1 Z"/>
  </svg>`;
  const flowerOutline = (size = 14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 2 Q13 9 21 11 Q22.5 12 21 13 Q13 15 12 22 Q11 15 3 13 Q1.5 12 3 11 Q11 9 12 2 Z"/>
  </svg>`;

  const ICONS = {
    // mode
    acceptEdits:       `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2-8 8H3.5v-2z"/><path d="M2.5 14h11"/></svg>`,
    plan:              `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2.5" width="10" height="11" rx="1"/><path d="M6 2v2h4V2M5.5 7h5M5.5 9.5h3"/></svg>`,
    auto:              `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2L3.5 3.5M8 1v2M11 2l1.5 1.5M13.5 8h-2M11 14l1.5-1.5M8 15v-2M5 14l-1.5-1.5M2.5 8h2"/><circle cx="8" cy="8" r="3"/></svg>`,
    default:           `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>`,
    dontAsk:           `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L2.5 4v3.5c0 3 2.5 5.5 5.5 7 3-1.5 5.5-4 5.5-7V4z"/></svg>`,
    bypassPermissions: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9 1L3 9h4l-1 6 6-8H8z"/></svg>`,

    // model — flower variants
    modelDefault: flowerOutline(14),
    opus: `<span class="ico-stack">${flowerSvg(14)}<span class="ico-dot"></span><span class="ico-dot ico-dot-2"></span></span>`,
    sonnet: `<span class="ico-stack">${flowerSvg(13)}<span class="ico-dot"></span></span>`,
    haiku: flowerSvg(11),

    // effort — spark bars
    effortDefault: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 14h10M5 11v3M8 7v7M11 9v5"/></svg>`,
    low:    `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="10" width="2" height="4" rx="0.6"/></svg>`,
    medium: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="10" width="2" height="4" rx="0.6"/><rect x="5" y="7" width="2" height="7" rx="0.6"/></svg>`,
    high:   `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="10" width="2" height="4" rx="0.6"/><rect x="5" y="7" width="2" height="7" rx="0.6"/><rect x="8" y="4" width="2" height="10" rx="0.6"/></svg>`,
    max:    `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5s-2 2.5-2 5a2 2 0 003.6 1.2C10 6.5 9 5 9 4c1.5 1 3 3.5 3 6a4 4 0 11-8 0c0-3 2-5 4-8.5z"/></svg>`,
  };

  const SETTING_DEFS = {
    mode: {
      label: 'mode',
      options: [
        { value: 'acceptEdits',       label: 'Accept edits',     desc: '編集を自動承認' },
        { value: 'plan',              label: 'Plan',             desc: '計画のみ・実行は確認' },
        { value: 'auto',              label: 'Auto',             desc: '自律実行' },
        { value: 'default',           label: 'Default',          desc: '通常（都度確認）' },
        { value: 'dontAsk',           label: 'Don\'t ask',       desc: '確認スキップ' },
        { value: 'bypassPermissions', label: 'Bypass',           desc: '権限無視（上級者向け）' },
      ],
    },
    model: {
      label: 'model',
      options: [
        { value: '',        label: 'Default',  desc: 'Claude Codeの既定' },
        { value: 'opus',    label: 'Opus',     desc: '最上位・高思考' },
        { value: 'sonnet',  label: 'Sonnet',   desc: 'バランス' },
        { value: 'haiku',   label: 'Haiku',    desc: '軽量・高速' },
      ],
    },
    effort: {
      label: 'effort',
      options: [
        { value: '',       label: 'Default', desc: 'Claude Codeの既定' },
        { value: 'low',    label: 'Low',     desc: '思考最小' },
        { value: 'medium', label: 'Medium',  desc: 'バランス' },
        { value: 'high',   label: 'High',    desc: '深く考える' },
        { value: 'max',    label: 'Max',     desc: '最大思考' },
      ],
    },
  };

  function iconFor(setting, value) {
    if (setting === 'mode')   return ICONS[value] || ICONS.default;
    if (setting === 'model')  return value === '' ? ICONS.modelDefault : (ICONS[value] || ICONS.modelDefault);
    if (setting === 'effort') return value === '' ? ICONS.effortDefault : (ICONS[value] || ICONS.medium);
    return '';
  }

  // Common SVG for clawd avatar (message)
  const CLAWD_SVG = `<svg class="avatar-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"/></svg>`;
  // Claude "spark" brand mark — fill=currentColor so CSS controls color state
  const CLAWD_MINI = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" fill-rule="nonzero" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>`;
  // Generic user avatar (unused currently)
  const USER_SVG = `<svg class="avatar-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`;

  // Persist settings across reloads
  const state = vscode.getState() || {};
  let settings = {
    mode:   state.settings?.mode   ?? 'default',
    model:  state.settings?.model  ?? '',
    effort: state.settings?.effort ?? '',
  };
  if (settings.model === null) settings.model = '';
  if (settings.effort === null) settings.effort = '';

  function currentSettings() {
    return {
      mode:   settings.mode   || 'default',
      model:  settings.model  || null,
      effort: settings.effort || null,
    };
  }
  function pushSettings() {
    const s = currentSettings();
    vscode.setState({ ...vscode.getState(), settings: { ...settings } });
    vscode.postMessage({ type: 'updateSettings', settings: s });
  }

  function renderPill(settingKey) {
    const def = SETTING_DEFS[settingKey];
    if (!def) return;
    const btn = els['pill' + settingKey.charAt(0).toUpperCase() + settingKey.slice(1)];
    if (!btn) return;
    const value = settings[settingKey];
    const opt = def.options.find((o) => o.value === value) || def.options[0];
    btn.innerHTML = `
      <span class="setting-icon">${iconFor(settingKey, value)}</span>
      <span class="setting-text">${esc(opt.label)}</span>
      <svg class="setting-chev" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 1.5l4 3 4-3"/></svg>
    `;
    btn.title = `${def.label}: ${opt.label}`;
  }
  function renderAllPills() {
    renderPill('mode');
    renderPill('model');
    renderPill('effort');
  }

  function openSettingMenu(settingKey, anchor) {
    const def = SETTING_DEFS[settingKey];
    if (!def) return;
    const menu = els.settingMenu;
    menu.innerHTML = def.options.map((o) => `
      <button class="setting-opt ${o.value === settings[settingKey] ? 'active' : ''}" data-val="${esc(String(o.value))}">
        <span class="setting-opt-icon">${iconFor(settingKey, o.value)}</span>
        <span class="setting-opt-text">
          <span class="setting-opt-label">${esc(o.label)}</span>
          <span class="setting-opt-desc">${esc(o.desc || '')}</span>
        </span>
      </button>
    `).join('');
    // Position above the anchor
    const composerRect = document.getElementById('composer').getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    menu.style.left = (rect.left - composerRect.left) + 'px';
    menu.style.bottom = (composerRect.bottom - rect.top + 6) + 'px';
    menu.classList.add('open');
    menu.dataset.for = settingKey;
    menu.querySelectorAll('.setting-opt').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        settings[settingKey] = el.dataset.val;
        closeSettingMenu();
        renderAllPills();
        pushSettings();
      });
    });
  }
  function closeSettingMenu() {
    els.settingMenu.classList.remove('open');
    els.settingMenu.dataset.for = '';
  }

  [['mode', els.pillMode], ['model', els.pillModel], ['effort', els.pillEffort]].forEach(([k, btn]) => {
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (els.settingMenu.classList.contains('open') && els.settingMenu.dataset.for === k) closeSettingMenu();
      else openSettingMenu(k, btn);
    });
  });
  document.addEventListener('mousedown', (e) => {
    if (!els.settingMenu.contains(e.target) &&
        !els.pillMode?.contains(e.target) &&
        !els.pillModel?.contains(e.target) &&
        !els.pillEffort?.contains(e.target)) {
      closeSettingMenu();
    }
  });

  renderAllPills();
  // Push once on load so extension has our values
  pushSettings();

  // marked UMD attaches to window.marked as a namespace object.
  // Safely configure + provide a render fallback.
  try {
    if (typeof marked?.setOptions === 'function') {
      marked.setOptions({ breaks: true, gfm: true });
    }
  } catch (e) {
    console.error('[screen-agent] marked.setOptions failed', e);
  }
  function renderMarkdown(md) {
    try {
      if (typeof marked?.parse === 'function') return marked.parse(md);
      if (typeof marked === 'function') return marked(md);
    } catch (e) {
      console.error('[screen-agent] marked.parse failed', e);
    }
    // Fallback: plain text with escaped HTML + line breaks
    return esc(md).replace(/\n/g, '<br>');
  }

  // ----- session state -----
  let currentSession = null;
  let currentAssistantMsg = null;
  let userScrolledUp = false;
  let editorContext = null;

  function makeSessionId() {
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
  }

  function newSession() {
    currentSession = {
      id: makeSessionId(),
      claudeSessionId: null,
      title: '',
      created: Date.now(),
      updated: Date.now(),
      messages: [],
    };
  }

  function persist() {
    if (!currentSession || currentSession.messages.length === 0) return;
    currentSession.updated = Date.now();
    vscode.postMessage({ type: 'saveSession', session: currentSession });
  }

  // ----- status -----
  function setStatus(state, text, meta = '') {
    els.statusbar.className = `statusbar ${state}`;
    els.statusText.textContent = text;
    els.statusMeta.textContent = meta || '';
    document.body.classList.toggle('is-running', state === 'running');
  }

  // ----- scroll -----
  function scrollToBottom(force = false) {
    if (userScrolledUp && !force) return;
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  els.messages.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = els.messages;
    userScrolledUp = scrollHeight - scrollTop - clientHeight >= 40;
  });

  // ----- empty state -----
  function hideEmpty() {
    if (els.emptyState) els.emptyState.style.display = 'none';
  }

  // ----- user message -----
  function addUserMessage(text, contextTag) {
    hideEmpty();
    const msg = document.createElement('div');
    msg.className = 'msg msg-user';
    if (contextTag) {
      const c = document.createElement('div');
      c.className = 'ctx-tag';
      c.textContent = contextTag;
      msg.appendChild(c);
    }
    const t = document.createElement('div');
    t.className = 'msg-text';
    t.textContent = text;
    msg.appendChild(t);
    els.messages.appendChild(msg);
    scrollToBottom();
  }

  // ----- assistant message -----
  const THINKING_WORDS = ['Thinking', 'Vibing', 'Considering', 'Pondering', 'Weaving'];
  function makeThinkingIndicator() {
    const ind = document.createElement('div');
    ind.className = 'thinking-indicator';
    ind.innerHTML = `
      <span class="ti-spark">${CLAWD_MINI}</span>
      <span class="ti-word">${THINKING_WORDS[0]}…</span>
    `;
    const word = ind.querySelector('.ti-word');
    let i = 0;
    ind._timer = setInterval(() => {
      i = (i + 1) % THINKING_WORDS.length;
      if (word) word.textContent = THINKING_WORDS[i] + '…';
    }, 2400);
    return ind;
  }
  function killThinkingIndicator(ind) {
    if (!ind) return;
    if (ind._timer) clearInterval(ind._timer);
    ind.remove();
  }

  function newAssistantMessage() {
    hideEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant streaming';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const indicator = makeThinkingIndicator();
    body.appendChild(indicator);
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    wrap.appendChild(body);
    wrap.appendChild(meta);
    els.messages.appendChild(wrap);
    scrollToBottom();
    return {
      wrap, body, meta,
      textBuffer: '',
      textBlock: null,
      streamedText: false,
      currentToolGroup: null,
      thinking: indicator,
      thinkingBlocks: {},
      activeThinkingIdx: null,
    };
  }

  // ---------- Thinking block (flat dot+label, Claude Code–style) ----------
  function ensureThinkingBlock(a, idx) {
    if (a.thinkingBlocks[idx]) return a.thinkingBlocks[idx];
    if (a.thinking) { killThinkingIndicator(a.thinking); a.thinking = null; }
    const group = document.createElement('div');
    group.className = 'think-item running';
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'think-head';
    header.innerHTML = `
      <span class="think-dot">${CLAWD_MINI}</span>
      <span class="think-label">Thinking…</span>
    `;
    header.addEventListener('click', () => group.classList.toggle('expanded'));
    const pre = document.createElement('div');
    pre.className = 'think-content';
    group.appendChild(header);
    group.appendChild(pre);
    a.body.appendChild(group);
    a.activeThinkingIdx = idx;
    const block = { group, header, pre, buffer: '', startedAt: Date.now(), done: false };
    a.thinkingBlocks[idx] = block;
    return block;
  }
  function appendThinkingDelta(idx, delta) {
    const a = ensureAssistant();
    const block = ensureThinkingBlock(a, idx);
    block.buffer += delta;
    block.pre.textContent = block.buffer;
    // Keep the most-recent text visible when preview-mode (not fully expanded)
    block.pre.scrollTop = block.pre.scrollHeight;
    scrollToBottom();
  }
  function finishThinkingBlock(idx) {
    const a = currentAssistantMsg;
    if (!a) return;
    const block = a.thinkingBlocks[idx];
    if (!block || block.done) return;
    block.done = true;
    const secs = Math.max(0, Math.round((Date.now() - block.startedAt) / 1000));
    block.group.classList.remove('running');
    block.group.classList.add('done');
    const label = block.header.querySelector('.think-label');
    if (label) label.textContent = `Thought for ${secs}s`;
  }
  function ensureAssistant() {
    if (!currentAssistantMsg) currentAssistantMsg = newAssistantMessage();
    return currentAssistantMsg;
  }
  function finishAssistant(metaText = '') {
    if (!currentAssistantMsg) return;
    killThinkingIndicator(currentAssistantMsg.thinking);
    currentAssistantMsg.thinking = null;
    currentAssistantMsg.wrap.classList.remove('streaming');
    if (metaText) currentAssistantMsg.meta.textContent = metaText;
    if (currentSession && currentAssistantMsg.textBuffer) {
      currentSession.messages.push({
        role: 'assistant',
        text: currentAssistantMsg.textBuffer,
        meta: metaText,
        at: Date.now(),
      });
      persist();
    }
    currentAssistantMsg = null;
  }
  function appendAssistantText(text, { fromStream = false } = {}) {
    const a = ensureAssistant();
    if (fromStream) a.streamedText = true;
    // Kill thinking indicator as soon as real text arrives
    if (a.thinking) { killThinkingIndicator(a.thinking); a.thinking = null; }
    if (!a.textBlock || a.textBlock !== a.body.lastElementChild || !a.textBlock.classList.contains('text-block')) {
      const block = document.createElement('div');
      block.className = 'text-block';
      a.body.appendChild(block);
      a.textBlock = block;
      a.textBuffer = '';
    }
    a.textBuffer += text;
    a.textBlock.innerHTML = renderMarkdown(a.textBuffer);
    scrollToBottom();
  }
  // Map tool name + input → human-readable running label
  function toolVerb(name, input, { past = false } = {}) {
    const p = (s, n = 40) => s && s.length > n ? s.slice(0, n) + '…' : s;
    const basename = (path) => path ? path.split('/').pop() : '';
    const i = input || {};
    const map = past ? {
      Read: () => `Read ${basename(i.file_path)}`,
      Edit: () => `Edited ${basename(i.file_path)}`,
      Write: () => `Wrote ${basename(i.file_path)}`,
      MultiEdit: () => `Edited ${basename(i.file_path)}`,
      Bash: () => `Ran ${p(i.command, 48)}`,
      Grep: () => `Searched "${p(i.pattern, 30)}"`,
      Glob: () => `Found "${p(i.pattern, 30)}"`,
      Task: () => `Delegated to ${i.subagent_type || 'agent'}`,
      WebFetch: () => `Fetched ${p(i.url, 40)}`,
      WebSearch: () => `Searched "${p(i.query, 30)}"`,
      TodoWrite: () => `Updated todos`,
      NotebookEdit: () => `Edited ${basename(i.notebook_path)}`,
    } : {
      Read: () => `Reading ${basename(i.file_path)}…`,
      Edit: () => `Editing ${basename(i.file_path)}…`,
      Write: () => `Writing ${basename(i.file_path)}…`,
      MultiEdit: () => `Editing ${basename(i.file_path)}…`,
      Bash: () => `Running ${p(i.command, 48)}…`,
      Grep: () => `Searching "${p(i.pattern, 30)}"…`,
      Glob: () => `Finding "${p(i.pattern, 30)}"…`,
      Task: () => `Delegating to ${i.subagent_type || 'agent'}…`,
      WebFetch: () => `Fetching ${p(i.url, 40)}…`,
      WebSearch: () => `Searching "${p(i.query, 30)}"…`,
      TodoWrite: () => `Updating todos…`,
      NotebookEdit: () => `Editing ${basename(i.notebook_path)}…`,
    };
    const fn = map[name];
    return fn ? fn() : (past ? `${name}` : `${name}…`);
  }

  // Short verb + target for the inline tool row (matches Claude Code's compact UI)
  function toolHeadParts(name, input) {
    const p = (s, n = 40) => s && s.length > n ? s.slice(0, n) + '…' : s;
    const basename = (path) => path ? path.split('/').pop() : '';
    const i = input || {};
    switch (name) {
      case 'Read':     return { verb: 'Read',    target: basename(i.file_path) };
      case 'Edit':     return { verb: 'Edit',    target: basename(i.file_path) };
      case 'MultiEdit':return { verb: 'Edit',    target: basename(i.file_path) };
      case 'Write':    return { verb: 'Write',   target: basename(i.file_path) };
      case 'Bash':     return { verb: 'Run',     target: p(i.command, 48) };
      case 'Grep':     return { verb: 'Search',  target: p(i.pattern, 40) };
      case 'Glob':     return { verb: 'Find',    target: p(i.pattern, 40) };
      case 'Task':     return { verb: 'Task',    target: i.subagent_type || 'agent' };
      case 'WebFetch': return { verb: 'Fetch',   target: p(i.url, 40) };
      case 'WebSearch':return { verb: 'Search',  target: p(i.query, 40) };
      case 'TodoWrite':return { verb: 'Todos',   target: '' };
      case 'NotebookEdit':return { verb: 'Edit', target: basename(i.notebook_path) };
      default:         return { verb: name,     target: '' };
    }
  }

  // Short result summary line ("Modified", "Added 3 lines", "42 lines", etc.)
  function summarizeToolResult(name, input, result) {
    const r = String(result || '');
    if (!r) return '';
    if (name === 'Edit' || name === 'MultiEdit') {
      const m = r.match(/(?:Added|Wrote|Updated|Modified)[^\n]*/i);
      if (m) return m[0].slice(0, 80);
      return 'Modified';
    }
    if (name === 'Write') return 'Wrote file';
    if (name === 'Read') {
      const lines = r.split('\n').length;
      return `${lines} line${lines === 1 ? '' : 's'}`;
    }
    if (name === 'Bash') {
      const first = r.trim().split('\n')[0] || '';
      return first.slice(0, 80);
    }
    if (name === 'Grep' || name === 'Glob') {
      const lines = r.split('\n').filter(Boolean).length;
      return `${lines} result${lines === 1 ? '' : 's'}`;
    }
    if (name === 'TodoWrite') return 'Updated';
    // Fallback: first line
    const first = r.trim().split('\n')[0] || '';
    return first.slice(0, 80);
  }

  function appendAssistantTool(name, input) {
    const a = ensureAssistant();
    if (a.thinking) { killThinkingIndicator(a.thinking); a.thinking = null; }
    a.textBlock = null;

    const item = document.createElement('div');
    item.className = 'tool-item running';
    item._tool = { name, input };

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'tool-head';
    const { verb, target } = toolHeadParts(name, input);
    head.innerHTML = `
      <span class="tool-dot">${CLAWD_MINI}</span>
      <span class="tool-verb">${esc(verb)}</span>
      ${target ? `<code class="tool-target">${esc(target)}</code>` : ''}
    `;
    head.addEventListener('click', () => item.classList.toggle('expanded'));
    item.appendChild(head);

    const summary = document.createElement('div');
    summary.className = 'tool-summary';
    item.appendChild(summary);

    const argStr = input ? JSON.stringify(input, null, 2) : '';
    if (argStr) {
      const pre = document.createElement('pre');
      pre.className = 'tool-details';
      pre.textContent = argStr;
      item.appendChild(pre);
    }
    a.body.appendChild(item);
    a.currentToolGroup = item;
    scrollToBottom();
  }
  // Decide whether to auto-expand a tool's result inline (matches Claude Code app:
  // show short outputs / diffs by default, keep long / noisy outputs collapsed).
  function shouldAutoExpand(name, input, content) {
    const text = String(content || '');
    const lines = text.split('\n').length;
    const chars = text.length;
    // Change-type tools: always show (users want to see the diff/contents)
    if (name === 'Edit' || name === 'MultiEdit') return true;
    if (name === 'Write') return chars < 1200;
    if (name === 'TodoWrite') return true;
    // Search-type tools: show if not too many results
    if (name === 'Grep' || name === 'Glob') return lines <= 10;
    // Command output: show if short
    if (name === 'Bash') return lines <= 8 && chars <= 800;
    // Read: usually huge, keep collapsed
    if (name === 'Read') return false;
    // Web / Task / default: show if short
    return lines <= 6 && chars <= 500;
  }

  function appendAssistantToolResult(content) {
    const a = ensureAssistant();
    a.textBlock = null;
    const item = a.currentToolGroup;
    if (item) {
      item.classList.remove('running');
      item.classList.add('done');
      const { name, input } = item._tool || {};
      const summaryEl = item.querySelector('.tool-summary');
      if (summaryEl) summaryEl.textContent = summarizeToolResult(name, input, content);
      // Full result for expansion
      const full = document.createElement('pre');
      full.className = 'tool-result-full';
      full.textContent = content;
      item.appendChild(full);
      // Auto-expand based on heuristics
      if (shouldAutoExpand(name, input, content)) item.classList.add('expanded');
      a.currentToolGroup = null;
    } else {
      // Orphan result (rare)
      const div = document.createElement('div');
      div.className = 'tool-summary';
      div.textContent = String(content || '').split('\n')[0].slice(0, 80);
      a.body.appendChild(div);
    }
    scrollToBottom();
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ----- handle Claude stream events -----
  function handleClaudeMsg(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      setStatus('running', `connected · ${msg.model || 'claude'}`);
      // Pre-create the bubble so "Thinking…" is visible during the latency
      // between init and the first streamed content.
      ensureAssistant();
      if (msg.session_id && currentSession && !currentSession.claudeSessionId) {
        currentSession.claudeSessionId = msg.session_id;
        persist();
      }
      return;
    }
    if (msg.type === 'assistant' && msg.message?.content) {
      const a = ensureAssistant();
      for (const c of msg.message.content) {
        if (c.type === 'text') {
          if (!a.streamedText) appendAssistantText(c.text);
        } else if (c.type === 'tool_use') {
          appendAssistantTool(c.name, c.input);
        } else if (c.type === 'thinking' && c.thinking) {
          // Full-message thinking (non-streamed fallback)
          const idx = `f-${Math.random().toString(36).slice(2, 6)}`;
          const block = ensureThinkingBlock(a, idx);
          block.buffer = c.thinking;
          block.pre.textContent = c.thinking;
          finishThinkingBlock(idx);
        }
      }
      return;
    }
    if (msg.type === 'stream_event' && msg.event) {
      const ev = msg.event;
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
        ensureThinkingBlock(ensureAssistant(), ev.index);
        return;
      }
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'thinking_delta') {
          appendThinkingDelta(ev.index, ev.delta.thinking || '');
        } else if (ev.delta?.type === 'text_delta') {
          appendAssistantText(ev.delta.text || '', { fromStream: true });
        }
        return;
      }
      if (ev.type === 'content_block_stop') {
        // Close any open thinking block at this index
        if (currentAssistantMsg?.thinkingBlocks[ev.index]) {
          finishThinkingBlock(ev.index);
        }
        return;
      }
      return;
    }
    if (msg.type === 'user' && msg.message?.content) {
      for (const c of msg.message.content) {
        if (c.type === 'tool_result') {
          const content = typeof c.content === 'string'
            ? c.content
            : Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : JSON.stringify(c.content);
          appendAssistantToolResult(content);
        }
      }
      return;
    }
    if (msg.type === 'result') {
      const cost = msg.total_cost_usd != null ? `$${msg.total_cost_usd.toFixed(4)}` : '';
      const dur = msg.duration_ms ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '';
      const metaText = [dur, cost].filter(Boolean).join(' · ');
      finishAssistant(metaText);
      setStatus('done', 'completed', metaText);
      els.btnStop.disabled = true;
      updateSendDisabled();
    }
  }

  // ----- submit -----
  function updateSendDisabled() {
    els.btnSubmit.disabled = !els.question.value.trim().length;
  }

  function autoResize() {
    els.question.style.height = 'auto';
    els.question.style.height = Math.min(els.question.scrollHeight, 180) + 'px';
  }

  async function doSubmit() {
    const text = els.question.value.trim();
    if (!text) return;

    // Slash command handling (client-side only)
    if (text.startsWith('/')) {
      const handled = runSlashCommand(text);
      if (handled) {
        els.question.value = '';
        autoResize();
        updateSendDisabled();
        hideSlashMenu();
        return;
      }
    }

    // First-send hero animation: play the clawd webm once then fade out
    if (els.clawdHero && !els.clawdHero.dataset.played) {
      els.clawdHero.dataset.played = '1';
      try { els.clawdHero.currentTime = 0; els.clawdHero.play(); } catch {}
    }

    // Request latest editor context right before send
    vscode.postMessage({ type: 'getEditorContext' });

    const contextTag = editorContext?.file
      ? `📄 ${editorContext.file}${editorContext.selection ? ' · selection' : ''}`
      : null;

    addUserMessage(text, contextTag);
    if (currentSession) {
      if (!currentSession.title) currentSession.title = text.slice(0, 60);
      currentSession.messages.push({
        role: 'user',
        text,
        contextTag,
        at: Date.now(),
      });
      persist();
    }

    lastUserMessage = text;
    els.question.value = '';
    autoResize();
    els.btnSubmit.disabled = true;
    els.btnStop.disabled = false;
    setStatus('running', 'starting claude…');

    vscode.postMessage({
      type: 'send',
      question: text,
      resumeId: currentSession?.claudeSessionId || null,
      // Claude Code本家と同じく、ユーザーの質問をそのまま渡す。
      // 必要なファイル情報は Claude が Read ツールで自律的に調べる。
      includeContext: false,
    });
  }

  els.btnSubmit.addEventListener('click', doSubmit);
  els.btnStop.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
    finishAssistant('stopped');
    setStatus('idle', 'stopped');
    els.btnStop.disabled = true;
    updateSendDisabled();
  });
  els.question.addEventListener('input', () => { autoResize(); updateSendDisabled(); });
  els.question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!els.btnSubmit.disabled) doSubmit();
    }
  });

  // ----- messages from extension host -----
  window.addEventListener('message', (e) => {
    const { type, payload } = e.data || {};
    switch (type) {
      case 'claudeEvent':
        if (payload.kind === 'msg') handleClaudeMsg(payload.data);
        else if (payload.kind === 'error') {
          setStatus('error', `error: ${payload.data}`);
          finishAssistant(`error: ${payload.data}`);
          els.btnStop.disabled = true;
          updateSendDisabled();
        } else if (payload.kind === 'done') {
          finishAssistant();
          if (payload.code !== 0 && !els.statusbar.classList.contains('done')) {
            setStatus('error', `exit ${payload.code}`);
          }
          els.btnStop.disabled = true;
          updateSendDisabled();
        }
        break;
      case 'editorContext':
        editorContext = payload;
        renderContextChip();
        break;
      case 'newChatAck':
        els.messages.querySelectorAll('.msg').forEach(m => m.remove());
        if (els.emptyState) els.emptyState.style.display = '';
        setStatus('idle', 'ready · new chat');
        newSession();
        els.question.focus();
        break;
      case 'focusInput':
        els.question.focus();
        break;
    }
  });

  function renderContextChip() {
    // Chip off by default. Claude discovers context via its own tools.
    els.contextChip.textContent = '';
  }
  // No polling needed in default CC-matching mode

  // ----- Slash command menu -----
  const SLASH_COMMANDS = [
    { cmd: '/clear',  desc: '新しい会話にリセット',        run: () => vscode.postMessage({ type: 'newChat' }) },
    { cmd: '/retry',  desc: '直前の質問をもう一度送る',    run: retryLast },
    { cmd: '/model',  desc: 'モデル選択メニュー',          run: () => openSettingMenu('model', els.pillModel) },
    { cmd: '/mode',   desc: '権限モード選択メニュー',      run: () => openSettingMenu('mode', els.pillMode) },
    { cmd: '/effort', desc: '思考効率選択メニュー',        run: () => openSettingMenu('effort', els.pillEffort) },
    { cmd: '/help',   desc: 'ヘルプを表示',               run: showHelp },
  ];
  let slashItems = [];
  let slashIndex = 0;
  let lastUserMessage = null;

  function showSlashMenu(filter) {
    const q = filter.toLowerCase();
    slashItems = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
    if (slashItems.length === 0) { hideSlashMenu(); return; }
    slashIndex = 0;
    els.slashMenu.innerHTML = slashItems.map((c, idx) => `
      <div class="slash-item ${idx === 0 ? 'active' : ''}" data-idx="${idx}">
        <span class="slash-cmd">${esc(c.cmd)}</span>
        <span class="slash-desc">${esc(c.desc)}</span>
      </div>
    `).join('');
    els.slashMenu.classList.add('open');
    els.slashMenu.querySelectorAll('.slash-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number(el.dataset.idx);
        executeSlash(slashItems[idx]);
      });
    });
  }
  function hideSlashMenu() {
    els.slashMenu.classList.remove('open');
    slashItems = [];
  }
  function moveSlashSelection(dir) {
    if (!slashItems.length) return;
    slashIndex = (slashIndex + dir + slashItems.length) % slashItems.length;
    els.slashMenu.querySelectorAll('.slash-item').forEach((el, idx) => {
      el.classList.toggle('active', idx === slashIndex);
    });
  }
  function executeSlash(cmd) {
    if (!cmd) return;
    els.question.value = '';
    autoResize();
    updateSendDisabled();
    hideSlashMenu();
    try { cmd.run(); } catch {}
  }
  function runSlashCommand(text) {
    const token = text.trim().split(/\s+/)[0];
    const cmd = SLASH_COMMANDS.find((c) => c.cmd === token);
    if (cmd) { executeSlash(cmd); return true; }
    return false;
  }
  function retryLast() {
    if (!lastUserMessage) { setStatus('idle', 'まだ質問がないデビ'); return; }
    els.question.value = lastUserMessage;
    autoResize();
    updateSendDisabled();
    setTimeout(doSubmit, 0);
  }
  function showHelp() {
    // Open an assistant-style help bubble
    const help = [
      '**Slash commands**',
      '- `/clear` — 新しい会話にリセット',
      '- `/retry` — 直前の質問を再送',
      '- `/model`, `/mode`, `/effort` — 対応する設定にフォーカス',
      '- `/help` — このヘルプ',
      '',
      '**Shortcuts**',
      '- `⌘Enter` 送信',
      '- `⌘⇧A` 新しいチャット',
    ].join('\n');
    const a = newAssistantMessage();
    killThinkingIndicator(a.thinking); a.thinking = null;
    const block = document.createElement('div');
    block.className = 'text-block';
    block.innerHTML = renderMarkdown(help);
    a.body.appendChild(block);
    a.wrap.classList.remove('streaming');
    currentAssistantMsg = null;
  }

  // Slash menu keyboard + input wiring
  els.question.addEventListener('input', () => {
    const v = els.question.value;
    if (v.startsWith('/') && !v.includes(' ') && !v.includes('\n')) {
      showSlashMenu(v);
    } else {
      hideSlashMenu();
    }
  });
  els.question.addEventListener('keydown', (e) => {
    if (els.slashMenu.classList.contains('open')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashSelection(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveSlashSelection(-1); return; }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        executeSlash(slashItems[slashIndex]);
        return;
      }
      if (e.key === 'Escape') { hideSlashMenu(); return; }
    }
  });

  // ----- History panel -----
  function formatRelTime(ms) {
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d < 7 ? `${d}d ago` : new Date(ms).toISOString().slice(0, 10);
  }
  function openHistory() {
    vscode.postMessage({ type: 'listSessions' });
    els.historyPanel.classList.add('open');
  }
  function closeHistory() {
    els.historyPanel.classList.remove('open');
  }
  function renderHistory(items) {
    if (!items || items.length === 0) {
      els.historyList.innerHTML = `<div class="history-empty">まだ履歴がないデビ</div>`;
      return;
    }
    els.historyList.innerHTML = items.map((it) => `
      <button class="history-item" data-id="${esc(it.id)}">
        <div class="h-title">${esc(it.title || '(empty)')}</div>
        <div class="h-meta">
          <span>${esc(formatRelTime(it.updated))}</span>
          <span>·</span>
          <span>${(it.messages?.length || 0)} msg</span>
        </div>
      </button>
    `).join('');
    els.historyList.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => vscode.postMessage({ type: 'getSession', id: el.dataset.id }));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (confirm('削除する？')) {
          vscode.postMessage({ type: 'deleteSession', id: el.dataset.id });
          setTimeout(() => vscode.postMessage({ type: 'listSessions' }), 100);
        }
      });
    });
  }
  function loadHistorySession(s) {
    if (!s) return;
    els.messages.querySelectorAll('.msg-row, .msg').forEach((n) => n.remove());
    hideEmpty();
    currentSession = { ...s };
    for (const m of s.messages || []) {
      if (m.role === 'user') {
        addUserMessage(m.text, m.contextTag);
      } else if (m.role === 'assistant') {
        const a = newAssistantMessage();
        killThinkingIndicator(a.thinking); a.thinking = null;
        if (m.text) appendAssistantText(m.text);
        a.wrap.classList.remove('streaming');
        if (m.meta) a.meta.textContent = m.meta;
        currentAssistantMsg = null;
      }
    }
    closeHistory();
    setStatus('idle', 'viewing past session · type to branch');
  }

  els.btnHistory?.addEventListener('click', () => {
    if (els.historyPanel.classList.contains('open')) closeHistory();
    else openHistory();
  });
  els.historyClose?.addEventListener('click', closeHistory);
  els.btnNew?.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));

  // Intercept extra message types
  const _origOnMessage = window.onmessage;
  window.addEventListener('message', (e) => {
    const { type, payload } = e.data || {};
    if (type === 'sessionsList') renderHistory(payload);
    if (type === 'sessionData') loadHistorySession(payload);
  });

  // ----- init -----
  newSession();
  setStatus('idle', 'ready');
  updateSendDisabled();
  autoResize();
})();
