# 処理の流れ

入口は [README](../README.md) です。このファイルは、1 レースが Queue の中でどう進むかを書きます。

## 段階

`POST /run` はレースを 1 件だけ Queue `jra-bashira-race` に積みます。Consumer の `max_batch_size` は 1 で、1 つの配送はメッセージ 1 件です。別レースは `max_concurrency` の 3 件まで同時に進みます。ジョブの `phase` は次の順です。

1. `collect`（メッセージ `start`）。馬場を 1 回取り、`tools/list` のあと `get_races`、出馬表の `get_entries`、単勝の `get_odds` を取る。
2. `form`（メッセージ `form`）。走れる馬の近走を、未処理 8 頭ずつ取る。
3. `stats`（メッセージ `stats`）。`get_stats` を、未処理 8 件ずつ取る。
4. `predict`。コースデータ要約を作り、KV のプロンプトでコース分析を作り、レース情報と馬柱を合わせてレース予想を作る。コース分析だけ Google 検索を付ける。両方の思考レベルは `high`。渡し方は [prompts.md](prompts.md) です。
5. `notion`。ページを作り、続きがあれば同じページへ追記する。
6. `done` または `error`。

`get_races` が 1 件以外、結果が打ち切られている、レースが中止、馬場種類か距離が無い、出馬表が空か打ち切られている、ときは予想しません。馬場の取得に失敗しても予想は続けます。詳細は [course-odds.md](course-odds.md) です。

近走が残っているあいだは `form` のメッセージを積み、集計が残っているあいだは `stats` のメッセージを積みます。フォームの 1 メッセージは未処理の馬を最大 8 頭（`FORM_BATCH_SIZE`）見ます。同名で生年が 1 候補に決まる馬は、同じ配送の中で生年付きの名前を 1 回だけ引き直します。1 配送で出す `get_entries` は最大 16 件（`FORM_FETCH_LIMIT`）です。これを超えた馬は pending のまま、次の `form` メッセージへ回します。

集計の 1 メッセージは、未処理の `get_stats` を最大 8 件、同じ Durable Object 呼び出しの中で順に実行します。Durable Object は 1 回に 8 件を超える tool を受け付けません。途中まで成功した集計はジョブに残し、失敗したときはそのエラーで止めます。再試行では、まだ pending のものだけを続けます。

上のコース集計の結果は KV にキャッシュしますが、Gemini のコース分析にもレース予想にも渡しません。Notion の本文にも書きません。回りで絞ったキャッシュは、絞らないキャッシュとは別のキーです。

コースデータ要約は、この集計とは別に、`predict` の中で Gemini の前に作ります。同じ開催場・芝またはダート・距離で、レース日の前日から過去 `STATS_PERIOD_YEARS` 年を `get_stats` で数え、率はコードで計算します。`course_side` が `内`、`外`、`外→内`、`内→外` のときは、その回りだけを数えます。`なし` は数え方を変えません。失敗しても予想は止めず、ジョブに理由を残してコース分析を続けます。Notion の書式には足しません。中身は [course-odds.md](course-odds.md)、差し込みは [prompts.md](prompts.md) です。

`predict` の 1 配送で、コース分析とレース予想の `streamGenerateContent`（`alt=sse`）を続けて呼びます。思考レベルは両方 `high` です。以前の `generateContent` は本文が揃うまで応答ヘッダを返さないため、長いレース予想が約 125 秒で HTTP 524 になり、predict ごと再試行されていた。ストリームはヘッダのあとで本文を届ける。2026-11-08 の東京11Rでは、この経路で 524 も再試行も無かった。記録は [verification.md](verification.md) です。`fetch` の待ちは CPU 時間に入らず、1 本のストリームはサブリクエスト 1 件である。思考トークンが増えると壁時計が長くなり、Queue consumer の 15 分に当たりやすくなります。上限で打ち切られた配送は、予想が保存されていなければ再試行で両方の呼び出しからやり直します。コース分析の検索クエリも、そのたびに数え直されます。途中で切れたストリームも失敗にして、同じ再試行に乗せる。

コース分析のユーザー文と、コース分析・レース予想の出力全文は、同じ KV の `trace:v1:{raceKey}` に残します。システムプロンプトの本文は残しません。馬柱とレース予想のユーザー文は、これまでどおり `input:v1:{raceKey}` です。値の上限は馬柱の保存と同じです。見方は [admin.md](admin.md) の `GET /admin/inspect` です。

