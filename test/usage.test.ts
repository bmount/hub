// AI usage accounting (migration 0012): one ledger, priced when recorded, reported from any tool.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { createChannel } from "../src/db/chat";
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
    expect(mine.result.byWork).toEqual([
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
    expect(page).toContain("+1 unpriced");
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
    expect(r.result.byWork).toEqual([{ key: "unmatched", label: "No matching work item", ref: null, calls: 4, input_tokens: 0, output_tokens: 0, cost_micros: 400, unpriced: 0 }]);
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
    const result = await callTool(auth.ctx, "usage_summary", { days: 7 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ total: { calls: 1, cost_micros: null }, byWork: [{ ref: "site#1", calls: 1, cost_micros: null, unpriced: 1 }], byWorkCoverage: { limit: 50, shown: 1, truncated: false } });
    const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    expect(text).toContain("By work item (1 groups shown; complete for recorded calls in this scope)");
    expect(text).toContain("price unknown (1 unpriced)");
    expect(text).toContain("not the full cost of the work");
    expect(text).not.toContain("$99");
    expect((await callTool(auth.ctx, "usage_summary", { everyone: true })).isError).toBe(true);
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
