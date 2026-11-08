# BASHIRA の認可と MCP

認可は Durable Object `BashiraAuth`（名前 `bashira`）が一つ持ちます。資格情報はレース横断で一つだからです。トークンと PKCE の verifier は `TOKEN_ENCRYPTION_KEY` で AES-GCM 暗号化して保存します。

## OAuth

OAuth は認可コードと PKCE S256 だけです。`client_credentials` は使いません。クライアントは `/register` で動的登録し、`token_endpoint_auth_method` は `none` です。登録時の `grant_types` は `authorization_code` と `refresh_token`、`application_type` は `native` です。エンドポイントは protected resource metadata と authorization server metadata から取ります。確認済みの発行元は `https://mcp.bashira.omninode.co.jp/` で、MCP の URL は `https://mcp.bashira.omninode.co.jp/mcp` です。

1. Access を通したブラウザで `GET /oauth/start` を開く。
2. BASHIRA の認可画面で許可する。
3. 公開の `GET /oauth/callback` が code をトークンに換える。`state` が不一致、または開始から 10 分を超えていれば失敗する。応答の `iss` があるときは、metadata の issuer と一致している必要がある。
4. `GET /oauth/status` で `authorized: true` を確認する。トークン自体は返さない。

status が返すのは `registered`、`authorized`、`needsReauth`、`expiresAt`、`lastError` です。callback の成功時は「BASHIRA の認可が完了しました。」という HTML です。

refresh の寿命とローテーションは未公開です。`expires_in` が無いときは 5 分で期限切れとして扱います。アクセスの期限の 60 秒前から refresh します。応答に新しい `refresh_token` があるときだけ差し替え、無いときは今の refresh token を残します。保存は応答を受け取ったあとです。refresh が無い応答で、保存済みの refresh token も無いときは失敗します。

refresh が失敗したら予想は止めます。`invalid_grant`（HTTP 400 で本文にその文字列がある）のときは再認可が必要だとトークンに残し、KV のジョブと `GET /admin/jobs` の `error` に出します。通信失敗でもそのジョブは止めます。MCP が 401 を返したときは 1 回だけ強制 refresh してやり直し、それでも 401 なら再認可が必要として止めます。

## MCP

MCP の `initialize` に渡す `clientInfo.version` は、`package.json` の `version` と同じです。引数は実行時の `tools/list` で確認します。スキーマに無い引数やフィールドは送りません。`initialize` は先にプロトコル `2025-06-18` を試し、失敗したら `2025-03-26` を試します。セッション ID は応答ヘッダ `mcp-session-id` があるときだけ後続に付けます。

`columns` と `rows` は、行が配列のときとオブジェクトのときの両方を読みます。配列のときは `columns` の名前でオブジェクトにします。`name_resolution` は配列と、フィールド名をキーにしたオブジェクトの両方を読みます。同名馬は [same-name-horses.md](same-name-horses.md) です。

Durable Object の 1 回の外部 `fetch` は 40 件で止めます。集計を 8 件までまとめる理由は [pipeline.md](pipeline.md) です。
