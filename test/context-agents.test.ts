import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/auth/context";
import { createApiToken } from "../src/db/apiTokens";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const db = () => env.HUB_DB;
const ctxFor = (host: string, headers: Record<string, string>, now = Date.now() + 1) =>
  buildContext(new Request(`https://${host}/`, { headers }), env, now);

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, blue, op, s };
}

describe("agent credentials in buildContext", () => {
  it("resolves a pmw_ token on its own tenant as the agent, with no session", async () => {
    const { acme, s } = await setup();
    const ctx = await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.longLived}` });
    expect(ctx.authKind).toBe("token");
    expect(ctx.apiToken?.id).toBe(s.apiToken.id);
    expect(ctx.identity?.id).toBe(s.agent.identity.id);
    expect(ctx.session).toBeNull();
    expect(ctx.tenant?.id).toBe(acme.id);
    expect(ctx.role).toBe("member");
  });

  it("resolves a run session on its own tenant", async () => {
    const { s } = await setup();
    const ctx = await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` });
    expect(ctx.authKind).toBe("bearer");
    expect(ctx.session?.kind).toBe("agent_run");
    expect(ctx.apiToken).toBeNull();
    expect(ctx.role).toBe("member");
  });

  it("is anonymous on the apex and on another tenant, even one the operator belongs to", async () => {
    const { s } = await setup();
    for (const host of ["pimwell.test", "blue.pimwell.test"]) {
      for (const tok of [s.longLived, s.token]) {
        const ctx = await ctxFor(host, { authorization: `Bearer ${tok}` });
        expect(ctx.identity).toBeNull();
        expect(ctx.session).toBeNull();
        expect(ctx.apiToken).toBeNull();
        expect(ctx.authKind).toBeNull();
        expect(ctx.role).toBeNull();
      }
    }
  });

  it("never accepts an agent session from a cookie", async () => {
    const { s } = await setup();
    const ctx = await ctxFor("acme.pimwell.test", { cookie: `pmw_session=${s.token}` });
    expect(ctx.identity).toBeNull();
    expect(ctx.staleCookie).toBe(true);
  });

  it("stops while the operator is not an active member or is archived, and resumes when restored", async () => {
    const { acme, op, s } = await setup();
    const check = async () => (await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` })).identity?.id ?? null;
    const checkToken = async () => (await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.longLived}` })).identity?.id ?? null;
    await db().prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(op.identity.id, acme.id).run();
    expect(await check()).toBeNull();
    expect(await checkToken()).toBeNull();
    await db().prepare("UPDATE membership SET state = 'active' WHERE identity_id = ? AND tenant_id = ?").bind(op.identity.id, acme.id).run();
    expect(await check()).toBe(s.agent.identity.id);
    await db().prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(op.identity.id).run();
    expect(await check()).toBeNull();
    expect(await checkToken()).toBeNull();
  });

  it("accepts a root operator with no membership", async () => {
    const acme = await seedTenant("acme");
    const root = await seedHuman("root@example.com", { is_root: true });
    const s = await seedAgent(acme, root.identity);
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` })).identity?.id).toBe(s.agent.identity.id);
  });

  it("rejects a run whose parent token is revoked even if the run row was not", async () => {
    const { s } = await setup();
    await db().prepare("UPDATE api_token SET revoked_at = ? WHERE id = ?").bind(Date.now(), s.apiToken.id).run();
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` })).identity).toBeNull();
  });

  it("rejects an archived agent, an expired token, and a token held by a human", async () => {
    const { acme, op, s } = await setup();
    const now = Date.now();
    const short = await createApiToken(db(), { identity_id: s.agent.identity.id, tenant_id: acme.id, name: "short", created_by: op.identity.id, expires_at: now + 1000 }, now);
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${short.plaintext}` }, now + 500)).identity).not.toBeNull();
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${short.plaintext}` }, now + 2000)).identity).toBeNull();
    const human = await createApiToken(db(), { identity_id: op.identity.id, tenant_id: acme.id, name: "h", created_by: op.identity.id, expires_at: null }, now);
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${human.plaintext}` })).identity).toBeNull();
    await db().prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(s.agent.identity.id).run();
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.longLived}` })).identity).toBeNull();
  });

  it("does not touch a run used on the wrong host", async () => {
    const { s } = await setup();
    const later = Date.now() + 2 * 3600_000;
    await ctxFor("blue.pimwell.test", { authorization: `Bearer ${s.token}` }, later);
    const row = await db().prepare("SELECT last_seen_at FROM session WHERE id = ?").bind(s.session.id).first<{ last_seen_at: number }>();
    expect(row!.last_seen_at).toBe(s.session.last_seen_at);
  });
});
