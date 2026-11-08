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
