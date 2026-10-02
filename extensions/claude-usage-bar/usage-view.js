function formatReset(isoString) {
  if (!isoString) return { rel: "", abs: "" };
  const reset = new Date(isoString);
  if (!Number.isFinite(reset.getTime())) return { rel: "", abs: "" };
  const diff = reset - new Date();
  const abs = reset.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" })
    + " " + reset.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  if (diff <= 0) return { rel: "now", abs };
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const rel = h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return { rel, abs };
}

function barGradient(pct) {
  if (pct >= 90) return { from: "#e53935", to: "#ef5350", text: "#ff8a65" };
  if (pct >= 70) return { from: "#e65100", to: "#f4511e", text: "#ff8a65" };
  if (pct >= 30) return { from: "#ef6c00", to: "#fb8c00", text: "#ffb74d" };
  return { from: "#00897b", to: "#26a69a", text: "#80cbc4" };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function claudeEntries(data) {
  if (!data) return [];
  const entries = [];
  if (data.five_hour) entries.push({ label: "Session", tag: "5h", ...data.five_hour });
  if (data.seven_day) entries.push({ label: "Weekly", tag: "7d", ...data.seven_day });

  // モデル別の週次上限（Fable / Opus / Sonnet …）は data.limits[] に scope 付きで入る。
  // 旧レスポンスの seven_day_opus / seven_day_sonnet は現在 null なので limits を正とする。
  if (Array.isArray(data.limits)) {
    for (const lim of data.limits) {
      const name = lim?.scope?.model?.display_name;
      if (!name) continue;
      const accent = name.toLowerCase() === "fable" ? "purple" : null;
      entries.push({ label: name, tag: "7d", utilization: lim.percent, resets_at: lim.resets_at, accent });
    }
  }

  return entries;
}

function renderRows(entries) {
  return entries.map((e) => {
    const pct = Math.round(Math.min(100, Math.max(0, Number(e.utilization) || 0)));
    // Fable は重要指標なので、使用率に依らず常に紫グラデで際立たせる
    const g = e.accent === "blue"
      ? { from: "#2563eb", to: "#60a5fa", text: "var(--codex-blue)" }
      : e.accent === "purple"
      ? { from: "#7c3aed", to: "#c084fc", text: "#d8b4fe" }
      : barGradient(pct);
    const r = formatReset(e.resets_at);
    const fillGlow = e.accent === "purple"
      ? "box-shadow:0 0 8px rgba(168,85,247,0.6),0 0 2px rgba(168,85,247,0.9);"
      : "";
    return `
    <div class="row${e.accent === "purple" ? " is-fable" : e.accent === "blue" ? " is-codex" : ""}">
      <div class="row-head">
        <span class="label">${escapeHtml(e.label)}<span class="tag">${escapeHtml(e.tag)}</span></span>
        <span class="pct" style="color:${g.text}">${pct}%</span>
      </div>
      <div class="track">
        <div class="fill" style="width:${pct}%;background:linear-gradient(90deg,${g.from},${g.to});${fillGlow}"></div>
      </div>
      <div class="reset">
        <span class="rel">${r.rel}</span>
        <span class="abs">${r.abs}</span>
      </div>
    </div>`;
  }).join("");

}

function renderSection(title, state, entries, codex = false) {
  const heading = `<h2 class="section-title${codex ? ' codex-title' : ''}">${title}</h2>`;
  const content = entries.length ? renderRows(entries) : state.loading
    ? '<div class="loading"><div class="spinner"></div></div>'
    : `<div class="msg">${escapeHtml(state.error || '利用枠データなし')}</div>`;
  const time = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit',
  }) + ' updated' : '';
  const note = state.error && entries.length ? `<div class="status-note">${escapeHtml(state.error)}（前回値を表示中）</div>` : '';
  return `<section aria-label="${title}">${heading}${content}${note}<div class="updated">${state.loading ? '更新中…' : time}</div></section>`;
}

function buildHtml(states) {
  return page(renderSection('CLAUDE USAGE', states.claude, claudeEntries(states.claude.data))
    + renderSection('CODEX USAGE', states.codex, states.codex.data || [], true));
}

function page(body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>
  :root {
    --track: rgba(128,128,128,0.12);
    --codex-blue: #60a5fa;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { --fg:var(--vscode-foreground); --dim:var(--vscode-descriptionForeground); font-family:var(--vscode-font-family); color:var(--fg); padding:10px 14px; }
  body.vscode-light { --codex-blue: #2563eb; }
  section + section { border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,0.18)); margin-top:12px; padding-top:12px; }
  .section-title { font-size:9px; font-weight:600; letter-spacing:0.8px; color:var(--dim); margin-bottom:10px; }
  .codex-title, .is-codex .label { color:var(--codex-blue); }
  .status-note { font-size:10px; color:var(--dim); line-height:1.4; }
  .row { margin-bottom:12px; }
  .row-head {
    display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;
  }
  .label {
    font-size:11px; font-weight:500; color:var(--fg); letter-spacing:0.2px;
  }
  .tag {
    font-size:9px; font-weight:400; color:var(--dim); margin-left:5px; opacity:0.7;
  }
  .pct {
    font-size:10px; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:0.3px;
  }
  .track {
    height:4px; border-radius:2px; background:var(--track); overflow:hidden;
    box-shadow:inset 0 1px 2px rgba(0,0,0,0.2);
  }
  /* Fable は重要指標なので紫グラデ＋グロー＋紫ラベルで目立たせる（太さは他バーと統一） */
  .is-fable .label { color:#d8b4fe; font-weight:700; }
  .fill {
    height:100%; border-radius:2px;
    transition:width 0.5s cubic-bezier(0.4,0,0.2,1);
    box-shadow:0 0 6px rgba(255,255,255,0.05);
  }
  .reset {
    display:flex; justify-content:space-between; align-items:baseline;
    margin-top:4px; padding-top:2px;
  }
  .rel {
    font-size:10px; font-weight:600; color:var(--fg); opacity:0.85;
  }
  .abs {
    font-size:9px; color:var(--dim); opacity:0.6;
  }
  .updated {
    font-size:9px; color:var(--dim); text-align:right;
    margin-top:8px; opacity:0.5;
  }
  .msg { font-size:11px; color:var(--dim); padding:12px 0; text-align:center; }
  .loading { display:flex; justify-content:center; padding:16px 0; }
  .spinner {
    width:14px; height:14px;
    border:2px solid rgba(255,255,255,0.1);
    border-top-color:var(--vscode-focusBorder,#007acc);
    border-radius:50%; animation:s .6s linear infinite;
  }
  @keyframes s { to { transform:rotate(360deg) } }
</style></head><body>${body}</body></html>`;
}


module.exports = { buildHtml, normalizeClaudeUsage: claudeEntries };
