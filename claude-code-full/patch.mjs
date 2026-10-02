#!/usr/bin/env node
// Patch the official Anthropic Claude Code VS Code/Cursor extension so any
// file dropped into the chat (pptx/docx/xlsx/csv/anything) gets attached as
// an absolute @path mention.
//
// Why this is non-trivial:
//   - Cursor's webview is sandboxed; dataTransfer strips text/uri-list, so
//     the webview cannot recover the absolute filesystem path from a Finder
//     drop on its own.
//   - File.path / webUtils.getPathForFile are not exposed inside webviews.
//   - So we must round-trip the bytes: webview reads File via arrayBuffer,
//     base64-encodes it, posts to the extension host, host writes it to
//     /tmp/claude-attachments/<ts>-<name>, replies with the absolute path,
//     webview calls the chat input's insertAtMention(path).
//
// This patcher modifies TWO files:
//   1. extension.js   — prepend a helper, wrap 3x onDidReceiveMessage handlers
//   2. webview/index.js — prepend an acquireVsCodeApi capture, replace t(k1)
//
// Idempotent. Backs up originals to `<file>.bak.original`.
// Run periodically (launchd) to survive extension updates.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PATCH_VERSION = 'v52';
const MARKER_EXT      = `/*__claude-code-attach-patch-ext-${PATCH_VERSION}__*/`;
const MARKER_WV       = `/*__claude-code-attach-patch-wv-${PATCH_VERSION}__*/`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, 'assets');

// Clawd companion characters, baked to gif data URIs at patch time.
// (webview CSP allows `img-src data:` only — no media-src — so these are gifs.)
// token in clawd-companion.js -> gif file in assets/
const CLAWD_ASSETS = {
  __CLAWD_CORAL2__: 'clawd-coral2.gif',
  __CLAWD_CORAL__:  'clawd-coral.gif',
  __CLAWD_BASIC__:  'clawd-basic.gif',
  __CLAWD_DJ__:     'clawd-dj.gif',
  __CLAWD_IDEA__:   'clawd-idea.gif',
  __CLAWD_TALK__:   'clawd-talk.gif',
  __CLAWD_BIG__:    'clawd-big.gif',
};
function gifDataUri(file) {
  const p = path.join(ASSETS_DIR, file);
  return fs.existsSync(p) ? `data:image/gif;base64,${fs.readFileSync(p).toString('base64')}` : '';
}

// The Clawd companion lives in its own readable file; we inline it (with the
// asset placeholders filled in) so it gets prepended into the webview bundle.
let COMPANION_SRC = fs.readFileSync(path.join(HERE, 'clawd-companion.js'), 'utf8');
for (const [token, file] of Object.entries(CLAWD_ASSETS)) {
  COMPANION_SRC = COMPANION_SRC.split(token).join(gifDataUri(file));
}

// Tiny helper (defines window.__ccToggleFast) prepended like the companion.
// Needs the session capture below to reach the live session for /fast.
const FAST_TOGGLE_SRC = fs.readFileSync(path.join(HERE, 'fast-toggle.js'), 'utf8');

// v45: compact composer footer. 2.1.258 introduced two oversized 9999px pills
// in the footer (model selector `modelPill_<hash>`, Remote Control
// `pill_<hash> pillOn_<hash>`; padding 4px 16px, font 1em, 26px min-height).
// ui-compact.css re-fits them to the footer's 22px/borders-only scale; the
// webview CSP allows `style-src 'unsafe-inline'`, so ui-compact.js just
// appends a <style>. Pure prepend, no anchor — an update can only make a
// selector inert. Edit the .css, bump PATCH_VERSION, `node patch.mjs`.
// v46: on narrow panels (data-fit-stage 1+) the model pill collapses to the
// Claude logo (assets/claude-logo.svg = the extension's own
// resources/claude-logo.svg), inlined as a data: URI for a CSS mask.
function svgDataUri(file) {
  const p = path.join(ASSETS_DIR, file);
  return fs.existsSync(p) ? `data:image/svg+xml;base64,${fs.readFileSync(p).toString('base64')}` : '';
}
const UI_COMPACT_CSS = fs.readFileSync(path.join(HERE, 'ui-compact.css'), 'utf8')
  .split('__CC_CLAUDE_LOGO__').join(svgDataUri('claude-logo.svg'));
