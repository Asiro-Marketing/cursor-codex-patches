#!/usr/bin/env bash
# Uninstall: stop the launchd job and restore the original extension files.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.local.claude-code-patch.plist"

echo "[uninstall] removing launchd job"
launchctl bootout "gui/$(id -u)/com.local.claude-code-patch" 2>/dev/null || true
rm -f "$PLIST"

echo "[uninstall] restoring original Claude Code extension files"
shopt -s nullglob
for ext_dir in "$HOME"/.cursor/extensions/anthropic.claude-code-* \
               "$HOME"/.vscode/extensions/anthropic.claude-code-* \
               "$HOME"/.vscode-insiders/extensions/anthropic.claude-code-*; do
  for f in "$ext_dir/extension.js" "$ext_dir/webview/index.js"; do
    bak="$f.bak.original"
    if [ -f "$bak" ]; then
      cp "$bak" "$f"
      echo "  restored: $f"
    fi
  done
done

echo ""
echo "✅ Uninstalled. Reload Cursor/VS Code to pick up the original extension."
