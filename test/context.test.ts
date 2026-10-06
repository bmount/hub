import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext, rank, roleFor } from "../src/auth/context";
import { createTenant, setTenantState } from "../src/db/tenants";
import { createIdentity } from "../src/db/identities";
import { addMembership } from "../src/db/memberships";
import { createBrowserSession, revokeSession } from "../src/db/sessions";
import { COOKIE_NAME } from "../src/auth/cookie";

const db = () => env.HUB_DB;
const now = 1_700_000_000_000;

async function seed() {
  const tenant = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
  const identity = await createIdentity(db(), { kind: "human", email: "a@example.com", display_name: "A", is_root: 0, operator_id: null }, now);
  await addMembership(db(), { identity_id: identity.id, tenant_id: tenant.id, role: "admin" }, now);
  const { session, token } = await createBrowserSession(db(), identity.id, now);
  return { tenant, identity, session, token };
}

describe("buildContext", () => {
  it("resolves tenant, identity and role from a cookie", async () => {
    const s = await seed();
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.host).toEqual({ kind: "tenant", slug: "acme" });
    expect(ctx.tenant?.id).toBe(s.tenant.id);
    expect(ctx.identity?.id).toBe(s.identity.id);
    expect(ctx.role).toBe("admin");
    expect(ctx.authKind).toBe("cookie");
    expect(ctx.staleCookie).toBe(false);
  });

  it("prefers a bearer session token and reports no role off-tenant", async () => {
    const s = await seed();
    const req = new Request("https://pimwell.test/", { headers: { authorization: `Bearer ${s.token}`, cookie: `${COOKIE_NAME}=pms_stale` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.authKind).toBe("bearer");
    expect(ctx.identity?.id).toBe(s.identity.id);
    expect(ctx.tenant).toBeNull();
    expect(ctx.role).toBeNull();
  });

  it("treats a revoked session cookie as anonymous and flags it stale", async () => {
    const s = await seed();
    await revokeSession(db(), s.session.id, now + 1);
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 2);
    expect(ctx.identity).toBeNull();
    expect(ctx.staleCookie).toBe(true);
  });

  it("archived tenant resolves to no tenant", async () => {
    const s = await seed();
    await setTenantState(db(), s.tenant.id, "archived", now + 1);
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 2);
    expect(ctx.tenant).toBeNull();
    expect(ctx.role).toBeNull();
  });

  it("root gets role root on any tenant without a membership", async () => {
    const tenant = await createTenant(db(), { slug: "blue", display_name: "Blue" }, now);
    const root = await createIdentity(db(), { kind: "human", email: "r@example.com", display_name: "R", is_root: 1, operator_id: null }, now);
    const { token } = await createBrowserSession(db(), root.id, now);
    const req = new Request("https://blue.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.tenant?.id).toBe(tenant.id);
    expect(ctx.role).toBe("root");
  });
});

describe("roleFor and rank", () => {
  it("orders roles", () => {
    expect(rank("root") > rank("admin") && rank("admin") > rank("member") && rank("member") > rank("reader") && rank("reader") > rank(null)).toBe(true);
    expect(roleFor(null, null)).toBeNull();
  });
});
