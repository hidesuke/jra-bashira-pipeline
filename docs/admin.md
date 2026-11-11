# 管理用エンドポイント

どれも Access の JWT が必要です。呼び出し元の見分けは [access.md](access.md) です。例の Client Secret はシェル変数に置き、リポジトリには書きません。

## 開催日の一括投入

`POST /admin/batch` は、指定した開催日のレースを cron と同じ手順で積みます。

```bash
curl -sS -X POST "https://<worker>/admin/batch" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET" \
  -H "content-type: application/json" \
  -d '{"date":"2026-11-09","dry_run":true}'
```

`date` は `YYYY-MM-DD` で必須です。ハイフンの無い `YYYYMMDD` は 400 です。`dry_run` が `true` のときは列挙し、既存のジョブを読んで飛ばすかを決めます。Queue にもロックにも KV の要約にも書きません。省略か `false` のときは積みます。中止（`canceled`）、重複、処理中、完了済みは `skipped` です。失敗済みはもう一度積みます。`race_status` が無い行や、レースを解釈できない行は `failed` です。

列挙できたときの応答は 200 です。件数は `enqueued`、`would_enqueue`、`skipped`、`failed` です。ほかに `date`、`source`（この入口は `admin`。cron は `cron`）、`dry_run`、`scheduled_time`（この入口は null。cron は発火時刻）、`listed_by`（1 回で取り切れたときは `day`、開催場に分けたときは `venue`）、`races` が入ります。`races` の 1 件は `race_key`、`race_id`、`venue`、`race_number`、`action`、`reason`、`run_id` です。`action` は `enqueued`、`would_enqueue`、`skipped`、`failed` です。飛ばす理由も失敗理由も無いときは `reason` は null です。積んだときだけ `run_id` が入ります。`dry_run` でないときだけ、同じ内容を KV `batch:v1:{date}` に 1 件書き、14 日で消します。書き込みに失敗しても応答は返し、ログ `batch_summary_failed` に理由を残します。プロンプト本文は入れません。

0 件の日は 200 で件数 0 です。`get_races` を開催場に分けてもまだ打ち切れているときは 400 で、その日は積みません。進め方は [pipeline.md](pipeline.md) です。

## ジョブ

```bash
curl -sS "https://<worker>/admin/jobs?race_key=20261107-03-11" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

`race_key` が無いときは 400、ジョブが無いときは 404 です。応答には `race_key`、`run_id`、`phase`、`error`、`retry`、`attempt`、`max_attempts`、`last_error`、`requested_by`、`notion_page_id`、`course_variant`、`gemini`、`odds` と、コースデータ要約の欄が入ります。`phase` が `error` のとき `error` に理由が入ります。refresh の失敗もここに出ます。再試行を待っているときは `phase` はその段階のままで、`retry` が `retrying attempt 2/3` のようになります。`attempt` と `max_attempts` はその数字、`last_error` は直前の失敗理由です。再試行中でなければこの 4 つは null です。`error` は最終失敗まで null です。`course_variant` は常に null です。回りは `get_races` の `course_side` をレース情報と集計に使い、Notion のフッターはこのフィールドのままにします。理由は [course-odds.md](course-odds.md) です。プロンプト本文、コース分析の本文、予想本文、検索の引用は返しません。

コースデータ要約は、予想の前に計算したものです。プロンプトの本文は返しません。

| フィールド | 内容 |
| --- | --- |
| `course_summary` | 要約の本文。未計算、または失敗のときは null |
| `course_summary_error` | 失敗した理由。成功のときは null |
| `course_summary_period` | `{ from, to }`。期間が決まる前に失敗したときは null |
| `course_summary_race_count` | 確定済みレース数。打ち切れたときは返った件数（下限）。未計算は null |
| `course_summary_race_count_truncated` | レース一覧が上限で切れたとき true |

`gemini.course` と `gemini.race` は、その呼び出しがまだ無いとき null です。あるときは次です。名前は Gemini の応答と同じです。

| フィールド | 内容 |
| --- | --- |
| `finishReason` | 候補の `finishReason`。文字列で無いときは null |
| `modelVersion` | 応答の `modelVersion`。無いときは null |
| `usageMetadata.promptTokenCount` | 入力トークン数。無いときは null |
| `usageMetadata.candidatesTokenCount` | 出力トークン数。無いときは null |
| `usageMetadata.thoughtsTokenCount` | 思考トークン数。無いときは null |
| `usageMetadata.totalTokenCount` | 合計トークン数。無いときは null |

コース分析だけ、次も返します。レース予想のオブジェクトには入れません。

| フィールド | 内容 |
| --- | --- |
| `webSearchQueryCount` | `groundingMetadata.webSearchQueries` の文字列の件数 |
| `webSearchQueries` | そのクエリ文字列。文字列以外は捨てる |

引用（`groundingChunks` など）はジョブにもこの応答にも入れません。呼び出しの形は [prompts.md](prompts.md) です。

`odds` があるときは `available`、`kind`、`observed_at_jst`、`reason` です。

`ticket_count_corrections` は、買い目の点数を差し替えた記録です。差し替えが無いときは空配列です。1 件は `tickets`（券種）、`declared`（見出しの点数）、`counted`（列から数えた点数）です。見方は [pipeline.md](pipeline.md) です。

`race_input_gaps` は、レース予想の入力で空欄にした項目です。予想の前は null です。予想まで進むと配列になります。仮柵は項目が無いので毎回入ります。内外回りは、`course_side` がスキーマに無い、値が空、値が読めない、`get_stats` で絞れない、ときだけ入ります。値があるときは入りません。見方は [prompts.md](prompts.md) です。

## 予想に渡した入力

```bash
curl -sS "https://<worker>/admin/jobs/input?race_key=20261108-05-11" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

