import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-roundtrip-'));
// Copy the patcher as well, so test logs never reach the checkout.
const tool = path.join(temporary, 'tool');
fs.mkdirSync(tool);
for (const file of ['patch.mjs', 'transform.mjs', 'ui-compact.css', 'ui-compact.js'])
  fs.copyFileSync(path.join(here, file), path.join(tool, file));
const extension = path.join(temporary, 'extension');
fs.mkdirSync(path.join(extension, 'webview'), { recursive:true });
fs.mkdirSync(path.join(extension, 'resources'));
fs.writeFileSync(path.join(extension, 'resources/claude-logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
const manifest = path.join(extension, 'package.json');
fs.writeFileSync(manifest, JSON.stringify({publisher:'anthropic',name:'claude-code',version:'2.1.286'}));
const target = path.join(extension, 'webview/index.js');
const original = 'function footer(){return [s!==2&&jsx(C,{...p}),s===2&&jsx("div",{className:S.modelPillRow,children:jsx(C,{...p,ownRow:!0})})]}';
fs.writeFileSync(target, original);
function run(mode, success=true) {
  const result = spawnSync(process.execPath, [path.join(tool, 'patch.mjs'), mode, extension], {encoding:'utf8'});
  assert.equal(result.status, success ? 0 : 1, result.stderr);
}
try {
  run('check'); assert.equal(fs.readFileSync(target,'utf8'),original);
  run('apply'); const applied=fs.readFileSync(target,'utf8'); assert.notEqual(applied,original);
  run('apply'); assert.equal(fs.readFileSync(target,'utf8'),applied);
  fs.appendFileSync(target,'\n// unrelated modification');
  const modified=fs.readFileSync(target,'utf8');
  run('restore',false); assert.equal(fs.readFileSync(target,'utf8'),modified);
  fs.writeFileSync(target,applied);
  run('restore'); assert.equal(fs.readFileSync(target,'utf8'),original);
  run('restore');
  fs.writeFileSync(target,'window.__ccUiCompactInstalled = true;');
  run('apply',false);
  fs.writeFileSync(target,'// incompatible layout'); run('apply',false);
  assert.equal(fs.readFileSync(target,'utf8'),'// incompatible layout');
  fs.writeFileSync(manifest,JSON.stringify({publisher:'anthropic',name:'claude-code',version:'0.0.0'}));
  run('apply',false);
  console.log('PASS: check, apply idempotency, exact restore, conflict/duplicate/layout/version refusal');
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }
