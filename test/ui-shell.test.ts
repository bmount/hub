import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { TIPS } from "../src/http/shell";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const lead = await seedHuman("lead@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  await seedAgent(t, lead.identity, "scout");
  await apiPost(HOST, "work.create", { project: "site", kind: "bug", title: "Checkout fails" }, cookieHeaders(pat.token, HOST));
  await apiPost(HOST, "work.create", { project: "site", kind: "wish", title: "Dark mode" }, cookieHeaders(pat.token, HOST));
  const get = async (path: string, token = pat.token, host = HOST) => (await SELF.fetch(`https://${host}${path}`, { headers: cookieHeaders(token, host) }));
  return { t, lead, pat, get };
}
const hasTip = (html: string) => TIPS.some((t) => html.includes(t.replace(/'/g, "&#39;")));

describe("the signed-in shell", () => {
  it("frames every organization page with the same navigation, the current section marked, and a reminder", async () => {
    const w = await world();
    for (const [path, label] of [["/", "Home"], ["/docket", "Docket"], ["/mail", "Mail"], ["/c", "Chat"], ["/people", "People and agents"]] as const) {
      const res = await w.get(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain('<nav class="wb-tree" aria-label="Primary">');
      expect(html.slice(html.indexOf('<aside id="rail"'), html.indexOf('<aside id="explorer"')), path).toMatch(new RegExp(`aria-current="page">${label}(?:<span class="wb-count">\\d+</span>)?</a>`));
      expect(html, path).toContain('class="wb-breadcrumb" aria-label="Breadcrumb"');
      expect(html, path).toContain('aria-label="Project explorer"');
      expect(hasTip(html), path).toBe(true);
    }
  });

  it("reports server time on every page", async () => {
    const w = await world();
    for (const path of ["/", "/docket", "/site"]) expect((await w.get(path)).headers.get("server-timing"), path).toMatch(/^app;dur=\d+, db;desc="\d+ round trips, \d+ statements";dur=\d+$/);
  });

  it("shows Admin only to admins", async () => {
    const w = await world();
    expect(await (await w.get("/")).text()).not.toContain('href="/admin/agents">Admin');
    expect(await (await w.get("/", w.lead.token)).text()).toContain('href="/admin/agents">Admin');
  });

  it("gives the organization a compact home: projects, open work, needs and latest activity", async () => {
    const w = await world();
    const html = await (await w.get("/")).text();
    expect(html).toContain('href="/site"');
    expect(html).toContain('href="/?project=site"');
    expect(html).toContain('aria-label="Projects"');
    expect(html).toContain("Open work");
    expect(html).toContain("Last activity");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("Nothing needs you right now.");
  });

  it("gives each project compact resource counts and selected work", async () => {
    const w = await world();
    const html = await (await w.get("/site")).text();
    expect(html).toContain("acme.site@pimwell.test");
    expect(html).toContain("git clone https://acme.pimwell.test/site.git");
    expect(html).toContain('href="/site?resource=snag"');
    expect(html).toContain("Open Snags");
    expect(html).toContain("Open Wishes");
    const selected = await (await w.get("/site?resource=snag")).text();
    expect(selected).toContain("Checkout fails");
    expect(selected).toContain('href="/site/w/1"');
    expect((await w.get("/nosuch")).status).toBe(404);
  });

  it("lists the whole organization's Docket and its people and agents", async () => {
    const w = await world();
    const docket = await (await w.get("/docket")).text();
    expect(docket).toContain("site#1");
    expect(docket).toContain("site#2");
    const people = await (await w.get("/people")).text();
    expect(people).toContain("lead@example.com");
    expect(people).toContain("acme.scout@pimwell.test");
  });

  it("keeps public pages plain, and the apex home lists your organizations", async () => {
    const w = await world();
    const login = await (await SELF.fetch("https://pimwell.test/login")).text();
    expect(login).toContain('class="plain"');
    expect(login).not.toContain('aria-label="Primary"');
    const apex = await (await w.get("/", w.pat.token, "pimwell.test")).text();
    expect(apex).toContain("Your organizations");
    expect(apex).toContain("https://acme.pimwell.test/");
  });
});
