# 処理の流れ

入口は [README](../README.md) です。このファイルは、1 レースが Queue の中でどう進むかを書きます。

## 段階

`POST /run` はレースを 1 件だけ Queue `jra-bashira-race` に積みます。Consumer の `max_batch_size` は 1 で、メッセージを 1 件ずつ処理します。ジョブの `phase` は次の順です。

1. `collect`（メッセージ `start`）。馬場を 1 回取り、`tools/list` のあと `get_races`、出馬表の `get_entries`、単勝の `get_odds` を取る。
2. `form`（メッセージ `form`）。走れる馬の近走を、未処理 8 頭ずつ取る。
3. `stats`（メッセージ `stats`）。`get_stats` を、未処理 8 件ずつ取る。
4. `predict`。コースデータ要約を作り、KV のプロンプトでコース分析を作り、レース情報と馬柱を合わせてレース予想を作る。コース分析だけ Google 検索を付ける。両方の思考レベルは `high`。渡し方は [prompts.md](prompts.md) です。
5. `notion`。ページを作り、続きがあれば同じページへ追記する。
6. `done` または `error`。

`get_races` が 1 件以外、結果が打ち切られている、レースが中止、馬場種類か距離が無い、出馬表が空か打ち切られている、ときは予想しません。馬場の取得に失敗しても予想は続けます。詳細は [course-odds.md](course-odds.md) です。

近走が残っているあいだは `form` のメッセージを積み、集計が残っているあいだは `stats` のメッセージを積みます。フォームの 1 メッセージは未処理の馬を最大 8 頭（`FORM_BATCH_SIZE`）見ます。同名で生年が 1 候補に決まる馬は、同じ配送の中で生年付きの名前を 1 回だけ引き直します。1 配送で出す `get_entries` は最大 16 件（`FORM_FETCH_LIMIT`）です。これを超えた馬は pending のまま、次の `form` メッセージへ回します。

集計の 1 メッセージは、未処理の `get_stats` を最大 8 件、同じ Durable Object 呼び出しの中で順に実行します。Durable Object は 1 回に 8 件を超える tool を受け付けません。途中まで成功した集計はジョブに残し、失敗したときはそのエラーで止めます。再試行では、まだ pending のものだけを続けます。

上のコース集計の結果は KV にキャッシュしますが、Gemini のコース分析にもレース予想にも渡しません。Notion の本文にも書きません。

コースデータ要約は、この集計とは別に、`predict` の中で Gemini の前に作ります。同じ開催場・芝またはダート・距離で、レース日の前日から過去 `STATS_PERIOD_YEARS` 年を `get_stats` で数え、率はコードで計算します。失敗しても予想は止めず、ジョブに理由を残してコース分析を続けます。Notion の書式には足しません。中身は [course-odds.md](course-odds.md)、差し込みは [prompts.md](prompts.md) です。

`predict` の 1 配送で、コース分析とレース予想の `generateContent` を続けて呼びます。思考レベルは両方 `high` です。思考トークンが増えると応答が長くなり、Queue consumer の実行時間の上限である 15 分に当たりやすくなります。上限で打ち切られた配送は、予想が保存されていなければ再試行で両方の呼び出しからやり直します。コース分析の検索クエリも、そのたびに数え直されます。

コース分析のユーザー文と、コース分析・レース予想の出力全文は、同じ KV の `trace:v1:{raceKey}` に残します。システムプロンプトの本文は残しません。馬柱とレース予想のユーザー文は、これまでどおり `input:v1:{raceKey}` です。値の上限は馬柱の保存と同じです。見方は [admin.md](admin.md) の `GET /admin/inspect` です。

レース予想のユーザー文には、レース名、グレード、クラス、競走種別、頭数、コース（A〜D）、斤量種別、発走時刻と、各馬の調教師・馬体重を足します。出典は collect で既に取る `get_races` と出馬表の `get_entries` です。`trainer_east_west` と `horse_weight_difference_with_previous_race` は、tools/list にあるときだけ列に足します。内外回りと仮柵は項目が無いので空欄です。レース情報そのものにオッズは足しません。

