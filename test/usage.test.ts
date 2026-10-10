// AI usage accounting (migration 0012): one ledger, priced when recorded, reported from any tool.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { createChannel } from "../src/db/chat";
import { createNamespace } from "../src/db/namespaces";
import { usageStatement } from "../src/models/usage";
import { agentMcpAuth } from "../src/mcp/agentAuth";
import { callTool } from "../src/mcp/tools";
import type { WorkGroup } from "../src/verbs/usage";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const root = await seedHuman("root@example.com", { is_root: true });
  const bot = await seedAgent(t, pat.identity, "scout");
  const call = async (h: Record<string, string>, verb: string, body: unknown, host = HOST) => {
    const r = await apiPost(host, verb, body, h);
    return { status: r.status, ...((await r.json()) as { ok: boolean; result: Record<string, unknown>; error?: string; detail?: string }) };
  };
  return { t, pat: cookieHeaders(pat.token, HOST), ada: cookieHeaders(ada.token, HOST), root: cookieHeaders(root.token, "pimwell.test"), bot: bearer(bot.token), botToken: bot.longLived, call, patId: pat.identity.id };
}
const costs = async () => (await env.HUB_DB.prepare("SELECT model, cost_micros, cost_source, source FROM model_call ORDER BY model").all()).results;

