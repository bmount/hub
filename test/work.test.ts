import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
type Item = { id: string; number: number; kind: string; state: string; title: string; owner_id: string | null; lease_until: number | null; closed_at: number | null };

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const rae = await seedHuman("rae@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
  const as = (h: { token: string }) => (verb: string, body: unknown) => apiPost(HOST, verb, body, cookieHeaders(h.token, HOST));
  return { t, pat: as(pat), sam: as(sam), rae: as(rae), patToken: pat.token, patId: pat.identity.id, samId: sam.identity.id };
}
const result = async <T>(r: Response) => { expect(r.status, await r.clone().text()).toBe(200); return ((await r.json()) as { result: T }).result; };

describe("work items", () => {
  it("files with plain words or Pimwell names, numbered per project, and reads back by reference", async () => {
    const w = await world();
    const a = await result<{ item: Item; ref: string }>(await w.pat("work.create", { project: "site", kind: "bug", title: "Checkout fails" }));
    const b = await result<{ item: Item; ref: string }>(await w.pat("work.create", { project: "site", kind: "Wish", title: "Dark mode" }));
    expect([a.item.kind, a.ref, b.item.kind, b.ref]).toEqual(["snag", "site#1", "wish", "site#2"]);
    const r = await result<{ item: Item }>(await w.sam("work.read", { id: "site#1" }));
    expect(r.item.title).toBe("Checkout fails");
    expect((await w.pat("work.create", { project: "site", kind: "whatever", title: "x" })).status).toBe(400);
  });

  it("lists the Docket: open by default, filtered by kind, finished on request", async () => {
    const w = await world();
    await w.pat("work.create", { project: "site", kind: "snag", title: "one" });
    await w.pat("work.create", { project: "site", kind: "spark", title: "two" });
    const done = await result<{ item: Item }>(await w.pat("work.create", { project: "site", kind: "errand", title: "three" }));
    await w.pat("work.update", { id: done.item.id, state: "done" });
    expect((await result<{ items: Item[] }>(await w.rae("work.list", { project: "site" }))).items.map((i) => i.title).sort()).toEqual(["one", "two"]);
    expect((await result<{ items: Item[] }>(await w.rae("work.list", { kind: "idea" }))).items.map((i) => i.title)).toEqual(["two"]);
    expect((await result<{ items: Item[] }>(await w.rae("work.list", { state: "done" }))).items.map((i) => i.title)).toEqual(["three"]);
  });

  it("closes and reopens, recording when", async () => {
    const w = await world();
    const a = await result<{ item: Item }>(await w.pat("work.create", { project: "site", kind: "snag", title: "x" }));
    const closed = await result<{ item: Item }>(await w.pat("work.update", { id: "site#1", state: "done" }));
    expect(closed.item.closed_at).not.toBeNull();
    const reopened = await result<{ item: Item }>(await w.pat("work.update", { id: a.item.id, state: "open" }));
    expect(reopened.item.closed_at).toBeNull();
  });

  it("claims: one owner at a time while the claim is live; a lapsed claim can be taken over", async () => {
    const w = await world();
    const a = await result<{ item: Item }>(await w.pat("work.create", { project: "site", kind: "errand", title: "x" }));
    const mine = await result<{ item: Item }>(await w.pat("work.claim", { id: a.item.id }));
    expect([mine.item.state, mine.item.owner_id]).toEqual(["doing", w.patId]);
    expect((await w.sam("work.claim", { id: a.item.id })).status).toBe(409);
    await env.HUB_DB.prepare("UPDATE work_item SET lease_until = ? WHERE id = ?").bind(Date.now() - 1000, a.item.id).run();
    const theirs = await result<{ item: Item }>(await w.sam("work.claim", { id: a.item.id }));
    expect(theirs.item.owner_id).toBe(w.samId);
  });

  it("builds quests from their parts and links work to the record", async () => {
    const w = await world();
    await w.pat("work.create", { project: "site", kind: "quest", title: "Launch" });
    await w.pat("work.create", { project: "site", kind: "errand", title: "Write copy", parent: 1 });
    await result(await w.pat("work.link", { id: "site#2", target_kind: "commit", target_ref: "site@abc1234", note: "first draft" }));
    const q = await result<{ children: Item[] }>(await w.rae("work.read", { project: "site", number: 1 }));
    expect(q.children.map((c) => c.title)).toEqual(["Write copy"]);
    const e = await result<{ links: Array<{ target_kind: string; target_ref: string }>; parent: string }>(await w.rae("work.read", { id: "site#2" }));
    expect(e.links).toMatchObject([{ target_kind: "commit", target_ref: "site@abc1234" }]);
    expect(e.parent).toBe("site#1");
  });

  it("records where an item came from and when, and can file a decision as already made", async () => {
    const w = await world();
    const c = await result<{ item: Item & { source_at: number; source_quote: string; source_kind: string } }>(await w.pat("work.create", {
      project: "site", kind: "decision", title: "Use dot-style addresses", state: "done", source_quote: "let's do the dot style", source_at: "2026-10-07T08:14:24Z",
    }));
    expect(c.item).toMatchObject({ kind: "call", state: "done", source_kind: "words", source_quote: "let's do the dot style", source_at: Date.parse("2026-10-07T08:14:24Z") });
    expect(c.item.closed_at).not.toBeNull();
    expect((await w.pat("work.create", { project: "site", kind: "spark", title: "x", source_at: "2999-01-01T00:00:00Z" })).status).toBe(400);
  });

  it("lets readers read but not file", async () => {
    const w = await world();
    expect((await w.rae("work.create", { project: "site", kind: "snag", title: "x" })).status).toBe(403);
  });

  it("records every change as an event and shows the Docket and the item pages", async () => {
    const w = await world();
    await w.pat("work.create", { project: "site", kind: "snag", title: "Checkout fails", body: "Steps: 1, 2, 3" });
    await w.pat("work.claim", { id: "site#1" });
    const kinds = (await env.HUB_DB.prepare("SELECT kind FROM event WHERE target_kind = 'work_item' ORDER BY created_at").all<{ kind: string }>()).results.map((r) => r.kind);
    expect(kinds).toEqual(["work.create", "work.claim"]);
    const h = cookieHeaders(w.patToken, HOST);
    const docket = await (await SELF.fetch(`https://${HOST}/site/docket`, { headers: h })).text();
    expect(docket).toContain("The Docket");
    expect(docket).toContain("Checkout fails");
    expect(docket).toContain("acme.site@pimwell.test");
    const item = await (await SELF.fetch(`https://${HOST}/site/w/1`, { headers: h })).text();
    expect(item).toContain("Snag (bug)");
    expect(item).toContain("Steps: 1, 2, 3");
    expect((await SELF.fetch(`https://${HOST}/site/w/99`, { headers: h })).status).toBe(404);
  });
});
