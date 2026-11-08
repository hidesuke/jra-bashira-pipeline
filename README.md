# JRA BASHIRA 一次予想 Worker

1 レースずつ BASHIRA から出走・成績・オッズを取り、Gemini でコース分析と一次予想を作り、既存の Notion データベース「場立ちのhidesuke JRA予想」に別ページとして書く Cloudflare Worker です。

手動の `POST /run` は 1 レースだけです。金曜と土曜の 16:45（日本時間）に、cron が翌日の全レースを同じ経路で Queue に積みます。予想そのものは Queue が 3 件ずつ進めます。

シークレットの値、プロンプトの本文、Access の Client Secret は、このリポジトリに置きません。

## 全体の構成

このリポジトリは公開の Cloudflare Worker です。予想に使う文章そのものは、別の非公開リポジトリで管理します。

| 役割 | 場所 |
| --- | --- |
| 実行 | このリポジトリの Worker `jra-bashira-pipeline` |
| 入力 | BASHIRA の MCP。`get_races`、`get_entries`、`get_odds`、`get_stats` |
| 文章生成 | Gemini。先にコース分析を作り、その本文を入れてレース予想を作る。コース分析だけ Google 検索を付ける。両方の思考レベルは `high` |
| 出力 | Notion データベース `3c57c7b2e419808ba999e9c1909fa39c`（「場立ちのhidesuke JRA予想」）。スキーマは変えず、別ページを追加する |
| プロンプト | 非公開リポジトリ `hidesuke/jra-bashira-prompts` にだけ本文を置く。Worker は KV の `prompt:v2:course` と `prompt:v2:race` を読む |

処理の骨格は次のとおりです。

1. Access を通した `POST /run` が、レース 1 件を Queue `jra-bashira-race` に積む。金曜・土曜の cron と `POST /admin/batch` も、同じ関数でレースごとに積む。
2. Consumer がメッセージを 1 件ずつ進める。段階は、出走と馬場の収集、馬ごとの近走、コース集計、Gemini、Notion への書き込みです。
3. 同じレースを再実行するときは、前の BASHIRA ページをアーカイブし、同じ書式で新しいページを作ります。

段階の分割、外部呼び出しの上限、同じレースのロックは [docs/pipeline.md](docs/pipeline.md) に書いてあります。枠・4角・馬場状態のコース集計（`get_stats` のキャッシュ）は、コース分析にもレース予想にも渡しません。コース分析には、別に計算したコースデータ要約を渡します。レース予想には、父・母の父・騎手のこのコースの成績を `{{runner_stats}}` で渡します。差し込み名は [docs/prompts.md](docs/prompts.md)、集計の中身は [docs/course-odds.md](docs/course-odds.md) です。

プロンプト本文を KV へ入れる手順は、このリポジトリにはありません。Worker が読むのは、KV に入っている `{"version","system","user"}` だけです。差し込み名は [docs/prompts.md](docs/prompts.md) です。

## セットアップ

Node.js 22 以上で、リポジトリ直下から依存を入れます。Wrangler は `package.json` の `^4.50.0`、lock では 4.158.0 です。KV と Queue の自動作成は [Wrangler 4.45.0 以降](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) です。

```bash
npm ci
```

ローカルの `wrangler dev` は、シークレットを `.dev.vars` から読みます。`.dev.vars.example` をコピーし、値は自分の環境だけに書いてください。`.dev.vars` はコミットしません。

例ファイルにある名前は `GEMINI_API_KEY`、`NOTION_TOKEN`、`TOKEN_ENCRYPTION_KEY`、`ACCESS_AUD` です。`ACCESS_AUD` の値はプレースホルダーです。保護された経路をローカルで試すときは、Access アプリケーションの AUD タグに置き換えてください。`TOKEN_ENCRYPTION_KEY` は `openssl rand -base64 32` で作ります。通知をローカルで試すときだけ、同じファイルの `NOTIFY_WEBHOOK_URL` と `NOTIFY_WEBHOOK_KEY` に自分の値を書きます。空なら通知しません。

本番のシークレットは、最初のデプロイで Worker ができてから入れます。手順は次の節と [docs/operations.md](docs/operations.md) です。

`wrangler.jsonc` の `vars` には、次が入っています。Client Secret は `vars` にも Worker にも置きません。Access が検証し、Worker は `Cf-Access-Jwt-Assertion` だけを見ます。

