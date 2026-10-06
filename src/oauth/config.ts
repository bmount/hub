import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { classifyHost } from "../tenant";

/** Phase 1 grants `read` only; `write` arrives in phase 2 (MCP spec 13). */
export const OAUTH_SCOPES: readonly string[] = ["read"];
export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_IDLE_TTL_S = 30 * 24 * 3600;
export const CLIENT_UNUSED_TTL_S = 30 * 24 * 3600;
export const PENDING_TTL_S = 30 * 60;
export const CONSENT_FRESH_PROOF_MINUTES = 600;

export const issuer = (env: Env): string => `https://${env.HUB_DOMAIN}`;
export const tenantResource = (env: Env, slug: string): string => `https://${slug}.${env.HUB_DOMAIN}/mcp`;
export const resourceMetadataUrl = (env: Env, slug: string): string => `https://${slug}.${env.HUB_DOMAIN}/.well-known/oauth-protected-resource/mcp`;
/** `mcp` is a reserved label (identity spec 5), so this resource can never be a tenant's. */
export const sentinelResource = (env: Env): string => `https://mcp.${env.HUB_DOMAIN}/mcp`;

/** The tenant label of an exact tenant MCP resource (lowercase, https, no port, no trailing slash), else null (MCP spec 4.2). */
export function tenantOfResource(env: Env, resource: string | null | undefined): string | null {
  if (!resource) return null;
  const m = /^https:\/\/([a-z0-9-]+)\.([a-z0-9.-]+)\/mcp$/.exec(resource);
  if (!m || m[2] !== env.HUB_DOMAIN.toLowerCase()) return null;
  const host = classifyHost(`${m[1]}.${m[2]}`, env.HUB_DOMAIN);
  return host.kind === "tenant" ? host.slug : null;
}

/**
 * The library's grant id from one of its tokens or codes. The format `{userId}:{grantId}:{secret}` is
 * documented on the library's `Token` type; identity ids are ULIDs, so they never contain `:`.
 */
export function libraryGrantIdOf(token: string): string | null {
  const parts = token.split(":");
  return parts.length === 3 && parts[0] && parts[1] && parts[2] ? parts[1] : null;
}

/**
 * The authorization server, built per request. The library fixes its resource registry at construction
 * and every tenant is a resource, so the registry is the one resource this request concerns plus a
 * sentinel. With the sentinel present, a request naming no resource or an unknown one fails inside the
 * library with `invalid_target`, redirected only once client and redirect URI are validated.
 */
export function authServer(env: Env, resource: string | null): OAuthAuthorizationServer<Env> {
  const sentinel = sentinelResource(env);
  const base = issuer(env);
  return new OAuthAuthorizationServer<Env>({
    issuer: base,
    resources: resource && tenantOfResource(env, resource) ? [resource, sentinel] : [sentinel],
    authorizeEndpoint: `${base}/oauth/authorize`,
    tokenEndpoint: `${base}/oauth/token`,
    clientRegistrationEndpoint: `${base}/oauth/register`,
    scopesSupported: [...OAUTH_SCOPES],
    accessTokenTTL: ACCESS_TOKEN_TTL_S,
    refreshTokenTTL: REFRESH_IDLE_TTL_S,
    refreshTokenIdleTTL: REFRESH_IDLE_TTL_S,
    clientRegistrationTTL: CLIENT_UNUSED_TTL_S,
    // Never log descriptions or requests: they can echo client input (MCP spec 3).
    onError: ({ status, code }) => { console.log("oauth error", status, code); },
  });
}
