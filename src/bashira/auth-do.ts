import { DurableObject } from "cloudflare:workers";
import { decryptJson, encryptJson, importAesKey, safeEqual } from "../crypto-util";
import { DO_EXTERNAL_BUDGET } from "../types";
import { initializeMcpSession, McpStatusError, postMcp, unwrapToolResult, type McpSession } from "./mcp";
import {
  applyTokenResponse,
  buildAuthorizeUrl,
  createPkce,
  discoverOAuth,
  tokenRequestBody,
  type OAuthMetadata,
  type PendingAuth,
  type TokenSet,
} from "./oauth";
import type { ToolFailure } from "./port";

type SessionState = McpSession;

interface ClientRegistration {
  clientId: string;
  redirectUri: string;
}

interface Budget {
  n: number;
}

class AuthFailed extends Error {}
class BudgetStop extends Error {}
class McpUnauthorized extends Error {}
class SessionExpired extends Error {}

/**
 * BASHIRA の OAuth トークンと MCP セッションを一つに集約する。
 * 資格情報はレース横断で一つなので、インスタンスも一つ（名前 "bashira"）。
 */
export class BashiraAuth extends DurableObject<Env> {
  private session: SessionState | null = null;
  private refreshInflight: Promise<string> | null = null;
  private aes: CryptoKey | null = null;
  private rpcId = 0;

  async getStatus(): Promise<{
    registered: boolean;
    authorized: boolean;
    needsReauth: boolean;
    expiresAt: string | null;
    lastError: string | null;
  }> {
    const client = await this.ctx.storage.get<ClientRegistration>("client");
    const tokens = await this.readTokens();
    return {
      registered: Boolean(client?.clientId),
      authorized: Boolean(tokens && !tokens.needsReauth),
      needsReauth: Boolean(tokens?.needsReauth),
      expiresAt: tokens ? new Date(tokens.expiresAtMs).toISOString() : null,
      lastError: tokens?.lastError ?? null,
    };
  }

  async beginAuthorization(redirectUri: string): Promise<{ url: string }> {
    const budget = this.budget();
    const metadata = await this.metadata(budget);
    const pkce = await createPkce();
    const client = await this.ensureClient(budget, metadata, redirectUri);
    const pending: PendingAuth = {
      state: pkce.state,
      codeVerifier: pkce.verifier,
      redirectUri,
      createdAtMs: Date.now(),
    };
    await this.ctx.storage.put("pending", await encryptJson(await this.key(), pending));
    return {
      url: buildAuthorizeUrl({
        metadata,
        clientId: client.clientId,
        redirectUri,
        state: pkce.state,
        codeChallenge: pkce.challenge,
      }),
    };
  }

