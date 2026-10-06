import type { Env } from "../env";
import { credentialUsable, oauthContext, type Ctx } from "../auth/context";
import { liveGrant } from "../db/oauthGrants";
import { touchSession } from "../db/sessions";
import { recordEvent } from "../db/events";
import { takeRateAtomic, takeRateDetail } from "../rate";
import { bearerChallenge, oauthJson } from "../http/oauthMeta";
import { authServer, tenantResource } from "../oauth/config";

/** What approve stores in the library grant's encrypted props (MCP spec 5.3). */
export type GrantProps = { grant_id: string; session_id: string; identity_id: string; tenant_id: string; resource: string; scopes: string[] };

const MAX_TOKEN_LENGTH = 400;

export type McpAuth =
  | { kind: "ok"; ctx: Ctx; token: string; resource: string; expiresAt: number }
  | { kind: "deny"; response: Response };

const tooMany = (retryAfterS: number) => ({ kind: "deny" as const, response: oauthJson({ error: "too_many_requests" }, 429, { "retry-after": String(retryAfterS) }) });

/**
 * Library token validation, then the hub's own check on every request (MCP spec 4.2, 5.3): the grant is live
 * in D1, bound to exactly this host's resource and tenant, and its session is the one in the token.
 */
export async function mcpAuth(
  request: Request, env: Env, slug: string, now: number, waitUntil?: (p: Promise<unknown>) => void,
): Promise<McpAuth> {
  const resource = tenantResource(env, slug);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  // Every path that ends without a valid token charges the same per-IP bucket, so guessing tokens is rate-limited too.
  // The anon bucket only guards a 401, so it lives in KV and fails open when KV errors.
  const charge = async () => {
    try {
      return await takeRateDetail(env.RATE, "mcp_anon_ip", ip, now);
    } catch (e) {
      console.log("anon rate failed", e instanceof Error ? e.name : "error");
      return { ok: true, first: false, retryAfterS: 1 };
    }
  };
  const refuse = async (error: "invalid_token" | null): Promise<McpAuth> => {
    const r = await charge();
    return r.ok ? { kind: "deny", response: bearerChallenge(env, slug, error) } : tooMany(r.retryAfterS);
  };
  if (!token) return refuse(null);
  // Real access tokens are far shorter; never hand a huge string to the library.
  if (token.length > MAX_TOKEN_LENGTH) return refuse("invalid_token");
  let validated;
  try {
    validated = await authServer(env, resource).validateToken<GrantProps>(resource, token, env);
  } catch (e) {
    // The check itself failed (storage or library error): that is not a verdict on the token.
    console.log("mcp token validation failed", e instanceof Error ? e.name : "error");
    const r = await charge();
    return r.ok ? { kind: "deny", response: oauthJson({ error: "temporarily_unavailable" }, 503, { "retry-after": "5" }) } : tooMany(r.retryAfterS);
  }
  if (!validated || validated.audience !== resource) return refuse("invalid_token");
  const live = await liveGrant(env.HUB_DB, validated.props.grant_id, now);
  if (!live || live.grant.resource !== resource || live.tenant.slug !== slug || live.session.id !== validated.props.session_id) return refuse("invalid_token");
  // Defence in depth: the token must have been issued to this grant's client and for this grant's human.
  if (validated.clientId !== live.grant.client_id || validated.userId !== live.identity.id) return refuse("invalid_token");
  if (!(await credentialUsable(env.HUB_DB, live.identity, live.session, null, live.tenant, "mcp"))) return refuse("invalid_token");
  for (const bucket of ["mcp_grant_minute", "mcp_grant_hour"] as const) {
    const r = await takeRateAtomic(env.HUB_DB, bucket, live.grant.id, now);
    if (r.ok) continue;
    if (r.first) {
      await recordEvent(env.HUB_DB, {
        tenant_id: live.tenant.id, identity_id: live.identity.id, session_id: live.session.id, kind: "mcp.denied", target_kind: "oauth_grant",
        target_id: live.grant.id, summary: `Rate limit ${bucket} reached for "${live.grant.client_name}"`,
      }, now);
    }
    return tooMany(r.retryAfterS);
  }
  const session = await touchSession(env.HUB_DB, live.session, now);
  const granted = live.grant.scopes.split(" ").filter(Boolean);
  const scopes = validated.scope.filter((s) => granted.includes(s));
  const ctx = oauthContext(env, { ...live, session }, scopes, { now, ip, waitUntil });
  return { kind: "ok", ctx, token, resource, expiresAt: validated.expiresAt };
}
