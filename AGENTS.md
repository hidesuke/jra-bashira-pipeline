# エージェント向けのルール

## コミットしないもの

このリポジトリは公開リポジトリである。次はコミットしない。

- プロンプトの本文。本文は非公開リポジトリ `hidesuke/jra-bashira-prompts` にだけ置く。このリポジトリに書いてよいのは、KV のキー名、差し込み名、処理の説明までである。
- 秘密情報。トークン、Access の認証情報、`.dev.vars` の値を含む。

## 確認してから行うこと

- マージ
- 本番へのデプロイ（`wrangler deploy` と `wrangler secret put`）
- 本番の一次予想の生成の実行（本番の `POST /run`）
- Notion に書き込む書式の変更
- Cloudflare の設定の変更（`wrangler.jsonc`、Workers Builds、Access、Queue、KV、Durable Object、サービスバインディング）
- 新しいトップレベルの構成の追加（リポジトリ直下の新しいディレクトリ、Worker の入口が増える構成）

## 確認なしで行ってよいこと

- ブランチでの作業
- テストの追加と実行
- プルリクエストの作成
- ドキュメントの更新

## プルリクエストとテスト

プルリクエストのタイトルと本文は日本語で書く。変更したら `npm test` と `npm run typecheck` を通す。Worker の挙動は、依頼された範囲だけ変える。

## ドキュメント

変更のたびに、関係するドキュメントが実装と一致しているか確認し、必要なら同じ PR で更新する。PR 本文に、ドキュメントを確認した結果（更新した／不要だった）を書く。見るのは README、`docs/`、このファイル、`wrangler.jsonc` のコメントである。

## プレビュー

`wrangler.jsonc` の `previews` に、本番の KV、Queue、cron、シークレット、本番の Notion データベース ID を足さない。`BABA` は本番の `jra-dify-pipeline` を読む設定のままにする。
