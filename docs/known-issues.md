# 既知の問題

## プルリクエストのプレビュー

プレビュー確認は通る。本番の KV、Queue、cron、シークレットは渡していない。`BABA` は本番の `jra-dify-pipeline` を読む。設定の中身は [operations.md](operations.md) にある。

## `.dev.vars.example` に `ACCESS_AUD` が無い

実行時に必要な Secret は `GEMINI_API_KEY`、`NOTION_TOKEN`、`TOKEN_ENCRYPTION_KEY`、`ACCESS_AUD` の 4 つです。`.dev.vars.example` にあるのは前の 3 つだけで、`ACCESS_AUD` の行はありません。ローカルで保護された経路を試すときは、コピー先の `.dev.vars` に自分で足します。例ファイルは、このドキュメント整理では変えていません。
