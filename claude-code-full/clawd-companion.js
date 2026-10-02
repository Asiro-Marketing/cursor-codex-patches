/*__clawd-companion__*/
// Clawd companion pet for the official Claude Code chat webview.
// Injected (prepended) into webview/index.js by patch.mjs, which fills the
// __CLAWD_*__ placeholders with base64 gif data URIs at patch time.
//
// The pet SWAPS CHARACTER based on what Claude is doing (3 states, each with a
// user-assigned character). ASK (AskUserQuestion choice UI) instead makes the
// whole window edge breathe blue, since the pet can't anchor then.
//   default     – idle
//   generating  – Claude is streaming a reply
//   needsInput  – Claude finished, your turn (chat settled after streaming)
// Per-character: size (height), and left/right + up/down offset. All adjustable
// from the menu, persisted in localStorage. Activity-based detection (DOM
// mutations), NOT button labels. CSP: img-src data: only → animated gif.
(function () {
  if (globalThis.__clawdInjected) return;
  globalThis.__clawdInjected = true;

  var ASSETS = {
    coral2: '__CLAWD_CORAL2__', coral: '__CLAWD_CORAL__', basic: '__CLAWD_BASIC__',
    dj: '__CLAWD_DJ__', idea: '__CLAWD_IDEA__', talk: '__CLAWD_TALK__', big: '__CLAWD_BIG__'
  };
  var LABELS = { coral2: 'コラール', coral: 'コラール2', basic: 'ベーシック', dj: 'DJ', idea: 'ひらめき', talk: 'ふきだし', big: 'ビッグ' };
  var ORDER = Object.keys(ASSETS).filter(function (k) { return ASSETS[k]; });
  if (ORDER.length === 0) { console.log('[clawd] no assets, abort'); return; }

  var MODES = ['needsInput', 'generating', 'default'];
  var MODE_LABEL = { needsInput: 'NEEDS入力', generating: '生成中', default: 'デフォルト' };
  var DEFAULT_BYSTATE = { default: 'coral2', generating: 'dj', needsInput: 'talk' };

  var LS_KEY = 'clawd.companion.v3';
  var pref = {};
  try { pref = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) {}
  var state = {
    visible: pref.visible !== false,
    side: pref.side === 'left' ? 'left' : 'right',  // base edge of the input to anchor to
    byState: {},      // state -> character key
    sizeByChar: {},   // character -> height px
    dxByChar: {},     // character -> horizontal nudge px (+ = right)
    dyByChar: {}      // character -> vertical offset px (+ = lower / more overlap)
  };
  MODES.forEach(function (m) {
    var v = pref.byState && pref.byState[m];
    state.byState[m] = (ORDER.indexOf(v) !== -1) ? v : DEFAULT_BYSTATE[m];
  });
  var oldSize = (typeof pref.size === 'number' && pref.size >= 40 && pref.size <= 240) ? pref.size : 90;
  var oldDy = (typeof pref.offsetY === 'number') ? pref.offsetY : 12;
  ORDER.forEach(function (ch) {
    var s = pref.sizeByChar && pref.sizeByChar[ch];
    state.sizeByChar[ch] = (typeof s === 'number' && s >= 40 && s <= 240) ? s : oldSize;
    var dx = pref.dxByChar && pref.dxByChar[ch];
    state.dxByChar[ch] = (typeof dx === 'number' && dx >= -600 && dx <= 600) ? dx : 0;
    var dy = pref.dyByChar && pref.dyByChar[ch];
    state.dyByChar[ch] = (typeof dy === 'number' && dy >= -200 && dy <= 320) ? dy : oldDy;
  });
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {} }

  var SELECTOR = 'textarea,[contenteditable="true"],[contenteditable="plaintext-only"],.ProseMirror,[role="textbox"]';
  var wrap = null, media = null, menu = null, shownChar = null, lastTarget = null;
  var editState = MODES[0]; // which state's character the menu's sliders edit

  // ASK: breathing-blue glow around the WHOLE WINDOW edge (fixed full-viewport
  // overlay, inset box-shadow). More noticeable than glowing just the choice box.
  // ONE continuous glowing line around the whole window: an SVG rounded rect is a
  // single path (no corner artifacts), with a bright gradient "comet" arc that
  // travels smoothly around it via stroke-dashoffset. Replaces the conic-border
  // which looked segmented/choppy on a non-square window.
  var SVGNS = 'http://www.w3.org/2000/svg';
  var askStyle = document.createElement('style');
  askStyle.textContent =
    '@keyframes clawd-ask-run{to{stroke-dashoffset:-100}}' +
    '#clawd-ask-overlay{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;display:none}' +
    '#clawd-ask-overlay .base{fill:none;stroke:rgba(120,150,255,.22);stroke-width:1.5}' +
    '#clawd-ask-overlay .comet{fill:none;stroke:url(#clawd-ask-grad);stroke-width:1.5;stroke-linecap:round;' +
      'stroke-dasharray:10 90;animation:clawd-ask-run 3s linear infinite;filter:drop-shadow(0 0 2px rgba(110,150,255,.9))}';
  (document.head || document.documentElement).appendChild(askStyle);
  var askSvg = null, askRects = [];
  function sizeAskRect() {
    if (!askSvg) return;
    var w = Math.max(0, window.innerWidth - 6), h = Math.max(0, window.innerHeight - 6);
    for (var i = 0; i < askRects.length; i++) { askRects[i].setAttribute('width', w); askRects[i].setAttribute('height', h); }
  }
  function ensureAskOverlay() {
    if (askSvg) return askSvg;
    askSvg = document.createElementNS(SVGNS, 'svg');
    askSvg.id = 'clawd-ask-overlay';
    askSvg.setAttribute('data-clawd', '1'); // ignored by activity detection
    var defs = document.createElementNS(SVGNS, 'defs');
    var grad = document.createElementNS(SVGNS, 'linearGradient');
    grad.id = 'clawd-ask-grad';
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
    [['0', '#3b82f6'], ['0.5', '#ec4899'], ['1', '#f59e0b']].forEach(function (s) {
      var st = document.createElementNS(SVGNS, 'stop');
      st.setAttribute('offset', s[0]); st.setAttribute('stop-color', s[1]); grad.appendChild(st);
    });
    defs.appendChild(grad); askSvg.appendChild(defs);
    ['base', 'comet'].forEach(function (cls) {
      var r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('class', cls);
      r.setAttribute('x', '3'); r.setAttribute('y', '3');
      r.setAttribute('rx', '12'); r.setAttribute('ry', '12');
      r.setAttribute('pathLength', '100'); // normalize dash units regardless of window size
      askSvg.appendChild(r); askRects.push(r);
    });
    document.body.appendChild(askSvg);
    window.addEventListener('resize', sizeAskRect);
    return askSvg;
  }
  function setAskGlow(on) {
    ensureAskOverlay();
    if (on) sizeAskRect();
    askSvg.style.display = on ? 'block' : 'none';
  }
  // official choice container class is `optionsContainer_<hash>`; hash changes on
  // update → partial match keeps it robust.
  function isAsk() {
    var el = document.querySelector('[class*="optionsContainer"]');
    return !!(el && el.getBoundingClientRect().height > 4);
  }

  function pickInput() {
    var all = Array.prototype.slice.call(document.querySelectorAll(SELECTOR)).filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.width >= 120 && r.height >= 20 && el.offsetParent !== null;
    });
    if (all.length === 0) return null;
    return all.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.bottom * 1000 + rb.width) - (ra.bottom * 1000 + ra.width);
    })[0];
  }

  function buildMedia(ch) {
    var el = document.createElement('img');
    el.src = ASSETS[ch] || ASSETS[ORDER[0]];
    el.alt = '';
    el.setAttribute('data-clawd-media', '1');
    el.draggable = false;
    el.style.cssText = 'position:relative;z-index:1;display:block;pointer-events:none;height:' + (state.sizeByChar[ch] || 90) + 'px;width:auto';
    return el;
  }
  function setMedia(ch) {
    if (!wrap) return;
    if (media) media.remove();
    media = buildMedia(ch);
    wrap.appendChild(media);
  }
  function ensureWrap() {
    if (wrap && wrap.isConnected) return wrap;
    wrap = document.createElement('div');
    wrap.setAttribute('data-clawd', '1');
    wrap.title = 'クリックでメニュー';
    wrap.style.cssText = 'position:fixed;z-index:2147483647;cursor:pointer;user-select:none;transition:top .15s,left .15s,right .15s,bottom .15s';
    shownChar = state.byState.default;
    setMedia(shownChar);
    wrap.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
    document.body.appendChild(wrap);
    console.log('[clawd] companion mounted');
    return wrap;
  }

  // ---- state detection: POSITIVE "generating" signal ----
  // The official chat renders a `spinnerRow` whose inner `spinner` div only gets
  // a child component while busy (o1 = busy && no permission prompt). So a spinner
  // WITH children == Claude is generating. This is immune to the user typing
  // (typing never mounts a spinner). needsInput = the instant generating ends,
  // until the user acts. Class hashes change on update → partial match.
  function isPetNode(n) {
    while (n) {
      if (n.nodeType === 1 && n.getAttribute &&
          (n.getAttribute('data-clawd') || n.getAttribute('data-clawd-menu') ||
           n.getAttribute('data-clawd-media'))) return true;
      n = n.parentNode;
    }
    return false;
  }
  function isGeneratingNow() {
    // PRIMARY: the chat send button swaps its icon to a stop icon
    // (class `stopIcon_<hash>`) only while Claude is generating. Definitive and
    // typing-immune (idle shows `sendIcon`). hash changes on update → partial.
    var stop = document.querySelector('[class*="stopIcon"]');
    if (stop && stop.getClientRects().length > 0) return true;
    // FALLBACK: the spinner status row shows a verb ("Churning…") only when busy
    var rows = document.querySelectorAll('[class*="spinnerRow"]');
    for (var i = 0; i < rows.length; i++) {
      if ((rows[i].textContent || '').trim().length > 0) return true;
    }
    return false;
  }
  var wasGen = false, needsInputFlag = false, generating = false;
  function updateState() {
    var gen = isGeneratingNow();
    if (gen) needsInputFlag = false;
    else if (wasGen) needsInputFlag = true; // just finished -> your turn
    wasGen = gen;
    generating = gen;
  }
  function userActed() { needsInputFlag = false; wasGen = false; }
  function currentMode() {
    if (generating) return 'generating';
    if (needsInputFlag) return 'needsInput';
    return 'default';
  }
  function syncMedia() {
    var ch = state.byState[currentMode()] || state.byState.default || ORDER[0];
    if (ch !== shownChar) { shownChar = ch; setMedia(ch); }
  }

  function place() {
    updateState();
    // ASK: glow the whole window edge blue (breathing) and hide the pet
    var ask = isAsk();
    setAskGlow(ask);
    if (ask) { if (wrap) wrap.style.display = 'none'; return; }

    var target = pickInput();
    if (!target) { if (wrap) wrap.style.display = 'none'; lastTarget = null; return; }
    lastTarget = target;
    var w = ensureWrap();
    var r = target.getBoundingClientRect();
    w.style.display = 'block';
    if (state.visible) {
      syncMedia();
      if (media) media.style.display = 'block';
      w.style.width = 'auto';
      w.style.height = 'auto';
      w.style.borderRadius = '';
      w.style.background = '';
      var ch = shownChar || state.byState.default;
      var dx = state.dxByChar[ch] || 0, dy = state.dyByChar[ch] || 0;
      w.style.bottom = Math.max(0, window.innerHeight - r.top - dy) + 'px';
      w.style.top = 'auto';
      if (state.side === 'left') {
        w.style.left = Math.max(0, (r.left + 4) + dx) + 'px';
        w.style.right = 'auto';
      } else {
        w.style.right = Math.max(0, (window.innerWidth - r.right + 4) - dx) + 'px';
        w.style.left = 'auto';
      }
    } else {
      // hidden: tiny handle to bring it back
      if (media) media.style.display = 'none';
      w.style.width = '12px';
      w.style.height = '12px';
      w.style.borderRadius = '50%';
      w.style.background = 'rgba(217,119,87,0.6)';
      w.style.bottom = 'auto';
      w.style.top = Math.max(0, r.top - 18) + 'px';
      if (state.side === 'left') { w.style.left = Math.max(0, r.left + 4) + 'px'; w.style.right = 'auto'; }
      else { w.style.right = Math.max(0, window.innerWidth - r.right + 4) + 'px'; w.style.left = 'auto'; }
    }
  }

  function toggleMenu() {
    if (!state.visible) { state.visible = true; save(); place(); return; } // handle click -> restore
    if (menu && menu.style.display === 'block') { closeMenu(); return; }
    editState = (MODES.indexOf(currentMode()) !== -1) ? currentMode() : MODES[0];
    openMenu();
  }

  function mkBtn(text, onClick, opts) {
    opts = opts || {};
    var b = document.createElement('button');
    b.textContent = text;
    var extra = opts.sep ? ';border-top:1px solid rgba(255,255,255,.12);margin-top:3px' : '';
    b.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:none;color:' + (opts.dim ? '#9a9aa2' : 'inherit') +
      ';padding:6px 9px;border-radius:4px;cursor:pointer;font:inherit;white-space:nowrap' + extra;
    b.addEventListener('mouseenter', function () { b.style.background = 'rgba(255,255,255,.08)'; });
    b.addEventListener('mouseleave', function () { b.style.background = 'none'; });
    b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  // a [−][label][＋]-style stepper row
  function stepRow(minusTxt, plusTxt, getText, onMinus, onPlus) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 6px';
    var lbl = document.createElement('span');
    lbl.style.cssText = 'flex:1;text-align:center;font:inherit;color:#dddde2';
    lbl.textContent = getText();
    function b(txt, fn) {
      var el = document.createElement('button');
      el.textContent = txt;
      el.style.cssText = 'flex:0 0 30px;background:rgba(255,255,255,.07);border:none;color:#dddde2;border-radius:4px;padding:4px 0;cursor:pointer;font:inherit';
      el.addEventListener('mouseenter', function () { el.style.background = 'rgba(255,255,255,.16)'; });
      el.addEventListener('mouseleave', function () { el.style.background = 'rgba(255,255,255,.07)'; });
      el.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); fn(); lbl.textContent = getText(); });
      return el;
    }
    row.appendChild(b(minusTxt, onMinus));
    row.appendChild(lbl);
    row.appendChild(b(plusTxt, onPlus));
    return row;
  }

  function previewH(ch) { return Math.max(18, Math.min(48, Math.round((state.sizeByChar[ch] || 90) * 0.34))); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function applyLive(ch) { if (shownChar === ch && media) media.style.height = state.sizeByChar[ch] + 'px'; place(); save(); }

  function openMenu() {
    if (!menu) {
      menu = document.createElement('div');
      menu.setAttribute('data-clawd-menu', '1');
      menu.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e1e;border:1px solid rgba(255,255,255,.16);' +
        'border-radius:6px;padding:4px;min-width:200px;font:12px var(--vscode-font-family,sans-serif);color:#dddde2;' +
        'max-height:min(74vh,460px);overflow-y:auto;overflow-x:hidden';
      document.body.appendChild(menu);
    }
    if (MODES.indexOf(editState) === -1) editState = MODES[0];
    menu.innerHTML = '';
    var nowMode = currentMode();

    var hdr = document.createElement('div');
    hdr.textContent = '状態→キャラ（サムネ=切替／行選択で下を調整）';
    hdr.style.cssText = 'padding:4px 9px 3px;font:inherit;font-size:10px;color:#9a9aa2';
    menu.appendChild(hdr);

    MODES.forEach(function (m) {
      var row = document.createElement('div');
      var selected = editState === m;
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;min-height:34px;' +
        (selected ? 'background:rgba(80,150,255,.16)' : '');
      var dot = document.createElement('span');
      dot.textContent = nowMode === m ? '●' : '';
      dot.style.cssText = 'flex:0 0 8px;color:#7fd1ff;font-size:9px';
      var nameBtn = document.createElement('button');
      nameBtn.textContent = MODE_LABEL[m];
      nameBtn.title = 'この状態を調整対象に';
      nameBtn.style.cssText = 'flex:0 0 58px;text-align:left;background:none;border:none;color:inherit;cursor:pointer;font:inherit;padding:2px 0';
      nameBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); editState = m; openMenu(); });
      var thumbBtn = document.createElement('button');
      thumbBtn.title = 'クリックでキャラ切替';
      thumbBtn.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;padding:2px;border-radius:4px;min-width:0';
      thumbBtn.addEventListener('mouseenter', function () { thumbBtn.style.background = 'rgba(255,255,255,.08)'; });
      thumbBtn.addEventListener('mouseleave', function () { thumbBtn.style.background = 'none'; });
      var thumb = document.createElement('img');
      thumb.src = ASSETS[state.byState[m]]; thumb.draggable = false;
      thumb.style.cssText = 'height:' + previewH(state.byState[m]) + 'px;width:auto;display:block';
      thumbBtn.appendChild(thumb);
      thumbBtn.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        var i = ORDER.indexOf(state.byState[m]);
        state.byState[m] = ORDER[(i + 1) % ORDER.length];
        editState = m;
        save(); shownChar = null; syncMedia(); place();
        openMenu();
      });
      row.appendChild(dot); row.appendChild(nameBtn); row.appendChild(thumbBtn);
      menu.appendChild(row);
    });

    // ---- per-character adjust block (for editState's character) ----
    var ch = state.byState[editState];
    var adj = document.createElement('div');
    adj.style.cssText = 'border-top:1px solid rgba(255,255,255,.12);margin-top:3px;padding-top:2px';
    var aLbl = document.createElement('div');
    aLbl.textContent = '調整: ' + MODE_LABEL[editState] + ' = ' + (LABELS[ch] || ch);
    aLbl.style.cssText = 'padding:3px 9px;font:inherit;font-size:10px;color:#7fd1ff';
    adj.appendChild(aLbl);
    adj.appendChild(stepRow('−', '＋', function () { return 'サイズ ' + state.sizeByChar[ch]; },
      function () { state.sizeByChar[ch] = clamp(state.sizeByChar[ch] - 8, 40, 240); applyLive(ch); },
      function () { state.sizeByChar[ch] = clamp(state.sizeByChar[ch] + 8, 40, 240); applyLive(ch); }));
    adj.appendChild(stepRow('↑', '↓', function () { return '上下 ' + state.dyByChar[ch]; },
      function () { state.dyByChar[ch] = clamp(state.dyByChar[ch] - 8, -200, 320); place(); save(); },
      function () { state.dyByChar[ch] = clamp(state.dyByChar[ch] + 8, -200, 320); place(); save(); }));
    adj.appendChild(stepRow('←', '→', function () { return '左右 ' + state.dxByChar[ch]; },
      function () { state.dxByChar[ch] = clamp(state.dxByChar[ch] - 8, -600, 600); place(); save(); },
      function () { state.dxByChar[ch] = clamp(state.dxByChar[ch] + 8, -600, 600); place(); save(); }));
    menu.appendChild(adj);

    menu.appendChild(mkBtn('基準: ' + (state.side === 'right' ? '右寄せ' : '左寄せ') + ' → 切替', function () {
      state.side = state.side === 'right' ? 'left' : 'right'; save(); place(); openMenu();
    }, { sep: true }));
    menu.appendChild(mkBtn('隠す', function () {
      state.visible = false; save(); place(); closeMenu();
    }, { dim: true }));

    var r = wrap.getBoundingClientRect();
    menu.style.display = 'block';
    var mw = menu.offsetWidth || 205;
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - mw - 4)) + 'px';
    menu.style.bottom = Math.max(4, window.innerHeight - r.top + 6) + 'px';
    menu.style.top = 'auto';
  }
  function closeMenu() { if (menu) menu.style.display = 'none'; }
  document.addEventListener('mousedown', function (e) {
    if (menu && menu.style.display === 'block' && !menu.contains(e.target) && (!wrap || !wrap.contains(e.target))) closeMenu();
  });

  function start() {
    place();
    new MutationObserver(place).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('keydown', userActed, true);
    document.addEventListener('pointerdown', function (e) { if (!isPetNode(e.target)) userActed(); }, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    setInterval(function () { place(); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
