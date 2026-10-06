import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getApiTokenByToken } from "../src/db/apiTokens";
import { getSessionByToken } from "../src/db/sessions";
import { archiveAgent } from "../src/db/agents";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

async function setup() {
  const acme = await seedTenant("acme");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const other = await seedHuman("o@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, admin, op, other, s };
}

describe("token.create", () => {
  it("returns the plaintext once and stores only its hash", async () => {
    const { acme, op, s } = await setup();
    const before = Date.now();
    const res = await apiPost("pimwell.test", "token.create", { agent_id: s.agent.identity.id, name: "deploy", expires_in_days: 30 }, bearer(op.token));
    expect(res.status).toBe(200);
    const r = ((await res.json()) as any).result;
    expect(r.token).toMatch(/^pmw_[A-Za-z0-9_-]{43}$/);
    expect(r).toMatchObject({ name: "deploy", agent_id: s.agent.identity.id, agent: "bot@acme.pimwell.test", tenant: "acme" });
    expect(r.start_url).toBe("https://acme.pimwell.test/api/session.start");
    expect(r.expires_at).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
    expect(r.expires_at).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000);
    expect((await getApiTokenByToken(env.HUB_DB, r.token, Date.now()))!.id).toBe(r.token_id);
    const ev = await env.HUB_DB.prepare("SELECT tenant_id, session_id, target_id, summary FROM event WHERE kind = 'token.create'").first<Record<string, string>>();
    expect(ev).toMatchObject({ tenant_id: acme.id, session_id: op.session.id, target_id: r.token_id });
    expect(ev!.summary).not.toContain(r.token);
    const list = await (await apiPost("pimwell.test", "token.list", { agent_id: s.agent.identity.id }, bearer(op.token))).text();
    expect(list).not.toContain(r.token);
    expect(list).not.toContain("token_hash");
  });

  it("validates expiry and refuses non-managers, agents, archived agents, and stale proof", async () => {
    const { admin, op, other, s } = await setup();
    const body = { agent_id: s.agent.identity.id, name: "x" };
    expect((await apiPost("pimwell.test", "token.create", { ...body, expires_in_days: 0 }, bearer(op.token))).status).toBe(400);
    expect((await apiPost("pimwell.test", "token.create", { ...body, expires_in_days: 366 }, bearer(op.token))).status).toBe(400);
    expect((await apiPost("pimwell.test", "token.create", { ...body, name: "" }, bearer(op.token))).status).toBe(400);
    expect((await apiPost("pimwell.test", "token.create", { ...body, name: "   " }, bearer(op.token))).status).toBe(400);
    const forever = ((await (await apiPost("pimwell.test", "token.create", body, bearer(op.token))).json()) as any).result;
    expect(forever.expires_at).toBeNull();
    expect((await apiPost("pimwell.test", "token.create", body, bearer(other.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "token.create", body, bearer(s.token))).status).toBe(403);
    expect((await apiPost("pimwell.test", "token.create", body, bearer(admin.token))).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, op.session.id).run();
    expect(((await (await apiPost("pimwell.test", "token.create", body, bearer(op.token))).json()) as any).error).toBe("reproof_required");
    await archiveAgent(env.HUB_DB, s.agent.identity.id, Date.now());
    expect((await apiPost("pimwell.test", "token.create", body, bearer(admin.token))).status).toBe(409);
  });

  it("shows the token on a page for form posts", async () => {
    const { op, s } = await setup();
    const res = await SELF.fetch("https://pimwell.test/api/token.create", {
      method: "POST", redirect: "manual",
      headers: { ...cookieHeaders(op.token, "pimwell.test"), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ agent_id: s.agent.identity.id, name: "<b>web</b>" }).toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toMatch(/pmw_[A-Za-z0-9_-]{43}/);
    expect(html).toContain("will not be shown again");
    expect(html).toContain("&lt;b&gt;web&lt;/b&gt;");
    expect(html).not.toContain("<b>web</b>");
    expect(html).toContain("https://acme.pimwell.test/api/session.start");
  });
});

describe("token.revoke", () => {
  it("revokes the token and its sessions for the operator, once", async () => {
    const { acme, op, s } = await setup();
    const res = await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(op.token));
    expect(((await res.json()) as any).result).toEqual({ ok: true, sessions_revoked: 1 });
    expect(await getSessionByToken(env.HUB_DB, s.token, Date.now())).toBeNull();
    const ev = await env.HUB_DB.prepare("SELECT tenant_id, target_id FROM event WHERE kind = 'token.revoke'").first<Record<string, string>>();
    expect(ev).toEqual({ tenant_id: acme.id, target_id: s.apiToken.id });
    expect((await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(op.token))).status).toBe(409);
  });

  it("answers identically for an unmanageable token and a nonexistent one", async () => {
    const { s } = await setup();
    const blue = await seedTenant("blue");
    const blueAdmin = await seedHuman("ba@example.com", { memberships: [{ tenant_id: blue.id, role: "admin" }] });
    const a = await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(blueAdmin.token));
    const b = await apiPost("pimwell.test", "token.revoke", { token_id: "01NONEXISTENT0000000000000" }, bearer(blueAdmin.token));
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
  });

  it("lets an admin revoke and hides tokens from other members", async () => {
    const { admin, other, s } = await setup();
    expect((await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(other.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "token.revoke", { token_id: "NOPE" }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(s.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(admin.token))).status).toBe(200);
  });
});

describe("token.list", () => {
  it("lists by agent, by operator, and for admins by tenant", async () => {
    const { acme, admin, op, other, s } = await setup();
    const theirs = await seedAgent(acme, other.identity, "theirs");
    const ids = async (host: string, body: object, token: string) =>
      (((await (await apiPost(host, "token.list", body, bearer(token))).json()) as any).result.tokens as any[]).map((t) => t.id).sort();
    expect(await ids("pimwell.test", {}, op.token)).toEqual([s.apiToken.id]);
    expect(await ids("acme.pimwell.test", {}, op.token)).toEqual([s.apiToken.id]);
    expect(await ids("acme.pimwell.test", {}, admin.token)).toEqual([s.apiToken.id, theirs.apiToken.id].sort());
    expect(await ids("pimwell.test", { agent_id: theirs.agent.identity.id }, admin.token)).toEqual([theirs.apiToken.id]);
    expect((await apiPost("pimwell.test", "token.list", { agent_id: theirs.agent.identity.id }, bearer(op.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "token.list", {})).status).toBe(401);
  });
});
