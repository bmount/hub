// Reviews: request a branch review, comment, give verdicts tied to the commit reviewed; reviewers hear about it.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { createChannel } from "../src/db/chat";
import { createNamespace } from "../src/db/namespaces";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { setArdiForTest } from "../src/code/ardi";
import { apiPost, cookieHeaders, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const BASE = "a".repeat(40), HEAD = "b".repeat(40);
afterEach(() => setArdiForTest(null));

function ardi(head = HEAD) {
  const commit = (oid: string, parents: string[], summary: string) => ({ oid, parents, summary, tree: "t", author_name: "Sam", author_email: "s@example.com", author_time: 1, committer_name: "Sam", committer_email: "s@example.com", commit_time: 1791000000, principal: null, session: null, trailer_principal: null, trailer_session: null });
  setArdiForTest({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const verb = new URL(String(input instanceof Request ? input.url : input)).pathname.split("/api/")[1];
      const b = JSON.parse(String(init?.body)) as Record<string, string>;
      const ok = (result: unknown) => Response.json({ ok: true, result, next: null });
      if (verb === "log") return ok({ commits: b.ref === "refs/heads/main" ? [commit(BASE, [], "Base")] : [commit(head, [BASE], "Faster prices"), commit(BASE, [], "Base")] });
      if (verb === "commit.show") return ok({ ...commit(b.oid!, [BASE], "Faster prices"), changes: [{ path: "p.ts", prev_path: null, prev_blob: "x", new_blob: "y", kind: "modify" }] });
      if (verb === "file.show") return ok({ content_b64: btoa(b.rev === BASE ? "slow\n" : "fast\n"), size: 5 });
      return Response.json({ ok: false, error: "nope" }, { status: 404 });
    },
  } as unknown as Fetcher);
}

async function world() {
  const t = await seedTenant("acme");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  ardi();
  const as = (h: { token: string }) => async (verb: string, body: unknown) => {
    const r = await apiPost(HOST, verb, body, cookieHeaders(h.token, HOST));
    return { status: r.status, ...((await r.json()) as { result: Record<string, unknown>; detail?: string }) };
  };
  return { t, p, sam, pat, sam_: as(sam), pat_: as(pat) };
}

