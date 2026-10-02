// Live fast-mode toggle for the Claude Code panel (Cursor / VS Code), with
// optimistic UI.
//
// /fast (slash command) is blocked in the panel's NON-interactive session, but
// the SDK control request `apply_settings` (flagsOnly) is not: the CLI applies
// it to the running session via LGH() — `state.fastMode = Boolean(settings
// .fastMode)`. So the click does:
//   connection.applySettings(channelId, {fastMode:target}, {flagsOnly:true})
// and persists fastMode to ~/.claude/settings.json (so NEW sessions match).
//
// Why optimistic: applySettings does NOT bump a local observable, so the
// `fastModeState` signal only changes when the CLI echoes fast_mode_state (which
// lags, or while idle may not arrive until the next turn). Reflecting that alone
// made the switch fail to move. So we set window.__ccFastWant and immediately
// re-register the menu entry (registerAction -> notify -> the open menu, a
// useSyncExternalStore subscriber, re-renders at once). The autorun clears
// __ccFastWant once the live state catches up.
//
// patch.mjs wraps getConnection() to stash the session on window.__ccSession;
// the connection it returns owns launchClaude (channel id) + applySettings.
(function () {
  if (window.__ccFastToggleInstalled) return;
  window.__ccFastToggleInstalled = true;

  // toast near the bottom-center of the panel
  var toastEl = null, toastTimer = null;
  function toast(msg, ok) {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:64px', 'transform:translateX(-50%)',
          'z-index:2147483647', 'max-width:78vw', 'padding:7px 12px', 'border-radius:8px',
          'font:600 12px/1.45 ui-sans-serif,-apple-system,system-ui,sans-serif',
          'background:rgba(20,20,22,.92)', 'box-shadow:0 6px 24px rgba(0,0,0,.4)',
          'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
          'pointer-events:none', 'opacity:0', 'transition:opacity .18s', 'text-align:center'
        ].join(';');
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.color = ok === false ? '#fca5a5' : '#fde68a';
      toastEl.style.border = '1px solid ' + (ok === false ? 'rgba(248,113,113,.4)' : 'rgba(245,158,11,.4)');
      requestAnimationFrame(function () { toastEl.style.opacity = '1'; });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, 2400);
    } catch (e) {}
  }

  function flip(on) {
    window.__ccFastWant = !!on;
    if (typeof window.__ccFastReg === 'function') {
      try { window.__ccFastReg(!!on); } catch (e) {}
    }
  }

  // target === true -> ON for this session, false -> OFF
  window.__ccApplyFast = async function (target) {
    target = !!target;
    flip(target); // optimistic: move the switch right now

    var sess = window.__ccSession;
    try {
      if (!sess || typeof sess.launchClaude !== 'function' || typeof sess.getConnection !== 'function') {
        throw new Error('session not ready');
      }
      var chan = await sess.launchClaude();
      var conn = await sess.getConnection();
      if (!conn || typeof conn.applySettings !== 'function') throw new Error('applySettings unavailable');
      // Live apply to the current session (flags layer); CLI echoes fast_mode_state.
      await conn.applySettings(chan, { fastMode: target }, { flagsOnly: true });
      // Persist for new sessions (best-effort; the live apply already happened).
      try {
        if (typeof window.__ccFastHost === 'function') await window.__ccFastHost('set', target);
      } catch (e) { /* persistence is secondary */ }
      toast(target ? 'fast mode ON' : 'fast mode OFF', true);
    } catch (err) {
      // Revert the optimistic flip to the real live state (data-spark = fast on).
      window.__ccFastWant = null;
      try {
        var live = !!document.querySelector('[data-spark]');
        if (typeof window.__ccFastReg === 'function') window.__ccFastReg(live);
      } catch (e) {}
      toast('切替に失敗: ' + (err && err.message ? err.message : err), false);
      try { console.error('[cc-fast] applyFast failed:', err); } catch (e) {}
    }
  };
})();