`/admin/jobs` と同じく、ジョブが無いときは 404 です。常に返すのは次です。

| フィールド | 内容 |
| --- | --- |
| `race_key` / `run_id` / `phase` | ジョブの識別 |
| `checked` | 整合性チェックを実行済みか。予想の前は false |
| `stored` | 馬柱とユーザー文を KV に書けたか |
| `truncated` | 馬柱、ユーザー文、近10走、コース成績、出走馬のコース成績のいずれかを 50 万文字で切ったか |
| `incomplete` | 分割した片方が KV から読めなかったか |
| `umabashira_bytes` / `race_input_bytes` | UTF-8 のバイト数。未保存なら null |
| `warnings` | 整合性チェックの警告。Notion には書かない |
| `horses` | 馬ごとの解決結果 |

`warnings` の 1 件は `horse_name`、`kind`（`finish` または `weight`）、`message`、`race_name`、`claimed`、`actual`、`snippet` です。見方は [consistency.md](consistency.md) です。

`horses` の 1 件は、馬名、馬番、解決後の名前、`resolution_status`、近走数、生年月日、通算出走数、前走着順、前走距離、前走馬場、間隔、今回斤量、近走の配列です。状態の意味は [same-name-horses.md](same-name-horses.md) です。近走の 1 件はレース名、日付、公式着順、馬場、距離です。

クエリを付けないときは `umabashira`（馬柱そのもの）と `race_input`（レース予想に渡したユーザー文）も返します。`include=umabashira` は馬柱だけ、`include=input` はユーザー文だけです。カンマで両方を指定できます。知らない名前は無視し、その本文は返しません。`horses` と `warnings` は `include` に関係なく返します。`horses` の `past_runs` は、これまでどおり短い成績の配列です。

`include=past_runs` は、一次予想に渡した近10走、コース成績、出走馬のコース成績の Markdown だけを足します。プロンプト文、馬柱、ユーザー文の残りは返しません。`include` に `umabashira` や `input` が無いときは、その本文の欄自体を付けません。クエリを付けないときの応答には、これらの欄を足しません。

