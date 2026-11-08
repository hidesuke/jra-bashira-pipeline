# エージェント向けのルール

このリポジトリは公開リポジトリです。次のものは絶対にコミットしないでください。

- プロンプトの本文（system、user、その下書き、差分、ログへの写し）
- 秘密情報。API トークン、`NOTION_TOKEN`、`GEMINI_API_KEY`、`TOKEN_ENCRYPTION_KEY`、`ACCESS_AUD`、Access の Client Secret、`.dev.vars` の値

プロンプトの本文は、非公開リポジトリ `hidesuke/jra-bashira-prompts` にだけ置きます。このリポジトリに書いてよいのは、KV のキー名、差し込み名、処理の説明までです。

## ユーザーに確認してから行うこと

- マージ
- 本番へのデプロイ（`wrangler deploy` と `wrangler secret put` を含む）
- 本番の一次予想の生成の実行（本番の `POST /run` など）
- Notion に書き込む書式の変更
- Cloudflare の設定の変更（`wrangler.jsonc`、Workers Builds、Access、Queue、KV、Durable Object、サービスバインディング）
- 新しいトップレベルの構成の追加（リポジトリ直下の新しいディレクトリや、Worker の入口が増える構成）

## 確認なしで行ってよいこと

- ブランチでの作業
- テストの追加と実行
- プルリクエストの作成
- ドキュメントの更新

## プルリクエストとテスト

プルリクエストのタイトルと本文は日本語で書きます。コードやドキュメントを変更したら、出す前にテストを通します。

```bash
npm test
npm run typecheck
```

`npm run check` は型検査とテストの両方です。ドキュメントだけの変更でも、このコマンドが通ることを確認します。依頼の範囲を超えて Worker の挙動は変えないでください。

## 既知のこと

Workers Builds のプルリクエスト用プレビュー確認は、`wrangler.jsonc` に `previews` の設定が無いため必ず失敗します。これは前からある問題です。マージ後の本番ビルドは成功します。プレビューを通すために、頼まれていない `previews` の設定を足さないでください。

詳細は [docs/known-issues.md](docs/known-issues.md) です。仕様の入口は [README.md](README.md) で、細目は `docs/` に分かれています。
