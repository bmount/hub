import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { notFound } from "../errors";
import type { Ctx } from "../auth/context";
import { projectBySlug } from "./work";
import { parseSince } from "./status";
import { DATA_NOTE } from "../mcp/render";
import { sha256Hex } from "../ids";
import { projectPathSql } from "../db/projects";

export type History = { kind: string; summary: string; created_at: number; identity_id: string | null; who?: string | null };
// Work follows recorded doing intervals, not lease expiry (which does not
// change an item's state). Renewals count as claims but never double-count time.
export function workedIntervals(events: History[], end: number) {
  let start: number | null = null, owner: string | null = null, first: number | null = null, attempts = 0;
  const intervals: Array<{ start: number; end: number; who: string | null }> = [];
  const workers = new Set<string>();
  const stop = (at: number) => { if (start !== null) { const finish = Math.min(at, end); if (finish > start) intervals.push({ start, end: finish, who: owner }); start = null; } };
  for (const e of [...events].sort((a,b)=>a.created_at-b.created_at)) {
    if (e.created_at > end) break;
    if (e.kind === "work.claim") {
      attempts++;
      if (first === null) first = e.created_at;
      if (start === null || owner !== e.identity_id) { stop(e.created_at); start = e.created_at; }
      owner = e.identity_id;
      if (e.who || e.identity_id) workers.add(e.who ?? e.identity_id!);
    } else if (e.kind === "work.release" || (e.kind === "work.update" && /\(Under way to (Open|Done|Let go)\)/.test(e.summary))) stop(e.created_at);
  }
  stop(end);
  return { first_claimed_at: first, attempts, workers: [...workers], intervals, worked_ms: intervals.reduce((n,i)=>n+i.end-i.start,0) };
}
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b), position = (sorted.length-1)*p, i = Math.floor(position);
  return sorted[i]! + (sorted[Math.ceil(position)]!-sorted[i]!)*(position-i);
}
type WorkRow = { id: string; number: number; kind: string; title: string; parent_id: string | null; state: string; created_at: number; closed_at: number | null };
type Usage = { item_id: string; at: number; input_tokens: number | null; cached_tokens: number | null; output_tokens: number | null; cost_micros: number | null };
export async function projectVelocity(ctx: Ctx, slug: string, quest: string | null = null, requestedSince: string | null = null) {
  const project = await projectBySlug(ctx, slug);
  const setting = await ctx.db.prepare("SELECT velocity_since FROM project WHERE id = ? AND tenant_id = ?").bind(project.id, ctx.tenant!.id).first<{velocity_since:number|null}>();
  const cutoff = setting?.velocity_since ?? project.created_at;
  const since = Math.max(cutoff, requestedSince ? parseSince(requestedSince,ctx.now) : cutoff);
  const tenant = ctx.tenant!.id;
  const eligible = "w.tenant_id = ? AND w.project_id = ? AND w.created_at >= ? AND w.created_at <= ?";
  const args = [tenant,project.id,cutoff,ctx.now];
  const [work, history, usage, commits] = await ctx.db.batch([
    ctx.db.prepare(`SELECT w.id,w.number,w.kind,w.title,w.parent_id,w.state,w.created_at,w.closed_at FROM work_item w WHERE ${eligible} ORDER BY w.number`).bind(...args),
    ctx.db.prepare(`SELECT e.target_id AS item_id,e.kind,e.summary,e.created_at,e.identity_id,i.display_name AS who FROM event e JOIN work_item w ON w.id = e.target_id AND w.tenant_id = e.tenant_id LEFT JOIN identity i ON i.id = e.identity_id WHERE ${eligible} AND e.target_kind = 'work_item' AND e.kind IN ('work.claim','work.release','work.update') ORDER BY e.created_at,e.id`).bind(...args),
    ctx.db.prepare(`SELECT w.id AS item_id,m.created_at AS at,m.input_tokens,m.cached_tokens,m.output_tokens,m.cost_micros FROM model_call m JOIN work_item w ON w.id = m.work_item_id AND w.tenant_id = m.tenant_id AND w.project_id = m.project_id WHERE ${eligible} AND m.created_at >= ? AND m.created_at <= ? AND NOT EXISTS (SELECT 1 FROM identity i WHERE i.id = m.identity_id AND i.is_synthetic = 1)`).bind(...args,cutoff,ctx.now),
    ctx.db.prepare(`SELECT DISTINCT w.id AS item_id,c.target AS oid,c.repo,c.summary,c.at,${projectPathSql('cp')} AS source_project FROM work_link l JOIN work_item w ON w.id = l.item_id JOIN code_event c ON c.tenant_id = w.tenant_id AND c.kind = 'commit' JOIN project cp ON cp.id = c.project_id AND cp.tenant_id = c.tenant_id WHERE (l.target_ref = (${projectPathSql('cp')}) || CASE WHEN c.repo = '' THEN '' ELSE '/' || c.repo END || '@' || c.target OR (c.project_id = w.project_id AND l.target_ref = c.target)) AND ${eligible} AND l.target_kind = 'commit' AND c.at >= ? AND c.at <= ?`).bind(...args,cutoff,ctx.now),
  ]);
  const all = work!.results as WorkRow[];
  let selected = all;
  if (quest) {
    const q = all.find(w=>w.id===quest || `${slug}#${w.number}`===quest || String(w.number)===quest);
    if (!q || q.kind !== 'quest') throw notFound('no such eligible quest');
    const children = new Set([q.id]);
    for (let size = -1; size !== children.size;) { size = children.size; for (const w of all) if (w.parent_id && children.has(w.parent_id)) children.add(w.id); }
    selected = all.filter(w=>w.id !== q.id && children.has(w.id));
  }
  const items = selected.filter(w=>w.created_at>=since).map(w=>{
    const h = workedIntervals((history!.results as (History & {item_id:string})[]).filter(e=>e.item_id===w.id),w.closed_at ?? ctx.now);
    const u = (usage!.results as Usage[]).filter(u=>u.item_id===w.id);
    return {...w,ref:`${slug}#${w.number}`,...h,worked_ms:h.first_claimed_at===null?null:h.worked_ms,lead_ms:w.closed_at===null?null:w.closed_at-w.created_at,cycle_ms:w.closed_at===null||h.first_claimed_at===null?null:w.closed_at-h.first_claimed_at,
      input_tokens:u.reduce((n,x)=>n+(x.input_tokens??0),0),cached_tokens:u.reduce((n,x)=>n+(x.cached_tokens??0),0),output_tokens:u.reduce((n,x)=>n+(x.output_tokens??0),0),cost_usd:u.some(x=>x.cost_micros!==null)?u.reduce((n,x)=>n+(x.cost_micros??0),0)/1e6:null,usage_calls:u.length,input_known:u.filter(x=>x.input_tokens!==null).length,cached_known:u.filter(x=>x.cached_tokens!==null).length,output_known:u.filter(x=>x.output_tokens!==null).length,unpriced_calls:u.filter(x=>x.cost_micros===null).length,
      commits:(commits!.results as {item_id:string;oid:string;repo:string;summary:string;at:number;source_project:string}[]).filter(c=>c.item_id===w.id)};
  });
  type Item = typeof items[number];
  const rollup = (rows: Item[]) => {
    const done = rows.filter(w=>w.state==='done' && w.closed_at!==null);
    const distribution = (key:'lead_ms'|'cycle_ms'|'worked_ms') => {const values=done.map(w=>w[key]).filter((v):v is number=>v!==null);return {median:percentile(values,.5),p90:percentile(values,.9),known:values.length};};
    return {items:rows.length,closed:done.length,usage_calls:rows.reduce((n,w)=>n+w.usage_calls,0),unpriced_calls:rows.reduce((n,w)=>n+w.unpriced_calls,0),worked_ms:rows.reduce((n,w)=>n+(w.worked_ms??0),0),input_tokens:rows.reduce((n,w)=>n+w.input_tokens,0),cached_tokens:rows.reduce((n,w)=>n+w.cached_tokens,0),output_tokens:rows.reduce((n,w)=>n+w.output_tokens,0),cost_usd:rows.some(w=>w.cost_usd!==null)?rows.reduce((n,w)=>n+(w.cost_usd??0),0):null,lead_ms:distribution('lead_ms'),cycle_ms:distribution('cycle_ms'),worked:distribution('worked_ms')};
  };
  const byQuest = all.filter(w=>w.kind==='quest').map(q=>{
    const ids=new Set([q.id]);for(let size=-1;size!==ids.size;){size=ids.size;for(const w of all)if(w.parent_id&&ids.has(w.parent_id))ids.add(w.id);}
    return {ref:`${slug}#${q.number}`,title:q.title,...rollup(items.filter(w=>w.id!==q.id&&ids.has(w.id)))};
  });
  const period = (weekly:boolean) => {
    const groups = new Map<string,{key:string;closed:number;worked_ms:number;input_tokens:number;cached_tokens:number;output_tokens:number}>();
    const group=(at:number)=>{const date=new Date(at);date.setUTCHours(0,0,0,0);if(weekly)date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));const key=date.toISOString().slice(0,10);if(!groups.has(key))groups.set(key,{key,closed:0,worked_ms:0,input_tokens:0,cached_tokens:0,output_tokens:0});return groups.get(key)!;};
    for(let at=since;at<=ctx.now;at+=86400000)group(at);
    group(ctx.now);
    for(const w of items){if(w.state==='done'&&w.closed_at!==null)group(w.closed_at).closed++;
      for(const i of w.intervals){let at=i.start;while(at<i.end){const next=Math.min(i.end,(Math.floor(at/86400000)+1)*86400000);group(at).worked_ms+=next-at;at=next;}}
    }
    const ids=new Set(items.map(w=>w.id));for(const u of usage!.results as Usage[])if(ids.has(u.item_id)){const g=group(u.at);g.input_tokens+=u.input_tokens??0;g.cached_tokens+=u.cached_tokens??0;g.output_tokens+=u.output_tokens??0;}
    return [...groups.values()].sort((a,b)=>a.key.localeCompare(b.key));
  };
  return {project:slug,velocity_since:cutoff,since,as_of:ctx.now,quest,evidence_key:await sha256Hex(JSON.stringify([since,quest,work!.results,history!.results,usage!.results,commits!.results])),coverage:'Recorded doing intervals only; every claim (including renewals) counts as an attempt, without overlapping time. Lease expiry does not change doing state. Medians and p90 cover done items with known times. Tokens are recorded attributed calls only; unpriced is not free. Priced ledger amounts are estimates or self-reports, not verified charges. Weeks start Monday (UTC).',total:rollup(items),items,by_quest:byQuest,by_kind:['wish','snag','errand'].map(kind=>({kind,...rollup(items.filter(w=>w.kind===kind))})),by_day:period(false),by_week:period(true)};
}
export const velocityRead = defineVerb({
  name:'velocity.read',kind:'query',scope:'tenant',minRole:'reader',freshProofMinutes:null,
  summary:'How long project work takes: claim intervals, lead and cycle times, attempts, linked commits and attributed AI usage; quest, kind, day and week rollups since the cleanup cutoff.',
  mcp:{scope:'read',destructive:false,title:'Velocity',input:{type:'object',properties:{project:{type:'string'},quest:{type:'string',description:'Quest reference, ID or number'},since:{type:'string',description:'ISO date or 7d; never before the project cutoff'}},required:['project'],additionalProperties:false},render:r=>`${DATA_NOTE}\n\n${JSON.stringify(r)}`},
  parse:i=>({project:reqString(i,'project',{max:127}),quest:optString(i,'quest',{max:80}),since:optString(i,'since',{max:80})}),
  run:(ctx,p)=>projectVelocity(ctx,p.project,p.quest,p.since),
});
