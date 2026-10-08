// Status from records (roadmap milestone 2): what happened in a project since a time, assembled only from what the
// hub recorded — work, comments, commits and who pushed them, deploys, new errors, reviews, mail. No model writes it,
// so it can't say "everything is fine" when the record doesn't.
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, notFound } from "../errors";
import type { Ctx } from "../auth/context";
import { DATA_NOTE, cleanText } from "../mcp/render";
import { KINDS, type WorkKind } from "../work/names";

export type Status = {
  project: string; since: number;
  filed: Array<{ ref: string; kind: WorkKind; title: string; by: string | null }>;
  finished: Array<{ ref: string; kind: WorkKind; title: string; state: string }>;
  doing: Array<{ ref: string; title: string; owner: string | null; stalled: boolean }>;
  commits: { count: number; by: Array<{ who: string; n: number }>; recent: Array<{ summary: string; at: number }> };
  deploys: Array<{ tag: string | null; script: string; at: number }>;
  errors: Array<{ title: string; count: number; first_seen: number }>;
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
  const p = await ctx.db.prepare("SELECT id, slug FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel'").bind(ctx.tenant!.id, slug.toLowerCase()).first<{ id: string; slug: string }>();
  if (!p) throw notFound("no such project");
  const id = p.id;
  const [filed, finished, doing, commits, byWho, deploys, errors, reviews, mail, comments] = await ctx.db.batch([
    ctx.db.prepare("SELECT w.number, w.kind, w.title, i.display_name AS by FROM work_item w LEFT JOIN identity i ON i.id = w.created_by WHERE w.project_id = ? AND w.created_at >= ? ORDER BY w.created_at DESC LIMIT 50").bind(id, since),
    ctx.db.prepare("SELECT w.number, w.kind, w.title, w.state FROM work_item w WHERE w.project_id = ? AND w.closed_at >= ? ORDER BY w.closed_at DESC LIMIT 50").bind(id, since),
    ctx.db.prepare("SELECT w.number, w.title, w.updated_at, i.display_name AS owner FROM work_item w LEFT JOIN identity i ON i.id = w.owner_id WHERE w.project_id = ? AND w.state = 'doing' ORDER BY w.updated_at LIMIT 50").bind(id),
    ctx.db.prepare("SELECT COUNT(*) AS n FROM code_event WHERE project_id = ? AND kind = 'commit' AND at >= ?").bind(id, since),
    ctx.db.prepare("SELECT COALESCE(i.display_name, 'someone outside Pimwell') AS who, COUNT(*) AS n FROM code_event e LEFT JOIN identity i ON i.id = e.identity_id WHERE e.project_id = ? AND e.kind = 'commit' AND e.at >= ? GROUP BY e.identity_id ORDER BY n DESC").bind(id, since),
    ctx.db.prepare("SELECT tag, script_name AS script, seen_at AS at FROM app_deploy WHERE project_id = ? AND seen_at >= ? ORDER BY seen_at DESC LIMIT 20").bind(id, since),
    ctx.db.prepare("SELECT title, count, first_seen FROM app_error_group WHERE project_id = ? AND first_seen >= ? ORDER BY count DESC LIMIT 20").bind(id, since),
    ctx.db.prepare("SELECT number, title, status FROM review WHERE project_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 20").bind(id, since),
    ctx.db.prepare("SELECT COUNT(*) AS n FROM inbound_mail WHERE project_id = ? AND verdict = 'admitted' AND received_at >= ?").bind(id, since),
    ctx.db.prepare("SELECT COUNT(*) AS n FROM work_comment c JOIN work_item w ON w.id = c.item_id WHERE w.project_id = ? AND c.created_at >= ?").bind(id, since),
  ]);
  const recent = await ctx.db.prepare("SELECT summary, at FROM code_event WHERE project_id = ? AND kind = 'commit' AND at >= ? ORDER BY at DESC LIMIT 10").bind(id, since).all<{ summary: string; at: number }>();
  const r = <T>(x: D1Result<unknown> | undefined) => (x?.results ?? []) as T[];
  return {
    project: p.slug, since,
    filed: r<{ number: number; kind: WorkKind; title: string; by: string | null }>(filed).map((x) => ({ ref: `${p.slug}#${x.number}`, kind: x.kind, title: x.title, by: x.by })),
    finished: r<{ number: number; kind: WorkKind; title: string; state: string }>(finished).map((x) => ({ ref: `${p.slug}#${x.number}`, kind: x.kind, title: x.title, state: x.state })),
    doing: r<{ number: number; title: string; updated_at: number; owner: string | null }>(doing).map((x) => ({ ref: `${p.slug}#${x.number}`, title: x.title, owner: x.owner, stalled: ctx.now - x.updated_at > 7 * 86_400_000 })),
    commits: { count: r<{ n: number }>(commits)[0]?.n ?? 0, by: r<{ who: string; n: number }>(byWho), recent: recent.results },
    deploys: r(deploys), errors: r(errors), reviews: r<{ number: number; title: string; status: string }>(reviews).map((x) => ({ ref: `${p.slug}!${x.number}`, title: x.title, status: x.status })),
    mail: r<{ n: number }>(mail)[0]?.n ?? 0, comments: r<{ n: number }>(comments)[0]?.n ?? 0,
  };
}

