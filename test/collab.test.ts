// Comments, following and What needs me (migration 0010).
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { deleteTenant } from "../src/db/tenantDelete";
import { ensureHandles } from "../src/chat/handles";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const rae = await seedHuman("rae@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  await ensureHandles(env.HUB_DB, t.id);
  const as = (h: { token: string }) => async (verb: string, body: unknown) => {
    const r = await apiPost(HOST, verb, body, cookieHeaders(h.token, HOST));
    const j = (await r.json()) as { ok: boolean; result: Record<string, unknown>; error?: string };
    return { status: r.status, ...j };
  };
  const needs = async (h: { token: string }) => ((await as(h)("attention.list", {})).result.entries as Array<{ reason: string; summary: string; number: number }>);
  return { t, pat, sam, rae, as, needs };
}

describe("comments, following, and what needs me", () => {
  it("tells the mentioned person and the followers about a comment, never the author", async () => {
    const w = await world();
    await w.as(w.pat)("work.create", { project: "site", kind: "snag", title: "Checkout fails" });
    const handle = (await env.HUB_DB.prepare("SELECT m.handle FROM membership m JOIN identity i ON i.id = m.identity_id WHERE i.email = 'rae@example.com'").first<{ handle: string }>())!.handle;
    const c = await w.as(w.sam)("work.comment", { id: "site#1", body: `Seen it too. @${handle} can you look?` });
    expect(c.status).toBe(200);
    expect(c.result.mentioned).toEqual([handle]);
    expect((await w.needs(w.rae)).map((e) => e.reason)).toEqual(["mention"]);
    expect((await w.needs(w.pat)).map((e) => e.reason)).toEqual(["comment"]);
    expect(await w.needs(w.sam)).toEqual([]);
    const read = await w.as(w.pat)("work.read", { id: "site#1" });
    expect((read.result.comments as Array<{ body: string }>)[0]!.body).toContain("Seen it too");
    expect((await w.as(w.pat)("work.comment", { id: "site#1", body: "   " })).status).toBe(400);
    expect((await w.as(w.pat)("work.comment", { id: "site#1", body: "x", reply_to: "nope" })).status).toBe(400);
  });

  it("tells a new owner it is theirs, and followers when it changes", async () => {
    const w = await world();
    await w.as(w.pat)("work.create", { project: "site", kind: "errand", title: "Rotate keys" });
    await w.as(w.pat)("work.update", { id: "site#1", owner: "sam@example.com" });
    expect((await w.needs(w.sam)).map((e) => e.reason)).toEqual(["assigned"]);
    await w.as(w.sam)("work.update", { id: "site#1", state: "done" });
    expect((await w.needs(w.pat)).map((e) => e.reason)).toEqual(["changed"]);
    await w.as(w.pat)("work.create", { project: "site", kind: "wish", title: "For rae", owner: "rae@example.com" });
    expect((await w.needs(w.rae)).map((e) => e.reason)).toEqual(["filed"]);
  });

  it("follows and unfollows items and projects", async () => {
    const w = await world();
    await w.as(w.pat)("work.create", { project: "site", kind: "spark", title: "Idea" });
    expect((await w.as(w.rae)("work.subscribe", { project: "site" })).result).toMatchObject({ following: true, kind: "project" });
    await w.as(w.pat)("work.comment", { id: "site#1", body: "More thoughts" });
    expect((await w.needs(w.rae)).length).toBe(1);
    await w.as(w.rae)("work.subscribe", { project: "site", follow: false });
    await w.as(w.pat)("work.comment", { id: "site#1", body: "Even more" });
    expect((await w.needs(w.rae)).length).toBe(1);
  });

  it("marks entries done when the item is opened, or all at once", async () => {
    const w = await world();
    await w.as(w.pat)("work.create", { project: "site", kind: "snag", title: "One", owner: "sam@example.com" });
    await w.as(w.pat)("work.create", { project: "site", kind: "snag", title: "Two", owner: "sam@example.com" });
    expect((await w.needs(w.sam)).length).toBe(2);
    const page = await SELF.fetch(`https://${HOST}/attention`, { headers: cookieHeaders(w.sam.token, HOST) });
    expect(await page.text()).toContain("Mark all done");
    await SELF.fetch(`https://${HOST}/site/w/1`, { headers: cookieHeaders(w.sam.token, HOST) });
    expect((await w.needs(w.sam)).map((e) => e.number)).toEqual([2]);
    expect((await w.as(w.sam)("attention.done", { all: true })).result).toEqual({ done: 1 });
    expect(await w.needs(w.sam)).toEqual([]);
  });

  it("shows comments and the follow toggle on the item, and the count in the rail", async () => {
    const w = await world();
    await w.as(w.pat)("work.create", { project: "site", kind: "snag", title: "One", owner: "sam@example.com" });
    await w.as(w.pat)("work.comment", { id: "site#1", body: "Context here" });
    const docket = await (await SELF.fetch(`https://${HOST}/docket`, { headers: cookieHeaders(w.sam.token, HOST) })).text();
    expect(docket).toMatch(/>Needs me<\/a><span class="n">2<\/span>/);
    const item = await (await SELF.fetch(`https://${HOST}/site/w/1`, { headers: cookieHeaders(w.sam.token, HOST) })).text();
    expect(item).toContain("Context here");
    expect(item).toContain('action="/api/work.comment"');
    expect(item).toContain("Following ✓");
  });

  it("deletes an organization that has work, comments, follows and attention", async () => {
    const w = await world();
    await w.as(w.pat)("work.create", { project: "site", kind: "snag", title: "One", owner: "sam@example.com" });
    await w.as(w.pat)("work.comment", { id: "site#1", body: "A comment" });
    await w.as(w.pat)("work.link", { id: "site#1", target_kind: "url", target_ref: "https://example.com/x" });
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.t.id).run();
    const root = await seedHuman("root@example.com", { is_root: true });
    const r = await deleteTenant(env.HUB_DB, "acme", root.identity.id, Date.now());
    expect(r.counts).toMatchObject({ work_item: 1, work_comment: 1, work_link: 1 });
    expect(await env.HUB_DB.prepare("SELECT (SELECT COUNT(*) FROM work_item) + (SELECT COUNT(*) FROM attention) + (SELECT COUNT(*) FROM follow) AS n").first()).toEqual({ n: 0 });
  });
});
