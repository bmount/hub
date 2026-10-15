import type { Ctx } from "../auth/context";
import type { Env } from "../env";
import type { SiteRow } from "../verbs/sites";
import { esc, htmlResponse, kitTable, kitTabs, toolbar, workbench, inspectorSection, emptyState } from "../html";
import { shellFor } from "./shell";
import { notFoundPage } from "./pages";
import { deploysStatement, deployView, type DeployRow } from "../apps/deploy";
import { performanceSelection, readPerformance, PerformanceUnavailable, type PerfRow, type PerformanceData, type PerfSelection } from "../apps/performance";
import { SQL_CATALOG, type CodeSite } from "../perfCatalog";
import { sha256Hex } from "../ids";
import { HubError } from "../errors";

const number=(v:unknown)=>Number.isFinite(Number(v))?Number(v):0;
const integerFormat=new Intl.NumberFormat("en-US"),decimalFormat=new Intl.NumberFormat("en-US",{maximumFractionDigits:1});
const count=(v:unknown)=>integerFormat.format(Math.round(number(v)));
const ms=(v:unknown)=>`${decimalFormat.format(number(v))}\u00a0ms`;
const titles={routes:"Routes",verbs:"Verbs",tools:"MCP tools",interactions:"Interactions",spinners:"Spinners",background:"Background",deploys:"Version comparison"};
type Version={id:string;worker:string;commit:string|null;repository?:string};
function source(value:unknown):CodeSite|null {
  try {const s=JSON.parse(String(value));return s && /^(src|git-proxy)\/[a-zA-Z0-9_./-]+\.ts$/.test(s.file) && !s.file.includes("..") && typeof s.fn==="string" && s.fn.length<200 && Number.isInteger(s.line) && s.line>0 ? s:null;} catch {return null;}
}
function codeLink(site:SiteRow, versions:Version[], version:string, location:CodeSite|null):string {
  const commit=versions.find(v=>v.id===version)?.commit;
  if(!location) return '';
  const label=`${location.file}:${location.line} · ${location.fn}`;
  if(!commit) return `${esc(label)} <span class="lede">(commit unknown)</span>`;
  const q=new URLSearchParams({ref:commit,f:location.file,path:location.file.split("/").slice(0,-1).join("/")});
  return `<a href="/${esc(encodeURIComponent(site.project))}/files?${esc(q.toString())}#L${location.line}">${esc(label)}</a>`;
}
export function sparkline(rows:PerfRow[]):string {
  if(!rows.length) return '<span class="lede">—</span>';
  const values=rows.map(r=>number(r.p50)), max=Math.max(1,...values);
  const first=number(rows[0]!.bucket),last=number(rows.at(-1)!.bucket);
  const points=values.map((v,i)=>`${(96*(number(rows[i]!.bucket)-first)/Math.max(1,last-first)).toFixed(1)},${(22-v*20/max).toFixed(1)}`).join(" ");
  const plot=rows.length===1?`<circle cx="48" cy="${(22-values[0]!*20/max).toFixed(1)}" r="2" fill="var(--accent)"/>`:`<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  return `<svg class="perf-spark" viewBox="0 0 100 24" width="100" height="24" role="img" aria-label="Median latency over time"><title>${rows.length===1?"One observed time bucket: ":""}${esc(values.map(ms).join(", "))}</title>${plot}</svg>`;
}
function stacked(segments:Array<{name:string;value:number;recorded?:boolean}>):string {
  const total=segments.reduce((n,s)=>n+s.value,0);if(!total) return `<span class="lede">${segments.some(s=>s.recorded!==false)?"0 ms attributed":"Breakdown not recorded"}</span>`;
  let x=0;
  return `<svg class="perf-stack" viewBox="0 0 300 18" width="100%" height="18" role="img" aria-label="${esc(segments.map(s=>`${s.name}: ${s.recorded===false?"Not recorded":ms(s.value)}`).join(", "))}">${segments.filter(s=>s.value>0).map((s,i)=>{const width=300*s.value/total,rect=`<rect x="${x.toFixed(2)}" y="1" width="${width.toFixed(2)}" height="16" fill="var(--accent)" opacity="${(0.25+0.75*(i%8)/7).toFixed(2)}"><title>${esc(s.name)}: ${ms(s.value)}</title></rect>`;x+=width;return rect;}).join("")}</svg>`;
}
export function routeBreakdown(data:PerformanceData,label:string):Array<{name:string;value:number;recorded:boolean}> {
  const rows=data.breakdown.filter(r=>r.label===label), roots=rows.filter(r=>r.kind==="request"), n=roots.reduce((v,r)=>v+number(r.n),0);
  if(!n) return [];
  const values:Record<string,number>={"Auth":0,"D1 transport / queue":0,"D1 execution":0,"D1 without execution metadata":0,"Durable Objects":0,"External calls":0,"Server render":0,"Other server":0},seen=new Set<string>();
  for(const r of rows.filter(r=>r.kind!=="request")) {
    const name=String(r.name), wall=number(r.attributed)/n;
    if(name.startsWith("d1.")) {
      const known=number(r.known_wall)/n,execution=Math.min(known,number(r.execution)/n);
      values["D1 execution"]!+=execution;values["D1 transport / queue"]!+=Math.max(0,known-execution);values["D1 without execution metadata"]!+=Math.max(0,wall-known);
      if(number(r.execution_n)>0) {seen.add("D1 execution");seen.add("D1 transport / queue");}
      if(number(r.execution_n)<number(r.n)) seen.add("D1 without execution metadata");
    } else {
      const category=name.startsWith("auth.")?"Auth":name.startsWith("do.")?"Durable Objects":/^(fetch\.|GIT_PROXY\.|ARDI\.|MAIL\.)/.test(name)?"External calls":name.startsWith("render.")?"Server render":"Other server";
      values[category]!+=wall;seen.add(category);
    }
  }
  // Detail sampling can represent different populations; never claim more than the root wall.
  const rootWall=roots.reduce((sum,r)=>sum+number(r.root_wall),0)/n;
  const attributed=Object.values(values).reduce((sum,v)=>sum+v,0);
  if(rootWall>0&&attributed>rootWall) for(const key of Object.keys(values)) values[key]!*=rootWall/attributed;
  values["Unattributed server"]=Math.max(0,rootWall-Object.values(values).reduce((sum,v)=>sum+v,0));
  seen.add("Unattributed server");
  const browser=data.browser.filter(r=>r.label===label);
  // Client and server residuals have already been joined by authorized request ID.
  const mean=(rs:PerfRow[])=>{const weight=rs.reduce((n,r)=>n+number(r.n),0);return weight?rs.reduce((n,r)=>n+number(r.mean)*number(r.n),0)/weight:0;};
  const network=mean(browser.filter(r=>r.phase==="network"));
  const paint=mean(browser.filter(r=>r.phase==="render"));
  const segments=Object.entries(values).map(([name,value])=>({name,value,recorded:seen.has(name)}));
  segments.unshift({name:"Browser network residual",value:network,recorded:browser.some(r=>r.phase==="network")});
  segments.push({name:"Browser render / ready",value:paint,recorded:browser.some(r=>r.phase==="render")});
  return segments;
}
function metricsTable(label:string,rows:PerfRow[],client=false):string {
  return rows.length?kitTable(label,[{label:"Group"},{label:"p50"},{label:"p95"},{label:"p99"},{label:"Count"},{label:"Errors"}],rows.map(r=>({cells:[{html:`<span title="${esc(String(r.label??"Unknown"))}">${esc(label==="version"?String(r.label??"Unknown").slice(0,8):String(r.label??"Unknown"))}</span>`},{html:ms(r.p50)},{html:ms(r.p95)},{html:ms(r.p99)},{html:count(r.n)},{html:client?"Not collected":`${number(r.errors).toFixed(1)}%`}]}))):`<p class="lede">${esc(label)}: none</p>`;
}
export function performanceMarkup(site:SiteRow,s:PerfSelection,data:PerformanceData,versions:Version[],href:(changes:Record<string,string|null>)=>string, loadingUrl?:string):{list:string;inspector:string|null} {
  const client=s.kind==="interactions"||s.kind==="spinners";
  const controls=kitTabs("Performance views",Object.entries(titles).map(([kind,label])=>({label,href:href({kind,selected:null,request:null}),current:s.kind===kind})))+kitTabs("Time range",[[1,"1 h"],[24,"24 h"],[168,"7 d"]].map(([hours,label])=>({label:String(label),href:href({hours:String(hours),selected:null,request:null}),current:s.hours===hours})))+kitTabs("Traffic population",[[false,"All organizations"],[true,"Only my org"]].map(([mine,label])=>({label:String(label),href:href({only_my_org:String(mine),request:null}),current:!!s.onlyMyOrg===mine})));
  const hidden=`<input type="hidden" name="site" value="${esc(site.name)}"><input type="hidden" name="project" value="${esc(site.project)}"><input type="hidden" name="view" value="performance"><input type="hidden" name="kind" value="${s.kind}"><input type="hidden" name="hours" value="${s.hours}"><input type="hidden" name="only_my_org" value="${!!s.onlyMyOrg}">`;
  const selectable=s.kind==="deploys"?versions.filter(v=>v.worker===versions.find(v=>v.id===s.version)?.worker):versions;
  const versionSelect=(name:string,selected:string,all:boolean)=>`<label>${name==="previous"?"Previous version":"Version"} <select name="${name}" aria-label="${name==="previous"?"Previous version":"Version"}">${all?'<option value="">All versions</option>':""}${selectable.map(v=>`<option value="${esc(v.id)}"${v.id===selected?" selected":""}>${esc(v.worker)}${v.repository ? ` · ${esc(v.repository)}` : ""} · ${esc(v.id.slice(0,8))}${v.commit?` · ${esc(v.commit.slice(0,7))}`:""}</option>`).join("")}</select></label>`;
  let list=`<div class="perf-view"><div class="head"><h1>Performance</h1><span>${esc(site.name)}</span></div>${toolbar("Performance filters",controls,`<form method="get">${hidden}${versionSelect("version",s.version,s.kind!=="deploys")}${s.kind==="deploys"?versionSelect("previous",s.previous,false):""}<button class="quiet" type="submit">Compare / apply</button><input data-filter name="filter" aria-label="Filter the list" placeholder="Filter these (/)" size="16"></form>`)}<p class="lede">${esc(titles[s.kind])} · ${s.hours===168?"7 d":`${s.hours} h`} · ${s.onlyMyOrg?"Only my org":"All organizations"} · longest total wait first <span title="All traffic on this site's active registered apps; no organization identities are exposed. Analytics Engine sampling is weighted in every count, quantile and distribution; cached for 60 seconds. Quantiles are approximate; counts are represented events. At most 200 groups. Browser versions/colos identify beacon reception, not necessarily the origin response.">ⓘ</span></p>`;
  if(s.kind==="deploys") {
    const labels=[...new Set(data.comparison.map(r=>String(r.label)))];
    const rows=labels.map(label=>({label,current:data.comparison.find(r=>r.label===label&&r.version===s.version),previous:data.comparison.find(r=>r.label===label&&r.version===s.previous)})).sort((a,b)=>number(b.current?.p95)-number(a.current?.p95));
    list+=rows.length?kitTable("Version comparison",[{label:"Route"},{label:"Previous p95"},{label:"Version p95"},{label:"Delta"},{label:"Counts"}],rows.map(r=>({href:href({selected:r.label,request:null}),selected:s.selected===r.label,cells:[{html:`<a href="${esc(href({selected:r.label,request:null}))}"><code>${esc(r.label)}</code></a>`},{html:r.previous?ms(r.previous.p95):"No samples"},{html:r.current?ms(r.current.p95):"No samples"},{html:r.current&&r.previous?`${number(r.current.p95)-number(r.previous.p95)>=0?"+":""}${ms(number(r.current.p95)-number(r.previous.p95))} (${number(r.previous.p95)?((number(r.current.p95)/number(r.previous.p95)-1)*100).toFixed(1)+"%":"—"})`:"—"},{html:`${count(r.previous?.n)} → ${count(r.current?.n)}`}]}))):emptyState("No version comparison yet","Choose two recorded versions with traffic in this time range.",{label:"Recorded deploys",href:`/apps?site=${encodeURIComponent(site.name)}&project=${encodeURIComponent(site.project)}&view=deploys`});
  } else {
    list+=data.overview.length?kitTable(titles[s.kind],[{label:s.kind==="spinners"?"Trigger":s.kind==="routes"?"Route":"Name"},{label:s.kind==="interactions"?"Ready p50":"p50"},{label:"p95"},{label:"p99",className:"hide-s"},{label:"Count"},{label:"Errors",className:"hide-s"},{label:"4xx",className:"hide-s"},...(s.kind==="interactions"?[{label:"Fetch"},{label:"Pane ready"},{label:"Paint"}]:[]),{label:s.kind==="spinners"?"Time shown":"Total wait",className:"hide-s"},{label:"Trend",className:"hide-s"}],data.overview.map(r=>({href:href({selected:String(r.label),request:null}),selected:s.selected===r.label,cells:[{html:`<a href="${esc(href({selected:String(r.label),request:null}))}"><code title="${esc(String(r.label))}">${esc(String(r.label)).replaceAll("/","/<wbr>")}</code></a>${s.kind==="routes"?(loadingUrl?'<span class="lede" data-performance-pending>Attribution loading…</span>':stacked(routeBreakdown(data,String(r.label)))):""}`},{html:ms(r.p50)},{html:ms(r.p95)},{html:ms(r.p99),className:"hide-s"},{html:count(r.n)},{html:client?"Not collected":`${number(r.errors).toFixed(1)}%`,className:"hide-s"},{html:client?"—":count(r.client_errors),className:"hide-s"},...(s.kind==="interactions"?['fetch','render','paint'].map(phase=>({html:loadingUrl?'<span data-performance-pending>Loading…</span>':r[phase]===undefined?"Not recorded":ms(r[phase])})):[]),{html:ms(r.total),className:"hide-s"},{html:loadingUrl?'<span data-performance-pending>Loading…</span>':sparkline(data.spark.filter(p=>p.label===r.label)),className:"hide-s"}]}))):emptyState("No performance data yet","No measured events for this site's active apps in this time range.",{label:"Try 7 days",href:href({hours:"168",selected:null,request:null})});
  }
  list+='</div>';
  if(s.kind==="interactions") list+='<p class="lede">Ranked by click → ready. Older paint-only observations are omitted; phase columns are recorded means joined to up to 2,000 recent ready observations.</p>';
  if(!s.selected) return {list,inspector:null};
  const row=data.overview.find(r=>r.label===s.selected) ?? data.comparison.find(r=>r.label===s.selected&&r.version===s.version);
  let inspector=`<div class="perf-view"><a class="back" href="${esc(href({selected:null,request:null}))}">‹ ${esc(titles[s.kind])}</a><div class="head"><span>${esc(titles[s.kind])}</span><span>${s.hours===168?"7 d":`${s.hours} h`}</span></div><h1><code>${esc(s.selected)}</code></h1>${row?inspectorSection("Latency",[{label:"p50 / p95 / p99",html:`${ms(row.p50)} / ${ms(row.p95)} / ${ms(row.p99)}`},{label:"Represented events",html:count(row.n)},{label:"Error rate (5xx / failed / aborted)",html:client?"Not collected":`${number(row.errors).toFixed(1)}%`},{label:"4xx responses",html:client?"Not collected":count(row.client_errors)} ]):'<p class="lede">No samples for this selection.</p>'}`;
  if(loadingUrl) {
    const sections=[...(s.kind==="routes"?["Where the time goes"]:s.kind==="spinners"?["What triggered this wait"]:[]),"Latency histogram","Cold / warm isolates","Auth kind","Colo","Version","Slowest sampled exemplars","Slowest D1 statements","Request waterfall"];
    inspector+=`<section data-performance-load="${esc(loadingUrl)}" aria-busy="true" aria-label="Performance details">${sections.map(label=>`<h2>${label}</h2><p class="lede" role="status">Loading…</p>`).join("")}<a data-reload href="${esc(loadingUrl)}">Load full details</a></section>`;
    return {list,inspector:inspector+'</div>'};
  }
  if(s.kind==="spinners") inspector+=`<h2>What triggered this wait</h2>${data.triggers.length?kitTable("Spinner triggers",[{label:"From → route"},{label:"Count"},{label:"Time shown"}],data.triggers.map(r=>({cells:[{html:`<code>${esc(String(r.previous))} → ${esc(String(r.label))}</code>`},{html:count(r.n)},{html:ms(r.total)}]}))):'<p class="lede">Triggers: none</p>'}`;
  const segments=routeBreakdown(data,s.selected);
  if(s.kind==="routes") inspector+=`<h2>Where the time goes</h2>${stacked(segments)}${segments.length?inspectorSection("Mean attributed work",segments.map(r=>({label:r.name,html:r.recorded?ms(r.value):"Not recorded"}))):""}<p class="lede" title="Only v2 server samples have exclusive time. Older points are omitted, not zero. D1 transport includes queueing. Deepest active spans share concurrent intervals; Unattributed server includes gaps and missing detail. Up to 200 recent trips per route are summed in SQL, then each is capped at its dispatched root before route aggregation; no global trip-row truncation. The allocation is not proof of a causal critical path. Browser residuals join client and server by authorized request ID (at most 5,000 grouped points); missing roots are omitted. Network residual includes browser queues/body decoding and streaming server work after dispatch. Render means post-response page or pane readiness, not isolated CPU. Missing client timing is not zero.">Attribution and browser residual estimates ⓘ</p>`;
  const bins=["<10 ms","10–25 ms","25–50 ms","50–100 ms","100–250 ms","250–500 ms","0.5–1 s","1–2.5 s","2.5–5 s","≥5 s"],max=Math.max(1,...data.histogram.map(r=>number(r.n)));
  inspector+=`<h2>Latency histogram</h2>${data.histogram.length?kitTable("Weighted latency histogram",[{label:"Latency"},{label:"Events"}],data.histogram.map(r=>({cells:[{html:esc(bins[number(r.bucket)]??"Unknown")},{html:`${count(r.n)} <svg viewBox="0 0 100 8" width="100" height="8" aria-hidden="true"><rect width="${(100*number(r.n)/max).toFixed(2)}" height="8" fill="var(--accent)"/></svg>`}]}))):'<p class="lede">Histogram: none</p>'}`;
  if(client) inspector+='<p class="lede" title="Split metrics use up to 2,000 recent weighted client points, joined to authorized origin request metadata. Missing server roots remain Unknown; beacon reception metadata is not substituted. Statement details are from the five exemplars.">Origin request splits · bounded sample ⓘ</p>';
  for(const [name,rows] of Object.entries(data.splits)) inspector+=`<h2>${name==="isolate"?"Cold / warm isolates":name==="auth"?"Auth kind":name==="colo"?"Colo":"Version"}</h2>${metricsTable(name,rows.map(r=>({...r,label:name==="isolate"?(r.label==="Unknown"?"Unknown":number(r.label)?"Cold":"Warm"):r.label||"Unknown"})),client)}`;
  if(data.sql.some(r=>!r.code&&!r.source)||data.waterfall.some(r=>number(r.schema)!==2&&r.kind!=="client")) inspector+='<p class="lede">Some observations in this window predate the source catalog and timed waterfalls. Prefer fresh exemplars; older observations have no recorded source or start.</p>';
  inspector+=`<h2>Slowest D1 statements</h2>${data.sql.length?data.sql.map(r=>{const catalog=SQL_CATALOG[String(r.code)]??SQL_CATALOG[String(r.fingerprint)],loc=source(r.source);return `<details><summary><code>${esc(String(r.fingerprint))}</code> · p95 ${ms(r.p95)} · ${count(r.n)} calls${catalog?` · ${esc(catalog.text.slice(0,100))}`:""} ${codeLink(site,versions,String(r.version),loc??catalog?.sites[0]??null)}</summary>${catalog?`${catalog.template?'<p class="lede">Source SQL template / expression; runtime values are not exported.</p>':""}<pre>${esc(catalog.text)}</pre>`:''}<p>${codeLink(site,versions,String(r.version),loc)}</p>${!loc&&catalog?catalog.sites.map(c=>`<p>${codeLink(site,versions,String(r.version),c)}</p>`).join(""):""}</details>`;}).join(""):'<p class="lede">D1 statements: none</p>'}`;
  inspector+=`<h2>Slowest sampled exemplars</h2>${data.exemplars.length?kitTable("Slowest exemplars",[{label:"Request"},{label:"Duration"}],data.exemplars.map(r=>({href:href({request:String(r.request)}),selected:s.request===r.request,cells:[{html:`<a href="${esc(href({request:String(r.request)}))}"><code>${esc(String(r.request).slice(0,8))}</code></a>`},{html:ms(r.duration)}]}))):'<p class="lede">Exemplars: none</p>'}`;
  if(data.waterfall.length) {
    const server=data.waterfall.filter(r=>number(r.schema)===2&&number(r.started)>0),start=server.length?Math.min(...server.map(r=>number(r.started))):0,end=server.length?Math.max(...server.map(r=>number(r.started)+number(r.duration))):Math.max(1,...data.waterfall.map(r=>number(r.duration))),width=Math.max(1,end-start);
    inspector+=`<h2>Request waterfall</h2><p><code title="${esc(String(data.waterfall[0]!.request))}">${esc(String(data.waterfall[0]!.request).slice(0,8))}</code></p><p class="lede" title="Sampled exemplars are not a complete request log. Missing roots/parents are possible. Server start timestamps have clock-resolution uncertainty across isolates. Client lanes share the authorized request ID; browser clocks are untrusted and may differ from server clocks. Older points have no start timestamp.">Joined by request ID · sampled, possibly incomplete ⓘ</p>${data.waterfall.map(r=>{const timed=number(r.schema)===2&&number(r.started)>0,offset=timed?Math.max(0,number(r.started)-start):0;return `<div class="perf-waterfall"><strong>${esc(String(r.name))}</strong> <span>${ms(r.duration)}${number(r.complete)===0?" · incomplete":""}${!timed?"":` · +${ms(offset)}`}</span><svg viewBox="0 0 300 12" width="100%" height="12" role="img" aria-label="${esc(String(r.name))}: ${ms(r.duration)}"><rect x="${timed?(offset*300/width).toFixed(2):"0"}" width="${Math.min(300,number(r.duration)*300/width).toFixed(2)}" height="12" fill="var(--accent)" opacity="${r.kind==="client"?"0.4":"1"}"/></svg><small>${r.kind==="client"?`Browser ${esc(String(r.phase))} · `:""}${codeLink(site,versions,String(r.version),source(r.source))}</small></div>`;}).join("")}`;
  } else inspector+='<p class="lede">Waterfall: no retained points</p>';
  return {list,inspector:inspector+'</div>'};
}
export async function performancePage(request:Request,env:Env,ctx:Ctx,site:SiteRow,extra:Record<string,string>):Promise<Response> {
  const url=new URL(request.url);
  let s:PerfSelection;
  try {s=performanceSelection(url.searchParams);} catch {return notFoundPage(extra);}
  const deployments=(await deploysStatement(ctx,site.project,site.id).all<DeployRow>()).results;
  const versions:Version[]=[];
  for(const row of deployments) {const view=deployView(row),id=view.release?.version;if(typeof id==="string"&&!versions.some(v=>v.id===id)) versions.push({id,worker:row.script_name,commit:view.commitRef?.split("@")[1]??null,repository:(row.repository_count ?? 0)>1 ? row.repo || row.default_repository : undefined});}
  if((s.version&&!versions.some(v=>v.id===s.version)) || (s.previous&&!versions.some(v=>v.id===s.previous))) return notFoundPage(extra);
  if(s.kind==="deploys") {
    const current=versions.find(v=>v.id===s.version)??versions.find(v=>v.worker==="pimwell-hub")??versions[0];
    s.version ||= current?.id??"";
    s.previous ||= versions.slice(versions.findIndex(v=>v.id===s.version)+1).find(v=>v.worker===current?.worker)?.id??"";
    if(s.previous&&versions.find(v=>v.id===s.previous)?.worker!==current?.worker) return notFoundPage(extra);
  }
  const full=url.searchParams.get("details")==="1";
  const fragment=request.headers.get("x-performance-details")==="1";
  const progressive=!!s.selected&&!full;
  const href=(changes:Record<string,string|null>)=>{const q=new URLSearchParams(url.searchParams);q.delete("details");q.set("project",site.project);q.set("site",site.name);q.set("view","performance");q.set("kind",s.kind);q.set("hours",String(s.hours));if(s.version)q.set("version",s.version);if(s.previous)q.set("previous",s.previous);for(const [k,v] of Object.entries(changes))v===null?q.delete(k):q.set(k,v);return `/apps?${q}`;};
  let markup:{list:string;inspector:string|null}, listDigest="unavailable";
  try {
    const data=await readPerformance(ctx,site,s,false,progressive);
    if(s.selected&&!(s.kind==="deploys"?data.comparison:data.overview).some(r=>r.label===s.selected)) return notFoundPage(extra);
    listDigest=await sha256Hex(JSON.stringify([data.overview,data.spark,data.breakdown,data.browser,data.comparison,versions]));
    markup=performanceMarkup(site,s,data,versions,href,progressive?href({details:"1"}):undefined);
  } catch(e) {
    if(e instanceof HubError && e.status===404) return notFoundPage(extra);
    if(!(e instanceof PerformanceUnavailable)) throw e;
    markup={list:`<div class="head"><h1>Performance</h1><span>${esc(site.name)}</span></div>${emptyState("Performance unavailable",e.message,{label:"Try again",href:href({})})}`,inspector:null};
  }
  if(full&&fragment) return Response.json(markup,{headers:{...extra,"cache-control":"private, no-store"}});
  const digest=await sha256Hex(JSON.stringify(markup));
  return htmlResponse(workbench("Performance",{...markup,stackOnPhone:true,listKey:`performance:${site.id}:${s.kind}:${s.hours}:${s.version}:${s.previous}:${listDigest}`,inspectorKey:s.selected?`performance:${site.id}:${s.selected}:${s.request}:${digest}`:""},shellFor(ctx,env,"apps","apps")!),200,extra);
}