const UI_COMPACT_SRC = fs.readFileSync(path.join(HERE, 'ui-compact.js'), 'utf8')
  .split('__CC_UI_COMPACT_CSS__')
  .join(JSON.stringify(UI_COMPACT_CSS));

// Turn the official "Toggle fast mode" menu entry (Model section of the "/"
// actions menu) into a Thinking-style live toggle: an ON/OFF switch that
// reflects fast_mode_state and flips it in-session instead of opening a
// terminal. We DON'T hardcode the minified React var / switch component /
// facade names (they get renamed on extension updates — see the v8/v34 break
// notes). Instead we capture them from stable string-literal anchors:
//   - RE_A: the adjacent "Thinking" toggle yields the JSX factory (e.g. b) and
//     the switch component (e.g. MD). Capture-only, never replaced.
//   - RE_B: the fast registration itself yields the state facade var and the
//     services var. Replaced with the live-toggle version.
// v43: 2.1.196 moved the menu from `Ke.default.createElement(ON,{isOn:K})` to
// the automatic JSX runtime `b(MD,{isOn:K})` (children/ref live INSIDE the props
// object now). So RE_A captures the factory-call form `b(MD,{isOn})` instead of
// `Ke.default.createElement(ON,{isOn})`, and buildFastMenuReplacement emits
// `b(type,{...props,children})` instead of `React.createElement(type,props,child)`.
// v44: 2.1.243+ minifier started emitting `$` as an identifier (e.g. the state
// facade is literally `$`, the session's connection var is `$`). `\w` does NOT
// include `$`, so every `(\w+)` identifier capture went dead at once (ext
// handler wrap, session capture, fast menu). All identifier captures are now
// `[\w$]+`. Replacements were already function-form (safe when a captured name
// is `$`, which is special in string-form replacements).
const FASTMENU_CAPTURE_RE =
  /trailingComponent:([\w$]+)\(([\w$]+),\{isOn:[\w$]+\}\),keepMenuOpen:!0\},"Model",\(\)=>\{([\w$]+)\.setThinkingLevel/;
const FASTMENU_RE =
  /if\(!([\w$]+)\.currentModelSupportsFastMode\.value\)\{([\w$]+)\.commandRegistry\.unregisterAction\("fast"\);return\}\2\.commandRegistry\.registerAction\(\{id:"fast",label:"Toggle fast mode",description:"Toggle fast mode for faster responses \(Opus only\)"\},"Model",\(\)=>\{([\w$]+)\.openClaudeInTerminal\("\/fast",\[\],"bottom"\)\}\)/;

// LIVE toggle with OPTIMISTIC UI. /fast (the slash command) is blocked in the
// non-interactive panel, but the SDK control request `apply_settings` (flagsOnly)
// is not — the CLI applies it to the running session via LGH() (merges fastMode
// into the active config). The catch: unlike setThinkingLevel, applySettings
// does NOT update a local observable, so the `fastModeState` signal only changes
// when the CLI later echoes fast_mode_state — which can lag or (while idle) not
// arrive until the next turn. Reflecting fastModeState alone made the switch
// "not move sometimes".
//
// Fix: optimistic state. `window.__ccFastWant` holds the user's last intended
// value; the switch shows want (if pending) else the live fastModeState. On
// click the helper sets want + re-registers immediately (registerAction calls
// this.notify(), and the menu is a useSyncExternalStore subscriber, so the open
// menu re-renders at once). When the CLI finally echoes a matching
// fastModeState, the autorun clears want (reconciled). We expose the
// registration as window.__ccFastReg(isOn) so the helper can drive that instant
// re-render; the autorun also reads both observables to stay reactive.
//
// UI rules: filter reads `cmd.label.toLowerCase()` so `label` MUST stay a
// string; `labelSuffix`/`trailingComponent` may be React elements. On non-Opus
// the row is dimmed (walk up the trailing ref to the `commandItem` row, set
// opacity — CSP-safe) and the click is a no-op.
function buildFastMenuReplacement(jsxFn, switchComp) {
  // jsxFn is the automatic-runtime factory (b = Xbe): jsxFn(type, props) with
  // children/ref carried INSIDE props (props.children, props.ref). No varargs.
  return (_m, stateVar, svcVar /* , svc2 */) =>
    `let __ccSup=${stateVar}.currentModelSupportsFastMode.value,__ccLive=${stateVar}.fastModeState.value!=="off";` +
    `if(window.__ccFastWant!=null&&!!window.__ccFastWant===__ccLive)window.__ccFastWant=null;` +
    `window.__ccFastReg=function(__on){` +
      `let __s=${stateVar}.currentModelSupportsFastMode.value;` +
      `${svcVar}.commandRegistry.registerAction({id:"fast",label:"Fast mode",` +
      `labelSuffix:__s?void 0:${jsxFn}("span",{style:{opacity:.6,fontWeight:400,marginLeft:6},children:"Opus\\u5C02\\u7528"}),` +
      `description:__s?"\\u3053\\u306E\\u30BB\\u30C3\\u30B7\\u30E7\\u30F3\\u3067 fast mode \\u3092\\u5207\\u66FF\\uFF08Opus\\u30FB\\u5FDC\\u7B54\\u304C\\u901F\\u304F\\u306A\\u308B\\uFF09":"Opus\\u30E2\\u30C7\\u30EB\\u3067\\u306E\\u307F\\u6709\\u52B9\\uFF08\\u30E2\\u30C7\\u30EB\\u3092 Opus \\u306B\\u5207\\u66FF\\uFF09",` +
      `trailingComponent:${jsxFn}("span",{ref:function(__el){try{if(__el){var __r=__el.closest('[class*="commandItem"]');if(__r)__r.style.opacity=__s?"":"0.42"}}catch(_e){}},style:{display:"inline-flex",alignItems:"center"},children:${jsxFn}(${switchComp},{isOn:__s&&!!__on})}),` +
      `keepMenuOpen:!0},"Model",` +
      `()=>{if(!__s)return;var __cur=window.__ccFastWant!=null?!!window.__ccFastWant:(${stateVar}.fastModeState.value!=="off");try{window.__ccApplyFast&&window.__ccApplyFast(!__cur)}catch(_e){}});` +
    `};` +
    `window.__ccFastReg(window.__ccFastWant!=null?!!window.__ccFastWant:__ccLive)`;
}

// Stash the *session* instance on globalThis so the fast pill can drive /fast
// into the current panel session. getConnection() is a stable, non-minified
// method, but there are TWO classes with that exact method head — only the
// session one continues with `this.connectionProvider()` (the other is the
// comms facade with `this.comms.open()`). We anchor on connectionProvider so we
// capture the session (which also owns launchClaude + sendInput-bearing conn).
// v44: the local var is minifier-named (`e` through 2.1.196, `$` in 2.1.243+),
// so it's captured instead of hardcoded. Function replacement keeps a captured
// `$` literal.
const SESSION_CAPTURE_RE =
  /getConnection\(\)\{if\(this\.currentConnection\)return this\.currentConnection;let ([\w$]+)=this\.connectionProvider\(\);/;
function buildSessionCaptureReplacement(_m, connVar) {
  return `getConnection(){try{globalThis.__ccSession=this}catch(_cc){}if(this.currentConnection)return this.currentConnection;let ${connVar}=this.connectionProvider();`;
}

// ---------- extension.js patches ----------

// Helper prepended to extension.js. Handles two host IPCs:
//   __patch_save_attachment__ — decode base64, write to /tmp, reply abs path.
//   __patch_fastmode__        — get/set the persistent `fastMode` flag in
//                               ~/.claude/settings.json. Runtime /fast is
//                               blocked in the non-interactive panel session
//                               (it's an interactive-only command), so the
//                               only honest in-panel lever is the persisted
//                               default, which a NEW panel session reads at
//                               startup (options.fastMode = Mw8(model)). We
//                               edit the value in place (targeted text replace,
//                               no full reparse) so the user's hand-maintained
//                               settings.json keeps its formatting.
const EXT_HELPER_PREPEND = MARKER_EXT +
`(function(){if(globalThis.__claudePatchHandle)return;` +
`const fs=require('fs'),path=require('path'),os=require('os');` +
`const DIR=path.join(os.tmpdir(),'claude-attachments');` +
`const SETTINGS=path.join(os.homedir(),'.claude','settings.json');` +
`function getFast(){try{const t=fs.readFileSync(SETTINGS,'utf8');const m=t.match(/"fastMode"\\s*:\\s*(true|false)/);return m?m[1]==='true':false;}catch(e){return false;}}` +
`function setFast(v){let t=fs.readFileSync(SETTINGS,'utf8');const lit=v?'true':'false';` +
  `if(/"fastMode"\\s*:\\s*(true|false)/.test(t)){t=t.replace(/("fastMode"\\s*:\\s*)(true|false)/,'$1'+lit);}` +
  `else{t=t.replace(/\\{/,'{\\n  "fastMode": '+lit+',');}` +
  `fs.writeFileSync(SETTINGS,t);return v;}` +
`globalThis.__claudePatchHandle=function(msg,webview){` +
  `if(!msg)return false;` +
  `if(msg.type==='__patch_save_attachment__'){` +
    `try{` +
      `fs.mkdirSync(DIR,{recursive:true});` +
      `const ts=Date.now();` +
      `const safe=String(msg.name||'file').replace(/[^\\w.\\-\\u3000-\\u9FFF]/g,'_');` +
      `const filePath=path.join(DIR,ts+'-'+safe);` +
      `const b64=(msg.dataUrl||'').split(',').pop();` +
      `fs.writeFileSync(filePath,Buffer.from(b64,'base64'));` +
      `webview.postMessage({type:'__patch_attachment_saved__',requestId:msg.requestId,path:filePath,name:msg.name});` +
    `}catch(e){` +
      `webview.postMessage({type:'__patch_attachment_saved__',requestId:msg.requestId,error:e.message});` +
    `}` +
    `return true;` +
  `}` +
  `if(msg.type==='__patch_fastmode__'){` +
    `try{const val=msg.action==='set'?setFast(!!msg.value):getFast();` +
      `webview.postMessage({type:'__patch_fastmode_result__',requestId:msg.requestId,value:val});` +
    `}catch(e){webview.postMessage({type:'__patch_fastmode_result__',requestId:msg.requestId,error:e.message});}` +
    `return true;` +
  `}` +
  `return false;` +
`};})();`;

// Pattern of the chat-panel onDidReceiveMessage. There are 3 of these in
// extension.js. EVERY minified name is captured — panel var included.
// (2.1.165+ renamed the panel var z -> e and the old hardcoded `z.webview`
// anchor went dead; same failure mode as the v8 webview break.)
// Shape (2.1.170):
//   e.webview.onDidReceiveMessage((a)=>{this.output.info(`Received message
//   from webview: ${JSON.stringify(a)}`),o?.fromClient(a)},null,...)
// Captures: 1=panelVar 2=open 3=paramVar 4=mid 5=sessionVar 6=fromClientCall
// (2.1.243+ names the panel var literally `$` — hence [\w$]+, see v44 note.)
// (2.1.270+ no longer inlines JSON.stringify: the log now goes through a
//  redacting helper, `${Xk(V)}`, so the serializer is captured as [\w$]+ too.
//  Group 4 is re-emitted verbatim by wrapHandler, so whichever helper the
//  bundle uses is preserved untouched. See v48 note.)
const HANDLER_RE = /([\w$]+)(\.webview\.onDidReceiveMessage\(\()([\w$]+)(\)=>\{this\.output\.info\(`Received message from webview: \$\{[\w$]+\(\3\)\}`\),)([\w$]+)(\?\.fromClient\(\3\))/g;

function wrapHandler(_, panelVar, openParen, paramVar, mid, sessionVar, fromClientCall) {
  return panelVar + openParen + paramVar + mid +
    `(globalThis.__claudePatchHandle&&globalThis.__claudePatchHandle(${paramVar},${panelVar}.webview)?void 0:` +
    sessionVar + fromClientCall + `)`;
}

// ---------- webview/index.js patches ----------

// Prepend: capture vscode API the first time acquireVsCodeApi is called.
// The official code calls it exactly once during bootstrap; we wrap it so
// our drop handler can postMessage to the host later.
const WV_PREPEND = MARKER_WV +
`(function(){if(globalThis.__claudePatchVsApi||!window.acquireVsCodeApi)return;` +
`const __orig=window.acquireVsCodeApi;` +
`window.acquireVsCodeApi=function(){` +
  `if(globalThis.__claudePatchVsApi)return globalThis.__claudePatchVsApi;` +
  `const api=__orig();` +
  `globalThis.__claudePatchVsApi=api;` +
  `return api;` +
`};` +
`globalThis.__claudePatchPending=new Map();` +
`window.addEventListener('message',function(ev){` +
  `const m=ev&&ev.data;if(!m||m.type!=='__patch_attachment_saved__')return;` +
  `const r=globalThis.__claudePatchPending.get(m.requestId);` +
  `if(r){globalThis.__claudePatchPending.delete(m.requestId);r(m);}` +
`});` +
`globalThis.__claudePatchSave=function(file){` +
  `return new Promise(function(resolve,reject){` +
    `try{` +
      `const reader=new FileReader();` +
      `reader.onload=function(){` +
        `try{` +
          `const api=globalThis.__claudePatchVsApi;` +
          `if(!api){reject(new Error('vscode api handle not captured'));return;}` +
          `const reqId='p_'+Date.now()+'_'+Math.random().toString(36).slice(2);` +
          `globalThis.__claudePatchPending.set(reqId,function(reply){` +
            `if(reply.error)reject(new Error(reply.error));` +
            `else resolve(reply.path);` +
          `});` +
          `api.postMessage({type:'__patch_save_attachment__',name:file.name,dataUrl:reader.result,requestId:reqId});` +
          `setTimeout(function(){` +
            `if(globalThis.__claudePatchPending.has(reqId)){` +
              `globalThis.__claudePatchPending.delete(reqId);` +
              `reject(new Error('host save timeout'));` +
            `}` +
          `},15000);` +
        `}catch(e){reject(e);}` +
      `};` +
      `reader.onerror=function(){reject(reader.error||new Error('FileReader error'));};` +
      `reader.readAsDataURL(file);` +
    `}catch(e){reject(e);}` +
  `});` +
`};` +
// Bridge for the persistent fastMode setting (get/set ~/.claude/settings.json
// via the host). Shares the pending map; results arrive as __patch_fastmode_result__.
`window.addEventListener('message',function(ev){` +
  `const m=ev&&ev.data;if(!m||m.type!=='__patch_fastmode_result__')return;` +
  `const r=globalThis.__claudePatchPending.get(m.requestId);` +
  `if(r){globalThis.__claudePatchPending.delete(m.requestId);r(m);}` +
`});` +
`globalThis.__ccFastHost=function(action,value){` +
  `return new Promise(function(resolve,reject){` +
    `const api=globalThis.__claudePatchVsApi;` +
    `if(!api){reject(new Error('vscode api handle not captured'));return;}` +
    `const reqId='ccf_'+Date.now()+'_'+Math.random().toString(36).slice(2);` +
    `globalThis.__claudePatchPending.set(reqId,function(reply){` +
      `if(reply.error)reject(new Error(reply.error));else resolve(reply.value);` +
    `});` +
    `api.postMessage({type:'__patch_fastmode__',action:action,value:value,requestId:reqId});` +
    `setTimeout(function(){if(globalThis.__claudePatchPending.has(reqId)){globalThis.__claudePatchPending.delete(reqId);reject(new Error('host fastmode timeout'));}},8000);` +
  `});` +
`};` +
// (Clawd companion lives in clawd-companion.js and is prepended separately.)
`})();`;

// Replacement of the `t(k1)` call.
//
// For each unsupported file:
//   1. Save the original bytes via host -> get abs path
//   2. Build a fake File whose contents are the abs path marker text but
//      whose name is the ORIGINAL filename (e.g. "foo.pptx") and whose
//      MIME is "text/plain" — this makes the official VB1() classify it
//      as "text", so the official chip UI renders it, and the official
//      HB1() sends it to the API as a text document.
//   3. FileReader -> dataUrl, then push { file, dataUrl } into the official
//      attachments state W (same shape as ux() produces).
//
// Net result: pptx/docx/xlsx etc. appear as a normal chip card with the
// real filename, and Claude receives a text block telling it the absolute
// path on disk to inspect with Read/Bash.
// The unsupported-file rejection appears in 3 webview call sites (drop,
// file-picker, paste), each minified with DIFFERENT variable names. We patch
// the DROP handler — the one reading from `<evt>.dataTransfer.files`. Every
// variable name is CAPTURED (not hardcoded), so the patch survives the
// minifier renaming them on each extension update. This is exactly what broke
// in v8: the callback arg `Y0` became `Q0` in 2.1.154 and the anchor missed.
//
// Drop handler shape (2.1.170):
//   let De=q.dataTransfer?.files;
//   if(De&&De.length>0){
//     let{attachments:Rt,unsupportedFiles:Ri}=await pR(De);
//     if(Rt.length>0)p((no)=>[...no,...Rt]);J(Ri)
//   }
//
// The classify fn is also minified-renamed across versions (ux in 2.1.153 ->
// cx in 2.1.154+ -> pR in 2.1.170), so it too is captured rather than
// hardcoded. The unsupported-toast fn kept the name `t` for a long time and
// was the last hardcoded name left — 2.1.165+ renamed it (J in 2.1.170) and
// the anchor went dead. Now captured like everything else.
// Captures: 1=filesVar 2=dropEvt 3=supportedVar 4=unsupportedVar 5=classifyFn 6=setter 7=arg 8=toastFn
const WV_DROP_RE = /let ([\w$]+)=([\w$]+)\.dataTransfer\?\.files;if\(\1&&\1\.length>0\)\{let\{attachments:([\w$]+),unsupportedFiles:([\w$]+)\}=await ([\w$]+)\(\1\);if\(\3\.length>0\)([\w$]+)\(\(([\w$]+)\)=>\[\.\.\.\7,\.\.\.\3\]\);([\w$]+)\(\4\)\}/;

// IIFE that does the real work. Called as (unsupportedNames, allFiles, setter, toast):
//   __k1=unsupported filename array, __files=full File list, __W=attachments
//   setter, __t=the official "Unsupported file type" toast (captured from the
//   drop site — its minified name changes across versions, so it's passed in).
const WV_REPLACEMENT_IIFE =
  `((__k1,__files,__W,__t)=>{` +
    `if(!__k1||__k1.length===0)return;` +
    `(async function(){` +
      `const __targets=Array.from(__files||[]).filter(function(f){return __k1.indexOf(f.name)!==-1;});` +
      `if(__targets.length===0){__t(__k1);return;}` +
      `const __toDataUrl=function(file){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(e){res(e.target?.result);};r.onerror=rej;r.readAsDataURL(file);});};` +
      `const __new=[];` +
      `for(const f of __targets){` +
        `try{` +
          `const p=await globalThis.__claudePatchSave(f);` +
          `const marker="[ATTACHED FILE]\\nABSOLUTE_PATH: "+p+"\\nORIGINAL_NAME: "+f.name+"\\nORIGINAL_MIME: "+(f.type||"application/octet-stream")+"\\n\\nThis file was attached to chat. Use the Read or Bash tool on the absolute path above to inspect its actual contents. For pptx/docx/xlsx, unzip and parse the inner XML to extract text.";` +
          `const __blob=new Blob([marker],{type:"text/plain"});` +
          `const __fakeFile=new File([__blob],f.name,{type:"text/plain",lastModified:f.lastModified||Date.now()});` +
          `const __dataUrl=await __toDataUrl(__fakeFile);` +
          `__new.push({file:__fakeFile,dataUrl:__dataUrl});` +
        `}catch(e){console.error('[claude-patch]',f.name,e);__t([f.name]);}` +
      `}` +
      `if(__new.length>0)__W(function(Y0){return [...(Y0||[]),...__new];});` +
    `})();` +
  `})`;

// Rebuild the matched drop handler: keep the supported-file path verbatim
// (with this site's captured names), then swap toast(unsupported) for our IIFE
// wired to the same names.
function buildDropReplacement(_m, filesVar, dropEvt, supVar, unsupVar, classifyFn, setterVar, argVar, toastFn) {
  const keep =
    `let ${filesVar}=${dropEvt}.dataTransfer?.files;` +
    `if(${filesVar}&&${filesVar}.length>0){` +
      `let{attachments:${supVar},unsupportedFiles:${unsupVar}}=await ${classifyFn}(${filesVar});` +
      `if(${supVar}.length>0)${setterVar}((${argVar})=>[...${argVar},...${supVar}]);`;
  const call = WV_REPLACEMENT_IIFE + `(${unsupVar},${dropEvt}.dataTransfer?.files,${setterVar},${toastFn})`;
  return keep + call + `}`;
}

// ---------- patcher core ----------

function findExtensionDirs() {
  const candidates = [
    path.join(os.homedir(), '.cursor', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  ];
  const out = [];
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith('anthropic.claude-code')) continue;
      const dir = path.join(root, entry);
      const ext = path.join(dir, 'extension.js');
      const wv = path.join(dir, 'webview', 'index.js');
      if (fs.existsSync(ext) && fs.existsSync(wv)) out.push({ host: path.basename(root), dir, ext, wv });
    }
  }
  return out;
}

function backupOnce(target) {
  const bak = target + '.bak.original';
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(target, bak);
    console.log(`[backup] ${bak}`);
  }
}

function restoreIfPatchedOldVersion(target, currentMarker) {
  // If file has any old marker (different version), restore from backup first.
  const src = fs.readFileSync(target, 'utf8');
  const oldMarker = src.match(/\/\*__claude-code-attach-patch[^*]*__\*\//);
  if (oldMarker && !src.includes(currentMarker)) {
    const bak = target + '.bak.original';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, target);
      console.log(`[reset] old patch detected (${oldMarker[0]}), restored from backup`);
      return true;
    }
  }
  return false;
}

