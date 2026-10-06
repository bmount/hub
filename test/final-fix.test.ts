import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

const GHOST = "01NONEXISTENT0000000000000";

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, blue, op, s };
}

async function both(verb: string, token: string, real: object, ghost: object) {
  const a = await apiPost("pimwell.test", verb, real, bearer(token));
  const b = await apiPost("pimwell.test", verb, ghost, bearer(token));
  expect(a.status).toBe(404);
  expect(b.status).toBe(404);
  expect(await a.text()).toBe(await b.text());
}

describe("hidden agents", () => {
  it("a blue-only admin sees acme agents exactly like nonexistent ones", async () => {
    const { blue, s } = await setup();
    const ba = await seedHuman("ba@example.com", { memberships: [{ tenant_id: blue.id, role: "admin" }] });
    const id = s.agent.identity.id;
    await both("agent.archive", ba.token, { agent_id: id }, { agent_id: GHOST });
    await both("token.create", ba.token, { agent_id: id, name: "x" }, { agent_id: GHOST, name: "x" });
    await both("token.revoke", ba.token, { token_id: s.apiToken.id }, { token_id: GHOST });
    await both("token.list", ba.token, { agent_id: id }, { agent_id: GHOST });
  });

  it("an operator with an archived or demoted membership gets 404", async () => {
    const { acme, op, s } = await setup();
    const id = s.agent.identity.id;
    const set = (col: string, v: string) => env.HUB_DB.prepare(`UPDATE membership SET ${col} = ? WHERE identity_id = ? AND tenant_id = ?`).bind(v, op.identity.id, acme.id).run();
    await set("state", "archived");
    await both("token.create", op.token, { agent_id: id, name: "x" }, { agent_id: GHOST, name: "x" });
    await both("agent.archive", op.token, { agent_id: id }, { agent_id: GHOST });
    await set("state", "active");
    await set("role", "reader");
    await both("token.create", op.token, { agent_id: id, name: "x" }, { agent_id: GHOST, name: "x" });
    await both("agent.archive", op.token, { agent_id: id }, { agent_id: GHOST });
  });
});

describe("session.revoke authority", () => {
  it("an operator demoted to reader can no longer revoke the agent's run", async () => {
    const { acme, op, s } = await setup();
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ? AND tenant_id = ?").bind(op.identity.id, acme.id).run();
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: s.session.id }, bearer(op.token))).status).toBe(404);
  });

  it("an admin may revoke agent runs but not another human's tenant-bound browser session", async () => {
    const { acme, s } = await setup();
    const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    await env.HUB_DB.prepare("UPDATE session SET tenant_id = ? WHERE id = ?").bind(acme.id, member.session.id).run();
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: member.session.id }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: s.session.id }, bearer(admin.token))).status).toBe(200);
  });
});

describe("misc hardening", () => {
  it("rejects a blank session.start label", async () => {
    const { s } = await setup();
    const res = await apiPost("acme.pimwell.test", "session.start", { label: "   " }, bearer(s.longLived));
    expect(res.status).toBe(400);
  });

  it("answers 404 on an unknown host for every verb", async () => {
    const h = await seedHuman("a@example.com");
    for (const verb of ["whoami", "session.list"]) {
      const res = await apiPost("evil.example.org", verb, {}, bearer(h.token));
      expect(res.status).toBe(404);
    }
  });
});
