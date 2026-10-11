// The work graph (docs/ops/work-graph.md): pure graph rules, then the acceptance scenarios end to end through /api.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { claimWork, getWork, LEASE_MS } from "../src/db/work";
import { changeDeps } from "../src/work/graphEdit";
import { closure, criticalPath, findCycle, rankReady, readiness, topoOrder, type Edge, type GraphNode } from "../src/work/graph";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const e = (prereq_id: string, dependent_id: string): Edge => ({ prereq_id, dependent_id });
const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, state: "open", owner_id: null, lease_until: null, priority: 2, estimate: null, created_at: 0, ...extra });

describe("graph rules", () => {
  it("computes closures both ways, nearest first", () => {
    const edges = [e("a", "b"), e("b", "c"), e("a", "d"), e("x", "c")];
    expect(closure(edges, "a", "down")).toEqual(["b", "d", "c"]);
    expect(closure(edges, "c", "up")).toEqual(["b", "x", "a"]);
  });

  it("finds cycles and orders acyclic graphs with prerequisites first, then by urgency", () => {
    expect(findCycle([e("a", "b"), e("b", "c")])).toBeNull();
    expect(findCycle([e("a", "b"), e("b", "c"), e("c", "a")])).toEqual(["a", "b", "c", "a"]);
    const nodes = [node("a", { priority: 3 }), node("b"), node("c", { priority: 0 })];
    expect(topoOrder(nodes, [e("a", "b")])).toEqual(["c", "a", "b"]);
    expect(() => topoOrder(nodes, [e("a", "b"), e("b", "a")])).toThrow(/cycle/);
  });

  it("measures the longest chain of open work, counting done items as zero", () => {
    const nodes = [node("a", { estimate: 3 }), node("b", { estimate: 5 }), node("c"), node("d", { state: "done", estimate: 9 })];
    const cp = criticalPath(nodes, [e("a", "b"), e("b", "c"), e("d", "c")]);
    expect([cp.get("a"), cp.get("b"), cp.get("c"), cp.get("d")]).toEqual([9, 6, 1, 1]);
  });

  it("keeps lifecycle and readiness apart: only done prerequisites count, live claims hold, resources conflict", () => {
    const now = 1000;
    const nodes = [node("p", { state: "dropped" }), node("q", { state: "done" }), node("a"), node("b"), node("c", { state: "doing", owner_id: "u", lease_until: now + 1 }),
      node("d"), node("e", { state: "doing", owner_id: "u", lease_until: now - 1 })];
    const r = readiness(nodes, [e("p", "a"), e("q", "b")], [{ item_id: "c", name: "db", mode: "exclusive" }, { item_id: "d", name: "db", mode: "shared" }], now);
    expect(r.get("p")).toEqual({ status: "closed" });
    expect(r.get("a")).toEqual({ status: "blocked", waiting_on: ["p"], claimed: false });
    expect(r.get("b")).toEqual({ status: "ready" });
    expect(r.get("c")).toEqual({ status: "claimed", owner_id: "u", until: now + 1 });
    expect(r.get("d")).toEqual({ status: "conflict", with: ["c"] });
    expect(r.get("e")).toEqual({ status: "ready" });
  });

  it("ranks ready work by priority, then critical path, then downstream impact, then shortest", () => {
    const nodes = [node("short", { estimate: 1 }), node("long", { estimate: 8 }), node("unblocks"), node("after"), node("urgent", { priority: 0 })];
    const edges = [e("unblocks", "after")];
    const ranked = rankReady(nodes, edges, readiness(nodes, edges, [], 0)).map((x) => x.id);
    expect(ranked).toEqual(["urgent", "long", "unblocks", "short"]);
  });
});

type Item = { id: string; number: number; state: string; owner_id: string | null; updated_at: number };
type Ready = { status: string; waiting_on?: string[]; with?: string[] };

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const as = (h: { token: string }) => (verb: string, body: unknown) => apiPost(HOST, verb, body, cookieHeaders(h.token, HOST));
  const call = { pat: as(pat), sam: as(sam) };
  const ok = async <T>(r: Response) => { expect(r.status, await r.clone().text()).toBe(200); return ((await r.json()) as { result: T }).result; };
  const file = async (title: string, extra: Record<string, unknown> = {}) => (await ok<{ item: Item; ref: string }>(await call.pat("work.create", { project: "site", kind: "errand", title, ...extra })));
  const readiness = async (ref: string) => (await ok<{ readiness: Ready }>(await call.pat("work.read", { id: ref }))).readiness;
  const deps = async () => (await env.HUB_DB.prepare("SELECT prereq_id, dependent_id FROM work_dep ORDER BY prereq_id, dependent_id").all<Edge>()).results;
  return { t, pat, sam, call, ok, file, readiness, deps };
}