```bash
curl -sS "https://<worker>/admin/jobs/input?race_key=20261108-05-11&include=past_runs" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

このとき足す欄は次です。BASHIRA も Gemini も呼びません。保存済みの `input:v1:{raceKey}` だけを読みます。

| フィールド | 内容 |
| --- | --- |
| `input_run_id` | その入力を書いた実行の `run_id`。今のジョブの `run_id` と違うときは、再実行の途中で、まだ入力を書き換えていない |
| `saved_at` | 入力を書いた時刻。ISO 8601。この欄を足す前の保存は null |
| `past_runs` | `{{past_runs}}` に渡した Markdown。取れなければ null |
| `past_runs_missing` | 返した `past_runs` の空欄の説明。本文が null のときは null。本文は数えるだけで、セルは変えない |
| `course_records` | `{{course_records}}` に渡した Markdown。取れなければ null |
| `runner_stats` | `{{runner_stats}}` に渡した Markdown。取れなければ null |
| `related_courses` | コース分析の末尾から読んで、コース成績に使った一覧。取れなければ null |
| `past_runs_source` / `course_records_source` / `runner_stats_source` / `related_courses_source` | `stored` は保存時の別フィールド。`extracted` は古いユーザー文から切り出した。無いときは null |
| `past_runs_error` / `course_records_error` / `runner_stats_error` / `related_courses_error` | その本文や一覧を返せない理由。本文を返せたときは null。一覧だけ読めないときは `related_courses_error` に理由を残し、`courses` は null |

`related_courses` は `status`、`courses`、`dropped`、`line` です。`courses` の 1 件は `track`、`surface`、`distance` です。`status` が `ok` のとき `courses` は数えた一覧で、空配列は「関連コース: なし」です。一覧が無い、閉じていない、読めないときは `courses` を null にします。空欄を `(0,0,0,0,0,0)` にはしません。`line` はコース成績に書いた「関連コース:」の行で、原文のままです。`dropped` は、5 件を超えて捨てた行数です。古い入力から行だけ読んだときは null です。

表の列、セル、空欄は保存された原文のままです。空欄を 0 や 0 件に置き換えません。`(0,0,0,0,0,0)` が原文にあるときは、関連コースが無くて実際に数えた 0 なので、そのまま返します。`past_runs_missing` も本文を書き換えません。保存済みの近10走を、取り直したりセルを補完したりはしません。

`past_runs_missing` は `rows`、`blank`、`note` です。`rows` は表のデータ行数で、見出しと区切り行は入れません。表が読めない文字列は 0 です。`blank` は、返した表にある列ごとの空欄件数です。今の表は 28 列で、末尾が `条件` です。それより前の 27 列の順番と意味は変えていません。条件列が無い古い表は、その 27 列だけを数えます。`0` はその列に空欄が無いことです。セルの `0` は空欄に数えません。`note` は、空欄が値なしであり、0 や未出走ではないことと、レース名の空欄は特別競走ではないことを書きます。`条件` は、特別競走かどうかに関係なく、競走種別とクラスを並べた値です。どちらかが無い走だけ空欄で、その件数が `blank` の `条件` です。前半3Fと後半3Fの空欄は、そのレースの秒が表に無いときです。

ダミーの応答です。馬名も数字も例です。単勝と前半3F・後半3Fの空欄は、値が無いセルを 0 にしていません。`blank` の数字も例です。

```json
{
  "race_key": "20261108-05-11",
  "run_id": "run-current",
  "input_run_id": "run-saved",
  "saved_at": "2026-11-08T06:00:00.000Z",
  "past_runs": "# 過去走（近10走）\n…\n\n### 1 ア\n| 日付 | … | 人気 | 単勝 | 前半3F | 後半3F | 条件 |\n| --- | … | --- | --- | --- | --- | --- |\n| 2026-10-12 | … |  |  |  |  | 3歳以上オープン |",
  "past_runs_missing": {
    "rows": 1,
    "blank": {
      "日付": 0,
      "競馬場": 0,
      "レース名": 1,
      "グレード": 0,
      "クラス": 0,
      "馬場": 0,
      "距離": 0,
      "コース": 0,
      "馬場状態": 0,
      "頭数": 0,
      "着順": 0,
      "タイム": 0,
      "着差": 0,
      "上り3F": 0,
      "上り順位": 0,
      "通過": 0,
      "騎手": 0,
      "乗替": 0,
      "斤量": 0,
      "馬体重": 0,
      "増減": 0,
      "馬番": 0,
      "間隔": 0,
      "人気": 1,
      "単勝": 1,
      "前半3F": 1,
      "後半3F": 1,
      "条件": 0
    },
    "note": "空欄は値なしであり、0や未出走ではない。0と書いてあるセルだけがゼロである。レース名の空欄は特別競走ではないことを表す。"
  },
  "course_records": "# コース成績\n…\n関連コース: 東京,芝,2400\n\n### 1 ア\n同じコース: (1,0,0,0,0,0)\n同じ競馬場: (1,0,0,0,0,0)\n関連コース: (0,0,0,0,0,1)",
  "runner_stats": "# 出走馬のコース成績\n条件: 東京 芝 2500m\n期間: 2021-11-07〜2026-11-07（レース日の前日までの過去5年）\nscope: jra_and_non_jra。条件の競馬場名は中央の開催場で、地方の同名場は別の名前なので、この件数は中央のそのコースの走。\n率は出走数と勝ち数・3着以内の件数から計算した。\n\n### 1 ア\n父 父一: 出走 48　勝ち 8　勝率 16.7%　複勝 20　複勝率 41.7%\n母父 母父一: 名前が見つからない\n騎手 騎手A: 出走 4　勝ち 1　勝率 25.0%　複勝 2　複勝率 50.0% 件数が少ないため参考値",
  "related_courses": {
    "status": "ok",
    "courses": [{ "track": "東京", "surface": "芝", "distance": 2400 }],
    "dropped": 0,
    "line": "関連コース: 東京,芝,2400"
  },
  "past_runs_source": "stored",
  "course_records_source": "stored",
  "runner_stats_source": "stored",
  "related_courses_source": "stored",
  "past_runs_error": null,
  "course_records_error": null,
  "runner_stats_error": null,
  "related_courses_error": null
}
```

一覧が読めない保存では、`related_courses.status` は `ok` 以外、`courses` は null、`related_courses_error` に理由が入ります。各馬の `関連コース:` は括弧の無い空欄のままです。

この変更以降の保存は、メタに `pastRuns`、`courseRecords`、`runnerStats`、`relatedCourses`、`savedAt` を別フィールドで書きます。プロンプト文は入れません。応答はその文字列をそのまま返します。それより前のジョブは別フィールドが無いので、保存済みの `raceInput` から `# 過去走（近10走）`、`# コース成績`、`# 出走馬のコース成績` だけを切り出します。切り出すのは、見出しの次の説明と、馬ごとの行が保存形式と一致する範囲だけです。見出しが無い、形が一致しない、ユーザー文の分割が欠けているときは null と理由を返し、前後の文は返しません。関連コースは、コース成績の `関連コース:` 行から読みます。ユーザー文のほかの場所に区切りが残っていても、その生テキストは返しません。`runnerStats` が無い保存で、ユーザー文にもその見出しが無いときは、`runner_stats` は null で、理由だけ返します。