// Keep the real model button in the measured footer even at stage 2. The
// official fallback moves it into a SIBLING modelPillRow, outside the compact
// CSS selectors. Fix both render gates together; never reparent React DOM.
// All minified identifiers are captured (including $), not hardcoded.
const MODEL_ROW_RE = /([\w$]+)===2&&([\w$]+)\("div",\{className:([\w$]+)\.modelPillRow,children:\2\(([\w$]+),\{\.\.\.([\w$]+),ownRow:!0\}\)\}\)/g;
function keepModelPillInline(source) {
  const rows = [...source.matchAll(MODEL_ROW_RE)];
  if (rows.length !== 1) return { source, ok: false };
  const [row, stage, jsx, , component, props] = rows[0];
  const button = `${jsx}(${component},{...${props}})`;
  const inlineGate = `${stage}!==2&&${button}`;
  if (source.split(inlineGate).length !== 2) return { source, ok: false };
  return {
    source: source.replace(inlineGate, () => button).replace(row, () => '!1'),
    ok: true,
  };
}

function patchExtensionJs({ ext }) {
  backupOnce(ext);
  restoreIfPatchedOldVersion(ext, MARKER_EXT);
  let src = fs.readFileSync(ext, 'utf8');

  if (src.includes(MARKER_EXT)) {
    return { ok: true, changed: false };
  }

  const handlers = (src.match(HANDLER_RE) || []).length;
  if (handlers === 0) {
    console.error(`[FAIL ext] no chat onDidReceiveMessage handlers matched: ${ext}`);
    return { ok: false };
  }

  let patched = src.replace(HANDLER_RE, wrapHandler);
  patched = EXT_HELPER_PREPEND + patched;

  fs.writeFileSync(ext, patched);
  console.log(`[ OK  ext] wrapped ${handlers} handlers + prepended helper`);
  return { ok: true, changed: true };
}

