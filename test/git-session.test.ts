import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { introspect } from "../src/http/internal";
import { credentialUsable } from "../src/auth/context";
import { gitCaller } from "../src/code/gitAccess";
import { createGitSession, GIT_SESSION_TTL_S, getSessionById, revokeSession } from "../src/db/sessions";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const SECRET = "test-internal-secret";

async function introspectAs(token: string, tenant: string): Promise<any> {
  const res = await introspect(new Request("https://hub.internal/internal/introspect", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-internal": SECRET },
    body: JSON.stringify({ token, tenant }),
  }), env);
  return res.json();
}

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const human = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const git = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: acme.id, label: "laptop" }, Date.now());
  return { acme, blue, human, git };
}

describe("batched Git caller authorization", () => {
  it.each([
    ["agent inactive", "UPDATE identity SET state='archived' WHERE id=?", "agent"],
    ["agent membership ended", "UPDATE membership SET state='archived' WHERE identity_id=?", "agent"],
    ["parent revoked", "UPDATE api_token SET revoked_at=1 WHERE id=?", "parent"],
    ["parent belongs to another identity", "UPDATE api_token SET identity_id=(SELECT id FROM identity WHERE kind='human' LIMIT 1) WHERE id=?", "parent"],
    ["parent belongs to another tenant", "UPDATE api_token SET tenant_id=(SELECT id FROM tenant WHERE slug='blue') WHERE id=?", "parent"],
    ["operator inactive", "UPDATE identity SET state='archived' WHERE id=?", "operator"],
    ["operator not human", "UPDATE identity SET kind='agent' WHERE id=?", "operator"],
    ["operator membership ended", "UPDATE membership SET state='archived' WHERE identity_id=?", "operator"],
    ["session revoked", "UPDATE session SET revoked_at=1 WHERE id=?", "session"],
    ["session expired", "UPDATE session SET expires_at=1 WHERE id=?", "session"],
    ["session not pinned", "UPDATE session SET tenant_id=(SELECT id FROM tenant WHERE slug='blue') WHERE id=?", "session"],
    ["browser credential", "UPDATE session SET kind='browser' WHERE id=?", "session"],
    ["parent missing", "UPDATE session SET parent_token_id=NULL WHERE id=?", "session"],
    ["tenant inactive", "UPDATE tenant SET state='archived' WHERE id=?", "tenant"],
  ])("rechecks %s on every call", async (_label, sql, key) => {
    const { acme, human } = await setup(), agent = await seedAgent(acme, human.identity);
    const ids: Record<string, string> = { agent: agent.agent.identity.id, parent: agent.apiToken.id, operator: human.identity.id, session: agent.session.id, tenant: acme.id };
    const auth = `Basic ${btoa(`git:${agent.token}`)}`;
    expect((await gitCaller(env, auth, "acme"))?.role).toBe("member");
    // Valid rows for another org must never rescue a tenant-pinned credential.
    expect(await gitCaller(env, auth, "blue")).toBeNull();
    await env.HUB_DB.prepare(sql!).bind(ids[key!]!).run();
    expect(await gitCaller(env, auth, "acme")).toBeNull();
  });
  it("keeps the agent capped at its live operator role and checks Git sessions live", async () => {
    const { acme, human, git } = await setup(), agent = await seedAgent(acme, human.identity);
    const auth = `Basic ${btoa(`git:${agent.token}`)}`, humanAuth = `Basic ${btoa(`git:${git.token}`)}`;
    expect((await gitCaller(env, humanAuth, "acme"))?.identity.id).toBe(human.identity.id);
    expect(await gitCaller(env, humanAuth, "blue")).toBeNull();
    await env.HUB_DB.prepare("UPDATE membership SET role='reader' WHERE identity_id=?").bind(human.identity.id).run();
    expect((await gitCaller(env, auth, "acme"))?.role).toBe("reader");
    await env.HUB_DB.prepare("UPDATE membership SET state='archived' WHERE identity_id=?").bind(human.identity.id).run();
    expect(await gitCaller(env, humanAuth, "acme")).toBeNull();
  });
});

