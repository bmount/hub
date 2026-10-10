// Code views over Ardi, against a stand-in git host: the shapes are the deployed Ardi's (probed 2026-10-07).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { createChannel } from "../src/db/chat";
import { buildContext, oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { afterCommit } from "../src/verbs/code";
import { commitWorkStatement } from "../src/work/commitEvidence";
import { setArdiForTest } from "../src/code/ardi";
import { apiPost, bearer, cookieHeaders, seedAgent, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
afterEach(() => setArdiForTest(null));

const b64 = (s: string) => btoa(s);
function fakeArdi(seen: Array<{ path: string; auth: string | null; body: Record<string, unknown> }>, pusher: string) {
  const files: Record<string, string> = { [`${A}:app.ts`]: "one\ntwo\nthree\n", [`${B}:app.ts`]: "one\nTWO\nthree\n", [`${B}:new.md`]: "hello\n" };
  setArdiForTest({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization"), body });
      const verb = url.pathname.split("/api/")[1];
      const ok = (result: unknown, next: string | null = null) => Response.json({ ok: true, result, next });
      const commit = (oid: string, parents: string[], summary: string) => ({ oid, parents, summary, tree: "t", author_name: "Bruno", author_email: "b@example.com", author_time: 1791000000, committer_name: "Bruno", committer_email: "b@example.com", commit_time: 1791000000, principal: pusher, session: "S1", trailer_principal: null, trailer_session: null });
      if (verb === "refs.list") return ok({ refs: [{ name: "refs/heads/main", target: B }, { name: "refs/heads/pio/topic", target: C }] });
      if (verb === "log") return ok({ commits: [commit(B, [A], "Fix two (site#1)"), commit(A, [], "Start")] }, "cursor1");
      if (verb === "commit.show") return ok({ ...commit(String(body.oid), body.oid === B ? [A] : [], body.oid === B ? "Fix two (site#1)" : "Start"), message: "Fix two (site#1)\n\nCareful now.",
        changes: body.oid === B ? [{ path: "app.ts", prev_path: null, prev_blob: "x", new_blob: "y", kind: "modify" }, { path: "new.md", prev_path: null, prev_blob: null, new_blob: "z", kind: "add" }] : [] });
      if (verb === "file.show") { const at = body.rev === "HEAD" || String(body.rev).startsWith("refs/") ? B : body.rev; const k = `${at}:${body.path}`; return k in files ? ok({ content_b64: b64(files[k]!), size: files[k]!.length, oid: "o", path: body.path, rev: body.rev }) : Response.json({ ok: false, error: "no such path" }, { status: 404 }); }
      if (verb === "tree.list") return ok({ entries: body.path === "src" ? [{ kind: "blob", mode: "100644", name: "x.ts", oid: "o" }] : [{ kind: "tree", mode: "040000", name: "src", oid: "t" }, { kind: "blob", mode: "100644", name: "app.ts", oid: "o" }] });
      return Response.json({ ok: false, error: "unknown verb" }, { status: 404 });
    },
  } as unknown as Fetcher);
}

async function world() {
  const t = await seedTenant("acme");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const bot = await seedAgent(t, pat.identity, "scout");
  const seen: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = [];
  fakeArdi(seen, pat.identity.id);
  const call = async (h: Record<string, string>, verb: string, body: unknown) => {
    const r = await apiPost(HOST, verb, body, h);
    return { status: r.status, ...((await r.json()) as { result: Record<string, unknown>; detail?: string }) };
  };
  return { t, p, pat, bot, seen, call, h: cookieHeaders(pat.token, HOST) };
}

describe("recorded commit/work evidence", () => {
  it("joins deduplicated full references and exact URLs across API/UI/MCP, not short ids or alternate URLs", async () => {
    const w = await world();
    const url = `https://${HOST}/site/code?c=${B}`;
    const create = async (title: string, extra: Record<string, unknown> = {}) => (await w.call(w.h, "work.create", { project: "site", kind: "errand", title, ...extra })).result.item as { id: string; number: number };
    const filed = await create("Filed source", { source_kind: "url", source_ref: url, state: "done" });
    const linked = await create("URL-linked work");
    const committed = await create('<img src=x onerror="evil()">Commit work');
    for (const item of [filed, linked, committed]) await w.call(w.h, "work.link", { id: item.id, target_kind: "commit", target_ref: `site@${B.toUpperCase()}` });
    for (const item of [filed, linked]) await w.call(w.h, "work.link", { id: item.id, target_kind: "url", target_ref: url });
    for (const [kind, ref] of [["commit", `site@${B.slice(0, 7)}`], ["commit", `SITE@${B}`], ["url", `${url}&ref=main`], ["url", `${url}#fragment`]]) {
      const item = await create(`Unsupported ${ref}`);
      await w.call(w.h, "work.link", { id: item.id, target_kind: kind, target_ref: ref });
    }
    const result = (await w.call(w.h, "repo.commit", { project: "site", oid: B.toUpperCase() })).result;
    expect(result).toMatchObject({ relatedWork: [{ id: committed.id, relationship: "commit" }, { id: linked.id, relationship: "linked" }, { id: filed.id, relationship: "filed", state: "done" }], relatedWorkCoverage: { limit: 50, shown: 3, truncated: false } });
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const get = async () => (await SELF.fetch(`https://${HOST}/site/code?c=${B}`, { headers: cookieHeaders(reader.token, HOST) })).text();
    const page = await get();
    expect(page).toContain(`href="/site/w/${filed.number}">Filed source</a>`);
    expect(page.match(/>Filed source<\/a>/g)).toHaveLength(1);
    expect(page).toContain("&lt;img src=x onerror=&quot;evil()&quot;&gt;Commit work");
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain("Unsupported");
    expect(page).toContain("do not prove that this commit completes, reviews or approves the work");
    const { grant } = await seedGrant(w.t, reader);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const mcp = await callTool(ctx, "repo_commit", { project: "site", oid: B });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.structuredContent).toMatchObject({ relatedWork: result.relatedWork, relatedWorkCoverage: result.relatedWorkCoverage });
    expect(JSON.stringify(mcp.content)).toContain("Recorded work (3 shown; complete for recorded associations)");
    expect((await callTool({ ...ctx, oauth: { ...ctx.oauth!, scopes: ["write"] } }, "repo_commit", { project: "site", oid: B })).isError).toBe(true);
    await w.call(w.h, "work.update", { id: committed.id, title: "Changed title", state: "doing" });
    const updated = await get();
    const key = (html: string) => html.match(/data-key="(commit:[^"]*)"/)![1];
    expect(key(updated)).not.toBe(key(page));
    expect(updated).toContain("Changed title");
    expect((await SELF.fetch(`https://${HOST}/site/code?c=${B}`)).status).toBe(404);
  });

  it("reports empty/exact/capped coverage, excluding foreign, inconsistent and channel work before limiting", async () => {
    const w = await world();
    const read = async () => (await w.call(w.h, "repo.commit", { project: "site", oid: B })).result;
    expect(await read()).toMatchObject({ relatedWork: [], relatedWorkCoverage: { shown: 0, truncated: false } });
    const add = async (n: number, tenant = w.t.id, project = w.p.id, number = n + 1) => {
      await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, source_kind, source_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'errand', 'Associated work', '', 'open', 'url', ?, ?, ?, ?)")
        .bind(`work-${String(n).padStart(3, "0")}`, tenant, project, number, `https://${HOST}/site/code?c=${B}`, w.pat.identity.id, n, n).run();
    };
    for (let n = 0; n < 50; n++) await add(n);
    expect(await read()).toMatchObject({ relatedWorkCoverage: { shown: 50, truncated: false } });
    const foreign = await seedTenant("bravo");
    const project = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "private-project", kind: "repo", display_name: "Private" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "private-channel", display_name: "Private channel", topic: "", created_by: w.pat.identity.id }, Date.now());
    for (let n = 100; n < 155; n++) await add(n, n % 3 === 0 ? foreign.id : w.t.id, n % 3 === 0 ? w.p.id : n % 3 === 1 ? project.id : channel.project_id);
    await add(200, w.t.id, w.p.id, 0);
    await add(201, w.t.id, w.p.id, 100000000);
    expect(await read()).toMatchObject({ relatedWorkCoverage: { shown: 50, truncated: false } });
    await add(50);
    const capped = await read();
    expect(capped.relatedWorkCoverage).toEqual({ limit: 50, shown: 50, truncated: true });
    expect((capped.relatedWork as Array<{ id: string }>).map(r => r.id)).toEqual(Array.from({ length: 50 }, (_, n) => `work-${String(50 - n).padStart(3, "0")}`));
    const page = await (await SELF.fetch(`https://${HOST}/site/code?c=${B}`, { headers: w.h })).text();
    expect(page).toContain("capped at 50, more omitted");
    expect(page).not.toContain("private-project");
    expect(page).not.toContain("private-channel");
    const ctx = await buildContext(new Request(`https://${HOST}/`, { headers: w.h }), env);
    expect((await commitWorkStatement(ctx, project.id, B).all()).results).toEqual([]);
    expect((await commitWorkStatement(ctx, channel.project_id, B).all()).results).toEqual([]);
    expect((await commitWorkStatement(ctx, w.p.id, B.slice(0, 7)).all()).results).toEqual([]);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect(await read()).toMatchObject({ relatedWorkCoverage: { shown: 50, truncated: true } });
  });

  it("keeps deploy and error evidence inside the current tenant and consistent repository project", async () => {
    const w = await world();
    const foreign = await seedTenant("bravo");
    const project = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "private", kind: "repo", display_name: "Private" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "private-channel", display_name: "Private channel", topic: "", created_by: w.pat.identity.id }, Date.now());
    const at = 1791000000 * 1000;
    for (const [n, tenant, pid] of [[0, foreign.id, w.p.id], [1, w.t.id, project.id], [2, w.t.id, channel.project_id], [3, w.t.id, w.p.id]] as const) {
      await env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(`deploy-${n}`, tenant, pid, n < 3 ? "Private deploy" : "Own deploy", `v${n}`, B.slice(0, 8), at + n).run();
      await env.HUB_DB.prepare("INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, title, last_message, count, first_seen, last_seen) VALUES (?, ?, ?, 'app', ?, 'exception', ?, '', 1, ?, ?)").bind(`error-${n}`, tenant, pid, `fp-${n}`, n < 3 ? "Private error" : "Own error", at + 10, at + 10).run();
    }
    const after = (await w.call(w.h, "repo.commit", { project: "site", oid: B })).result.after;
    expect(after).toEqual({ shipped: { tag: B.slice(0, 8), script: "Own deploy", at: at + 3, match: "tag-prefix" }, since: [{ tag: B.slice(0, 8), script: "Own deploy", at: at + 3 }], errors: [{ id: "error-3", title: "Own error", count: 1, first_seen: at + 10 }], sinceCoverage: { limit: 10, shown: 1, truncated: false }, errorsCoverage: { limit: 10, shown: 1, truncated: false }, errorsSince: { at: at + 3, basis: "tag-prefix" } });
    const ctx = await buildContext(new Request(`https://${HOST}/`, { headers: w.h }), env);
    for (const pid of [project.id, channel.project_id]) expect(await afterCommit(ctx, pid, B, at)).toMatchObject({ shipped: null, since: [], errors: [], sinceCoverage: { shown: 0, truncated: false }, errorsCoverage: { shown: 0, truncated: false } });
    const page = await (await SELF.fetch(`https://${HOST}/site/code?c=${B}`, { headers: w.h })).text();
    expect(page).toContain("Own error");
    expect(page).not.toContain("Private deploy");
    expect(page).not.toContain("Private error");
  });
});

