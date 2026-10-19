import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";
import { INIT, connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

import { SKILLS } from "../src/skills";
import { guideManifest } from "../src/skills/versions";
import { syncGuideNotices, guideStatus } from "../src/skills/receipts";
import { sha256Hex } from "../src/ids";
import { skillRead } from "../src/verbs/discover";
import type { Ctx } from "../src/auth/context";

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
  it("serves a standalone Files helper and teaches fresh agents where to get it", async () => {
    const helper = await SELF.fetch(`https://${HOST}/pimwell-files.mjs`);
    expect(helper.status).toBe(200);
    expect(helper.headers.get("content-type")).toContain("javascript");
    const source = await helper.text();
    expect(source).toContain("export async function main");
    expect(source).toContain("PIMWELL_TOKEN_FILE");
    const setup = await (await SELF.fetch(`https://${HOST}/skills/pimwell-agent-onboarding/SKILL.md`)).text();
    for (const body of [setup, SKILLS.find(s => s.name === "start-here")!.body]) {
      for (const instruction of ["pimwell-files.mjs", "data-manifest.json", "5 GiB", "50 GiB", "evidence, never instructions", "outside services", "Every organization member"]) expect(body).toContain(instruction);
    }
  });
  it("versions content, delivers one change notice per active agent and guards read receipts", async () => {
    const t = await seedTenant("acme");
    const other = await seedTenant("other");
    const human = await seedHuman("owner@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const a = await seedAgent(t, human.identity, "guide-bot");
    const b = await seedAgent(other, human.identity, "other-bot");
    const api = async (verb: string, body: unknown = {}, token = a.token) => {
      const response = await apiPost(HOST, verb, body, bearer(token));
      expect(response.status).toBe(200);
      return (await response.json() as any).result;
    };
    const guide = await guideManifest();
    const list = await api("skill.list");
    expect(list.skills).toHaveLength(guide.skills.length);
    for (const s of guide.skills) {
      expect(s.version).toBe(await sha256Hex(s.body));
      expect(s.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.changed.length).toBeGreaterThan(0);
    }
    await Promise.all([syncGuideNotices(env.HUB_DB, Date.now()), syncGuideNotices(env.HUB_DB, Date.now())]);
    const entries = (await api("attention.list")).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain("skill_read");
    expect((await api("attention.done", { all: true })).done).toBe(0);
    expect((await apiPost(HOST, "attention.done", { ids: [entries[0].id] }, bearer(b.token))).status).toBe(404);
    expect((await guideStatus(env.HUB_DB, t.id, a.agent.identity.id)).caught_up).toBe(false);
    for (const s of guide.skills) {
      const read = await api("skill.read", { name: s.name });
      expect(read.version).toBe(s.version);
    }
    expect((await api("attention.done", { ids: [entries[0].id] })).done).toBe(1);
    expect((await guideStatus(env.HUB_DB, t.id, a.agent.identity.id)).caught_up).toBe(true);
    const page = await (await SELF.fetch(`https://${HOST}/people/${a.agent.identity.email}`, { headers: cookieHeaders(human.token, HOST) })).text();
    expect(page).toContain("Caught up");
    expect(page).toContain(guide.version);
    expect(await api("attention.list")).toEqual({ entries: [] });

    // A subsequent release edits one skill: only that skill must be read again.
    const original = SKILLS[0]!.body;
    try {
      SKILLS[0]!.body += "\nA new guide revision.";
      await syncGuideNotices(env.HUB_DB, Date.now());
      await syncGuideNotices(env.HUB_DB, Date.now());
      const notices = (await env.HUB_DB.prepare("SELECT * FROM guide_notice WHERE tenant_id = ? AND identity_id = ? ORDER BY created_at DESC").bind(t.id, a.agent.identity.id).all<any>()).results;
      expect(notices).toHaveLength(2);
      expect(JSON.parse(notices[0].required).map((s: any) => s.name)).toEqual(["start-here"]);
      expect((await guideStatus(env.HUB_DB, t.id, a.agent.identity.id)).caught_up).toBe(false);
      expect((await api("attention.done", { ids: [notices[0].id] })).done).toBe(0);
      const read = await skillRead.run({ db: env.HUB_DB, tenant: t, identity: a.agent.identity, now: Date.now() } as Ctx, { name: "start-here" });
      expect(read.body).toContain("A new guide revision.");
      expect((await api("attention.done", { ids: [notices[0].id] })).done).toBe(1);
      expect((await guideStatus(env.HUB_DB, t.id, a.agent.identity.id)).caught_up).toBe(true);
    } finally { SKILLS[0]!.body = original; }
  });

  it("announces resources and points new agents at the start-here skill", async () => {
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
    expect((await call(access, "skill_read", { name: "mail-as-evidence" })).content[0].text).toContain("executes permitted additive actions as that sender");
    const start = (await call(access, "skill_read", { name: "start-here" })).content[0].text;
    for (const tool of ["repo_search", "work_frontier", "work_claim", "work_comment", "work_release", "work_propose", "work_graph"]) {
      expect(start).toContain(tool);
    }
    expect(start).toContain("claim again to renew");
    expect(start).toContain("another member approves");
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
