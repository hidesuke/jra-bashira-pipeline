# 1 レースの実行

`POST /run` は Access の JWT が必要です。呼び出し方は [access.md](access.md)、進み方は [pipeline.md](pipeline.md) です。

`race_id` は BASHIRA の `YYYYMMDD-場コード-レース番号` です。場コードとレース番号は 2 桁です。場コードは次のとおりです。

| コード | 競馬場 |
| --- | --- |
| 01 | 札幌 |
| 02 | 函館 |
| 03 | 福島 |
| 04 | 新潟 |
| 05 | 東京 |
| 06 | 中山 |
| 07 | 中京 |
| 08 | 京都 |
| 09 | 阪神 |
| 10 | 小倉 |

```bash
curl -sS -X POST "https://<worker>/run" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET" \
  -H "content-type: application/json" \
  -d '{"race_id":"20261107-03-11"}'
```

日付と場名でも同じです。日付は `YYYY-MM-DD`、場名は上の 10 場です。末尾の「競馬場」は除いて解釈します。レース番号は 1 から 12 の整数です。`race_id` と日付・場・レース番号の両方を書いたときは、同じレースである必要があります。配列で複数レースは受け付けません。

```bash
curl -sS -X POST "https://<worker>/run" \
  -H "CF-Access-Client-Id: $MUSE_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $MUSE_ACCESS_CLIENT_SECRET" \
  -H "content-type: application/json" \
  -d '{"date":"2026-11-07","venue":"福島","race_number":11}'
```

任意の `remarks` は文字列のときだけ、前後の空白を除いてレース予想の備考に入ります。それ以外の型は空として扱います。備考の組み立ては [prompts.md](prompts.md) です。

受理されると 202 で `race_key`、`run_id`、`requested_by` が返ります。同じレースが処理中なら 409 です。進捗は [admin.md](admin.md) の `GET /admin/jobs` です。

開催日の全レースは、この `POST /run` では受け付けません。金曜・土曜の cron と `POST /admin/batch` が、レースごとにここと同じ関数で積みます。見方は [admin.md](admin.md) と [pipeline.md](pipeline.md) です。