describe("project-filtered recorded AI usage", () => {
  it("filters every aggregate and inspector, includes calls without work, and retains own/admin scope", async () => {
    const w = await world();
    const created = await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Build" });
    const work = created.result.item as { id: string; project_id: string };
    await w.call(w.pat, "usage.report", { calls: [
      { provider: "p", model: "site-paid", work: "site#1", cost_usd: 0.25, client: "site-tool" },
      { provider: "p", model: "site-unpriced", work: "site#1", client: "site-tool" },
      { provider: "p", model: "unattributed-model", cost_usd: 100 },
      { provider: "p", model: "old-model", work: "site#1", cost_usd: 500, at: new Date(Date.now() - 8 * 86_400_000).toISOString() },
    ] });
    const other = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "other", kind: "tracker", display_name: "Other" }, Date.now());
    const foreign = await seedTenant("bravo");
    for (const [id, project, tenant, identity, cost] of [
      ["site-no-work", work.project_id, w.t.id, w.patId, 500_000],
      ["other-model", other.id, w.t.id, w.patId, 20_000_000],
      ["app-model", work.project_id, w.t.id, null, 2_000_000],
      ["foreign-secret-model", work.project_id, foreign.id, w.patId, 999_000_000],
    ] as const) await usageStatement(env.HUB_DB, { id, source: "reported", purpose: "coding", provider: "p", model: id, tenant_id: tenant, identity_id: identity, project_id: project, client: "site-tool", ok: true, ms: 0, input_tokens: null, output_tokens: null, reported_cost_micros: cost, created_at: Date.now() }).run();
    await w.call(w.bot, "usage.report", { provider: "p", model: "bot-secret-model", work: "site#1", cost_usd: 9 });
    const result = await w.call(w.pat, "usage.summary", { days: 7, project: "SITE" });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ project: "site", work: null, scope: "you", total: { calls: 3, cost_micros: 750_000, unpriced: 1 }, byWorkCoverage: { shown: 2, truncated: false } });
    expect((result.result.byModel as { label: string }[]).map(g => g.label).sort()).toEqual(["site-no-work", "site-paid", "site-unpriced"]);
    expect(result.result.byWho).toMatchObject([{ key: "pat@example.com", calls: 3 }]);
    expect(result.result.bySource).toMatchObject([{ label: "site-tool", calls: 3 }]);
    expect(result.result.byDay).toMatchObject([{ calls: 3 }]);
    expect(result.result.byWork).toMatchObject([{ ref: null, calls: 1 }, { ref: "site#1", calls: 2, unpriced: 1 }]);
    const narrowed = await w.call(w.pat, "usage.summary", { days: 7, project: "site", work: "site#1" });
    expect(narrowed.result.total).toMatchObject({ calls: 2, cost_micros: 250_000, unpriced: 1 });
    expect((await w.call(w.ada, "usage.summary", { days: 7, project: "site", everyone: true })).result.total).toMatchObject({ calls: 5, cost_micros: 11_750_000, unpriced: 1 });
    expect((await w.call(w.pat, "usage.summary", { project: "site", everyone: true })).status).toBe(403);
    const page = await (await SELF.fetch(`https://${HOST}/usage?days=7&project=SITE&who=scout%40acme.pimwell.test`, { headers: w.pat })).text();
    expect(page).toContain('name="project" maxlength="127" value="site"');
    expect(page).toContain("Clear project filter");
    expect(page).toContain("project=site");
    expect(page).toContain("site-no-work");
    expect(page).toContain("site-unpriced");
    for (const model of ["other-model", "old-model", "unattributed-model", "app-model", "bot-secret-model", "foreign-secret-model"]) expect(page).not.toContain(model);
    const adminPage = await (await SELF.fetch(`https://${HOST}/usage?days=7&project=site&work=site%231&who=pat%40example.com`, { headers: w.ada })).text();
    expect(adminPage).toContain('who=pat%40example.com&amp;work=site%231&amp;project=site');
    expect(adminPage).toContain('href="/usage?days=7&amp;work=site%231&amp;project=site">‹ AI usage');
    expect(adminPage).toContain('href="/usage?days=7&amp;who=pat%40example.com&amp;project=site">Clear work filter');
    expect(adminPage).toContain('href="/usage?days=7&amp;who=pat%40example.com&amp;work=site%231">Clear project filter');
    const overview = await (await SELF.fetch(`https://${HOST}/site`, { headers: w.pat })).text();
    expect(overview).toContain('<a href="/usage?project=site">Recorded AI usage for this project</a>');
  });

  it("resolves namespace paths independently, keeps archived history and distinguishes pane scopes", async () => {
    const w = await world();
    const ns = await createNamespace(env.HUB_DB, { tenant_id: w.t.id, slug: "team", display_name: "Team" }, Date.now());
    const project = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: ns.id, slug: "site", kind: "repo", display_name: "Team site" }, Date.now());
    const flat = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND namespace_id IS NULL AND slug = 'site'").bind(w.t.id).first<string>("id");
    for (const [n, projectId] of [flat, project.id].entries()) await usageStatement(env.HUB_DB, { id: `scope-${n}`, source: "reported", purpose: "coding", provider: "p", model: `scope-${n}`, tenant_id: w.t.id, identity_id: w.patId, project_id: projectId, ok: true, ms: 0, input_tokens: null, output_tokens: null, created_at: Date.now() }).run();
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(project.id).run();
    await env.HUB_DB.prepare("UPDATE namespace SET state = 'archived' WHERE id = ?").bind(ns.id).run();
    const result = await w.call(w.pat, "usage.summary", { project: " Team/SITE " });
    expect(result.result).toMatchObject({ project: "team/site", total: { calls: 1, cost_micros: null, unpriced: 1 } });
    expect(result.result.byModel).toMatchObject([{ label: "scope-1" }]);
    const page = await (await SELF.fetch(`https://${HOST}/usage?project=team%2Fsite`, { headers: w.pat })).text();
    expect(page).toContain('value="team/site"');
    expect(page).toContain("project=team%2Fsite");
    expect(page).toContain("scope-1");
    expect(page).not.toContain("scope-0");
    const flatPage = await (await SELF.fetch(`https://${HOST}/usage?project=site`, { headers: w.pat })).text();
    const keys = (html: string) => [...html.matchAll(/data-key="(usage:[^"]*)"/g)].map(m => m[1]);
    expect(keys(flatPage)).toHaveLength(2);
    expect(keys(page)).toHaveLength(2);
    expect(keys(flatPage)).not.toEqual(keys(page));
  });

  it("refuses unknown, foreign, channel, inconsistent and mismatched filters rather than falling back", async () => {
    const w = await world();
    await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Build" });
    const foreign = await seedTenant("bravo");
    await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "foreign-secret", kind: "repo", display_name: "Foreign" }, Date.now());
    const ns = await createNamespace(env.HUB_DB, { tenant_id: foreign.id, slug: "secret", display_name: "Foreign namespace" }, Date.now());
    const bad = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "bad", kind: "repo", display_name: "Bad" }, Date.now());
    await env.HUB_DB.prepare("UPDATE project SET namespace_id = ? WHERE id = ?").bind(ns.id, bad.id).run();
    await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "channel-secret", display_name: "Private channel", topic: "", created_by: w.patId }, Date.now());
    await w.call(w.pat, "usage.report", { provider: "p", model: "unfiltered-model", cost_usd: 1 });
    for (const project of ["unknown", "foreign-secret", "channel-secret", "bad", "secret/bad", "../site", "/site", "site/team/more", "site?who=admin"]) {
      expect((await w.call(w.pat, "usage.summary", { project })).status, project).toBe(404);
      const response = await SELF.fetch(`https://${HOST}/usage?project=${encodeURIComponent(project)}`, { headers: w.pat });
      expect(response.status, project).toBe(404);
      expect(await response.text()).not.toContain("unfiltered-model");
    }
    for (const project of [42, {}, "x".repeat(128)]) expect((await w.call(w.pat, "usage.summary", { project })).status).toBe(400);
    expect((await SELF.fetch(`https://${HOST}/usage?project=${"x".repeat(128)}`, { headers: w.pat })).status).toBe(404);
    await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "other", kind: "repo", display_name: "Other" }, Date.now());
    expect((await w.call(w.pat, "usage.summary", { project: "other", work: "site#1" })).status).toBe(400);
    expect((await SELF.fetch(`https://${HOST}/usage?project=other&work=site%231`, { headers: w.pat })).status).toBe(404);
    expect((await SELF.fetch(`https://${HOST}/usage?project=site`)).status).toBe(404);
    expect((await w.call(w.pat, "usage.summary", { project: "" })).result.project).toBeNull();
  });

  it("keeps reader/agent scopes and returns truthful empty results through MCP", async () => {
    const w = await world();
    await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Build" });
    await w.call(w.pat, "usage.report", { provider: "p", model: "member-only-model", work: "site#1", cost_usd: 10 });
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const result = await w.call(cookieHeaders(reader.token, HOST), "usage.summary", { project: "site" });
    expect(result.result).toMatchObject({ project: "site", total: { calls: 0, cost_micros: null }, byWork: [], byWorkCoverage: { shown: 0, truncated: false } });
    for (const field of ["byWho", "byModel", "bySource", "byDay"]) expect(result.result[field]).toEqual([]);
    const page = await (await SELF.fetch(`https://${HOST}/usage?project=site`, { headers: cookieHeaders(reader.token, HOST) })).text();
    expect(page).toContain("No AI usage recorded for project site in this period and scope. This does not mean the project cost nothing.");
    expect(page).not.toContain("member-only-model");
    const auth = await agentMcpAuth(new Request(`https://${HOST}/agent/mcp`, { headers: bearer(w.botToken) }), env, "acme", Date.now());
    if (auth.kind !== "ok") throw new Error("agent auth failed");
    const empty = await callTool(auth.ctx, "usage_summary", { project: "site" });
    expect(empty.structuredContent).toMatchObject({ project: "site", total: { calls: 0 } });
    await w.call(w.bot, "usage.report", { provider: "p", model: "agent-unpriced", work: "site#1" });
    const own = await callTool(auth.ctx, "usage_summary", { project: "site", work: "site#1" });
    expect(own.structuredContent).toMatchObject({ project: "site", work: "site#1", total: { calls: 1, cost_micros: null, unpriced: 1 } });
    expect(JSON.stringify(own.content)).toContain("in project site");
    expect(JSON.stringify(own.content)).toContain("price unknown");
    expect(JSON.stringify(own)).not.toContain("member-only-model");
    for (const args of [{ project: "site", everyone: true }, { project: "unknown" }, { project: "x".repeat(128) }]) expect((await callTool(auth.ctx, "usage_summary", args)).isError).toBe(true);
  });
});

