import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grantConsent } from "../src/db/consent";
import { createAgent } from "../src/db/agents";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const get = (host: string, headers: Record<string, string> = {}) => SELF.fetch(`https://${host}/me`, { headers });

describe("/me", () => {
  it("is the apex account page for a signed-in human only", async () => {
    const acme = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, op.identity);
    expect((await get("pimwell.test")).status).toBe(401);
    expect((await get("acme.pimwell.test", { cookie: `pmw_session=${op.token}` })).status).toBe(404);
    expect((await get("pimwell.test", { authorization: `Bearer ${s.token}` })).status).toBe(401);
    expect((await get("pimwell.test", { cookie: `pmw_session=${s.token}` })).status).toBe(401);
  });

  it("shows sessions, agents, tokens, runs, and consent with working forms and no secrets", async () => {
    const acme = await seedTenant("acme");
    const blue = await seedTenant("blue");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "reader" }] });
    const s = await seedAgent(acme, op.identity);
    await grantConsent(env.HUB_DB, { email: "op@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
    const res = await get("pimwell.test", { cookie: `pmw_session=${op.token}` });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(op.session.id);
    expect(html).toContain('action="/api/session.end"');
    expect(html).toContain("acme.bot@pimwell.test");
    expect(html).toContain('action="/api/token.create"');
    expect(html).toContain(`name="agent_id" value="${s.agent.identity.id}"`);
    expect(html).toContain('action="/api/agent.archive"');
    expect(html).toContain('action="/api/token.revoke"');
    expect(html).toContain(`name="token_id" value="${s.apiToken.id}"`);
    expect(html).toContain("run-1");
    expect(html).toContain(`name="session_id" value="${s.session.id}"`);
    expect(html).toContain('action="/api/agent.create"');
    expect(html).toContain('name="tenant" value="acme"');
    expect(html).not.toContain("Create agent in blue"); // reader: no agent form (the credential form still lists blue)
    expect(html).toContain("New git credential for blue");
    expect(html).toContain("inbound_email");
    expect(html).toContain('action="/api/consent.revoke"');
    expect(html).toContain('name="_back" value="/me"');
    for (const secret of [s.longLived, s.token, op.token, s.apiToken.token_hash, s.session.token_hash]) expect(html).not.toContain(secret);
  });

  it("escapes agent names and offers roots every tenant", async () => {
    const acme = await seedTenant("acme");
    await seedTenant("blue");
    const root = await seedHuman("root@example.com", { is_root: true });
    await createAgent(env.HUB_DB, { tenant: acme, slug: "x", display_name: "<script>x</script>", operator_id: root.identity.id, role: "member", hubDomain: env.HUB_DOMAIN }, Date.now());
    const html = await (await get("pimwell.test", { cookie: `pmw_session=${root.token}` })).text();
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain('name="tenant" value="acme"');
    expect(html).toContain('name="tenant" value="blue"');
  });

  it("is linked from the apex home", async () => {
    const h = await seedHuman("a@example.com");
    const html = await (await SELF.fetch("https://pimwell.test/", { headers: { cookie: `pmw_session=${h.token}` } })).text();
    expect(html).toContain('href="/me"');
    expect(html).toContain('href="/me/sessions"');
  });
});
