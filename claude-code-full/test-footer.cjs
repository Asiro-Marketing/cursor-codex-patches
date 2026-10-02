#!/usr/bin/env node
// Runs the INSTALLED official React footer, CSS, ResizeObserver and fit logic
// with synthetic session data. No Cursor UI, credentials or network are used.
// Usage: node test-footer.cjs [extension-directory ...]
// Playwright is resolved from ../node_modules (the workspace scripts package).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const modelSelector = '[class*="modelPill_"]:not([class*="agentsPill"])';
const project = __dirname;

function exposeFooter(source) {
  const stage = source.indexOf('"data-fit-stage":');
  assert(stage > 0, 'Official fit-stage attribute must exist');
  const functionStart = source.lastIndexOf('function ', stage);
  const footer = source.slice(functionStart).match(/^function ([\w$]+)\(\{session:/)?.[1];
  const renderer = [...source.matchAll(/([\w$]+)\.createRoot\(document\.querySelector\("#root"\)\)\.render\(([\w$]+)\(/g)].at(-1);
  assert(footer && renderer, 'Discover the official footer and React runtime');
  const bootstrap = /try\{([\w$]+)\(\)\}catch\(([\w$]+)\)\{([\w$]+)\(\2 instanceof Error\?\2:Error\(String\(\2\)\)\)\}\s*$/;
  assert(bootstrap.test(source), 'Disable the host-connected application bootstrap');
  return source.replace(bootstrap, () =>
    `window.__footerTest={createRoot:${renderer[1]}.createRoot,jsx:${renderer[2]},Footer:${footer}};`);
}

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function assertPatchAnchors(keepInline) {
  // Dollar signs in identifiers and replacement values must remain literal.
  const inline = '$!==2&&F$(C$,{...P$})';
  const row = '$===2&&F$("div",{className:S$.modelPillRow,children:F$(C$,{...P$,ownRow:!0})})';
  assert.deepEqual(keepInline(`${inline},${row}`), {source:'F$(C$,{...P$}),!1',ok:true});
  for (const source of [inline, row, `${inline},${row},${row}`, `${inline},${inline},${row}`]) {
    assert.deepEqual(keepInline(source), {source,ok:false}, 'Fail closed on missing/ambiguous gates');
  }
}

async function mountFooter(page, scenario) {
  await page.evaluate(scenario => {
    const test = window.__footerTest;
    const noop = () => {};
    const values = {
      busy:!!scenario.busy, usageData:{totalTokens:700000,contextWindow:1000000,maxOutputTokens:32000},
      remoteControlState:scenario.rich ? {status:'connected',sessionUrl:'https://example.invalid'} : {status:'disconnected'},
      config:{}, claudeConfig:{models:[{value:'test-model',displayName:'Opus 5 (1M)',supportsEffort:true,supportedEffortLevels:['low','medium','high']}]},
      modelSelection:'test-model',lastServedModel:'test-model',effortLevel:'high',
      ultracodeAvailable:false,ultracodeEnabled:false,
      agentMapAgents:scenario.rich ? new Map([['test',{taskId:'test',status:scenario.waiting?'working':'finished'}]]) : new Map(),
      permissionRequests:scenario.waiting ? [{agentId:'test'}] : [],
      promptCacheRecord:scenario.rich ? {anchorAt:Date.now(),ttl:'5m'} : undefined,
    };
    const session = new Proxy({}, {get:(_,key) => key==='interrupt' ? ()=>test.clicks.stop++ : key.startsWith('set') || key==='logEvent' ? noop : {value:values[key]}});
    test.clicks = {model:0,agents:0,stop:0,send:0};
    document.querySelector('#root').addEventListener('submit',event=>{event.preventDefault();test.clicks.send++;});
    test.props = {session,mode:'default',availablePermissionModes:['default','plan','acceptEdits'],canSendMessage:!scenario.busy,
      toggleCommandMenu:noop,onRemoveSelection:noop,onCompact:noop,onOpenAgentMap:()=>test.clicks.agents++,
      onAttachFile:noop,onInsertAtMention:noop,browserIntegrationSupported:false,
      modelSelector:{isOpen:false,onToggle:()=>test.clicks.model++,onClose:noop,onModelSelected:noop,
        commandRegistry:{getCommand:()=>undefined,subscribe:()=>noop}}};
    if(scenario.selection) test.props.currentSelection={filePath:'/workspace/very-long-selected-file-name-that-collides-with-the-send-button.ts'};
    test.values=values;
    test.root=test.createRoot(document.querySelector('#root'));
    test.render=()=>test.root.render(test.jsx(test.Footer,test.props));
    test.render();
  }, scenario);
  await page.locator(modelSelector).waitFor();
}

async function measurements(page) {
  // Wait for React layout effects plus ResizeObserver and tooltip RAF to settle.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(selector => {
    const footer=document.querySelector('[data-fit-stage]');
    const model=document.querySelector(selector);
    const agents=document.querySelector('[class*="agentsPill"]');
    const rect=model.getBoundingClientRect();
    const footerRect=footer.getBoundingClientRect();
    const send=footer.querySelector('[class*="sendButton_"]');
    const sendRect=send.getBoundingClientRect();
    const rectData=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
    return {
      width:innerWidth,stage:Number(footer.dataset.fitStage),modelWidth:rect.width,
      inline:footer.contains(model),ownRows:document.querySelectorAll('[class*="modelPillRow_"]').length,
      centered:Math.abs(rect.y+rect.height/2-(footerRect.y+footerRect.height/2))<1,
      hasLogo:getComputedStyle(model,'::before').maskImage.startsWith('url('),
      title:model.title,ariaLabel:model.getAttribute('aria-label'),
      send:{box:rectData(send),hit:send.contains(document.elementFromPoint(sendRect.x+sendRect.width/2,sendRect.y+sendRect.height/2)),inside:sendRect.right<=innerWidth},
      agents:agents&&{box:rectData(agents),hasLogo:getComputedStyle(agents,'::before').maskImage!=='none',
        overflow:agents.scrollWidth-agents.clientWidth,title:agents.title,
        icon:rectData(agents.querySelector('svg')),dot:rectData(agents.querySelector('[data-status-dot]'))},
    };
  }, modelSelector);
}

function assertLayout(result, scenario) {
  assert.equal(result.inline,true,'Model must remain in the footer');
  assert.equal(result.ownRows,0,'No separate model row at any stage');
  assert.equal(result.centered,true,'Model must align with the icon row');
  assert.equal(result.hasLogo,result.stage>0,'Logo only at compact stages');
  if(result.stage>0) assert.equal(result.modelWidth,26);
  else assert(result.modelWidth>26,'Wide state must display model text');
  assert.equal(result.title,'Opus 5 (1M) High · Switch model');
  assert.equal(result.ariaLabel,result.title,'Icon mode retains accessible model name');
  assert.equal(result.send.box.width,26,'Send/stop keeps its full hit area');
  assert.equal(result.send.hit,true,'Send/stop is in front and clickable');
  assert.equal(result.send.inside,true,'Send/stop stays inside the viewport');
  if(!scenario.rich) return;
  const agents=result.agents;
  assert(agents,'Agent map must be rendered');
  if(result.stage===2) {
    assert.equal(agents.box.width,0,'Secondary actions collapse behind the ellipsis');
    return;
  }
  assert.equal(agents.box.width,26);
  assert.equal(agents.box.height,26);
  assert.equal(agents.icon.width,16);
  assert.equal(agents.hasLogo,false,'Agent map keeps its own icon');
  assert(agents.overflow<=1,'State dot must not trigger the clipping detector');
  assert(agents.title.includes('agent map')&&!agents.title.includes('Switch model'));
  assert(agents.dot.x>=agents.box.x&&agents.dot.x+agents.dot.width<=agents.box.x+26);
  assert(agents.dot.y>=agents.box.y&&agents.dot.y+agents.dot.height<=agents.box.y+26);
}

async function checkScenario(browser, bundle, css, compact, scenario, output) {
  const page=await browser.newPage({viewport:{width:720,height:160}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.abort());
  try {
    await page.setContent('<form id="root"></form>');
    await page.addStyleTag({content:css});
    await page.addStyleTag({content:'body{margin:0;font:13px Arial;background:#181818;color:#ddd}#root{display:block;width:100%}'});
    await page.addScriptTag({content:compact});
    await page.addScriptTag({content:exposeFooter(bundle)});
    await mountFooter(page,scenario);
    const results=[];
    for(const width of [720,400,360,320,280,240,200,160,400,720]) {
      await page.setViewportSize({width,height:160});
      const result=await measurements(page);
      assertLayout(result,scenario);
      results.push(result);
    }
    assert.equal(results[0].stage,0,'Wide footer starts in text mode');
    assert.equal(results.at(-1).stage,0,'Widening restores text mode');
    if(!scenario.selection) assert(results.some(result=>result.stage===1),'Exercise stage 1');
    if(scenario.rich) assert(results.some(result=>result.stage===2),'Exercise stage 2');
    await page.setViewportSize({width:320,height:160});
    await measurements(page);
    await page.locator(modelSelector).focus();
    await page.setViewportSize({width:200,height:160});
    await measurements(page);
    assert(await page.locator(modelSelector).evaluate(element=>document.activeElement===element),'Resize preserves focus');
    await page.locator(modelSelector).press('Enter');
    assert.equal(await page.evaluate(()=>window.__footerTest.clicks.model),1);
    const more=page.locator('.cc-footer-more');
    if(await more.isVisible()) {
      await page.screenshot({path:path.join(output,`${scenario.name}-200-collapsed.png`)});
      await more.click();
      assert.equal(await more.getAttribute('aria-expanded'),'true');
      await page.screenshot({path:path.join(output,`${scenario.name}-200-expanded.png`)});
    }
    if(scenario.rich) {
      await page.locator('[class*="agentsPill"]').click();
      assert.equal(await page.evaluate(()=>window.__footerTest.clicks.agents),1);
    }
    await page.locator('[class*="sendButton_"]').click();
    assert.equal(await page.evaluate(busy=>window.__footerTest.clicks[busy?'stop':'send'],!!scenario.busy),1);
    if(await more.isVisible()) {
      await more.press('Escape');
      assert.equal(await more.getAttribute('aria-expanded'),'false');
    }
    if(scenario.selection) {
      await page.setViewportSize({width:320,height:160});
      await measurements(page);
      if(await more.isVisible()) await more.click();
      const label=page.locator('[class*="selectionChip_"] [class*="footerButtonStatic_"] > span');
      assert(await label.evaluate(element=>getComputedStyle(element).textOverflow==='ellipsis'&&element.scrollWidth>element.clientWidth),'Long filenames visibly truncate with ellipsis');
      await page.locator('[class*="sendButton_"]').click();
      if(await more.isVisible()) await more.press('Escape');
    }
    await page.evaluate(()=>{
      const test=window.__footerTest;
      test.values.claudeConfig.models[0].displayName='Sonnet test';
      test.values.effortLevel='low';
      test.render();
    });
    await page.waitForFunction(selector=>document.querySelector(selector).title==='Sonnet test Low · Switch model',modelSelector);
    await page.setViewportSize({width:320,height:160});
    await measurements(page);
    await page.screenshot({path:path.join(output,`${scenario.name}-320.png`)});
    assert.deepEqual(errors,[],'No browser errors');
    return results;
  } finally {await page.close();}
}

async function main() {
  const patcher=await import('./patch.mjs');
  assertPatchAnchors(patcher.keepModelPillInline);
  const extensionRoot=path.join(os.homedir(),'.cursor/extensions');
  const directories=process.argv.slice(2);
  if(!directories.length) directories.push(...fs.readdirSync(extensionRoot).filter(name=>name.startsWith('anthropic.claude-code-')).map(name=>path.join(extensionRoot,name)));
  assert(directories.length>0,'An installed Claude Code extension is required');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'claude-footer-test-'));
  const browser=await chromium.launch({headless:true});
  const report={output,versions:[]};
  try {
    for(const directory of directories) {
      const version=JSON.parse(fs.readFileSync(path.join(directory,'package.json'))).version;
      const fixture=path.join(output,version);
      fs.mkdirSync(fixture,{recursive:true});
      const wv=path.join(fixture,'index.js');
      const ext=path.join(fixture,'extension.js');
      const original=fs.readFileSync(path.join(directory,'webview/index.js.bak.original'),'utf8');
      fs.writeFileSync(wv,original);
      fs.copyFileSync(path.join(directory,'extension.js.bak.original'),ext);
      assert(patcher.patchExtensionJs({ext}).ok);
      assert(patcher.patchWebviewJs({wv}).ok);
      checkSyntax(ext);checkSyntax(wv);
      assert.equal((fs.readFileSync(ext,'utf8').match(/__claudePatchHandle&&/g)||[]).length,3);
      assert.equal(patcher.patchExtensionJs({ext}).changed,false);
      assert.equal(patcher.patchWebviewJs({wv}).changed,false);
      const patched=fs.readFileSync(wv,'utf8');
      const bodyStart=patched.indexOf(original.slice(0,200));
      assert(bodyStart>=0,'Locate official bundle after helpers');
      const compactCss=JSON.parse(patched.match(/var CSS = ("[^\n]+");/)[1]);
      const compact=fs.readFileSync(path.join(project,'ui-compact.js'),'utf8').split('__CC_UI_COMPACT_CSS__').join(JSON.stringify(compactCss));
      const css=fs.readFileSync(path.join(directory,'webview/index.css'),'utf8');
      const cases=[];
      for(const scenario of [{name:'basic',rich:false},{name:'agents-idle',rich:true},{name:'agents-waiting',rich:true,waiting:true},{name:'long-filename',rich:true,selection:true},{name:'stop',rich:true,busy:true}]) {
        const results=await checkScenario(browser,patched.slice(bodyStart),css,compact,scenario,fixture);
        cases.push({scenario:scenario.name,results});
      }
      report.versions.push({version,cases});
      console.log(`PASS ${version}: 5 scenarios × 10 widths, send/stop, overflow disclosure, focus/clicks/tooltips, syntax, 3 attachment handlers, idempotency`);
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(`Evidence: ${output}`);
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
