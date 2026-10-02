#!/usr/bin/env bash
# Install the Claude Code attach patch:
#   1. Detect node binary (Homebrew or system)
#   2. Render plist from template
#   3. Bootstrap launchd job (10-minute interval, idempotent re-apply)
#   4. Run patcher once now
set -euo pipefail

REPO_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  if [ -x /opt/homebrew/bin/node ]; then NODE_BIN=/opt/homebrew/bin/node
  elif [ -x /usr/local/bin/node ]; then NODE_BIN=/usr/local/bin/node
  elif command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"
  else
    echo "ERROR: node not found. Install Node.js (brew install node) and re-run." >&2
    exit 1
  fi
fi

echo "[install] repo dir : $REPO_DIR"
echo "[install] node bin : $NODE_BIN"

PLIST_DEST="$HOME/Library/LaunchAgents/com.local.claude-code-patch.plist"
TEMPLATE="$REPO_DIR/com.local.claude-code-patch.plist.template"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__REPO_DIR__#$REPO_DIR#g" "$TEMPLATE" > "$PLIST_DEST"
echo "[install] plist written -> $PLIST_DEST"

# Unload any previous registration before bootstrapping the new plist.
launchctl bootout "gui/$(id -u)/com.local.claude-code-patch" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
echo "[install] launchd job bootstrapped"

# Run once now so the patch is applied immediately.
"$NODE_BIN" "$REPO_DIR/patch.mjs"

echo ""
echo "✅ Done. Reload Cursor/VS Code: Cmd+Shift+P → Developer: Reload Window"
echo "   Logs: $REPO_DIR/patch.{log,err}"