describe("work-filtered recorded AI usage", () => {
  it("filters every aggregate and the call inspector without widening own usage scope", async () => {
    const w = await world();
    const first = await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "First" });
    const item = first.result.item as { id: string };
    await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Second" });
    await w.call(w.pat, "usage.report", { calls: [
      { provider: "p", model: "first-priced", work: "site#1", cost_usd: 0.25, client: "first-tool" },
      { provider: "p", model: "first-unpriced", work: "site#1", client: "first-tool" },
      { provider: "p", model: "second-model", work: "site#2", cost_usd: 20, client: "second-tool" },
      { provider: "p", model: "second-model", work: "site#2", cost_usd: 20, client: "second-tool" },
      { provider: "p", model: "unlinked-model", cost_usd: 100 },
      { provider: "p", model: "old-model", work: "site#1", cost_usd: 500, at: new Date(Date.now() - 8 * 86_400_000).toISOString() },
    ] });
    await w.call(w.bot, "usage.report", { provider: "p", model: "bot-secret-model", work: "site#1", cost_usd: 9 });
    const wrongProject = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "other", kind: "repo", display_name: "Other" }, Date.now());
    await usageStatement(env.HUB_DB, { id: "wrong-project-call", source: "reported", purpose: "coding", provider: "p", model: "wrong-project-model", tenant_id: w.t.id, identity_id: w.patId, project_id: wrongProject.id, work_item_id: item.id, ok: true, ms: 0, input_tokens: null, output_tokens: null, reported_cost_micros: 99999, created_at: Date.now() }).run();
    const result = await w.call(w.pat, "usage.summary", { days: 7, work: item.id });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ work: "site#1", scope: "you", total: { calls: 2, cost_micros: 250_000, unpriced: 1 }, byWorkCoverage: { shown: 1, truncated: false } });
    expect((result.result.byWork as WorkGroup[]).map(g => g.ref)).toEqual(["site#1"]);
    expect((result.result.byModel as { key: string }[]).map(g => g.key).sort()).toEqual(["p/first-priced", "p/first-unpriced"]);
    expect(result.result.bySource).toMatchObject([{ label: "first-tool", calls: 2 }]);
    expect(result.result.byWho).toMatchObject([{ key: "pat@example.com", calls: 2 }]);
    expect(result.result.byDay).toMatchObject([{ calls: 2 }]);
    expect((await w.call(w.pat, "usage.summary", { days: 7, work: "site#1" })).result).toEqual(result.result);
    expect((await w.call(w.ada, "usage.summary", { days: 7, work: "site#1", everyone: true })).result.total).toMatchObject({ calls: 3, cost_micros: 9_250_000, unpriced: 1 });
    const url = `/usage?days=7&work=${encodeURIComponent(item.id)}&who=scout%40acme.pimwell.test`;
    const response = await SELF.fetch(`https://${HOST}${url}`, { headers: w.pat });
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('name="work" maxlength="80" value="site#1"');
    expect(page).toContain("Clear work filter");
    expect(page).toContain("work=site%231");
    expect(page).toContain("first-priced");
    expect(page).toContain("first-unpriced");
    for (const text of ["second-model", "unlinked-model", "old-model", "bot-secret-model", "wrong-project-model", "$9.25"]) expect(page).not.toContain(text);
    const secondPage = await (await SELF.fetch(`https://${HOST}/usage?days=7&work=site%232`, { headers: w.pat })).text();
    const key = (html: string) => html.match(/id="list"[^>]*data-key="([^"]*)"/)![1];
    expect(key(page)).not.toBe(key(secondPage));
    const adminPage = await (await SELF.fetch(`https://${HOST}/usage?days=7&work=site%231`, { headers: w.ada })).text();
    expect(adminPage).toContain("$9.25");
    expect(adminPage).toContain('who=pat%40example.com&amp;work=site%231');
    const itemPage = await (await SELF.fetch(`https://${HOST}/site/w/1`, { headers: w.pat })).text();
    expect(itemPage).toContain('<a href="/usage?work=site%231">Recorded AI usage for this work</a>');
  });

  it("reports a scoped empty result, including when other people recorded calls for the work", async () => {
    const w = await world();
    await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Empty for member" });
    await w.call(w.bot, "usage.report", { provider: "p", model: "private-model", work: "site#1", cost_usd: 123 });
    const result = await w.call(w.pat, "usage.summary", { work: "site#1" });
    expect(result.result).toMatchObject({ work: "site#1", total: { calls: 0, cost_micros: null }, byWork: [], byWorkCoverage: { shown: 0, truncated: false } });
    for (const field of ["byWho", "byModel", "bySource", "byDay"]) expect(result.result[field]).toEqual([]);
    const page = await (await SELF.fetch(`https://${HOST}/usage?work=site%231`, { headers: w.pat })).text();
    expect(page).toContain("No AI usage recorded for site#1 in this period and scope.");
    expect(page).not.toContain("private-model");
    expect(page).not.toContain("$123");
    expect((await w.call(w.pat, "usage.summary", { work: "site#1", everyone: true })).status).toBe(403);
  });

  it("refuses unknown, foreign, channel and inconsistent targets instead of falling back to totals", async () => {
    const w = await world();
    const other = await seedTenant("bravo");
    const foreign = await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "foreign-secret", kind: "repo", display_name: "Private" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "channel-secret", display_name: "Private channel", topic: "", created_by: w.patId }, Date.now());
    const localProject = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'site'").bind(w.t.id).first("id");
    await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at) VALUES ('foreign-work', ?, ?, 1, 'errand', 'Foreign secret title', '', 'open', ?, 1, 1), ('channel-work', ?, ?, 1, 'errand', 'Channel secret title', '', 'open', ?, 1, 1), ('bad-project-work', ?, ?, 2, 'errand', 'Bad project secret', '', 'open', ?, 1, 1), ('bad-tenant-work', ?, ?, 2, 'errand', 'Bad tenant secret', '', 'open', ?, 1, 1)")
      .bind(other.id, foreign.id, w.patId, w.t.id, channel.project_id, w.patId, w.t.id, foreign.id, w.patId, other.id, localProject, w.patId).run();
    await w.call(w.pat, "usage.report", { provider: "p", model: "existing-model", cost_usd: 1 });
    for (const work of ["unknown-id", "site#99", "foreign-work", "foreign-secret#1", "channel-work", "channel-secret#1", "bad-project-work", "site#2", "bad-tenant-work"]) {
      const result = await w.call(w.pat, "usage.summary", { work });
      expect(result.status, work).toBe(404);
      expect(result.result).toBeUndefined();
      const response = await SELF.fetch(`https://${HOST}/usage?work=${encodeURIComponent(work)}`, { headers: w.pat });
      expect(response.status, work).toBe(404);
      expect(await response.text()).not.toContain("existing-model");
    }
    for (const work of [42, {}, "x".repeat(81)]) expect((await w.call(w.pat, "usage.summary", { work })).status).toBe(400);
    expect((await SELF.fetch(`https://${HOST}/usage?work=${"x".repeat(81)}`, { headers: w.pat })).status).toBe(404);
    expect((await SELF.fetch(`https://${HOST}/usage?work=site%232`)).status).toBe(404);
  });
});

