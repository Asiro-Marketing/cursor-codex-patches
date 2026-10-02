# Screen Agent 0.8.1

Claude Code CLIを利用するCursor内のチャットUIです。インストール済みの0.8.1を収録しています。
モデル・effortの選択、会話履歴、エディタのファイル・選択範囲の参照を備えます。

## 導入

Node.jsがある環境で、このフォルダから実行します。

```sh
npx --yes @vscode/vsce@3.7.1 package --no-dependencies --skip-license
```

生成したVSIXをCursorの「Extensions: Install from VSIX...」からインストールします。
Claude Code CLIのインストールとログインが必要です。実行ファイルは `CLAUDE_BIN` 環境変数で指定できます。
Markdown描画用のmarkedはwebviewへ同梱しています。ライセンスは `webview/marked.LICENSE.md` を参照してください。

利用者の認証・会話履歴・設定は含めていません。
