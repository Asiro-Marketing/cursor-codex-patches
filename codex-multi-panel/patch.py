#!/usr/bin/env python3
"""Add independent Codex tabs and Claude-style header icons in Cursor."""

import argparse
import hashlib
import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
EXTENSIONS = Path.home() / '.cursor/extensions'
VERSION = '26.5908.31748'
CHANGES = [
    ('async createNewPanel(){let e=pI("/extension/panel/new"),',
     'async createNewPanel(){let e=pI("/extension/panel/new").with({query:"codexPanel="+require("node:crypto").randomUUID()}),'),
    ('initialRoute:i==null||o.path.startsWith("/local/")?o.path:`/local/${i}`',
     'initialRoute:i==null&&o.path.startsWith("/extension/panel/new?codexPanel=")?"/extension/panel/new":i==null||o.path.startsWith("/local/")?o.path:`/local/${i}`'),
]
MENU_ENTRY = {
    'command': 'chatgpt.newCodexPanel',
    'group': 'navigation@1',
    'when': 'resourceScheme == openai-codex',
}
HEADER_PATH = 'webview/assets/header-8aa6e5b9570e.js'


def header_icon(runtime, path):
    return (
        f'(0,{runtime}.jsxs)(`svg`,{{width:20,height:20,viewBox:`0 0 20 20`,'
        'fill:`none`,stroke:`currentColor`,strokeWidth:1.1,strokeLinecap:`round`,'
        'strokeLinejoin:`round`,"aria-hidden":!0,focusable:`false`,'
        f'children:[(0,{runtime}.jsx)(`circle`,{{cx:10,cy:10,r:7}}),'
        f'(0,{runtime}.jsx)(`path`,{{d:`{path}`}})]}})'
    )


HEADER_CHANGES = [
    ('(0,Dt.jsx)(Xe,{"aria-hidden":!1,asset:d})',
     header_icon('Dt', 'M10 6.5v7M6.5 10h7')),
    ('(0,Q.jsx)(Xe,{className:`hover:opacity-80`,"aria-hidden":!1,asset:xt})',
     header_icon('Q', 'M10 5.8V10l3 1.8')),
    ('children:[O,null,k,A]', 'children:[k,null,O,A]'),
]


def locate_extension():
    registry = json.loads((EXTENSIONS / 'extensions.json').read_text())
    matches = [x for x in registry if x.get('identifier', {}).get('id') == 'openai.chatgpt']
    if len(matches) != 1 or matches[0].get('version') != VERSION:
        raise RuntimeError('Registered Codex version changed; inspect before applying.')
    path = (EXTENSIONS / matches[0]['relativeLocation']).resolve()
    if path.parent != EXTENSIONS.resolve():
        raise RuntimeError('Unexpected extension location.')
    return path


def transform_js(text, restore, replacements=CHANGES):
    for original, patched in replacements:
        before, after = (patched, original) if restore else (original, patched)
        if text.count(before) == 1 and text.count(after) == 0:
            text = text.replace(before, after, 1)
        elif text.count(after) == 1 and text.count(before) == 0:
            continue
        else:
            raise RuntimeError('Unexpected JavaScript layout; refusing partial patch.')
    return text


def prepare(extension, restore):
    js_path, manifest_path = extension / 'out/extension.js', extension / 'package.json'
    original_js, original_manifest = js_path.read_bytes(), manifest_path.read_bytes()
    patched_js = transform_js(original_js.decode(), restore).encode()
    manifest = json.loads(original_manifest)
    commands = manifest['contributes']['commands']
    if not any(x['command'] == MENU_ENTRY['command'] for x in commands):
        raise RuntimeError('New Codex Agent command is missing.')
    menu = manifest['contributes']['menus']['editor/title']
    changed = False
    # The webview header already invokes newCodexPanel. Remove the earlier
    # native toolbar shortcut so there is only one visible new-chat button.
    if MENU_ENTRY in menu:
        menu.remove(MENU_ENTRY)
        changed = True
    patched_manifest = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode() if changed else original_manifest
    header_path = extension / HEADER_PATH
    original_header = header_path.read_bytes()
    patched_header = transform_js(original_header.decode(), restore, HEADER_CHANGES).encode()
    return [(js_path, original_js, patched_js), (manifest_path, original_manifest, patched_manifest),
            (header_path, original_header, patched_header)]


def validate_javascript(content, suffix='.cjs'):
    with tempfile.TemporaryDirectory(prefix='codex-multi-panel-') as directory:
        path = Path(directory) / ('check' + suffix)
        path.write_bytes(content)
        subprocess.run(['node', '--check', str(path)], check=True, capture_output=True)


def apply_changes(changes, mode):
    modified = [(path, before, after) for path, before, after in changes if before != after]
    if not modified:
        print('No change needed.')
        return
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    log_dir = BASE / 'logs' / stamp
    log_dir.mkdir(parents=True, exist_ok=False)
    records = []
    for path, before, after in modified:
        (log_dir / (path.name + '.before')).write_bytes(before)
        (log_dir / (path.name + '.after')).write_bytes(after)
        records.append({'path': str(path), 'before': hashlib.sha256(before).hexdigest(),
                        'after': hashlib.sha256(after).hexdigest()})
    (log_dir / 'manifest.json').write_text(json.dumps({'mode': mode, 'files': records}, indent=2) + '\n')
    if any(path.read_bytes() != before for path, before, _ in modified):
        raise RuntimeError('Extension changed during preparation; no files written.')
    written = []
    try:
        for path, before, after in modified:
            written.append((path, before))
            path.write_bytes(after)
            if path.read_bytes() != after:
                raise RuntimeError(f'Write verification failed: {path}')
    except Exception:
        for path, before in reversed(written):
            path.write_bytes(before)
        raise
    print(f'{mode}: {len(modified)} files\nBackup: {log_dir}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['check', 'apply', 'restore'])
    args = parser.parse_args()
    extension = locate_extension()
    changes = prepare(extension, args.mode == 'restore')
    validate_javascript(changes[0][2])
    validate_javascript(changes[2][2], '.mjs')
    if args.mode == 'check':
        for path, before, after in changes:
            print(f'{path.name}: {"already applied" if before == after else "ready to patch"}')
        print('JavaScript syntax: OK')
    else:
        apply_changes(changes, args.mode)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'Patch did not complete: {error}')
