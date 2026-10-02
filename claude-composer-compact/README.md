# Claude Code composer compact

Claude Codeの入力欄下部をコンパクトにする非公式パッチです。既存のMITライセンスのClaude Code Patchから入力欄の調整を切り出しています。

- モデル選択を小さな枠付きボタンに変更し、狭い幅ではロゴだけにします。モデル名はツールチップと読み上げ用ラベルに残ります。
- AgentsとRemote Controlをアイコンにまとめ、状態表示を残します。
- 最も狭い幅では補助操作を「…」から開閉できます。送信・停止ボタンは右端に残ります。
- 長い選択ファイル名は省略表示します。

## 対応環境

Cursorの `anthropic.claude-code` **2.1.286**、Node.js。macOSで検証しています。
自動検出先は `~/.cursor/extensions/extensions.json` です。
他バージョンや想定外のコード構造には適用を拒否します。
ロゴはインストール済み拡張の `resources/claude-logo.svg` から読み込みます。
マスコット・添付機能の変更・Fast modeの変更・自動更新ジョブは含みません。

## 使い方

リポジトリのルートで実行します。

```sh
node claude-composer-compact/patch.mjs check
node claude-composer-compact/patch.mjs apply
```

Claudeの処理が終わってから、Cursorで `Developer: Reload Window` を実行してください。

元に戻す場合：

```sh
node claude-composer-compact/patch.mjs restore
```

復元後も再読み込みが必要です。変更前後のファイルとハッシュは、このフォルダの `logs/` に保存されます。
**復元するまでは、このフォルダとログを残してください。**
復元は適用直後のファイルとハッシュが一致する場合だけ実行し、後から別の変更が入ったファイルは上書きしません。
拡張更新後は、新しい版への互換性確認が必要です。

既存のマスコット用パッチなどで同じ入力欄調整が入っている場合、`check` でその旨を表示し、二重適用を拒否します。
このスクリプトの `restore` は既存マスコット用パッチを除去しません。

## 開発用テスト

通常の適用には追加パッケージは不要です。UI回帰テストにはPlaywrightが必要です。

```sh
cd claude-composer-compact
npm ci
npx playwright install chromium
node test-patch.mjs
node test-footer.cjs /path/to/anthropic.claude-code-extension
```

公式フッターのコードを一時領域へコピーし、外部通信を遮断したheadless Chromiumで5構成×10幅を検証します。
未改変の `webview/index.js`、または既存パッチの `index.js.bak.original` を使用します。
実際のCursorのファイルは変更しません。

MITライセンスは同梱の `LICENSE` を参照してください。Anthropic / Cursorの公式プロジェクトではありません。
