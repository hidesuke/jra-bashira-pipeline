# 既知の問題

## プルリクエストのプレビュー

プレビュー確認は通る。本番の KV、Queue、cron、シークレットは渡していない。`BABA` は本番の `jra-dify-pipeline` を読む。設定の中身は [operations.md](operations.md) にある。

## まだ本番で見ていないこと

レースは 1 件ずつ進める。開催日の全レースを 1 件ずつ最後まで進めた記録は、まだ本番にない。その日の KV 書き込み、Gemini の呼び出し、Durable Object の外部 40 件に収まるかも、まだ見ていない。詳細は [verification.md](verification.md) にある。