レース予想のユーザー文には、レース名、グレード、クラス、競走種別、頭数、コース（A〜D）、内外回り、斤量種別、発走時刻と、各馬の調教師・馬体重を足します。出典は collect で既に取る `get_races` と出馬表の `get_entries` です。`trainer_east_west` と `horse_weight_difference_with_previous_race` と `course_side` は、tools/list にあるときだけ列に足します。`course_side` が `内`、`外`、`外→内`、`内→外`、`なし` のときは、その値を内外回りに書きます。項目が無い、空、読めないときは空欄です。仮柵は項目が無いので空欄です。レース情報そのものにオッズは足しません。

それに加え、predict で各馬の通算を `get_entries` で取ります。近10走の表（`{{past_runs}}`）と、同じコース・同じ競馬場・関連コースの成績（`{{course_records}}`）は、この応答から作ります。近10走のための別呼び出しはありません。関連コースの一覧は、コース分析の末尾から読み、`{{course_analysis}}` と Notion のコース分析からは除きます。読めないときは `raceInputGaps` に残し、関連コースの成績だけ空欄にして予想は続けます。今回の単勝（`{{win_odds}}`）は、collect で既に取る `get_odds` と出馬表から作り、追加の呼び出しはしません。中身は [prompts.md](prompts.md) と [umabashira.md](umabashira.md) です。

通算の `get_entries` は、出走する馬の名前をまとめて取ります（1 呼び出しの `limit` は 200。BASHIRA の上限と同じ）。`career_starts` の見積もりが 150 行を超えるとき、または馬名が 100 件を超えるときは、呼び出しを分けます。応答が打ち切れて複数頭が混ざっているときは、頭数を半分にして取り直します。1頭が 200 行で打ち切れたときは、その馬の欠けを `raceInputGaps` に残します。この取得は 1 配送で最大 8 回（`CAREER_FETCH_LIMIT`）です。同名で近走を特定できない馬は、この呼び出しに入れません。

近10走のレース名は `race_name_main` のままです。表の末尾の条件列は、同じ `get_entries` の `race_type` と `race_condition` が両方あるときだけ並べます。どちらかが無い走は空欄です。追加の呼び出しはありません。

近10走に出てきた JRA のレースの前半3Fと後半3Fは、`get_races` を `race_id` の配列で取ります。配列は 100 件までなので、最大 2 回（18頭×10走は 180 件、同じレースは1回にまとめる）です。`race_id` は開催日、競馬場、レース番号から作ります。開催日が `2026-10-12T00:00:00Z` のように時刻付きでも、先頭の `YYYY-MM-DD` を使います。時刻を残したままでは `race_id` が作れず、`get_races` を呼ばないので前半3Fと後半3Fが全行空欄になります。列が tools/list に無いときは呼び出しをせず、セルを空欄にして `raceInputGaps` に残します。

predict のこの取得は、コース分析のあと、レース予想の前です。`tools/list` がコースデータ要約とは別に 1 回入ります。失敗（認可、上限、上流）のときは、そのエラーで止めます。関連コースの一覧が読めないことだけでは止めません。

そのあと、同じ配送で出走馬のコース成績（`{{runner_stats}}`）を作ります。父と母の父は、名前を配列にして `get_stats` を 1 回ずつ呼びます。`name_resolution` が曖昧な名前は、問い合わせた名前に生年を足した候補がちょうど 1 件のときだけ、その名前で 1 回だけ指定し直します。候補が複数のときは決め打ちせず、その名前は欠けにします。騎手は配列にできないので 1 人ずつです。結果は KV に、コース（競馬場、芝かダート、距離、期間、絞った回り）× 騎手 × `data_version` で 7 日置きます。`なし` と絞らない結果は、回りの断片を付けません。同じ日の別レースはこれを読み、無いときだけその場で取ります。`data_version` は、先に取る父か母の父の応答から読みます。期間をキーに入れるのは、同じ `data_version` でもレース日が違うと終点が 1 日ずれるためです。回りをキーに入れるのは、内と外の結果を混ぜないためです。