本文は KV `input:v1:{raceKey}` にあります。馬柱、ユーザー文、近10走、コース成績、出走馬のコース成績を JSON にした長さが 10 万文字を超えるときは、10 万文字ごとに `input:v1:{raceKey}:u:{n}`、`input:v1:{raceKey}:r:{n}`、`input:v1:{raceKey}:p:{n}`、`input:v1:{raceKey}:c:{n}`、`input:v1:{raceKey}:s:{n}` へ分けます。値の上限 25MiB より手前で、それぞれ 50 万文字を超える分は切り、末尾に切り詰めた旨を付けます。切ったときは `truncated` が true です。近10走、コース成績、出走馬のコース成績の分割が欠けているときは、その本文は null とし、欠けたユーザー文から切り出しません。

## モデル

既定は両方 `gemini-flash-latest` です。ジョブごとに KV `config:models` を読み、無ければコードの既定（`DEFAULT_MODEL`）を使います。`models/gemini-flash-latest` と `gemini-flash-latest` は同じ名前として扱います。先頭の `models/` を除きます。

`GET /admin/models` は `generateContent` できるモデル一覧と現在値、直前の値を返します。一覧は Gemini の `models.list` を最大 5 ページ取り、KV `cache:v2:gemini-models` に 10 分キャッシュします。

```bash
curl -sS "https://<worker>/admin/models" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

応答の形:

```json
{
  "note": "course はコース分析、race はレース予想に使う Gemini モデルです。",
  "current": { "course": "gemini-flash-latest", "race": "gemini-flash-latest" },
  "source": "default",
  "previous": null,
  "history_count": 0,
  "models": [{ "name": "gemini-flash-latest", "displayName": "Gemini Flash", "methods": ["generateContent"] }]
}
```

`source` は KV にあれば `kv`、無ければ `default` です。履歴は最大 100 件で、`history_count` はその件数です。応答に履歴の中身は入れません。

`PUT /admin/models` は一覧にある名前だけを受け入れます。`course` と `race` の少なくとも一方が必要です。変更前、変更後、呼び出し元、Client ID、日本時間を `config:models:history` に残し、直前の値を `config:models:previous` に残します。一覧に無い名前は 400 で、KV は変わりません。

Muse がレース段階だけ変える例:

```bash
curl -sS -X PUT "https://<worker>/admin/models" \
  -H "CF-Access-Client-Id: $MUSE_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $MUSE_ACCESS_CLIENT_SECRET" \
  -H "content-type: application/json" \
  -d '{"race":"gemini-flash-latest"}'
```

応答の形:

```json
{
  "note": "モデルを更新しました。履歴には変更前、変更後、呼び出し元、日本時間を残しています。",
  "current": { "course": "gemini-flash-latest", "race": "gemini-flash-latest" },
  "previous": { "course": "gemini-flash-latest", "race": "gemini-flash-latest" },
  "caller": "Muse"
}
```

戻す:

```bash
curl -sS -X POST "https://<worker>/admin/models/restore" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

