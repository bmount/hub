import type { Env } from "../env";
import { credentialUsable, oauthContext, type Ctx } from "../auth/context";
import { liveGrant } from "../db/oauthGrants";
import { touchSession } from "../db/sessions";
import { recordEvent } from "../db/events";
import { takeRateDetail } from "../rate";
import { bearerChallenge, oauthJson } from "../http/oauthMeta";
import { authServer, tenantResource } from "../oauth/config";

/** What approve stores in the library grant's encrypted props (MCP spec 5.3). */
export type GrantProps = { grant_id: string; session_id: string; identity_id: string; tenant_id: string; resource: string; scopes: string[] };

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
  if (!token) {
    const r = await takeRateDetail(env.RATE, "mcp_anon_ip", ip, now);
    return r.ok ? { kind: "deny", response: bearerChallenge(env, slug, null) } : tooMany(r.retryAfterS);
  }
  const invalid = { kind: "deny" as const, response: bearerChallenge(env, slug, "invalid_token") };
  const validated = await authServer(env, resource).validateToken<GrantProps>(resource, token, env).catch(() => null);
  if (!validated || validated.audience !== resource) return invalid;
  const live = await liveGrant(env.HUB_DB, validated.props.grant_id, now);
  if (!live || live.grant.resource !== resource || live.tenant.slug !== slug || live.session.id !== validated.props.session_id) return invalid;
  if (!(await credentialUsable(env.HUB_DB, live.identity, live.session, null, live.tenant, "mcp"))) return invalid;
  for (const bucket of ["mcp_grant_minute", "mcp_grant_hour"] as const) {
    const r = await takeRateDetail(env.RATE, bucket, live.grant.id, now);
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
