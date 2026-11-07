# JRA BASHIRA 一次予想 Worker

1 レースずつ BASHIRA から出走・成績・オッズを取り、Gemini でコース分析と一次予想を作り、既存の Notion データベース「場立ちのhidesuke JRA予想」に **別ページ** として書く Cloudflare Worker です。リソース（KV、Queue、Durable Object）は最初の `wrangler deploy` が作ります。シークレットの値はこのリポジトリに置きません。

開発モードは手動の 1 レースだけです。cron の時刻は未定なので、定義はコメントアウトしたままです。

## 処理の流れ

1. `POST /run` がレースを 1 件だけ Queue `jra-bashira-race` に積む。
2. Consumer が 1 メッセージずつ処理する。`get_stats` は 8 件ずつ別メッセージに分ける。
3. コース分析のあとレース予想を行い、Notion に書く。
4. 同じレースの再実行は、KV に覚えたページを更新する。BASHIRA のページが複数あって判断できないときはエラーで止まる。

Free プランの外部 `fetch` は 1 呼び出し 50 件までです。Worker 側は 45 件で止め、Durable Object 側の MCP 呼び出しは 40 件で止めます。KV・Queue・Durable Object への内部呼び出しは、この 50 件には入れません（Free では外部 50、内部 1000）。

## Workers Builds

Git 接続の Cloudflare Workers Builds は、リポジトリ直下をルートにします。Wrangler は `package.json` の `^4.50.0`、lock では 4.158.0 です。KV / Queue の自動作成は [4.45.0 以降](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) です。

| 設定 | 値 |
| --- | --- |
| Worker 名 | `jra-bashira-pipeline`（`wrangler.jsonc` の `name`。Workers Builds の名前と揃える） |
| ルートディレクトリ | `/`（リポジトリ直下） |
| ビルドコマンド | `npm ci` |
| デプロイコマンド | `npx wrangler deploy` |

`npm ci` は lock と `package.json` が一致している必要があります。依存の範囲は `package.json` のままです（TypeScript 5.9、Vitest 3.2、`@types/node` 24）。

最初の `npx wrangler deploy` が次を作ります。id は設定に書きません。Git からの deploy では、作られた id はダッシュボードに残り、リポジトリには書き戻されません。

- KV `APP_KV`（binding のみ。id なし）
- Queue `jra-bashira-race`（producer / consumer の名前。id フィールドは無い）
- Durable Object `BashiraAuth`（`migrations` の `new_sqlite_classes`。SQLite）

ローカルで同じことをするときは `npx wrangler login` のあと `npx wrangler deploy` です。この作業ではデプロイしません。

## シークレット

次は **手動の Secret** です。値をリポジトリ、コマンド引数、ログに書かないでください。`openssl rand -base64 32` で作った鍵を `TOKEN_ENCRYPTION_KEY` にします。`ACCESS_AUD` は Access アプリケーションの AUD タグで、ダッシュボードの Secret に置きます。`vars` には書きません。

- `GEMINI_API_KEY`
- `NOTION_TOKEN`
- `TOKEN_ENCRYPTION_KEY`
- `ACCESS_AUD`

Worker がまだ無い状態では `wrangler secret put` もダッシュボードもシークレットを先に置けないため、`secrets.required` は設定していません。最初の deploy が Worker を作ったあと、ダッシュボードの Settings → Variables and Secrets か、次で入れます。

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ACCESS_AUD
```

`secret put` はそれ自体がデプロイになります。レースを動かす前に入れてください。入っていないと実行時に失敗します。`ACCESS_AUD` はダッシュボードで設定済みなら、その値を上書きしないでください。

ローカルの `wrangler dev` では同じ名前を `.dev.vars` に書きます。`.dev.vars.example` をコピーしてください。`.dev.vars` はコミットしません。

`vars` で置き換えるもの:

| 変数 | 内容 |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | `https://hdsk.cloudflareaccess.com`（`wrangler.jsonc` に設定済み） |
| `ACCESS_CLIENT_ID_GROK` | Grok Bot の Access サービストークンの Client ID |
| `ACCESS_CLIENT_ID_MUSE` | Muse の Client ID |

Client Secret は Worker に置きません。Access が検証し、Worker は `Cf-Access-Jwt-Assertion` だけを見ます。

型生成と確認:

```bash
npm run types
npm run check
```

## Cloudflare Access

`/run` と `/admin/*` と `/oauth/start` と `/oauth/status` は Access の JWT が必要です。`/health` と `/oauth/callback` は公開です。callback は `state` と PKCE で紐づけます。

Access アプリケーションを Worker の URL に置き、ポリシーに Grok Bot と Muse のサービストークンを入れます。アプリケーションの AUD は Secret `ACCESS_AUD` です。設定ファイルには書きません。

Worker は次を検証します。

