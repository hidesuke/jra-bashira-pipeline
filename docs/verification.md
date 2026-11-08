# 確認の記録

このファイルは、以前の README に書いてあった「この環境で確認できたことと、できていないこと」です。ドキュメント整理のときにライブの BASHIRA、Gemini、Notion、Cloudflare を打ち直した記録ではありません。コードが後から両対応にした箇所だけ、末尾に実装の状態を足してあります。

## 確認できたこと

- BASHIRA の認可サーバ metadata（authorization、token、register、PKCE S256、refresh_token、`none`）
- protected resource metadata（`/.well-known/oauth-protected-resource/mcp`）
- `POST /register` が公開クライアントを 201 で返すこと
- 未認証の MCP が 401 と `resource_metadata` を返すこと
- 接続済み BASHIRA ツールの引数スキーマ（`get_races`、`get_entries`、`get_odds`、`get_stats`）。実行時も `tools/list` で同じ確認をする
- 馬場 API の JSON（`fetchedAt` と `venues[]`）
- Notion データベースのプロパティ型と選択肢（2026-11-07 に読んだもの。[notion.md](notion.md)）
- `get_entries` の `name_resolution`。同名は `status: "ambiguous"` と `candidates[].name`（`マイネルエンペラー (2020)`）、`starts`、`period`。一意な馬は `status: "resolved"`。生年付きの名前を指定し直すと行が返る

## 確認できていないこと

- ブラウザでの認可コード交換、refresh の実寿命、refresh token のローテーション有無
- Worker からの `tools/list` と `tools/call` の実レスポンス
- Gemini の `models.list` と `generateContent` の実応答
- Notion への作成と更新
- Cloudflare 上での Queue、Durable Object、Access JWT、50 サブリクエスト上限

## 実装側で後から入っていること

上の「確認できていないこと」は、実レスポンスをこの環境で見ていない、という意味です。パーサとフッターの文言は、コードにあります。

- `columns` と `rows` は、行が配列のときとオブジェクトのときの両方を読む。実レスポンスの再確認はこの記録には無い。
- `name_resolution` は配列と、フィールド名をキーにしたオブジェクトの両方を読む。
- `modelVersion` が応答に無いときは、Notion フッターに「応答に modelVersion が無い」と書く。
- 外部 `fetch` は Worker が 45 件、Durable Object が 40 件で止める。50 はコメントにあるプラットフォーム上限で、Cloudflare 上での実測はこの記録には無い。
