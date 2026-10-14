// Performance budget (overnight plan 2, N4): every signed-in page stays within a fixed number of D1 round trips.
// A batch is one round trip. If a page needs more, read in one batch, or record a ruling and raise its budget here.
import { situationReport } from "../src/http/situationPage";
import { checkPerformance, runPerformanceChecks, type CheckTarget } from "../src/perf/checks";
import { BUDGETS } from "../src/perf/budgets";
import { timedEnv, withTrace, newTrace, span, traceFields, writeTrace, writeClientPoints, deferredTrace, meteredD1, hasSpan, exclusiveDuration, attributedDurations, applicationSource, type TimingSpan } from "../src/perf";
import worker, { app } from "../src/index";
import gitWorker from "../git-proxy/index";
import { Conversation } from "../src/chat/conversationDO";
import { Inbox } from "../src/chat/inboxDO";
import { listVerbs } from "../src/verbs/table";
import type { Ctx } from "../src/auth/context";
import type { Env } from "../src/env";
import { SQL_CATALOG } from "../src/perfCatalog";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import puppeteer from "@cloudflare/puppeteer";
import * as ardi from "../src/code/ardi";
import { runSynthetic, gitLsRemote, recordSynthetic, syntheticMarker, SYNTHETIC_TENANT, SYNTHETIC_MEMBER, SYNTHETIC_JOURNEYS } from "../src/synthetic";
import { listMembers } from "../src/db/memberships";
import { sha256Hex } from "../src/ids";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
export const TRIP_BUDGET = 4;

function trips(header: string | null): { trips: number; statements: number } {
  const m = /db;desc="(\d+) round trips, (\d+) statements"/.exec(header ?? "");
  if (!m) throw new Error(`no db timing in ${header}`);
  return { trips: Number(m[1]), statements: Number(m[2]) };
}