- ヘッダ `Cf-Access-Jwt-Assertion` がある
- 署名が `https://hdsk.cloudflareaccess.com/cdn-cgi/access/certs` の公開鍵と一致する
- `iss` が `https://hdsk.cloudflareaccess.com` である
- `aud` が Secret の `ACCESS_AUD` と一致する
- 有効期限が切れていない

呼び出し元の記録は、`CF-Access-Client-Id` が `ACCESS_CLIENT_ID_GROK` / `ACCESS_CLIENT_ID_MUSE` と一致すれば「Grok Bot」「Muse」です。一致しなければ JWT の `common_name`（名前に grok / muse を含む場合も同じラベル）か email を使います。Client Secret は読みません。

呼び出し側は、Access の前にサービストークンを付けます。Access が通したリクエストには JWT が付きます。Worker のオリジンへ JWT 無しで直接叩くと 403 です。

## BASHIRA の初回認可

認可は Durable Object `BashiraAuth`（名前 `bashira`）が一つ持ちます。資格情報はレース横断で一つだからです。トークンと PKCE の verifier は `TOKEN_ENCRYPTION_KEY` で AES-GCM 暗号化して保存します。

OAuth は認可コードと PKCE S256 だけです。`client_credentials` は使いません。クライアントは `/register` で動的登録し、`token_endpoint_auth_method=none` です。エンドポイントは protected resource metadata と authorization server metadata から取ります。確認済みの発行元は `https://mcp.bashira.omninode.co.jp/` です。

1. Access を通したブラウザで `GET /oauth/start` を開く。
2. BASHIRA の認可画面で許可する。
3. 公開の `GET /oauth/callback` が code をトークンに換える。`state` が不一致、または 10 分超過なら失敗する。
4. `GET /oauth/status` で `authorized: true` を確認する。トークン自体は返しません。

refresh の寿命とローテーションは未公開です。`expires_in` が無いときは 5 分で期限切れとして扱います。応答に新しい `refresh_token` があるときだけ差し替え、無いときは今の refresh token を残します。保存は応答を受け取ったあとです。refresh が失敗したら予想は止め、`invalid_grant` のときは再認可が必要だと KV のジョブと `/admin/jobs` に残します。通信失敗でもそのジョブは止めます。

MCP の引数は実行時の `tools/list` で確認します。スキーマに無い引数やフィールドは送りません。`2025-06-18` で initialize し、失敗したら `2025-03-26` を試します。

## プロンプトを KV に入れる

プロンプト本文はこのリポジトリに置きません。版番号付きで KV に入れます。

| キー | 値 |
| --- | --- |
| `prompt:v2:course` | `{"version":"3","text":"..."}` |
| `prompt:v2:race` | `{"version":"4","text":"..."}` |

```bash
node scripts/put-prompts.mjs --stage course --version 3 --file /path/to/course.md --namespace-id <kv-id> --remote
node scripts/put-prompts.mjs --stage race --version 4 --file /path/to/race.md --namespace-id <kv-id> --remote
```

KV の id は設定に無いので、ダッシュボードの namespace id を `--namespace-id` で渡します。Worker はプロンプトの後ろに `# 入力データ` と JSON を足します。レース段階は次のキーを持つ JSON を要求します。`指数分布`、`自信度`、`波乱度`、`印`、`予想本文`。

## モデル

既定は両方 `gemini-flash-latest` です。ジョブごとに KV `config:models` を読み、無ければコードの既定を使います。

`GET /admin/models` は `generateContent` できるモデル一覧（KV に 10 分キャッシュ）と現在値、直前の値を返します。`PUT /admin/models` は一覧にある名前だけを受け入れ、変更前・変更後・呼び出し元・日本時間を `config:models:history` に残します。`POST /admin/models/restore` は直前の設定に戻し、その操作も履歴に残します。

Grok Bot の例（Client Secret はシェル変数に置く）:

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

`models/gemini-flash-latest` と `gemini-flash-latest` は同じ名前として扱います。一覧に無い名前は 400 で、KV は変わりません。

## 1 レース実行

`race_id` は BASHIRA の `YYYYMMDD-場コード-レース番号` です。場コードは 01 札幌、02 函館、03 福島、04 新潟、05 東京、06 中山、07 中京、08 京都、09 阪神、10 小倉です。

```bash
curl -sS -X POST "https://<worker>/run" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET" \
  -H "content-type: application/json" \
  -d '{"race_id":"20261107-03-11"}'
```

日付と場名でも同じです。両方書いたときは一致している必要があります。配列で複数レースは受け付けません。

```bash
curl -sS -X POST "https://<worker>/run" \
  -H "CF-Access-Client-Id: $MUSE_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $MUSE_ACCESS_CLIENT_SECRET" \
  -H "content-type: application/json" \
  -d '{"date":"2026-11-07","venue":"福島","race_number":11}'
```

受理されると 202 で `race_key` と `run_id` と `requested_by` が返ります。同じレースが処理中なら 409 です。

進捗と失敗理由:

