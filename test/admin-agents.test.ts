import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const page = (host: string, token?: string) => SELF.fetch(`https://${host}/admin/agents`, { headers: token ? { cookie: `pmw_session=${token}` } : {} });

async function setup() {
  const acme = await seedTenant("acme");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, admin, op, s };
}

describe("/admin/agents", () => {
  it("shows every agent in the tenant to an admin, with operator and activity", async () => {
    const { admin, s } = await setup();
    const res = await page("acme.pimwell.test", admin.token);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("acme.bot@pimwell.test");
    expect(html).toContain("op@example.com");
    expect(html).toMatch(/<td>1<\/td><td>1<\/td>/);
    expect(html).toContain('action="/api/agent.archive"');
    expect(html).toContain(`name="agent_id" value="${s.agent.identity.id}"`);
    expect(html).toContain('name="_back" value="/admin/agents"');
    expect(html).not.toContain(s.longLived);
    expect(html).not.toContain(s.apiToken.token_hash);
  });

  it("is a 404 for members, anonymous callers, other tenants, and the apex", async () => {
    const { admin, op } = await setup();
    await seedTenant("blue");
    expect((await page("acme.pimwell.test", op.token)).status).toBe(404);
    expect((await page("acme.pimwell.test")).status).toBe(404);
    expect((await page("blue.pimwell.test", admin.token)).status).toBe(404);
    expect((await page("pimwell.test", admin.token)).status).toBe(404);
  });

  it("archives from the page and lists the agent as archived", async () => {
    const { admin, s } = await setup();
    const res = await SELF.fetch("https://acme.pimwell.test/api/agent.archive", {
      method: "POST", redirect: "manual",
      headers: { cookie: `pmw_session=${admin.token}`, origin: "https://acme.pimwell.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ agent_id: s.agent.identity.id, _back: "/admin/agents" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/agents");
    const html = await (await page("acme.pimwell.test", admin.token)).text();
    const archived = html.slice(html.indexOf("<h2>Archived</h2>"));
    expect(archived).toContain("acme.bot@pimwell.test");
    expect(html.slice(0, html.indexOf("<h2>Archived</h2>"))).not.toContain("acme.bot@pimwell.test");
  });

  it("links from the tenant home for admins only", async () => {
    const { admin, op } = await setup();
    const home = (token: string) => SELF.fetch("https://acme.pimwell.test/", { headers: { cookie: `pmw_session=${token}` } }).then((r) => r.text());
    expect(await home(admin.token)).toContain('href="/admin/agents"');
    expect(await home(op.token)).not.toContain('href="/admin/agents"');
  });
});
