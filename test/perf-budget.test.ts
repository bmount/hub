// Performance budget (overnight plan 2, N4): every signed-in page stays within a fixed number of D1 round trips.
// A batch is one round trip. If a page needs more, read in one batch, or record a ruling and raise its budget here.
import { timedEnv, withTrace, newTrace, span, traceFields, writeTrace, deferredTrace, meteredD1, hasSpan } from "../src/perf";
import worker, { app } from "../src/index";
import gitWorker from "../git-proxy/index";
import { Conversation } from "../src/chat/conversationDO";
import { Inbox } from "../src/chat/inboxDO";
import { listVerbs } from "../src/verbs/table";
import type { Ctx } from "../src/auth/context";
import type { Env } from "../src/env";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
export const TRIP_BUDGET = 4;

function trips(header: string | null): { trips: number; statements: number } {
  const m = /db;desc="(\d+) round trips, (\d+) statements"/.exec(header ?? "");
  if (!m) throw new Error(`no db timing in ${header}`);
  return { trips: Number(m[1]), statements: Number(m[2]) };
}

describe("performance budget", () => {
  it("every signed-in page stays within the round-trip budget", async () => {
    const t = await seedTenant("acme");

    await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await seedAgent(t, pat.identity, "scout");
    const h = cookieHeaders(pat.token, HOST);
    for (let i = 0; i < 5; i++) await apiPost(HOST, "work.create", { project: "site", kind: "bug", title: `Snag ${i}` }, h);
    const report: string[] = [];
    for (const path of ["/", "/docket", "/site", "/site/docket", "/site/w/1", "/people", "/mail", "/c", "/playground", "/archive", "/skills", "/new", "/jump?q=snag", "/planned", "/planned/review?v=review.integrate", "/site/w/1?kind=bug&owner=me", "/docket?owner=me"]) {
      const res = await SELF.fetch(`https://${HOST}${path}`, { headers: h });
      expect(res.status, path).toBe(200);
      const t2 = trips(res.headers.get("server-timing"));
      report.push(`${path}: ${t2.trips} trips, ${t2.statements} statements`);
      expect(t2.trips, `${path} uses ${t2.trips} D1 round trips`).toBeLessThanOrEqual(TRIP_BUDGET);
    }
    await apiPost(HOST, "chat.open", { kind: "direct", members: ["scout"], client_id: "perf-private" }, h);
    const privateRail = await SELF.fetch(`https://${HOST}/c`, { headers: h });
    expect(privateRail.status).toBe(200);
    expect(trips(privateRail.headers.get("server-timing")).trips).toBeLessThanOrEqual(TRIP_BUDGET);
    expect(await privateRail.text()).toContain("@pat, @scout (direct)");
    console.log(report.join("\n"));
  });
});