describe("latency budget situations", () => {
  it("renders code-generated deploy/commit links without accepting arbitrary HTML or URLs", () => {
    const id = '01M4WQRWTK8D6R5NXC3RGVC1Y7', commit = 'a'.repeat(40);
    const html = situationReport(`[${id}](/apps?d=${id})\n[${commit}](/pimwell/code?c=${commit})\n[x](javascript:alert(1))\n<img src=x onerror=alert(1)>`);
    expect(html).toContain(`<a href="/apps?d=${id}">${id}</a>`);
    expect(html).toContain(`<a href="/pimwell/code?c=${commit}">${commit}</a>`);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
  });
  async function fixture() {
    const tenant = await seedTenant("acme");
    const project = await createProject(env.HUB_DB, {tenant_id:tenant.id,namespace_id:null,slug:"latency",kind:"repo",display_name:"Latency"},Date.now());
    const now = Date.now(), version = "11111111-1111-4111-8111-111111111111", oldVersion = "22222222-2222-4222-8222-222222222222", commit = "a".repeat(40);
    await env.HUB_DB.prepare("INSERT INTO site (id,tenant_id,project_id,name,hostnames,created_at) VALUES ('latency-site',?,?, 'pimwell.com','[]',?)").bind(tenant.id,project.id,now).run();
    for (const [id,v,at] of [["new-deploy",version,now-1_800_000],["old-deploy",oldVersion,now-5_400_000]] as const) await env.HUB_DB.prepare("INSERT INTO app_deploy (id,tenant_id,project_id,script_name,version_id,tag,message,seen_at) VALUES (?,?,?,'pimwell-hub',?,?,?,?)").bind(id,tenant.id,project.id,v+":"+v,commit,JSON.stringify({release:1,environment:"production"}),at).run();
    const target:CheckTarget = {site_id:"latency-site",tenant_id:tenant.id,project_id:project.id,project:"latency",name:"pimwell.com",script_name:"pimwell-hub"};
    return {target,now,current:{id:"new-deploy",version,commit,seen_at:now-1_800_000},previous:{id:"old-deploy",version:oldVersion,commit,seen_at:now-5_400_000}};
  }
  it("synthetic points create a breach and threshold regression linked to deploy, commit, route and growing span; recovery resolves, unknown does not", async () => {
    const f = await fixture();
    let p95 = 500, samples = 200, empty = false;
    const queries:string[] = [];
    const query = async (sql:string) => {
      queries.push(sql);
      if (sql.includes("AS span")) return [{span:"d1.batch",version:f.current.version,p95:300,samples:200},{span:"d1.batch",version:f.previous.version,p95:100,samples:200},{span:"fetch",version:f.current.version,p95:120,samples:200},{span:"fetch",version:f.previous.version,p95:110,samples:200}];
      if (!sql.includes("blob11 = 'cookie'") || empty) return [];
      // Exactly +25% qualifies, not just >25%.
      const points = Array.from({length:samples},()=>({duration:sql.includes(f.current.version)?p95:400,weight:1}));
      return [{route:"/docket",p95:points[0]!.duration,samples:points.length}];
    };
    await checkPerformance(env,f.target,f.current,f.previous,f.now,query);
    await checkPerformance(env,f.target,f.current,f.previous,f.now+1,query);
    const alerts = (await env.HUB_DB.prepare("SELECT * FROM perf_alert ORDER BY kind").all()).results;
    expect(alerts).toHaveLength(2);
    expect(alerts.map(a=>a.kind)).toEqual(["budget","regression"]);
    for (const alert of alerts) expect(alert).toMatchObject({deploy_id:f.current.id,commit_oid:f.current.commit,route:"/docket",span:"d1.batch"});
    const situations = (await env.HUB_DB.prepare("SELECT * FROM situation WHERE tenant_id = ?").bind(f.target.tenant_id).all()).results;
    expect(situations).toHaveLength(2);
    expect(situations[0]!.report).toContain(`/apps?d=${f.current.id}`);
    expect(situations[0]!.report).toContain(`/latency/code?c=${f.current.commit}`);
    expect(queries.every(q=>q.includes("blob1 = 'pimwell.com'") && q.includes("blob2 = 'pimwell-hub'"))).toBe(true);
    expect(queries.some(q=>q.includes("COUNT() AS samples"))).toBe(true);
    empty = true;
    await checkPerformance(env,f.target,f.current,f.previous,f.now+2,query);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM situation WHERE outcome IS NOT NULL").first("n")).toBe(0);
    empty = false; samples = 199; p95 = 200;
    await checkPerformance(env,f.target,f.current,f.previous,f.now+3,query);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM situation WHERE outcome IS NOT NULL").first("n")).toBe(1);
    samples = 200;
    await checkPerformance(env,f.target,f.current,f.previous,f.now+4,query);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM situation WHERE outcome IS NOT NULL").first("n")).toBe(2);
    p95 = 500;
    await checkPerformance(env,f.target,f.current,f.previous,f.now+5,query);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM situation").first("n")).toBe(4);
    expect(await env.HUB_DB.prepare("SELECT met FROM perf_budget_check").first("met")).toBe(0);
    expect(BUDGETS.map(b=>b.ms)).toEqual([300,500,800,1000,400,1000]);
  });
  it("does not call analytics before 30 minutes or within an hour of a successful check", async () => {
    const f = await fixture();
    await env.HUB_DB.prepare("INSERT INTO app_source (id,tenant_id,project_id,script_name,state,created_at) VALUES ('latency-app',?,?, 'pimwell-hub','active',?)").bind(f.target.tenant_id,f.target.project_id,f.now).run();
    await env.HUB_DB.prepare("INSERT INTO site_app (site_id,app_id) VALUES ('latency-site','latency-app')").run();
    await runPerformanceChecks(env,f.now-1);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM perf_budget_check").first("n")).toBe(0);
    await env.HUB_DB.prepare("INSERT INTO perf_budget_check VALUES ('latency-site','pimwell-hub','new-deploy',?,0,0)").bind(f.now).run();
    await runPerformanceChecks(env,f.now+3_599_999);
  });
});

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
  it("skips perf instrumentation when resolving the first application frame", async () => {
    const stack='Error\n    at meteredD1 (src/perf.ts:210:5)\n    at get (src/perf.ts:203:5)\n    at buildContext (index.js:800:9)\n    at appsPage (index.js:900:9)';
    expect(applicationSource(stack)).toMatchObject({file:'src/auth/context.ts',fn:'buildContext'});
    expect(applicationSource('Error\n    at meteredD1 (index.js:200:5)\n    at uncataloguedFrame240 (index.js:300:5)')).toBeUndefined();
    const trace=newTrace();
    await withTrace(trace,()=>span('auth.buildContext',()=>span('d1.batch',()=>1)));
    expect(trace.spans[1]!.source).toMatchObject({file:'src/auth/context.ts'});
    expect(trace.spans[1]!.source?.file).not.toBe('src/perf.ts');
  });
  it("exports source-defined locations and non-overlapping v2 timing, ignoring batch detail overlap", async () => {
    const make = (id:number,parent:number,started:number,ms:number,name="step"): TimingSpan => ({id,parent,started,ms,name,failed:false,finished:true});
    const root=make(0,0,10,100), a=make(1,0,20,40), b=make(2,0,40,40), detail=make(3,1,20,40,"d1.statement");
    expect(exclusiveDuration(root,[a,b,detail],110)).toBe(40);
    expect(exclusiveDuration(a,[a,b,detail],110)).toBe(40);
    const concurrent=Object.assign(newTrace(),{started:10,ended:110,parent:0,spans:[a,b,detail]});
    const attributed=attributedDurations(concurrent,110);
    expect(attributed.get(0)).toBe(40);expect(attributed.get(1)).toBe(30);expect(attributed.get(2)).toBe(30);expect(attributed.has(3)).toBe(false);
    expect([...attributed.values()].reduce((n,v)=>n+v,0)).toBe(100);
    concurrent.spans.push(make(4,1,30,20));
    const nested=attributedDurations(concurrent,110);
    expect(nested.get(1)).toBe(15);expect(nested.get(4)).toBe(15);
    expect([...nested.values()].reduce((n,v)=>n+v,0)).toBe(100);
    const trace=newTrace(), c=collector();
    await withTrace(trace, () => span("auth.buildContext", () => 1));
    trace.ended=performance.now(); await writeTrace(c.measured,trace);
    const point=c.points.find(p=>p.blobs?.[13]==="auth.buildContext")!;
    expect(JSON.parse(point.blobs![18] as string)).toMatchObject({file:"src/auth/context.ts"});
    expect(point.doubles![14]).toBeGreaterThanOrEqual(0);
    expect(point.doubles![15]).toBeGreaterThanOrEqual(trace.at);
    expect(point.doubles![16]).toBeGreaterThanOrEqual(0);
    expect(point.doubles![19]).toBe(2);
  });
  it("separates rare roots and browser phases from request-scoped trace detail", async () => {
    const c = collector(), a = newTrace(), b = newTrace();
    const measured = { ...c.measured, WORKER_VERSION: { id: "same-version", tag: "", timestamp: "" } };
    for (const trace of [a, b]) {
      await withTrace(trace, () => { for (let i = 0; i < 500; i++) span("bounded", () => 1); });
      await writeTrace(measured, trace);
    }
    const rpc = { ...a, kind: "rpc" as const, parent: 123 };
    await writeTrace(measured, rpc, "pimwell-git");
    await writeClientPoints(measured, "", "", [
      { request: a.id, path: "/apps", previous: "/", phase: "fetch", name: "list.select", duration: 10 },
      { request: a.id, path: "/apps", previous: "/", phase: "spinner", name: "list.select", duration: 10 },
      { request: "", path: "/apps", previous: "/", phase: "spinner", name: "list.select", duration: 10 },
      { request: "", path: "/apps", previous: "/", phase: "spinner", name: "list.select", duration: 10 },
    ]);
    const keys = (kind: string, request: string) => c.points.filter(p => p.blobs?.[6] === kind && p.blobs?.[5] === request).map(p => p.indexes?.[0]);
    expect(keys("request", a.id)).toEqual(["request:" + a.id]);
    expect(keys("request", b.id)).toEqual(["request:" + b.id]);
    expect(keys("rpc", a.id)).toEqual(["rpc:" + a.id]);
    expect(new Set([...keys("span", a.id), ...keys("other", a.id)])).toEqual(new Set(["trace:" + a.id]));
    expect(new Set(keys("span", b.id))).toEqual(new Set(["trace:" + b.id]));
    expect(keys("client", a.id)).toEqual(["client:fetch:" + a.id, "client:spinner:" + a.id]);
    const unjoined = keys("client", "");
    expect(unjoined).toHaveLength(2);
    expect(unjoined[0]).toMatch(/^client:spinner:[0-9a-f-]{36}$/);
    expect(unjoined[0]).not.toBe(unjoined[1]);
    for (const p of c.points) expect(p.blobs?.[2]).toBe("same-version");
  });

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

  it("resolves identical SQL at distinct annotated code sites without exporting runtime SQL or values", async () => {
    const entries=Object.entries(SQL_CATALOG).filter(([key,value])=>key.startsWith("site-")&&!value.template);
    const first=entries.find(([,value])=>entries.some(([,other])=>other!==value&&other.text===value.text))!;
    const second=entries.find(([,value])=>value!==first[1]&&value.text===first[1].text)!;
    expect(first).toBeDefined();expect(second).toBeDefined();
    const sessionQuery=entries.find(([,value])=>value.sites[0]?.file==="src/auth/context.ts"&&value.text.startsWith("select * from session where"))!;
    expect(sessionQuery[1].sites[0]!.fn).toBe("prefetch");
    const statement={bind(){return this;},async all(){return {results:[],meta:{duration:1,rows_read:0,rows_written:0}};}};
    const raw={prepare(){return statement;}} as unknown as D1Database;
    const trace=newTrace(), db=meteredD1(raw,{trips:0,statements:0,ms:0});
    await withTrace(trace,async()=>{
      for(const [,catalog] of [first,second]) {
        const s=catalog.sites[0]!;
        await db.prepare(`/*perf-site:${encodeURIComponent(s.file)}:${s.line}:${s.column}:${encodeURIComponent(s.fn)}:${catalog.sourceHash}*/ SELECT 'user-secret-must-not-export'`).all();
      }
    });
    expect(trace.spans[0]!.fingerprint).not.toBe(trace.spans[1]!.fingerprint);
    expect(trace.spans[0]!.source).toEqual(first[1].sites[0]);expect(trace.spans[1]!.source).toEqual(second[1].sites[0]);
    expect(trace.spans[0]!.sqlCode).toBe(first[0]);expect(trace.spans[1]!.sqlCode).toBe(second[0]);
    const c=collector();await writeTrace(c.measured,trace);expect(JSON.stringify(c.points)).not.toContain("user-secret-must-not-export");
    for(const point of c.points) {expect(point.blobs?.length).toBeLessThanOrEqual(20);expect(point.doubles?.length).toBeLessThanOrEqual(20);}
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

  it("drains spans that outlive response headers and cancels its drain timer", async () => {
    const trace = newTrace(), c = collector();
    await withTrace(trace, async () => { void span("mcp.tools.call", () => scheduler.wait(20)); });
    trace.ended = performance.now();
    await deferredTrace(c.measured, trace, "pimwell-hub", 100);
    expect(trace.pending.size).toBe(0);
    const point = c.points.find(p => p.blobs?.[13] === "mcp.tools.call")!;
    expect(point.doubles?.[13]).toBe(1);
    expect(point.doubles?.[0]).toBeGreaterThan(0);
  });

  it("bounds stalled-span draining and ignores public trace-envelope spoofing", async () => {
    const trace = newTrace(), c = collector();
    await withTrace(trace, async () => { void span("stalled", () => new Promise(() => {})); });
    trace.ended = performance.now();
    await deferredTrace(c.measured, trace, "pimwell-hub", 10);
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

describe("isolated synthetic journeys", () => {
  it("seeds a hidden member, refuses spoofed/expired markers and rejects real-tenant credentials", async () => {
    const c = collector();
    expect(await listMembers(env.HUB_DB,SYNTHETIC_TENANT)).toEqual([]);
    expect(await syntheticMarker(c.measured,"spoof")).toBe(false);
    const token="pms_synthetic_test",now=Date.now();
    await env.HUB_DB.prepare("INSERT INTO session (id,identity_id,tenant_id,kind,label,token_hash,created_at,last_seen_at,expires_at,last_proof_at) VALUES ('synthetic-test',?,?,'browser','Synthetic journey',?,?,?,?,?)").bind(SYNTHETIC_MEMBER,SYNTHETIC_TENANT,await sha256Hex(token),now,now,now+60000,now).run();
    expect(await syntheticMarker(c.measured,token)).toBe(true);
    await seedTenant("acme");
    const response=await app.fetch(new Request("https://"+HOST+"/docket",{headers:cookieHeaders(token,HOST)}),c.measured,c.ctx);
    expect(response.status).not.toBe(200);
    await c.flush();
    await env.HUB_DB.prepare("UPDATE session SET expires_at = 0 WHERE id = 'synthetic-test'").run();
    expect(await syntheticMarker(c.measured,token)).toBe(false);
  });
  it("records each journey as synthetic, opens one Situation per failure episode, and never retains content", async () => {
    const c=collector(),point={duration:12,version:"synthetic-version",colo:"DFW",failed:true};
    await recordSynthetic(c.measured,"mail",point);
    await recordSynthetic(c.measured,"mail",point);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM situation").first("n")).toBe(1);
    await recordSynthetic(c.measured,"mail",{...point,failed:false});
    await recordSynthetic(c.measured,"mail",point);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM situation").first("n")).toBe(2);
    expect(c.points.every(p=>p.blobs?.[6]==="synthetic")).toBe(true);
    expect(c.points[0]?.blobs?.slice(2,4)).toEqual(["synthetic-version","DFW"]);
  });
  it.each(["new", "mapped", "missing-storage"])("avoids repeated fixture provisioning for %s while retaining storage repair", async mode => {
    if (mode !== "new") await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id,project_id,imported_at) VALUES (?,'perf-synthetic-repo',0)").bind(SYNTHETIC_TENANT).run();
    const provision = vi.spyOn(ardi, "createRepo").mockResolvedValue();
    let requests = 0;
    const exchange = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://perf-synthetic.pimwell.test/fixture.git/info/refs?service=git-upload-pack");
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic synthetic-fixture-only");
      requests++;
      if (mode === "missing-storage" && requests === 1) return new Response("missing", { status: 404 });
      return new Response("001e# service=git-upload-pack\n00000000", { headers: { "content-type": "application/x-git-upload-pack-advertisement", "x-pimwell-colo": "DFW", "x-pimwell-version": "fixture-test" } });
    });
    try {
      expect(await gitLsRemote(env, exchange, "Basic synthetic-fixture-only", Date.now())).toEqual({ colo: "DFW", version: "fixture-test" });
      expect(provision).toHaveBeenCalledTimes(mode === "mapped" ? 0 : 1);
      expect(exchange).toHaveBeenCalledTimes(mode === "missing-storage" ? 2 : 1);
      if (mode !== "mapped") {
        expect(provision.mock.calls[0]![2]).toEqual({ identity_id: SYNTHETIC_MEMBER, tenant_id: SYNTHETIC_TENANT, org: "perf-synthetic", name: "fixture" });
        expect(typeof provision.mock.calls[0]![3]).toBe("number");
      }
    } finally { vi.restoreAllMocks(); }
  });
  it.each([403, 503])("does not use fixture provisioning to retry authorization/storage ownership failures (%s)", async status => {
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id,project_id,imported_at) VALUES (?,'perf-synthetic-repo',0)").bind(SYNTHETIC_TENANT).run();
    const provision = vi.spyOn(ardi, "createRepo").mockResolvedValue();
    try {
      await expect(gitLsRemote(env, async () => new Response("denied", { status }), "Basic synthetic-fixture-only", Date.now())).rejects.toThrow("Synthetic Git failed");
      expect(provision).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  it("runs the fixed browser/MCP/chat/Git journeys through live handlers and deletes ephemeral credentials", async () => {
    const c=collector(); let cookies="",current="",html="";
    const measured={...c.measured,SYNTHETIC_BROWSER:{} as Fetcher};
    const page={
      setRequestInterception:async()=>{},on:()=>{},setCookie:async(p:{value:string})=>{cookies="pmw_session="+p.value;},
      goto:async(url:string)=>{
        current=url;
        const response=await app.fetch(new Request(url,{headers:{cookie:cookies}}),measured,c.ctx);
        html=await response.text();
        return {status:()=>response.status,headers:()=>Object.fromEntries(response.headers)};
      },
      url:()=>current,$:async()=>html.includes("/assets/timing.")?{}:null,evaluate:async(_fn:unknown,url?:string,options?:RequestInit)=>{
        if(!url)return;
        const response=await fetch(url,{...options,headers:{...options?.headers,cookie:cookies,...(new URL(url).pathname==="/mcp"?{}:{origin:new URL(url).origin})}});
        return {status:response.status,headers:Array.from(response.headers.entries()),body:await response.text()};
      }
    };
    const close=vi.fn(async()=>{});
    vi.spyOn(puppeteer,"launch").mockResolvedValue({newPage:async()=>page,close} as never);
    vi.spyOn(ardi,"createRepo").mockResolvedValue();
    const originalFetch=globalThis.fetch;
    vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      const request=input instanceof Request?input:new Request(input,init),url=new URL(request.url);
      if(url.pathname.includes(".git/"))return new Response("001e# service=git-upload-pack\n00000000",{headers:{"content-type":"application/x-git-upload-pack-advertisement","x-pimwell-colo":"DFW","x-pimwell-version":"test-version"}});
      if(url.hostname.endsWith(".pimwell.test")||url.hostname==="pimwell.test")return app.fetch(request,measured,c.ctx);
      return originalFetch(input,init);
    });
    try {
      await runSynthetic(measured,c.ctx);
      await c.flush();
      const rows=(await env.HUB_DB.prepare("SELECT journey,failed FROM synthetic_run ORDER BY journey").all<{journey:string;failed:number}>()).results;
      expect(rows).toEqual([...SYNTHETIC_JOURNEYS].sort().map(journey=>({journey,failed:0})));
      expect(close).toHaveBeenCalledOnce();
      expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM oauth_grant WHERE identity_id = ?").bind(SYNTHETIC_MEMBER).first("n")).toBe(0);
      expect(await env.OAUTH_KV.list({prefix:"client:"})).toMatchObject({keys:[]});
    } finally {vi.restoreAllMocks();}
  });
});
