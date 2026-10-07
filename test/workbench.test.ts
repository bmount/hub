// The workbench (2026-10-07): persistent rail with live counts, list and inspector panes that keep their place,
// + File, the jump box, and the planned areas in plain view.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const h = cookieHeaders(pat.token, HOST);
  for (const [kind, title, owner] of [["snag", "Checkout fails", "me"], ["wish", "Dark mode", ""], ["quest", "Launch", ""]] as const) {
    await apiPost(HOST, "work.create", { project: "site", kind, title, ...(owner ? { owner } : {}) }, h);
  }
  const get = async (path: string, headers: Record<string, string> = {}) => SELF.fetch(`https://${HOST}${path}`, { headers: { ...h, ...headers } });
  return { t, pat, h, get };
}
const attr = (html: string, id: string) => /data-key="([^"]*)"/.exec(html.slice(html.indexOf(`id="${id}"`)))?.[1];

describe("the workbench", () => {
  it("shows the rail with live counts on every page, read in the sign-in batch", async () => {
    const w = await world();
    const res = await w.get("/docket");
    const html = await res.text();
    expect(html).toContain('<body class="wb"');
    expect(html).toMatch(/aria-current="page">Docket<\/a><span class="n">3<\/span>/);
    expect(html).toMatch(/>Mine<\/a><span class="n">1<\/span>/);
    expect(html).toMatch(/href="\/site\/docket">Site<\/a><span class="n">3<\/span>/);
    expect(html).toContain('<span class="pill">planned</span>');
    expect(html).toContain('<nav class="tabs" aria-label="Sections">');
    expect(res.headers.get("server-timing")).toMatch(/db;desc="2 round trips/);
  });

  it("opens an item beside the same list, keeping the list's filters and key", async () => {
    const w = await world();
    const list = await (await w.get("/site/docket?kind=snag")).text();
    expect(list).toContain('data-href="/site/w/1?kind=snag"');
    const item = await (await w.get("/site/w/1?kind=snag")).text();
    expect(attr(item, "list")).toBe(attr(list, "list"));
    expect(attr(item, "inspector")).toMatch(/^w:/);
    expect(item).toContain('data-focus="inspector"');
    expect(item).toContain("<h1>Checkout fails</h1>");
    expect(item).toContain('<a class="back" href="/site/docket?kind=snag">');
    expect(item).toContain('name="_back" value="/site/w/1?kind=snag"');
    expect(item).toContain("Comments</b> <span class=\"pill\">planned</span>");
    const org = await (await w.get("/docket?owner=me")).text();
    expect(org).toContain('data-href="/site/w/1?in=org&amp;owner=me"');
    const orgItem = await (await w.get("/site/w/1?in=org&owner=me")).text();
    expect(attr(orgItem, "list")).toBe(attr(org, "list"));
  });

  it("files new work from + File and lands on it", async () => {
    const w = await world();
    const page = await (await w.get("/new?project=site&kind=errand&title=Build%20it")).text();
    expect(page).toContain('value="@result"');
    expect(page).toContain('<option value="errand" selected>');
    const res = await SELF.fetch(`https://${HOST}/api/work.create`, {
      method: "POST", redirect: "manual",
      headers: { cookie: `pmw_session=${w.pat.token}`, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: "site", kind: "errand", title: "Build it", _back: "@result" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/site/w/4");
  });

  it("jumps to refs, projects, titles and people", async () => {
    const w = await world();
    const j = async (q: string) => ((await (await w.get(`/jump?q=${encodeURIComponent(q)}`, { accept: "application/json" })).json()) as { results: Array<{ label: string; href: string }> }).results;
    expect((await j("site#2"))[0]).toMatchObject({ href: "/site/w/2", label: "site#2 Dark mode" });
    expect((await j("sit")).map((r) => r.href)).toContain("/site/docket");
    expect((await j("checkout")).map((r) => r.href)).toContain("/site/w/1");
    expect((await j("pat@")).map((r) => r.href)).toContain("/docket?owner=pat%40example.com");
    expect(await j("100%_")).toEqual([]);
    expect(await (await w.get("/jump?q=dark")).text()).toContain("Dark mode");
  });

  it("lists what is coming, with each planned verb's spec", async () => {
    const w = await world();
    const all = await (await w.get("/planned")).text();
    expect(all).toContain("<code>review.request</code>");
    const one = await (await w.get("/planned/review?v=review.request")).text();
    expect(one).toContain("<code>review_request</code>");
    expect(one).toContain("POST /api/review.request");
    expect(one).toContain("501 not_implemented");
    expect((await w.get("/planned/nosuch")).status).toBe(404);
  });

  it("links one cached stylesheet and script, offers Log out, and signs out to a page that needs no session", async () => {
    const w = await world();
    const html = await (await w.get("/docket")).text();
    const css = /href="(\/assets\/app\.[a-z0-9]+\.css)"/.exec(html)![1]!;
    const js = /src="(\/assets\/wb\.[a-z0-9]+\.js)"/.exec(html)![1]!;
    for (const path of [css, js]) {
      const res = await SELF.fetch(`https://${HOST}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control")).toContain("immutable");
    }
    expect(await (await SELF.fetch(`https://${HOST}${css}`)).text()).toContain("--accent:");
    expect((await SELF.fetch(`https://${HOST}/assets/app.old.css`)).status).toBe(404);
    expect(html).not.toContain("<style>");
    expect(html).toContain('<h4>Your account</h4>');
    expect(html).toContain('action="/api/session.end" data-reload><input type="hidden" name="_back" value="/signed-out">');
    const out = await SELF.fetch(`https://${HOST}/api/session.end`, { method: "POST", redirect: "manual", headers: { ...w.h, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" }, body: "_back=%2Fsigned-out" });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/signed-out");
    expect(await (await SELF.fetch(`https://${HOST}/signed-out`)).text()).toContain("re signed out");
  });
});