直前の設定が無いときは 400 です。戻す操作も履歴に残り、`restored` が付きます。戻すときはモデル一覧との再照合はしません。応答の `note` は「直前のモデル設定に戻しました。」です。

## レースの確認

`GET /admin/inspect` は、保存済みのジョブから、馬柱と LLM の入出力をまとめて返します。Gemini と BASHIRA は呼びません。システムプロンプト、トークン、API キーは返しません。

```bash
curl -sS "https://<worker>/admin/inspect?race_key=20261108-05-11" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

`race_key` の代わりに `raceKey` も受け付けます。`format` を付けないときは JSON です。人が読むときは `format=markdown` です。知らない `format` は 400 です。エラー応答は `format` に関係なく JSON です。

```bash
curl -sS "https://<worker>/admin/inspect?race_key=20261108-05-11&format=markdown" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

`race_key` が無く、`date` も無いときは 400 です。ジョブが無いときは 404 です。`date` は `YYYY-MM-DD` または `YYYYMMDD` です。`race_key` と `date` を同時に付けたときは、そのレースだけを返します。

その日のジョブ一覧です。`phase`、`error`、`run_id`、`requested_by`、予想の有無だけを返します。本文は返しません。KV の list はすぐには揃わないことがあります。

```bash
curl -sS "https://<worker>/admin/inspect?date=2026-11-08" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

レース 1 件の JSON は次です。呼び出し結果の名前は `GET /admin/jobs` の `gemini` と同じです。

| フィールド | 内容 |
| --- | --- |
| `race` | 日付、競馬場、場コード、レース番号、レース名、グレード、馬場種類、距離、天気、馬場状態 |
| `phase` / `error` | ジョブの段階と失敗理由 |
| `going` | 予想に使った天気、馬場状態、馬場 API にしか無い詳細 |
| `baba` / `race_row` / `remarks` / `odds` | 保存されている入力。秘密情報のキーは落とす |
| `umabashira` | LLM に渡した馬柱。未保存なら null |
| `course.user_text` / `course.prompt_version` | コース分析のユーザー文とプロンプト版 |
| `course.output_text` | コース分析の全文。Notion で切り詰める前 |
| `race_prediction.user_text` / `race_prediction.prompt_version` | レース予想のユーザー文とプロンプト版。ユーザー文にはレース情報、近10走、コース成績、出走馬のコース成績（父・母の父・騎手）が入る。`{{win_odds}}` はプロンプトに書いてあるときだけ |
| `race_input_gaps` | その入力で空欄にした項目。予想の前は null |
| `race_level` | 過去最高レースレベルの記録。`input:v1:{raceKey}` に無いときは `trace:v1:{raceKey}`。どちらにも無い古いジョブは null。`applied`、`reason`、`asof`、`dataThrough`、`featSha256`、`horses`、`missing`。マーカーが無いプロンプトは `reason` が `prompt_without_c1` で、馬柱にもユーザー文にも節は無い |
| `race_prediction.output_text` | レース予想のモデル出力全文 |
| `race_prediction.予想本文` | 保存した予想本文。見出しから読んだあとの本文 |
| `finishReason` / `modelVersion` / `usageMetadata` | 呼び出しごと |
| `webSearchQueries` | コース分析はジョブの記録。レース予想は `trace:v1:{raceKey}` に残したクエリ。未記録は null |
| `course_summary` / `course_summary_error` | ジョブに `courseSummary`（または同名のスネークケース）があるときだけ。無いジョブでは両方 null |
| `warnings` | 整合性チェックの警告。Notion には書かない |

`course_summary` は、ジョブ KV にそのフィールドが無い古い実行では null です。エンドポイントは要約の計算をしません。

Markdown は上の項目を見出しで区切り、本文は省略しません。保存が無い項目は「保存されていません」と書きます。

馬柱とレース予想のユーザー文は `input:v1:{raceKey}`、コース分析のユーザー文と両方の出力全文は `trace:v1:{raceKey}` です。どちらも 10 万文字で分割し、1 項目 50 万文字で切ります。切ったときは `truncated` が true です。分割の一部が読めないときは `incomplete` が true です。この変更より前のジョブは、コース分析のユーザー文が無いことがあります。出力は、予想まで終わっていれば `prediction` に残っている全文を返します。

馬ごとの解決結果は [このファイルの予想入力](#予想に渡した入力) の `GET /admin/jobs/input` です。コース集計のキャッシュは返しません。
