// Headless agents (owner, 2026-10-08): a person makes a one-time connect link, valid 24 hours; the agent claims it
// with a POST and works over /agent/mcp with its own token, within its person's rights.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
const MCP_TRIP_BUDGET = 3;

const HOST = "acme.pimwell.test";
let rpcId = 1000;
function agentMcp(token: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return SELF.fetch(`https://${HOST}/agent/mcp`, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
}

async function makeLink(h: Record<string, string>, body: Record<string, unknown>) {
  const r = await apiPost(HOST, "agent.connect", body, h);
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { result: { link: string; expires_at: number; agent: { id: string; address: string; role: string }; mcp_url: string } }).result;
}

const tokenIn = (text: string) => /`(pmw_[A-Za-z0-9_-]+)`/.exec(text)![1]!;
const pathOf = (link: string) => new URL(link).pathname;

describe("connect links", () => {
  it("creates the agent and a 24-hour link that GET never spends and POST claims exactly once", async () => {
    const t = await seedTenant("acme");
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const h = cookieHeaders(ann.token, HOST);
    const before = Date.now();
    const made = await makeLink(h, { display_name: "Build box" });
    expect(made.link).toMatch(/^https:\/\/acme\.pimwell\.test\/connect\/pmc_/);
    expect(made.agent.address).toBe("acme.build-box@pimwell.test");
    expect(made.agent.role).toBe("member");
    expect(made.mcp_url).toBe("https://acme.pimwell.test/agent/mcp");
    expect(made.expires_at - before).toBeGreaterThan(23.9 * 3600_000);
    expect(made.expires_at - before).toBeLessThanOrEqual(24 * 3600_000 + 5000);

    const look = await SELF.fetch(`https://${HOST}${pathOf(made.link)}`);
    expect(look.status).toBe(200);
    expect(await look.text()).toContain("curl -sf -X POST");

    const claim = await SELF.fetch(`https://${HOST}${pathOf(made.link)}`, { method: "POST" });
    expect(claim.status).toBe(200);
    const text = await claim.text();
    expect(text).toContain("https://acme.pimwell.test/agent/mcp");
    expect(text).toContain("claude mcp add --transport http pimwell-acme ");
    expect(text).toContain("PIMWELL_ACME_TOKEN");
    expect(text).toContain("acme.build-box@pimwell.test");
    expect(tokenIn(text)).toMatch(/^pmw_/);

    expect((await SELF.fetch(`https://${HOST}${pathOf(made.link)}`, { method: "POST" })).status).toBe(410);
    // Naming one of your own agents again makes a new link for it, not a duplicate; a new name whose address is taken gets the next free one.
    expect((await makeLink(h, { display_name: "Build box" })).agent.address).toBe("acme.build-box@pimwell.test");
    expect((await makeLink(h, { display_name: "Build-box" })).agent.address).toBe("acme.build-box-2@pimwell.test");
    // From the People page: the form, then the link shown once.
    expect(await (await SELF.fetch(`https://${HOST}/people?connect=1`, { headers: h })).text()).toContain('action="/api/agent.connect"');
    const form = await SELF.fetch(`https://${HOST}/api/agent.connect`, { method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: "display_name=Laptop%20runner" });
    expect(form.status).toBe(200);
    expect(await form.text()).toMatch(/https:\/\/acme\.pimwell\.test\/connect\/pmc_/);
    // Only its own organization's host takes a link.
    const other = await makeLink(h, { display_name: "Elsewhere" });
    await seedTenant("beta2");
    expect((await SELF.fetch(`https://beta2.pimwell.test${pathOf(other.link)}`, { method: "POST" })).status).toBe(410);
  });

  it("refuses expired links, readers making member agents, and agents making links", async () => {
    const t = await seedTenant("acme");
    const rita = await seedHuman("rita@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
    expect((await apiPost(HOST, "agent.connect", { display_name: "Mine" }, cookieHeaders(rita.token, HOST))).status).toBe(403);
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const made = await makeLink(cookieHeaders(ann.token, HOST), { display_name: "Late" });
    await env.HUB_DB.prepare("UPDATE agent_connect_link SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await SELF.fetch(`https://${HOST}${pathOf(made.link)}`, { method: "POST" })).status).toBe(410);
    // A new link for the same agent, from its page.
    const again = await makeLink(cookieHeaders(ann.token, HOST), { agent_id: made.agent.id });
    expect(again.agent.id).toBe(made.agent.id);
    // Someone else can't make links for Ann's agent.
    const bob = await seedHuman("bob@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    expect((await apiPost(HOST, "agent.connect", { agent_id: made.agent.id }, cookieHeaders(bob.token, HOST))).status).toBe(404);
  });
});

describe("/agent/mcp", () => {
  async function connected(role: "member" | "admin" = "member") {
    const t = await seedTenant("acme");
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role }] });
    await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    const made = await makeLink(cookieHeaders(ann.token, HOST), { display_name: "Build box" });
    const text = await (await SELF.fetch(`https://${HOST}${pathOf(made.link)}`, { method: "POST" })).text();
    return { t, ann, agent: made.agent, token: tokenIn(text) };
  }

  it("works as the agent, within member rights, on the record, within the round-trip budget", async () => {
    const { ann, agent, token } = await connected("admin");
    const list = await rpcBody(await agentMcp(token, "tools/list"));
    const names = (list.result.tools as Array<{ name: string }>).map((x) => x.name);
    expect(names).toContain("work_create");
    expect(names).toContain("whoami");
    const who = await rpcBody(await agentMcp(token, "tools/call", { name: "whoami", arguments: {} }));
    expect(JSON.stringify(who.result.structuredContent)).toContain(agent.address);
    const created = await rpcBody(await agentMcp(token, "tools/call", { name: "work_create", arguments: { project: "site", kind: "snag", title: "Flaky deploy step" } }));
    expect(created.result.isError ?? false, JSON.stringify(created)).toBe(false);
    const audit = await env.HUB_DB.prepare("SELECT kind, session_id FROM event WHERE identity_id = ? AND kind = 'mcp.call'").bind(agent.id).all<{ kind: string; session_id: string | null }>();
    expect(audit.results.length).toBeGreaterThanOrEqual(2);
    expect(new Set(audit.results.map((r) => r.session_id)).size).toBe(1);
    for (const m of ["tools/list", "tools/list"]) {
      const res = await agentMcp(token, m);
      expect(Number(/(\d+) round trips/.exec(res.headers.get("server-timing") ?? "")?.[1])).toBeLessThanOrEqual(MCP_TRIP_BUDGET);
    }
    void ann;
  });

  it("refuses wrong tokens, browsers, the other endpoint, and agents whose person left", async () => {
    const { t, ann, token } = await connected();
    expect((await agentMcp(null, "tools/list")).status).toBe(401);
    const bad = await agentMcp("pmw_nope", "tools/list");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).not.toContain("resource_metadata");
    expect((await agentMcp(token, "tools/list", {}, { origin: "https://claude.ai" })).status).toBe(403);
    // The agent token is not an assistant connection, and an assistant's token is not an agent's.
    expect((await mcpPost("acme", token, "tools/list")).status).toBe(401);
    const access = (await connectWithTokens(ann.token, {})).tokens.access_token;
    expect((await agentMcp(access, "tools/list")).status).toBe(401);
    // Removing the person cuts off their agents.
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(ann.identity.id, t.id).run();
    expect((await agentMcp(token, "tools/list")).status).toBe(401);
  });
});

