import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext, type Ctx } from "../src/auth/context";
import { createProject } from "../src/db/projects";
import { board, workBoard } from "../src/verbs/board";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
// The actual pre-increment query, for differential semantics and local read-work
// comparisons. No substitute algorithm or production-sized latency claim.
const BEFORE = `SELECT p.slug, q.number, q.title, q.state,
  (SELECT COUNT(*) FROM work_item c WHERE c.parent_id = q.id AND c.tenant_id = q.tenant_id AND c.project_id = q.project_id AND c.state = 'done') AS done,
  (SELECT COUNT(*) FROM work_item c WHERE c.parent_id = q.id AND c.tenant_id = q.tenant_id AND c.project_id = q.project_id AND c.state <> 'dropped') AS total
  FROM work_item q JOIN project p ON p.id = q.project_id WHERE q.tenant_id = ? AND p.tenant_id = q.tenant_id AND p.kind <> 'channel' AND (? IS NULL OR p.slug = ?) AND q.kind = 'quest' AND q.state IN ('open', 'doing') ORDER BY q.number, q.id`;

async function world() {
  const t = await seedTenant("acme"), now = Date.now();
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
  const h = await seedHuman("reader@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
  const headers = cookieHeaders(h.token, HOST);
  const ctx = await buildContext(new Request(`https://${HOST}/`, { headers }), env, now);
  return { t, p, h, ctx, now, headers };
}
type World = Awaited<ReturnType<typeof world>>;
async function row(w: World, id: string, n: number, kind: string, state: string, parent: string | null = null, project = w.p.id, tenant = w.t.id) {
  await env.HUB_DB.prepare(`INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, parent_id, created_by, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`)
    .bind(id, tenant, project, n, kind, id, state, parent, w.h.identity.id, w.now - 30 * 86400000, w.now, null).run();
}

/** Capture the real bound quest statement and D1 read-work, without changing its execution. */
async function measured(ctx: Ctx, project: string | null) {
  let sql = "", args: unknown[] = [], meta: D1Meta | undefined;
  const db = new Proxy(ctx.db, {
    get(target, key) {
      if (key === "prepare") return (query: string) => {
        const statement = target.prepare(query);
        if (!query.includes("q.number")) return statement;
        sql = query;
        return new Proxy(statement, {
          get(s, name) {
            if (name === "bind") return (...values: unknown[]) => { args = values; return s.bind(...values); };
            const value = Reflect.get(s, name);
            return typeof value === "function" ? value.bind(s) : value;
          },
        });
      };
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await target.batch(statements);
        meta = result[1]!.meta;
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await board({ ...ctx, db }, project);
  const plan = await ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>();
  const before = await ctx.db.prepare(BEFORE).bind(ctx.tenant!.id, project, project).all();
  expect(result.quests.map(({ ref: _, ...q }) => q)).toEqual(before.results);
  return { result, meta: meta!, before, plan: plan.results.map(r => r.detail) };
}

describe("request-local quest child aggregation", () => {
  it("preserves zero/mixed/dropped/nested/old-done semantics and ordering across browser/MCP", async () => {
    const w = await world();
    await row(w, "empty", 1, "quest", "open");
    await row(w, "mixed", 2, "quest", "doing");
    await row(w, "dropped-only", 3, "quest", "open");
    await row(w, "old-done", 4, "snag", "done", "mixed"); // no closed_at; still counts for quest
    await row(w, "open", 5, "snag", "open", "mixed");
    await row(w, "doing", 6, "snag", "doing", "mixed");
    await row(w, "dropped", 7, "snag", "dropped", "mixed");
    await row(w, "nested", 8, "quest", "open", "mixed");
    await row(w, "grandchild", 9, "snag", "done", "nested");
    await row(w, "ignored", 10, "snag", "dropped", "dropped-only");
    await row(w, "done-quest", 11, "quest", "done");
    await row(w, "dropped-quest", 12, "quest", "dropped");
    await row(w, "not-a-quest", 13, "snag", "open");
    await row(w, "nonquest-child", 14, "snag", "done", "not-a-quest");
    const { result: b } = await measured(w.ctx, "site");
    expect(b.quests.map(q => [q.ref, q.done, q.total])).toEqual([
      ["site#1", 0, 0], ["site#2", 1, 4], ["site#3", 0, 0], ["site#8", 1, 1],
    ]);
    expect(workBoard.mcp!.render!(b)).toContain("**site#2** mixed: 1/4 done");
    const html = await (await SELF.fetch(`https://${HOST}/site/board`, { headers: w.headers })).text();
    expect(html).toContain("1 of 4 done"); expect(html).toContain("0 of 0 done");
    expect((await measured(w.ctx, "absent")).result.quests).toEqual([]);
  });

  it("isolates both child and quest tenant/project/channel scope, including malformed rows", async () => {
    const w = await world(), foreign = await seedTenant("foreign");
    const second = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "second", kind: "repo", display_name: "Second" }, w.now);
    const other = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "site", kind: "repo", display_name: "SECRET" }, w.now);
    await env.HUB_DB.prepare("INSERT INTO project (id, tenant_id, slug, kind, display_name, state, created_at) VALUES ('channel', ?, 'general', 'channel', 'General', 'active', ?)").bind(w.t.id, w.now).run();
    await row(w, "quest", 1, "quest", "open");
    await row(w, "valid", 2, "snag", "done", "quest");
    await row(w, "second-quest", 1, "quest", "doing", null, second.id);
    await row(w, "second-child", 2, "snag", "open", "second-quest", second.id);
    const cases = [
      ["foreign", other.id, foreign.id], ["wrong-project", other.id, w.t.id],
      ["wrong-tenant", w.p.id, foreign.id], ["channel-child", "channel", w.t.id],
      ["cross-project-child", second.id, w.t.id],
    ];
    for (const [id, project, tenant] of cases) await row(w, id!, 20 + cases.findIndex(c => c[0] === id), "quest", "done", "quest", project!, tenant!);
    await row(w, "SECRET", 30, "quest", "open", null, other.id, foreign.id);
    await row(w, "wrong-project-quest", 31, "quest", "open", null, other.id);
    await row(w, "wrong-tenant-quest", 32, "quest", "open", null, w.p.id, foreign.id);
    await row(w, "channel-quest", 33, "quest", "open", null, "channel");
    const scoped = await measured(w.ctx, "site"), org = await measured(w.ctx, null);
    expect(scoped.result.quests.map(q => [q.ref, q.done, q.total])).toEqual([["site#1", 1, 1]]);
    expect(org.result.quests.map(q => [q.ref, q.done, q.total])).toEqual([["site#1", 1, 1], ["second#1", 0, 1]]);
    expect(JSON.stringify(org.result.quests)).not.toContain("SECRET");
    expect((await measured(w.ctx, "general")).result.quests).toEqual([]);
  });

  it("recomputes after state/parent changes, including reopens and dropped children; no cross-request cache", async () => {
    const w = await world();
    await row(w, "one", 1, "quest", "open"); await row(w, "two", 2, "quest", "doing");
    await row(w, "child", 3, "snag", "open", "one");
    const counts = async () => (await measured(w.ctx, null)).result.quests.map(q => [q.done, q.total]);
    expect(await counts()).toEqual([[0, 1], [0, 0]]);
    await env.HUB_DB.prepare("UPDATE work_item SET state = 'done' WHERE id = 'child'").run();
    expect(await counts()).toEqual([[1, 1], [0, 0]]);
    await env.HUB_DB.prepare("UPDATE work_item SET parent_id = 'two' WHERE id = 'child'").run();
    expect(await counts()).toEqual([[0, 0], [1, 1]]);
    await env.HUB_DB.prepare("UPDATE work_item SET state = 'open' WHERE id = 'child'").run();
    expect(await counts()).toEqual([[0, 0], [0, 1]]);
    await env.HUB_DB.prepare("UPDATE work_item SET state = 'dropped' WHERE id = 'child'").run();
    expect(await counts()).toEqual([[0, 0], [0, 0]]);
  });

  it.each(["site", null])("materializes one scoped child aggregation instead of two correlated child scans per quest (scope=%s)", async (scope) => {
    const w = await world();
    // 80 quests and 4,000 children in one project: a deliberately adverse case
    // for the original project-index scans. Populate test D1 only, never live.
    await env.HUB_DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 80)
      INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at)
      SELECT 'q' || x, ?, ?, x, 'quest', 'Quest ' || x, '', 'open', ?, ?, ? FROM n`)
      .bind(w.t.id, w.p.id, w.h.identity.id, w.now, w.now).run();
    await env.HUB_DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 4000)
      INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, parent_id, created_by, created_at, updated_at)
      SELECT 'c' || x, ?, ?, x+80, 'snag', 'Child ' || x, '', CASE WHEN x%2 = 0 THEN 'done' ELSE 'open' END, 'q' || (((x-1)%80)+1), ?, ?, ? FROM n`)
      .bind(w.t.id, w.p.id, w.h.identity.id, w.now, w.now).run();
    const { result, meta, before, plan } = await measured(w.ctx, scope);
    expect(result.quests).toHaveLength(80);
    expect(result.quests.reduce((n, q) => n + q.total, 0)).toBe(4000);
    expect(result.quests.reduce((n, q) => n + q.done, 0)).toBe(2000);
    expect(plan.some(s => s.includes("MATERIALIZE child_counts"))).toBe(true);
    expect(plan.some(s => s.includes("CORRELATED"))).toBe(false);
    // Read work, not timing, and only the quest statement (not total page cost).
    expect(meta.rows_read).toBeLessThan(before.meta.rows_read / 10);
    expect(before.meta.rows_read).toBeGreaterThan(4000);
    const oldPlan = await env.HUB_DB.prepare(`EXPLAIN QUERY PLAN ${BEFORE}`).bind(w.t.id, scope, scope).all<{ detail: string }>();
    expect(oldPlan.results.filter(r => r.detail.includes("CORRELATED"))).toHaveLength(2);
  });
});
