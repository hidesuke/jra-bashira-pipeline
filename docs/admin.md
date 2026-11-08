# 管理用エンドポイント

どれも Access の JWT が必要です。呼び出し元の見分けは [access.md](access.md) です。例の Client Secret はシェル変数に置き、リポジトリには書きません。

## ジョブ

```bash
curl -sS "https://<worker>/admin/jobs?race_key=20261107-03-11" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

`race_key` が無いときは 400、ジョブが無いときは 404 です。応答には `race_key`、`run_id`、`phase`、`error`、`requested_by`、`notion_page_id`、`course_variant`、`gemini`、`odds` と、コースデータ要約の欄が入ります。`phase` が `error` のとき `error` に理由が入ります。refresh の失敗もここに出ます。`course_variant` は常に null です。理由は [course-odds.md](course-odds.md) です。プロンプト本文、コース分析の本文、予想本文、検索の引用は返しません。

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

`race_input_gaps` は、レース予想の入力で空欄にした項目です。予想の前は null です。予想まで進むと配列になり、内外回りと仮柵は項目が無いので毎回入ります。ほかに空欄が無ければこの 2 件だけです。見方は [prompts.md](prompts.md) です。

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
| `truncated` | 馬柱かユーザー文を 50 万文字で切ったか |
| `incomplete` | 分割した片方が KV から読めなかったか |
| `umabashira_bytes` / `race_input_bytes` | UTF-8 のバイト数。未保存なら null |
| `warnings` | 整合性チェックの警告。Notion には書かない |
| `horses` | 馬ごとの解決結果 |

`warnings` の 1 件は `horse_name`、`kind`（`finish` または `weight`）、`message`、`race_name`、`claimed`、`actual`、`snippet` です。見方は [consistency.md](consistency.md) です。

`horses` の 1 件は、馬名、馬番、解決後の名前、`resolution_status`、近走数、生年月日、通算出走数、前走着順、前走距離、前走馬場、間隔、今回斤量、近走の配列です。状態の意味は [same-name-horses.md](same-name-horses.md) です。近走の 1 件はレース名、日付、公式着順、馬場、距離です。

クエリを付けないときは `umabashira`（馬柱そのもの）と `race_input`（レース予想に渡したユーザー文）も返します。`include=umabashira` は馬柱だけ、`include=input` はユーザー文だけです。カンマで両方を指定できます。知らない名前は無視し、その本文は返しません。`horses` と `warnings` は `include` に関係なく返します。

本文は KV `input:v1:{raceKey}` にあります。馬柱とユーザー文を JSON にした長さが 10 万文字を超えるときは、10 万文字ごとに `input:v1:{raceKey}:u:{n}` と `input:v1:{raceKey}:r:{n}` へ分けます。値の上限 25MiB より手前で、それぞれ 50 万文字を超える分は切り、末尾に切り詰めた旨を付けます。切ったときは `truncated` が true です。

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
| `race_prediction.user_text` / `race_prediction.prompt_version` | レース予想のユーザー文とプロンプト版。ユーザー文にはレース情報、近10走、コース成績が入る。`{{win_odds}}` はプロンプトに書いてあるときだけ |
| `race_input_gaps` | その入力で空欄にした項目。予想の前は null |
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
