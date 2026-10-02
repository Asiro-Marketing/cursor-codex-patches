// Claude Chat renderer — runs inside the VS Code webview.
// Handles drag-drop attachments, chat UI, and stream-json events from the
// extension host (which spawns the `claude` CLI on our behalf).

(() => {
  const vscode = acquireVsCodeApi();

  const els = {
    messages: document.getElementById('messages'),
    composer: document.getElementById('composer'),
    chips: document.getElementById('chips'),
    input: document.getElementById('input'),
    btnSend: document.getElementById('btn-send'),
    btnStop: document.getElementById('btn-stop'),
    status: document.getElementById('status'),
  };

  // ---------- pending attachments ----------
  let pendingAttachments = [];
  // Sequence number for async readImageDataUrl round-trips back from extension host.
  let imgReqSeq = 0;
  const imgReqPromises = new Map();

  function basename(p) {
    if (!p) return '';
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function setStatus(state, text) {
    els.status.className = 'status ' + state;
    els.status.textContent = text;
  }
  function updateSendDisabled() {
    const canSend = els.input.value.trim().length > 0 || pendingAttachments.length > 0;
    els.btnSend.disabled = !canSend;
  }

  // Webview can read its own files via fetch? No — but we can ask the extension
  // host for a base64 data URL. This keeps preview previews tied to absolute paths.
  function requestImageDataUrl(p) {
    return new Promise((resolve) => {
      const requestId = ++imgReqSeq;
      imgReqPromises.set(requestId, resolve);
      vscode.postMessage({ type: 'read-image-data-url', path: p, requestId });
      // Don't block forever — if the host doesn't reply in 4s, fall back to no preview.
      setTimeout(() => {
        if (imgReqPromises.has(requestId)) {
          imgReqPromises.delete(requestId);
          resolve(null);
        }
      }, 4000);
    });
  }

  function renderChips() {
    els.chips.innerHTML = '';
    els.composer.classList.toggle('has-attachment', pendingAttachments.length > 0);
    pendingAttachments.forEach((att, idx) => {
      const chip = document.createElement('div');
      chip.className = 'chip chip-' + (att.kind || 'file');
      if (att.kind === 'image' && att.dataUrl) {
        const img = document.createElement('img');
        img.src = att.dataUrl;
        chip.appendChild(img);
      } else {
        const ext = (att.name || '').split('.').pop().toUpperCase().slice(0, 5) || 'FILE';
        const badge = document.createElement('div');
        badge.className = 'file-badge';
        badge.title = att.path || att.name || '';
        badge.innerHTML = `
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
            <path d="M3.5 2.5h6L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 .5-1z"/>
            <path d="M9 2.5V6h4"/>
          </svg>
          <div class="file-meta">
            <div class="file-name">${escHtml(att.name || 'file')}</div>
            <div class="file-ext">${escHtml(ext)}${att.size ? ` · ${fmtBytes(att.size)}` : ''}</div>
          </div>`;
        chip.appendChild(badge);
      }
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.title = '削除';
      x.innerHTML = '×';
      x.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pendingAttachments.splice(idx, 1);
        renderChips();
        updateSendDisabled();
      });
      chip.appendChild(x);
      els.chips.appendChild(chip);
    });
  }

  // VS Code webviews do NOT expose `File.path` for dropped files — there's no
  // equivalent of Electron's webUtils.getPathForFile. Workaround: VS Code lets
  // the webview read `dataTransfer.getData('text/uri-list')` (and 'codeFiles'
  // for editor-internal drops) which DOES contain file://… URIs for Finder
  // drops. Parse those to absolute paths.
  function pathsFromDrop(dt) {
    const out = [];
    // Finder drag exposes the URIs via text/uri-list.
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/);
    for (const raw of uris) {
      const u = raw.trim();
      if (!u || u.startsWith('#')) continue;
      if (u.startsWith('file://')) {
        try { out.push(decodeURIComponent(u.replace(/^file:\/\//, ''))); }
        catch { /* ignore malformed */ }
      }
    }
    // Plain-text fallback: paths pasted from the terminal etc.
    if (out.length === 0) {
      const txt = dt.getData('text/plain') || '';
      for (const line of txt.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t)) out.push(t);
      }
    }
    return out;
  }

  function kindFromExt(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
    return 'file';
  }

  async function addAttachment(absPath, name) {
    const att = {
      kind: kindFromExt(name || absPath),
      path: absPath,
      name: name || basename(absPath),
    };
    if (att.kind === 'image') {
      att.dataUrl = await requestImageDataUrl(absPath);
    }
    pendingAttachments.push(att);
    renderChips();
    updateSendDisabled();
  }

  // ---------- drag & drop on composer ----------
  els.composer.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).some((t) =>
      t === 'Files' || t === 'text/uri-list' || t === 'text/plain'
    )) return;
    e.preventDefault();
    els.composer.classList.add('drag-over');
  });
  els.composer.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  els.composer.addEventListener('dragleave', (e) => {
    if (e.target === els.composer) els.composer.classList.remove('drag-over');
  });
  els.composer.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.composer.classList.remove('drag-over');
    const paths = pathsFromDrop(e.dataTransfer);
    if (paths.length === 0) {
      setStatus('error', 'ドロップしたファイルのパスが取れませんでした (Finderからドラッグしてください)');
      return;
    }
    for (const p of paths) await addAttachment(p);
    setStatus('idle', `${paths.length}件添付しました`);
  });

  // ---------- composer ----------
  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
    updateSendDisabled();
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!els.btnSend.disabled) doSubmit();
    }
  });
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!els.btnSend.disabled) doSubmit();
  });
  els.btnStop.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
    finishAssistant('停止しました');
    setStatus('idle', '停止');
    els.btnStop.disabled = true;
  });

  // ---------- message DOM ----------
  function addUserMessage(text, attachments) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    const list = Array.isArray(attachments) ? attachments : [];
    if (list.length > 0) {
      const atts = document.createElement('div');
      atts.className = 'msg-atts';
      for (const a of list) {
        if (a.kind === 'image' && a.dataUrl) {
          const img = document.createElement('img');
          img.src = a.dataUrl;
          img.className = 'msg-img';
          atts.appendChild(img);
        } else {
          const ext = (a.name || '').split('.').pop().toUpperCase().slice(0, 5) || 'FILE';
          const card = document.createElement('div');
          card.className = 'msg-file';
          card.title = a.path || '';
          card.innerHTML = `
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
              <path d="M3.5 2.5h6L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 .5-1z"/>
              <path d="M9 2.5V6h4"/>
            </svg>
            <div>
              <div class="file-name">${escHtml(a.name)}</div>
              <div class="file-ext">${escHtml(ext)}</div>
            </div>`;
          if (a.path) {
            card.style.cursor = 'pointer';
            card.addEventListener('click', () => vscode.postMessage({ type: 'open-path', path: a.path }));
          }
          atts.appendChild(card);
        }
      }
      wrap.appendChild(atts);
    }
    if (text) {
      const t = document.createElement('div');
      t.className = 'msg-text';
      t.textContent = text;
      wrap.appendChild(t);
    }
    els.messages.appendChild(wrap);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  let currentAssistant = null;
  function ensureAssistant() {
    if (currentAssistant) return currentAssistant;
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant streaming';
    const head = document.createElement('div');
    head.className = 'msg-head';
    head.textContent = 'CLAUDE';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const thinking = document.createElement('span');
    thinking.className = 'thinking';
    thinking.textContent = '⠋ 考え中…';
    body.appendChild(thinking);
    wrap.appendChild(head);
    wrap.appendChild(body);
    els.messages.appendChild(wrap);
    currentAssistant = { wrap, body, thinking, textBuffer: '' };
    return currentAssistant;
  }
  function appendAssistantText(chunk) {
    const a = ensureAssistant();
    if (a.thinking) { a.thinking.remove(); a.thinking = null; }
    a.textBuffer += chunk;
    // Render markdown progressively (cheap re-parse on each chunk; OK for our scale).
    try { a.body.innerHTML = window.marked.parse(a.textBuffer); }
    catch { a.body.textContent = a.textBuffer; }
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  function finishAssistant(metaText) {
    if (!currentAssistant) return;
    currentAssistant.wrap.classList.remove('streaming');
    if (currentAssistant.thinking) { currentAssistant.thinking.remove(); currentAssistant.thinking = null; }
    if (metaText) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = metaText;
      currentAssistant.wrap.appendChild(meta);
    }
    currentAssistant = null;
  }

  async function doSubmit() {
    const text = els.input.value.trim();
    if (!text && pendingAttachments.length === 0) return;
    const attachments = pendingAttachments.slice();
    addUserMessage(text, attachments);
    els.input.value = '';
    els.input.style.height = 'auto';
    pendingAttachments = [];
    renderChips();
    updateSendDisabled();
    els.btnSend.disabled = true;
    els.btnStop.disabled = false;
    setStatus('running', '実行中');
    ensureAssistant();
    // Strip dataUrl before sending to extension host (it's a renderer-only preview blob).
    const wireAtts = attachments.map((a) => ({ kind: a.kind, path: a.path, name: a.name }));
    vscode.postMessage({ type: 'run', question: text, attachments: wireAtts });
  }

  // ---------- stream events from extension host ----------
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m) return;
    if (m.kind === 'image-data-url') {
      const resolve = imgReqPromises.get(m.requestId);
      if (resolve) { imgReqPromises.delete(m.requestId); resolve(m.dataUrl); }
      return;
    }
    if (m.kind === 'extension-error') {
      setStatus('error', m.message);
      finishAssistant(`error: ${m.message}`);
      els.btnStop.disabled = true;
      return;
    }
    if (m.kind !== 'claude-event') return;
    const evt = m.evt || {};
    if (evt.kind === 'msg') {
      handleClaudeMsg(evt.data);
    } else if (evt.kind === 'stderr') {
      // ignore unless you want a debug pane
    } else if (evt.kind === 'done') {
      finishAssistant('');
      setStatus('idle', '完了');
      els.btnStop.disabled = true;
      updateSendDisabled();
    } else if (evt.kind === 'error') {
      setStatus('error', evt.data);
      finishAssistant(`error: ${evt.data}`);
      els.btnStop.disabled = true;
    }
  });

  // stream-json message dispatcher. We care about:
  //   - assistant text deltas (stream_event with content_block_delta of type text_delta)
  //   - final assistant message blocks
  //   - tool_use notifications (lightweight indicator)
  function handleClaudeMsg(data) {
    if (!data) return;
    if (data.type === 'stream_event' && data.event) {
      const ev = data.event;
      if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta' && ev.delta.text) {
          appendAssistantText(ev.delta.text);
        }
      }
      return;
    }
    if (data.type === 'assistant' && data.message && Array.isArray(data.message.content)) {
      // Some content arrives only via the final assistant message (no deltas).
      // Append any text blocks we haven't seen yet — simple heuristic: if our
      // buffer is empty, take the message verbatim.
      const a = ensureAssistant();
      if (!a.textBuffer) {
        for (const c of data.message.content) {
          if (c.type === 'text' && c.text) appendAssistantText(c.text);
          if (c.type === 'tool_use' && c.name) {
            const tag = document.createElement('div');
            tag.className = 'tool-tag';
            tag.textContent = `🔧 ${c.name}`;
            a.body.appendChild(tag);
          }
        }
      } else {
        for (const c of data.message.content) {
          if (c.type === 'tool_use' && c.name) {
            const tag = document.createElement('div');
            tag.className = 'tool-tag';
            tag.textContent = `🔧 ${c.name}`;
            a.body.appendChild(tag);
          }
        }
      }
      return;
    }
    if (data.type === 'result') {
      const meta = data.is_error ? `error: ${(data.errors || []).join(', ')}` : '';
      finishAssistant(meta);
      setStatus(data.is_error ? 'error' : 'idle', data.is_error ? 'エラー' : '完了');
      els.btnStop.disabled = true;
      updateSendDisabled();
    }
  }

  setStatus('idle', '待機中');
  updateSendDisabled();
})();
