// Status from records, and the reviewer agent.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { setArdiForTest } from "../src/code/ardi";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential } from "../src/models/store";
import { parseFindings } from "../src/verbs/reviewAi";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const BASE = "a".repeat(40), HEAD = "b".repeat(40);
afterEach(() => { setArdiForTest(null); setModelFetchForTest(null); });

async function world() {
  const t = await seedTenant("acme");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const as = (h: { token: string }) => async (verb: string, body: unknown) => {
    const r = await apiPost(HOST, verb, body, cookieHeaders(h.token, HOST));
    return { status: r.status, ...((await r.json()) as { result: Record<string, unknown>; detail?: string }) };
  };
  return { t, p, ada, sam, ada_: as(ada), sam_: as(sam) };
}

describe("status from records", () => {
  it("reports what was filed, finished, under way (and stalled), committed, deployed and broken", async () => {
    const w = await world();
    await w.ada_("work.create", { project: "site", kind: "snag", title: "Old bug" });
    await w.ada_("work.create", { project: "site", kind: "wish", title: "Dark mode" });
    await w.ada_("work.update", { id: "site#1", state: "done" });
    await w.ada_("work.update", { id: "site#2", state: "doing", owner: "sam@example.com" });
    await env.HUB_DB.prepare("UPDATE work_item SET updated_at = ? WHERE number = 2").bind(Date.now() - 9 * 86_400_000).run();
    await env.HUB_DB.prepare("INSERT INTO code_event (tenant_id, project_id, ardi_id, kind, identity_id, session_id, ref, target, summary, at) VALUES (?, ?, 1, 'commit', ?, NULL, NULL, 'x', 'Fix the bug', ?)").bind(w.t.id, w.p.id, w.ada.identity.id, Date.now()).run();
    await env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, message, seen_at) VALUES ('D', ?, ?, 'site-app', 'v', 'abc1234', NULL, ?)").bind(w.t.id, w.p.id, Date.now()).run();
    const s = (await w.sam_("project.status", { project: "site" })).result as { filed: unknown[]; finished: Array<{ ref: string }>; doing: Array<{ ref: string; owner: string; stalled: boolean }>; commits: { count: number; by: Array<{ who: string }> }; deploys: unknown[] };
    expect(s.filed.length).toBe(2);
    expect(s.finished.map((f) => f.ref)).toEqual(["site#1"]);
    expect(s.doing).toEqual([{ ref: "site#2", title: "Dark mode", owner: "sam", stalled: true }]);
    expect(s.commits).toMatchObject({ count: 1, by: [{ who: "ada" }] });
    expect(s.deploys.length).toBe(1);
    const page = await (await SELF.fetch(`https://${HOST}/site/status`, { headers: cookieHeaders(w.sam.token, HOST) })).text();
    expect(page).toContain("Built from the record only");
    expect(page).toContain('<span class="pill">stalled</span>');
    expect((await w.sam_("project.status", { project: "site", since: "tomorrow" })).status).toBe(400);
  });
});

describe("the reviewer agent", () => {
  it("reads the diff and leaves comments as Pimwell reviewer, anchored only to files in the change", async () => {
    const w = await world();
    setArdiForTest({ fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const verb = new URL(String(input instanceof Request ? input.url : input)).pathname.split("/api/")[1];
      const b = JSON.parse(String(init?.body)) as Record<string, string>;
      const c = (oid: string, parents: string[]) => ({ oid, parents, summary: "Speed up", tree: "t", author_name: "Sam", author_email: "s@e", author_time: 1, committer_name: "Sam", committer_email: "s@e", commit_time: 1791000000, principal: null, session: null, trailer_principal: null, trailer_session: null });
      const ok = (result: unknown) => Response.json({ ok: true, result, next: null });
      if (verb === "log") return ok({ commits: b.ref === "refs/heads/main" ? [c(BASE, [])] : [c(HEAD, [BASE]), c(BASE, [])] });
      if (verb === "commit.show") return ok({ ...c(b.oid!, [BASE]), changes: [{ path: "p.ts", prev_path: null, prev_blob: "x", new_blob: "y", kind: "modify" }] });
      return ok({ content_b64: btoa(b.rev === BASE ? "let x = 1\n" : "let x = eval(input)\n"), size: 20 });
    } } as unknown as Fetcher);
    setModelFetchForTest(async (input) => {
      if (String(input).endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Unsafe eval.", comments: [
        { path: "p.ts", line: 1, severity: "must", comment: "Don't eval input; parse it." },
        { path: "not/in/diff.ts", line: 9, severity: "nit", comment: "Elsewhere" },
      ] }) }] }], usage: { input_tokens: 100, output_tokens: 40 } });
    });
    await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "hub", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
    await w.sam_("review.request", { project: "site", branch: "fast", reviewers: ["ada@example.com"] });
    const r = await w.ada_("review.ai", { id: "site!1" });
    expect(r.status, r.detail).toBe(200);
    expect(r.result).toMatchObject({ ref: "site!1", comments: 2 });
    const rows = (await env.HUB_DB.prepare("SELECT i.display_name AS who, c.path, c.line, c.body FROM review_comment c JOIN identity i ON i.id = c.author_id ORDER BY c.created_at").all()).results;
    expect(rows).toEqual([
      { who: "Pimwell reviewer", path: null, line: null, body: "Review by gpt-6.1-sol: Unsafe eval." },
      { who: "Pimwell reviewer", path: "p.ts", line: 1, body: "[must] Don't eval input; parse it." },
      { who: "Pimwell reviewer", path: null, line: null, body: "[nit] Elsewhere" },
    ]);
    expect((await env.HUB_DB.prepare("SELECT identity_id = ? AS mine, purpose FROM model_call").bind(w.ada.identity.id).first())).toEqual({ mine: 1, purpose: "code" });
  });

  it("parses whatever the model returns without trusting it", () => {
    expect(parseFindings("not json", new Set())).toEqual({ summary: "not json", comments: [] });
    expect(parseFindings('{"summary":"ok","comments":[{"comment":"x","severity":"critical","path":"a","line":-3}]}', new Set(["a"])).comments).toEqual([{ path: "a", line: null, severity: "should", comment: "x" }]);
  });
});