この取得は予想を止めません。失敗、名前が見つからない、同名、呼び出し上限で切った分は、`raceInputGaps` に残し、取れた行だけ渡します。取れない値は 0 件にしません。解決できた名前で行が無いときだけ、出走 0 です。本文は近10走・コース成績と同じく `input:v1:{raceKey}` の別フィールドに置き、`GET /admin/jobs/input?include=past_runs` の `runner_stats` で返します。プロンプト文は返しません。別フィールドが無い保存は、ユーザー文から `# 出走馬のコース成績` だけを切り出します。1 配送の `get_stats` は `RUNNER_STATS_CALL_LIMIT`（24）までです。内訳は、父 1、母の父 1、それぞれの再指定 1、騎手 18、騎手の再指定 2 です。Durable Object の 1 呼び出しには、既存の集計と同じく 8 件までまとめます。

そのあと、3歳未勝利に限って過去最高レースレベルを馬柱の末尾へ足します。対象は `race_type` が `3歳`、`race_condition` が `未勝利`、`grade` が G1、G2、G3、L のどれでもなく、`race_condition` がオープンではなく、`surface` が芝またはダートのレースです。新馬、1勝クラス、2歳、3歳以上、障害は対象外です。対象外では KV を読まず、節も出しません。対象でも、race の system にマーカー `<!-- input:race_level -->` が無いときは出しません。新しい `{{...}}` 差し込みは足しません。`{{umabashira}}` の値の末尾に、別の節として連結します。

値はこの Worker では計算しません。共有マシンが `APP_KV` に書いた `c1:v1:meta` と、その `feat_key`（`c1:v1:feat:{asof}`）を読むだけです。他の `c1:v1:*` は読みません。書き込みもしません。`display` はそのまま馬番つきの行にします。表に無い馬は `過去最高レースレベル 不明` です。取消・除外（出走取消、発走除外、競走除外）は出しません。基準日 `asof` が開催日の 9 日前より古いとき、開催日以降のとき、meta か feat が無いとき、壊れているときは、全頭を不明にし、理由を `raceInputGaps` に足します。開催日の 9 日前から開催日前日までだけ、表を使います。基準日が範囲外のときは feat を読みません。予想は止めません。記録は `input:v1:{raceKey}` と `trace:v1:{raceKey}` の `raceLevel` に足し、新しいキーは作りません。Notion の書式は変えません。中身は [prompts.md](prompts.md) と [umabashira.md](umabashira.md) です。

出馬表の時点で週の「コース × 騎手」を別キューで先に取る仕組みは、入れていません。Notion 段の外部 45 は別の配送で、predict の BASHIRA はその 45 に数えません。上の 24 回を、コース要約、通算、ペース、Gemini 2 回と足しても、Durable Object への呼び出しを外部 50 に数える仮定で 50 未満です。同じコースの 2 レース目以降は騎手の呼び出しが 0 です。先に別メッセージへ分けると、予想が保存される前の再試行で Gemini をやり直す経路と組み、15 分の上限をむしろ使いやすくなります。`get_stats` を最大 24 回足しても、思考レベル `high` の Gemini より短いので、この配送に収めています。

レース予想の本文をジョブに保存する前に、買い目の点数を馬番の列から数え直します。見出しの券種（3連複、3連単、馬連、馬単、ワイドなど）ごとに、フォーメーション、ボックス、流しの列を読み、同じ馬が重なる組と、同じ組の重複を除いて数えます。見出しの点数と違うときだけ、その数字を差し替えます。列が読めない買い目は本文を変えません。数え直しに失敗しても予想は止めません。差し替えたときはジョブの `ticketCountCorrections` とログ `ticket_count_corrected` に、券種、見出しの点数、数え直した点数を残します。`trace:v1:{raceKey}` のモデル出力は、差し替える前のままです。Notion の見出し、並び、文言は変えません。

## 外部呼び出しの上限

Free プランの外部 `fetch` は 1 呼び出し 50 件まで、とコードのコメントにあります。Worker と Durable Object は、その手前で止めます。

| 場所 | 定数 | 止める件数 |
| --- | --- | --- |
| Worker の外部 `fetch` | `EXTERNAL_BUDGET` | 45 |
| Durable Object の外部 `fetch` | `DO_EXTERNAL_BUDGET` | 40 |