| 変数 | 内容 |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | `https://hdsk.cloudflareaccess.com` |
| `ACCESS_CLIENT_ID_GROK` | Grok Bot の Access サービストークンの Client ID。リポジトリ上の値は空で、デプロイ先で置く |
| `ACCESS_CLIENT_ID_MUSE` | Muse の Client ID。リポジトリ上の値は空で、デプロイ先で置く |
| `BASHIRA_MCP_URL` | `https://mcp.bashira.omninode.co.jp/mcp` |
| `BABA_URL` | 馬場 API `https://jra-dify-pipeline.hdsk.workers.dev/baba/latest`。本番はサービスバインディング `BABA` を優先する |
| `NOTION_DATABASE_ID` | 上のデータベース id |
| `DEFAULT_MODEL` | `gemini-flash-latest` |
| `STATS_PERIOD_YEARS` | `5` |
| `STATS_MIN_STARTS` | `30` |
| `STATS_BROODMARE_SIRE_MIN_STARTS` | `50` |
| `COURSE_SUMMARY_MIN_COUNT` | `30`。コースデータ要約で「開催が少ないため参考値」と書く件数の下限 |

型とテスト:

```bash
npm run types
npm test
npm run typecheck
npm run check
```

`npm run check` は型検査とテストの両方です。BASHIRA、Gemini、Notion はテストではモックです。

BASHIRA の初回認可は、デプロイと Access のあと、ブラウザで `GET /oauth/start` を開きます。詳細は [docs/bashira-auth.md](docs/bashira-auth.md) です。

## 本番へのデプロイ

Git 接続の Cloudflare Workers Builds は、リポジトリ直下をルートにします。

| 設定 | 値 |
| --- | --- |
| Worker 名 | `jra-bashira-pipeline`（`wrangler.jsonc` の `name` と揃える） |
| ルートディレクトリ | `/` |
| ビルドコマンド | `npm ci && node scripts/write-build-info.mjs` |
| デプロイコマンド | `npx wrangler deploy` |

`npm ci` は lock と `package.json` が一致している必要があります。依存の範囲は `package.json` のままです（TypeScript 5.9、Vitest 3.2、`@types/node` 24）。

失敗したメッセージの待ち行列 `jra-bashira-race-dlq` は、この deploy では作られません。先に作ります。

```bash
npx wrangler queues create jra-bashira-race-dlq
```

無い状態で deploy すると失敗します。ローカルから同じ deploy をするときは、`npx wrangler login` のあと `npx wrangler deploy` です。

最初の deploy が次を作ります。id は設定に書きません。Git からの deploy では、作られた id はダッシュボードに残り、リポジトリには書き戻されません。

- KV `APP_KV`（binding のみ）
- Queue `jra-bashira-race`（producer / consumer の名前。id フィールドは無い）
- Durable Object `BashiraAuth`（SQLite。`migrations` の `new_sqlite_classes`）
- サービスバインディング `BABA`（`jra-dify-pipeline`）

