# Cloudflare Access

`/run`、`/admin/*`、`/oauth/start`、`/oauth/status` は Access の JWT が必要です。`/health` と `/oauth/callback` は公開です。callback は `state` と PKCE で紐づけます。認可の手順は [bashira-auth.md](bashira-auth.md) です。

Access アプリケーションを Worker の URL に置き、ポリシーに Grok Bot と Muse のサービストークンを入れます。アプリケーションの AUD は Secret `ACCESS_AUD` です。設定ファイルには書きません。チームのドメインは `wrangler.jsonc` の `ACCESS_TEAM_DOMAIN`（`https://hdsk.cloudflareaccess.com`）です。

Worker は次を検証します。

- ヘッダ `Cf-Access-Jwt-Assertion` がある
- 署名が `https://hdsk.cloudflareaccess.com/cdn-cgi/access/certs` の公開鍵と一致する
- `iss` が `https://hdsk.cloudflareaccess.com` である（末尾のスラッシュは除いて比べる）
- `aud` が Secret の `ACCESS_AUD` と一致する
- 有効期限が切れていない

`ACCESS_TEAM_DOMAIN` が `https://` で始まらないとき、または `ACCESS_AUD` が空のときは 500 です。JWT が無い、または検証できないときは 403 です。

呼び出し元の記録は、`CF-Access-Client-Id` が `ACCESS_CLIENT_ID_GROK` または `ACCESS_CLIENT_ID_MUSE` と一致すれば「Grok Bot」「Muse」です。一致しなければ、JWT の `common_name` を使います。名前に grok または muse を含むときも同じラベルです。それ以外は `common_name`、無ければ email、それも無ければ `sub`、どれも無ければ `unknown` です。Client Secret は読みません。

呼び出し側は、Access の前にサービストークンを付けます。Access が通したリクエストには JWT が付きます。Worker のオリジンへ JWT 無しで直接叩くと 403 です。Client ID の置き場所は [README](../README.md) のセットアップです。
