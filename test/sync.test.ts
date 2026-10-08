// Push sync from Ardi's timeline: quiet first pass, then links, events and an ops notice for new commits.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { setArdiForTest } from "../src/code/ardi";
import { syncAll } from "../src/code/sync";
import { ensureProjectChannels } from "../src/chat/defaults";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

afterEach(() => setArdiForTest(null));

function timeline(pages: Array<{ events: unknown[]; next: string }>, seen: Array<Record<string, unknown>>) {
  let n = 0;
  setArdiForTest({
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ ...body, auth: new Headers(init?.headers).get("authorization") });
      const p = pages[Math.min(n++, pages.length - 1)]!;
      return Response.json({ ok: true, result: { events: p.events }, next: p.next });
    },
  } as unknown as Fetcher);
}

describe("push sync", () => {
  it("takes history quietly, then links commits that mention work and says so in #<project>-ops", async () => {
    const t = await seedTenant("acme");
    await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await ensureProjectChannels(env.HUB_DB, { tenant_id: t.id, slug: "site", display_name: "Site" }, ada.identity.id, Date.now());
    await apiPost("acme.pimwell.test", "work.create", { project: "site", kind: "snag", title: "Broken" }, cookieHeaders(ada.token, "acme.pimwell.test"));
    const seen: Array<Record<string, unknown>> = [];
    const ev = (id: number, summary: string) => ({ id, kind: "commit", principal: ada.identity.id, session: "S", ref: null, target: String(id).repeat(40).slice(0, 40), summary, time: 1791000000 + id });
    timeline([{ events: [ev(1, "Old work site#1")], next: "1" }, { events: [ev(2, "Fix the thing (site#1)"), ev(3, "Unrelated")], next: "3" }, { events: [], next: "3" }], seen);

    expect(await syncAll(env, Date.now())).toEqual({ repos: 1, events: 1 });
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_link").first<{ n: number }>())!.n).toBe(0);
    await syncAll(env, Date.now());
    expect(seen[1]).toMatchObject({ repo: "site", since: "1" });
    const links = (await env.HUB_DB.prepare("SELECT target_ref, created_by FROM work_link").all()).results;
    expect(links).toEqual([{ target_ref: `site@${"2".repeat(40)}`, created_by: ada.identity.id }]);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'work.commit'").first<{ n: number }>())!.n).toBe(1);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM code_event").first<{ n: number }>())!.n).toBe(3);
    await syncAll(env, Date.now());
    expect(seen[2]).toMatchObject({ since: "3" });

    // One sync agent per organization, a reader, with one sealed token; every run's session is revoked.
    const agent = await env.HUB_DB.prepare("SELECT i.email, m.role FROM identity i JOIN membership m ON m.identity_id = i.id WHERE i.display_name = 'Pimwell sync'").first();
    expect(agent).toEqual({ email: "acme.pimwell-sync@pimwell.test", role: "reader" });
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM ardi_cred WHERE kind = 'api_token'").first<{ n: number }>())!.n).toBe(1);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM session WHERE label = 'push sync' AND revoked_at IS NULL").first<{ n: number }>())!.n).toBe(0);
  });

  it("records a failure and keeps going", async () => {
    const t = await seedTenant("acme");
    await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    setArdiForTest({ fetch: async () => { throw new Error("down"); } } as unknown as Fetcher);
    await syncAll(env, Date.now());
    expect((await env.HUB_DB.prepare("SELECT last_error FROM code_sync").first<{ last_error: string }>())!.last_error).toContain("did not answer");
  });
});