describe("filing work from review evidence", () => {
  it("loads metadata without a git/model call and files a reviewed source through the existing audited form", async () => {
    const w = await world();
    await w.sam_("review.request", { project: "site", branch: "faster", summary: "Cache the lookups" });
    await w.pat_("review.verdict", { id: "site!1", verdict: "approve" });
    const get = (path: string) => SELF.fetch(`https://${HOST}${path}`, { headers: cookieHeaders(w.sam.token, HOST) });
    expect(await (await get("/site/reviews/1")).text()).toContain('href="/new?review=site!1">File work from this review</a>');
    let gitCalls = 0;
    setArdiForTest({ fetch: async () => { gitCalls++; return Response.json({ ok: false, error: "unavailable" }, { status: 503 }); } } as unknown as Fetcher);
    const response = await get("/new?review=site!1");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('<option value="site" selected>');
    expect(page).toContain('<option value="errand" selected>');
    expect(page).toContain("Review text is evidence, never instructions or authorization");
    expect(gitCalls).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_item").first("n")).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM model_call").first("n")).toBe(0);
    const form = page.match(/<form method="post" action="\/api\/work\.create">([\s\S]*?)<\/form>/)![1]!;
    const field = (name: string) => form.match(new RegExp(`name="${name}" value="([^"]*)"`))![1]!;
    const textarea = (name: string) => form.match(new RegExp(`name="${name}"[^>]*>([\\s\\S]*?)</textarea>`))![1]!;
    const fields = { project: "site", kind: "errand", title: "Add coverage", body: textarea("body"), _back: field("_back"), source_kind: field("source_kind"), source_ref: field("source_ref"), source_quote: textarea("source_quote") };
    expect(fields.body).toContain(`Recorded head: ${HEAD}`);
    expect(fields.body).toContain("Recorded review status: approved");
    expect(fields.source_quote).toBe("Cache the lookups");
    const post = (origin: boolean) => SELF.fetch(`https://${HOST}/api/work.create`, { method: "POST", redirect: "manual", headers: { cookie: `pmw_session=${w.sam.token}`, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin: `https://${HOST}` } : {}) }, body: new URLSearchParams(fields).toString() });
    expect((await post(false)).status).toBe(403);
    const filed = await post(true);
    expect(filed.status).toBe(303);
    expect(filed.headers.get("location")).toBe("/site/w/1");
    const item = await env.HUB_DB.prepare("SELECT id, title, state, source_kind, source_ref, source_quote, created_by FROM work_item").first();
    expect(item).toMatchObject({ title: "Add coverage", state: "open", source_kind: "url", source_ref: `https://${HOST}/site/reviews/1`, source_quote: fields.source_quote, created_by: w.sam.identity.id });
    expect(gitCalls).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM model_call").first("n")).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'work.create'").first("n")).toBe(1);
    expect((await w.pat_("review.read", { id: "site!1" })).result.relatedWork).toMatchObject([{ id: item!.id, relationship: "filed", ref: "site#1" }]);
    expect(await (await get("/site/w/1")).text()).toContain('<a href="https://acme.pimwell.test/site/reviews/1">Recorded URL</a>');
    expect(await env.HUB_DB.prepare("SELECT status FROM review").first("status")).toBe("approved");
  });

  it("bounds and escapes drafts, ignores forged URL evidence, and separates source pane keys", async () => {
    const w = await world();
    const opened = await w.sam_("review.request", { project: "site", branch: "faster" });
    const id = (opened.result.review as { id: string }).id;
    const prefix = "Follow up on site!1: ";
    const attack = '</textarea><script>evil()</script>';
    await env.HUB_DB.prepare("UPDATE review SET title = ?, summary = ?, head_oid = NULL WHERE id = ?")
      .bind("x".repeat(199 - prefix.length) + "🧪tail", attack + "x".repeat(1999 - attack.length) + "🧪tail", id).run();
    const page = await (await SELF.fetch(`https://${HOST}/new?review=${id}&project=forged&kind=call&title=pwned&body=pwned&source_ref=https://evil.test`, { headers: cookieHeaders(w.sam.token, HOST) })).text();
    expect(page).toContain('<option value="site" selected>');
    expect(page).toContain('<option value="errand" selected>');
    expect(page).not.toContain("pwned");
    expect(page).not.toContain("https://evil.test");
    expect(page).not.toContain(attack);
    expect(page).toContain("&lt;/textarea&gt;&lt;script&gt;evil()&lt;/script&gt;");
    expect(page).toContain("excerpt is shortened");
    expect(page).toContain("Recorded head: unknown");
    expect(page).not.toContain("🧪");
    expect(page.match(/name="title"[^>]*value="([^"]*)"/)![1]).toHaveLength(199);
    await w.sam_("review.request", { project: "site", branch: "other" });
    const otherPage = await (await SELF.fetch(`https://${HOST}/new?review=site!2`, { headers: cookieHeaders(w.sam.token, HOST) })).text();
    const key = (html: string) => html.match(/data-key="(new:review:[^"]*)"/)![1];
    expect(key(page)).not.toBe(key(otherPage));
  });

  it("refuses readers, invalid/mixed sources, foreign/channel/tracker/archived and ambiguous repositories", async () => {
    const w = await world();
    const opened = await w.sam_("review.request", { project: "site", branch: "faster" });
    const id = (opened.result.review as { id: string }).id;
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const root = await seedHuman("root@example.com", { is_root: true, memberships: [{ tenant_id: w.t.id, role: "admin" }] });
    const get = (ref: string, token = w.sam.token) => SELF.fetch(`https://${HOST}/new?review=${encodeURIComponent(ref)}&title=fallback-marker`, { headers: cookieHeaders(token, HOST) });
    expect((await get(id, reader.token)).status).toBe(404);
    expect((await SELF.fetch(`https://${HOST}/new?review=site!1`)).status).toBe(404);
    const readerPage = await (await SELF.fetch(`https://${HOST}/site/reviews/1`, { headers: cookieHeaders(reader.token, HOST) })).text();
    expect(readerPage).not.toContain("File work from this review");
    for (const ref of ["", "unknown", "site!0", "site!999999999", "../reviews", "x".repeat(81)]) {
      const response = await get(ref);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("fallback-marker");
    }
    expect((await SELF.fetch(`https://${HOST}/new?review=site!1&trace=unknown`, { headers: cookieHeaders(w.sam.token, HOST) })).status).toBe(404);
    const foreign = await seedTenant("bravo");
    const project = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "private", kind: "repo", display_name: "Private" }, Date.now());
    const tracker = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "tracker", kind: "tracker", display_name: "Tracker" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "private-channel", display_name: "Private channel", topic: "", created_by: w.sam.identity.id }, Date.now());
    for (const [tenant, pid] of [[foreign.id, project.id], [w.t.id, project.id], [w.t.id, channel.project_id], [w.t.id, tracker.id]]) {
      await env.HUB_DB.prepare("UPDATE review SET tenant_id = ?, project_id = ? WHERE id = ?").bind(tenant, pid, id).run();
      for (const token of [w.sam.token, root.token]) {
        const denied = await get(id, token);
        expect(denied.status).toBe(404);
        expect(await denied.text()).not.toContain("Faster prices");
      }
    }
    await env.HUB_DB.prepare("UPDATE review SET tenant_id = ?, project_id = ?, status = 'closed' WHERE id = ?").bind(w.t.id, w.p.id, id).run();
    expect((await get(id)).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect((await get(id)).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE project SET state = 'active' WHERE id = ?").bind(w.p.id).run();
    const ns = await createNamespace(env.HUB_DB, { tenant_id: w.t.id, slug: "team", display_name: "Team" }, Date.now());
    const duplicate = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: ns.id, slug: "site", kind: "repo", display_name: "Other site" }, Date.now());
    expect((await get(id)).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(duplicate.id).run();
    expect((await get(id)).status).toBe(404);
  });
});

