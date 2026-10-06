import { env, SELF } from "cloudflare:test";
import { COOKIE_NAME } from "../src/auth/cookie";
import { createTenant } from "../src/db/tenants";
import { createIdentity } from "../src/db/identities";
import { addMembership } from "../src/db/memberships";
import { createBrowserSession } from "../src/db/sessions";
import type { Role } from "../src/db/types";

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