それに加え、predict で各馬の通算を `get_entries` で取ります。近10走の表（`{{past_runs}}`）と、同じコース・同じ競馬場・関連コースの成績（`{{course_records}}`）は、この応答から作ります。近10走のための別呼び出しはありません。関連コースの一覧は、コース分析の末尾から読み、`{{course_analysis}}` と Notion のコース分析からは除きます。読めないときは `raceInputGaps` に残し、関連コースの成績だけ空欄にして予想は続けます。今回の単勝（`{{win_odds}}`）は、collect で既に取る `get_odds` と出馬表から作り、追加の呼び出しはしません。中身は [prompts.md](prompts.md) と [umabashira.md](umabashira.md) です。

通算の `get_entries` は、出走する馬の名前をまとめて1回で取ります（`limit` 500。続きを取る offset は無い）。`career_starts` の見積もりが 450 行を超えるとき、または馬名が 100 件を超えるときは、呼び出しを分けます。応答が打ち切れて複数頭が混ざっているときは、頭数を半分にして取り直します。1頭が 500 行で打ち切れたときは、その馬の欠けを `raceInputGaps` に残します。この取得は 1 配送で最大 8 回（`CAREER_FETCH_LIMIT`）です。同名で近走を特定できない馬は、この呼び出しに入れません。

近10走に出てきた JRA のレースの前半3Fと後半3Fは、`get_races` を `race_id` の配列で取ります。配列は 100 件までなので、最大 2 回（18頭×10走は 180 件、同じレースは1回にまとめる）です。`race_id` は開催日、競馬場、レース番号から作ります。開催日が `2026-10-12T00:00:00Z` のように時刻付きでも、先頭の `YYYY-MM-DD` を使います。時刻を残したままでは `race_id` が作れず、`get_races` を呼ばないので前半3Fと後半3Fが全行空欄になります。列が tools/list に無いときは呼び出しをせず、セルを空欄にして `raceInputGaps` に残します。

predict のこの取得は、コース分析のあと、レース予想の前です。`tools/list` がコースデータ要約とは別に 1 回入ります。失敗（認可、上限、上流）のときは、そのエラーで止めます。関連コースの一覧が読めないことだけでは止めません。

そのあと、同じ配送で出走馬のコース成績（`{{runner_stats}}`）を作ります。父と母の父は、名前を配列にして `get_stats` を 1 回ずつ呼びます。`name_resolution` が曖昧な名前は、問い合わせた名前に生年を足した候補がちょうど 1 件のときだけ、その名前で 1 回だけ指定し直します。候補が複数のときは決め打ちせず、その名前は欠けにします。騎手は配列にできないので 1 人ずつです。結果は KV に、コース（競馬場、芝かダート、距離、期間）× 騎手 × `data_version` で 7 日置きます。同じ日の別レースはこれを読み、無いときだけその場で取ります。`data_version` は、先に取る父か母の父の応答から読みます。期間をキーに入れるのは、同じ `data_version` でもレース日が違うと終点が 1 日ずれるためです。

この取得は予想を止めません。失敗、名前が見つからない、同名、呼び出し上限で切った分は、`raceInputGaps` に残し、取れた行だけ渡します。取れない値は 0 件にしません。解決できた名前で行が無いときだけ、出走 0 です。本文は近10走・コース成績と同じく `input:v1:{raceKey}` の別フィールドに置き、`GET /admin/jobs/input?include=past_runs` の `runner_stats` で返します。プロンプト文は返しません。別フィールドが無い保存は、ユーザー文から `# 出走馬のコース成績` だけを切り出します。1 配送の `get_stats` は `RUNNER_STATS_CALL_LIMIT`（24）までです。内訳は、父 1、母の父 1、それぞれの再指定 1、騎手 18、騎手の再指定 2 です。Durable Object の 1 呼び出しには、既存の集計と同じく 8 件までまとめます。

