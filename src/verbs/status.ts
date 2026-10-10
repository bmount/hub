// Status from recorded evidence, never a health claim. Totals are independent of capped examples.
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, notFound } from "../errors";
import type { Ctx } from "../auth/context";
import { DATA_NOTE, cleanText } from "../mcp/render";
import { KINDS, type WorkKind } from "../work/names";
import { gitSyncCoverage } from "../code/syncState";

export const STATUS_COVERAGE_NOTE = "Recorded evidence only; zero records does not prove zero activity or healthy operation. Error occurrences in the period are unavailable: retained events are sampled and capped, and group counts are lifetime counts. Telemetry last-received times do not prove continuous coverage. Git records may lag upstream.";
type ExampleKey = "filed" | "finished" | "doing" | "deploys" | "errors" | "reviews" | "commits";
export type Status = {
  project: string; since: number; as_of: number;
  totals: Record<Exclude<ExampleKey, "commits">, number> & { error_occurrences: null };
  examples: Record<ExampleKey, { shown: number; limit: number; truncated: boolean }>;
  coverage: { note: string; telemetry: { registered_sources: number; active_sources: number; active_never_received: number; active_received_in_period: number; oldest_active_last_received_at: number | null; latest_active_last_received_at: number | null }; latest_recorded_commit_at: number | null; git_sync: ReturnType<typeof gitSyncCoverage> };
  filed: Array<{ ref: string; kind: WorkKind; title: string; by: string | null }>;
  finished: Array<{ ref: string; kind: WorkKind; title: string; state: string }>;
  doing: Array<{ ref: string; title: string; owner: string | null; stalled: boolean }>;
  commits: { count: number; by: Array<{ who: string; n: number }>; recent: Array<{ summary: string; at: number }> };
  deploys: Array<{ tag: string | null; script: string; at: number }>;
  errors: Array<{ title: string; lifetime_count: number; period_samples: number; period_count: null; first_seen: number; last_seen: number }>;
  reviews: Array<{ ref: string; title: string; status: string }>;
  mail: number; comments: number;
};

export function parseSince(v: string | null, now: number): number {
  if (!v) return now - 7 * 86_400_000;
  const d = /^(\d{1,3})d$/.exec(v.trim());
  if (d) return now - Number(d[1]) * 86_400_000;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > now) throw badRequest("since is like 7d, or an ISO 8601 date in the past");
  return t;
}