describe("recorded commit deployment evidence", () => {
  it("rejects malformed/contradictory matches and prefers exact full IDs to explicitly labelled prefix hints", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${HOST}/`, { headers: w.h }), env);
    const at = 1791000000 * 1000;
    const add = async (id: string, version: string, tag: string | null, offset: number) => env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, w.t.id, w.p.id, id, version, tag, at + offset).run();
    for (const [n, version, tag] of [[0, "v0", "bbbbbb_%"], [1, "v1", "b".repeat(41)], [2, "v2", "b".repeat(6)], [3, "v3", C.slice(0, 8)], [4, A, B.slice(0, 8)], [5, "v5", "release!"]] as const) await add(`bad-${n}`, version, tag, n);
    const read = () => afterCommit(ctx, w.p.id, B.toUpperCase(), at);
    expect(await read()).toMatchObject({ shipped: null, errorsSince: { at, basis: "commit-time" } });
    await add("Hint", "runtime-uuid", B.slice(0, 8).toUpperCase(), 20);
    expect(await read()).toMatchObject({ shipped: { script: "Hint", match: "tag-prefix", at: at + 20 }, errorsSince: { at: at + 20, basis: "tag-prefix" } });
    const hintPage = await (await SELF.fetch(`https://${HOST}/site/code?c=${B}`, { headers: w.h })).text();
    expect(hintPage).toContain("tag-prefix hint");
    await add("Exact<script>evil()</script>", B.toUpperCase(), null, 40);
    for (const [id, offset] of [["before", 39], ["after", 40]] as const) await env.HUB_DB.prepare("INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, title, last_message, count, first_seen, last_seen) VALUES (?, ?, ?, 'app', ?, 'exception', ?, '', 1, ?, ?)").bind(id, w.t.id, w.p.id, id, id, at + offset, at + offset).run();
    expect(await read()).toMatchObject({ shipped: { script: "Exact<script>evil()</script>", match: "full-commit", tag: null, at: at + 40 }, errors: [{ id: "after" }], errorsSince: { at: at + 40, basis: "full-commit" } });
    const result = (await w.call(w.h, "repo.commit", { project: "site", oid: B })).result;
    const { grant } = await seedGrant(w.t, w.pat);
    const oauth = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const mcp = await callTool(oauth, "repo_commit", { project: "site", oid: B });
    expect(mcp.structuredContent).toMatchObject({ after: result.after });
    expect(JSON.stringify(mcp.content)).toContain("exact full commit ID");
    expect(JSON.stringify(mcp.content)).toContain("do not prove live rollout");
    const page = await (await SELF.fetch(`https://${HOST}/site/code?c=${B}`, { headers: w.h })).text();
    expect(page).toContain("exact full commit ID");
    expect(page).toContain("Exact&lt;script&gt;evil()&lt;/script&gt;");
    expect(page).not.toContain("Exact<script>");
    expect(page).not.toContain("<dt>Shipped</dt>");
    expect(page).toContain("do not prove live rollout");
  });

  it("reports empty, exactly full and truncated samples with stable ties and invalid rows excluded before limits", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${HOST}/`, { headers: w.h }), env);
    const at = 1791000000 * 1000;
    const read = () => afterCommit(ctx, w.p.id, B, at);
    expect(await read()).toMatchObject({ shipped: null, sinceCoverage: { limit: 10, shown: 0, truncated: false }, errorsCoverage: { limit: 10, shown: 0, truncated: false }, errorsSince: { at, basis: "commit-time" } });
    const add = async (n: number, tenant = w.t.id, pid = w.p.id, offset = 1) => {
      const id = `row-${String(n).padStart(3, "0")}`;
      await env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, seen_at) VALUES (?, ?, ?, ?, 'runtime', ?, ?)").bind(id, tenant, pid, id, id, at + offset).run();
      await env.HUB_DB.prepare("INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, title, last_message, count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, 'exception', ?, '', 1, ?, ?)").bind(id, tenant, pid, id, id, id, at + offset, at + offset).run();
    };
    for (let n = 0; n < 10; n++) await add(n);
    expect(await read()).toMatchObject({ sinceCoverage: { shown: 10, truncated: false }, errorsCoverage: { shown: 10, truncated: false } });
    const foreign = await seedTenant("bravo");
    const project = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "private", kind: "repo", display_name: "Private" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "private-channel", display_name: "Private channel", topic: "", created_by: w.pat.identity.id }, Date.now());
    for (let n = 100; n < 133; n++) await add(n, n % 3 === 0 ? foreign.id : w.t.id, n % 3 === 0 ? w.p.id : n % 3 === 1 ? project.id : channel.project_id, 0);
    expect(await read()).toMatchObject({ sinceCoverage: { shown: 10, truncated: false }, errorsCoverage: { shown: 10, truncated: false } });
    await add(10);
    const capped = await read();
    expect(capped.sinceCoverage).toEqual({ limit: 10, shown: 10, truncated: true });
    expect(capped.errorsCoverage).toEqual({ limit: 10, shown: 10, truncated: true });
    expect(capped.since.map(d => d.script)).toEqual(Array.from({ length: 10 }, (_, n) => `row-${String(n).padStart(3, "0")}`));
    expect(capped.errors.map(g => g.id)).toEqual(capped.since.map(d => d.script));
    const page = await (await SELF.fetch(`https://${HOST}/site/code?c=${B}`, { headers: w.h })).text();
    expect(page.match(/capped at 10, more omitted/g)).toHaveLength(2);
    expect(page).not.toContain("row-100");
  });
});

