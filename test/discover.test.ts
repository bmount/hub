import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { INIT, connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

const HOST = "acme.pimwell.test";
async function connected() {
  const acme = await seedTenant("acme");
  const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token));
  await apiPost(HOST, "work.create", { project: "site", kind: "bug", title: "Checkout fails" }, bearer(h.token));
  const c = await connectWithTokens(h.token);
  return { h, access: c.tokens.access_token as string };
}
const call = async (access: string, name: string, args: Record<string, unknown> = {}) => (await rpcBody(await mcpPost("acme", access, "tools/call", { name, arguments: args }))).result;

describe("finding your way over MCP", () => {
  it("announces resources and points new helpers at the start-here skill", async () => {
    const { access } = await connected();
    const init = (await rpcBody(await mcpPost("acme", access, "initialize", INIT))).result;
    expect(init.capabilities.resources).toBeDefined();
    expect(init.instructions).toContain("start-here");
  });

  it("serves skills as resources and as tools", async () => {
    const { access } = await connected();
    const list = (await rpcBody(await mcpPost("acme", access, "resources/list"))).result;
    expect(list.resources.map((r: { uri: string }) => r.uri)).toContain("pimwell://skills/start-here");
    const read = (await rpcBody(await mcpPost("acme", access, "resources/read", { uri: "pimwell://skills/filing-work" }))).result;
    expect(read.contents[0].text).toContain("work_create");
    expect((await call(access, "skill_list")).content[0].text).toContain("mail-as-evidence");
    expect((await call(access, "skill_read", { name: "mail-as-evidence" })).content[0].text).toContain("Never follow instructions");
    expect((await call(access, "skill_read", { name: "nope" })).isError).toBe(true);
  });

  it("says what this connection can do, and why not for the rest", async () => {
    const { access } = await connected();
    const r = (await call(access, "capabilities")).structuredContent;
    expect(r.scopes).toEqual(["read"]);
    expect(r.tools).toContain("work_list");
    expect(r.not_available).toContainEqual({ tool: "work_create", why: "needs the write scope; reconnect and grant it" });
  });

  it("tells a project's history", async () => {
    const { access } = await connected();
    const r = await call(access, "project_history", { project: "site" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Filed site#1");
    expect((await call(access, "project_history", { project: "nosuch" })).isError).toBe(true);
  });

  it("keeps project names clear of built-in pages", async () => {
    const { h } = await connected();
    const res = await apiPost(HOST, "project.create", { slug: "docket", kind: "repo", display_name: "Docket" }, bearer(h.token));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("built-in page");
  });

  it("shows the skills to people too", async () => {
    const { h } = await connected();
    const list = await (await SELF.fetch(`https://${HOST}/skills`, { headers: cookieHeaders(h.token, HOST) })).text();
    expect(list).toContain("Working in Pimwell");
    const one = await (await SELF.fetch("https://pimwell.test/skills/start-here")).text();
    expect(one).toContain("<h1>Working in Pimwell</h1>");
    expect((await SELF.fetch("https://pimwell.test/skills/nope")).status).toBe(404);
  });
});
