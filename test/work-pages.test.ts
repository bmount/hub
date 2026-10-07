// Deep UI round 2 (overnight plan 2, N5): work items edited in place, and Docket filters for owner, quest and "mine".
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
type Item = { id: string; number: number; kind: string; state: string; title: string; body: string; owner_id: string | null; parent_id: string | null };

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const rae = await seedHuman("rae@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
  const create = async (body: Record<string, unknown>) => {
    const r = await apiPost(HOST, "work.create", { project: "site", ...body }, cookieHeaders(pat.token, HOST));
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { result: { item: Item } }).result.item;
  };
  const get = (path: string, token = pat.token) => SELF.fetch(`https://${HOST}${path}`, { headers: cookieHeaders(token, HOST) });
  const read = async (id: string) => ((await (await apiPost(HOST, "work.read", { id }, cookieHeaders(pat.token, HOST))).json()) as { result: { item: Item } }).result.item;
  const form = (verb: string, fields: Record<string, string>) => SELF.fetch(`https://${HOST}/api/${verb}`, {
    method: "POST", redirect: "manual",
    headers: { cookie: `pmw_session=${pat.token}`, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { t, pat, sam, rae, create, get, read, form };
}

describe("work item editing", () => {
  it("edits title, kind, owner, quest and details from the page's form, and can clear each", async () => {
    const w = await world();
    const quest = await w.create({ kind: "quest", title: "Launch" });
    const item = await w.create({ kind: "snag", title: "Old title", body: "Old details", owner: "sam@example.com", parent: quest.number });
    const html = await (await w.get(`/site/w/${item.number}`)).text();
    expect(html).toContain('<details class="edit">');
    expect(html).toContain('<option value="sam@example.com" selected>');
    expect(html).toContain(`<option value="${quest.number}" selected>`);
    expect(html).toContain(">Old details</textarea>");

    const res = await w.form("work.update", { id: item.id, _back: `/site/w/${item.number}`, title: "New title", kind: "wish", owner: "pat@example.com", parent: String(quest.number), body: "New details" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/site/w/${item.number}`);
    let now = await w.read(item.id);
    expect([now.title, now.kind, now.owner_id, now.parent_id, now.body]).toEqual(["New title", "wish", w.pat.identity.id, quest.id, "New details"]);

    await w.form("work.update", { id: item.id, _back: `/site/w/${item.number}`, title: "New title", kind: "wish", owner: "none", parent: "0", body: "" });
    now = await w.read(item.id);
    expect([now.owner_id, now.parent_id, now.body]).toEqual([null, null, ""]);
  });

  it("leaves the details alone when an update does not mention them", async () => {
    const w = await world();
    const item = await w.create({ kind: "errand", title: "Keep", body: "Keep these details" });
    await apiPost(HOST, "work.update", { id: item.id, title: "Kept" }, cookieHeaders(w.pat.token, HOST));
    expect((await w.read(item.id)).body).toBe("Keep these details");
  });

  it("keeps a finished quest as the selected choice, so saving the form does not drop it", async () => {
    const w = await world();
    const quest = await w.create({ kind: "quest", title: "Old launch" });
    const item = await w.create({ kind: "errand", title: "Child", parent: quest.number });
    await apiPost(HOST, "work.update", { id: quest.id, state: "done" }, cookieHeaders(w.pat.token, HOST));
    const html = await (await w.get(`/site/w/${item.number}`)).text();
    expect(html).toContain(`<option value="${quest.number}" selected>#${quest.number} Old launch</option>`);
  });

  it("shows readers the item without an edit form", async () => {
    const w = await world();
    const item = await w.create({ kind: "spark", title: "Idea" });
    const html = await (await w.get(`/site/w/${item.number}`, w.rae.token)).text();
    expect(html).toContain("Idea");
    expect(html).not.toContain('<details class="edit">');
  });
});

describe("Docket filters", () => {
  it("filters by mine, owner and quest, keeps other filters on every chip, and names what emptied the list", async () => {
    const w = await world();
    const quest = await w.create({ kind: "quest", title: "Launch" });
    await w.create({ kind: "snag", title: "Pat snag", owner: "me", parent: quest.number });
    await w.create({ kind: "wish", title: "Sam wish", owner: "sam@example.com" });
    await w.create({ kind: "errand", title: "Nobody errand" });
    const titles = async (path: string) => [...(await (await w.get(path)).text()).matchAll(/class="k-\w+"><span class="kd"><\/span>[^<]*<\/td><td><a href="[^"]+">([^<]*)<\/a>/g)].map((m) => m[1]).sort();

    expect(await titles("/site/docket?owner=me")).toEqual(["Pat snag"]);
    expect(await titles("/docket?owner=sam%40example.com")).toEqual(["Sam wish"]);
    expect(await titles(`/site/docket?quest=${quest.number}`)).toEqual(["Pat snag"]);
    expect(await titles("/site/docket?owner=me&kind=wish")).toEqual([]);

    const mine = await (await w.get("/site/docket?owner=me")).text();
    expect(mine).toContain('href="/site/docket?kind=snag&amp;owner=me"');
    expect(mine).toContain('<a class="chip" href="/site/docket?owner=me" aria-current="true">Mine</a>');
    expect(await (await w.get("/site/docket?owner=me&kind=wish")).text()).toContain("Nothing matches these filters.");
    expect(await (await w.get("/docket?owner=me", w.rae.token)).text()).toContain("Nothing is yours right now.");
  });

  it("escapes an owner it does not know instead of echoing it", async () => {
    const w = await world();
    const html = await (await w.get(`/docket?owner=${encodeURIComponent('"><script>x</script>')}`)).text();
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