KV、Queue、Durable Object へのバインディング呼び出しは、この外部件数に入れません。Free プランでは、それらへのサブリクエストが 1 呼び出し 1,000 件までです。この 1,000 はリポジトリの定数ではありません。日次の KV 書き込み（1,000）と Queue 操作（10,000）、同じキーへの書き込みが 1 秒に 1 回であることは、[operations.md](operations.md) にまとめてあります。429 のときは 1 秒、2 秒、4 秒待って同じ書き込みをやり直します（`KV_PUT_BACKOFF_MS`）。

レース情報を足すための外部 `fetch` は 0 回です。既存の `get_races` 1 回と、出馬表の `get_entries` 1 回の列を増やすだけです。Notion 段の予算 45 も変えません。過去走とコース成績の BASHIRA 呼び出しは predict の配送で、Notion の配送には入れません。

predict の Worker 外部 `fetch` は、これまでどおり Gemini が 2 回（コース分析とレース予想）です。BASHIRA は Durable Object 経由で、この 45 件には数えません。仮に Durable Object への呼び出しも 50 件に数えるとしても、既存はコース要約の `tools/list` 1、`callTools` 1、`get_races` は通常 1（打ち切れたときだけ offset で続く）、通算の `tools/list` 1（出走馬のコース成績もこの一覧を使う。通算を呼ばないときだけ、もう 1 回取る）、通算の `get_entries` が通常数回（上限 8）、ペースの `get_races` が最大 2 回、Gemini 2 です。ここに父と母の父の `get_stats`（通常 2、曖昧なら再指定で最大 4）と、騎手の `get_stats`（キャッシュが無いとき最大 18、`callTools` では 8 件ずつ）を足します。`RUNNER_STATS_CALL_LIMIT` は 24 で、合わせても 50 より少ないです。キャッシュが当たるレースは騎手の分が 0 です。Notion 段は外部 45 のままです。枠・4角・馬場状態の集計は、これまでどおり別の `stats` メッセージです。

上限に達した Worker は、ジョブを分割して止める再試行可能なエラーにします。Notion へ書き始めたあとなら、下の「Notion の続き」に従います。

## Queue と失敗

`wrangler.jsonc` の consumer は次のとおりです。

| 設定 | 値 |
| --- | --- |
| `max_batch_size` | 1 |
| `max_batch_timeout` | 1 |
| `max_retries` | 3（`src/types.ts` の `QUEUE_MAX_RETRIES` と同じ） |
| `retry_delay` | 30 秒 |
| `max_concurrency` | 3（`src/types.ts` の `QUEUE_MAX_CONCURRENCY` と同じ） |
| `dead_letter_queue` | `jra-bashira-race-dlq` |

待ち時間を置いているのは、同じジョブキーの KV 書き込みが 1 秒に 1 回という制限に当たらないようにするためです。ジョブの保存は、同じ配送の中では約 1.1 秒に 1 回まで間を空けます。

再試行できるエラーで、配送の `attempts` が 3 未満のときは `retry` します。そのあいだ `phase` は進んでいる段階のままです（`predict` なら `predict`）。ジョブの `retry` に、失敗した配送の `attempt`、`maxAttempts`（`max_retries`）、`lastError` を残します。`GET /admin/jobs` はこれを `retrying attempt 2/3` のように返します。`error` は、再試行が終わるまで空のままです。次の配送が先へ進むと `retry` は消します。

再試行しないエラー、または `attempts` が 3 以上のときは、失敗理由をジョブに書けたら `ack` し、`phase` を `error` にします。この経路では待ち行列へは入りません。失敗理由の保存に失敗したときは、`retry` を返します。Queue 側の再試行を使い切った配送は、`jra-bashira-race-dlq` の設定に従います。待ち行列の作り方は [operations.md](operations.md) です。