describe("work graph acceptance", () => {
  it("refuses a cyclic hard dependency and changes nothing", async () => {
    const w = await world();
    const [a, b, c] = [await w.file("A"), await w.file("B"), await w.file("C")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    await w.ok(await w.call.pat("work.depend", { id: c.ref, on: [b.ref] }));
    const before = await w.deps();
    const refused = await w.call.pat("work.depend", { id: a.ref, on: c.ref });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain("dependency cycle");
    for (const r of [a.ref, b.ref, c.ref]) expect(text).toContain(r);
    expect(await w.call.pat("work.depend", { id: a.ref, on: a.ref }).then((r) => r.status)).toBe(400);
    expect(await w.deps()).toEqual(before);
  });

  it("unlocks dependent work when its prerequisite is done, and only done counts", async () => {
    const w = await world();
    const [a, b] = [await w.file("Schema"), await w.file("Feature")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    expect(await w.readiness(b.ref)).toEqual({ status: "blocked", waiting_on: ["site#1"], claimed: false });
    const refused = await w.call.sam("work.claim", { id: b.ref });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("waits on site#1");
    await w.ok(await w.call.pat("work.update", { id: a.ref, state: "dropped" }));
    expect((await w.readiness(b.ref)).status).toBe("blocked");
    await w.ok(await w.call.pat("work.update", { id: a.ref, state: "done" }));
    expect(await w.readiness(b.ref)).toEqual({ status: "ready" });
    await w.ok(await w.call.sam("work.claim", { id: b.ref }));
  });

  it("does not block on parents, children or links", async () => {
    const w = await world();
    const quest = await w.ok<{ item: Item; ref: string }>(await w.call.pat("work.create", { project: "site", kind: "quest", title: "Big goal" }));
    const child = await w.file("Part of it", { parent: quest.item.number });
    const other = await w.file("Related");
    await w.ok(await w.call.pat("work.link", { id: child.ref, target_kind: "item", target_ref: other.ref }));
    expect(await w.readiness(child.ref)).toEqual({ status: "ready" });
    expect(await w.readiness(quest.ref)).toEqual({ status: "ready" });
    await w.ok(await w.call.sam("work.claim", { id: child.ref }));
  });

  it("lets exactly one of two simultaneous claimers win", async () => {
    const w = await world();
    const a = await w.file("Contested");
    const [r1, r2] = await Promise.all([w.call.pat("work.claim", { id: a.ref }), w.call.sam("work.claim", { id: a.ref })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });

  it("recovers an expired claim", async () => {
    const w = await world();
    const a = await w.file("Abandoned");
    const now = Date.now();
    const held = await claimWork(env.HUB_DB, (await getWork(env.HUB_DB, w.t.id, a.item.id))!, w.pat.identity.id, now);
    await expect(claimWork(env.HUB_DB, held, w.sam.identity.id, now + 1000)).rejects.toMatchObject({ status: 409 });
    const taken = await claimWork(env.HUB_DB, held, w.sam.identity.id, now + LEASE_MS + 1);
    expect(taken.owner_id).toBe(w.sam.identity.id);
  });

  it("treats a new dependency as invalidating readiness: a claim prepared before it is refused", async () => {
    const w = await world();
    const [a, b] = [await w.file("Found later"), await w.file("Was ready")];
    expect(await w.readiness(b.ref)).toEqual({ status: "ready" });
    const stale = (await getWork(env.HUB_DB, w.t.id, b.item.id))!;
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    await expect(claimWork(env.HUB_DB, stale, w.sam.identity.id, Date.now())).rejects.toMatchObject({ status: 409 });
    const fresh = (await getWork(env.HUB_DB, w.t.id, b.item.id))!;
    await expect(claimWork(env.HUB_DB, fresh, w.sam.identity.id, Date.now())).rejects.toThrow(/waits on site#1/);
    expect((await w.readiness(b.ref)).status).toBe("blocked");
  });

  it("applies a multi-edge change all or nothing, and serializes concurrent edits so no cycle slips through", async () => {
    const w = await world();
    const [a, b, c] = [await w.file("A"), await w.file("B"), await w.file("C")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    // a waiting on c is fine, but a waiting on b closes a cycle; in one call, the bad edge refuses both.
    expect((await w.call.pat("work.depend", { id: a.ref, on: [c.ref, b.ref] })).status).toBe(400);
    expect(await w.deps()).toEqual([{ prereq_id: a.item.id, dependent_id: b.item.id }]);
    // Two edits that are each fine alone but form a cycle together: exactly one commits.
    const actor = (id: string) => ({ tenant_id: w.t.id, identity_id: id, session_id: null });
    const results = await Promise.allSettled([
      changeDeps(env.HUB_DB, actor(w.pat.identity.id), { add: [{ prereq_id: b.item.id, dependent_id: c.item.id }], remove: [] }, Date.now()),
      changeDeps(env.HUB_DB, actor(w.sam.identity.id), { add: [{ prereq_id: c.item.id, dependent_id: a.item.id }], remove: [] }, Date.now()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(findCycle(await w.deps())).toBeNull();
  });

  it("keeps conflicting work from running at once, unless both sides are shared", async () => {
    const w = await world();
    const [a, b, c, d] = [await w.file("Migrate"), await w.file("Backfill"), await w.file("Read report"), await w.file("Read stats")];
    await w.ok(await w.call.pat("work.resources", { id: a.ref, resources: "prod-db" }));
    await w.ok(await w.call.pat("work.resources", { id: b.ref, resources: ["prod-db"] }));
    await w.ok(await w.call.pat("work.resources", { id: c.ref, resources: "replica:shared" }));
    await w.ok(await w.call.pat("work.resources", { id: d.ref, resources: "replica:shared" }));
    await w.ok(await w.call.pat("work.claim", { id: a.ref }));
    const refused = await w.call.sam("work.claim", { id: b.ref });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("held by site#1");
    expect(await w.readiness(b.ref)).toEqual({ status: "conflict", with: ["site#1"] });
    await w.ok(await w.call.pat("work.claim", { id: c.ref }));
    await w.ok(await w.call.sam("work.claim", { id: d.ref }));
    await w.ok(await w.call.pat("work.release", { id: a.ref }));
    await w.ok(await w.call.sam("work.claim", { id: b.ref }));
  });

  it("lists the frontier best first and points out work stuck behind dropped items", async () => {
    const w = await world();
    const low = await w.file("Low", { priority: 3 });
    const base = await w.file("Base", { estimate: 4 });
    await w.file("Top", { estimate: 2, after: [base.ref] });
    const gone = await w.file("Abandoned idea");
    await w.file("Needs the idea", { after: gone.ref });
    await w.ok(await w.call.pat("work.update", { id: gone.ref, state: "dropped" }));
    const f = await w.ok<{ ready: Array<{ ref: string; critical: number; downstream: number }>; counts: Record<string, number>; stuck: Array<{ ref: string }> }>(await w.call.pat("work.frontier", {}));
    expect(f.ready.map((x) => x.ref)).toEqual([base.ref, low.ref]);
    expect(f.ready[0]).toMatchObject({ critical: 6, downstream: 1 });
    expect(f.counts).toEqual({ ready: 2, blocked: 2, claimed: 0, conflict: 0 });
    expect(f.stuck.map((x) => x.ref)).toEqual(["site#5"]);
    const order = await w.ok<{ items: Array<{ ref: string }> }>(await w.call.pat("work.graph", { project: "site" }));
    expect(order.items.map((x) => x.ref).indexOf(base.ref)).toBeLessThan(order.items.map((x) => x.ref).indexOf("site#3"));
  });

  it("deletes an item with its edges, comments and links, frees what waited on it, and keeps an audit record", async () => {
    const w = await world();
    const [a, b] = [await w.file("Noise"), await w.file("Real work")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    await w.ok(await w.call.pat("work.comment", { id: a.ref, body: "hm" }));
    await w.ok(await w.call.pat("work.link", { id: a.ref, target_kind: "url", target_ref: "https://example.com/x" }));
    expect((await w.call.pat("work.delete", { id: a.ref, confirm: "site#2" })).status).toBe(400);
    const done = await w.ok<{ ref: string; released: string[] }>(await w.call.pat("work.delete", { id: a.ref, confirm: a.ref }));
    expect(done.released).toEqual([b.ref]);
    expect(await getWork(env.HUB_DB, w.t.id, a.item.id)).toBeNull();
    expect(await w.deps()).toEqual([]);
    expect(await w.readiness(b.ref)).toEqual({ status: "ready" });
    const left = await env.HUB_DB.prepare("SELECT (SELECT COUNT(*) FROM work_comment) AS comments, (SELECT COUNT(*) FROM work_link) AS links").first<{ comments: number; links: number }>();
    expect(left).toEqual({ comments: 0, links: 0 });
    const event = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'work.delete' AND target_id = ?").bind(a.item.id).first<{ summary: string }>();
    expect(event?.summary).toBe("Deleted site#1: Noise");
    expect((await w.call.pat("work.read", { id: a.ref })).status).toBe(404);
  });

  it("records every graph change in the activity log", async () => {
    const w = await world();
    const [a, b] = [await w.file("A"), await w.file("B")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    await w.ok(await w.call.pat("work.depend", { id: b.ref, remove: a.ref }));
    await w.ok(await w.call.pat("work.resources", { id: b.ref, resources: "x" }));
    await w.ok(await w.call.pat("work.claim", { id: b.ref }));
    await w.ok(await w.call.pat("work.release", { id: b.ref }));
    const kinds = (await env.HUB_DB.prepare("SELECT kind FROM event WHERE target_id = ? ORDER BY id").bind(b.item.id).all<{ kind: string }>()).results.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["work.depend", "work.undepend", "work.resources", "work.claim", "work.release"]));
  });
});