Worker ができてから、ダッシュボードの Settings → Variables and Secrets か、次でシークレットを入れます。`secret put` はそれ自体がデプロイです。`ACCESS_AUD` が既にあるときは、その値を上書きしないでください。

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ACCESS_AUD
```

入れる名前は `GEMINI_API_KEY`、`NOTION_TOKEN`、`TOKEN_ENCRYPTION_KEY`、`ACCESS_AUD` です。レースを動かす前に 4 つが必要です。入っていないと実行時に失敗します。`secrets.required` は設定していません。Worker がまだ無い状態では、シークレットを先に置けないためです。

レースが最終失敗したときの通知は任意です。`NOTIFY_WEBHOOK_URL` が未設定、または空白のときは何も送りません。URL とキーは Secret です。値はリポジトリ、ログ、コマンド引数に書きません。

```bash
npx wrangler secret put NOTIFY_WEBHOOK_URL
npx wrangler secret put NOTIFY_WEBHOOK_KEY
```

`secret put` はそれ自体がデプロイです。通知が要らないときは、この 2 つを置かないでください。ダッシュボードの Settings → Variables and Secrets から Secret として入れても同じです。

キーを載せるヘッダー名は、平文の変数 `NOTIFY_WEBHOOK_KEY_HEADER` です。未設定なら `Authorization` で、値は `Bearer <NOTIFY_WEBHOOK_KEY>` です。`Authorization` 以外の名前（大文字小文字は区別しません）をセットしたときは、`Bearer` を付けず、キーをそのヘッダーへそのまま入れます。`Content-Type` と `Content-Length` はキーのヘッダーには使わず、本文は JSON のまま送ります。キーが空なら認証ヘッダーは付けません。この変数は `wrangler.jsonc` には入れていません。既定はコード側です。別の名前をデプロイのあとも残すときは、`vars` に `NOTIFY_WEBHOOK_KEY_HEADER` を書いてください。ダッシュボードだけに置いた平文変数は、次の `wrangler deploy` で消えることがあります。

送るのは、再試行を終えてジョブの `phase` を `error` にしたときだけです。本文は JSON で、`type` は `race_failed` です。中身は [docs/pipeline.md](docs/pipeline.md) です。通知の失敗でレースジョブは失敗させず、再試行もしません。

`/health` の `commit` の決まり方と、プルリクエストのプレビューは [docs/operations.md](docs/operations.md) にあります。プレビュー確認は通ります。本番の KV、Queue、cron、シークレットはプレビューに渡しません。`BABA` は本番の `jra-dify-pipeline` を読みます。

## 主なエンドポイント

| メソッド | パス | 認証 | 役割 |
| --- | --- | --- | --- |
| `GET` | `/health` | なし | 生存確認。`mode` は `next-day-batch`。`commit` と `version_id` も返す |
| `POST` | `/run` | Access JWT | レース 1 件を積む。受理は 202、処理中は 409 |
| `POST` | `/admin/batch` | Access JWT | 指定した開催日の全レースを積む。`dry_run: true` は一覧だけで積まない |
| `GET` | `/oauth/start` | Access JWT | BASHIRA の認可を始める |
| `GET` | `/oauth/callback` | なし | 認可コードを受け取る。`state` と PKCE で紐づける |
| `GET` | `/oauth/status` | Access JWT | 認可済みかを返す。トークンは返さない |
| `GET` | `/admin/jobs` | Access JWT | ジョブの進捗と失敗理由。Gemini の `finishReason`、`modelVersion`、トークン数。コース分析は検索クエリも |
| `GET` | `/admin/jobs/input` | Access JWT | 予想に渡した馬柱と、馬ごとの解決結果。`include=past_runs` は近10走、コース成績、出走馬のコース成績だけ |
| `GET` | `/admin/inspect` | Access JWT | レースの馬柱、LLM の入出力、呼び出し結果。`format=markdown` は人が読む形。`date` はその日の一覧 |
| `GET` | `/admin/models` | Access JWT | Gemini モデルの一覧と現在値 |
| `PUT` | `/admin/models` | Access JWT | コース分析またはレース予想のモデルを変える |
| `POST` | `/admin/models/restore` | Access JWT | 直前のモデル設定に戻す |

`POST /run` のリクエストは [docs/run.md](docs/run.md)、管理用 API は [docs/admin.md](docs/admin.md)、Access の検証は [docs/access.md](docs/access.md) です。

## ドキュメント

プロジェクト全体で変わらない説明は、この README に置きます。仕様、管理用 API、運用、確認の記録は `docs/` です。

| ファイル | 内容 |
| --- | --- |
| [docs/pipeline.md](docs/pipeline.md) | 段階、Queue、外部呼び出しの上限、ロック、cron |
| [docs/run.md](docs/run.md) | `POST /run` のリクエストと場コード |
| [docs/access.md](docs/access.md) | Cloudflare Access の検証と呼び出し元 |
| [docs/bashira-auth.md](docs/bashira-auth.md) | BASHIRA の OAuth と MCP |
| [docs/prompts.md](docs/prompts.md) | KV のプロンプト形式と差し込み名。本文は置かない |
| [docs/umabashira.md](docs/umabashira.md) | 馬柱の書き方 |
| [docs/same-name-horses.md](docs/same-name-horses.md) | 同じ名前の馬 |
| [docs/consistency.md](docs/consistency.md) | 予想本文と成績の整合性チェック |
| [docs/admin.md](docs/admin.md) | 管理用エンドポイント |
| [docs/notion.md](docs/notion.md) | Notion のプロパティ、ページの作り方、本文のブロック |
| [docs/course-odds.md](docs/course-odds.md) | コース集計、馬場、単勝オッズ |
| [docs/operations.md](docs/operations.md) | シークレット、ビルドの commit、プレビュー、テスト |
| [docs/verification.md](docs/verification.md) | 以前の環境で確認できたことと、できていないこと |
| [docs/known-issues.md](docs/known-issues.md) | 既知の問題 |
