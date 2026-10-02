# Claude Chat — Cursor / VS Code 拡張

`claude` CLI を裏で走らせるだけの最小チャットパネル。**PDF・画像・テキスト・任意ファイルを drag & drop で添付**して聞ける。

## できること

- Cursor / VS Code のサイドパネルでチャット
- Composer 全体が drop zone → Finder からファイルをポイ投げで添付
- 画像・動画・PDF・CSV・JSON・docx・なんでも対応（Claude の Read ツールが読めるもの）
- 複数同時添付 OK（画像 + PDF の混在も）
- 添付のみ（テキストなし）の送信 OK
- 添付チップは × で個別削除

## できないこと（スコープ外）

- 複数タブ・モデル切替・effort切替 UI（→ `screen-agent-cursor` 使ってください）
- スクショ・全画面録画・floating mascot（→ Screen Agent 本体）

## 起動

| 操作 | キーバインド |
|---|---|
| Claude Chat を開く | `⌘⇧C` |

または **コマンドパレット → "Claude Chat: Open"**。

エディタ右側にパネルが開きます。

## インストール

開発時はシンボリックリンクが楽:

```bash
ln -sf "$PWD" ~/.cursor/extensions/claude-chat
# または VS Code 本体: ~/.vscode/extensions/claude-chat
```

Cursor / VS Code を再起動して反映。

## 動作要件

- `claude` CLI が `$HOME/.local/bin/claude` または `$CLAUDE_BIN` にインストール済み
- Claude Code に `claude /login` でログイン済み

## 仕組み

添付ファイルは絶対パスをプロンプトに埋め込んで Claude に渡し、Claude が Read ツールで読み込む方式。複雑な multipart 送信ナシ。これだけで PDF も画像も CSV も全部 OK。

Webview から file path を取るのに `text/uri-list` を使ってます（VS Code webview には Electron の `webUtils.getPathForFile` が無いため）。Finder からのドラッグはこの方式で安定して動きます。


## このリポジトリからの導入

ルートREADMEのVSIX作成手順を使用してください。上記の旧開発用手順よりこちらを優先します。