export function statusText(s: Status): string {
  const since = new Date(s.since).toISOString().slice(0, 10);
  const lines = [`**${s.project} since ${since}**`, ""];
  lines.push(`- Filed: ${s.filed.length}${s.filed.length ? ` (${s.filed.slice(0, 8).map((f) => `${f.ref} ${KINDS[f.kind]?.name ?? f.kind}: ${cleanText(f.title)}`).join("; ")})` : ""}`);
  lines.push(`- Finished or let go: ${s.finished.length}${s.finished.length ? ` (${s.finished.slice(0, 8).map((f) => `${f.ref} ${cleanText(f.title)}`).join("; ")})` : ""}`);
  lines.push(`- Under way now: ${s.doing.length}${s.doing.length ? ` (${s.doing.map((d) => `${d.ref} ${cleanText(d.title)}${d.owner ? ` — ${cleanText(d.owner)}` : ""}${d.stalled ? " [stalled]" : ""}`).join("; ")})` : ""}`);
  lines.push(`- Commits: ${s.commits.count}${s.commits.by.length ? ` (${s.commits.by.map((b) => `${cleanText(b.who)} ${b.n}`).join(", ")})` : ""}`);
  lines.push(`- Deploys: ${s.deploys.length}${s.deploys.length ? ` (${s.deploys.slice(0, 5).map((d) => cleanText(d.tag ?? d.script)).join(", ")})` : ""}`);
  lines.push(`- New error groups: ${s.errors.length}${s.errors.length ? ` (${s.errors.slice(0, 5).map((e) => `${cleanText(e.title)} ×${e.count}`).join("; ")})` : ""}`);
  lines.push(`- Reviews: ${s.reviews.length}${s.reviews.length ? ` (${s.reviews.map((r) => `${r.ref} ${r.status}`).join(", ")})` : ""}`);
  lines.push(`- Mail received: ${s.mail}; comments on work: ${s.comments}`);
  return lines.join("\n");
}

export const projectStatusVerb = defineVerb({
  name: "project.status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "What happened in a project since a time (default 7 days), from the record only: work filed and finished, what's under way and stalled, commits and who pushed them, deploys, new errors, reviews, mail.",
  mcp: {
    scope: "read", destructive: false, title: "Project status",
    input: { type: "object", properties: { project: { type: "string" }, since: { type: "string", description: "Like 7d or 2026-10-01; default 7d" } }, required: ["project"], additionalProperties: false },
    render: (r) => `${DATA_NOTE}\n\n${statusText(r as Status)}`,
  },
  parse: (i) => ({ project: reqString(i, "project", { max: 63 }), since: optString(i, "since", { max: 40 }) }),
  run: async (ctx, p) => projectStatus(ctx, p.project, parseSince(p.since, ctx.now)),
});