出馬表の時点で週の「コース × 騎手」を別キューで先に取る仕組みは、入れていません。Notion 段の外部 45 は別の配送で、predict の BASHIRA はその 45 に数えません。上の 24 回を、コース要約、通算、ペース、Gemini 2 回と足しても、Durable Object への呼び出しを外部 50 に数える仮定で 50 未満です。同じコースの 2 レース目以降は騎手の呼び出しが 0 です。先に別メッセージへ分けると、予想が保存される前の再試行で Gemini をやり直す経路と組み、15 分の上限をむしろ使いやすくなります。`get_stats` を最大 24 回足しても、思考レベル `high` の Gemini より短いので、この配送に収めています。

レース予想の本文をジョブに保存する前に、買い目の点数を馬番の列から数え直します。見出しの券種（3連複、3連単、馬連、馬単、ワイドなど）ごとに、フォーメーション、ボックス、流しの列を読み、同じ馬が重なる組と、同じ組の重複を除いて数えます。見出しの点数と違うときだけ、その数字を差し替えます。列が読めない買い目は本文を変えません。数え直しに失敗しても予想は止めません。差し替えたときはジョブの `ticketCountCorrections` とログ `ticket_count_corrected` に、券種、見出しの点数、数え直した点数を残します。`trace:v1:{raceKey}` のモデル出力は、差し替える前のままです。Notion の見出し、並び、文言は変えません。

## 外部呼び出しの上限

Free プランの外部 `fetch` は 1 呼び出し 50 件まで、とコードのコメントにあります。Worker と Durable Object は、その手前で止めます。

| 場所 | 定数 | 止める件数 |
| --- | --- | --- |
| Worker の外部 `fetch` | `EXTERNAL_BUDGET` | 45 |
| Durable Object の外部 `fetch` | `DO_EXTERNAL_BUDGET` | 40 |

KV、Queue、Durable Object への内部呼び出しは、この外部件数に入れません。以前の README は、Free プランの内部呼び出し上限を 1000 と書いていました。その数は、このリポジトリの定数にはありません。

レース情報を足すための外部 `fetch` は 0 回です。既存の `get_races` 1 回と、出馬表の `get_entries` 1 回の列を増やすだけです。Notion 段の予算 45 も変えません。過去走とコース成績の BASHIRA 呼び出しは predict の配送で、Notion の配送には入れません。

predict の Worker 外部 `fetch` は、これまでどおり Gemini が 2 回（コース分析とレース予想）です。BASHIRA は Durable Object 経由で、この 45 件には数えません。仮に Durable Object への呼び出しも 50 件に数えるとしても、既存はコース要約の `tools/list` 1、`callTools` 1、`get_races` 1、通算の `tools/list` 1（出走馬のコース成績もこの一覧を使う。通算を呼ばないときだけ、もう 1 回取る）、通算の `get_entries` が通常 1 回（上限 8）、ペースの `get_races` が最大 2 回、Gemini 2 です。ここに父と母の父の `get_stats`（通常 2、曖昧なら再指定で最大 4）と、騎手の `get_stats`（キャッシュが無いとき最大 18、`callTools` では 8 件ずつ）を足します。`RUNNER_STATS_CALL_LIMIT` は 24 で、合わせても 50 より少ないです。キャッシュが当たるレースは騎手の分が 0 です。Notion 段は外部 45 のままです。枠・4角・馬場状態の集計は、これまでどおり別の `stats` メッセージです。

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