function patchWebviewJs({ wv }) {
  backupOnce(wv);
  restoreIfPatchedOldVersion(wv, MARKER_WV);
  let src = fs.readFileSync(wv, 'utf8');

  if (src.includes(MARKER_WV)) {
    return { ok: true, changed: false };
  }

  // The Clawd companion + vscode-api capture are pure prepends with no anchor
  // dependency, so they get injected even when the drop anchor is broken by an
  // extension update. (Before v34 a dead drop anchor aborted the whole webview
  // patch and took the companion down with it — that's how Clawd "disappeared"
  // on 2.1.165+.)
  const dropOk = WV_DROP_RE.test(src);
  let patched = dropOk ? src.replace(WV_DROP_RE, buildDropReplacement) : src;

  // Session capture for the fast toggle. Anchor-independent of the drop patch:
  // if this misses, the toggle is inert but attach/companion are fine.
  const captureOk = SESSION_CAPTURE_RE.test(patched);
  if (captureOk) patched = patched.replace(SESSION_CAPTURE_RE, buildSessionCaptureReplacement);

  // Rewrite the native "Toggle fast mode" menu entry into a live switch.
  const capA = patched.match(FASTMENU_CAPTURE_RE);
  const fastMenuOk = !!(capA && FASTMENU_RE.test(patched));
  if (fastMenuOk) patched = patched.replace(FASTMENU_RE, buildFastMenuReplacement(capA[1], capA[2]));

  const footer = keepModelPillInline(patched);
  patched = footer.source;

  patched = WV_PREPEND + '\n' + COMPANION_SRC + '\n' + FAST_TOGGLE_SRC + '\n' + UI_COMPACT_SRC + '\n' + patched;

  fs.writeFileSync(wv, patched);
  if (dropOk) {
    console.log(`[ OK  wv ] replaced drop handler + prepended acquireVsCodeApi capture + Clawd companion + fast helper + compact-footer css`);
  } else {
    console.error(`[WARN wv] drop-handler anchor not found (attach patch SKIPPED, companion + fast helper still injected): ${wv}`);
  }
  if (!captureOk) {
    console.error(`[WARN wv] session-capture anchor not found (fast toggle inert — getConnection head changed): ${wv}`);
  }
  if (fastMenuOk) {
    console.log(`[ OK  wv ] rewrote "fast" menu entry into live ON/OFF toggle (React=${capA[1]} switch=${capA[2]})`);
  } else {
    console.error(`[WARN wv] fast-menu anchor not found (menu entry left as official open-terminal action): ${wv}`);
  }
  if (footer.ok) {
    console.log('[ OK  wv ] kept model selector inline at every fit stage');
  } else {
    console.error(`[WARN wv] model-footer render gates not found together (official row fallback retained): ${wv}`);
  }
  return { ok: dropOk && footer.ok, changed: true };
}

