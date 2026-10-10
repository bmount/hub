import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const PATH = "/assistant/connect";
const get = (token: string, host = HOST, suffix = "") => SELF.fetch(`https://${host}${PATH}${suffix}`, { headers: cookieHeaders(token, host) });

async function world(role: "reader" | "member" | "admin" = "member") {
  const acme = await seedTenant("acme");
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: acme.id, role }] });
  return { acme, pat };
}

async function effectCounts() {
  const tables = ["session", "oauth_grant", "consent", "assistant_thread", "assistant_message", "model_call", "event"];
  return Promise.all(tables.map(async (table) => [table, await env.HUB_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()]));
}

describe("human hosted-assistant connect guide", () => {
  it.each(["reader", "member", "admin"] as const)("binds the copyable endpoint, identity and role to the authorized %s browser", async (role) => {
    const w = await world(role);
    const before = await effectCounts();
    const response = await get(w.pat.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    const html = await response.text();
    expect(html).toContain('readonly value="https://acme.pimwell.test/mcp"');
    expect(html).toContain(`role <strong>${role}</strong>`);
    expect(html).toContain("pat@example.com");
    expect(html).toContain('href="https://pimwell.test/me"');
    expect(html).toContain("whoami");
    expect(html).toContain("Read</strong>");
    expect(html).toContain("Write</strong>");
    expect(html).toContain("not given every administrative or credential-management tool");
    expect(html).toContain("No particular hosted client or plan is claimed tested");
    expect(html).toContain("client-ID metadata documents (CIMD) are not supported");
    expect(html).toContain("This alone does not establish that your client is incompatible");
    expect(html).toContain("Do not retry a write with an uncertain result");
    expect(html).not.toContain("action=\"/oauth");
    expect(html).not.toContain(w.pat.token);
    expect(await effectCounts()).toEqual(before);
  });

  it("ignores query-supplied endpoint/identity/tenant and renders stored names inertly", async () => {
    const w = await world();
    const other = await seedTenant("secret");
    const stranger = await seedHuman("private@example.com", { memberships: [{ tenant_id: other.id, role: "admin" }] });
    await env.HUB_DB.prepare("UPDATE tenant SET display_name = ? WHERE id = ?").bind('<img src=x onerror="leak()">', w.acme.id).run();
    await env.HUB_DB.prepare("UPDATE identity SET display_name = ? WHERE id = ?").bind("<script>bad()</script>", w.pat.identity.id).run();
    const html = await (await get(w.pat.token, HOST, `?tenant=secret&identity=${stranger.identity.id}&endpoint=https://evil.example/mcp`)).text();
    expect(html).toContain('readonly value="https://acme.pimwell.test/mcp"');
    expect(html).toContain("&lt;img src=x onerror=&quot;leak()&quot;&gt;");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>bad()");
    expect(html).not.toContain("private@example.com");
    expect(html).not.toContain("secret.pimwell.test");
    expect(html).not.toContain("evil.example");
  });

  it("offers discoverable links from chat, tools and only the account's active memberships", async () => {
    const w = await world();
    const other = await seedTenant("other");
    await seedHuman("other@example.com", { memberships: [{ tenant_id: other.id, role: "admin" }] });
    for (const path of ["/assistant", "/assistant/tools"]) {
      const html = await (await SELF.fetch(`https://${HOST}${path}`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
      expect(html).toContain('href="/assistant/connect">Connect ChatGPT or Claude</a>');
    }
    const html = await (await SELF.fetch("https://pimwell.test/me", { headers: cookieHeaders(w.pat.token, "pimwell.test") })).text();
    expect(html).toContain('href="https://acme.pimwell.test/assistant/connect"');
    expect(html).not.toContain("https://other.pimwell.test/assistant/connect");
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ?").bind(w.pat.identity.id).run();
    const removed = await (await SELF.fetch("https://pimwell.test/me", { headers: cookieHeaders(w.pat.token, "pimwell.test") })).text();
    expect(removed).not.toContain("https://acme.pimwell.test/assistant/connect");
    expect(removed).toContain("first sign in with an identity that has active organization access");
  });

  it.each(["pimwell.test", "secret.pimwell.test", "unknown.pimwell.test", "evil.test"])("does not disclose browser guidance on unauthorized host %s", async (host) => {
    const w = await world();
    await seedTenant("secret");
    const r = await get(w.pat.token, host);
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).not.toContain("pat@example.com");
    expect(html).not.toContain('id="mcp-endpoint"');
  });

  it("refuses anonymous, expired and removed browser principals with neutral pages", async () => {
    const w = await world();
    expect((await SELF.fetch(`https://${HOST}${PATH}`)).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE session SET expires_at = 0 WHERE id = ?").bind(w.pat.session.id).run();
    const expired = await get(w.pat.token);
    expect(expired.status).toBe(404);
    expect(expired.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await expired.text()).not.toContain("pat@example.com");
    const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: w.acme.id, role: "reader" }] });
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ?").bind(sam.identity.id).run();
    expect((await get(sam.token)).status).toBe(404);
  });

  it("refuses archived organizations without minting any grant", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.acme.id).run();
    const before = await effectCounts();
    const r = await get(w.pat.token);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("pat@example.com");
    expect(await effectCounts()).toEqual(before);
  });

  it("does not substitute agent run, agent token or bearer human credentials for browser guidance", async () => {
    const w = await world();
    const agent = await seedAgent(w.acme, w.pat.identity);
    const before = await effectCounts();
    for (const headers of [bearer(agent.token), bearer(agent.longLived), cookieHeaders(agent.token, HOST), bearer(w.pat.token)]) {
      const r = await SELF.fetch(`https://${HOST}${PATH}`, { headers });
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain('id="mcp-endpoint"');
    }
    expect(await effectCounts()).toEqual(before);
  });
});
