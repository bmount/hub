import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext, credentialUsable } from "../src/auth/context";
import { introspect } from "../src/http/internal";
import { createApiToken } from "../src/db/apiTokens";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const db = () => env.HUB_DB;
const ctxFor = (host: string, headers: Record<string, string>, now = Date.now() + 1) =>
  buildContext(new Request(`https://${host}/`, { headers }), env, now, undefined, { longLivedToken: true });

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, blue, op, s };
}

describe("agent credentials in buildContext", () => {
  it("authenticates each chat command from one live batch without page aggregates", async () => {
    const { op, s } = await setup();
    let batches = 0;
    const prepared: string[] = [];
    const measured = new Proxy(db(), { get(target, key) {
      if (key === 'prepare') return (sql: string) => { prepared.push(sql); return target.prepare(sql); };
      if (key === 'batch') return (statements: D1PreparedStatement[]) => { batches++; return target.batch(statements); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const request = (headers: Record<string, string>) => new Request('https://acme.pimwell.test/chat/v1/getUpdates', { headers });
    const agent = await buildContext(request({ authorization: `Bearer ${s.token}` }), { ...env, HUB_DB: measured });
    expect(agent.identity?.id).toBe(s.agent.identity.id);
    expect(agent.rail).toBeUndefined(); expect(agent.explorer).toBeUndefined();
    expect(batches).toBe(1); expect(prepared).toHaveLength(7);
    prepared.length = 0; batches = 0;
    const human = await buildContext(request({ cookie: `pmw_session=${op.token}` }), { ...env, HUB_DB: measured });
    expect(human.identity?.id).toBe(op.identity.id);
    expect(human.rail).toBeUndefined(); expect(human.explorer).toBeUndefined();
    expect(batches).toBe(1); expect(prepared).toHaveLength(4);
  });

  it.each(['parent identity', 'parent tenant', 'own membership', 'operator kind', 'operator membership'])('refuses changed %s evidence on the next batched chat authentication', async change => {
    const { acme, blue, op, s } = await setup();
    const request = () => new Request('https://acme.pimwell.test/chat/v1/getUpdates', { headers: { authorization: `Bearer ${s.token}` } });
    expect((await buildContext(request(), env)).identity?.id).toBe(s.agent.identity.id);
    if (change === 'parent identity') await db().prepare('UPDATE api_token SET identity_id = ? WHERE id = ?').bind(op.identity.id, s.apiToken.id).run();
    if (change === 'parent tenant') await db().prepare('UPDATE api_token SET tenant_id = ? WHERE id = ?').bind(blue.id, s.apiToken.id).run();
    if (change === 'own membership') await db().prepare("UPDATE membership SET state = 'archived' WHERE tenant_id = ? AND identity_id = ?").bind(acme.id, s.agent.identity.id).run();
    if (change === 'operator kind') await db().prepare("UPDATE identity SET kind = 'agent' WHERE id = ?").bind(op.identity.id).run();
    if (change === 'operator membership') await db().prepare('DELETE FROM membership WHERE tenant_id = ? AND identity_id = ?').bind(acme.id, op.identity.id).run();
    expect((await buildContext(request(), env)).identity).toBeNull();
  });

  it.each(['run', 'api', 'introspect'])('authenticates %s with one batch and no standalone reads', async mode => {
    const { s } = await setup();
    let batches = 0;
    const prepared: string[] = [];
    const measured = new Proxy(db(), { get(target, key) {
      if (key === 'prepare') return (sql: string) => { prepared.push(sql); return target.prepare(sql); };
      if (key === 'batch') return (statements: D1PreparedStatement[]) => { batches++; return target.batch(statements); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const e = { ...env, HUB_DB: measured };
    if (mode === 'introspect') {
      const response = await introspect(new Request('https://pimwell.test/internal/introspect', {
        method: 'POST', headers: { 'x-hub-internal': 'test-internal-secret' },
        body: JSON.stringify({ token: s.token, tenant: 'acme' }),
      }), e);
      expect(await response.json()).toMatchObject({ ok: true, role: 'member', identity: { id: s.agent.identity.id } });
    } else {
      const ctx = await buildContext(new Request('https://acme.pimwell.test/api/whoami', {
        headers: { authorization: `Bearer ${mode === 'api' ? s.longLived : s.token}` },
      }), e, Date.now(), undefined, { longLivedToken: true });
      expect(ctx.identity?.id).toBe(s.agent.identity.id);
      expect(ctx.role).toBe('member');
    }
    expect(batches).toBe(1);
    expect(prepared).toHaveLength(7);
  });

  it.each(['revoked token', 'inactive agent', 'inactive operator', 'removed operator', 'operator kind', 'removed operator membership', 'inactive operator membership', 'removed own membership'])('rejects %s on the next API-token snapshot', async change => {
    const { acme, op, s } = await setup();
    const check = () => ctxFor('acme.pimwell.test', { authorization: `Bearer ${s.longLived}` });
    expect((await check()).identity?.id).toBe(s.agent.identity.id);
    if (change === 'revoked token') await db().prepare('UPDATE api_token SET revoked_at = ? WHERE id = ?').bind(Date.now(), s.apiToken.id).run();
    if (change === 'inactive agent') await db().prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(s.agent.identity.id).run();
    if (change === 'inactive operator') await db().prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(op.identity.id).run();
    if (change === 'removed operator') await db().prepare('UPDATE identity SET operator_id = NULL WHERE id = ?').bind(s.agent.identity.id).run();
    if (change === 'operator kind') await db().prepare("UPDATE identity SET kind = 'agent' WHERE id = ?").bind(op.identity.id).run();
    if (change === 'removed operator membership') await db().prepare('DELETE FROM membership WHERE identity_id = ? AND tenant_id = ?').bind(op.identity.id, acme.id).run();
    if (change === 'inactive operator membership') await db().prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(op.identity.id, acme.id).run();
    if (change === 'removed own membership') await db().prepare('DELETE FROM membership WHERE identity_id = ? AND tenant_id = ?').bind(s.agent.identity.id, acme.id).run();
    expect((await check()).identity).toBeNull();
  });

  it('keeps synthetic credentials confined even with prefetched evidence', async () => {
    const { acme, s } = await setup();
    const synthetic = { ...s.agent.identity, id: 'perf-synthetic-member' };
    expect(await credentialUsable(db(), synthetic, s.session, null, acme)).toBe(false);
    expect(await credentialUsable(db(), synthetic, null, s.apiToken, { ...acme, id: 'perf-synthetic-tenant' })).toBe(false);
  });

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
    for (const token of [s.token, s.longLived]) {
      expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${token}` })).identity?.id).toBe(s.agent.identity.id);
    }
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

  it("resolves a pmw_ token to anonymous unless the caller opts in", async () => {
    const { s } = await setup();
    const ctx = await buildContext(new Request("https://acme.pimwell.test/", { headers: { authorization: `Bearer ${s.longLived}` } }), env, Date.now() + 1);
    expect(ctx.identity).toBeNull();
    expect(ctx.apiToken).toBeNull();
    expect(ctx.authKind).toBeNull();
  });

  it("rejects an agent whose own membership is archived, and a run with no parent token", async () => {
    const { acme, s } = await setup();
    await db().prepare("UPDATE session SET parent_token_id = NULL WHERE id = ?").bind(s.session.id).run();
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` })).identity).toBeNull();
    await db().prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(s.agent.identity.id, acme.id).run();
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.longLived}` })).identity).toBeNull();
  });
});
