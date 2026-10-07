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
    for (const [path, label] of [["/", "Home"], ["/docket", "Docket"], ["/mail", "Mail"], ["/c", "Conversations"], ["/people", "People and agents"]] as const) {
      const res = await w.get(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain('<nav aria-label="Primary">');
      expect(html, path).toContain(`aria-current="page">${label}</a>`);
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

  it("gives the organization a deep home: projects, open work by kind, what happened lately", async () => {
    const w = await world();
    const html = await (await w.get("/")).text();
    expect(html).toContain('href="/site"');
    expect(html).toContain("Snags 1");
    expect(html).toContain("Wishes 1");
    expect(html).toContain("Filed site#1");
    expect(html).toContain("acme@pimwell.test");
  });

  it("gives each project a page: open work and one timeline of what happened", async () => {
    const w = await world();
    const html = await (await w.get("/site")).text();
    expect(html).toContain("acme.site@pimwell.test");
    expect(html).toContain("git clone https://acme.pimwell.test/site.git");
    expect(html).toContain("Checkout fails");
    expect(html).toContain("Filed site#2");
    expect((await w.get("/nosuch")).status).toBe(404);
  });

  it("lists the whole organization's Docket and its people and agents", async () => {
    const w = await world();
    const docket = await (await w.get("/docket")).text();
    expect(docket).toContain("site#1");
    expect(docket).toContain("site#2");
    const people = await (await w.get("/people")).text();
    expect(people).toContain("lead@example.com");
    expect(people).toContain("scout@acme.pimwell.test");
  });

  it("keeps public pages plain, and the apex home lists your organizations", async () => {
    const w = await world();
    const login = await (await SELF.fetch("https://pimwell.test/login")).text();
    expect(login).toContain('class="plain"');
    expect(login).not.toContain('<nav aria-label="Primary">');
    const apex = await (await w.get("/", w.pat.token, "pimwell.test")).text();
    expect(apex).toContain("Your organizations");
    expect(apex).toContain("https://acme.pimwell.test/");
  });
});
