# Cursor Codex + Claude Code patches

CursorでCodex・Claude Codeを使う際の、入力欄と複数タブの使い勝手を改善する非公式パッチ集です。

## できること

- **入力欄の位置調整**: 「ローカルで作業」などの操作行を入力欄の上へ移し、入力欄の最小高さを縮めます。複数行入力は伸びます。
- **独立した複数タブ**: `Codex: New Codex Agent` から毎回別のCodexタブを開き、左右・上下のエディタグループに並べられます。
- **ヘッダー調整**: 履歴・新規チャットを細線の時計・丸い＋アイコンに整えます。

- **Claude Codeの入力欄整理**: モデル・Agents・Remote Controlを小さくまとめ、狭い幅では補助操作を「…」に畳みます。[使い方](claude-composer-compact/README.md)（Claude Code 2.1.286専用）。

以下はCodex用の手順です。Claude Code用は上記リンクを参照してください。

## 対応環境

- Cursorの `openai.chatgpt` 拡張 **26.5908.31748** 専用です。
- macOSの `~/.cursor/extensions/extensions.json` に登録された拡張を対象とします。他OSや別の配置先は未検証です。
- Python 3、Node.js（複数タブ用のJavaScript構文検査）が必要です。追加Pythonパッケージは不要です。
- OpenAI / Cursorの公式プロジェクトではありません。拡張本体をローカルで書き換えます。

## 使い方

このリポジトリのルートで実行します。まず互換性を確認してください。

```sh
python3 codex-composer-align/patch.py check
python3 codex-multi-panel/patch.py check
```

適用するパッチを選んで実行します。2つを併用できます。

```sh
python3 codex-composer-align/patch.py apply
python3 codex-multi-panel/patch.py apply
```

作業中のCodexの処理が終わってから、Cursorのコマンドパレットで `Developer: Reload Window` を実行します。
その後 `Codex: New Codex Agent` で新しいタブを開いてください。

## 元に戻す

```sh
python3 codex-multi-panel/patch.py restore
python3 codex-composer-align/patch.py restore
```

復元後もCursorの再読み込みが必要です。実行前後のファイルとハッシュは各パッチの `logs/` に保存されます。
ログには拡張本体のコピーやローカルパスを含むため、Git管理から除外しています。

## 更新時の扱い

拡張が更新されるとパッチが消えることがあります。異なるバージョンや想定と異なるコードには適用を拒否します。
バージョン番号だけを書き換えて再実行せず、新しいコードへの適合確認が必要です。
既存会話の複製や、別OSウィンドウを自動で開く機能はありません。

配布対象はパッチスクリプト・CSS・説明書のみです。
旧版の `patch-codex.sh` はコード構造が異なるため含めていません。
