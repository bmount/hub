// An organization's home, its people and agents, and each project's own page (overnight plan task 4).
// Every page reads in one D1 batch: one round trip, whatever it shows.
import type { Env } from "../env";
import { esc, htmlResponse, onramp, page } from "../html";
import { intentBox } from "../intent/page";
import { buildContext, rank, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { KINDS, STATES, type WorkKind, type WorkState } from "../work/names";

const ago = (now: number, t: number) => {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 36) return `${h} h ago`;
  return new Date(t).toISOString().slice(0, 10);
};

type Ev = { kind: string; summary: string; created_at: number; who: string | null; who_kind: string | null };
function timeline(now: number, rows: Ev[]): string {
  if (!rows.length) return `<p class="lede">Nothing yet. The first thing that happens here will show up in this list.</p>`;
  return `<ol class="timeline">${rows.map((e) => `<li><time>${esc(ago(now, e.created_at))}</time><span>${e.who ? `<strong>${esc(e.who)}</strong>${e.who_kind === "agent" ? " <small>(agent)</small>" : ""}: ` : ""}${esc(e.summary)}</span></li>`).join("")}</ol>`;
}

async function orgCtx(request: Request, env: Env): Promise<{ ctx: Ctx; extra: Record<string, string> } | Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  return { ctx, extra };
}

const EVENTS_SQL = `SELECT e.kind, e.summary, e.created_at, i.display_name AS who, i.kind AS who_kind FROM event e LEFT JOIN identity i ON i.id = e.identity_id`;

