# Notion Task Board 0.7.6

NotionのタスクをCursorのパネルで表示する拡張です。インストール済み0.7.6を基に、個人・社内固有の設定値を外しています。

このフォルダで `npx --yes @vscode/vsce@3.7.1 package --no-dependencies --skip-license` を実行し、生成したVSIXをCursorの「Extensions: Install from VSIX...」からインストールします。

Cursor設定で次を設定してください。

- `notionTaskBoard.token`: 自分のNotion Integration Token
- `notionTaskBoard.databaseId`: 自分のタスクDBのID
- `notionTaskBoard.assigneeUserId`: 担当者のユーザーID。空欄なら全員
- `notionTaskBoard.refreshInterval`: 更新間隔（秒）

Integrationに対象DBのアクセス権を与える必要があります。既存DBのプロパティ構成に依存するため、任意のDBをそのまま表示できるとは限りません。設定値はリポジトリにコミットしないでください。
