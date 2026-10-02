#!/usr/bin/env node
// Compact-only adapter. Does not install the mascot, attachment or fast helpers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keepModelPillInline } from './transform.mjs';
export { keepModelPillInline } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '2.1.286';
const MARKER = '/* CURSOR CLAUDE COMPACT v1 */';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

export function buildPatch(source, extension) {
  if (source.includes('__ccUiCompactInstalled') || source.includes(MARKER)) {
    throw new Error('Compact UI is already installed. Do not stack this on the mascot patch.');
  }
  const result = keepModelPillInline(source);
  if (!result.ok) throw new Error('Unsupported footer layout; no files changed.');
  const logo = fs.readFileSync(path.join(extension, 'resources/claude-logo.svg')).toString('base64');
  const css = fs.readFileSync(path.join(HERE, 'ui-compact.css'), 'utf8')
    .split('__CC_CLAUDE_LOGO__').join(`data:image/svg+xml;base64,${logo}`);
  const helper = fs.readFileSync(path.join(HERE, 'ui-compact.js'), 'utf8')
    .split('__CC_UI_COMPACT_CSS__').join(JSON.stringify(css));
  return `${MARKER}\n${helper}\n${result.source}`;
}

function locate(explicit) {
  let extension;
  if (explicit) extension = path.resolve(explicit);
  else {
    const root = path.join(os.homedir(), '.cursor/extensions');
    const entries = JSON.parse(fs.readFileSync(path.join(root, 'extensions.json'), 'utf8'))
      .filter(entry => entry.identifier?.id === 'anthropic.claude-code');
    if (entries.length !== 1) throw new Error('Expected one registered Claude Code extension.');
    extension = fs.realpathSync(path.resolve(root, entries[0].relativeLocation));
    if (path.dirname(extension) !== fs.realpathSync(root)) throw new Error('Unexpected extension path.');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8'));
  if (manifest.publisher?.toLowerCase() !== 'anthropic' || manifest.name !== 'claude-code' || manifest.version !== VERSION)
    throw new Error(`Only anthropic.claude-code ${VERSION} is supported.`);
  return extension;
}

function syntax(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compact-check-'));
  try {
    const file = path.join(directory, 'check.js');
    fs.writeFileSync(file, source);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'JavaScript syntax check failed.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function writeChange(target, before, after, mode) {
  const log = path.join(HERE, 'logs', `${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(log, 'before.js'), before);
  fs.writeFileSync(path.join(log, 'after.js'), after);
  fs.writeFileSync(path.join(log, 'manifest.json'), JSON.stringify({target, mode, before:hash(before), after:hash(after)}, null, 2));
  if (hash(fs.readFileSync(target)) !== hash(before)) throw new Error('Extension changed during preparation.');
  try {
    fs.writeFileSync(target, after);
    if (hash(fs.readFileSync(target)) !== hash(after)) throw new Error('Write verification failed.');
  } catch (error) {
    fs.writeFileSync(target, before); // Restore the original if writing or verification fails.
    throw error;
  }
  console.log(`${mode}: ${target}\nBackup: ${log}`);
}

function main() {
  const [mode, explicit, ...extra] = process.argv.slice(2);
  if (!['check', 'apply', 'restore'].includes(mode) || extra.length)
    throw new Error('Usage: node patch.mjs check|apply|restore [extension-directory]');
  const extension = locate(explicit);
  const target = path.join(extension, 'webview/index.js');
  const before = fs.readFileSync(target);
  const source = before.toString('utf8');
  if (mode === 'restore') {
    if (!source.startsWith(MARKER)) { console.log('This standalone patch is not installed.'); return; }
    const root = path.join(HERE, 'logs');
    const matches = fs.readdirSync(root).flatMap(name => {
      const dir = path.join(root, name);
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      return record.mode === 'apply' && record.target === target && record.after === hash(before) ? [{dir,record}] : [];
    });
    if (!matches.length) throw new Error('No matching backup, or extension changed. Refusing to overwrite.');
    const {dir,record} = matches[0];
    const original = fs.readFileSync(path.join(dir, 'before.js'));
    if (hash(original) !== record.before) throw new Error('Backup checksum mismatch.');
    writeChange(target, before, original, mode);
    return;
  }
  if (source.startsWith(MARKER)) { syntax(source); console.log('Already applied; syntax OK.'); return; }
  if (source.includes('__ccUiCompactInstalled')) {
    if (mode === 'check') { console.log('Compact UI already present through another patch; standalone apply is blocked.'); return; }
    throw new Error('Compact UI already present through another patch; refusing duplicate installation.');
  }
  const after = Buffer.from(buildPatch(source, extension));
  syntax(after);
  if (mode === 'check') console.log(`Compatible: Claude Code ${VERSION}; footer anchors and syntax OK.`);
  else writeChange(target, before, after, mode);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
