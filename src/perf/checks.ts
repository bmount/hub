import type { Env } from "../env";
import { analyticsQuery, type PerfRow } from "../apps/performance";
import { ulid } from "../ids";
import { BUDGETS, MIN_BUDGET_SAMPLES, MIN_REGRESSION_SAMPLES, REGRESSION_RATIO } from "./budgets";

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
type Release = { id: string; version: string; commit: string | null; seen_at: number };
export type CheckTarget = { site_id: string; name: string; tenant_id: string; project_id: string; project: string; script_name: string };
type Query = (sql: string) => Promise<PerfRow[]>;

/** Account-wide telemetry is restricted to the registered site and Worker, never copied across tenants. */
export async function checkPerformance(env: Env, target: CheckTarget, current: Release, previous: Release | null, now: number, query: Query = sql => analyticsQuery({env}, sql)): Promise<void> {
  const db = env.HUB_DB;
  const scope = `blob1 = ${quote(target.name)} AND blob2 = ${quote(target.script_name)} AND double14 = 1`;
  const since = Math.max(current.seen_at, now - 3_600_000);
  const range = `timestamp >= toDateTime(${Math.floor(since/1000)}) AND timestamp < toDateTime(${Math.floor(now/1000)})`;
  const metrics = "quantileWeighted(0.95)(double1, _sample_interval) AS p95, COUNT() AS samples";
  // Missing current windows are unknown; only a full day without retained evidence ends an episode.
  const cutoff = now - 86_400_000;
  const stale = (await db.prepare("SELECT a.situation_id, a.budget, a.route FROM perf_alert a JOIN situation s ON s.id = a.situation_id WHERE a.site_id = ? AND a.script_name = ? AND s.tenant_id = ? AND s.outcome IS NULL AND s.created_at <= ?").bind(target.site_id,target.script_name,target.tenant_id,cutoff).all<{situation_id:string;budget:string;route:string}>()).results;
  for (const alert of stale) {
    const budget = BUDGETS.find(b => b.id === alert.budget);
    const split = alert.budget === "git" ? alert.route.lastIndexOf(" @") : -1;
    const route = split < 0 ? alert.route : alert.route.slice(0,split);
    const colo = split < 0 ? "" : ` AND blob4 = ${quote(alert.route.slice(split+2))}`;
    // Across releases: a deploy is not evidence that a route has stopped receiving traffic.
    const evidence = await query(`SELECT COUNT() AS samples FROM pimwell_perf WHERE ${scope} AND timestamp >= toDateTime(${Math.floor(cutoff/1000)}) AND timestamp < toDateTime(${Math.floor(now/1000)}) AND blob8 = ${quote(route)}${colo} AND (${budget?.where ?? "blob7 = 'request' AND blob9 IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')"})`);
    if (evidence.length === 1 && Number(evidence[0]!.samples) === 0) {
      await db.prepare("UPDATE situation SET outcome = 'No recent data: no retained observations for this route or vantage in the last 24 hours; performance recovery is unknown.', outcome_at = ? WHERE id = ? AND tenant_id = ? AND outcome IS NULL").bind(now,alert.situation_id,target.tenant_id).run();
    }
  }
  let met = 0, measured = 0;
  const populations = [...BUDGETS, {id: "route", ms: Infinity, where: "blob7 = 'request' AND blob9 IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')"}];
  for (const budget of populations) {
    const synthetic = budget.id === "git";
    const vantage = synthetic ? ", blob4 AS colo" : "";
    const grouping = synthetic ? "route, colo" : "route";
    const rows = await query(`SELECT blob8 AS route${vantage}, ${metrics} FROM pimwell_perf WHERE ${scope} AND ${range} AND blob3 = ${quote(current.version)} AND (${budget.where}) GROUP BY ${grouping} LIMIT 1000`);
    const baseline = previous ? await query(`SELECT blob8 AS route${vantage}, ${metrics} FROM pimwell_perf WHERE ${scope} AND timestamp >= toDateTime(${Math.floor(Math.max(previous.seen_at,current.seen_at-3_600_000)/1000)}) AND timestamp < toDateTime(${Math.floor(current.seen_at/1000)}) AND blob3 = ${quote(previous.version)} AND (${budget.where}) GROUP BY ${grouping} LIMIT 1000`) : [];
    if (budget.id !== "route" && rows.length) { measured++; if (rows.every(r => Number(r.p95) <= budget.ms)) met++; }
    for (const row of rows) {
      const route = synthetic ? `${row.route} @${row.colo}` : String(row.route), old = baseline.find(r => r.route === row.route && (!synthetic || r.colo === row.colo));
      const regressionKnown = !!old && Number(old.samples) >= MIN_REGRESSION_SAMPLES && Number(row.samples) >= MIN_REGRESSION_SAMPLES && Number(old.p95) > 0;
      for (const kind of ["budget", "regression"] as const) {
        if (budget.id === "route" && kind === "budget") continue;
        // Sparse or missing observations cannot resolve a regression.
        if (kind === "regression" && !regressionKnown) continue;
        let failed = kind === "budget" ? Number(row.samples) >= MIN_BUDGET_SAMPLES && Number(row.p95) > budget.ms : Number(row.p95) >= Number(old!.p95) * REGRESSION_RATIO;
        if (synthetic && kind === "budget") {
          const colo = route.slice(route.lastIndexOf(" @") + 2);
          const runs = await query(`SELECT double1 AS duration, double16 AS at FROM pimwell_perf WHERE ${scope} AND ${range} AND blob3 = ${quote(current.version)} AND (${budget.where}) AND blob4 = ${quote(colo)} ORDER BY at DESC LIMIT 2`);
          // Distinct runs, not repeated checks of one observation.
          failed = runs.length === 2 && Number(runs[0]!.at) > Number(runs[1]!.at) && runs.every(r => Number(r.duration) > budget.ms);
        }
        const key = [target.site_id, target.script_name, kind, budget.id, route];
        const alert = await db.prepare("/*perf-site:src%2Fperf%2Fchecks.ts:33:29:checkPerformance:131189a6*/ SELECT a.situation_id, s.outcome FROM perf_alert a JOIN situation s ON s.id = a.situation_id WHERE a.site_id = ? AND a.script_name = ? AND a.kind = ? AND a.budget = ? AND a.route = ?").bind(...key).first<{situation_id:string;outcome:string|null}>();
        if (!failed) {
          if (alert && !alert.outcome) await db.prepare("/*perf-site:src%2Fperf%2Fchecks.ts:35:46:checkPerformance:033b2589*/ UPDATE situation SET outcome = 'No longer qualifies under the latest measured performance evidence (budget recovery, insufficient retained samples, or unconfirmed synthetic breach).', outcome_at = ? WHERE id = ? AND tenant_id = ?").bind(now,alert.situation_id,target.tenant_id).run();
          continue;
        }
        if (alert && !alert.outcome) continue;
        const spans = previous ? await query(`SELECT blob14 AS span, blob3 AS version, ${metrics} FROM pimwell_perf WHERE ${scope} AND timestamp >= toDateTime(${Math.floor(Math.max(previous.seen_at,current.seen_at-3_600_000)/1000)}) AND timestamp < toDateTime(${Math.floor(now/1000)}) AND blob8 = ${quote(String(row.route))}${synthetic ? ` AND blob4 = ${quote(String(row.colo))}` : ''} AND blob7 = 'span' AND blob3 IN (${quote(current.version)},${quote(previous.version)}) GROUP BY span, version LIMIT 1000`) : [];
        const growth = spans.filter(s => s.version === current.version && spans.some(p => p.span === s.span && p.version === previous?.version)).map(s => ({name:String(s.span),delta:Number(s.p95)-Number(spans.find(p => p.span === s.span && p.version === previous?.version)?.p95 ?? 0)})).sort((a,b) => b.delta-a.delta)[0];
        const span = growth?.name ?? null, id = ulid(now), thread = ulid(now);
        const actor = await db.prepare("/*perf-site:src%2Fperf%2Fchecks.ts:42:29:checkPerformance:ed4a7206*/ SELECT id FROM identity WHERE id = 'perf-synthetic-member'").first<{id:string}>();
        if (!actor) throw new Error("Performance system identity missing");
        const title = `Latency ${kind}: ${budget.id} ${route} (${row.samples} samples)`;
        const report = `${title}\np95 ${row.p95} ms; budget ${budget.ms} ms; ${row.samples} retained samples. Previous p95 ${old?.p95 ?? 'unknown'} ms (${old?.samples ?? 0} retained samples).\nDeploy: [${current.id}](/apps?d=${encodeURIComponent(current.id)})\nCommit: ${current.commit ? `[${current.commit}](/${encodeURIComponent(target.project)}/code?c=${encodeURIComponent(current.commit)})` : 'unknown'}\nLargest span growth: ${span ?? 'unavailable'}${growth ? ` (${growth.delta} ms)` : ''}.\nVersion: ${current.version}. Site: ${target.name}; Worker: ${target.script_name}.`;
        await db.batch([
          db.prepare("/*perf-site:src%2Fperf%2Fchecks.ts:47:11:checkPerformance:4471ec87*/ INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, 'read', ?, ?)").bind(thread,target.tenant_id,actor.id,title,now,now),
          db.prepare("/*perf-site:src%2Fperf%2Fchecks.ts:48:11:checkPerformance:fc1a53e5*/ INSERT INTO situation (id, tenant_id, identity_id, thread_id, title, question, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id,target.tenant_id,actor.id,thread,title,title,report,now),
          db.prepare("/*perf-site:src%2Fperf%2Fchecks.ts:49:11:checkPerformance:d37d7d26*/ INSERT INTO perf_alert (site_id, script_name, kind, budget, route, situation_id, deploy_id, commit_oid, span) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, script_name, kind, budget, route) DO UPDATE SET situation_id = excluded.situation_id, deploy_id = excluded.deploy_id, commit_oid = excluded.commit_oid, span = excluded.span").bind(...key,id,current.id,current.commit,span),
        ]);
      }
    }
  }
  await db.prepare("/*perf-site:src%2Fperf%2Fchecks.ts:54:9:checkPerformance:20e112f6*/ INSERT INTO perf_budget_check (site_id, script_name, deploy_id, checked_at, met, measured) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, script_name) DO UPDATE SET deploy_id = excluded.deploy_id, checked_at = excluded.checked_at, met = excluded.met, measured = excluded.measured").bind(target.site_id,target.script_name,current.id,now,met,measured).run();
}

/** Five-minute scheduler: hourly thereafter, first eligible check 30–35 minutes after a release. */
export async function runPerformanceChecks(env: Env, now = Date.now()): Promise<void> {
  const targets = (await env.HUB_DB.prepare(`/*perf-site:src%2Fperf%2Fchecks.ts:59:26:runPerformanceChecks:e2e64921*/ SELECT s.id AS site_id, s.name, s.tenant_id, s.project_id, p.slug AS project, a.script_name FROM site s JOIN project p ON p.id = s.project_id AND p.tenant_id = s.tenant_id JOIN site_app sa ON sa.site_id = s.id JOIN app_source a ON a.id = sa.app_id AND a.tenant_id = s.tenant_id AND a.project_id = s.project_id WHERE a.state = 'active' AND p.state = 'active' AND EXISTS (SELECT 1 FROM json_each(p.parts) WHERE value = 'repo')`).all<CheckTarget>()).results;
  for (const target of targets) {
    const releases = (await env.HUB_DB.prepare(`/*perf-site:src%2Fperf%2Fchecks.ts:61:29:runPerformanceChecks:729a20f8*/ SELECT id, substr(version_id,1,36) AS version, CASE WHEN length(tag) = 40 AND tag NOT GLOB '*[^0-9a-fA-F]*' THEN lower(tag) ELSE NULL END AS "commit", seen_at FROM app_deploy WHERE tenant_id = ? AND project_id = ? AND script_name = ? AND length(version_id) = 73 AND CASE WHEN json_valid(message) THEN json_extract(message,'$.release') = 1 AND json_extract(message,'$.environment') = 'production' ELSE 0 END ORDER BY seen_at DESC, id DESC LIMIT 2`).bind(target.tenant_id,target.project_id,target.script_name).all<Release>()).results;
    const current = releases[0];
    if (!current || now-current.seen_at < 1_800_000) continue;
    const last = await env.HUB_DB.prepare("/*perf-site:src%2Fperf%2Fchecks.ts:64:24:runPerformanceChecks:476d2857*/ SELECT deploy_id, checked_at FROM perf_budget_check WHERE site_id = ? AND script_name = ?").bind(target.site_id,target.script_name).first<{deploy_id:string;checked_at:number}>();
    if (last?.deploy_id === current.id && now-last.checked_at < 3_600_000) continue;
    await checkPerformance(env,target,current,releases[1] ?? null,now);
  }
}