describe("git sessions", () => {
  it("are pinned to one tenant, last 90 days, and have no parent token", async () => {
    const { acme, human, git } = await setup();
    expect(GIT_SESSION_TTL_S).toBe(90 * 86400);
    expect(git.token.startsWith("pms_")).toBe(true);
    const row = await getSessionById(env.HUB_DB, git.session.id);
    expect(row).toMatchObject({ kind: "git", identity_id: human.identity.id, tenant_id: acme.id, label: "laptop", parent_token_id: null, revoked_at: null });
    expect(row!.expires_at - row!.created_at).toBe(GIT_SESSION_TTL_S * 1000);
  });

  it("introspect on their own tenant only", async () => {
    const { human, git } = await setup();
    expect(await introspectAs(git.token, "acme")).toEqual({
      ok: true,
      identity: { id: human.identity.id, kind: "human", display_name: "m", email: "m@example.com", operator_id: null },
      session: { id: git.session.id, kind: "git", label: "laptop" },
      tenant: { slug: "acme" },
      role: "member",
    });
    expect(await introspectAs(git.token, "blue")).toEqual({ ok: false });
  });

  it("count only on the introspection path", async () => {
    const { acme, blue, human, git } = await setup();
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme, "introspect")).toBe(true);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, blue, "introspect")).toBe(false);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme)).toBe(false);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme, "mcp")).toBe(false);
    // Browser sessions never introspect (ruling A-1).
    expect(await credentialUsable(env.HUB_DB, human.identity, human.session, null, acme, "introspect")).toBe(false);
  });

  it("refuse a valid browser session token on introspection", async () => {
    const { human } = await setup();
    expect(await introspectAs(human.token, "acme")).toEqual({ ok: false });
  });

  it("stop introspecting when the membership ends, the session expires, or it is revoked", async () => {
    const { acme, human, git } = await setup();
    const setMembership = (state: string) => env.HUB_DB.prepare("UPDATE membership SET state = ? WHERE identity_id = ? AND tenant_id = ?").bind(state, human.identity.id, acme.id).run();
    await setMembership("archived");
    expect(await introspectAs(git.token, "acme")).toEqual({ ok: false });
    await setMembership("active");
    expect((await introspectAs(git.token, "acme")).ok).toBe(true);
    await env.HUB_DB.prepare("UPDATE session SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, git.session.id).run();
    expect(await introspectAs(git.token, "acme")).toEqual({ ok: false });
    const other = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: acme.id, label: "desk" }, Date.now());
    expect((await introspectAs(other.token, "acme")).ok).toBe(true);
    await revokeSession(env.HUB_DB, other.session.id, Date.now());
    expect(await introspectAs(other.token, "acme")).toEqual({ ok: false });
  });

  it("record their last use without extending the expiry", async () => {
    const { git } = await setup();
    const before = Date.now() - 2 * 3600_000;
    await env.HUB_DB.prepare("UPDATE session SET last_seen_at = ? WHERE id = ?").bind(before, git.session.id).run();
    expect((await introspectAs(git.token, "acme")).ok).toBe(true);
    const row = await getSessionById(env.HUB_DB, git.session.id);
    expect(row!.last_seen_at).toBeGreaterThan(before);
    expect(row!.expires_at).toBe(git.session.expires_at);
  });

  it("are anonymous on the hub's own API, by bearer or cookie", async () => {
    const { git } = await setup();
    const byBearer = await apiPost("acme.pimwell.test", "whoami", {}, bearer(git.token));
    expect(await byBearer.json()).toEqual({ ok: true, result: { identity: null } });
    const byCookie = await apiPost("acme.pimwell.test", "whoami", {}, cookieHeaders(git.token, "acme.pimwell.test"));
    expect(await byCookie.json()).toEqual({ ok: true, result: { identity: null } });
    expect(byCookie.headers.get("set-cookie") ?? "").toContain("pmw_session=");
    expect((await apiPost("acme.pimwell.test", "session.list", {}, bearer(git.token))).status).toBe(401);
  });
});

