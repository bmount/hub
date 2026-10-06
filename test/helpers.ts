import { env, SELF } from "cloudflare:test";
import { COOKIE_NAME } from "../src/auth/cookie";
import { createTenant } from "../src/db/tenants";
import { createIdentity } from "../src/db/identities";
import { addMembership } from "../src/db/memberships";
import { createAgent } from "../src/db/agents";
import { createApiToken } from "../src/db/apiTokens";
import { AGENT_SESSION_DEFAULT_TTL_S, createAgentSession, createBrowserSession } from "../src/db/sessions";
import { createGrant } from "../src/db/oauthGrants";
import type { Identity, Role, Session, Tenant } from "../src/db/types";

export function apiPost(host: string, verb: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://${host}/api/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function seedTenant(slug: string) {
  return createTenant(env.HUB_DB, { slug, display_name: slug.toUpperCase() }, Date.now());
}

export async function seedHuman(email: string, opts: { is_root?: boolean; memberships?: Array<{ tenant_id: string; role: Role }> } = {}) {
  const identity = await createIdentity(env.HUB_DB, { kind: "human", email, display_name: email.split("@")[0]!, is_root: opts.is_root ? 1 : 0, operator_id: null }, Date.now());
  for (const m of opts.memberships ?? []) await addMembership(env.HUB_DB, { identity_id: identity.id, tenant_id: m.tenant_id, role: m.role }, Date.now());
  const { session, token } = await createBrowserSession(env.HUB_DB, identity.id, Date.now());
  return { identity, session, token };
}

export function cookieHeaders(token: string, host: string): Record<string, string> {
  return { cookie: `${COOKIE_NAME}=${token}`, origin: `https://${host}` };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function seedAgent(tenant: Tenant, operator: Identity, slug = "bot", role: "member" | "reader" = "member") {
  const agent = await createAgent(env.HUB_DB, { tenant, slug, display_name: slug, operator_id: operator.id, role, hubDomain: env.HUB_DOMAIN }, Date.now());
  const { token: apiToken, plaintext: longLived } = await createApiToken(env.HUB_DB, { identity_id: agent.identity.id, tenant_id: tenant.id, name: "ci", created_by: operator.id, expires_at: null }, Date.now());
  const { session, token } = await createAgentSession(env.HUB_DB, { identity_id: agent.identity.id, tenant_id: tenant.id, label: "run-1", parent_token_id: apiToken.id, ttl_s: AGENT_SESSION_DEFAULT_TTL_S }, Date.now());
  return { agent, apiToken, longLived, session, token };
}

/** A live assistant grant for `human` on `tenant`, as oauth.grant.approve writes it (no library grant). */
export function seedGrant(tenant: Tenant, human: { identity: Identity; session: Session }, client_id = "client-1") {
  return createGrant(env.HUB_DB, {
    identity_id: human.identity.id, tenant_id: tenant.id, client_id, client_name: "Test App", client_kind: "dcr",
    redirect_host: "loopback", resource: `https://${tenant.slug}.${env.HUB_DOMAIN}/mcp`, scopes: ["read"],
    approved_by_session_id: human.session.id, last_proof_at: human.session.last_proof_at,
  }, Date.now());
}