describe("recorded review/work evidence", () => {
  it("deduplicates URL sources, URL links and full recorded-head commit links across UI/API/MCP", async () => {
    const w = await world();
    await w.sam_("review.request", { project: "site", branch: "faster" });
    const url = `https://${HOST}/site/reviews/1`;
    const create = async (title: string, fields: Record<string, unknown> = {}) => (await w.sam_("work.create", { project: "site", kind: "errand", title, ...fields })).result.item as { id: string; number: number };
    const filed = await create("Filed source", { source_kind: "url", source_ref: url, state: "done" });
    const linked = await create('<img src=x onerror="alert(1)">Linked work');
    const committed = await create("Recorded head work");
    const unrelated = await create("Unrelated work");
    for (const item of [filed, linked, committed]) await w.sam_("work.link", { id: item.id, target_kind: "commit", target_ref: `site@${HEAD.toUpperCase()}` });
    for (const item of [filed, linked]) await w.sam_("work.link", { id: item.id, target_kind: "url", target_ref: url });
    await w.sam_("work.link", { id: unrelated.id, target_kind: "url", target_ref: `${url}?extra=1` });
    const moving = "c".repeat(40);
    const tip = await create("Moving-tip-only work");
    await w.sam_("work.link", { id: tip.id, target_kind: "commit", target_ref: `site@${moving}` });
    ardi(moving);
    const result = await w.pat_("review.read", { id: "site!1" });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ head: moving, relatedWorkCommit: `site@${HEAD}`, relatedWork: [
      { id: committed.id, relationship: "commit" }, { id: linked.id, relationship: "linked" }, { id: filed.id, relationship: "filed", state: "done" },
    ], relatedWorkCoverage: { limit: 50, shown: 3, truncated: false } });
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const page = await (await SELF.fetch(`https://${HOST}/site/reviews/1`, { headers: cookieHeaders(reader.token, HOST) })).text();
    expect(page).toContain(`href="/site/w/${filed.number}">Filed source</a>`);
    expect(page.match(/>Filed source<\/a>/g)).toHaveLength(1);
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Linked work");
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain("Moving-tip-only work");
    expect(page).not.toContain("Unrelated work");
    expect(page).toContain("not proof that this work was reviewed, approved or completed");
    const { grant } = await seedGrant(w.t, reader);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const mcp = await callTool(ctx, "review_read", { id: "site!1" });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.structuredContent).toMatchObject({ relatedWork: result.result.relatedWork, relatedWorkCommit: `site@${HEAD}` });
    expect(JSON.stringify(mcp.content)).toContain("Recorded work (3 shown; complete for recorded associations)");
    expect(JSON.stringify(mcp.content)).toContain("not the moving branch tip");
    expect((await callTool({ ...ctx, oauth: { ...ctx.oauth!, scopes: ["write"] } }, "review_read", { id: "site!1" })).isError).toBe(true);
    expect((await SELF.fetch(`https://${HOST}/site/reviews/1`)).status).toBe(404);
    await w.sam_("work.update", { id: committed.id, title: "Changed work title", state: "doing" });
    const changedPage = await (await SELF.fetch(`https://${HOST}/site/reviews/1`, { headers: cookieHeaders(reader.token, HOST) })).text();
    const key = (html: string) => html.match(/data-key="(review:[^"]*)"/)![1];
    expect(key(changedPage)).not.toBe(key(page));
    expect(changedPage).toContain("Changed work title");
  });

  it("keeps explicit associations when the recorded head is unsupported or the diff is unavailable", async () => {
    const w = await world();
    const opened = await w.sam_("review.request", { project: "site", branch: "faster" });
    const id = (opened.result.review as { id: string }).id;
    const item = (await w.sam_("work.create", { project: "site", kind: "snag", title: "Explicit association", source_kind: "url", source_ref: `https://${HOST}/site/reviews/1` })).result.item as { id: string };
    await w.sam_("work.link", { id: item.id, target_kind: "commit", target_ref: `site@${HEAD.slice(0, 7)}` });
    setArdiForTest({ fetch: async () => Response.json({ ok: false, error: "unavailable" }, { status: 503 }) } as unknown as Fetcher);
    for (const head of [null, HEAD.slice(0, 7), "g".repeat(40), HEAD + "\n"]) {
      await env.HUB_DB.prepare("UPDATE review SET head_oid = ? WHERE id = ?").bind(head, id).run();
      const result = await w.pat_("review.read", { id });
      expect(result.result).toMatchObject({ diff: null, relatedWorkCommit: null, relatedWork: [{ id: item.id, relationship: "filed" }], relatedWorkCoverage: { shown: 1, truncated: false } });
      expect(result.result.diff_error).not.toBeNull();
    }
  });

  it("reports exact empty/full/capped coverage with invalid work excluded before the limit", async () => {
    const w = await world();
    await w.sam_("review.request", { project: "site", branch: "faster" });
    const read = async () => (await w.pat_("review.read", { id: "site!1" })).result;
    expect(await read()).toMatchObject({ relatedWork: [], relatedWorkCoverage: { shown: 0, truncated: false } });
    const add = async (n: number, tenant = w.t.id, project = w.p.id, number = n + 1) => {
      await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, source_kind, source_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'errand', 'Associated', '', 'open', 'url', ?, ?, ?, ?)")
        .bind(`work-${String(n).padStart(3, "0")}`, tenant, project, number, `https://${HOST}/site/reviews/1`, w.sam.identity.id, n, n).run();
    };
    for (let n = 0; n < 50; n++) await add(n);
    expect(await read()).toMatchObject({ relatedWorkCoverage: { shown: 50, truncated: false } });
    const foreign = await seedTenant("bravo");
    const project = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "foreign-secret", kind: "repo", display_name: "Foreign" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "channel-secret", display_name: "Channel", topic: "", created_by: w.sam.identity.id }, Date.now());
    for (let n = 100; n < 155; n++) await add(n, n % 3 === 0 ? foreign.id : w.t.id, n % 3 === 0 ? w.p.id : n % 3 === 1 ? project.id : channel.project_id);
    await add(200, w.t.id, w.p.id, 0);
    await add(201, w.t.id, w.p.id, 100000000);
    expect(await read()).toMatchObject({ relatedWorkCoverage: { shown: 50, truncated: false } });
    await add(50);
    const capped = await read();
    expect(capped.relatedWorkCoverage).toEqual({ limit: 50, shown: 50, truncated: true });
    expect((capped.relatedWork as Array<{ id: string }>).map(r => r.id)).toEqual(Array.from({ length: 50 }, (_, n) => `work-${String(50 - n).padStart(3, "0")}`));
    const page = await (await SELF.fetch(`https://${HOST}/site/reviews/1`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(page).toContain("capped at 50, more omitted");
    expect(page).not.toContain("foreign-secret");
    expect(page).not.toContain("channel-secret");
  });

  it("refuses foreign/channel/inconsistent reviews and filters foreign comments", async () => {
    const w = await world();
    const opened = await w.sam_("review.request", { project: "site", branch: "faster" });
    const id = (opened.result.review as { id: string }).id;
    const foreign = await seedTenant("bravo");
    const project = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "foreign-secret", kind: "repo", display_name: "Foreign" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "channel-secret", display_name: "Channel", topic: "", created_by: w.sam.identity.id }, Date.now());
    await env.HUB_DB.prepare("INSERT INTO review_comment (id, review_id, tenant_id, author_id, body, created_at) VALUES ('foreign-comment', ?, ?, ?, 'Foreign comment secret', 1)").bind(id, foreign.id, w.sam.identity.id).run();
    expect((await w.pat_("review.read", { id })).result.comments).toEqual([]);
    for (const [tenant, pid] of [[foreign.id, project.id], [w.t.id, project.id], [w.t.id, channel.project_id]]) {
      await env.HUB_DB.prepare("UPDATE review SET tenant_id = ?, project_id = ? WHERE id = ?").bind(tenant, pid, id).run();
      expect((await w.pat_("review.read", { id })).status).toBe(404);
      expect((await w.pat_("review.list", {})).result.reviews).toEqual([]);
      const page = await (await SELF.fetch(`https://${HOST}/reviews`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
      expect(page).not.toContain("foreign-secret");
      expect(page).not.toContain("channel-secret");
      expect(page).not.toContain("Foreign comment secret");
    }
  });
});

