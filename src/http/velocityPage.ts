import type { Env } from "../env";
import { buildContext } from "../auth/context";
import { esc, htmlResponse, inspectorSection, kitTable, toolbar, utcTime, workbench } from "../html";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { projectVelocity } from "../verbs/velocity";
import { sha256Hex } from "../ids";

const duration = (ms: number | null) => ms === null ? '—' : ms < 3_600_000 ? `${(ms/60_000).toFixed(0)} min` : `${(ms/3_600_000).toFixed(1)} h`;
const numbers = new Intl.NumberFormat('en-US');
const count = (n: number) => numbers.format(n);
export async function velocityPage(request: Request, env: Env, slug: string) {
  const ctx = await buildContext(request,env);
  if(ctx.host.kind!=='tenant'||!ctx.tenant||!ctx.role||!ctx.identity)return notFoundPage();
  const url=new URL(request.url);
  let v;
  try {v=await projectVelocity(ctx,slug,url.searchParams.get('quest'),url.searchParams.get('since'));}catch(e){if(e instanceof HubError&&[400,404].includes(e.status))return notFoundPage();throw e;}
  const href=(work:string)=>{const u=new URL(url);u.searchParams.set('work',work);return u.pathname+u.search;};
  const selected=v.items.find(w=>w.ref===url.searchParams.get('work'));
  const total=v.total;
  const max=Math.max(1,...v.by_day.map(d=>d.closed));
  const chart=`<svg viewBox="0 0 720 95" role="img" aria-label="Items closed per UTC day"><title>Items closed per UTC day</title>${v.by_day.map((d,i)=>{const width=700/Math.max(1,v.by_day.length),height=d.closed/max*50,x=10+(i+.5)*width,bar=Math.min(28,Math.max(1,width-3));return `<rect x="${x-bar/2}" y="${70-height}" width="${bar}" height="${height}" fill="currentColor"><title>${esc(d.key)}: ${d.closed} closed</title></rect>${d.closed?`<text x="${x}" y="${64-height}" text-anchor="middle" font-size="10">${d.closed}</text>`:''}${i%Math.max(1,Math.ceil(v.by_day.length/10))===0?`<text x="${x}" y="90" text-anchor="middle" font-size="9">${esc(d.key.slice(5))}</text>`:''}`;}).join('')}</svg>`;
  const rollups=kitTable('Velocity by kind',[{label:'Kind'},{label:'Closed'},{label:'Worked median / p90'},{label:'Lead median / p90'},{label:'Cycle median / p90'}],v.by_kind.map(k=>({cells:[{html:esc(k.kind)},{html:String(k.closed)},{html:`${duration(k.worked.median)} / ${duration(k.worked.p90)}`},{html:`${duration(k.lead_ms.median)} / ${duration(k.lead_ms.p90)}`},{html:`${duration(k.cycle_ms.median)} / ${duration(k.cycle_ms.p90)}`}]})));
  const list=`<div class="head"><h1>Velocity</h1><span>${total.closed} closed</span></div>
<p class="lede">Starts ${utcTime(v.since)} · only items filed since this date.</p>
${toolbar('Velocity filters','',`<form method="get" class="wb-actions"><label>Since <input name="since" size="14" value="${esc(url.searchParams.get('since')??'')}" placeholder="Cleanup cutoff"></label> <label>Quest <input name="quest" size="12" value="${esc(v.quest??'')}" placeholder="project#n"></label> <button>Apply</button></form>`)}
<p><strong>${duration(total.worked.median)}</strong> median worked · <strong>${duration(total.lead_ms.median)}</strong> median lead · <strong>${duration(total.cycle_ms.median)}</strong> median cycle · ${count(total.input_tokens)} input (${count(total.cached_tokens)} cached) · ${count(total.output_tokens)} output · ${total.cost_usd===null?'Unpriced':`$${total.cost_usd.toFixed(2)} priced`} (${total.unpriced_calls} unpriced calls)</p>
${chart}
${kitTable('Velocity items',[{label:'Item'},{label:'Worked'},{label:'Lead'},{label:'Cycle'},{label:'Attempts'},{label:'Input / cached'},{label:'Output'}],v.items.map(w=>({href:href(w.ref),selected:w.ref===selected?.ref,cells:[{html:`<a href="${esc(href(w.ref))}">${esc(w.ref)} ${esc(w.title)}</a><small> · ${esc(w.state)}</small>`},{html:duration(w.worked_ms)},{html:duration(w.lead_ms)},{html:duration(w.cycle_ms)},{html:String(w.attempts)},{html:`${count(w.input_tokens)} / ${count(w.cached_tokens)}`},{html:count(w.output_tokens)}].map((cell,index)=>({...cell,className:index?'wb-num':undefined}))})))}
<h2>By kind · done items</h2>${rollups}
<h2>Quests · descendants</h2>${kitTable('Quest velocity',[{label:'Quest'},{label:'Closed / items'},{label:'Worked total / median'},{label:'Lead median'},{label:'Input tokens'}],v.by_quest.map(q=>({cells:[{html:`${esc(q.ref)} ${esc(q.title)}`},{html:`${q.closed} / ${q.items}`},{html:`${duration(q.worked_ms)} / ${duration(q.worked.median)}`},{html:duration(q.lead_ms.median)},{html:count(q.input_tokens)}]})))}
${[ ['day',v.by_day],['week',v.by_week] ].map(([name,rows])=>`<h2>By ${name} · UTC</h2>${kitTable(`Velocity by ${name}`,[{label:'Period'},{label:'Closed'},{label:'Hours worked'},{label:'Input / cached'},{label:'Output'}],(rows as typeof v.by_day).map(d=>({cells:[{html:esc(d.key)},{html:String(d.closed)},{html:(d.worked_ms/3_600_000).toFixed(1)},{html:`${count(d.input_tokens)} / ${count(d.cached_tokens)}`},{html:count(d.output_tokens)}]})))}`).join('')}
<p class="lede">${esc(v.coverage)}</p>`;
  const inspector=selected?`<h1>${esc(selected.ref)} ${esc(selected.title)}</h1>${inspectorSection('Timing',[{label:'Lead',html:duration(selected.lead_ms)},{label:'Cycle',html:duration(selected.cycle_ms)},{label:'Worked',html:duration(selected.worked_ms)},{label:'Attempts',html:String(selected.attempts)},{label:'Workers',html:esc(selected.workers.join(', ')||'No recorded claims')}])}${inspectorSection('AI usage',[{label:'Input',html:count(selected.input_tokens)},{label:'Of which cached',html:count(selected.cached_tokens)},{label:'Output',html:count(selected.output_tokens)},{label:'Priced cost (USD)',html:selected.cost_usd===null?'Unpriced':`$${selected.cost_usd.toFixed(2)}`},{label:'Coverage',html:`${selected.usage_calls} recorded calls; ${selected.unpriced_calls} unpriced. Token counts known: ${selected.input_known} input / ${selected.cached_known} cached / ${selected.output_known} output.`}])}<h3>Linked commits since cutoff</h3><ul>${selected.commits.map(c=>`<li><a href="/${esc(c.source_project)}/code?c=${esc(encodeURIComponent(c.oid))}${c.repo?`&amp;repo=${esc(encodeURIComponent(c.repo))}`:''}"><code>${esc(c.oid.slice(0,12))}</code> ${esc(c.summary)}</a></li>`).join('')}</ul><p><a href="/${esc(slug)}/w/${selected.number}">Open item</a></p>`:'';
  return htmlResponse(workbench(`${slug}: velocity`,{list,listKey:`velocity:${slug}:${v.evidence_key}`,inspector:selected?inspector:null,inspectorKey:selected?`${selected.ref}:${await sha256Hex(inspector)}`:undefined},shellFor(ctx,env,'project',slug)!),200);
}
