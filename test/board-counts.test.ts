import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/auth/context";
import { createProject } from "../src/db/projects";
import { board, workBoard, type Board } from "../src/verbs/board";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test", DAY = 86_400_000;
async function world() {
  const t = await seedTenant("acme"), now = Date.now();
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
  const h = await seedHuman("reader@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
  const headers = cookieHeaders(h.token, HOST);
  const ctx = await buildContext(new Request(`https://${HOST}/`, { headers }), env, now);
  return { t, p, h, ctx, now, headers };
}
async function rows(w: Awaited<ReturnType<typeof world>>, prefix: string, count: number, state: string, updated: number, closed: number | null = null) {
  await env.HUB_DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at, closed_at)
    SELECT ? || x, ?, ?, COALESCE((SELECT MAX(number) FROM work_item WHERE project_id = ?), 0) + x, 'snag', ? || x, '', ?, ?, ?, ?, ? FROM n`)
    .bind(count, prefix, w.t.id, w.p.id, w.p.id, prefix, state, w.h.identity.id, updated, updated, closed).run();
}
type ExactBoard = Board;

describe("exact board totals and bounded examples", () => {
  it("counts stalled and every column independently of the global 500-item sample across API/MCP/browser", async () => {
    const w = await world();
    await rows(w, "open", 510, "open", w.now - 1000);
    await rows(w, "doing", 45, "doing", w.now - 8 * DAY);
    await rows(w, "done", 30, "done", w.now - DAY, w.now - DAY);
    await rows(w, "old", 5, "done", w.now - 20 * DAY, w.now - 20 * DAY);
    await rows(w, "dropped", 5, "dropped", w.now);
    const b = await board(w.ctx, "site") as ExactBoard;
    expect(b.totals).toEqual({ open: 510, doing: 45, done: 30 });
    expect(b.stalled).toBe(45);
    expect(b.columns.open).toHaveLength(500);
    expect(b.columns.doing).toEqual([]); expect(b.columns.done).toEqual([]);
    expect(b.examples).toEqual({ limit: 500, shown: 500, truncated: true });
    const text = workBoard.mcp!.render!(b);
    expect(text).toContain("Under way (45; showing 0)");
    expect(text).toContain("Open (510; showing 40)");
    expect(text).toContain("Done lately (30; showing 0)");
    expect(text).toContain("45 stalled"); expect(text).toContain("latest 500-item sample");
    const res = await apiPost(HOST, "work.board", { project: "site" }, w.headers);
    expect(res.status).toBe(200);
    expect((await res.json() as { result: ExactBoard }).result.totals).toEqual(b.totals);
    const html = await (await SELF.fetch(`https://${HOST}/site/board`, { headers: w.headers })).text();
    expect(html).toContain('Under way <span class="pill">45</span>');
    expect(html).toContain('Open <span class="pill">510</span>');
    expect(html).toContain("Showing 60 of 510"); expect(html).toContain("Showing 0 of 45");
    expect(html).toContain("No examples in the latest-item sample"); expect(html).not.toContain('None.</p>');
  });

  it("uses strict done/stall boundaries and reports empty and complete samples truthfully", async () => {
    const w = await world();
    const empty = await board(w.ctx, null) as ExactBoard;
    expect(empty.totals).toEqual({ open: 0, doing: 0, done: 0 });
    expect(empty.examples).toEqual({ limit: 500, shown: 0, truncated: false });
    await rows(w, "boundary", 1, "doing", w.now - 7 * DAY);
    await rows(w, "stalled", 1, "doing", w.now - 7 * DAY - 1);
    await rows(w, "excluded", 1, "done", w.now, w.now - 14 * DAY);
    await rows(w, "included", 1, "done", w.now, w.now - 14 * DAY + 1);
    await rows(w, "noclose", 1, "done", w.now);
    const b = await board(w.ctx, null) as ExactBoard;
    expect(b.totals).toEqual({ open: 0, doing: 2, done: 1 }); expect(b.stalled).toBe(1);
    expect(b.examples).toEqual({ limit: 500, shown: 3, truncated: false });
    expect(b.columns.doing.map(i => i.stalled).sort()).toEqual([false, true]);
  });

  it("reports exactly 500 as complete and uses deterministic newest-first tie ordering", async () => {
    const w = await world(); await rows(w, "item", 500, "open", w.now);
    const b = await board(w.ctx, "site") as ExactBoard;
    expect(b.totals).toEqual({ open: 500, doing: 0, done: 0 });
    expect(b.examples).toEqual({ limit: 500, shown: 500, truncated: false });
    expect(b.columns.open.map(i => i.title)).toEqual(Array.from({ length: 500 }, (_, i) => `item${i+1}`).sort().reverse());
  });

  it("keeps same-slug foreign projects, channels and inconsistent tenant/project/parent rows out of totals and quests", async () => {
    const w = await world(), other = await seedTenant("other");
    const p2 = await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "site", kind: "repo", display_name: "SECRET" }, w.now);
    const p3 = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "second", kind: "repo", display_name: "Second" }, w.now);
    await env.HUB_DB.prepare("INSERT INTO project (id, tenant_id, slug, kind, display_name, state, created_at) VALUES ('channel', ?, 'general', 'channel', 'General', 'active', ?)").bind(w.t.id, w.now).run();
    await rows(w, "mine", 2, "open", w.now);
    await env.HUB_DB.prepare("UPDATE work_item SET kind = 'quest' WHERE id = 'mine1'").run();
    await env.HUB_DB.prepare("UPDATE work_item SET parent_id = 'mine1', state = 'done', closed_at = ? WHERE id = 'mine2'").bind(w.now).run();
    const cases = [["foreign", other.id, p2.id], ["wrong-project", w.t.id, p2.id], ["wrong-tenant", other.id, w.p.id], ["channel-work", w.t.id, "channel"], ["other-project-child", w.t.id, p3.id]];
    for (const [id, tenant, project] of cases) await env.HUB_DB.prepare(`INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, parent_id, created_by, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, 'quest', 'SECRET', '', 'done', 'mine1', ?, ?, ?, ?)`)
      .bind(id, tenant, project, cases.findIndex(c => c[0] === id) + 10, w.h.identity.id, w.now, w.now, w.now).run();
    const b = await board(w.ctx, "site") as ExactBoard;
    expect(b.totals).toEqual({ open: 1, doing: 0, done: 1 });
    expect(b.quests).toMatchObject([{ ref: "site#1", done: 1, total: 1 }]);
    expect(JSON.stringify(b)).not.toContain("SECRET");
    const org = await board(w.ctx, null) as ExactBoard;
    expect(org.totals).toEqual({ open: 1, doing: 0, done: 2 }); // legitimate second-project item only
    expect((await board(w.ctx, "general") as ExactBoard).totals).toEqual({ open: 0, doing: 0, done: 0 });
    const outsider = await seedHuman("outsider@example.com");
    expect((await apiPost(HOST, "work.board", {}, cookieHeaders(outsider.token, HOST))).status).not.toBe(200);
    expect((await SELF.fetch(`https://${HOST}/board`)).status).toBe(404);
  });
});
