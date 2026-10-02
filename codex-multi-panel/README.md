# Codex multi-panel for Cursor

Cursor の Codex 拡張 `26.5908.31748` に対するローカル調整です。

- `Codex: New Codex Agent` が毎回異なる識別子で独立した新規タブを開きます。
- チャット内の右上にある履歴・新規チャットを、Claude Code に近い細線の「時計・丸い＋」に調整します。
- 「丸い＋」は既存の新規チャット操作を使い、独立したタブを開きます。履歴の実行中表示は維持します。
- 以前追加した Cursor ネイティブのタイトルバーの「＋」は取り除きます。
- タブを左右や上下のエディタグループへ移動して別々のチャットを使えます。
- 会話履歴の既存ルートと、先に適用した入力欄の CSS 調整は保持します。
- 同じ会話の複製表示や、別 OS ウィンドウを自動で開く機能ではありません。

```sh
python3 codex-multi-panel/patch.py check
python3 codex-multi-panel/patch.py apply
python3 codex-multi-panel/patch.py restore
```

変更前後の `extension.js`・`package.json`・ヘッダー JavaScript は `logs/` に保存します。
`restore` はこのスクリプトによる動作・ヘッダーの変更を標準に戻します。
適用と復元には拡張のインストール先への書き込み権限が必要です。
適用後、作業中の処理が終わってから Cursor の `Developer: Reload Window` を実行してください。
拡張更新で変更が消える場合があります。別バージョンには自動適用しません。