describe("reviews", () => {
  it("opens a review, tells the reviewer, and shows the diff", async () => {
    const w = await world();
    const r = await w.sam_("review.request", { project: "site", branch: "faster", reviewers: ["pat@example.com"], summary: "Cache the lookups" });
    expect(r.status, r.detail).toBe(200);
    expect(r.result.ref).toBe("site!1");
    const needs = (await w.pat_("attention.list", {})).result.entries as Array<{ summary: string; href: string }>;
    expect(needs[0]!.summary).toContain("asked you to review site!1");
    const read = await w.pat_("review.read", { id: "site!1" });
    expect((read.result.diff as { commits: number; files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(["p.ts"]);
    const page = await (await SELF.fetch(`https://${HOST}/site/reviews/1`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(page).toContain("<h1>Faster prices</h1>");
    expect(page).toContain("<code>+fast</code>");
    expect(page).toContain('name="verdict" value="approve"');
    const att = await (await SELF.fetch(`https://${HOST}/attention`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(att).toContain('data-href="/site/reviews/1"');
  });

  it("records comments and verdicts: changes need reasons, authors can't approve their own, any 'changes' holds it", async () => {
    const w = await world();
    await w.sam_("review.request", { project: "site", branch: "faster", reviewers: ["pat@example.com"] });
    expect((await w.sam_("review.verdict", { id: "site!1", verdict: "approve" })).status).toBe(403);
    expect((await w.pat_("review.verdict", { id: "site!1", verdict: "changes" })).status).toBe(400);
    expect((await w.pat_("review.verdict", { id: "site!1", verdict: "changes", reason: "Add a test" })).result.status).toBe("changes");
    await w.pat_("review.comment", { id: "site!1", body: "Off by one?", path: "p.ts", line: 1 });
    expect((await w.pat_("review.verdict", { id: "site!1", verdict: "approve" })).result.status).toBe("approved");
    const v = (await w.sam_("review.read", { id: "site!1" })).result;
    expect((v.comments as Array<{ path: string; line: number }>)[0]).toMatchObject({ path: "p.ts", line: 1 });
    expect((v.reviewers as Array<{ verdict: string; stale: boolean }>)[0]).toMatchObject({ verdict: "approve", stale: false });
    const list = (await w.sam_("review.list", {})).result.reviews as Array<{ status: string }>;
    expect(list[0]!.status).toBe("approved");
  });

  it("refuses unknown branches, outsiders, and bad names", async () => {
    const w = await world();
    expect((await w.sam_("review.request", { project: "site", branch: "faster", reviewers: ["stranger@example.com"] })).status).toBe(400);
    expect((await w.sam_("review.request", { project: "site", branch: "main" })).status).toBe(400);
    expect((await w.sam_("review.request", { project: "site", branch: "x y" })).status).toBe(400);
    expect((await w.sam_("review.read", { id: "site!9" })).status).toBe(404);
  });
});
