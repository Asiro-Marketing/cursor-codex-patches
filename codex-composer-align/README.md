# Cursor Codex composer alignment

既存チャットの「ローカルで作業」などの操作行を入力欄の上へ移し、
入力欄の最小高さを縮めて Claude Code 側の入力位置に近づける表示調整です。
複数行の入力は引き続き伸びます。操作ボタンは隠しません。

対象は Cursor に登録された `openai.chatgpt` バージョン `26.5908.31748`。
JavaScript や認証・権限設定は変更せず、読み込まれる CSS の末尾へ追記します。
拡張の更新後は再確認が必要です。異なるバージョンには適用しません。

```sh
python3 codex-composer-align/patch.py check
python3 codex-composer-align/patch.py apply
python3 codex-composer-align/patch.py restore
```

`apply` と `restore` は拡張のインストール先への書き込み権限が必要です。
変更前後の CSS と対象・ハッシュを `logs/` に保存します。
`restore` は今回の追記ブロックだけを除去し、他の変更を保持します。
反映には Codex パネルの再読み込み、または Cursor の Reload Window が必要です。
作業中のセッションがある場合は、その完了後に再読み込みしてください。