export async function projectStatus(ctx: Ctx, slug: string, since: number): Promise<Status> {
  const tenant = ctx.tenant!.id, now = ctx.now;
  const p = await ctx.db.prepare("SELECT id, slug FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel'").bind(tenant, slug.toLowerCase()).first<{ id: string; slug: string }>();
  if (!p) throw notFound("no such project");
  const id = p.id;
  // D1 batch reads use one transaction, keeping counts and examples consistent. No unbounded time ranges.
  const period = (table: string, time: string, suffix = "") => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND project_id = ? AND ${time} >= ? AND ${time} <= ? ${suffix}`).bind(tenant, id, since, now);
  const [filed, finished, doing, commits, byWho, deploys, errors, reviews, mail, comments, recent, counts, telemetry, latestCommit, gitSync] = await ctx.db.batch([
    ctx.db.prepare("SELECT w.number, w.kind, w.title, i.display_name AS by FROM work_item w LEFT JOIN identity i ON i.id = w.created_by WHERE w.tenant_id = ? AND w.project_id = ? AND w.created_at BETWEEN ? AND ? ORDER BY w.created_at DESC, w.number DESC LIMIT 50").bind(tenant, id, since, now),
    ctx.db.prepare("SELECT number, kind, title, state FROM work_item WHERE tenant_id = ? AND project_id = ? AND closed_at BETWEEN ? AND ? ORDER BY closed_at DESC, number DESC LIMIT 50").bind(tenant, id, since, now),
    ctx.db.prepare("SELECT w.number, w.title, w.updated_at, i.display_name AS owner FROM work_item w LEFT JOIN identity i ON i.id = w.owner_id WHERE w.tenant_id = ? AND w.project_id = ? AND w.state = 'doing' ORDER BY w.updated_at, w.number LIMIT 50").bind(tenant, id),
    period("code_event", "at", "AND kind = 'commit'"),
    ctx.db.prepare("SELECT COALESCE(i.display_name, 'someone outside Pimwell') AS who, COUNT(*) AS n FROM code_event e LEFT JOIN identity i ON i.id = e.identity_id WHERE e.tenant_id = ? AND e.project_id = ? AND e.kind = 'commit' AND e.at BETWEEN ? AND ? GROUP BY e.identity_id ORDER BY n DESC").bind(tenant, id, since, now),
    ctx.db.prepare("SELECT tag, script_name AS script, seen_at AS at FROM app_deploy WHERE tenant_id = ? AND project_id = ? AND seen_at BETWEEN ? AND ? ORDER BY seen_at DESC, id DESC LIMIT 20").bind(tenant, id, since, now),
    ctx.db.prepare(`SELECT g.title, g.count AS lifetime_count, g.first_seen, g.last_seen, NULL AS period_count,
      (SELECT COUNT(*) FROM app_event e WHERE e.tenant_id = g.tenant_id AND e.group_id = g.id AND e.at BETWEEN ? AND ?) AS period_samples
      FROM app_error_group g WHERE g.tenant_id = ? AND g.project_id = ? AND g.last_seen BETWEEN ? AND ? ORDER BY g.last_seen DESC, g.id DESC LIMIT 20`).bind(since, now, tenant, id, since, now),
    ctx.db.prepare("SELECT number, title, status FROM review WHERE tenant_id = ? AND project_id = ? AND updated_at BETWEEN ? AND ? ORDER BY updated_at DESC, number DESC LIMIT 20").bind(tenant, id, since, now),
    period("inbound_mail", "received_at", "AND verdict = 'admitted'"),
    ctx.db.prepare("SELECT COUNT(*) AS n FROM work_comment c JOIN work_item w ON w.id = c.item_id WHERE w.tenant_id = ? AND c.tenant_id = w.tenant_id AND w.project_id = ? AND c.created_at BETWEEN ? AND ?").bind(tenant, id, since, now),
    ctx.db.prepare("SELECT summary, at FROM code_event WHERE tenant_id = ? AND project_id = ? AND kind = 'commit' AND at BETWEEN ? AND ? ORDER BY at DESC, ardi_id DESC LIMIT 10").bind(tenant, id, since, now),
    ctx.db.prepare(`SELECT
      (SELECT COUNT(*) FROM work_item WHERE tenant_id = ?1 AND project_id = ?2 AND created_at BETWEEN ?3 AND ?4) AS filed,
      (SELECT COUNT(*) FROM work_item WHERE tenant_id = ?1 AND project_id = ?2 AND closed_at BETWEEN ?3 AND ?4) AS finished,
      (SELECT COUNT(*) FROM work_item WHERE tenant_id = ?1 AND project_id = ?2 AND state = 'doing') AS doing,
      (SELECT COUNT(*) FROM app_deploy WHERE tenant_id = ?1 AND project_id = ?2 AND seen_at BETWEEN ?3 AND ?4) AS deploys,
      (SELECT COUNT(*) FROM app_error_group WHERE tenant_id = ?1 AND project_id = ?2 AND last_seen BETWEEN ?3 AND ?4) AS errors,
      (SELECT COUNT(*) FROM review WHERE tenant_id = ?1 AND project_id = ?2 AND updated_at BETWEEN ?3 AND ?4) AS reviews`).bind(tenant, id, since, now),
    ctx.db.prepare(`SELECT COUNT(*) AS registered_sources, COUNT(CASE WHEN state = 'active' THEN 1 END) AS active_sources,
      COUNT(CASE WHEN state = 'active' AND last_event_at IS NULL THEN 1 END) AS active_never_received,
      COUNT(CASE WHEN state = 'active' AND last_event_at BETWEEN ? AND ? THEN 1 END) AS active_received_in_period,
      MIN(CASE WHEN state = 'active' THEN last_event_at END) AS oldest_active_last_received_at,
      MAX(CASE WHEN state = 'active' THEN last_event_at END) AS latest_active_last_received_at
      FROM app_source WHERE tenant_id = ? AND project_id = ?`).bind(since, now, tenant, id),
    ctx.db.prepare("SELECT MAX(at) AS at FROM code_event WHERE tenant_id = ? AND project_id = ? AND kind = 'commit' AND at <= ?").bind(tenant, id, now),
    ctx.db.prepare("SELECT cursor, last_run_at, last_error FROM code_sync WHERE tenant_id = ? AND project_id = ?").bind(tenant, id),
  ]);
  const r = <T>(x: D1Result<unknown> | undefined) => (x?.results ?? []) as T[];
  const totals = { ...r<Omit<Status["totals"], "error_occurrences">>(counts)[0]!, error_occurrences: null };
  const commitCount = r<{ n: number }>(commits)[0]!.n;
  const examples = {} as Status["examples"];
  for (const [key, result, limit, total] of [
    ["filed", filed, 50, totals.filed], ["finished", finished, 50, totals.finished], ["doing", doing, 50, totals.doing],
    ["deploys", deploys, 20, totals.deploys], ["errors", errors, 20, totals.errors], ["reviews", reviews, 20, totals.reviews], ["commits", recent, 10, commitCount],
  ] as const) examples[key] = { shown: result!.results.length, limit, truncated: total > result!.results.length };
  return {
    project: p.slug, since, as_of: now, totals, examples,
    coverage: { note: STATUS_COVERAGE_NOTE, telemetry: r<Status["coverage"]["telemetry"]>(telemetry)[0]!, latest_recorded_commit_at: r<{ at: number | null }>(latestCommit)[0]!.at, git_sync: gitSyncCoverage(r<{ cursor: string | null; last_run_at: number | null; last_error: string | null }>(gitSync)[0]) },
    filed: r<{ number: number; kind: WorkKind; title: string; by: string | null }>(filed).map((x) => ({ ref: `${p.slug}#${x.number}`, kind: x.kind, title: x.title, by: x.by })),
    finished: r<{ number: number; kind: WorkKind; title: string; state: string }>(finished).map((x) => ({ ref: `${p.slug}#${x.number}`, kind: x.kind, title: x.title, state: x.state })),
    doing: r<{ number: number; title: string; updated_at: number; owner: string | null }>(doing).map((x) => ({ ref: `${p.slug}#${x.number}`, title: x.title, owner: x.owner, stalled: now - x.updated_at > 7 * 86_400_000 })),
    commits: { count: commitCount, by: r<{ who: string; n: number }>(byWho), recent: r(recent) },
    deploys: r(deploys), errors: r(errors), reviews: r<{ number: number; title: string; status: string }>(reviews).map((x) => ({ ref: `${p.slug}!${x.number}`, title: x.title, status: x.status })),
    mail: r<{ n: number }>(mail)[0]!.n, comments: r<{ n: number }>(comments)[0]!.n,
  };
}

