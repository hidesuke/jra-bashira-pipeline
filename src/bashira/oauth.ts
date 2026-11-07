export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  resource: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** 不明な寿命は短く扱う。epoch ms。 */
  expiresAtMs: number;
  needsReauth: boolean;
  lastError: string | null;
}

export interface PendingAuth {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAtMs: number;
}

const UNKNOWN_LIFETIME_MS = 5 * 60 * 1000;

export async function discoverOAuth(
  mcpUrl: string,
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<OAuthMetadata> {
  const mcp = new URL(mcpUrl);
  const resourceUrl = new URL(`/.well-known/oauth-protected-resource${mcp.pathname}`, mcp.origin);
  const resourceRes = await doFetch(resourceUrl.toString(), { method: "GET" });
  if (!resourceRes.ok) {
    throw new Error(`OAuth protected resource metadata の取得に失敗しました（HTTP ${resourceRes.status}）`);
  }
  const resource = (await resourceRes.json()) as { authorization_servers?: string[]; resource?: string };
  const issuer = resource.authorization_servers?.[0];
  if (!issuer) throw new Error("authorization_servers が metadata にありません");
  const issuerUrl = new URL(issuer);
  const metaRes = await doFetch(new URL("/.well-known/oauth-authorization-server", issuerUrl.origin).toString(), {
    method: "GET",
  });
  if (!metaRes.ok) {
    throw new Error(`authorization server metadata の取得に失敗しました（HTTP ${metaRes.status}）`);
  }
  const meta = (await metaRes.json()) as {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    grant_types_supported?: string[];
    code_challenge_methods_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
  };
  if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) {
    throw new Error("authorization / token / registration のエンドポイントが metadata に揃っていません");
  }
  if (!meta.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("この認可サーバは PKCE S256 に対応していません");
  }
  const grants = meta.grant_types_supported ?? [];
  if (!grants.includes("authorization_code") || !grants.includes("refresh_token")) {
    throw new Error("authorization_code と refresh_token が必要です。client_credentials は使いません");
  }
  if (!meta.token_endpoint_auth_methods_supported?.includes("none")) {
    throw new Error("公開クライアント（token_endpoint_auth_method=none）に対応していません");
  }
  return {
    issuer: meta.issuer ?? issuer,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint,
    resource: resource.resource ?? mcpUrl,
  };
}

export function buildAuthorizeUrl(input: {
  metadata: OAuthMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", "openid refresh_token");
  url.searchParams.set("resource", input.metadata.resource);
  return url.toString();
}

export function tokenRequestBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export function applyTokenResponse(current: TokenSet | null, response: unknown, nowMs: number): TokenSet {
  if (!response || typeof response !== "object") {
    throw new Error("トークン応答が JSON オブジェクトではありません");
  }
  const body = response as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("トークン応答に access_token がありません");
  }
  const rotated = typeof body.refresh_token === "string" && body.refresh_token !== "";
  const refreshToken = rotated ? body.refresh_token : current?.refreshToken;
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new Error("refresh_token が無いままです。再認可してください");
  }
  const expiresAtMs =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? nowMs + body.expires_in * 1000
      : nowMs + UNKNOWN_LIFETIME_MS;
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAtMs,
    needsReauth: false,
    lastError: null,
  };
}

export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  return { verifier, challenge, state };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