describe("recorded AI usage by work item", () => {
  it("groups priced and unpriced calls by work without widening member scope", async () => {
    const w = await world();
    const created = await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Build" });
    const item = created.result.item as { id: string };
    await w.call(w.pat, "usage.report", { calls: [
      { provider: "openai", model: "paid", work: "site#1", input_tokens: 100, output_tokens: 20, cost_usd: 0.25 },
      { provider: "openai", model: "unknown", work: "site#1" },
      { provider: "openai", model: "free", cost_usd: 0 },
    ] });
    await w.call(w.bot, "usage.report", { provider: "openai", model: "private-bot-model", work: "site#1", cost_usd: 9 });
    const mine = await w.call(w.pat, "usage.summary", {});
    expect(mine.result.byWork).toMatchObject([
      { key: item.id, label: "site#1", ref: "site#1", calls: 2, input_tokens: 100, output_tokens: 20, cost_micros: 250_000, unpriced: 1 },
      { key: "unmatched", label: "No matching work item", ref: null, calls: 1, input_tokens: 0, output_tokens: 0, cost_micros: 0, unpriced: 0 },
    ]);
    expect(mine.result.byWorkCoverage).toEqual({ limit: 50, shown: 2, truncated: false });
    expect(mine.result.total).toMatchObject({ calls: 3, cost_micros: 250_000, unpriced: 1 });
    expect((await w.call(w.pat, "usage.summary", { everyone: true })).status).toBe(403);
    const all = await w.call(w.ada, "usage.summary", { everyone: true });
    expect((all.result.byWork as WorkGroup[])[0]).toMatchObject({ calls: 3, cost_micros: 9_250_000, unpriced: 1 });
    const page = await (await SELF.fetch(`https://${HOST}/usage?who=ada%40example.com`, { headers: w.pat })).text();
    expect(page).toContain("By work item");
    expect(page).toContain('<a href="/site/w/1">site#1</a>');
    expect(page).toContain("price unknown (1 unpriced)");
    expect(page).toContain("not the full cost of the work");
    expect(page).not.toContain("private-bot-model");
    expect(page).not.toContain("$9.25");
  });

  it("reports empty and all-unpriced work groups without inventing a zero cost", async () => {
    const w = await world();
    const empty = await w.call(w.pat, "usage.summary", {});
    expect(empty.result.byWork).toEqual([]);
    expect(empty.result.byWorkCoverage).toEqual({ limit: 50, shown: 0, truncated: false });
    await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Unpriced work" });
    await w.call(w.pat, "usage.report", { provider: "unknown", model: "unknown", work: "site#1" });
    const result = await w.call(w.pat, "usage.summary", {});
    expect((result.result.byWork as WorkGroup[])[0]).toMatchObject({ ref: "site#1", calls: 1, cost_micros: null, unpriced: 1 });
    const page = await (await SELF.fetch(`https://${HOST}/usage`, { headers: w.pat })).text();
    expect(page).toContain("price unknown");
    expect(page).toContain("Unpriced calls are not zero-cost calls.");
    expect(page).not.toContain("$0");
  });

  it("caps work examples independently of totals, with deterministic ties and exact coverage", async () => {
    const w = await world();
    const project = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'site'").bind(w.t.id).first<string>("id");
    const add = async (n: number) => {
      const id = `work-${String(n).padStart(2, "0")}`;
      await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'errand', 'Build', '', 'open', ?, ?, ?)").bind(id, w.t.id, project, n + 1, w.patId, Date.now(), Date.now()).run();
      await usageStatement(env.HUB_DB, { id: `call-${n}`, source: "reported", purpose: "coding", provider: "p", model: "m", tenant_id: w.t.id, identity_id: w.patId, project_id: project, work_item_id: id, ok: true, ms: 0, input_tokens: null, output_tokens: null, reported_cost_micros: 100, created_at: Date.now() }).run();
    };
    for (let n = 0; n < 50; n++) await add(n);
    const full = await w.call(w.pat, "usage.summary", {});
    expect(full.result.byWorkCoverage).toEqual({ limit: 50, shown: 50, truncated: false });
    await add(50);
    const capped = await w.call(w.pat, "usage.summary", {});
    expect(capped.result.byWorkCoverage).toEqual({ limit: 50, shown: 50, truncated: true });
    expect(capped.result.byWork).toEqual(full.result.byWork);
    expect(capped.result.total).toMatchObject({ calls: 51, cost_micros: 5100 });
    expect((await w.call(w.pat, "usage.summary", { project: "site" })).result.byWorkCoverage).toEqual(capped.result.byWorkCoverage);
    expect((capped.result.byWork as WorkGroup[]).map(g => g.key)).toEqual(Array.from({ length: 50 }, (_, n) => `work-${String(n).padStart(2, "0")}`));
    const page = await (await SELF.fetch(`https://${HOST}/usage`, { headers: w.pat })).text();
    expect(page).toContain("capped at 50, more groups omitted");
    expect(page).not.toContain('href="/site/w/51"');
  });

  it("keeps foreign, mismatched and channel work references unmatched without exposing targets", async () => {
    const w = await world();
    const created = await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Local" });
    const local = created.result.item as { id: string; project_id: string };
    const other = await seedTenant("bravo");
    const foreign = await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "foreign-secret", kind: "repo", display_name: "Private" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "channel-secret", display_name: "Private channel", topic: "", created_by: w.patId }, Date.now());
    await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at) VALUES ('foreign-work', ?, ?, 1, 'errand', 'Private foreign title', '', 'open', ?, ?, ?), ('channel-work', ?, ?, 1, 'errand', 'Private channel title', '', 'open', ?, ?, ?), ('bad-project-work', ?, ?, 2, 'errand', 'Inconsistent', '', 'open', ?, ?, ?)")
      .bind(other.id, foreign.id, w.patId, Date.now(), Date.now(), w.t.id, channel.project_id, w.patId, Date.now(), Date.now(), w.t.id, foreign.id, w.patId, Date.now(), Date.now()).run();
    const targets = [["foreign-work", foreign.id], [local.id, foreign.id], ["channel-work", channel.project_id], ["bad-project-work", foreign.id]];
    for (const [n, [work, project]] of targets.entries()) await usageStatement(env.HUB_DB, { id: `bad-${n}`, source: "reported", purpose: "coding", provider: "p", model: "m", tenant_id: w.t.id, identity_id: w.patId, project_id: project, work_item_id: work, ok: true, ms: 0, input_tokens: null, output_tokens: null, reported_cost_micros: 100, created_at: Date.now() }).run();
    await usageStatement(env.HUB_DB, { id: "foreign-call", source: "reported", purpose: "coding", provider: "p", model: "foreign-model-secret", tenant_id: other.id, identity_id: w.patId, project_id: foreign.id, work_item_id: "foreign-work", ok: true, ms: 0, input_tokens: null, output_tokens: null, reported_cost_micros: 99999, created_at: Date.now() }).run();
    const r = await w.call(w.pat, "usage.summary", {});
    expect(r.result.byWork).toMatchObject([{ key: "unmatched", label: "No matching work item", ref: null, calls: 4, input_tokens: 0, output_tokens: 0, cost_micros: 400, unpriced: 0 }]);
    const page = await (await SELF.fetch(`https://${HOST}/usage`, { headers: w.pat })).text();
    for (const text of ["foreign-secret", "channel-secret", "Private foreign title", "foreign-model-secret"]) {
      expect(JSON.stringify(r.result)).not.toContain(text);
      expect(page).not.toContain(text);
    }
    expect((await SELF.fetch(`https://${HOST}/usage`)).status).toBe(404);
  });

  it("respects the period and exposes truthful work coverage through agent MCP", async () => {
    const w = await world();
    await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Build" });
    await w.call(w.bot, "usage.report", { calls: [
      { provider: "unknown", model: "fresh", work: "site#1" },
      { provider: "unknown", model: "old", work: "site#1", cost_usd: 99, at: new Date(Date.now() - 8 * 86_400_000).toISOString() },
    ] });
    const auth = await agentMcpAuth(new Request(`https://${HOST}/agent/mcp`, { headers: bearer(w.botToken) }), env, "acme", Date.now());
    expect(auth.kind).toBe("ok");
    if (auth.kind !== "ok") throw new Error("agent auth failed");
    const result = await callTool(auth.ctx, "usage_summary", { days: 7, work: "site#1" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ work: "site#1", total: { calls: 1, cost_micros: null }, byWork: [{ ref: "site#1", calls: 1, cost_micros: null, unpriced: 1 }], byWorkCoverage: { limit: 50, shown: 1, truncated: false } });
    const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    expect(text).toContain("By work item (1 groups shown; complete for recorded calls in this scope)");
    expect(text).toContain("price unknown (1 unpriced)");
    expect(text).toContain("not the full cost of the work");
    expect(text).toContain("for site#1");
    expect(text).not.toContain("$99");
    expect((await callTool(auth.ctx, "usage_summary", { work: "x".repeat(81) })).isError).toBe(true);
    expect((await callTool(auth.ctx, "usage_summary", { everyone: true })).isError).toBe(true);
  });
});

