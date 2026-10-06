import type { Env } from "../env";
import { sha256Hex, timingSafeEqual } from "../ids";
import { recordEvent } from "../db/events";
import { getGrantByLibraryId, liveGrant, rotateRefreshHash } from "../db/oauthGrants";
import type { OAuthGrant } from "../db/types";
import { takeRateDetail } from "../rate";
import { oauthJson } from "../http/oauthMeta";
import { isApex } from "../http/login";
import { notFoundPage } from "../http/pages";
import { authServer, issuer, libraryGrantIdOf } from "./config";
import { revokeOAuthGrant } from "./revoke";

const DAY_MS = 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

const oauthError = (error: string, status = 400) => oauthJson({ error }, status);

/** The library serves token and revocation on one endpoint; the hub decides first, then forwards the same body. */
function forward(env: Env, request: Request, body: string): Request {
  return new Request(`${issuer(env)}/oauth/token`, { method: "POST", headers: request.headers, body });
}

async function grantOf(env: Env, token: string): Promise<OAuthGrant | null> {
  const id = libraryGrantIdOf(token);
  return id ? getGrantByLibraryId(env.HUB_DB, id) : null;
}

async function issuedRefresh(res: Response): Promise<string | null> {
  const body = (await res.clone().json()) as { refresh_token?: unknown };
  return typeof body.refresh_token === "string" ? body.refresh_token : null;
}

/** authorization_code: the D1 grant must be live and the resource must be the grant's (MCP spec 4.2, 7.4). */
async function exchangeCode(env: Env, request: Request, body: string, form: URLSearchParams, ectx: ExecutionContext, now: number): Promise<Response> {
  const grant = await grantOf(env, form.get("code") ?? "");
  // Codes live 5 minutes (MCP spec 10.1); the library alone would allow 10.
  if (!grant || now - grant.created_at > CODE_TTL_MS) return oauthError("invalid_grant");
  if (form.get("resource") !== grant.resource) return oauthError("invalid_target");
  if (!(await liveGrant(env.HUB_DB, grant.id, now))) return oauthError("invalid_grant");
  const res = await authServer(env, grant.resource).fetch(forward(env, request, body), env, ectx);
  if (res.status !== 200) return res;
  const refresh = await issuedRefresh(res);
  if (!refresh || !(await rotateRefreshHash(env.HUB_DB, grant.id, null, await sha256Hex(refresh), now))) {
    await revokeOAuthGrant(env, grant, null, "code_reuse", now);
    return oauthError("invalid_grant");
  }
  return res;
}

/**
 * refresh_token: only the newest refresh token works. Any other refresh token for a known grant is a
 * rotated one coming back, which is treated as theft: the grant is revoked (MCP spec 10.1).
 */
async function refreshTokens(env: Env, request: Request, body: string, form: URLSearchParams, ectx: ExecutionContext, now: number): Promise<Response> {
  const token = form.get("refresh_token") ?? "";
  const grant = await grantOf(env, token);
  if (!grant || grant.revoked_at !== null) return oauthError("invalid_grant");
  const hash = await sha256Hex(token);
  if (grant.refresh_hash === null || !timingSafeEqual(hash, grant.refresh_hash)) {
    await revokeOAuthGrant(env, grant, null, "refresh_reuse", now);
    return oauthError("invalid_grant");
  }
  const resource = form.get("resource");
  if (resource !== null && resource !== grant.resource) return oauthError("invalid_target");
  if (!(await liveGrant(env.HUB_DB, grant.id, now))) return oauthError("invalid_grant");
  const res = await authServer(env, grant.resource).fetch(forward(env, request, body), env, ectx);
  if (res.status !== 200) return res;
  const next = await issuedRefresh(res);
  if (!next || !(await rotateRefreshHash(env.HUB_DB, grant.id, hash, await sha256Hex(next), now))) {
    // Two refreshes raced with the same token: one of them is not the client we issued it to.
    await revokeOAuthGrant(env, grant, null, "refresh_reuse", now);
    return oauthError("invalid_grant");
  }
  if (grant.refreshed_at === null || Math.floor(grant.refreshed_at / DAY_MS) !== Math.floor(now / DAY_MS)) {
    await recordEvent(env.HUB_DB, {
      tenant_id: grant.tenant_id, identity_id: grant.identity_id, session_id: grant.session_id, kind: "oauth.grant.refresh",
      target_kind: "oauth_grant", target_id: grant.id, summary: `Refreshed access for "${grant.client_name}"`,
    }, now);
  }
  return res;
}

/** RFC 7009. Revoking the current refresh token also revokes the hub grant. */
async function revokeToken(env: Env, request: Request, body: string, form: URLSearchParams, ectx: ExecutionContext, now: number): Promise<Response> {
  const token = form.get("token") ?? "";
  const grant = await grantOf(env, token);
  const res = await authServer(env, grant?.resource ?? null).fetch(forward(env, request, body), env, ectx);
  if (res.ok && grant && grant.revoked_at === null && grant.refresh_hash !== null && timingSafeEqual(await sha256Hex(token), grant.refresh_hash)) {
    await revokeOAuthGrant(env, grant, { identity_id: grant.identity_id, session_id: grant.session_id }, "client", now);
  }
  return res;
}

/** POST /oauth/token and /oauth/revoke on the apex. */
export async function tokenEndpoint(request: Request, env: Env, ectx: ExecutionContext, now: number = Date.now()): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return oauthError("invalid_request");
  const body = await request.text();
  const form = new URLSearchParams(body);
  const rate = await takeRateDetail(env.RATE, "oauth_token_client", form.get("client_id") ?? "none", now);
  if (!rate.ok) return oauthJson({ error: "too_many_requests" }, 429, { "retry-after": String(rate.retryAfterS) });
  const grantType = form.get("grant_type");
  if (grantType === null && form.get("token") !== null) return revokeToken(env, request, body, form, ectx, now);
  if (new URL(request.url).pathname === "/oauth/revoke") return oauthError("invalid_request");
  if (grantType === "authorization_code") return exchangeCode(env, request, body, form, ectx, now);
  if (grantType === "refresh_token") return refreshTokens(env, request, body, form, ectx, now);
  return oauthError("unsupported_grant_type");
}