```bash
curl -sS "https://<worker>/admin/jobs?race_key=20261107-03-11" \
  -H "CF-Access-Client-Id: $GROK_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GROK_ACCESS_CLIENT_SECRET"
```

`phase` が `error` のとき `error` に理由が入ります。refresh 失敗はここに出ます。

## Notion

データベース id は `3c57c7b2e419808ba999e9c1909fa39c` です。スキーマは変更しません。実行時にプロパティ型を読み、想定と違うときは書かずに止まります。セレクトに無い競馬場・レース番号も、新しい選択肢を作らずに止まります。

2026-11-07 に読んだスキーマ:

| プロパティ | 型 | この Worker が書く値 |
| --- | --- | --- |
| 名前 | title | `【BASHIRA】` + レース名。レース名が無いときは場とレース番号 |
| 日付 | date | 開催日 |
| 競馬場 | select | 開催場（既存の 10 場） |
| レース | select | レース番号の文字列 `1`〜`12` |
| 指数分布 | rich_text | 予想 JSON の `指数分布` |
| 自信度 | rich_text | 予想 JSON の `自信度` |
| 波乱度 | rich_text | 予想 JSON の `波乱度` |

`予想結果` と `馬券結果` と `メモ` と `URL` は書きません。Dify 版と同じ開催日・競馬場・レース番号のページがあっても、本文が `BASHIRAで取得` で始まらないページは更新しません。新規ページを作ります。

ページ id は `notion:page:v1:{raceKey}` に保存し、再実行はそのページを更新します。保存したページの日付・場・レースが違う、または `BASHIRAで取得` で始まるページが複数あるときは、どれかを選ばずにエラーで止まります。

本文の先頭行は `BASHIRAで取得` です。その後に印、予想本文、オッズ種別、オッズ観測時刻（JST）、指定モデル、応答の `modelVersion`、プロンプト版、実行者、`course_variant: null` を書きます。

## コース成績とオッズ

`get_stats` の条件は開催場・馬場（芝 / ダート / 障害）・距離・開催年です。期間の既定はレース年を含む過去 5 年（`STATS_PERIOD_YEARS`）です。`min_starts` の既定は 30、母父だけ 50 です。

取るもの:

- 枠番（1 回、`bracket_number` で分ける）
- 4 コーナー順位を 4 回に分ける。1〜3、4〜6、7〜10、11 以降
- そのレースの父（まとめて 1 回）
- そのレースの母父（`min_starts` 50）
- 騎手は 1 人ずつ 1 回。取消・除外の馬の騎手は除く
- 馬場状態

人気（`win_odds_rank`）では集計しません。内・外はデータが無いので `course_variant` は常に null です。`rail_type` や馬場 API の使用コース文言は参考としてプロンプトに渡しますが、内・外には読み替えません。

成績は `stats:v2:` で KV に 7 日キャッシュします。

馬場は `GET https://jra-dify-pipeline.hdsk.workers.dev/baba/latest` をジョブの最初に 1 回だけ取り、そのジョブに渡します。失敗しても予想は続け、理由を残します。

オッズは `get_odds` の単勝です。種別（`odds_kind`）と観測時刻を日本時間で必ず残します。行が無いときは未発売、`no_bets` のときは発売票数なし、取得に失敗したときは取得エラーと書きます。取得に失敗しても出馬表に単勝があればそれを使い、その旨を残します。オッズが無くても予想は続けます。

## cron

`wrangler.jsonc` の `triggers` はコメントアウトしています。有効にしても `scheduled` は理由をログして戻り、レースは積みません。時刻を決めたあとに、積む処理を別途足してください。

## テスト

```bash
npm test
npm run typecheck
```

BASHIRA・Gemini・Notion はモックです。実 API へのデプロイや書き込みはしていません。

## この環境で確認できたことと、できていないこと

確認できたこと:

- BASHIRA の認可サーバ metadata（authorization / token / register、PKCE S256、refresh_token、`none`）
- protected resource metadata（`/.well-known/oauth-protected-resource/mcp`）
- `POST /register` が公開クライアントを 201 で返すこと
- 未認証の MCP が 401 と `resource_metadata` を返すこと
- 接続済み BASHIRA ツールの引数スキーマ（`get_races` / `get_entries` / `get_odds` / `get_stats`）。実行時も `tools/list` で同じ確認をします
- 馬場 API の JSON（`fetchedAt` と `venues[]`）
- Notion データベースのプロパティ型と選択肢

確認できていないこと:

- ブラウザでの認可コード交換、refresh の実寿命、refresh token のローテーション有無
- Worker からの `tools/list` と `tools/call` の実レスポンス。`columns` / `rows` が配列のときとオブジェクトのときの両方を読む
- `name_resolution` の実 JSON。候補配列が複数で未解決のときだけ曖昧として止める
- Gemini の `models.list` と `generateContent` の実応答。`modelVersion` が無いときはその旨を本文に書く
- Notion への作成・更新
- Cloudflare 上での Queue、Durable Object、Access JWT、50 サブリクエスト上限