`phase` を `error` に書けたときだけ、任意の Webhook へ POST します。`NOTIFY_WEBHOOK_URL` が未設定なら送りません。本文は JSON で、`type` は `race_failed` です。入るのは `race_key`、`run_id`、失敗したときの `phase_at_failure`、短い `error`、`attempts`、分かれば `http_status`、`inspect_path`（`/admin/inspect?race_key=...`）、`jobs_path`（`/admin/jobs?race_key=...`）、`occurred_at_jst` です。キーは Secret `NOTIFY_WEBHOOK_KEY` です。ヘッダー名は平文の `NOTIFY_WEBHOOK_KEY_HEADER` で、未設定なら `Authorization: Bearer <key>` です。`Authorization` という名前は大文字小文字を問いません。別の名前ならキーをそのままそのヘッダーに入れます。`Content-Type` と `Content-Length` は使いません。URL とキーはログに出しません。失敗したときは HTTP ステータスだけをログし、約 10 秒で打ち切ります。この POST は同じ配送の外部予算に 1 件数えます。ソフト上限の 45 を使い切ったあとでも、プラットフォーム上限の 50 未満なら 1 件だけ送ります。通知の失敗でジョブを `error` 以外にしたり、Queue の再試行を足したりはしません。置き方は [operations.md](operations.md) です。

複数レースを一度に積む入口は、金曜・土曜の cron と `POST /admin/batch` です。どちらもレースごとに `start` を 1 件ずつ積み、`POST /run` と同じ関数を使います。`POST /run` 自体は 1 レースのままです。`max_batch_size` は配送の件数で、レースの束ではありません。`max_concurrency` が 3 なので、別レースのメッセージは 3 件まで同時に進みます。同じレースの次の段階は、前のメッセージが終わってから積みます。終了を 1 通にまとめる `batch_completed` は送りません。

認可の失敗（未認可、`invalid_grant`、通信失敗を含む refresh 失敗）は再試行せず、ジョブを `error` にします。理由は `GET /admin/jobs` の `error` に出ます。このときも、上の Webhook を 1 回送ります。

## 同じレースのロック

受理されると 202 で `race_key`、`run_id`、`requested_by` が返ります。同じレースが処理中なら 409 です。

ロックのキーは `lock:v1:{raceKey}` で、寿命は 4 時間（`LOCK_TTL_SECONDS`）です。3 並列で 36 レースを進めると、次のメッセージを待つあいだジョブの更新が止まります。`predict` が consumer の 15 分まで伸びると、その待ちは約 3 時間になります。15 分のままだと、待ちのあいだの再投入が進行中のジョブを上書きします。

ロックキーが消えていても、ジョブが処理中で最後の更新から 4 時間以内なら、新しい実行は拒みます。`phase` が `done` か `error` のとき、`error` が入っているとき、更新が 4 時間を超えて止まっているときは拒みません。ただし期限内のロックが、そのジョブと別の `runId` を持っているときは、新しい `start` が Queue にいるので拒みます。ジョブが無く、ロックの期限だけが残っているときも拒みます。

別の `runId` の `start` が配送されても、期限内のロックか処理中のジョブがあるときは collect しません。ジョブを書く直前にもう一度見ます。自分が外したのではないロックは消しません。

`max_concurrency` が 3 だと、次の段階のメッセージが別の isolate で、KV のジョブより先に読まれることがあります。ジョブがまだ見えない、または段階が追いついていないときは、KV に書かず再配送します。すでに先の段階へ進んだメッセージは、その段階をやり直しません。Notion の検索は日付・競馬場・レース番号で絞ります。並走しても、別レースのページは候補になりません。同じレースの BASHIRA ページが複数なら、これまでどおり止めます。

終了時と、再試行しない失敗を保存できたときは、その実行のロックだけを消します。Queue へ積む前に失敗したときも、その実行のロックだけを消します。

## Notion の続き

ページを作った直後に、ページ ID をジョブと KV `notion:page:v1:{raceKey}` に残します。追記の途中で外部呼び出しの上限に達しても、次の `notion` メッセージはそのページを続けます。旧ページは、新しい本文が終わるまでアーカイブしません。この続きは最大 8 回（`NOTION_CONTINUATION_LIMIT`）です。ページの選び方は [notion.md](notion.md) です。

## cron

金曜と土曜の 16:45（日本時間）に、翌日の開催を積みます。式は `45 7 * * FRI,SAT` です。時刻の決め方は [operations.md](operations.md) にあります。

