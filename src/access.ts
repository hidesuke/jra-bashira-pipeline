import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface Caller {
  name: string;
  clientId: string | null;
  commonName: string | null;
  email: string | null;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

export function accessJwks(teamDomain: string): JWTVerifyGetKey {
  const issuer = teamDomain.replace(/\/$/, "");
  const existing = jwksCache.get(issuer);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  jwksCache.set(issuer, jwks);
  return jwks;
}

export async function verifyAccessJwt(
  token: string,
  options: { issuer: string; audience: string; key: JWTVerifyGetKey | CryptoKey },
): Promise<JWTPayload> {
  const issuer = options.issuer.replace(/\/$/, "");
  const { payload } = await jwtVerify(token, options.key, {
    issuer,
    audience: options.audience,
  });
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
  if (!audiences.includes(options.audience)) {
    throw new Error("AUD が Access アプリケーションと一致しません");
  }
  return payload;
}

export function identifyCaller(input: {
  clientId: string | null;
  payload: JWTPayload;
  grokClientId: string;
  museClientId: string;
}): Caller {
  const commonName = typeof input.payload.common_name === "string" ? input.payload.common_name : null;
  const email = typeof input.payload.email === "string" ? input.payload.email : null;
  let name = "unknown";
  if (input.clientId && input.grokClientId && input.clientId === input.grokClientId) name = "Grok Bot";
  else if (input.clientId && input.museClientId && input.clientId === input.museClientId) name = "Muse";
  else if (commonName && /grok/i.test(commonName)) name = "Grok Bot";
  else if (commonName && /muse/i.test(commonName)) name = "Muse";
  else if (commonName) name = commonName;
  else if (email) name = email;
  else if (typeof input.payload.sub === "string" && input.payload.sub) name = input.payload.sub;
  return { name, clientId: input.clientId, commonName, email };
}