/** Disclosure at the actual presentation cap (which may be smaller than the API example cap). */
export function statusExamples(total: number, shown: number): string {
  return shown < total ? `Showing ${shown} of ${total} recorded examples; truncated.` : `Showing all ${shown} recorded examples.`;
}
export function statusFreshness(s: Status): string {
  const t = s.coverage.telemetry;
  const when = (at: number | null) => at === null ? "never received" : new Date(at).toISOString();
  const git = s.coverage.git_sync;
  const lag = git.lag_ms === null ? "unknown" : `${git.lag_ms}ms`;
  return `Git sync: ${git.phase}; observed at ${when(git.observed_at)}; pending event-ID span ${git.pending_id_span ?? "unknown"}; observed event-time lag ${lag} (not an event count or continuous freshness guarantee). Last run: ${when(git.last_run_at)}${git.last_error ? "; sync error recorded" : ""}. As of ${new Date(s.as_of).toISOString()}; telemetry sources: ${t.registered_sources} registered, ${t.active_sources} active, ${t.active_never_received} active never received, ${t.active_received_in_period} active last received in period. Oldest/latest active last received: ${when(t.oldest_active_last_received_at)} / ${when(t.latest_active_last_received_at)}. Latest recorded commit: ${when(s.coverage.latest_recorded_commit_at)}.`;
}
export function statusText(s: Status): string {
  const lines = [`**${s.project} since ${new Date(s.since).toISOString()}**`, statusFreshness(s), s.coverage.note, ""];
  const examples = (key: Exclude<ExampleKey, "commits">, cap: number) => statusExamples(s.totals[key], Math.min(s[key].length, cap));
  lines.push(`- Filed: ${s.totals.filed}. ${examples("filed", 8)} ${s.filed.slice(0, 8).map((f) => `${f.ref} ${KINDS[f.kind]?.name ?? f.kind}: ${cleanText(f.title)}`).join("; ")}`);
  lines.push(`- Finished or let go: ${s.totals.finished}. ${examples("finished", 8)} ${s.finished.slice(0, 8).map((f) => `${f.ref} ${cleanText(f.title)}`).join("; ")}`);
  lines.push(`- Under way now: ${s.totals.doing}. ${examples("doing", 50)} ${s.doing.map((d) => `${d.ref} ${cleanText(d.title)}${d.owner ? ` — ${cleanText(d.owner)}` : ""}${d.stalled ? " [stalled]" : ""}`).join("; ")}`);
  lines.push(`- Commits: ${s.commits.count}${s.commits.by.length ? ` (${s.commits.by.map((b) => `${cleanText(b.who)} ${b.n}`).join(", ")})` : ""}`);
  lines.push(`- Deploys: ${s.totals.deploys}. ${examples("deploys", 5)} ${s.deploys.slice(0, 5).map((d) => cleanText(d.tag ?? d.script)).join(", ")}`);
  lines.push(`- Error groups observed in period (including recurring): ${s.totals.errors}. ${examples("errors", 5)} ${s.errors.slice(0, 5).map((e) => `${cleanText(e.title)}: ${e.period_samples} retained period samples; ${e.lifetime_count} lifetime occurrences`).join("; ")}`);
  lines.push(`- Reviews updated in period: ${s.totals.reviews}. ${examples("reviews", 20)} ${s.reviews.map((r) => `${r.ref} ${r.status}`).join(", ")}`);
  lines.push(`- Admitted mail received: ${s.mail}; comments on work: ${s.comments}`);
  return lines.join("\n");
}

export const projectStatusVerb = defineVerb({
  name: "project.status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Recorded project activity since a time (default 7 days): independent totals, capped examples, recurring error groups and coverage/freshness limits. Not a health claim; period error occurrences are unknown.",
  mcp: {
    scope: "read", destructive: false, title: "Project status",
    input: { type: "object", properties: { project: { type: "string" }, since: { type: "string", description: "Like 7d or 2026-10-01; default 7d" } }, required: ["project"], additionalProperties: false },
    render: (r) => `${DATA_NOTE}\n\n${statusText(r as Status)}`,
  },
  parse: (i) => ({ project: reqString(i, "project", { max: 63 }), since: optString(i, "since", { max: 40 }) }),
  run: async (ctx, p) => projectStatus(ctx, p.project, parseSince(p.since, ctx.now)),
});
