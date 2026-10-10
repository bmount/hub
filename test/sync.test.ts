// Push sync from Ardi's timeline: quiet first pass, then links, events and an ops notice for new commits.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { setArdiForTest, type ArdiEvent } from "../src/code/ardi";
import { gitSyncCoverage, readGitSyncState } from "../src/code/syncState";
import { syncAll } from "../src/code/sync";
import { ensureProjectChannels } from "../src/chat/defaults";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

afterEach(() => setArdiForTest(null));

function timeline(events: ArdiEvent[], seen: Array<Record<string, unknown>>, failSince?: string) {
  setArdiForTest({
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ ...body, auth: new Headers(init?.headers).get("authorization") });
      if (failSince !== undefined && body.since === failSince) throw new Error("interrupted");
      const limit = Number(body.limit);
      const remaining = events.filter((e) => e.id > Number(body.since ?? 0));
      const got = body.since === undefined ? remaining.slice(-limit) : remaining.slice(0, limit);
      const next = (body.since === undefined || remaining.length > limit) && got.length ? String(got.at(-1)!.id) : null;
      return Response.json({ ok: true, result: { events: got }, next });
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
    const events = [ev(1, "Old work site#1")];
    timeline(events, seen);

    expect(await syncAll(env, Date.now())).toEqual({ repos: 1, events: 1 });
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_link").first<{ n: number }>())!.n).toBe(0);
    events.push(ev(2, "Fix the thing (site#1)"), ev(3, "Unrelated"));
    await syncAll(env, Date.now());
    expect(seen[3]).toMatchObject({ repo: "site", since: "1" });
    const links = (await env.HUB_DB.prepare("SELECT target_ref, created_by FROM work_link").all()).results;
    expect(links).toEqual([{ target_ref: `site@${"2".repeat(40)}`, created_by: ada.identity.id }]);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'work.commit'").first<{ n: number }>())!.n).toBe(1);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM code_event").first<{ n: number }>())!.n).toBe(3);
    await syncAll(env, Date.now());
    expect(seen[5]).toMatchObject({ since: "3" });

    // One sync agent per organization, a reader, with one sealed token; every run's session is revoked.
    const agent = await env.HUB_DB.prepare("SELECT i.email, m.role FROM identity i JOIN membership m ON m.identity_id = i.id WHERE i.display_name = 'Pimwell sync'").first();
    expect(agent).toEqual({ email: "acme.pimwell-sync@pimwell.test", role: "reader" });
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM ardi_cred WHERE kind = 'api_token'").first<{ n: number }>())!.n).toBe(1);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM session WHERE label = 'push sync' AND revoked_at IS NULL").first<{ n: number }>())!.n).toBe(0);
  });

  it("persists the historical cutoff across bounded runs and imports pushes arriving during backfill as live", async () => {
    const t = await seedTenant("acme");
    const repo = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await ensureProjectChannels(env.HUB_DB, { tenant_id: t.id, slug: "site", display_name: "Site" }, ada.identity.id, Date.now());
    await apiPost("acme.pimwell.test", "work.create", { project: "site", kind: "snag", title: "Broken" }, cookieHeaders(ada.token, "acme.pimwell.test"));
    const event = (id: number): ArdiEvent => ({ id, kind: "commit", principal: ada.identity.id, session: null, ref: null, target: id.toString(16).padStart(40, "0"), summary: "Fix site#1", time: 1791000000 + id });
    const events = Array.from({ length: 450 }, (_, i) => event(i + 1));
    const seen: Array<Record<string, unknown>> = [];
    timeline(events, seen);
    const now = Date.now();
    const checkpoint = async () => (await env.HUB_DB.prepare("SELECT cursor, last_run_at, last_error FROM code_sync WHERE project_id = ?").bind(repo.id).first<{ cursor: string; last_run_at: number; last_error: string | null }>())!;
    const count = async (table: string) => (await env.HUB_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    const notices = async () => (await apiPost("acme.pimwell.test", "chat.read", { c: "site-ops" }, cookieHeaders(ada.token, "acme.pimwell.test"))).json() as Promise<{ result: { messages: unknown[] } }>;

    expect(await syncAll(env, now)).toEqual({ repos: 1, events: 300 });
    expect(seen.map((s) => s.since)).toEqual([undefined, "0", "100", "200"]);
    expect(readGitSyncState((await checkpoint()).cursor)).toMatchObject({ after: 300, cutoff: 450, phase: "backfill" });
    expect(gitSyncCoverage(await checkpoint())).toMatchObject({ pending_id_span: 150, lag_ms: 150000, observed_at: now, caught_up_at: null });
    expect(await count("work_link")).toBe(0);
    expect((await notices()).result.messages).toHaveLength(0);

    events.push(event(451), event(452));
    expect(await syncAll(env, now + 300000)).toEqual({ repos: 1, events: 152 });
    expect(seen.slice(4).map((s) => s.since)).toEqual([undefined, "300", "400"]);
    expect(readGitSyncState((await checkpoint()).cursor)).toMatchObject({ after: 452, cutoff: 450, phase: "live", caught_up_at: now + 300000 });
    expect(gitSyncCoverage(await checkpoint())).toMatchObject({ pending_id_span: 0, lag_ms: 0 });
    expect(await count("code_event")).toBe(452);
    expect(await count("work_link")).toBe(2);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'work.commit'").first<{ n: number }>())!.n).toBe(2);
    expect((await notices()).result.messages).toHaveLength(1);
    await syncAll(env, now + 600000);
    expect(await count("work_link")).toBe(2);
    expect((await notices()).result.messages).toHaveLength(1);
    const status = await (await apiPost("acme.pimwell.test", "project.status", { project: "site" }, cookieHeaders(ada.token, "acme.pimwell.test"))).json() as { result: { coverage: { git_sync: unknown } } };
    expect(status.result.coverage.git_sync).toMatchObject({ phase: "live", cursor: 452, initial_cutoff: 450, lag_ms: 0 });
  });

  it("retains the cutoff after a page failure and quietly repairs a legacy newest-page checkpoint", async () => {
    const t = await seedTenant("acme");
    const repo = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await apiPost("acme.pimwell.test", "work.create", { project: "site", kind: "snag", title: "Broken" }, cookieHeaders(ada.token, "acme.pimwell.test"));
    await env.HUB_DB.prepare("INSERT INTO code_sync (tenant_id, project_id, cursor) VALUES (?, ?, '150')").bind(t.id, repo.id).run();
    const events: ArdiEvent[] = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, kind: "commit", principal: ada.identity.id, session: null, ref: null, target: (i + 1).toString(16).padStart(40, "0"), summary: "Fix site#1", time: 1791000000 + i }));
    const seen: Array<Record<string, unknown>> = [];
    timeline(events, seen, "100");
    expect(await syncAll(env, Date.now())).toEqual({ repos: 1, events: 100 });
    const row = (await env.HUB_DB.prepare("SELECT cursor, last_run_at, last_error FROM code_sync WHERE project_id = ?").bind(repo.id).first<{ cursor: string; last_run_at: number; last_error: string | null }>())!;
    expect(readGitSyncState(row.cursor)).toMatchObject({ after: 100, cutoff: 150, phase: "backfill" });
    expect(row.last_error).toContain("did not answer");
    expect(gitSyncCoverage(row)).toMatchObject({ pending_id_span: 50, lag_ms: 50000, caught_up_at: null });
    // New commits can have old commit times; the upstream event ID defines the initial boundary.
    events.push({ ...events[0]!, id: 151, target: "f".repeat(40) });
    timeline(events, seen);
    expect(await syncAll(env, Date.now())).toEqual({ repos: 1, events: 51 });
    expect(seen.at(-1)).toMatchObject({ since: "100" });
    const saved = (await env.HUB_DB.prepare("SELECT cursor, last_error FROM code_sync WHERE project_id = ?").bind(repo.id).first<{ cursor: string; last_error: string | null }>())!;
    expect(readGitSyncState(saved.cursor)).toMatchObject({ after: 151, cutoff: 150, phase: "live" });
    expect(saved.last_error).toBeNull();
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM code_event").first<{ n: number }>())!.n).toBe(151);
    expect((await env.HUB_DB.prepare("SELECT target_ref FROM work_link").all()).results).toEqual([{ target_ref: `site@${"f".repeat(40)}` }]);
  });

  it("records an exhausted empty repository and then discovers its first push", async () => {
    const t = await seedTenant("acme");
    await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const events: ArdiEvent[] = [];
    const seen: Array<Record<string, unknown>> = [];
    timeline(events, seen);
    const now = Date.now();
    expect(await syncAll(env, now)).toEqual({ repos: 1, events: 0 });
    expect(readGitSyncState((await env.HUB_DB.prepare("SELECT cursor FROM code_sync").first<{ cursor: string }>())!.cursor)).toMatchObject({ after: 0, cutoff: 0, phase: "live", caught_up_at: now });
    events.push({ id: 1, kind: "ref", principal: null, session: null, ref: "refs/heads/main", target: "a".repeat(40), summary: "push", time: Math.floor(now / 1000) });
    expect(await syncAll(env, now + 300000)).toEqual({ repos: 1, events: 1 });
    expect(seen.at(-1)).toMatchObject({ since: "0" });
  });

  it("reports unknown lag for absent, legacy and malformed checkpoints", () => {
    for (const cursor of [null, "100", "{bad", '{"version":1,"after":-1}']) {
      expect(readGitSyncState(cursor)).toBeNull();
      expect(gitSyncCoverage({ cursor, last_run_at: null, last_error: null })).toMatchObject({ phase: "unknown", lag_ms: null, pending_id_span: null });
    }
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
