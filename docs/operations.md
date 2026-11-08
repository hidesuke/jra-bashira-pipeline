# 運用

デプロイの手順そのものは [README](../README.md) にあります。ここでは、その周辺でコードと設定が決めていることを書きます。

## シークレット

次は手動の Secret です。値をリポジトリ、コマンド引数、ログに書かないでください。

- `GEMINI_API_KEY`
- `NOTION_TOKEN`
- `TOKEN_ENCRYPTION_KEY`（`openssl rand -base64 32`）
- `ACCESS_AUD`（Access アプリケーションの AUD タグ。`vars` には書かない）

Worker がまだ無い状態では `wrangler secret put` もダッシュボードもシークレットを先に置けないため、`secrets.required` は設定していません。最初の deploy が Worker を作ったあと、ダッシュボードの Settings → Variables and Secrets か、README の `secret put` で入れます。

`secret put` はそれ自体がデプロイになります。レースを動かす前に入れてください。入っていないと実行時に失敗します。`ACCESS_AUD` はダッシュボードで設定済みなら、その値を上書きしないでください。

ローカルの `wrangler dev` では同じ名前を `.dev.vars` に書きます。`.dev.vars.example` をコピーしてください。例ファイルにあるのは `GEMINI_API_KEY`、`NOTION_TOKEN`、`TOKEN_ENCRYPTION_KEY` です。`ACCESS_AUD` の行は例に無いので、保護された経路を試すときは自分で足します。`.dev.vars` はコミットしません。

`ACCESS_CLIENT_ID_GROK` と `ACCESS_CLIENT_ID_MUSE` は Secret ではなく `vars` です。リポジトリ上の値は空です。Client Secret は Worker に置きません。

## ビルドと `/health` の commit

`/health` は `ok`、`mode`（`one-race`）、`commit`、`version_id` を返します。`commit` は、空でなければ `CF_VERSION_METADATA.tag` です。Workers Builds ではこの tag が空になることがあります。そのときはビルド時に `src/build-info.ts` へ書いた SHA を使います。両方空なら `commit` は null です。

SHA を書くのは `scripts/write-build-info.mjs` です。次のときだけファイルを書き換えます。

- `WORKERS_CI` が `1`
- または `WORKERS_CI_COMMIT_SHA` か `CF_PAGES_COMMIT_SHA` がある

SHA の環境変数が空で、上の条件を満たすときだけ `git rev-parse HEAD` を使います。ローカルの `npm ci` は `prepare` でこのスクリプトを起動しますが、CI でなければ何も書かずに終了します。コミット済みの `src/build-info.ts` は空文字のままです。

Workers Builds は `wrangler.jsonc` の custom build を実行しません。ダッシュボードのビルドコマンド `npm ci && node scripts/write-build-info.mjs` が、CI 上でスクリプトを走らせます。`npm ci` の `prepare` も同じスクリプトを起動します。スクリプトが走らず tag も空なら、`commit` は null のままです。

プルリクエストのプレビュー確認が失敗する理由は [known-issues.md](known-issues.md) です。

## リソース

最初の `npx wrangler deploy` が KV `APP_KV`、Queue `jra-bashira-race`、SQLite の Durable Object `BashiraAuth`、サービスバインディング `BABA` を作ります。id は設定に書きません。Git からの deploy では、作られた id はダッシュボードに残り、リポジトリには書き戻されません。

失敗したメッセージの待ち行列は、この deploy では作られません。

```bash
npx wrangler queues create jra-bashira-race-dlq
```

無い状態で deploy すると失敗します。配送が待ち行列へ入る条件は [pipeline.md](pipeline.md) です。

## テスト

```bash
npm test
npm run typecheck
npm run check
```

BASHIRA、Gemini、Notion はモックです。実 API へのデプロイや書き込みは、テストではしません。型生成は `npm run types`（`wrangler types`）です。

## cron

時刻は未定です。`triggers` はコメントアウトしたままで、有効にしてもレースは積みません。[pipeline.md](pipeline.md) を参照してください。