  async completeAuthorization(input: { code: string; state: string; iss: string | null }): Promise<{ ok: true }> {
    const budget = this.budget();
    const metadata = await this.metadata(budget);
    const pending = await this.readPending();
    if (!pending || !safeEqual(pending.state, input.state)) {
      throw new Error("state が一致しません。認可を最初からやり直してください");
    }
    if (Date.now() - pending.createdAtMs > 10 * 60 * 1000) {
      throw new Error("認可の state が期限切れです。/oauth/start からやり直してください");
    }
    if (input.iss && normalizeIssuer(input.iss) !== normalizeIssuer(metadata.issuer)) {
      throw new Error("認可応答の iss が metadata の issuer と一致しません");
    }
    const client = await this.ctx.storage.get<ClientRegistration>("client");
    if (!client) throw new Error("OAuth クライアントが未登録です");
    const response = await this.trackedFetch(budget, metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenRequestBody({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: pending.redirectUri,
        client_id: client.clientId,
        code_verifier: pending.codeVerifier,
        resource: metadata.resource,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`認可コードの交換に失敗しました（HTTP ${response.status}）`);
    }
    const tokens = applyTokenResponse(null, payload, Date.now());
    await this.writeTokens(tokens);
    await this.ctx.storage.delete("pending");
    await this.clearSession();
    return { ok: true };
  }

  async listTools(): Promise<{ ok: true; tools: unknown[] } | ToolFailure> {
    const budget = this.budget();
    try {
      const tools = await this.withAuth(budget, async (token) => {
        const collected: unknown[] = [];
        let cursor: string | undefined;
        do {
          const result = (await this.rpc(budget, token, "tools/list", cursor ? { cursor } : {})) as {
            tools?: unknown[];
            nextCursor?: string;
          };
          collected.push(...(result.tools ?? []));
          cursor = result.nextCursor;
        } while (cursor);
        return collected;
      });
      return { ok: true, tools };
    } catch (err) {
      return this.failure(err);
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | ToolFailure> {
    const budget = this.budget();
    try {
      const data = await this.withAuth(budget, async (token) =>
        unwrapToolResult(await this.rpc(budget, token, "tools/call", { name, arguments: args })),
      );
      return { ok: true, data };
    } catch (err) {
      return this.failure(err);
    }
  }

  async callTools(
    calls: Array<{ name: string; args: Record<string, unknown> }>,
  ): Promise<{ ok: true; results: unknown[] } | ToolFailure> {
    if (calls.length > 8) {
      return {
        ok: false,
        results: [],
        message: "1 回の DO 呼び出しに渡せる tool は 8 件までです",
        retryable: false,
        code: "upstream",
      };
    }
    const budget = this.budget();
    const results: unknown[] = [];
    try {
      for (const call of calls) {
        const data = await this.withAuth(budget, async (token) =>
          unwrapToolResult(await this.rpc(budget, token, "tools/call", { name: call.name, arguments: call.args })),
        );
        results.push(data);
      }
      return { ok: true, results };
    } catch (err) {
      return { ...this.failure(err), results };
    }
  }

  private budget(): Budget {
    return { n: 0 };
  }

  private async withAuth<T>(budget: Budget, run: (token: string) => Promise<T>): Promise<T> {
    try {
      const token = await this.ensureAccessToken(budget);
      return await run(token);
    } catch (err) {
      if (!(err instanceof McpUnauthorized)) throw err;
      try {
        const token = await this.forceRefresh(budget);
        return await run(token);
      } catch (retryErr) {
        if (retryErr instanceof McpUnauthorized) {
          throw new AuthFailed("BASHIRA がアクセストークンを拒否しました。/oauth/start から再認可してください");
        }
        throw retryErr;
      }
    }
  }

  private async ensureAccessToken(budget: Budget): Promise<string> {
    if (this.refreshInflight) return this.refreshInflight;
    const tokens = await this.readTokens();
    if (this.refreshInflight) return this.refreshInflight;
    if (!tokens) {
      throw new AuthFailed("BASHIRA が未認可です。/oauth/start をブラウザで開いて認可してください");
    }
    if (tokens.needsReauth) {
      throw new AuthFailed(tokens.lastError ?? "BASHIRA の再認可が必要です。/oauth/start を開いてください");
    }
    if (tokens.expiresAtMs - 60_000 > Date.now()) return tokens.accessToken;
    return this.startRefresh(budget, tokens, false);
  }

  private async forceRefresh(budget: Budget): Promise<string> {
    if (this.refreshInflight) return this.refreshInflight;
    const tokens = await this.readTokens();
    if (!tokens) throw new AuthFailed("BASHIRA が未認可です。/oauth/start をブラウザで開いて認可してください");
    return this.startRefresh(budget, tokens, true);
  }

  private startRefresh(budget: Budget, tokens: TokenSet, force: boolean): Promise<string> {
    const run = this.refresh(budget, tokens, force).finally(() => {
      if (this.refreshInflight === run) this.refreshInflight = null;
    });
    this.refreshInflight = run;
    return run;
  }

  private async refresh(budget: Budget, tokens: TokenSet, _force: boolean): Promise<string> {
    const metadata = await this.metadata(budget);
    const client = await this.ctx.storage.get<ClientRegistration>("client");
    if (!client) throw new AuthFailed("OAuth クライアントが未登録です。/oauth/start からやり直してください");
    let response: Response;
    try {
      response = await this.trackedFetch(budget, metadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenRequestBody({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: client.clientId,
          resource: metadata.resource,
        }),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AuthFailed(`BASHIRA の refresh に失敗しました（通信エラー）。処理を止めます。詳細: ${detail}`);
    }
    if (!response.ok) {
      const text = await response.text();
      const invalid = response.status === 400 && text.includes("invalid_grant");
      const message = invalid
        ? "BASHIRA の refresh に失敗しました（invalid_grant）。トークンが失効またはローテーション済みです。/oauth/start から再認可してください。"
        : `BASHIRA の refresh に失敗しました（HTTP ${response.status}）。処理を止めます。`;
      if (invalid) await this.writeTokens({ ...tokens, needsReauth: true, lastError: message });
      throw new AuthFailed(message);
    }
    const payload = await response.json().catch(() => null);
    // 新しい refresh_token が無いときは古いものを残す。応答を保存するまで古いトークンは消さない。
    const next = applyTokenResponse(tokens, payload, Date.now());
    await this.writeTokens(next);
    return next.accessToken;
  }

  private async rpc(
    budget: Budget,
    token: string,
    method: string,
    params: unknown,
    notification = false,
  ): Promise<unknown> {
    try {
      return await this.rpcOnce(budget, token, method, params, notification);
    } catch (err) {
      if (!(err instanceof SessionExpired)) throw err;
      return this.rpcOnce(budget, token, method, params, notification);
    }
  }

  private async rpcOnce(
    budget: Budget,
    token: string,
    method: string,
    params: unknown,
    notification: boolean,
  ): Promise<unknown> {
    await this.ensureSession(budget, token);
    if (!this.session) throw new Error("MCP セッションがありません");
    const body = notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: ++this.rpcId, method, params };
    try {
      const posted = await postMcp({
        url: this.env.BASHIRA_MCP_URL,
        token,
        session: this.session,
        fetchImpl: (url, init) => this.trackedFetch(budget, url, init),
        body,
        notification,
      });
      return posted.result;
    } catch (err) {
      if (err instanceof McpStatusError && err.status === 401) throw new McpUnauthorized();
      if (err instanceof McpStatusError && err.status === 404) {
        await this.clearSession();
        throw new SessionExpired();
      }
      throw err;
    }
  }

  private async ensureSession(budget: Budget, token: string): Promise<void> {
    if (this.session) return;
    const stored = await this.ctx.storage.get<SessionState>("mcp_session");
    if (stored?.protocol) {
      this.session = { id: stored.id?.trim() ? stored.id : null, protocol: stored.protocol };
      return;
    }
    try {
      const opened = await initializeMcpSession({
        url: this.env.BASHIRA_MCP_URL,
        token,
        fetchImpl: (url, init) => this.trackedFetch(budget, url, init),
        nextId: () => ++this.rpcId,
        clientInfo: { name: "jra-bashira-predict", version: "0.4.0" },
      });
      this.session = opened.session;
      await this.ctx.storage.put("mcp_session", this.session);
    } catch (err) {
      if (err instanceof McpStatusError && err.status === 401) throw new McpUnauthorized();
      throw err;
    }
  }

  private async metadata(budget: Budget): Promise<OAuthMetadata> {
    const stored = await this.ctx.storage.get<OAuthMetadata>("oauth_meta");
    if (stored?.authorization_endpoint && stored.token_endpoint && stored.registration_endpoint) return stored;
    const discovered = await discoverOAuth(this.env.BASHIRA_MCP_URL, (url, init) => this.trackedFetch(budget, url, init));
    await this.ctx.storage.put("oauth_meta", discovered);
    return discovered;
  }

  private async ensureClient(budget: Budget, metadata: OAuthMetadata, redirectUri: string): Promise<ClientRegistration> {
    const existing = await this.ctx.storage.get<ClientRegistration>("client");
    if (existing && existing.redirectUri === redirectUri) return existing;
    const response = await this.trackedFetch(budget, metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "jra-bashira-predict",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    });
    const payload = (await response.json().catch(() => null)) as { client_id?: string } | null;
    if (!response.ok || !payload?.client_id) {
      throw new Error(`動的クライアント登録に失敗しました（HTTP ${response.status}）`);
    }
    const client = { clientId: payload.client_id, redirectUri };
    await this.ctx.storage.put("client", client);
    return client;
  }

  private async trackedFetch(budget: Budget, url: string, init?: RequestInit): Promise<Response> {
    if (budget.n >= DO_EXTERNAL_BUDGET) {
      throw new BudgetStop("この DO 呼び出しの外部サブリクエストが上限に達したため中断しました");
    }
    budget.n += 1;
    return fetch(url, init);
  }

  private async key(): Promise<CryptoKey> {
    if (!this.aes) this.aes = await importAesKey(this.env.TOKEN_ENCRYPTION_KEY);
    return this.aes;
  }

  private async readTokens(): Promise<TokenSet | null> {
    const packed = await this.ctx.storage.get<string>("tokens");
    if (!packed) return null;
    try {
      return await decryptJson<TokenSet>(await this.key(), packed);
    } catch {
      throw new AuthFailed("保存したトークンを復号できません。TOKEN_ENCRYPTION_KEY を変えた場合は /oauth/start から再認可してください");
    }
  }

  private async writeTokens(tokens: TokenSet): Promise<void> {
    await this.ctx.storage.put("tokens", await encryptJson(await this.key(), tokens));
  }

  private async readPending(): Promise<PendingAuth | null> {
    const packed = await this.ctx.storage.get<string>("pending");
    if (!packed) return null;
    return decryptJson<PendingAuth>(await this.key(), packed);
  }

  private async clearSession(): Promise<void> {
    this.session = null;
    await this.ctx.storage.delete("mcp_session");
  }

  private failure(err: unknown): ToolFailure {
    if (err instanceof AuthFailed) return { ok: false, message: err.message, retryable: false, code: "auth" };
    if (err instanceof BudgetStop) return { ok: false, message: err.message, retryable: true, code: "budget" };
    const message = err instanceof Error ? err.message : String(err);
    if (/再認可|未認可|invalid_grant|復号できません/.test(message)) {
      return { ok: false, message, retryable: false, code: "auth" };
    }
    return { ok: false, message, retryable: true, code: "upstream" };
  }
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/$/, "");
}
