# 処理の流れ

入口は [README](../README.md) です。このファイルは、1 レースが Queue の中でどう進むかを書きます。

## 段階

`POST /run` はレースを 1 件だけ Queue `jra-bashira-race` に積みます。Consumer の `max_batch_size` は 1 で、メッセージを 1 件ずつ処理します。ジョブの `phase` は次の順です。

1. `collect`（メッセージ `start`）。馬場を 1 回取り、`tools/list` のあと `get_races`、出馬表の `get_entries`、単勝の `get_odds` を取る。
2. `form`（メッセージ `form`）。走れる馬の近走を、未処理 8 頭ずつ取る。
3. `stats`（メッセージ `stats`）。`get_stats` を、未処理 8 件ずつ取る。
4. `predict`。コースデータ要約を作り、KV のプロンプトでコース分析を作り、馬柱と合わせてレース予想を作る。
5. `notion`。ページを作り、続きがあれば同じページへ追記する。
6. `done` または `error`。

`get_races` が 1 件以外、結果が打ち切られている、レースが中止、馬場種類か距離が無い、出馬表が空か打ち切られている、ときは予想しません。馬場の取得に失敗しても予想は続けます。詳細は [course-odds.md](course-odds.md) です。

近走が残っているあいだは `form` のメッセージを積み、集計が残っているあいだは `stats` のメッセージを積みます。フォームの 1 メッセージは未処理の馬を最大 8 頭（`FORM_BATCH_SIZE`）見ます。同名で生年が 1 候補に決まる馬は、同じ配送の中で生年付きの名前を 1 回だけ引き直します。1 配送で出す `get_entries` は最大 16 件（`FORM_FETCH_LIMIT`）です。これを超えた馬は pending のまま、次の `form` メッセージへ回します。

集計の 1 メッセージは、未処理の `get_stats` を最大 8 件、同じ Durable Object 呼び出しの中で順に実行します。Durable Object は 1 回に 8 件を超える tool を受け付けません。途中まで成功した集計はジョブに残し、失敗したときはそのエラーで止めます。再試行では、まだ pending のものだけを続けます。

上のコース集計の結果は KV にキャッシュしますが、Gemini のコース分析にもレース予想にも渡しません。Notion の本文にも書きません。

コースデータ要約は、この集計とは別に、`predict` の中で Gemini の前に作ります。同じ開催場・芝またはダート・距離で、レース日の前日から過去 `STATS_PERIOD_YEARS` 年を `get_stats` で数え、率はコードで計算します。失敗しても予想は止めず、ジョブに理由を残してコース分析を続けます。Notion の書式には足しません。中身は [course-odds.md](course-odds.md)、差し込みは [prompts.md](prompts.md) です。

## 外部呼び出しの上限

Free プランの外部 `fetch` は 1 呼び出し 50 件まで、とコードのコメントにあります。Worker と Durable Object は、その手前で止めます。

| 場所 | 定数 | 止める件数 |
| --- | --- | --- |
| Worker の外部 `fetch` | `EXTERNAL_BUDGET` | 45 |
| Durable Object の外部 `fetch` | `DO_EXTERNAL_BUDGET` | 40 |

KV、Queue、Durable Object への内部呼び出しは、この外部件数に入れません。以前の README は、Free プランの内部呼び出し上限を 1000 と書いていました。その数は、このリポジトリの定数にはありません。

上限に達した Worker は、ジョブを分割して止める再試行可能なエラーにします。Notion へ書き始めたあとなら、下の「Notion の続き」に従います。

## Queue と失敗

`wrangler.jsonc` の consumer は次のとおりです。

| 設定 | 値 |
| --- | --- |
| `max_batch_size` | 1 |
| `max_batch_timeout` | 1 |
| `max_retries` | 3（`src/types.ts` の `QUEUE_MAX_RETRIES` と同じ） |
| `retry_delay` | 30 秒 |
| `max_concurrency` | 1 |
| `dead_letter_queue` | `jra-bashira-race-dlq` |

待ち時間を置いているのは、同じジョブキーの KV 書き込みが 1 秒に 1 回という制限に当たらないようにするためです。ジョブの保存は、同じ配送の中では約 1.1 秒に 1 回まで間を空けます。

再試行できるエラーで、配送の `attempts` が 3 未満のときは `retry` します。再試行しないエラー、または `attempts` が 3 以上のときは、失敗理由をジョブに書けたら `ack` し、`phase` を `error` にします。この経路では待ち行列へは入りません。失敗理由の保存に失敗したときは、`retry` を返します。Queue 側の再試行を使い切った配送は、`jra-bashira-race-dlq` の設定に従います。待ち行列の作り方は [operations.md](operations.md) です。

認可の失敗（未認可、`invalid_grant`、通信失敗を含む refresh 失敗）は再試行せず、ジョブを `error` にします。理由は `GET /admin/jobs` の `error` に出ます。

## 同じレースのロック

受理されると 202 で `race_key`、`run_id`、`requested_by` が返ります。同じレースが処理中なら 409 です。

ロックのキーは `lock:v1:{raceKey}` で、寿命は 15 分（`LOCK_TTL_SECONDS`）です。ロックが残っていても、ジョブの `phase` が `done` か `error` のとき、`error` が入っているとき、最後の更新から 15 分を超えているときは、新しい実行を拒みません。ジョブが無く、ロックの期限だけが残っているときは拒みます。

終了時と、再試行しない失敗を保存できたときは、ロックを消します。Queue へ積む前に失敗したときも消します。

## Notion の続き

ページを作った直後に、ページ ID をジョブと KV `notion:page:v1:{raceKey}` に残します。追記の途中で外部呼び出しの上限に達しても、次の `notion` メッセージはそのページを続けます。旧ページは、新しい本文が終わるまでアーカイブしません。この続きは最大 8 回（`NOTION_CONTINUATION_LIMIT`）です。ページの選び方は [notion.md](notion.md) です。

## cron

`wrangler.jsonc` の `triggers` はコメントアウトしています。コメント内の例は `0 21 * * *` です。有効にしても `scheduled` は理由をログして戻り、レースは積みません。時刻を決めたあとに、積む処理を別途足してください。
