# Cursor環境一式

2026-10-02時点のインストール済み環境を基に、自作拡張6本とパッチをまとめています。
個人設定、認証情報、会話・タスクデータ、拡張本体のバックアップは含めません。

## 自作拡張

| フォルダ（extensions/配下） | バージョン | 用途 |
|---|---|---|
| file-colorizer | 0.8.0 | ファイル・フォルダーの色分け |
| claude-chat | 0.1.0 | Claude CLIのチャットパネル |
| notion-task-board | 0.7.6 | Notionタスク表示 |
| screen-agent-cursor | 0.8.1 | Claude CLIを利用するチャットUI |
| claude-sessions-sidebar | 0.3.1 | Claudeのセッション一覧 |
| claude-usage-bar | 0.4.0 | Claude / Codexの利用状況表示 |

Notion Task Boardは開発フォルダの新版ではなく、インストール済み0.7.6を収録しています。
社内DB・個人ユーザーIDの初期値を空欄にしたので、各自で設定してください。
Claudeを使う拡張には各自のCLI・ログインが必要です。Claude UsageのClaude側はmacOS Keychainに依存します。

### インストール

Node.jsとnpmが必要です。使う拡張のフォルダでVSIXを作成します。

```sh
cd extensions/file-colorizer
npx --yes @vscode/vsce@3.7.1 package --no-dependencies --skip-license
```

生成したVSIXをCursorのコマンドパレット「Extensions: Install from VSIX...」から選択します。
6本とも同じ方法です。ライセンスファイルのある拡張は同梱しています。
Screen AgentのMarkdown描画ライブラリはwebviewに同梱しているため、実行時のnpm installは不要です。

## パッチ

| フォルダ | 内容 | 対応拡張 |
|---|---|---|
| codex-composer-align | Codex入力欄の位置・高さ | 26.5908.31748 |
| codex-multi-panel | Codexの独立タブ・ヘッダー | 26.5908.31748 |
| claude-composer-compact | Claude入力欄整理のみ | 2.1.286 |
| claude-code-full | マスコット・添付・入力欄整理 | 2.1.286 |

Claude用2種類はどちらか片方を選んでください。手順・復元方法は各フォルダのREADMEにあります。

## 公開・市販拡張

`inventory/installed-extensions.json` に36件のインストールID・バージョンを記録しています。
うち自作6件以外の30件は `inventory/marketplace-extensions.txt` にIDをまとめています。
他社拡張はこのリポジトリに本体を再配布せず、Cursorの拡張画面で各IDを検索して導入します。
記録された旧バージョンの入手可否や、新バージョンとの互換性は保証しません。これは推奨一覧ではなく当時の構成記録です。

Cursor本体のsettings.json・キーバインド・MCP設定は含めていません。
インストールされていなかった開発途中の拡張も対象外です。