describe("session.git", () => {
  it("mints a tenant-pinned git credential for any member, shown once, with an event", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("g@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
    const res = await apiPost("pimwell.test", "session.git", { tenant: "acme", label: " laptop " }, bearer(h.token));
    expect(res.status).toBe(200);
    const r = ((await res.json()) as any).result;
    expect(r).toMatchObject({ username: "g@example.com", tenant: "acme", clone_example: "git clone https://acme.pimwell.test/<repo>.git" });
    expect(r.token.startsWith("pms_")).toBe(true);
    expect(await getSessionById(env.HUB_DB, r.session_id)).toMatchObject({ kind: "git", identity_id: h.identity.id, tenant_id: acme.id, label: "laptop", expires_at: r.expires_at });
    expect((await introspectAs(r.token, "acme")).role).toBe("reader");
    const ev = await env.HUB_DB.prepare("SELECT kind, tenant_id, identity_id, session_id FROM event WHERE kind = 'session.git' AND target_id = ?").bind(r.session_id).first();
    expect(ev).toEqual({ kind: "session.git", tenant_id: acme.id, identity_id: h.identity.id, session_id: h.session.id });
  });

  it("defaults the tenant to the host and 404s tenants the caller is not in", async () => {
    const acme = await seedTenant("acme");
    await seedTenant("cold");
    const h = await seedHuman("g@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const here = ((await (await apiPost("acme.pimwell.test", "session.git", { label: "desk" }, bearer(h.token))).json()) as any).result;
    expect(here.tenant).toBe("acme");
    for (const tenant of ["cold", "nosuch"]) {
      const res = await apiPost("pimwell.test", "session.git", { tenant, label: "x" }, bearer(h.token));
      expect({ tenant, status: res.status, error: ((await res.json()) as any).error }).toEqual({ tenant, status: 404, error: "not_found" });
    }
    const none = await apiPost("pimwell.test", "session.git", { label: "x" }, bearer(h.token));
    expect(none.status).toBe(400);
  });

  it("refuses agents, anonymous callers, a blank label, and a stale proof", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("g@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, h.identity);
    expect((await apiPost("acme.pimwell.test", "session.git", { label: "x" }, bearer(s.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "session.git", { label: "x" })).status).toBe(401);
    expect((await apiPost("acme.pimwell.test", "session.git", { label: "   " }, bearer(h.token))).status).toBe(400);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, h.session.id).run();
    const stale = await apiPost("acme.pimwell.test", "session.git", { label: "x" }, bearer(h.token));
    expect(((await stale.json()) as any).error).toBe("reproof_required");
  });

  it("is minted from the /me form, shown once, and listed with its label", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("g@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const me = await SELF.fetch("https://pimwell.test/me", { headers: cookieHeaders(h.token, "pimwell.test") });
    const page = await me.text();
    expect(page).toContain(`action="/api/session.git"`);
    expect(page).toContain(`name="tenant" value="acme"`);
    const form = await SELF.fetch("https://pimwell.test/api/session.git", {
      method: "POST",
      headers: { ...cookieHeaders(h.token, "pimwell.test"), "content-type": "application/x-www-form-urlencoded" },
      body: "tenant=acme&label=laptop",
    });
    expect(form.status).toBe(200);
    const shown = await form.text();
    expect(shown).toMatch(/pms_[A-Za-z0-9_-]{43}/);
    expect(shown).toContain("git clone https://acme.pimwell.test/&lt;repo&gt;.git");
    expect(shown).toContain("g@example.com");
    const after = await (await SELF.fetch("https://pimwell.test/me", { headers: cookieHeaders(h.token, "pimwell.test") })).text();
    expect(after).toContain("git (laptop)");
    expect(after).not.toMatch(/pms_[A-Za-z0-9_-]{43}/);
  });
});
