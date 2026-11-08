# 運用

デプロイの手順そのものは [README](../README.md) にあります。ここでは、その周辺でコードと設定が決めていることを書きます。

## シークレット

次は手動の Secret です。値をリポジトリ、コマンド引数、ログに書かないでください。

- `GEMINI_API_KEY`
- `NOTION_TOKEN`
- `TOKEN_ENCRYPTION_KEY`（`openssl rand -base64 32`）
- `ACCESS_AUD`（Access アプリケーションの AUD タグ。`vars` には書かない）

次は任意の Secret です。未設定なら通知しません。値をリポジトリ、コマンド引数、ログに書かないでください。

- `NOTIFY_WEBHOOK_URL`
- `NOTIFY_WEBHOOK_KEY`

入れ方は必須の Secret と同じです。ダッシュボードの Settings → Variables and Secrets か、`npx wrangler secret put NOTIFY_WEBHOOK_URL` と `npx wrangler secret put NOTIFY_WEBHOOK_KEY` です。`secret put` はデプロイになります。通知が要らないときは置かないでください。

`NOTIFY_WEBHOOK_KEY_HEADER` は Secret ではなく平文の変数です。未設定なら `Authorization` で、値は `Bearer <NOTIFY_WEBHOOK_KEY>` です。それ以外のヘッダー名なら、キーをそのままそのヘッダーに入れます。`wrangler.jsonc` には書いていません。別の名前を残すときは `vars` に足してください。

Worker がまだ無い状態では `wrangler secret put` もダッシュボードもシークレットを先に置けないため、`secrets.required` は設定していません。最初の deploy が Worker を作ったあと、ダッシュボードの Settings → Variables and Secrets か、README の `secret put` で入れます。

`secret put` はそれ自体がデプロイになります。レースを動かす前に入れてください。入っていないと実行時に失敗します。`ACCESS_AUD` はダッシュボードで設定済みなら、その値を上書きしないでください。

ローカルの `wrangler dev` では同じ名前を `.dev.vars` に書きます。`.dev.vars.example` をコピーしてください。例ファイルにあるのは `GEMINI_API_KEY`、`NOTION_TOKEN`、`TOKEN_ENCRYPTION_KEY`、`ACCESS_AUD` です。通知を試すときだけ `NOTIFY_WEBHOOK_URL` と `NOTIFY_WEBHOOK_KEY` も書きます。空なら送りません。`ACCESS_AUD` の値はプレースホルダーなので、保護された経路を試すときは自分の AUD タグに置き換えます。`.dev.vars` はコミットしません。

`ACCESS_CLIENT_ID_GROK` と `ACCESS_CLIENT_ID_MUSE` は Secret ではなく `vars` です。リポジトリ上の値は空です。Client Secret は Worker に置きません。

## ビルドと `/health` の commit

`/health` は `ok`、`mode`（`next-day-batch`）、`version`、`commit`、`version_id` を返します。`version` は `package.json` の version で、コードの `APP_VERSION`（`src/version.ts`）と同じです。いまの値は `0.9.0` です。`commit` は、空でなければ `CF_VERSION_METADATA.tag` です。Workers Builds ではこの tag が空になることがあります。そのときはビルド時に `src/build-info.ts` へ書いた SHA を使います。両方空なら `commit` は null です。

SHA を書くのは `scripts/write-build-info.mjs` です。次のときだけファイルを書き換えます。

- `WORKERS_CI` が `1`
- または `WORKERS_CI_COMMIT_SHA` か `CF_PAGES_COMMIT_SHA` がある

SHA の環境変数が空で、上の条件を満たすときだけ `git rev-parse HEAD` を使います。ローカルの `npm ci` は `prepare` でこのスクリプトを起動しますが、CI でなければ何も書かずに終了します。コミット済みの `src/build-info.ts` は空文字のままです。

Workers Builds は `wrangler.jsonc` の custom build を実行しません。ダッシュボードのビルドコマンド `npm ci && node scripts/write-build-info.mjs` が、CI 上でスクリプトを走らせます。`npm ci` の `prepare` も同じスクリプトを起動します。スクリプトが走らず tag も空なら、`commit` は null のままです。

## プルリクエストのプレビュー