export async function orgHomePage(request: Request, env: Env): Promise<Response> {
  const oc = await orgCtx(request, env);
  if (oc instanceof Response) return oc;
  const { ctx, extra } = oc;
  const t = ctx.tenant!;
  const [projects, byKind, events, mail, people] = await ctx.db.batch([
    ctx.db.prepare(`SELECT p.slug, p.display_name, p.kind, (SELECT COUNT(*) FROM work_item w WHERE w.project_id = p.id AND w.state IN ('open','doing')) AS open_work,
      (SELECT MAX(w.updated_at) FROM work_item w WHERE w.project_id = p.id) AS last_work FROM project p WHERE p.tenant_id = ? AND p.state = 'active' AND p.kind <> 'channel' ORDER BY p.slug`).bind(t.id),
    ctx.db.prepare("SELECT kind, COUNT(*) AS n FROM work_item WHERE tenant_id = ? AND state IN ('open','doing') GROUP BY kind").bind(t.id),
    ctx.db.prepare(`${EVENTS_SQL} WHERE e.tenant_id = ? ORDER BY e.created_at DESC LIMIT 12`).bind(t.id),
    ctx.db.prepare(`SELECT m.id, m.subject, m.from_email, m.received_at, pr.slug AS project FROM inbound_mail m LEFT JOIN project pr ON pr.id = m.project_id WHERE m.tenant_id = ? AND m.verdict = 'admitted' ORDER BY m.received_at DESC LIMIT 5`).bind(t.id),
    ctx.db.prepare("SELECT i.kind, COUNT(*) AS n FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active' GROUP BY i.kind").bind(t.id),
  ]);
  const proj = (projects!.results as Array<{ slug: string; display_name: string; kind: string; open_work: number; last_work: number | null }>);
  const kinds = new Map((byKind!.results as Array<{ kind: WorkKind; n: number }>).map((r) => [r.kind, r.n]));
  const counts = new Map((people!.results as Array<{ kind: string; n: number }>).map((r) => [r.kind, r.n]));
  const totalOpen = [...kinds.values()].reduce((a, b) => a + b, 0);

  const projectCards = proj.length ? `<div class="grid">${proj.map((p) => `<div class="card"><h3><a href="/${esc(p.slug)}">${esc(p.display_name)}</a></h3>
<p>${p.kind === "repo" ? "Repository" : "Tracker"} · ${p.open_work} open${p.last_work ? ` · active ${esc(ago(ctx.now, p.last_work))}` : ""}</p>
<p><a href="/${esc(p.slug)}/docket">Docket</a> · <code>${esc(t.slug)}.${esc(p.slug)}@${esc(env.HUB_DOMAIN)}</code></p></div>`).join("")}</div>`
    : `<p class="lede">No projects yet.</p>`;
  const kindChips = (Object.keys(KINDS) as WorkKind[]).map((k) => `<a class="chip k-${k}" href="/docket?kind=${k}">${esc(KINDS[k].plural)} ${kinds.get(k) ?? 0}</a>`).join("");
  const mailRows = (mail!.results as Array<{ id: string; subject: string; from_email: string; received_at: number; project: string | null }>);
  const body = `<h1>${esc(t.display_name)}</h1>
<p class="lede">You are ${esc(ctx.role!)} · ${counts.get("human") ?? 0} people and ${counts.get("agent") ?? 0} agents · ${totalOpen} things open · send anything to <code>${esc(t.slug)}@${esc(env.HUB_DOMAIN)}</code></p>
${intentBox()}
${onramp({ connect: rank(ctx.role) >= rank("member"), invite: rank(ctx.role) >= rank("admin") })}
<h2>Projects</h2>${projectCards}
<h2>Open work</h2><div class="chips">${kindChips}</div>
<h2>Lately</h2>${timeline(ctx.now, events!.results as Ev[])}
<h2>Mail</h2>${mailRows.length ? `<ul>${mailRows.map((m) => `<li><a href="/mail/${esc(m.id)}">${esc(m.subject || "(no subject)")}</a> <small>from ${esc(m.from_email)} to ${esc(m.project ?? "the inbox")}, ${esc(ago(ctx.now, m.received_at))}</small></li>`).join("")}</ul>` : `<p class="lede">No mail yet. Forward a thread to any project's address and it lands here.</p>`}
<p><a href="/archive">Archive</a></p>`;
  return htmlResponse(page(t.display_name, body, shellFor(ctx, env, "home", t.slug)), 200, extra);
}

export async function projectPage(request: Request, env: Env, slug: string): Promise<Response> {
  const oc = await orgCtx(request, env);
  if (oc instanceof Response) return oc;
  const { ctx, extra } = oc;
  const t = ctx.tenant!;
  const p = await ctx.db.prepare("SELECT id, slug, display_name, kind, state FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel'").bind(t.id, slug)
    .first<{ id: string; slug: string; display_name: string; kind: string; state: string }>();
  if (!p) return notFoundPage(extra);
  const [byKind, events, open] = await ctx.db.batch([
    ctx.db.prepare("SELECT kind, COUNT(*) AS n FROM work_item WHERE project_id = ? AND state IN ('open','doing') GROUP BY kind").bind(p.id),
    ctx.db.prepare(`${EVENTS_SQL} WHERE e.tenant_id = ? AND ((e.target_kind = 'project' AND e.target_id = ?)
      OR (e.target_kind = 'work_item' AND e.target_id IN (SELECT id FROM work_item WHERE project_id = ?))
      OR (e.target_kind = 'inbound_mail' AND e.target_id IN (SELECT id FROM inbound_mail WHERE project_id = ?))) ORDER BY e.created_at DESC LIMIT 40`).bind(t.id, p.id, p.id, p.id),
    ctx.db.prepare("SELECT number, kind, title, state FROM work_item WHERE project_id = ? AND state IN ('open','doing') ORDER BY CASE kind WHEN 'quest' THEN 0 ELSE 1 END, updated_at DESC LIMIT 12").bind(p.id),
  ]);
  const kinds = new Map((byKind!.results as Array<{ kind: WorkKind; n: number }>).map((r) => [r.kind, r.n]));
  const openRows = open!.results as Array<{ number: number; kind: WorkKind; title: string; state: WorkState }>;
  const clone = p.kind === "repo" ? `<p>Clone: <code>git clone https://${esc(t.slug)}.${esc(env.HUB_DOMAIN)}/${esc(p.slug)}.git</code> <small>(make a git credential on <a href="https://${esc(env.HUB_DOMAIN)}/me">your account</a>)</small></p>` : "";
  const body = `<p class="crumbs"><a href="/">${esc(t.display_name)}</a> /</p>
<h1>${esc(p.display_name)}${p.state === "archived" ? " <small>(archived)</small>" : ""}</h1>
<p class="lede">Send or forward anything to <code>${esc(t.slug)}.${esc(p.slug)}@${esc(env.HUB_DOMAIN)}</code>. It is filed here as evidence, never as instructions.</p>
${clone}
<div class="chips">${(Object.keys(KINDS) as WorkKind[]).map((k) => `<a class="chip k-${k}" href="/${esc(p.slug)}/docket?kind=${k}">${esc(KINDS[k].plural)} ${kinds.get(k) ?? 0}</a>`).join("")}<a class="chip" href="/${esc(p.slug)}/docket">Docket</a></div>
<h2>Open now</h2>${openRows.length ? `<ul>${openRows.map((w) => `<li><a href="/${esc(p.slug)}/w/${w.number}">#${w.number}</a> <span class="k-${w.kind}">${esc(KINDS[w.kind].name)}</span>: ${esc(w.title)} <small>${esc(STATES[w.state])}</small></li>`).join("")}</ul>` : `<p class="lede">Nothing open. File a wish, a snag, or an errand from the Docket.</p>`}
<h2>What happened</h2>${timeline(ctx.now, events!.results as Ev[])}`;
  return htmlResponse(page(p.display_name, body, shellFor(ctx, env, "project", `${t.slug}/${p.slug}`)), 200, extra);
}

