// Search across work, comments, mail, people, projects and app errors; every term must match.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { snippet, terms } from "../src/verbs/search";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

async function world() {
  const t = await seedTenant("acme");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const h = cookieHeaders(pat.token, HOST);
  await apiPost(HOST, "work.create", { project: "site", kind: "snag", title: "Metformin price wrong", body: "Shows $412 instead of $4" }, h);
  await apiPost(HOST, "work.create", { project: "site", kind: "wish", title: "Compare pharmacies", body: "side by side" }, h);
  await apiPost(HOST, "work.comment", { id: "site#2", body: "Metformin would be the first test case" }, h);
  await env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, project_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded)
    VALUES ('M1', ?, ?, ?, 'pat@example.com', 'acme.site@pimwell.test', 'Pricing question', ?, 10, 'admitted', 'Is metformin cheaper elsewhere?', '[]', 0)`).bind(t.id, p.id, pat.identity.id, Date.now()).run();
  const call = async (verb: string, body: unknown) => ((await (await apiPost(HOST, verb, body, h)).json()) as { result: Record<string, Array<{ ref: string; title: string; snippet: string }>> }).result;
  return { pat, h, call };
}

describe("search", () => {
  it("finds work by title, details and comments, title matches first", async () => {
    const w = await world();
    const r = await w.call("work.search", { q: "metformin" });
    expect(r.hits!.map((x) => x.ref)).toEqual(["site#1", "site#2"]);
    expect(r.hits![1]!.snippet).toContain("first test case");
    expect((await w.call("work.search", { q: "metformin pharmacies" })).hits!.map((x) => x.ref)).toEqual(["site#2"]);
    expect((await w.call("work.search", { q: "100%" })).hits).toEqual([]);
  });

  it("searches everything at once, grouped, and shows it on /search", async () => {
    const w = await world();
    const r = await w.call("search.query", { q: "metformin" });
    expect(r.work!.length).toBe(2);
    expect(r.mail!.map((m) => m.title)).toEqual(["Pricing question"]);
    expect((await w.call("search.query", { q: "site" })).projects!.map((p) => p.ref)).toEqual(["site"]);
    const page = await (await SELF.fetch(`https://${HOST}/search?q=metformin`, { headers: w.h })).text();
    expect(page).toContain("Metformin price wrong");
    expect(page).toContain("Pricing question");
    const jump = await (await SELF.fetch(`https://${HOST}/jump?q=metformin`, { headers: { ...w.h, accept: "application/json" } })).json() as { results: Array<{ href: string }> };
    expect(jump.results.map((x) => x.href)).toContain("/search?q=metformin");
  });

  it("needs real words and keeps snippets short around the match", () => {
    expect(() => terms("a")).toThrow();
    expect(terms("  Price   WRONG ")).toEqual(["price", "wrong"]);
    expect(snippet(`${"x ".repeat(200)}needle here ${"y ".repeat(200)}`, ["needle"]).startsWith("…")).toBe(true);
  });
});
