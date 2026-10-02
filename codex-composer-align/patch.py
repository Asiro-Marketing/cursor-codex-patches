#!/usr/bin/env python3
"""Apply or remove a version-checked, CSS-only Cursor Codex adjustment."""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
EXTENSIONS = Path.home() / '.cursor/extensions'
VERSION = '26.5908.31748'
STYLESHEET = 'webview/assets/app-initial-ddb6c251267b.css'
START = '/* BEGIN LOCAL CODEX COMPOSER ALIGN */'
END = '/* END LOCAL CODEX COMPOSER ALIGN */'


def locate_extension():
    registry = json.loads((EXTENSIONS / 'extensions.json').read_text())
    matches = [item for item in registry
               if item.get('identifier', {}).get('id') == 'openai.chatgpt']
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one registered Codex extension.')
    entry = matches[0]
    if entry.get('version') != VERSION:
        raise RuntimeError('Extension version changed; inspect its layout before applying.')
    extension = (EXTENSIONS / entry['relativeLocation']).resolve()
    if extension.parent != EXTENSIONS.resolve():
        raise RuntimeError('Unexpected extension path.')
    return extension


def remove_block(text):
    if START not in text and END not in text:
        return text
    if text.count(START) != 1 or text.count(END) != 1:
        raise RuntimeError('Unexpected patch markers; refusing to modify the stylesheet.')
    start = text.index(START)
    end = text.index(END, start) + len(END)
    return text[:start] + text[end:]


def validate_layout(extension):
    html = (extension / 'webview/index.html').read_text()
    if './assets/app-initial-ddb6c251267b.css' not in html:
        raise RuntimeError('Expected stylesheet is not loaded by the webview.')
    source = (extension / 'webview/assets/app-initial-84c784f5e305.js').read_text()
    for marker in ['_ComposerFooter_q5yh8_1', '_ComposerLayoutRoot_1qpwu_2',
                   '"data-codex-composer-root"', 'className:Q(`flex w-full flex-col gap-2`']:
        if marker not in source:
            raise RuntimeError(f'Layout no longer matches: {marker}')


def write_change(target, before, after, mode):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    log_dir = BASE / 'logs' / stamp
    log_dir.mkdir(parents=True, exist_ok=False)
    (log_dir / 'before.css').write_bytes(before)
    (log_dir / 'after.css').write_bytes(after)
    manifest = {'mode': mode, 'target': str(target),
                'before_sha256': hashlib.sha256(before).hexdigest(),
                'after_sha256': hashlib.sha256(after).hexdigest()}
    (log_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if target.read_bytes() != before:
        raise RuntimeError('Stylesheet changed during preparation; no changes applied.')
    with target.open('r+b') as stream:
        stream.write(after)
        stream.truncate()
    if target.read_bytes() != after:
        raise RuntimeError(f'Write verification failed; backup: {log_dir}')
    print(f'{mode}: {target}\nBackup and change record: {log_dir}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['check', 'apply', 'restore'])
    args = parser.parse_args()
    extension = locate_extension()
    validate_layout(extension)
    target = extension / STYLESHEET
    before = target.read_bytes()
    text = before.decode('utf-8')
    clean = remove_block(text)
    patch = START + '\n' + (BASE / 'align.css').read_text() + END
    desired = clean if args.mode == 'restore' else clean + patch
    if args.mode == 'check':
        print(f'Compatible extension: {extension.name}')
        print(f'Status: {"applied" if START in text else "not applied"}')
        print(f'Target: {target}')
        print(patch)
    elif desired.encode('utf-8') == before:
        print('No change needed.')
    else:
        write_change(target, before, desired.encode('utf-8'), args.mode)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        raise SystemExit(f'No successful application: {error}')