describe("claiming from an agent's own process", () => {
  it("answers in JSON when asked, retires never-used tokens on a new claim, and reuses an agent by name", async () => {
    const t = await seedTenant("acme");
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const h = cookieHeaders(ann.token, HOST);
    const first = await makeLink(h, { display_name: "Timon" });
    const claim = (link: string) => SELF.fetch(`https://${HOST}${pathOf(link)}`, { method: "POST", headers: { accept: "application/json" } });
    const r1 = await claim(first.link);
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { ok: boolean; token: string; mcp_url: string; agent: { address: string } };
    expect(j1).toMatchObject({ ok: true, mcp_url: "https://acme.pimwell.test/agent/mcp", agent: { address: "acme.timon@pimwell.test" } });
    expect(j1.token).toMatch(/^pmw_/);
    // Pimwell's own names, per organization, so nothing collides with the agent's other servers and keys.
    expect((j1 as unknown as { names: { mcp_server: string; secret: string } }).names).toMatchObject({ mcp_server: "pimwell-acme", secret: "PIMWELL_ACME_TOKEN" });
    const again = await claim(first.link);
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ ok: false, error: "gone" });

    // The first token was lost in transit and never used. Asking for Timon again reuses Timon; the new claim retires it.
    const second = await makeLink(h, { display_name: "timon" });
    expect(second.agent.id).toBe(first.agent.id);
    const j2 = (await (await claim(second.link)).json()) as { token: string };
    expect((await agentMcp(j1.token, "tools/list")).status).toBe(401);
    expect((await agentMcp(j2.token, "tools/list")).status).toBe(200);

    // A token that has been used stays live when another link is claimed.
    const third = await makeLink(h, { agent_id: first.agent.id });
    await claim(third.link);
    expect((await agentMcp(j2.token, "tools/list")).status).toBe(200);
  });
});

describe("the onboarding skill", () => {
  it("is served ready to save, with the organization's own names on its host and placeholders on the hub's", async () => {
    const org = await (await SELF.fetch(`https://${HOST}/skills/pimwell-agent-onboarding/SKILL.md`)).text();
    expect(org.startsWith("---\nname: pimwell-agent-onboarding\ndescription: ")).toBe(true);
    expect(org).toContain("PIMWELL_ACME_TOKEN");
    expect(org).toContain("https://acme.pimwell.test/agent/mcp");
    // Early work goes to main; branches stay short (owner, 2026-10-08).
    expect(org).toContain("Small changes can go straight to main");
    expect(org).not.toContain("Work on a branch");
    expect(org).not.toMatch(/pm[wsc]_[A-Za-z0-9]/);
    const hub = await (await SELF.fetch("https://pimwell.test/skills/pimwell-agent-onboarding/SKILL.md")).text();
    expect(hub).toContain("PIMWELL_<ORG>_TOKEN");

    const t = await seedTenant("acme");
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const h = cookieHeaders(ann.token, HOST);
    const form = await SELF.fetch(`https://${HOST}/api/agent.connect`, { method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: "display_name=Helper%20one" });
    expect(await form.text()).toContain("https://acme.pimwell.test/skills/pimwell-agent-onboarding/SKILL.md");
    const made = await makeLink(h, { display_name: "Helper two" });
    const j = (await (await SELF.fetch(`https://${HOST}${pathOf(made.link)}`, { method: "POST", headers: { accept: "application/json" } })).json()) as { skill: string };
    expect(j.skill).toBe("https://acme.pimwell.test/skills/pimwell-agent-onboarding/SKILL.md");
  });
});