// When launchd / Windows Task Scheduler runs us with `--self-update`, pull the
// latest patcher from the team repo BEFORE patching. This is what makes the
// patch maintainable across a whole team: when the official extension updates
// and breaks an anchor, the maintainer fixes patch.mjs and pushes once, and
// every teammate's machine picks up the fix on its next 10-minute run — no
// manual `git pull` needed.
//
// We only pull when the working tree is clean. That protects the maintainer,
// who edits patch.mjs locally: a dirty tree means "someone is iterating here",
// so we leave it alone. Teammates never edit, so their tree is always clean.
function selfUpdate() {
  try {
    const dirty = execSync('git status --porcelain', { cwd: HERE, encoding: 'utf8' }).trim();
    if (dirty) {
      console.log('[self-update] working tree has local changes, skipping git pull');
      return;
    }
    const out = execSync('git pull --ff-only', { cwd: HERE, encoding: 'utf8' }).trim();
    console.log(`[self-update] ${out.replace(/\n+/g, ' ')}`);
  } catch (e) {
    // Offline, credentials not cached, or not a git checkout: self-update is
    // best-effort. We log why and fall through to patch with the local version
    // so the patch never goes missing just because the update step failed.
    console.log(`[self-update] skipped: ${String(e.message).split('\n')[0]}`);
  }
}

