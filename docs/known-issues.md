# 既知の問題

## Workers Builds のプルリクエストプレビュー

Workers Builds のプルリクエスト用プレビュー確認は、必ず失敗します。`wrangler.jsonc` に `previews` の設定が無いためです。これは前からある問題で、このリポジトリの不具合として新しく入ったものではありません。

マージ後の本番ビルドは成功します。プレビューを通すための `previews` 設定は、頼まれない限り足しません。本番のビルドコマンドとデプロイコマンドは [README](../README.md) のとおりです。

## `.dev.vars.example` に `ACCESS_AUD` が無い

実行時に必要な Secret は `GEMINI_API_KEY`、`NOTION_TOKEN`、`TOKEN_ENCRYPTION_KEY`、`ACCESS_AUD` の 4 つです。`.dev.vars.example` にあるのは前の 3 つだけで、`ACCESS_AUD` の行はありません。ローカルで保護された経路を試すときは、コピー先の `.dev.vars` に自分で足します。例ファイルは、このドキュメント整理では変えていません。