`scheduled` は、レースを列挙して積む処理が終わるまで待ちます。予想の完了は待ちません。BASHIRA の `get_races` に、その開催日の `race_meeting_date` を `gte` と `lte` で渡します。1 回の `limit` は KV `config:get-races-limit`（正の整数。無い、または不正なら 200）です。`get_races` は `offset` を持ち、上限は 2000 です。`truncated` のときは `offset` に `row_count` を足して同じ条件で続け、`data_version` がページの途中で変わったら先頭から 1 回だけ取り直します。スキーマに `offset` が無いときだけ、10 場に分けて取り直します。場でもまだ打ち切れているとき、`offset` の上限を超えるとき、`data_version` がもう一度変わったときは、その日は 1 件も積みません。中止（`race_status` が `canceled`）は積みません。0 件ならログして戻ります。

`limit` が BASHIRA の上限を超えて `validating /properties/limit: maximum:` の形で拒まれたときは、レースを積まず、要約を KV `batch:v1:{開催日}` に残します（`dry_run` でも残します）。`limit_sent` は送った件数、`limit_maximum` はメッセージから読んだ上限、`error` はその両方と元の文です。`NOTIFY_WEBHOOK_URL` があるときは `type` が `batch_failed` の JSON で同じ 2 つを送ります。URL が無ければ通知しません。cron の呼び出し自体は失敗のままです。件数の変え方と積み直しは [README](../README.md) の「開催日の get_races 件数」です。

処理中のジョブと、`phase` が `done` のジョブは飛ばします。`error` のジョブはもう一度積みます。同じ `race_key` が列挙に二度出たときも飛ばします。積めた件数、飛ばした件数、失敗した件数はログと KV `batch:v1:{開催日}` に 1 件残します。レースごとのキーは増やしません。要約は 14 日で消えます。手動で同じことをする入口は [admin.md](admin.md) の `POST /admin/batch` です。

## KV のキー

Worker が使う主なキーです。過去最高レースレベルの 2 つは読み取りだけで、書き込みは共有マシンです。

| キー | この Worker |
| --- | --- |
| `job:v1:{raceKey}` | 読み書き。ジョブの状態 |
| `lock:v1:{raceKey}` | 読み書き。同じレースのロック |
| `batch:v1:{date}` | 書き込み。開催日の投入要約。14 日で消える。`limit` 上限の失敗も残す |
| `config:get-races-limit` | 読み取り。開催日の `get_races` の件数。正の整数。無いときは 200 |
| `notion:page:v1:{raceKey}` | 読み書き。追記するページ ID |
| `config:models`、`config:models:previous`、`config:models:history` | 読み書き。Gemini のモデル |
| `cache:v2:gemini-models` | 読み書き。モデル一覧の 10 分キャッシュ |
| `prompt:v2:course`、`prompt:v2:race` | 読み取り。本文の入れ方はこのリポジトリに無い |
| `input:v1:{raceKey}` と `:u` `:r` `:p` `:c` `:s` の分割 | 読み書き。馬柱、ユーザー文、近10走、コース成績、出走馬のコース成績。`raceLevel` は同じ JSON |
| `trace:v1:{raceKey}` と `:cu` `:co` `:ro` の分割 | 読み書き。コースのユーザー文と、両方の出力。`raceLevel` は同じ JSON。システムプロンプトは入れない |
| `stats:v2:{id}:{場}:{馬場}:{距離}:{開始年}:{min_starts}:{対象名}` | 読み書き。枠・4角・馬場状態の集計キャッシュ。予想には渡さない。回りで絞ったときだけ末尾に `:side:{値}` |
| `jockey-course:v1:{data_version}:{場}:{馬場}:{距離}:{期間の始}:{期間の終}:{騎手}` | 読み書き。騎手のコース成績。7 日で消える。回りで絞ったときだけ末尾に `:side:{値}` |
| `c1:v1:meta` | 読み取りのみ。書き込みは外部。過去最高レースレベルの基準日と `feat_key` |
| `c1:v1:feat:{asof}` | 読み取りのみ。書き込みは外部。馬ごとの `display` |
| その他の `c1:v1:*`（races、runs、horses、sw） | 読まない |

`c1:v1:meta` が指す `feat_key` が `c1:v1:feat:{asof}` と一致しないときは、そのキーを読まず、全頭を不明にします。予想 1 件あたりの KV 書き込みは増やしません。読み取り回数は [operations.md](operations.md) です。
