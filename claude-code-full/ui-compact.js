// Compact-footer stylesheet injector for the Claude Code panel.
//
// The webview CSP is `style-src 'unsafe-inline'`, so a <style> element works.
// The rules themselves live in ui-compact.css; patch.mjs inlines that file
// into the __CC_UI_COMPACT_CSS__ token below (JSON-stringified) and prepends
// this IIFE to webview/index.js next to the companion and the fast helper.
// Anchor-independent: nothing in the official bundle is matched or replaced,
// so an extension update can only make a selector inert, never break the panel.
//
// Also mirrors the model pill's label into its tooltip: on narrow panels the
// CSS collapses the pill to a Claude-logo icon (text hidden), so hovering
// should still tell you which model is active. React sets title="Switch model"
// once and only rewrites it if that prop changes (it never does), so our value
// survives re-renders.
(function () {
  if (window.__ccUiCompactInstalled) return;
  window.__ccUiCompactInstalled = true;

  var CSS = __CC_UI_COMPACT_CSS__;
  var ID = 'cc-ui-compact';

  // TEMPORARY DIAGNOSTIC (v48). The narrow-panel collapse stopped firing and
  // static analysis cleared the fit logic, the official CSS and the DOM shape,
  // so we need the live value. Mirrors the footer's data-fit-stage into the
  // pill tooltip (hover the model pill while narrowing the panel) and logs
  // every change. Set to false and bump PATCH_VERSION to turn it off.
  var DEBUG_FIT = false;
  var lastStage = null;

  function install() {
    try {
      if (document.getElementById(ID)) return;
      var el = document.createElement('style');
      el.id = ID;
      el.textContent = CSS;
      // Append last so we win ties against the bundled index.css at equal specificity.
      (document.head || document.documentElement).appendChild(el);
    } catch (e) {
      try { console.error('[cc-ui-compact] install failed:', e); } catch (_e) {}
    }
  }

  var syncQueued = false;
  function syncOverflow() {
    var footers = document.querySelectorAll('[class*="inputFooter"][data-fit-stage]');
    footers.forEach(function (footer) {
      Array.from(footer.children).forEach(function (child) {
        var primary = child.matches('[class*="addButtonContainer_"], [class*="spacer_"], [class*="sendButton_"], .cc-footer-more') ||
          child.matches('[class*="modelPill_"]:not([class*="agentsPill"])') ||
          child.querySelector(':scope > button[class*="footerButtonPrimary_"]');
        // Native popovers are positioned overlays, not toolbar actions.
        if (!primary && getComputedStyle(child).position !== 'absolute') child.setAttribute('data-cc-secondary', '');
      });
      if (footer.querySelector('.cc-footer-more')) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'cc-footer-more';
      button.textContent = '…';
      button.title = 'その他の操作';
      button.setAttribute('aria-label', 'その他の操作');
      button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', function () {
        var open = footer.toggleAttribute('data-cc-more-open');
        button.setAttribute('aria-expanded', String(open));
      });
      footer.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !footer.hasAttribute('data-cc-more-open')) return;
        footer.removeAttribute('data-cc-more-open');
        button.setAttribute('aria-expanded', 'false');
        button.focus();
      });
      footer.insertBefore(button, footer.querySelector('[class*="spacer_"]'));
    });
  }
  function syncModelTitle() {
    syncQueued = false;
    try {
      syncOverflow();
      var pills = document.querySelectorAll('[class*="modelPill_"]:not([class*="agentsPill"])');
      for (var i = 0; i < pills.length; i++) {
        var pill = pills[i];
        var name = String(pill.textContent || '').replace(/\s+/g, ' ').trim();
        var want = name ? name + ' · Switch model' : 'Switch model';
        if (DEBUG_FIT) {
          var footer = pill.closest ? pill.closest('[class*="inputFooter"]') : null;
          var stage = footer ? footer.getAttribute('data-fit-stage') : null;
          var applied = '';
          try {
            applied = getComputedStyle(pill).width;
          } catch (_e) {}
          want += ' · fit=' + (stage === null ? 'NO-FOOTER' : stage) + ' w=' + applied;
          if (stage !== lastStage) {
            lastStage = stage;
            try {
              console.log('[cc-ui-compact] data-fit-stage =', stage,
                '| pill width =', applied,
                '| footer children =', footer ? footer.children.length : 'n/a');
            } catch (_e2) {}
          }
        }
        if (pill.getAttribute('title') !== want) pill.setAttribute('title', want);
        // Hidden spans no longer provide an accessible name in icon mode.
        if (pill.getAttribute('aria-label') !== want) pill.setAttribute('aria-label', want);
      }
    } catch (e) {}
  }
  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(syncModelTitle);
  }
  function watch() {
    try {
      var root = document.body || document.documentElement;
      if (!root) return;
      new MutationObserver(queueSync).observe(root, { childList: true, subtree: true, characterData: true });
      queueSync();
    } catch (e) {}
  }

  install();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { install(); watch(); }, { once: true });
  } else {
    watch();
  }
})();
