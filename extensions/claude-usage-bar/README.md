# Claude Usage

Show your Claude and Codex usage together in the VS Code / Cursor sidebar.

![VS Code](https://img.shields.io/badge/VS%20Code-1.74%2B-blue) ![Version](https://img.shields.io/badge/version-0.4.0-blue)

## Features

- **Live usage** — Reads your Claude usage from the OAuth usage endpoint and renders it in a sidebar webview
- **Codex usage** — Reads the signed-in Codex CLI's official `account/rateLimits/read` response. The real window length determines the label; a weekly-only quota appears as `Weekly 7d`.
- **Always blue** — Codex's heading, labels, percentages and bars stay blue at every usage level, matching the menu bar app.
- **No config** — Pulls the access token straight from the macOS Keychain (`Claude Code-credentials`); no API key to paste
- **Auto-refresh** — Polls on an interval (default 120s, min 60s) and caches results to stay light
- **Independent updates** — Claude and Codex refresh independently. Errors keep the previous value and its actual update time, with an error note and retry backoff.
- **Design-matched** — Webview UI built on VS Code theme variables to sit cleanly next to `claude-sessions-sidebar`

## Install

1. Build the `.vsix`: `npx @vscode/vsce package` (a prebuilt one ships in this folder)
2. In VS Code / Cursor: `Cmd+Shift+P` → **Extensions: Install from VSIX...** → select the `.vsix`
3. The **Claude Usage** view appears in the Explorer sidebar
4. After updating an already running extension, run **Developer: Reload Window** from the command palette if the new Codex section is not yet visible.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeUsageBar.refreshIntervalSeconds` | `120` | Auto-refresh interval in seconds (min 60) |
| `claudeUsageBar.codexExecutablePath` | empty | Absolute Codex CLI path; empty detects standard macOS installations |

## Requirements

- macOS (token is read from the Keychain via `security`)
- VS Code 1.74+ or Cursor
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (Max plan)
- Codex CLI installed and signed in to ChatGPT for Codex usage. Authentication remains with Codex; this extension does not read its credentials or start model turns.

## Validation

`npm test` covers quota mapping, blue colors across usage levels, independent provider errors, cache/backoff, stdio communication, cancellation and timeout cleanup. Test fixtures and preview artifacts are excluded from the VSIX.

Codex protocol: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt

## License

MIT
