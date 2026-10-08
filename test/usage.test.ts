// AI usage accounting (migration 0012): one ledger, priced when recorded, reported from any tool.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
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
  return { t, pat: cookieHeaders(pat.token, HOST), ada: cookieHeaders(ada.token, HOST), root: cookieHeaders(root.token, "pimwell.test"), bot: bearer(bot.token), call, patId: pat.identity.id };
}
const costs = async () => (await env.HUB_DB.prepare("SELECT model, cost_micros, cost_source, source FROM model_call ORDER BY model").all()).results;

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