describe("code views", () => {
  it("reads branches and commits as the person, with a sealed git session minted once", async () => {
    const w = await world();
    const r = await w.call(w.h, "repo.branches", { project: "site" });
    expect(r.status, r.detail).toBe(200);
    expect((r.result.refs as unknown[]).length).toBe(2);
    await w.call(w.h, "repo.log", { project: "site", ref: "main" });
    expect(w.seen.map((s) => s.path)).toEqual(["/t/acme/api/refs.list", "/t/acme/api/log"]);
    expect(w.seen[1]!.body).toMatchObject({ repo: "site", ref: "refs/heads/main" });
    expect(w.seen[0]!.auth).toBe(w.seen[1]!.auth);
    const token = atob(w.seen[0]!.auth!.slice(6)).split(":")[1]!;
    expect(token.startsWith("pms_")).toBe(true);
    const creds = await env.HUB_DB.prepare("SELECT COUNT(*) AS n, MIN(ciphertext) AS c FROM ardi_cred").first<{ n: number; c: string }>();
    expect(creds!.n).toBe(1);
    expect(creds!.c).not.toContain(token);
    expect((await env.HUB_DB.prepare("SELECT kind, label FROM session WHERE id = (SELECT ref_id FROM ardi_cred)").first())).toEqual({ kind: "git", label: "Pimwell code views" });
  });

  it("shows a commit with each file's diff, and who pushed it", async () => {
    const w = await world();
    const r = await w.call(w.h, "repo.commit", { project: "site", oid: B });
    const files = r.result.files as Array<{ path: string; diff: { added: number; removed: number } }>;
    expect(files.map((f) => [f.path, f.diff.added, f.diff.removed])).toEqual([["app.ts", 1, 1], ["new.md", 1, 0]]);
    expect(r.result.pushed_by).toBe("pat");
    const page = await (await SELF.fetch(`https://${HOST}/site/code?c=${B}`, { headers: w.h })).text();
    expect(page).toContain("<h1>Fix two (site#1)</h1>");
    expect(page).toContain('<tr class="ins">');
    expect(page).toContain("pushed by pat");
  });

  it("agents read with their own run token; bad input never reaches the git host", async () => {
    const w = await world();
    const r = await w.call(bearer(w.bot.token), "repo.log", { project: "site" });
    expect(r.status).toBe(200);
    expect(atob(w.seen.at(-1)!.auth!.slice(6))).toBe(`agent:${w.bot.token}`);
    const before = w.seen.length;
    expect((await w.call(w.h, "repo.log", { project: "site", ref: "main; rm -rf" })).status).toBe(400);
    expect((await w.call(w.h, "repo.commit", { project: "site", oid: "abc" })).status).toBe(400);
    expect((await w.call(w.h, "repo.log", { project: "nope" })).status).toBe(404);
    expect(w.seen.length).toBe(before);
  });

  it("browses files and compares revisions", async () => {
    const w = await world();
    const root = await w.call(w.h, "repo.file", { project: "site" });
    expect((root.result.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(["src", "app.ts"]);
    const f = await w.call(w.h, "repo.file", { project: "site", path: "app.ts", ref: B });
    expect(f.result.text).toBe("one\nTWO\nthree\n");
    const d = await w.call(w.h, "repo.diff", { project: "site", from: A, to: "main" });
    expect(d.result).toMatchObject({ commits: 1 });
    expect((d.result.files as Array<{ path: string }>).map((x) => x.path)).toEqual(["app.ts", "new.md"]);
    const page = await (await SELF.fetch(`https://${HOST}/site/files?path=&f=app.ts`, { headers: w.h })).text();
    expect(page).toContain("<code>three</code>");
  });

  it("follows generated commit links on slash-containing branches and preserves branch context", async () => {
    const w = await world();
    const get = async (path: string) => (await SELF.fetch(`https://${HOST}${path}`, { headers: w.h })).text();
    const initial = await get("/site/code");
    const branchHref = [...initial.matchAll(/href="([^"]+)"/g)].map(m => m[1]!).find(h => h.includes("ref=pio%2Ftopic"));
    expect(branchHref).toBeTruthy();
    const branch = await get(branchHref!);
    expect(branch).not.toContain("give a branch");
    const commitHref = [...branch.matchAll(/href="([^"]+)"/g)].map(m => m[1]!.replace(/&amp;/g, "&")).find(h => h.includes(`c=${B}`));
    expect(commitHref).toContain("ref=pio%2Ftopic");
    const commit = await get(commitHref!);
    expect(commit).toContain("<h1>Fix two (site#1)</h1>");
    expect(commit).toContain('<tr class="ins">');
    expect(commit).not.toContain("give a branch");
    expect(w.seen.filter(s => s.path.endsWith("/log")).at(-1)!.body.ref).toBe("refs/heads/pio/topic");
    const file = await get("/site/files?ref=pio%2Ftopic&f=app.ts");
    expect(file).toContain("<code>TWO</code>");
    const compare = await w.call(w.h, "repo.diff", { project: "site", from: A, to: "pio/topic" });
    expect(compare.status).toBe(200);
    expect(compare.result.commits).toBe(1);
    const qualified = await w.call(w.h, "repo.log", { project: "site", ref: "refs/heads/pio/topic" });
    expect(qualified.status).toBe(200);
    expect(w.seen.at(-1)!.body.ref).toBe("refs/heads/pio/topic");
  });

  it("says plainly when the git host can't be reached", async () => {
    const w = await world();
    setArdiForTest({ fetch: async () => { throw new Error("down"); } } as unknown as Fetcher);
    expect((await w.call(w.h, "repo.branches", { project: "site" })).status).toBe(503);
    expect(await (await SELF.fetch(`https://${HOST}/site/code`, { headers: w.h })).text()).toContain("the git host did not answer");
  });

  it("says what came after a commit: the deploy that shipped it, and new errors since", async () => {
    const w = await world();
    const pid = (await env.HUB_DB.prepare("SELECT id FROM project WHERE slug = 'site'").first<{ id: string }>())!.id;
    const shippedAt = 1791000000 * 1000 + 60_000;
    await env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, message, seen_at) VALUES ('D1', ?, ?, 'site-app', 'v1', ?, 'Fix two', ?)").bind(w.t.id, pid, B.slice(0, 8), shippedAt).run();
    await env.HUB_DB.prepare(`INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, title, last_message, count, first_seen, last_seen)
      VALUES ('G1', ?, ?, 'site-app', 'fp1', 'exception', 'TypeError: x', 'x', 3, ?, ?), ('G0', ?, ?, 'site-app', 'fp0', 'exception', 'Older', 'y', 1, 1, 1)`).bind(w.t.id, pid, shippedAt + 1000, shippedAt + 1000, w.t.id, pid).run();
    const r = await w.call(w.h, "repo.commit", { project: "site", oid: B });
    expect(r.result.after).toMatchObject({ shipped: { tag: B.slice(0, 8), script: "site-app" }, errors: [{ id: "G1", count: 3 }] });
    const page = await (await SELF.fetch(`https://${HOST}/site/code?c=${B}`, { headers: w.h })).text();
    expect(page).toContain("<h2>After this commit</h2>");
    expect(page).toContain("TypeError: x");
  });
});
