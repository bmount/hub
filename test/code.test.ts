// Code views over Ardi, against a stand-in git host: the shapes are the deployed Ardi's (probed 2026-10-07).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { setArdiForTest } from "../src/code/ardi";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

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
      if (verb === "refs.list") return ok({ refs: [{ name: "refs/heads/main", target: B }, { name: "refs/heads/topic", target: C }] });
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
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const bot = await seedAgent(t, pat.identity, "scout");
  const seen: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = [];
  fakeArdi(seen, pat.identity.id);
  const call = async (h: Record<string, string>, verb: string, body: unknown) => {
    const r = await apiPost(HOST, verb, body, h);
    return { status: r.status, ...((await r.json()) as { result: Record<string, unknown>; detail?: string }) };
  };
  return { t, pat, bot, seen, call, h: cookieHeaders(pat.token, HOST) };
}

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

  it("says plainly when the git host can't be reached", async () => {
    const w = await world();
    setArdiForTest({ fetch: async () => { throw new Error("down"); } } as unknown as Fetcher);
    expect((await w.call(w.h, "repo.branches", { project: "site" })).status).toBe(503);
    expect(await (await SELF.fetch(`https://${HOST}/site/code`, { headers: w.h })).text()).toContain("the git host did not answer");
  });
});
