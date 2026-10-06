import type { Env } from "../env";
import { classifyHost } from "../tenant";
import { OAUTH_SCOPES, issuer, resourceMetadataUrl, tenantResource } from "../oauth/config";
import { notFoundPage } from "./pages";

export function oauthJson(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** RFC 8414 document (MCP spec 7.1). Phase 1: DCR only (no CIMD), scope `read` only. */
export function authorizationServerMetadata(env: Env): Record<string, unknown> {
  const base = issuer(env);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

/** RFC 9728 document for one tenant (MCP spec 4.2): `resource` is exactly the tenant's MCP URL. */
export function protectedResourceMetadata(env: Env, slug: string): Record<string, unknown> {
  return {
    resource: tenantResource(env, slug),
    authorization_servers: [issuer(env)],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/** 401 with the RFC 9728 pointer (MCP spec 7.1). Identical for every valid label, known or not (MCP spec 4.3). */
export function bearerChallenge(env: Env, slug: string, error: "invalid_token" | null): Response {
  const parts = [`resource_metadata="${resourceMetadataUrl(env, slug)}"`, `scope="${OAUTH_SCOPES.join(" ")}"`];
  if (error) parts.unshift(`error="${error}"`);
  return oauthJson({ error: error ?? "unauthorized" }, 401, { "www-authenticate": `Bearer ${parts.join(", ")}` });
}

const PUBLIC = { "access-control-allow-origin": "*" };

export function asMetadataPage(request: Request, env: Env): Response {
  const host = classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN);
  if (host.kind !== "apex") return notFoundPage();
  return oauthJson(authorizationServerMetadata(env), 200, PUBLIC);
}

export function protectedResourcePage(request: Request, env: Env): Response {
  const host = classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN);
  if (host.kind !== "tenant") return notFoundPage();
  return oauthJson(protectedResourceMetadata(env, host.slug), 200, PUBLIC);
}
