import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getApiTokenById } from "../src/db/apiTokens";
import { getSessionByToken } from "../src/db/sessions";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

const DAY = 86_400_000;

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, blue, op, s };
}
const start = (host: string, token: string, body: object = { label: "nightly" }) => apiPost(host, "session.start", body, bearer(token));
const list = (host: string, token: string) => apiPost(host, "project.list", {}, bearer(token));

describe("session.start", () => {
  it("trades a long-lived token for a 24 hour run pinned to the tenant", async () => {
    const { acme, s } = await setup();
    const before = Date.now();
    const res = await start("acme.pimwell.test", s.longLived);
    expect(res.status).toBe(200);
    const r = ((await res.json()) as any).result;
    expect(r.session_token).toMatch(/^pms_/);
    expect(r.tenant).toBe("acme");
    expect(r.expires_at).toBeGreaterThanOrEqual(before + DAY);
    expect(r.expires_at).toBeLessThanOrEqual(Date.now() + DAY);
    const row = await getSessionByToken(env.HUB_DB, r.session_token, Date.now());
    expect(row).toMatchObject({ id: r.session_id, kind: "agent_run", tenant_id: acme.id, label: "nightly", parent_token_id: s.apiToken.id, identity_id: s.agent.identity.id });
    expect((await getApiTokenById(env.HUB_DB, s.apiToken.id))!.last_used_at).not.toBeNull();
    const ev = await env.HUB_DB.prepare("SELECT tenant_id, identity_id, session_id, summary FROM event WHERE kind = 'session.start'").first<Record<string, string>>();
    expect(ev).toMatchObject({ tenant_id: acme.id, identity_id: s.agent.identity.id, session_id: r.session_id });
    expect(ev!.summary).not.toContain(s.longLived);
    expect(ev!.summary).not.toContain(r.session_token);

    expect((await list("acme.pimwell.test", r.session_token)).status).toBe(200);
    expect((await list("blue.pimwell.test", r.session_token)).status).toBe(404);
    const who = (await (await apiPost("pimwell.test", "whoami", {}, bearer(r.session_token))).json()) as any;
    expect(who.result.identity).toBeNull();
  });

  it("rolls back the run and token use if auditing fails", async () => {
    const { s } = await setup();
    const before = await getApiTokenById(env.HUB_DB, s.apiToken.id);
    const count = () => env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM session WHERE parent_token_id = ?").bind(s.apiToken.id).first<{ n: number }>();
    const runs = await count();
    await env.HUB_DB.exec("CREATE TRIGGER fail_run_audit BEFORE INSERT ON event WHEN NEW.kind = 'session.start' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    try {
      expect((await start("acme.pimwell.test", s.longLived)).status).toBe(500);
      expect(await count()).toEqual(runs);
      expect((await getApiTokenById(env.HUB_DB, s.apiToken.id))!.last_used_at).toBe(before!.last_used_at);
    } finally {
      await env.HUB_DB.exec("DROP TRIGGER fail_run_audit");
    }
  });

  it("records every run without moving token use backwards", async () => {
    const { s } = await setup();
    const future = Date.now() + DAY;
    await env.HUB_DB.prepare("UPDATE api_token SET last_used_at = ? WHERE id = ?").bind(future, s.apiToken.id).run();
    for (let n = 0; n < 2; n++) expect((await start("acme.pimwell.test", s.longLived)).status).toBe(200);
    expect((await getApiTokenById(env.HUB_DB, s.apiToken.id))!.last_used_at).toBe(future);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'session.start'").first()).toEqual({ n: 2 });
  });

  it("honours ttl bounds in seconds", async () => {
    const { s } = await setup();
    const before = Date.now();
    const hour = ((await (await start("acme.pimwell.test", s.longLived, { label: "x", ttl: 3600 })).json()) as any).result;
    expect(hour.expires_at).toBeGreaterThanOrEqual(before + 3600_000);
    expect(hour.expires_at).toBeLessThanOrEqual(Date.now() + 3600_000);
    expect((await start("acme.pimwell.test", s.longLived, { label: "x", ttl: 604800 })).status).toBe(200);
    for (const ttl of [59, 604801, "abc", -5]) expect((await start("acme.pimwell.test", s.longLived, { label: "x", ttl })).status).toBe(400);
    expect((await start("acme.pimwell.test", s.longLived, {})).status).toBe(400);
  });

  it("needs a long-lived token, on its own tenant", async () => {
    const { op, s } = await setup();
    expect((await start("acme.pimwell.test", s.token)).status).toBe(403);
    expect((await start("acme.pimwell.test", op.token)).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "session.start", { label: "x" })).status).toBe(404);
    expect((await start("blue.pimwell.test", s.longLived)).status).toBe(404);
    expect((await start("pimwell.test", s.longLived)).status).toBe(404);
  });
});

describe("revocation cascade", () => {
  it("revoking the token ends its runs and blocks new ones", async () => {
    const { op, s } = await setup();
    const r = ((await (await start("acme.pimwell.test", s.longLived)).json()) as any).result;
    const res = await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(op.token));
    expect(((await res.json()) as any).result.sessions_revoked).toBe(2);
    expect((await list("acme.pimwell.test", r.session_token)).status).toBe(404);
    expect((await list("acme.pimwell.test", s.token)).status).toBe(404);
    expect((await start("acme.pimwell.test", s.longLived)).status).toBe(404);
  });

  it("archiving the agent ends everything", async () => {
    const { op, s } = await setup();
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(op.token))).status).toBe(200);
    expect((await list("acme.pimwell.test", s.token)).status).toBe(404);
    expect((await start("acme.pimwell.test", s.longLived)).status).toBe(404);
  });

  it("pauses the agent while its operator is not an active member, and resumes after", async () => {
    const { acme, op, s } = await setup();
    const setState = (state: string) => env.HUB_DB.prepare("UPDATE membership SET state = ? WHERE identity_id = ? AND tenant_id = ?").bind(state, op.identity.id, acme.id).run();
    await setState("archived");
    expect((await list("acme.pimwell.test", s.token)).status).toBe(404);
    expect((await start("acme.pimwell.test", s.longLived)).status).toBe(404);
    await setState("active");
    expect((await list("acme.pimwell.test", s.token)).status).toBe(200);
    expect((await start("acme.pimwell.test", s.longLived)).status).toBe(200);
  });
});

describe("session.revoke and session.end for runs", () => {
  it("lets the operator and a tenant admin revoke a run, and nobody else", async () => {
    const { acme, op, s } = await setup();
    const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
    const other = await seedHuman("o@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: s.session.id }, bearer(other.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: op.session.id }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: s.session.id }, bearer(op.token))).status).toBe(200);
    expect(await getSessionByToken(env.HUB_DB, s.token, Date.now())).toBeNull();
    const ev = await env.HUB_DB.prepare("SELECT tenant_id FROM event WHERE kind = 'session.revoke'").first<{ tenant_id: string }>();
    expect(ev!.tenant_id).toBe(acme.id);
    const r = ((await (await start("acme.pimwell.test", s.longLived)).json()) as any).result;
    expect((await apiPost("acme.pimwell.test", "session.revoke", { session_id: r.session_id }, bearer(admin.token))).status).toBe(200);
    expect(await getSessionByToken(env.HUB_DB, r.session_token, Date.now())).toBeNull();
  });

  it("lets the agent end its own run on its tenant", async () => {
    const { s } = await setup();
    expect((await apiPost("acme.pimwell.test", "session.end", {}, bearer(s.token))).status).toBe(200);
    expect(await getSessionByToken(env.HUB_DB, s.token, Date.now())).toBeNull();
  });
});
