// Every new project gets #<project>-team and #<project>-ops; a name already taken is skipped, never an error.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PROJECT_FEATURES, projectFeatures, requireProjectFeature } from "../src/projectFeatures";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { registerAllVerbs } from "../src/verbs/index";
import { createChannel } from "../src/db/chat";
import { apiPost, cookieHeaders, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

describe("project kinds", () => {
  it("defines all capabilities in one table", () => {
    expect(PROJECT_FEATURES).toEqual({ repo: ["docket", "repo"], tracker: ["docket"], wiki: ["wiki", "files"], workspace: ["docket", "wiki", "knowledge", "files", "people"] });
    expect(projectFeatures("channel")).toEqual([]);
    expect(() => requireProjectFeature({ slug: "docs", kind: "wiki" }, "repo")).toThrow("does not support Repository");
  });
  it("creates wiki and workspace over MCP and forms, with kind-specific tabs and feature errors", async () => {
    registerAllVerbs();
    const t = await seedTenant("acme");
    const h = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const { grant } = await seedGrant(t, h);
    const live = (await liveGrant(env.HUB_DB, grant.id, Date.now()))!;
    const ctx = oauthContext(env, live, ["read", "write"], { now: Date.now(), ip: "203.0.113.1" });
    for (const kind of ["wiki", "workspace"]) {
      const res = await callTool(ctx, "project_create", { slug: kind, kind, display_name: kind });
      expect(res.isError, JSON.stringify(res)).toBeUndefined();
      const form = await SELF.fetch(`https://${HOST}/api/project.create`, { method: "POST", redirect: "manual", headers: { ...cookieHeaders(h.token, HOST), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slug: `${kind}-form`, kind, display_name: kind, _back: "@result" }).toString() });
      expect(form.status).toBe(303);
      expect(form.headers.get("location")).toBe(`/${kind}-form`);
      const html = await (await SELF.fetch(`https://${HOST}/${kind}`, { headers: cookieHeaders(h.token, HOST) })).text();
      const tabs = html.match(/<nav class="chips" aria-label="Project features">([\s\S]*?)<\/nav>/)![1]!;
      expect(tabs).toContain("Wiki pages");
      expect(tabs).toContain("Files");
      expect(tabs).not.toContain("Repository");
      expect(tabs.includes("Docket")).toBe(kind === "workspace");
      expect(tabs.includes("Knowledge base")).toBe(kind === "workspace");
      expect(tabs.includes("People")).toBe(kind === "workspace");
      const repo = await callTool(ctx, "repo_branches", { project: kind });
      expect(repo.isError).toBe(true);
      expect(JSON.stringify(repo)).toContain("does not support Repository");
    }
    for (const name of ["work_list", "work_board", "work_frontier", "work_graph"]) {
      const res = await callTool(ctx, name, { project: "wiki" });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toContain("does not support Docket");
    }
    const form = await (await SELF.fetch(`https://${HOST}/projects/new`, { headers: cookieHeaders(h.token, HOST) })).text();
    for (const kind of Object.keys(PROJECT_FEATURES)) expect(form).toContain(`<option value="${kind}">`);
  });
});

describe("default project channels", () => {
  it("creates the team and ops channels with the project, skipping a taken name", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await createChannel(env.HUB_DB, { tenant_id: t.id, slug: "site-ops", display_name: "taken", topic: "", created_by: pat.identity.id }, Date.now());
    const res = await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, cookieHeaders(pat.token, HOST));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { result: { channels: string[] } }).result.channels).toEqual(["site-team"]);
    const rows = await env.HUB_DB.prepare("SELECT p.slug, c.topic FROM channel c JOIN project p ON p.id = c.project_id WHERE p.tenant_id = ? ORDER BY p.slug").bind(t.id).all<{ slug: string; topic: string }>();
    expect(rows.results.map((r) => r.slug)).toEqual(["site-ops", "site-team"]);
    expect(rows.results[1]!.topic).toContain("Talk about Site");
    const docket = await (await SELF.fetch(`https://${HOST}/docket`, { headers: cookieHeaders(pat.token, HOST) })).text();
    expect(docket).not.toContain('href="/site-team/docket"');
  });
});