type Point = NonNullable<Parameters<AnalyticsEngineDataset["writeDataPoint"]>[0]>;
function collector() {
  const points: Point[] = [], pending: Promise<unknown>[] = [];
  const measured = { ...env, PERF: { writeDataPoint: (point: Point) => points.push(point) } as unknown as AnalyticsEngineDataset };
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { points, measured, ctx, flush };
}
describe("request tracing guardrails", () => {
  it("every registered verb, page route and public Durable Object method emits a span", async () => {
    const routes = app.routes.filter(r => !["*", "/*"].includes(r.path));
    expect(routes.length).toBeGreaterThan(100);
    for (const route of routes) expect(hasSpan(route.handler), route.path).toBe(true);
    for (const verb of listVerbs()) {
      expect(hasSpan(verb.run), verb.name).toBe(true);
      const trace = newTrace();
      await withTrace(trace, async () => { try { await verb.run({} as Ctx, undefined); } catch { /* deliberately no authority/bindings */ } });
      expect(trace.spans.map(s => s.name), verb.name).toContain("verb." + verb.name);
    }
    for (const klass of [Conversation, Inbox]) for (const method of Object.getOwnPropertyNames(klass.prototype)) {
      if (method === "constructor") continue;
      const fn = Object.getOwnPropertyDescriptor(klass.prototype, method)!.value;
      if (typeof fn !== "function") continue;
      expect(hasSpan(fn), klass.name + "." + method).toBe(true);
      const trace = newTrace();
      await withTrace(trace, async () => { try { await Reflect.apply(fn, {}, []); } catch { /* no private state: must stop before I/O */ } });
      expect(trace.spans.map(s => s.name)).toContain("do.handler." + klass.name + "." + method);
    }
    const c = collector();
    await worker.scheduled({} as ScheduledController, c.measured, c.ctx);
    await gitWorker.scheduled({} as ScheduledController, { ...c.measured, HUB: {} as Fetcher, ARTIFACTS_API_TOKEN: "synthetic", ARTIFACTS_ACCOUNT_ID: "a".repeat(32) }, c.ctx);
    await c.flush();
    const roots = c.points.filter(p => p.blobs?.[6] === "request").map(p => p.blobs?.[7]);
    expect(roots).toContain("scheduled");
    expect(roots).toContain("scheduled.git.cleanup");
  });

  it("writes page, API, MCP, git and chat request metadata without any content or credentials", async () => {
    const tenant = await seedTenant("acme");
    const human = await seedHuman("private-address@example.test", { memberships: [{ tenant_id: tenant.id, role: "admin" }] });
    const agent = await seedAgent(tenant, human.identity);
    const c = collector();
    const requests = [
      new Request("https://" + HOST + "/private-project-name?q=private-search", { headers: cookieHeaders(human.token, HOST) }),
      new Request("https://" + HOST + "/api/whoami", { method: "POST", headers: { ...cookieHeaders(human.token, HOST), "content-type": "application/json" }, body: "{}" }),
      new Request("https://" + HOST + "/agent/mcp", { method: "POST", headers: { authorization: "Bearer " + agent.longLived, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }) }),
      new Request("https://" + HOST + "/private-repository.git/info/refs?service=git-upload-pack"),
      new Request("https://" + HOST + "/chat/v1/getChats", { headers: cookieHeaders(human.token, HOST) }),
    ];
    for (const request of requests) {
      const response = await app.fetch(request, c.measured, c.ctx);
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers.get("server-timing")).toContain("span0");
      await response.text(); await c.flush();
    }
    const roots = c.points.filter(p => p.blobs?.[6] === "request");
    expect(roots).toHaveLength(5);
    expect(roots.map(p => p.blobs?.[7])).toEqual(["/:project", "/api/*", "/agent/mcp", "/:repo.git/*", "/chat/v1/*"]);
    expect(roots[1]!.blobs?.[11]).toBe("whoami");
    expect(roots[2]!.blobs?.[12]).toBe("whoami");
    expect(roots[2]!.blobs?.[10]).toBe("agent");
    for (const point of c.points) expect(point.blobs?.[4]).toMatch(/^[0-9a-f]{32}$/);
    const serialized = JSON.stringify(c.points);
    for (const secret of [human.token, agent.longLived, tenant.id, human.identity.email, "private-project-name", "private-search", "private-repository"]) expect(serialized).not.toContain(secret);
  });

  it("isolates overlapping traces, preserves failures and folds excess spans into other", async () => {
    const a = newTrace(), b = newTrace();
    await Promise.all([a,b].map((trace,i) => withTrace(trace, () => span("outer", async () => {
      await Promise.resolve();
      span("inner" + i, () => 1);
      try { await span("failure", async () => { throw new Error("private exception"); }); } catch {}
    }))));
    for (const [i,trace] of [a,b].entries()) {
      expect(trace.spans.map(s => s.name)).toEqual(["outer", "inner"+i, "failure"]);
      expect(trace.spans[1]!.parent).toBe(trace.spans[0]!.id);
      expect(trace.spans[2]!.failed).toBe(true);
    }
    await withTrace(a, async () => {
      traceFields({ tenant: "tenant-private", route: "/:project/w/:number" });
      for (let i = 0; i < 500; i++) span("bounded", () => 1);
    });
    const c = collector(); await writeTrace(c.measured, a);
    expect(c.points).toHaveLength(201);
    expect(c.points.at(-1)!.blobs?.[6]).toBe("other");
    expect(c.points.at(-1)!.doubles?.[10]).toBe(304);
    expect(JSON.stringify(c.points)).not.toContain("tenant-private");
    expect(newTrace().cold).toBe(false);
  });

  it("captures D1 meta, row counts, call sites and one-trip batches, preserving first/raw", async () => {
    const trace = newTrace(), meter = { trips: 0, statements: 0, ms: 0 };
    await withTrace(trace, async () => {
      const db = meteredD1(env.HUB_DB, meter);
      function firstSite(sql: string) { return db.prepare(sql); }
      function secondSite(sql: string) { return db.prepare(sql); }
      expect(await firstSite("SELECT 7 AS n").first("n")).toBe(7);
      expect(await firstSite("SELECT 9 AS n").first("n")).toBe(9);
      expect(await secondSite("SELECT 7 AS n").first("n")).toBe(7);
      const rows = await db.batch([db.prepare("SELECT 2 AS n"), db.prepare("SELECT 3 AS n")]);
      expect(rows.map(r => r.results[0])).toEqual([{ n: 2 }, { n: 3 }]);
      expect(await db.prepare("SELECT 4 AS n").raw()).toEqual([[4]]);
    });
    expect(meter.trips).toBe(5); expect(meter.statements).toBe(6);
    const statements = trace.spans.filter(s => s.name === "d1.first");
    expect(statements[0]!.fingerprint).toBe(statements[1]!.fingerprint);
    expect(statements[0]!.fingerprint).not.toBe(statements[2]!.fingerprint);
    for (const s of statements) {
      expect(s.execution).toBeGreaterThanOrEqual(0);
      expect(s.read).toBeGreaterThanOrEqual(0);
      expect(s.written).toBeGreaterThanOrEqual(0);
    }
    expect(trace.spans.filter(s => s.name === "d1.batch")).toHaveLength(1);
    expect(trace.spans.filter(s => s.name === "d1.statement")).toHaveLength(2);
  });

  it("snapshots stalled spans without delaying telemetry and ignores public trace-envelope spoofing", async () => {
    const trace = newTrace(), c = collector();
    await withTrace(trace, async () => { void span("stalled", () => new Promise(() => {})); });
    trace.ended = performance.now();
    await deferredTrace(c.measured, trace);
    const point = c.points.find(p => p.blobs?.[14 - 1] === "stalled")!;
    expect(point.doubles?.[13]).toBe(0);
    expect(point.doubles?.[0]).toBeGreaterThanOrEqual(0);
    const spoofed = "11111111-1111-4111-8111-111111111111";
    const response = await app.fetch(new Request("https://" + HOST + "/healthz", { headers: { "x-pimwell-perf": JSON.stringify({
      __pimwell_perf: 1, request: spoofed, parent: 0, tenant: "private-spoof", method: "GET", route: "/private-spoof", auth: "cookie", colo: "XXX"
    }) } }), c.measured, c.ctx);
    await c.flush();
    expect(response.headers.get("x-request-id")).not.toBe(spoofed);
    expect(JSON.stringify(c.points)).not.toContain("private-spoof");
  });

  it("native RPC stubs and storage handlers remain callable under async-local timing", async () => {
    const tenant = await seedTenant("acme"), trace = newTrace();
    await withTrace(trace, async () => {
      const e = timedEnv(env);
      expect(await e.INBOX.get(e.INBOX.idFromName(tenant.id + ":probe")).head(tenant.id, "probe")).toBe(0);
    });
    expect(trace.spans.map(s => s.name)).toContain("do.stub.INBOX.head");
  });
});