Workers Builds のプルリクエスト用プレビュー確認は通ります。設定は `wrangler.jsonc` の `previews` です。このブロックは本番の設定を継承しません。ブロックの説明は [Workers のプレビュー設定](https://developers.cloudflare.com/workers/previews/configuration/) にあります。

`previews` にあるのは、非シークレットの `vars`、Durable Object `BASHIRA_AUTH` の binding、`CF_VERSION_METADATA`、サービスバインディング `BABA` です。

プレビューに渡していないものは次です。

- 本番の KV。`APP_KV` の binding は `previews` に無い。
- 本番の Queue。`jra-bashira-race` の producer も consumer も `previews` に無い。
- cron。`previews` に `triggers` は無い。プレビューの `scheduled` は動かない。
- シークレット。`GEMINI_API_KEY`、`NOTION_TOKEN`、`TOKEN_ENCRYPTION_KEY`、`ACCESS_AUD` は `previews` に無い。任意の `NOTIFY_WEBHOOK_URL` と `NOTIFY_WEBHOOK_KEY` も無い。

`NOTION_DATABASE_ID` はプレビューでは空です。本番のデータベース ID は置きません。

Durable Object のクラスと `migrations` はトップレベルにあります。プレビューの binding は、プレビューごとの名前空間です。

`BABA` の `service` は `jra-dify-pipeline` です。プレビューはこの本番 Worker を読みます。この Worker の KV や Notion には書きません。

## リソース

最初の `npx wrangler deploy` が KV `APP_KV`、Queue `jra-bashira-race`、SQLite の Durable Object `BashiraAuth`、サービスバインディング `BABA` を作ります。id は設定に書きません。Git からの deploy では、作られた id はダッシュボードに残り、リポジトリには書き戻されません。

失敗したメッセージの待ち行列は、この deploy では作られません。

```bash
npx wrangler queues create jra-bashira-race-dlq
```

無い状態で deploy すると失敗します。配送が待ち行列へ入る条件は [pipeline.md](pipeline.md) です。

## Free プランの上限

コードが件数で止めているのは、1 呼び出しの外部 `fetch` です。日次の枠はプラットフォームが適用し、超えるとその操作が失敗します。出典は [Workers のサブリクエスト上限](https://developers.cloudflare.com/workers/platform/limits/#subrequests)、[KV の上限](https://developers.cloudflare.com/kv/platform/limits/)、[Queues の料金](https://developers.cloudflare.com/queues/platform/pricing/) です。

| 上限 | Free プラン | このリポジトリ |
| --- | --- | --- |
| 外部サブリクエスト | 1 呼び出し 50 件 | `EXTERNAL_SUBREQUEST_LIMIT`。Worker は `EXTERNAL_BUDGET` の 45 件で分割する。通知の 1 件だけ、45 を使い切っていても 50 未満なら送る |
| Cloudflare サービスへのサブリクエスト | 1 呼び出し 1,000 件 | KV、Queue、Durable Object のバインディング。この 1,000 は定数にしていない。外部 `fetch` の 45 件・40 件には数えない |
| KV の書き込み | 別のキーへ 1 日 1,000。同じキーは 1 秒に 1 回 | ジョブは `JOB_WRITE_MIN_INTERVAL_MS`（1.1 秒）で間を空ける。429 は `KV_PUT_BACKOFF_MS`（1 秒、2 秒、4 秒）で待ってやり直す |
| Queue の操作 | 1 日 10,000。64KB までの書き込み、読み取り、削除がそれぞれ 1 操作。1 メッセージの配送は、通常この 3 操作 | `max_batch_size` は 1。`max_concurrency` は 3。メッセージの保持は 24 時間で、Free プランでは変えられない。待ち行列 `jra-bashira-race-dlq` も Queue なので、同じ保持になる |
| Durable Object の外部 `fetch` | 外部サブリクエストと同じく 1 回 50 件 | `DO_EXTERNAL_BUDGET` の 40 件で止める。40 は 1 回の呼び出しの予算で、1 日の合計ではない |

Gemini の日次の呼び出し上限は、このリポジトリの定数にはありません。予想 1 件の `predict` は `streamGenerateContent` を 2 回（コース分析とレース予想）呼びます。

開催日の全レースを 3 並列で進めたとき、KV の 1 日の書き込み、Gemini の呼び出し、各呼び出しの Durable Object 40 件に収まるかは、まだ本番で見ていません。記録は [verification.md](verification.md) です。

## テスト

```bash
npm test
npm run typecheck
npm run check
```

BASHIRA、Gemini、Notion はモックです。実 API へのデプロイや書き込みは、テストではしません。型生成は `npm run types`（`wrangler types`）です。

同じ `npm ci` と `npm run check` を、GitHub Actions（[`.github/workflows/check.yml`](../.github/workflows/check.yml)）が pull request と `main` への push で実行します。シークレットは使わず、デプロイはしません。デプロイは Workers Builds のままです。

## cron

金曜と土曜の 16:45（日本時間）に、翌日の全レースを積みます。`wrangler.jsonc` の式は `45 7 * * FRI,SAT` です。Cloudflare の cron は UTC で、曜日の 1 は日曜なので金・土は `FRI,SAT` です。7:45 UTC は 16:45 JST で、日付は変わりません。積む開催日は、発火した瞬間の日本時間の翌日です。

`scheduled` は予想の完了を待ちません。0 件の日はログして戻ります。処理中と完了済みのレースは積みません。失敗済みはもう一度積みます。件数はログと KV `batch:v1:{開催日}` の 1 件に残し、14 日で消します。プレビューには cron を置いていないので、プレビューの `scheduled` は動きません。進み方とロックは [pipeline.md](pipeline.md)、手動の再実行は [admin.md](admin.md) です。

本番で、この cron が翌日の全レースを 3 並列で最後まで進めた記録は、まだありません。初回は 2026-11-13 16:45（日本時間）の予定です。見方は [verification.md](verification.md) です。
