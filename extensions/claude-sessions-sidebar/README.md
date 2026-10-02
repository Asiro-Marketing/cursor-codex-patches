# Claude Sessions

Arc-style live session lanes for Claude Code, in the VS Code / Cursor sidebar.

![VS Code](https://img.shields.io/badge/VS%20Code-1.74%2B-blue) ![Version](https://img.shields.io/badge/version-0.3.1-green)

## Features

- **Live lanes** — Active sessions split into **Needs input** / **Working** / **Recent**, so you see at a glance which sessions are waiting on you and which are still running
- **Prompt-aware** — A session blocked on a choice popup (`AskUserQuestion`) or plan approval (`ExitPlanMode`) is surfaced in **Needs input**, even though it's technically mid-tool-call
- **Auto state detection** — pid liveness + jsonl tail classify each session without any extra config
- **Quick resume** — Click a card to reopen it in a new tab, or use the **split** hover action to open it beside the current editor. Both resume the exact session via `claude-vscode.editor.open`
- **Delete history** — A **trash** hover action on Recent cards removes that session's history file (moved to the OS trash, so it's recoverable, after a confirm). Offered only on Recent — live sessions are still writing their jsonl
- **Auto-refresh** — `fs.watch` + polling keep the lanes live (default 2.5s)
- **Design-matched** — Webview UI built on VS Code theme variables to sit cleanly next to `claude-usage-bar`

## Install

1. Build the `.vsix`: `npx @vscode/vsce package` (a prebuilt one ships in this folder)
2. In VS Code / Cursor: `Cmd+Shift+P` → **Extensions: Install from VSIX...** → select the `.vsix`
3. The Claude icon appears in the Activity Bar

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeSessions.maxSessions` | `50` | Maximum sessions to display per project |
| `claudeSessions.showAllProjects` | `false` | Show sessions from all projects (live lanes only show when `false`) |
| `claudeSessions.pollingInterval` | `2500` | Polling interval (ms) for live status. Min 1000 |
| `claudeSessions.maxRecentSessions` | `15` | Number of recent (non-live) sessions in the Recent group |

## Requirements

- VS Code 1.74+ or Cursor
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and used at least once

## License

MIT