describe("AI usage cost provenance", () => {
  it("separates stored reported, estimated and unclassified amounts in every breakdown and UI", async () => {
    const w = await world();
    await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Build" });
    await w.call(w.root, "model.price_set", { provider: "anthropic", model: "exact-model", input_usd: 3, output_usd: 15, cached_input_usd: 0.3 }, "pimwell.test");
    const reported = await w.call(w.pat, "usage.report", { calls: [
      { provider: "anthropic", model: "exact-model", input_tokens: 1_000_000, output_tokens: 100_000, cached_tokens: 500_000, work: "site#1" },
      { provider: "anthropic", model: "exact-model", cost_usd: 0.25, work: "site#1" },
      { provider: "anthropic", model: "exact-model", cost_usd: 0, work: "site#1" },
      { provider: "anthropic", model: "exact-model-alias", input_tokens: 7, work: "site#1" },
    ] });
    expect(reported.result).toMatchObject({ reported_micros: 250_000, estimated_micros: 3_150_000, reported_calls: 2, estimated_calls: 1, unpriced: 1 });
    expect(reported.result.cost).toContain("Reported amounts: $0.25 (2 calls); API-rate estimates: $3.15 (1 call)");
    await env.HUB_DB.prepare("UPDATE model_call SET cost_source = NULL WHERE cost_micros = 250000").run();
    const summary = await w.call(w.pat, "usage.summary", { project: "site", work: "site#1" });
    const money = { calls: 4, reported_micros: 0, reported_calls: 1, estimated_micros: 3_150_000, estimated_calls: 1, unclassified_micros: 250_000, unclassified_calls: 1, unpriced: 1 };
    expect(summary.result.total).toMatchObject({ ...money, input_tokens: 1_000_007, output_tokens: 100_000, cached_tokens: 500_000, input_known: 2, output_known: 1 });
    for (const key of ["byWho", "bySource", "byDay", "byWork"]) expect(summary.result[key]).toMatchObject([money]);
    expect(summary.result.byModel).toMatchObject([{ calls: 3, estimated_micros: 3_150_000 }, { calls: 1, estimated_micros: null, unpriced: 1 }]);
    const page = await (await SELF.fetch(`https://${HOST}/usage?project=site&work=site%231`, { headers: w.pat })).text();
    for (const text of ["Reported amounts: $0 (1 call)", "API-rate estimates: $3.15 (1 call)", "Unclassified amounts: $0.25 (1 call)", "price unknown (1 unpriced)", "2/4 input and 1/4 output counts known", "Billing mode: unknown", "Subscription fees are not configured", "not audited invoices", "not charges", "Rate-tier coverage", "anthropic/exact-model", "$3.15 · API-rate estimate", "$0.25 · unclassified amount", "$0 · reported amount", "unknown / unknown"]) expect(page).toContain(text);
    expect(page).not.toContain("$3.40");
    expect(page).not.toContain("every call priced");
  });

  it("keeps provenance sums historical and period-scoped without widening caller or tenant scope", async () => {
    const w = await world();
    const other = await seedTenant("bravo");
    const now = Date.now();
    const auth = await agentMcpAuth(new Request(`https://${HOST}/agent/mcp`, { headers: bearer(w.botToken) }), env, "acme", now);
    if (auth.kind !== "ok") throw new Error("agent auth failed");
    for (const [id, tenant, identity, at, source, amount] of [
      ["boundary", w.t.id, auth.ctx.identity!.id, now - 7 * 86_400_000, "reported", 0],
      ["outside", w.t.id, auth.ctx.identity!.id, now - 7 * 86_400_000 - 1, "reported", 99_000_000],
      ["historical-estimate", w.t.id, auth.ctx.identity!.id, now, "price", 1_000_000],
      ["unpriced", w.t.id, auth.ctx.identity!.id, now, null, null],
      ["other-person", w.t.id, w.patId, now, "reported", 88_000_000],
      ["other-tenant", other.id, auth.ctx.identity!.id, now, "reported", 77_000_000],
    ] as const) {
      await usageStatement(env.HUB_DB, { id, tenant_id: tenant, identity_id: identity, source: "reported", purpose: "coding", provider: "p", model: id, input_tokens: null, output_tokens: null, ok: true, ms: 0, created_at: at }).run();
      await env.HUB_DB.prepare("UPDATE model_call SET cost_source = ?, cost_micros = ? WHERE id = ?").bind(source, amount, id).run();
    }
    const result = await callTool(auth.ctx, "usage_summary", { days: 7 });
    expect(result.structuredContent).toMatchObject({ total: { calls: 3, reported_calls: 1, reported_micros: 0, estimated_calls: 1, estimated_micros: 1_000_000, unclassified_calls: 0, unpriced: 1, input_known: 0, output_known: 0 } });
    const text = JSON.stringify(result.content);
    for (const expected of ["Reported amounts: $0", "API-rate estimates: $1.00", "price unknown (1 unpriced)", "not audited invoices", "Billing mode is unknown"]) expect(text).toContain(expected);
    for (const excluded of ["outside", "other-person", "other-tenant", "$99", "$88", "$77"]) expect(JSON.stringify(result)).not.toContain(excluded);
  });

  it("shows empty monetary categories as absent records rather than zero charges", async () => {
    const w = await world();
    const summary = await w.call(w.pat, "usage.summary", {});
    expect(summary.result.total).toMatchObject({ calls: 0, reported_micros: null, estimated_micros: null, unclassified_micros: null, reported_calls: 0, estimated_calls: 0, unclassified_calls: 0, unpriced: 0, input_known: 0, output_known: 0 });
    const page = await (await SELF.fetch(`https://${HOST}/usage`, { headers: w.pat })).text();
    expect(page).toContain("Reported amounts: none recorded (0 calls)");
    expect(page).toContain("API-rate estimates: none recorded (0 calls)");
    expect(page).not.toContain("$0");
  });
});

