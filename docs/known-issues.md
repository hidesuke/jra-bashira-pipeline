# 既知の問題

## プルリクエストのプレビュー

プレビュー確認は通る。本番の KV、Queue、cron、シークレットは渡していない。`BABA` は本番の `jra-dify-pipeline` を読む。設定の中身は [operations.md](operations.md) にある。

## まだ本番で見ていないこと

3 並列の全レースバッチは未実施で、初回は 2026-11-13 16:45（日本時間）の予定である。その日の KV 書き込み、Gemini の呼び出し、Durable Object の外部 40 件に収まるかも、まだ見ていない。詳細は [verification.md](verification.md) にある。
