// Reviews: request a branch review, comment, give verdicts tied to the commit reviewed; reviewers hear about it.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { setArdiForTest } from "../src/code/ardi";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const BASE = "a".repeat(40), HEAD = "b".repeat(40);
afterEach(() => setArdiForTest(null));

function ardi() {
  const commit = (oid: string, parents: string[], summary: string) => ({ oid, parents, summary, tree: "t", author_name: "Sam", author_email: "s@example.com", author_time: 1, committer_name: "Sam", committer_email: "s@example.com", commit_time: 1791000000, principal: null, session: null, trailer_principal: null, trailer_session: null });
  setArdiForTest({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const verb = new URL(String(input instanceof Request ? input.url : input)).pathname.split("/api/")[1];
      const b = JSON.parse(String(init?.body)) as Record<string, string>;
      const ok = (result: unknown) => Response.json({ ok: true, result, next: null });
      if (verb === "log") return ok({ commits: b.ref === "refs/heads/main" ? [commit(BASE, [], "Base")] : [commit(HEAD, [BASE], "Faster prices"), commit(BASE, [], "Base")] });
      if (verb === "commit.show") return ok({ ...commit(b.oid!, [BASE], "Faster prices"), changes: [{ path: "p.ts", prev_path: null, prev_blob: "x", new_blob: "y", kind: "modify" }] });
      if (verb === "file.show") return ok({ content_b64: btoa(b.rev === BASE ? "slow\n" : "fast\n"), size: 5 });
      return Response.json({ ok: false, error: "nope" }, { status: 404 });
    },
  } as unknown as Fetcher);
}

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  ardi();
  const as = (h: { token: string }) => async (verb: string, body: unknown) => {
    const r = await apiPost(HOST, verb, body, cookieHeaders(h.token, HOST));
    return { status: r.status, ...((await r.json()) as { result: Record<string, unknown>; detail?: string }) };
  };
  return { sam, pat, sam_: as(sam), pat_: as(pat) };
}

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