describe("AI usage accounting", () => {
  it("records reported calls, priced from the table, from the report, or left unknown", async () => {
    const w = await world();
    expect((await w.call(w.root, "model.price_set", { provider: "anthropic", model: "big-1", input_usd: "3", output_usd: "15", cached_input_usd: "0.3" }, "pimwell.test")).status).toBe(200);
    const r = await w.call(w.pat, "usage.report", { calls: [
      { provider: "anthropic", model: "big-1", input_tokens: 1_000_000, output_tokens: 100_000, cached_tokens: 500_000, client: "claude-code", work: "site#1" },
      { provider: "openai", model: "mystery", input_tokens: 10, output_tokens: 10 },
      { provider: "openai", model: "paid", input_tokens: 10, output_tokens: 10, cost_usd: 0.25 },
    ] });
    expect(r.status, JSON.stringify(r)).toBe(404);
    await w.call(w.pat, "work.create", { project: "site", kind: "errand", title: "Build" });
    const ok = await w.call(w.pat, "usage.report", { calls: [
      { provider: "anthropic", model: "big-1", input_tokens: 1_000_000, output_tokens: 100_000, cached_tokens: 500_000, client: "claude-code", work: "site#1" },
      { provider: "openai", model: "mystery", input_tokens: 10, output_tokens: 10 },
      { provider: "openai", model: "paid", input_tokens: 10, output_tokens: 10, cost_usd: 0.25 },
    ] });
    expect(ok.result).toMatchObject({ recorded: 3, unpriced: 1 });
    // 0.5M uncached × $3 + 0.5M cached × $0.30 + 0.1M out × $15 = 1.5 + 0.15 + 1.5 = $3.15
    expect(await costs()).toEqual([
      { model: "big-1", cost_micros: 3_150_000, cost_source: "price", source: "reported" },
      { model: "mystery", cost_micros: null, cost_source: null, source: "reported" },
      { model: "paid", cost_micros: 250_000, cost_source: "reported", source: "reported" },
    ]);
    const linked = await env.HUB_DB.prepare("SELECT work_item_id IS NOT NULL AS linked, client, identity_id FROM model_call WHERE model = 'big-1'").first();
    expect(linked).toEqual({ linked: 1, client: "claude-code", identity_id: w.patId });
  });

  it("keeps a call's cost when the price changes later", async () => {
    const w = await world();
    await w.call(w.root, "model.price_set", { provider: "openai", model: "m", input_usd: "1", output_usd: "1" }, "pimwell.test");
    await w.call(w.pat, "usage.report", { provider: "openai", model: "m", input_tokens: 1_000_000, output_tokens: 0 });
    await env.HUB_DB.prepare("UPDATE model_price SET effective_from = effective_from - 1000").run();
    await w.call(w.root, "model.price_set", { provider: "openai", model: "m", input_usd: "9", output_usd: "9" }, "pimwell.test");
    expect((await costs())[0]).toMatchObject({ cost_micros: 1_000_000 });
  });

  it("refuses bad reports and lets only root set prices", async () => {
    const w = await world();
    expect((await w.call(w.pat, "usage.report", { provider: "openai", model: "m", input_tokens: -1, output_tokens: 0 })).status).toBe(400);
    // Tokens are optional: a tool that doesn't show them still reports, and the call is counted, unpriced.
    const bare = await w.call(w.pat, "usage.report", { provider: "anthropic", model: "big-1", client: "hermes" });
    expect(bare.status, JSON.stringify(bare)).toBe(200);
    expect(bare.result).toMatchObject({ recorded: 1, unpriced: 1 });
    expect((await w.call(w.pat, "usage.report", { provider: "openai", model: "m", cost_usd: 0.12 })).status).toBe(200);
    expect((await w.call(w.pat, "usage.report", { model: "m" })).status).toBe(400);
    expect((await w.call(w.pat, "usage.report", { provider: "open ai; drop", model: "m", input_tokens: 1, output_tokens: 0 })).status).toBe(400);
    expect((await w.call(w.pat, "usage.report", { calls: [] })).status).toBe(400);
    expect((await w.call(w.pat, "usage.report", { provider: "openai", model: "m", input_tokens: 1, output_tokens: 1, at: "2001-01-01T00:00:00Z" })).status).toBe(400);
    expect((await w.call(cookieHeaders("nope", "pimwell.test"), "model.price_set", { provider: "a", model: "b", input_usd: 1, output_usd: 1 }, "pimwell.test")).status).not.toBe(200);
  });

  it("shows members their own usage and admins everyone's; agents report too", async () => {
    const w = await world();
    await w.call(w.pat, "usage.report", { provider: "openai", model: "m", input_tokens: 5, output_tokens: 5 });
    expect((await w.call(w.bot, "usage.report", { provider: "anthropic", model: "a", input_tokens: 7, output_tokens: 7, client: "agent-runner" })).status).toBe(200);
    const mine = await w.call(w.pat, "usage.summary", {});
    expect((mine.result.total as { calls: number }).calls).toBe(1);
    expect((await w.call(w.pat, "usage.summary", { everyone: true })).status).toBe(403);
    const all = await w.call(w.ada, "usage.summary", { everyone: true });
    expect((all.result.total as { calls: number }).calls).toBe(2);
    const page = await (await SELF.fetch(`https://${HOST}/usage`, { headers: w.ada })).text();
    expect(page).toContain("By person or agent");
    const patPage = await (await SELF.fetch(`https://${HOST}/usage?who=ada%40example.com`, { headers: w.pat })).text();
    expect(patPage).not.toContain("By person or agent");
    expect(patPage).toContain("<h1>pat@example.com</h1>");
  });
});