再試行できるエラーで、配送の `attempts` が 3 未満のときは `retry` します。そのあいだ `phase` は進んでいる段階のままです（`predict` なら `predict`）。ジョブの `retry` に、失敗した配送の `attempt`、`maxAttempts`（`max_retries`）、`lastError` を残します。`GET /admin/jobs` はこれを `retrying attempt 2/3` のように返します。`error` は、再試行が終わるまで空のままです。次の配送が先へ進むと `retry` は消します。

再試行しないエラー、または `attempts` が 3 以上のときは、失敗理由をジョブに書けたら `ack` し、`phase` を `error` にします。この経路では待ち行列へは入りません。失敗理由の保存に失敗したときは、`retry` を返します。Queue 側の再試行を使い切った配送は、`jra-bashira-race-dlq` の設定に従います。待ち行列の作り方は [operations.md](operations.md) です。

`phase` を `error` に書けたときだけ、任意の Webhook へ POST します。`NOTIFY_WEBHOOK_URL` が未設定なら送りません。本文は JSON で、`type` は `race_failed` です。入るのは `race_key`、`run_id`、失敗したときの `phase_at_failure`、短い `error`、`attempts`、分かれば `http_status`、`inspect_path`（`/admin/inspect?race_key=...`）、`jobs_path`（`/admin/jobs?race_key=...`）、`occurred_at_jst` です。キーは Secret `NOTIFY_WEBHOOK_KEY` です。ヘッダー名は平文の `NOTIFY_WEBHOOK_KEY_HEADER` で、未設定なら `Authorization: Bearer <key>` です。`Authorization` という名前は大文字小文字を問いません。別の名前ならキーをそのままそのヘッダーに入れます。`Content-Type` と `Content-Length` は使いません。URL とキーはログに出しません。失敗したときは HTTP ステータスだけをログし、約 10 秒で打ち切ります。この POST は同じ配送の外部予算に 1 件数えます。ソフト上限の 45 を使い切ったあとでも、プラットフォーム上限の 50 未満なら 1 件だけ送ります。通知の失敗でジョブを `error` 以外にしたり、Queue の再試行を足したりはしません。置き方は [operations.md](operations.md) です。

複数レースを一度に積む入口は、いまありません。`POST /run` は 1 レース、cron はレースを積みません。Queue の `max_batch_size` は配送の件数で、レースの束ではありません。そのため `batch_completed` は送りません。後から複数レースを積むときは、積む時点で batch id を付け、終了と失敗の件数をその id でまとめてから 1 回送る必要があります。

認可の失敗（未認可、`invalid_grant`、通信失敗を含む refresh 失敗）は再試行せず、ジョブを `error` にします。理由は `GET /admin/jobs` の `error` に出ます。このときも、上の Webhook を 1 回送ります。

## 同じレースのロック

受理されると 202 で `race_key`、`run_id`、`requested_by` が返ります。同じレースが処理中なら 409 です。

ロックのキーは `lock:v1:{raceKey}` で、寿命は 15 分（`LOCK_TTL_SECONDS`）です。ロックが残っていても、ジョブの `phase` が `done` か `error` のとき、`error` が入っているとき、最後の更新から 15 分を超えているときは、新しい実行を拒みません。ジョブが無く、ロックの期限だけが残っているときは拒みます。

終了時と、再試行しない失敗を保存できたときは、ロックを消します。Queue へ積む前に失敗したときも消します。

## Notion の続き

ページを作った直後に、ページ ID をジョブと KV `notion:page:v1:{raceKey}` に残します。追記の途中で外部呼び出しの上限に達しても、次の `notion` メッセージはそのページを続けます。旧ページは、新しい本文が終わるまでアーカイブしません。この続きは最大 8 回（`NOTION_CONTINUATION_LIMIT`）です。ページの選び方は [notion.md](notion.md) です。

## cron

`wrangler.jsonc` の `triggers` はコメントアウトしています。コメント内の例は `0 21 * * *` です。有効にしても `scheduled` は理由をログして戻り、レースは積みません。時刻を決めたあとに、積む処理を別途足してください。
