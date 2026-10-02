# Claude Code full patch

Cursorで使用しているClaude Code Patch v52の共有用コピーです。

- 状態に応じて変わるClawdマスコット
- 任意ファイルをチャットにドラッグ＆ドロップで添付
- Fast modeの切替補助コード（2.1.286ではメニューの一致箇所が見つからず、公式のターミナル操作を維持）
- モデル・Agents・Remote Controlをコンパクトにする入力欄調整

対応は **Claude Code 2.1.286**、Node.js。macOSで検証しています。
入力欄だけ必要なら `../claude-composer-compact/` を使用してください。両方を重ねて適用しないでください。単独版を適用済みなら先に単独版の `restore` を実行します。

## 手動適用

このフォルダで実行します。

```sh
node patch.mjs
```

Cursor / VS Code / VS Code Insidersの拡張フォルダを探索し、対応版に適用します。
別バージョンが見つかった場合は書き込み前に停止します。
Claudeの処理が終わってから `Developer: Reload Window` を実行してください。

変更対象は `extension.js` と `webview/index.js` です。原本は各ファイルの `.bak.original` に保存されます。

## 自動再適用（任意）

```sh
# macOS: 10分ごとのlaunchdジョブを登録
bash install.sh
```

Windowsでは `powershell -ExecutionPolicy Bypass -File .\install.ps1` を使用します（今回の実行検証はmacOSのみ）。
自動ジョブは `--self-update` でこのリポジトリを `git pull --ff-only` し、パッチを再実行します。ローカル変更がある場合はpullをスキップします。
拡張更新後の新バージョンへの適合確認は必要です。この作業ではジョブの登録・変更は行っていません。

## 復元

macOSは `bash uninstall.sh`、Windowsは `powershell -ExecutionPolicy Bypass -File .\uninstall.ps1`。
自動ジョブを解除し、検出した拡張の `.bak.original` から両ファイルを復元します。
**原本への全体復元なので、後から同じファイルへ加えた別のパッチも外れます。**
復元後はCursor / VS Codeを再読み込みしてください。

## テスト

```sh
npm ci
npx playwright install chromium
node test-footer.cjs /path/to/anthropic.claude-code-extension
```

既存の `.bak.original` を一時フォルダへコピーして適用し、headless Chromiumで5構成×10幅を検証します。
送信・停止・ツールチップ・「…」開閉・添付ハンドラ数・再適用の冪等性を確認します。
テストから実機の拡張は変更しません。マスコットの全アニメーションや実際のファイル添付通信はこのテストの対象外です。

MITライセンスは `LICENSE` を参照してください。Anthropic / Cursorの公式プロジェクトではありません。
