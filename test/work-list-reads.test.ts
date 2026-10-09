import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/auth/context";
import { createProject } from "../src/db/projects";
import { listWorkWithProjects } from "../src/db/work";
import { meteredD1, type Meter } from "../src/perf";
import { workList } from "../src/verbs/work";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

async function world() {
  const t = await seedTenant("acme"), now = Date.now();
  const h = await seedHuman("reader@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
  const ctx = await buildContext(new Request("https://acme.pimwell.test/", { headers: cookieHeaders(h.token, "acme.pimwell.test") }), env, now);
  const meter: Meter = { trips: 0, statements: 0, ms: 0 };
  ctx.db = meteredD1(env.HUB_DB, meter);
  return { t, now, h, ctx, meter };
}
async function project(w: Awaited<ReturnType<typeof world>>, slug: string) {
  return createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug, kind: "repo", display_name: slug }, w.now);
}
async function row(w: Awaited<ReturnType<typeof world>>, projectId: string, id: string, n = 1, state = "open", kind = "snag", at = w.now, tenant = w.t.id) {
  await env.HUB_DB.prepare(`INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`)
    .bind(id, tenant, projectId, n, kind, id, state, w.h.identity.id, at, at, w.h.identity.id).run();
}

describe("joined work-list project references", () => {
  it("uses one query across 25 distinct projects and retains every field/ref in deterministic order", async () => {
    const w = await world();
    for (let n = 0; n < 25; n++) { const p = await project(w, `p${n}`); await row(w, p.id, `item${n}`); }
    const r = await workList.run(w.ctx, workList.parse({ limit: 200 }));
    expect(r.items).toHaveLength(25);
    expect(r.items.map(i => i.id)).toEqual(Array.from({ length: 25 }, (_, n) => `item${n}`).sort().reverse());
    for (const i of r.items) {
      expect(i.ref).toBe(`${i.project}#1`); expect(i.project).toBe(`p${i.id.slice(4)}`);
      expect(i.tenant_id).toBe(w.t.id); expect(i.created_by).toBe(w.h.identity.id);
    }
    expect(w.meter).toMatchObject({ trips: 1, statements: 1 });
    expect(workList.mcp!.render!(r)).toContain("p0#1");
  });

  it("preserves state/kind/owner/project/limit filters without per-project slug reads", async () => {
    const w = await world(), p = await project(w, "site"), p2 = await project(w, "second");
    await row(w, p.id, "mine", 1, "done", "spark", w.now - 1);
    await row(w, p.id, "other-kind", 2, "done", "snag");
    await row(w, p.id, "other-state", 3, "open", "spark");
    await row(w, p2.id, "other-project", 1, "done", "spark");
    const r = await workList.run(w.ctx, workList.parse({ project: "site", state: "done", kind: "idea", owner: "me", limit: 1 }));
    expect(r.items.map(i => i.ref)).toEqual(["site#1"]);
    expect(w.meter).toMatchObject({ trips: 2, statements: 2 }); // one project validation, one joined item query
    const filtered = await listWorkWithProjects(env.HUB_DB, w.t.id, { project_id: p.id, states: [], owner_email: " READER@EXAMPLE.COM ", before: w.now, limit: 50 });
    expect(filtered.map(i => i.id)).toEqual(["mine"]);
  });

  it("filters malformed tenant/project and channel rows before LIMIT, not after returning their private slugs", async () => {
    const w = await world(), p = await project(w, "site"), other = await seedTenant("other");
    const foreign = await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "secret", kind: "repo", display_name: "SECRET" }, w.now);
    await env.HUB_DB.prepare("INSERT INTO project (id, tenant_id, slug, kind, display_name, state, created_at) VALUES ('channel', ?, 'general', 'channel', 'General', 'active', ?)").bind(w.t.id, w.now).run();
    await row(w, p.id, "visible", 1, "open", "snag", w.now - 1000);
    await row(w, foreign.id, "wrong-project");
    await row(w, foreign.id, "foreign", 2, "open", "snag", w.now, other.id);
    await row(w, p.id, "wrong-tenant", 2, "open", "snag", w.now, other.id);
    await row(w, "channel", "channel-item");
    const r = await workList.run(w.ctx, workList.parse({ limit: 1 }));
    expect(r.items.map(i => i.ref)).toEqual(["site#1"]);
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(w.meter).toMatchObject({ trips: 1, statements: 1 });
  });

  it("retains parent-id and project-local parent-number filtering in the shared statement", async () => {
    const w = await world(), p = await project(w, "site"), p2 = await project(w, "second");
    await row(w, p.id, "quest", 1, "open", "quest");
    await row(w, p.id, "child", 2);
    await row(w, p2.id, "second", 1);
    await env.HUB_DB.prepare("UPDATE work_item SET parent_id = 'quest' WHERE id = 'child'").run();
    const byId = await listWorkWithProjects(env.HUB_DB, w.t.id, { parent_id: "quest", limit: 50 });
    const byNumber = await listWorkWithProjects(env.HUB_DB, w.t.id, { project_id: p.id, parent_number: 1, limit: 50 });
    expect(byId.map(i => i.id)).toEqual(["child"]); expect(byNumber).toEqual(byId);
  });
});
