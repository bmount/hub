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
  return { t, p, pat, h, call };
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

  it("searches body text across projects, extracted attachments, reviews, situations and private assistant conversations", async () => {
    const w = await world(), now = Date.now();
    await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "backend", kind: "repo", display_name: "Backend" }, now);
    await apiPost(HOST, "work.create", { project: "backend", kind: "errand", title: "A normal title", body: "galactic needle in the details" }, w.h);
    await env.HUB_DB.prepare("UPDATE inbound_mail SET attachments = ? WHERE id = 'M1'").bind(JSON.stringify([{ filename: "note.txt", text: "galactic needle in an attachment", text_status: "complete" }])).run();
    await env.HUB_DB.prepare("INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES ('T1', ?, ?, 'An ordinary conversation', 'read', ?, ?)").bind(w.t.id, w.pat.identity.id, now, now).run();
    await env.HUB_DB.prepare("INSERT INTO assistant_message (id, thread_id, tenant_id, role, text, created_at) VALUES ('A1', 'T1', ?, 'user', 'galactic needle privately discussed', ?)").bind(w.t.id, now).run();
    await env.HUB_DB.prepare("INSERT INTO situation (id, tenant_id, identity_id, thread_id, title, question, report, created_at) VALUES ('S1', ?, ?, 'T1', 'Investigation', 'What happened?', 'galactic needle in the report', ?)").bind(w.t.id, w.pat.identity.id, now).run();
    await env.HUB_DB.prepare("INSERT INTO review (id, tenant_id, project_id, number, branch, base, title, author_id, status, created_at, updated_at) VALUES ('R1', ?, ?, 1, 'main', 'main', 'Review', ?, 'open', ?, ?)").bind(w.t.id, w.p.id, w.pat.identity.id, now, now).run();
    await env.HUB_DB.prepare("INSERT INTO review_comment (id, review_id, tenant_id, author_id, body, created_at) VALUES ('RC1', 'R1', ?, ?, 'galactic needle in a review comment', ?)").bind(w.t.id, w.pat.identity.id, now).run();
    const r = await w.call("search.query", { q: "galactic needle" });
    expect(r.work!.map(x => x.ref)).toEqual(["backend#1"]);
    expect(r.mail![0]!.snippet).toContain("in an attachment");
    expect(r.reviews![0]!.snippet).toContain("review comment");
    expect(r.situations![0]!.snippet).toContain("in the report");
    expect(r.assistant![0]!.snippet).toContain("privately discussed");
    const palette = await SELF.fetch(`https://${HOST}/search?format=json&q=galactic%20needle`, { headers: w.h });
    expect(palette.headers.get("cache-control")).toBe("no-store");
    const suggestions = await palette.json() as { results: Array<{href: string; hint: string}> };
    expect(suggestions.results).toEqual(expect.arrayContaining([expect.objectContaining({ href: "/backend/w/1", hint: expect.stringContaining("galactic needle") })]));
    expect((await SELF.fetch(`https://${HOST}/search?format=json&q=needle`)).status).toBe(404);
  });

  it("does not expose other people's assistant chats, private mail, attachments or other tenants through search", async () => {
    const w = await world(), now = Date.now();
    const other = await seedHuman("other@example.com", { memberships: [{ tenant_id: w.t.id, role: "member" }] });
    await env.HUB_DB.prepare("INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES ('PRIVATE', ?, ?, 'needle private title', 'read', ?, ?)").bind(w.t.id, other.identity.id, now, now).run();
    await env.HUB_DB.prepare("INSERT INTO outbound_mail (id, tenant_id, from_address, to_address, subject, text, sent_by, status, created_at) VALUES ('OUT', ?, 'me@example.com', 'friend@example.com', 'A letter', 'needle <script>attack()</script>', ?, 'sent', ?)").bind(w.t.id, other.identity.id, now).run();
    await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ?, text = 'needle private message', attachments = ? WHERE id = 'M1'").bind(other.identity.id, JSON.stringify([{ text: 'needle private attachment' }])).run();
    const foreign = await seedTenant("foreign");
    await env.HUB_DB.prepare("INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES ('FOREIGN', ?, ?, 'needle foreign private title', 'read', ?, ?)").bind(foreign.id, w.pat.identity.id, now, now).run();
    const r = await w.call("search.query", { q: "needle" });
    expect(r.assistant).toEqual([]);expect(r.mail).toEqual([]);expect(r.outgoing).toEqual([]);
    expect((await SELF.fetch(`https://${HOST}/mail/sent/OUT`, { headers: w.h })).status).toBe(404);
    const ownerHeaders = cookieHeaders(other.token, HOST);
    const ownerResult = await (await apiPost(HOST, "search.query", { q: "needle" }, ownerHeaders)).json() as {result: {outgoing: unknown[]; assistant: unknown[]; mail: unknown[]}};
    expect(ownerResult.result.outgoing).toHaveLength(1);expect(ownerResult.result.assistant).toHaveLength(1);expect(ownerResult.result.mail).toHaveLength(1);
    const page = await SELF.fetch(`https://${HOST}/mail/sent/OUT`, { headers: ownerHeaders });
    expect(page.status).toBe(200);
    const html = await page.text();expect(html).toContain("&lt;script&gt;attack()");expect(html).not.toContain("<script>attack()");
    expect((await SELF.fetch(`https://${HOST}/mail/sent/OUT`)).status).toBe(404);
  });

  it("needs real words and keeps snippets short around the match", () => {
    expect(() => terms("a")).toThrow();
    expect(terms("  Price   WRONG ")).toEqual(["price", "wrong"]);
    expect(snippet(`${"x ".repeat(200)}needle here ${"y ".repeat(200)}`, ["needle"]).startsWith("…")).toBe(true);
  });
});
