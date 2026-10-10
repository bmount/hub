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
  it("posts the rendered revision from every edit/state/claim form and refuses a stale page without overwriting", async () => {
    const w = await world();
    const item = await w.create({ kind: "snag", title: "Original", body: "Original details" });
    const html = await (await w.get(`/site/w/${item.number}`)).text();
    const forms = [...html.matchAll(/<form\b[^>]*action="\/api\/work\.(update|claim)"[^>]*>([\s\S]*?)<\/form>/g)];
    expect(forms.length).toBeGreaterThanOrEqual(4);
    const revisions = forms.map((form) => form[2]!.match(/name="expected_updated_at" value="(\d+)"/)?.[1]);
    expect(revisions.every((rev) => rev && rev === revisions[0])).toBe(true);
    const revision = revisions[0]!;
    expect((await w.form("work.update", { id: item.id, expected_updated_at: revision, title: "Concurrent winner" })).status).toBe(303);
    const staleEdits: Array<Record<string, string>> = [{ title: "Stale form", body: "Stale details" }, { state: "done" }];
    for (const fields of staleEdits) {
      const response = await w.form("work.update", { id: item.id, expected_updated_at: revision, ...fields });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("read it again");
    }
    expect((await w.form("work.claim", { id: item.id, expected_updated_at: revision })).status).toBe(409);
    expect(await w.read(item.id)).toMatchObject({ title: "Concurrent winner", body: "Original details", state: "open", owner_id: null });
    const refreshed = await (await w.get(`/site/w/${item.number}`)).text();
    expect(refreshed).not.toContain(`name="expected_updated_at" value="${revision}"`);
  });

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

describe("recorded work evidence navigation", () => {
  it("opens full commit IDs and numbered work references without looking up or claiming their targets", async () => {
    const w = await world();
    const source = await w.create({ kind: "errand", title: "Source work" });
    const target = await w.create({ kind: "snag", title: "Target work" });
    const oid = "ABCDEF0123456789".repeat(2) + "ABCDEF01";
    for (const [kind, ref] of [["commit", `site@${oid}`], ["item", `site#${target.number}`], ["item", "missing#99999999"]]) {
      const r = await apiPost(HOST, "work.link", { id: source.id, target_kind: kind, target_ref: ref, note: '<b>recorded & unverified</b>' }, cookieHeaders(w.pat.token, HOST));
      expect(r.status).toBe(200);
    }
    const html = await (await w.get(`/site/w/${source.number}`, w.rae.token)).text();
    expect(html).toContain(`<a href="/site/code?c=${oid.toLowerCase()}">site@${oid}</a>`);
    expect(html).toContain(`<a href="/site/w/${target.number}">site#${target.number}</a>`);
    expect(html).toContain('<a href="/missing/w/99999999">missing#99999999</a>');
    expect(html).toContain("Recorded references, not verified access or existence.");
    expect(html).toContain("&lt;b&gt;recorded &amp; unverified&lt;/b&gt;");
    expect(html.split("<h2>Links</h2>")[1]!.split("<h2>Activity</h2>")[0]!).not.toContain("Target work");
    expect(await (await w.get(`/site/w/${target.number}`, w.rae.token)).text()).toContain("Target work");
    expect((await w.get("/missing/w/99999999", w.rae.token)).status).toBe(404);
  });

  it("keeps short, malformed, unsupported and injection-shaped references inert", async () => {
    const w = await world();
    const item = await w.create({ kind: "errand", title: "Legacy references" });
    const oid = "a".repeat(40);
    const refs = [
      ["commit", "site@abcdef0"], ["commit", `site@${oid}0`], ["commit", `site@${oid}\n`],
      ["commit", `../site@${oid}`], ["commit", `//evil.test@${oid}`], ["commit", `site@${oid}?x=1`],
      ["commit", `${"s".repeat(64)}@${oid}`], ["commit", `-site@${oid}`], ["commit", `site-@${oid}`],
      ["item", "site#0"], ["item", "site#01"], ["item", "site#100000000"], ["item", "site#1\n"],
      ["item", "site#1?x=1"], ["item", "site#1/../../mail"], ["item", "site#1\" onclick=\"alert(1)"],
      ["item", "https://evil.test/site#1"], ["message", "site#1"], ["event", `site@${oid}`],
    ];
    for (const [i, [kind, ref]] of refs.entries()) {
      await env.HUB_DB.prepare("INSERT INTO work_link (id, item_id, target_kind, target_ref, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(`legacy-${i}`, item.id, kind, ref, w.pat.identity.id, Date.now()).run();
    }
    const html = await (await w.get(`/site/w/${item.number}`)).text();
    const links = html.split("<h2>Links</h2>")[1]!.split("<h2>Activity</h2>")[0]!;
    expect(links).not.toContain("<a ");
    expect(links.match(/<code>/g)).toHaveLength(refs.length);
    expect(links).toContain("&quot; onclick=&quot;alert(1)");
    expect(links).not.toContain(' onclick="');
  });

  it("keeps navigation on the current tenant and rechecks destination membership", async () => {
    const w = await world();
    const source = await w.create({ kind: "errand", title: "Tenant reference" });
    const foreign = await seedTenant("other");
    await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "hidden", kind: "repo", display_name: "Foreign repo" }, Date.now());
    const outsider = await seedHuman("outsider@example.com", { memberships: [{ tenant_id: foreign.id, role: "member" }] });
    const foreignItem = await apiPost("other.pimwell.test", "work.create", { project: "hidden", kind: "errand", title: "Private foreign title" }, cookieHeaders(outsider.token, "other.pimwell.test"));
    expect(foreignItem.status).toBe(200);
    for (const [kind, ref] of [["item", "hidden#1"], ["commit", `hidden@${"a".repeat(40)}`]]) {
      expect((await apiPost(HOST, "work.link", { id: source.id, target_kind: kind, target_ref: ref }, cookieHeaders(w.pat.token, HOST))).status).toBe(200);
    }
    const html = await (await w.get(`/site/w/${source.number}`)).text();
    expect(html).toContain('<a href="/hidden/w/1">hidden#1</a>');
    expect(html).not.toContain("Private foreign title");
    expect(html).not.toContain("Foreign repo");
    for (const path of ["/hidden/w/1", `/hidden/code?c=${"a".repeat(40)}`]) {
      expect((await w.get(path)).status).toBe(404);
      expect((await SELF.fetch(`https://other.pimwell.test${path}`, { headers: cookieHeaders(w.pat.token, "other.pimwell.test") })).status).toBe(404);
    }
    for (const path of [`/site/w/${source.number}`, "/site/w/1", `/site/code?c=${"a".repeat(40)}`]) {
      expect((await SELF.fetch(`https://${HOST}${path}`)).status).toBe(404);
      expect((await w.get(path, outsider.token)).status).toBe(404);
    }
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