function main() {
  if (process.argv.includes('--self-update')) selfUpdate();
  const dirs = findExtensionDirs();
  if (dirs.length === 0) {
    console.error('No anthropic.claude-code-* extension found');
    process.exit(1);
  }
  // Validate all targets before the first write.
  for (const d of dirs) {
    const version = JSON.parse(fs.readFileSync(path.join(d.dir, 'package.json'), 'utf8')).version;
    if (version !== '2.1.286') throw new Error(`Unsupported Claude Code version: ${version}`);
    if (fs.readFileSync(d.wv, 'utf8').includes('/* CURSOR CLAUDE COMPACT v1 */'))
      throw new Error('Restore the standalone compact patch before applying the full patch.');
  }
  let anyChange = false, anyFail = false;
  for (const d of dirs) {
    console.log(`\n=== ${d.host} / ${path.basename(d.dir)} ===`);
    const a = patchExtensionJs(d);
    const b = patchWebviewJs(d);
    if (!a.ok || !b.ok) anyFail = true;
    if (a.changed || b.changed) anyChange = true;
  }
  if (anyFail) process.exit(2);
  if (anyChange) {
    console.log('\n→ Reload Cursor/VS Code: Cmd+Shift+P → Developer: Reload Window');
  }
}

export { keepModelPillInline, patchExtensionJs, patchWebviewJs };
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
