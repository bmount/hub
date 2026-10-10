import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext, oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { recordEvent } from "../src/db/events";
import { createProject } from "../src/db/projects";
import { createWork, getWork, updateWork } from "../src/db/work";
import { board, CLOSURE_ACTOR_LIMIT, workBoard } from "../src/verbs/board";
import { callTool } from "../src/mcp/tools";
import { registerAllVerbs } from "../src/verbs/index";
import { apiPost, bearer, cookieHeaders, seedAgent, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
async function world() {
  const t = await seedTenant("acme"), now = Date.now();
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Site" }, now);
  const h = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
  const a = await seedAgent(t, h.identity);
  const headers = cookieHeaders(h.token, HOST);
  const ctx = await buildContext(new Request(`https://${HOST}/`, { headers }), env, now);
  const make = (title = "Bug", state: "open" | "done" = "open") => createWork(env.HUB_DB, { tenant_id: t.id, project_id: p.id, kind: "snag", title, body: "", state, created_by: h.identity.id, owner_id: a.agent.identity.id }, now);
  return { t, p, h, reader, a, now, headers, ctx, make };
}
const events = async (id: string) => (await env.HUB_DB.prepare("SELECT * FROM event WHERE kind = 'work.done' AND target_id = ?").bind(id).all()).results;

// These are synthetic isolated Workers fixtures, never real identities/memberships.
describe("recorded work closure attribution", () => {
  it("credits the authenticated closer, not owner; deduplicates no-ops/reclosures and discloses historical gaps on all surfaces", async () => {
    const w = await world(), item = await w.make();
    expect((await apiPost(HOST, "work.update", { id: item.id, state: "done" }, w.headers)).status).toBe(200);
    expect(await events(item.id)).toMatchObject([{ identity_id: w.h.identity.id, session_id: w.h.session.id }]);
    await apiPost(HOST, "work.update", { id: item.id, state: "done", title: "Details" }, w.headers);
    expect(await events(item.id)).toHaveLength(1);
    for (const state of ["open", "done", "open"]) await apiPost(HOST, "work.update", { id: item.id, state }, w.headers);
    expect(await events(item.id)).toHaveLength(2);
    const created = await apiPost(HOST, "work.create", { project: "site", kind: "snag", title: "Agent done", state: "done", owner: "none" }, bearer(w.a.token));
    expect(created.status).toBe(200);
    const made = (await created.json() as { result: { item: { id: string } } }).result.item;
    expect(await events(made.id)).toMatchObject([{ identity_id: w.a.agent.identity.id, session_id: w.a.session.id }]);
    await w.make("Legacy", "done");
    const b = await board(w.ctx, "site");
    expect(b.closures).toMatchObject({ total_actors: 2, truncated: false, currently_done_without_record: 1 });
    expect(b.closures.actors).toEqual(expect.arrayContaining([
      { identity_id: w.h.identity.id, name: "pat", kind: "human", items: 1 },
      { identity_id: w.a.agent.identity.id, name: "bot", kind: "agent", items: 1 },
    ]));
    const text = workBoard.mcp!.render!(b);
    expect(text).toContain("including reopened items"); expect(text).toContain("Historical prose events are not attributed");
    expect(text).toContain("Currently done without a structured closure record: 1");
    const rh = cookieHeaders(w.reader.token, HOST);
    const api = await apiPost(HOST, "work.board", { project: "site" }, rh);
    expect(api.status).toBe(200);
    expect((await api.json() as { result: typeof b }).result.closures).toEqual(b.closures);
    const html = await (await SELF.fetch(`https://${HOST}/site/board`, { headers: rh })).text();
    expect(html).toContain("Recorded closures by actor"); expect(html).toContain("<th>Items</th>");
    expect(html).toContain("structured closure record: 1"); expect(html).toContain(w.a.agent.identity.id);
    expect((await apiPost(HOST, "work.update", { id: item.id, state: "done" }, rh)).status).toBe(403);
    expect((await SELF.fetch(`https://${HOST}/site/board`)).status).toBe(404);
  });

  it("atomically elects one same-snapshot closer; stale losers cannot steal the winner's credit", async () => {
    const w = await world(), item = await w.make();
    const actors = [w.h.identity.id, w.a.agent.identity.id].map(identity_id => ({ identity_id, session_id: null }));
    const outcomes = await Promise.allSettled(actors.map(actor => updateWork(env.HUB_DB, item, { state: "done" }, w.now, actor)));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const winner = outcomes.findIndex(r => r.status === "fulfilled");
    expect(await events(item.id)).toMatchObject([{ identity_id: actors[winner]!.identity_id }]);
    expect(await events(item.id)).toHaveLength(1);
    await expect(updateWork(env.HUB_DB, item, { state: "done" }, w.now, actors[1 - winner])).rejects.toMatchObject({ status: 409 });
    expect(await events(item.id)).toHaveLength(1);
  });

  it("rolls back the done write/create when closure evidence cannot persist", async () => {
    const w = await world(), item = await w.make();
    await env.HUB_DB.exec("CREATE TRIGGER reject_done BEFORE INSERT ON event WHEN NEW.kind = 'work.done' BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    const actor = { identity_id: w.h.identity.id, session_id: null };
    try {
      await expect(updateWork(env.HUB_DB, item, { state: "done" }, w.now + 1, actor)).rejects.toThrow();
      expect(await getWork(env.HUB_DB, w.t.id, item.id)).toEqual(item);
      await expect(createWork(env.HUB_DB, { tenant_id: w.t.id, project_id: w.p.id, kind: "snag", title: "No phantom", body: "", state: "done", created_by: w.h.identity.id }, w.now + 2, actor)).rejects.toThrow();
      expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_item").first("n")).toBe(1);
      expect(await events(item.id)).toEqual([]);
    } finally { await env.HUB_DB.exec("DROP TRIGGER reject_done;"); }
  });

  it("allows multiple genuine closers but never counts dropping, claiming, details or legacy prose as closure evidence", async () => {
    const w = await world(), item = await w.make();
    for (const state of ["dropped", "open", "done", "open", "done"] as const) {
      const actor = { identity_id: state === "done" && (await events(item.id)).length ? w.a.agent.identity.id : w.h.identity.id, session_id: null };
      await updateWork(env.HUB_DB, (await getWork(env.HUB_DB, w.t.id, item.id))!, { state }, w.now, actor);
    }
    expect(await events(item.id)).toHaveLength(2);
    const legacy = await w.make("Forged-looking prose", "done");
    await recordEvent(env.HUB_DB, { tenant_id: w.t.id, identity_id: w.a.agent.identity.id, session_id: null, kind: "work.update", target_kind: "work_item", target_id: legacy.id, summary: "Updated site#2 (Open to Done): work.done" }, w.now);
    const b = await board(w.ctx, null);
    expect(b.closures.actors.map(a => a.items)).toEqual([1, 1]);
    expect(b.closures.currently_done_without_record).toBe(1);
    expect(b.closures.note).toContain("one item can appear under multiple actors");
  });

  it("isolates tenants, projects, channel work and inconsistent event/item/project joins; safely renders actor names", async () => {
    const w = await world(), other = await seedTenant("other");
    const p2 = await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "site", kind: "repo", display_name: "SECRET" }, w.now);
    const p3 = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "second", kind: "repo", display_name: "Second" }, w.now);
    await env.HUB_DB.prepare("INSERT INTO project (id, tenant_id, slug, kind, display_name, state, created_at) VALUES ('channel', ?, 'general', 'channel', 'General', 'active', ?)").bind(w.t.id, w.now).run();
    const actor = { identity_id: w.h.identity.id, session_id: null };
    const mine = await w.make(); await updateWork(env.HUB_DB, mine, { state: "done" }, w.now, actor);
    for (const [tenant, project] of [[other.id, p2.id], [w.t.id, p2.id], [other.id, w.p.id], [w.t.id, "channel"], [w.t.id, p3.id]]) {
      await createWork(env.HUB_DB, { tenant_id: tenant!, project_id: project!, kind: "snag", title: "SECRET", body: "", state: "done", created_by: w.a.agent.identity.id }, w.now, { identity_id: w.a.agent.identity.id, session_id: null });
    }
    // Same target, wrong tenant: must not disclose that actor or inflate this scope.
    await recordEvent(env.HUB_DB, { tenant_id: other.id, identity_id: w.a.agent.identity.id, session_id: null, kind: "work.done", target_kind: "work_item", target_id: mine.id, summary: "", }, w.now);
    expect((await board(w.ctx, "site")).closures.actors).toEqual([{ identity_id: w.h.identity.id, name: "pat", kind: "human", items: 1 }]);
    expect((await board(w.ctx, "second")).closures.actors).toMatchObject([{ identity_id: w.a.agent.identity.id, items: 1 }]);
    expect((await board(w.ctx, "general")).closures.total_actors).toBe(0);
    expect((await board(w.ctx, null)).closures.total_actors).toBe(2);
    await env.HUB_DB.prepare("UPDATE identity SET display_name = '<img src=x onerror=alert(1)>' WHERE id = ?").bind(w.h.identity.id).run();
    const html = await (await SELF.fetch(`https://${HOST}/site/board`, { headers: w.headers })).text();
    expect(html).not.toContain("<img src=x"); expect(html).toContain("&lt;img");
    const outsider = await seedHuman("outsider@example.com");
    expect((await apiPost(HOST, "work.board", {}, cookieHeaders(outsider.token, HOST))).status).not.toBe(200);
  });

  it("filters only closure counts on API/browser, keeps scope gaps, and reveals no foreign actor directory data", async () => {
    const w = await world(), item = await w.make();
    await updateWork(env.HUB_DB, item, { state: "done" }, w.now, { identity_id: w.a.agent.identity.id, session_id: null });
    await w.make("Legacy", "done");
    const rh = cookieHeaders(w.reader.token, HOST);
    const api = await apiPost(HOST, "work.board", { project: "site", actor: w.a.agent.identity.id }, rh);
    expect(api.status).toBe(200);
    const result = (await api.json() as { result: Awaited<ReturnType<typeof board>> }).result;
    expect(result.closures).toMatchObject({ actor_id: w.a.agent.identity.id, total_actors: 1, currently_done_without_record: 1, actors: [{ identity_id: w.a.agent.identity.id, kind: "agent", items: 1 }] });
    const { grant } = await seedGrant(w.t, w.reader);
    const live = (await liveGrant(env.HUB_DB, grant.id, Date.now()))!;
    const oauth = oauthContext(env, live, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    registerAllVerbs();
    const mcp = await callTool(oauth, "work_board", { project: "site", actor: w.a.agent.identity.id });
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
    expect(mcp.structuredContent).toMatchObject({ closures: result.closures });
    const html = await (await SELF.fetch(`https://${HOST}/site/board?actor=${w.a.agent.identity.id}`, { headers: rh })).text();
    expect(html).toContain(`value="${w.a.agent.identity.id}"`);
    expect(html).toContain('href="/site/board">Clear filter');
    expect(html).toContain("whole selected scope, independent of actor filter");
    const foreign = await seedHuman("SECRET-DIRECTORY@example.com");
    const other = await seedTenant("other");
    const project = await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Other" }, w.now);
    await createWork(env.HUB_DB, { tenant_id: other.id, project_id: project.id, kind: "snag", title: "Secret", body: "", state: "done", created_by: foreign.identity.id }, w.now, { identity_id: foreign.identity.id, session_id: null });
    const empty = await board(w.ctx, "site", foreign.identity.id);
    expect(empty.closures).toMatchObject({ actors: [], total_actors: 0, currently_done_without_record: 1 });
    expect(workBoard.mcp!.render!(empty)).not.toContain("SECRET-DIRECTORY");
    const payload = '<img src=x onerror="x">';
    const safe = await (await SELF.fetch(`https://${HOST}/board?actor=${encodeURIComponent(payload)}`, { headers: rh })).text();
    expect(safe).not.toContain(payload); expect(safe).toContain("&lt;img");
    for (const actor of ["x".repeat(27), 42]) {
      expect((await apiPost(HOST, "work.board", { actor }, rh)).status).toBe(400);
    }
    expect((await SELF.fetch(`https://${HOST}/board?actor=${"x".repeat(27)}`, { headers: rh })).status).toBe(400);
    expect((await SELF.fetch(`https://${HOST}/board?actor=${foreign.identity.id}`)).status).toBe(404);
    expect(workBoard.parse({ actor: "" }).actor).toBeNull();
  });

  it("reports bounded actors with exact actor total independent of item sampling and stable tie order", async () => {
    const w = await world(), item = await w.make();
    const ids: string[] = [];
    for (let n = 0; n < CLOSURE_ACTOR_LIMIT + 2; n++) {
      const h = await seedHuman(`actor${n}@example.com`);
      ids.push(h.identity.id);
      await recordEvent(env.HUB_DB, { tenant_id: w.t.id, identity_id: h.identity.id, session_id: null, kind: "work.done", target_kind: "work_item", target_id: item.id, summary: "" }, w.now);
    }
    const b = await board(w.ctx, null);
    expect(b.closures).toMatchObject({ total_actors: 52, limit: 50, truncated: true, currently_done_without_record: 0 });
    expect(b.closures.actors).toHaveLength(50);
    expect(b.closures.actors.map(a => a.identity_id)).toEqual(b.closures.actors.map(a => a.identity_id).sort());
    expect(workBoard.mcp!.render!(b)).toContain("showing 50 of 52; truncated");
    const omitted = ids.find(id => !b.closures.actors.some(a => a.identity_id === id))!;
    const filtered = await board(w.ctx, null, omitted);
    expect(filtered.closures).toMatchObject({ actor_id: omitted, total_actors: 1, truncated: false, actors: [{ identity_id: omitted, items: 1 }] });
    expect(filtered.columns).toEqual(b.columns);
    expect(workBoard.mcp!.render!(filtered)).toContain(`Actor filter: ${omitted}`);
    expect((await board(w.ctx, "absent", omitted)).closures).toMatchObject({ actors: [], total_actors: 0, truncated: false });
  });
});
