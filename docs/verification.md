# 確認の記録

本番で通したことと、まだ見ていないことを分けて書く。ドキュメントを整理したときに、ライブの BASHIRA、Gemini、Notion、Cloudflare を打ち直した記録ではない。コードが後から両対応にした箇所は、末尾に実装の状態を残してある。

## 本番で確認できたこと

2026-11-08 に確認した。

- 本番にデプロイ済みである。`/health` が返す `commit` は、その時点の main の最新と一致した。main の先頭は `e81d6f5` だった。
- 東京11R（`20261108-05-11`）を `POST /run` から Queue、予想、Notion のページ作成まで通した。ジョブは `b14439fc` で、所要時間は約 4 分 10 秒だった。524 エラーも再試行も無かった。
- `{{runner_stats}}` は 18 頭分、54 行だった。近10走の表に条件列があることも確認した。
- Gemini の生成を `streamGenerateContent`（`alt=sse`）に替えたあと、524 エラーは解消した。このレースの予想は、その経路で最後まで出ている。

## 以前の環境で確認できたこと

- BASHIRA の認可サーバ metadata（authorization、token、register、PKCE S256、refresh_token、`none`）
- protected resource metadata（`/.well-known/oauth-protected-resource/mcp`）
- `POST /register` が公開クライアントを 201 で返すこと
- 未認証の MCP が 401 と `resource_metadata` を返すこと
- 接続済み BASHIRA ツールの引数スキーマ（`get_races`、`get_entries`、`get_odds`、`get_stats`）。実行時も `tools/list` で同じ確認をする
- 馬場 API の JSON（`fetchedAt` と `venues[]`）
- Notion データベースのプロパティ型と選択肢（2026-11-07 に読んだもの。[notion.md](notion.md)）
- `get_entries` の `name_resolution`。同名は `status: "ambiguous"` と `candidates[].name`（`マイネルエンペラー (2020)`）、`starts`、`period`。一意な馬は `status: "resolved"`。生年付きの名前を指定し直すと行が返る
- 2026-11-08 の `get_stats`。京都ダート 1800、2021-11-07〜2026-11-07、父の配列では、`scope` が `jra_and_non_jra`、`data_version` が `20261108T091910Z` の形、`data_through` が `2026-11-03` だった。曖昧な名前が混ざると行は返らず、絞り込みを実行していない旨が `note` に出た。見つからない名前は `status: "not_found"` で、他の解決できた名前の行は返った

上の東京11Rは、Worker から BASHIRA を呼んで最後まで進んでいる。その応答本文は、このファイルには残していない。

## 確認できていないこと

- ブラウザでの認可コード交換、refresh の実寿命、refresh token のローテーション有無
- Gemini の `models.list` の実応答
- Notion の更新。再実行で旧ページをアーカイブすることは、まだ見ていない。ページの新規作成は、上の東京11Rで通った
- Durable Object の中身を本番で見た記録。外部サブリクエスト 50 件の上限に当たった実測も無い
- 1 件ずつの全レースバッチの実績。定時実行は停止している。定期予想は Dify 版。手動は `POST /admin/batch`。1 レースの Queue は、上の東京11Rで通った
- そのバッチの日に、KV の書き込み、Gemini の呼び出し上限、Durable Object の外部呼び出し予算 40 件（`DO_EXTERNAL_BUDGET`。1 回の呼び出しごとの予算）に収まるか。上限の説明は [operations.md](operations.md) にある

## 実装側で後から入っていること

上の「確認できていないこと」のうち、実レスポンスをこのファイルに貼っていないものは、パーサとフッターの文言がコードにある。

- `columns` と `rows` は、行が配列のときとオブジェクトのときの両方を読む。実レスポンスの再確認はこの記録には無い。
- `name_resolution` は配列と、フィールド名をキーにしたオブジェクトの両方を読む。
- `modelVersion` が応答に無いときは、Notion フッターに「応答に modelVersion が無い」と書く。
- 外部 `fetch` は Worker が 45 件、Durable Object が 40 件で止める。50 はコードのコメントにあるプラットフォーム上限で、Cloudflare 上でその件数に当たった実測はこの記録には無い。
