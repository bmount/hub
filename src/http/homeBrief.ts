import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import { projectPathSql } from "../db/projects";
import { esc, localTime } from "../html";
import { ulid } from "../ids";

/** Open the existing direct pair (or create it on click), never a new room per item. */
export function messageOwner(ctx: Ctx, id: string, name: string): string {
  if (ctx.identity?.kind !== "human" || ctx.identity.id === id || rank(ctx.role) < rank("member")) return "";
  return `<form method="post" class="inline" action="/api/chat.open"><input type="hidden" name="_back" value="@result"><input type="hidden" name="kind" value="direct"><input type="hidden" name="members" value="${esc(id)}"><input type="hidden" name="client_id" value="${ulid()}"><button class="quiet">Message ${esc(name)}</button></form>`;
}

type Row = { path: string; title: string; at: number; label: string; dest: string; note?: string; owner_id?: string; owner?: string };
export async function homeBrief(ctx: Ctx): Promise<string> {
  const path = projectPathSql(), tenant = ctx.tenant!.id;
  const projects = `p.tenant_id = ?1 AND p.state = 'active' AND p.kind NOT IN ('channel','agent-src')`;
  const latestNote = (item: string) => `(SELECT substr(c.body,1,180) FROM work_comment c WHERE c.tenant_id=?1 AND c.item_id=${item} ORDER BY c.created_at DESC,c.id DESC LIMIT 1)`;
  const [doing, changes] = await ctx.db.batch<Row>([
    ctx.db.prepare(`SELECT ${path} AS path, w.title, w.updated_at AS at, w.number AS dest, i.id AS owner_id, i.display_name AS owner, ${latestNote('w.id')} AS note
      FROM work_item w JOIN project p ON p.id=w.project_id AND p.tenant_id=w.tenant_id
      LEFT JOIN membership m ON m.tenant_id=p.tenant_id AND m.identity_id=w.owner_id AND m.state='active'
      LEFT JOIN identity i ON i.id=m.identity_id AND i.state='active'
      WHERE ${projects} AND w.state='doing' ORDER BY w.updated_at DESC,w.id DESC LIMIT 8`).bind(tenant),
    ctx.db.prepare(`SELECT recent.*, ${latestNote('recent.item')} AS note FROM (SELECT * FROM (
      SELECT w.id AS item, ${path} AS path,w.title,w.updated_at AS at,CASE w.state WHEN 'done' THEN 'Done' WHEN 'dropped' THEN 'Let go' ELSE CASE WHEN w.updated_at=w.created_at THEN 'Filed' ELSE 'Updated' END END AS label,'/w/' || w.number AS dest
      FROM work_item w JOIN project p ON p.id=w.project_id AND p.tenant_id=w.tenant_id WHERE ${projects} AND w.state <> 'doing'
      UNION ALL SELECT NULL,${path},r.title,r.updated_at,CASE WHEN r.merged_oid IS NOT NULL THEN 'Merged' WHEN r.status='approved' THEN 'Approved' WHEN r.status='changes' THEN 'Changes requested' WHEN r.status='closed' THEN 'Review closed' ELSE 'In review' END,'/reviews/' || r.number || CASE WHEN r.repo='' THEN '' ELSE '?repo=' || r.repo END
      FROM review r JOIN project p ON p.id=r.project_id AND p.tenant_id=r.tenant_id WHERE ${projects}
      UNION ALL SELECT NULL,${path},d.script_name || ' · ' || COALESCE(d.tag,substr(d.version_id,1,12)),d.seen_at,'Deploy recorded','/apps?d=' || d.id
      FROM app_deploy d JOIN project p ON p.id=d.project_id AND p.tenant_id=d.tenant_id WHERE ${projects}
    ) ORDER BY at DESC,path,dest LIMIT 12) recent ORDER BY at DESC,path,dest`).bind(tenant),
  ]);
  const rows = (items: Row[], active: boolean) => `<ul class="brief-list">${items.map(r => {
    const href = active ? `/${r.path}/w/${r.dest}` : r.dest.startsWith('/apps?') ? r.dest : `/${r.path}${r.dest}`;
    return `<li><div><a class="brief-title" href="${esc(href)}">${esc(r.title)}</a><small>${esc(r.path)} · ${esc(active ? r.owner ?? 'Unassigned' : r.label)} · ${localTime(r.at)}</small>${r.note ? `<p class="brief-note">${esc(r.note.trim())}${r.note.length === 180 ? '…' : ''}</p>` : ''}</div>${active && r.owner_id && r.owner ? messageOwner(ctx,r.owner_id,r.owner) : ''}</li>`;
  }).join('')}</ul>`;
  return `<section><h2>Under way</h2>${doing!.results.length ? rows(doing!.results,true) : '<p class="empty">No work is marked under way.</p>'}</section><section><h2>Recent changes</h2>${changes!.results.length ? rows(changes!.results,false) : '<p class="empty">No other changes to show.</p>'}</section>`;
}
