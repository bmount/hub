import type { Ctx } from "../auth/context";
import { tenantHash } from "../perf";
import type { SiteRow } from "../verbs/sites";
import { badRequest, notFound } from "../errors";

export type PerfRow = Record<string,string|number>;
export type PerfKind = "routes"|"verbs"|"tools"|"interactions"|"spinners"|"background"|"deploys";
export type PerfSelection = {kind:PerfKind;hours:1|24|168;selected:string;version:string;previous:string;request:string;onlyMyOrg?:boolean};
const dimensions = {routes:"blob8",background:"blob8",verbs:"substring(blob14,6)",tools:"substring(blob14,5)",interactions:"blob14",spinners:"blob14",deploys:"blob8"} as const;
export function performanceSelection(params:URLSearchParams):PerfSelection {
  const kind=params.get("kind")??"routes", hours=Number(params.get("hours")??24);
  if (!Object.hasOwn(dimensions,kind) || ![1,24,168].includes(hours)) throw badRequest("invalid performance view");
  const selected=params.get("selected")??"",version=params.get("version")??"",previous=params.get("previous")??"",request=params.get("request")??"";
  if(selected.length>200 || [version,previous].some(v=>v && !/^[a-zA-Z0-9-]{1,64}$/.test(v)) || (request && !/^[0-9a-f-]{36}$/.test(request))) throw badRequest("invalid performance selection");
  const onlyMyOrg=params.get("only_my_org")??"false";
  if(!["true","false"].includes(onlyMyOrg)) throw badRequest("invalid performance population");
  return {kind:kind as PerfKind,hours:hours as 1|24|168,selected,version,previous,request,onlyMyOrg:onlyMyOrg==="true"};
}
export const weightedMetrics = `SUM(_sample_interval) AS n,
  quantileWeighted(0.5)(double1, _sample_interval) AS p50,
  quantileWeighted(0.95)(double1, _sample_interval) AS p95,
  quantileWeighted(0.99)(double1, _sample_interval) AS p99,
  SUM(IF(blob10 = '5xx' OR double5 = 1 OR double14 = 0, 1.0, 0.0) * _sample_interval) / SUM(_sample_interval) * 100 AS errors,
  SUM(IF(blob10 = '4xx', _sample_interval, 0)) AS client_errors,
  SUM(double1 * _sample_interval) AS total`;
const quote = (s:string) => `'${s.replace(/\\/g,"\\\\").replace(/'/g,"''")}'`;
const cache=new Map<string,{until:number;rows:PerfRow[];bytes:number}>();
let cacheBytes=0;
export function clearPerformanceCache():void {cache.clear();cacheBytes=0;}
export class PerformanceUnavailable extends Error {}
export async function analyticsQuery(ctx:Pick<Ctx,"env">, sql:string):Promise<PerfRow[]> {
  const account=ctx.env.ARTIFACTS_ACCOUNT_ID, token=ctx.env.PERF_ANALYTICS_TOKEN;
  if(!account || !/^[0-9a-f]{32}$/.test(account) || !token) throw new PerformanceUnavailable("Performance reporting is not connected.");
  for(const [key,value] of cache) if(value.until<=Date.now()) {cache.delete(key);cacheBytes-=value.bytes;}
  const key=account+":"+sql, hit=cache.get(key);
  if(hit) return hit.rows;
  let response:Response;
  try {
    response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"text/plain"},body:sql,signal:AbortSignal.timeout(10_000)});
  } catch {throw new PerformanceUnavailable("Performance reporting is temporarily unavailable.");}
  if(!response.ok) throw new PerformanceUnavailable("Performance reporting is temporarily unavailable.");
  let payload:{data?:unknown};
  try {payload=await response.json() as {data?:unknown};} catch {throw new PerformanceUnavailable("Performance reporting returned an invalid result.");}
  if(!payload || !Array.isArray(payload.data) || payload.data.length>5000 || payload.data.some(r=>!r || typeof r!=="object" || Object.values(r).some(v=>typeof v!=="string" && typeof v!=="number"))) throw new PerformanceUnavailable("Performance reporting returned an invalid result.");
  const rows=payload.data as PerfRow[];
  const bytes=JSON.stringify(rows).length*2;
  if(bytes<=4_000_000) {
    const replaced=cache.get(key);if(replaced){cacheBytes-=replaced.bytes;cache.delete(key);}
    while(cache.size && (cache.size>=128 || cacheBytes+bytes>8_000_000)) {const oldest=cache.keys().next().value!;cacheBytes-=cache.get(oldest)!.bytes;cache.delete(oldest);}
    cacheBytes+=bytes;cache.set(key,{until:Date.now()+60_000,rows,bytes});
  }
  return rows;
}
export type PerfScope = {where:string;scripts:string[]};
/** SQL credentials are account-wide; product authorization is checked before every cache lookup. */
export async function performanceScope(ctx:Ctx, site:SiteRow, hours:number, onlyMyOrg=false):Promise<PerfScope> {
  if(!ctx.tenant || !ctx.identity || !ctx.role || site.tenant_id!==ctx.tenant.id || (ctx.mcpProject && ctx.mcpProject.id!==site.project_id)) throw notFound("no such site");
  // Recheck membership before cached reads; account-wide root powers do not substitute for it.
  if(!await ctx.db.prepare("/*perf-site:src%2Fapps%2Fperformance.ts:58:13:performanceScope:2d1e104e*/ SELECT 1 FROM membership WHERE identity_id = ? AND tenant_id = ? AND state = 'active'").bind(ctx.identity.id,ctx.tenant.id).first()) throw notFound("no such site");
  const project=await ctx.db.prepare("/*perf-site:src%2Fapps%2Fperformance.ts:59:23:performanceScope:e8c7cd55*/ SELECT id FROM project WHERE id = ? AND tenant_id = ? AND kind = 'repo' AND state = 'active'").bind(site.project_id,ctx.tenant.id).first();
  if(!project) throw notFound("no such site");
  const scripts=(await ctx.db.prepare(`/*perf-site:src%2Fapps%2Fperformance.ts:61:24:performanceScope:7a84f38e*/ SELECT a.script_name FROM site_app sa JOIN app_source a ON a.id = sa.app_id
    WHERE sa.site_id = ? AND a.tenant_id = ? AND a.project_id = ? AND a.state = 'active' ORDER BY a.script_name`).bind(site.id,ctx.tenant.id,site.project_id).all<{script_name:string}>()).results.map(r=>r.script_name);
  const hash=onlyMyOrg?await tenantHash(ctx.tenant.id,ctx.env.PERF_TENANT_KEY??ctx.env.HUB_INTERNAL_SECRET??ctx.env.HUB_SECRETS_KEY??""):"";
  if(onlyMyOrg&&!hash) throw new PerformanceUnavailable("Performance tenant identity is not configured.");
  if(![1,24,168].includes(hours)) throw badRequest("invalid performance range");
  return {scripts,where:`blob7 != 'synthetic' AND blob1 = ${quote(site.name)} ${onlyMyOrg?`AND blob5 = ${quote(hash)} `:""}AND blob2 IN (${scripts.length?scripts.map(quote).join(","):"''"}) AND timestamp > NOW() - INTERVAL '${hours}' HOUR`};
}
export function population(selection:PerfSelection):string {
  const dim=dimensions[selection.kind];
  if(selection.kind==="spinners") return "blob7 = 'client' AND blob9 = 'spinner'";
  if(selection.kind==="interactions") return "blob7 = 'client' AND blob9 = 'ready'";
  const background="(blob9 IN ('scheduled','tail','alarm','rpc') OR blob8 IN ('scheduled','tail') OR blob8 LIKE 'scheduled.%' OR blob8 LIKE 'tail.%' OR blob8 LIKE 'rpc.%' OR blob8 LIKE 'alarm%' OR blob8 LIKE 'do.alarm.%')";
  if(selection.kind==="background") return `blob7 IN ('request','rpc') AND ${background}`;
  if(selection.kind==="verbs") return "blob7 = 'span' AND blob14 LIKE 'verb.%' AND double14 = 1";
  if(selection.kind==="tools") return "blob7 = 'span' AND blob14 LIKE 'mcp.%' AND substring(blob14,5) NOT LIKE '%.%' AND double14 = 1";
  return `blob7 = 'request' AND ${dim} != '' AND NOT ${background}`;
}
export function pairedBrowser(rows:PerfRow[],version=""):PerfRow[] {
  const roots=new Map(rows.filter(r=>r.kind==="request"&&(!version||r.version===version)).map(r=>[String(r.tenant??"")+":"+String(r.request),r]));
  const clients=new Map<string,PerfRow[]>();
  for(const r of rows) if(r.kind==="client"&&roots.has(String(r.tenant??"")+":"+String(r.request))) {const key=String(r.tenant??"")+":"+String(r.request);clients.set(key,[...(clients.get(key)??[]),r]);}
  const groups=new Map<string,{label:string;phase:string;total:number;n:number}>();
  const add=(label:string,phase:string,value:number,n:number)=>{const key=label+":"+phase,g=groups.get(key)??{label,phase,total:0,n:0};g.total+=value*n;g.n+=n;groups.set(key,g);};
  for(const [request,points] of clients) {
    const root=roots.get(request)!, label=String(root.label);
    const longest=(rs:PerfRow[])=>rs.sort((a,b)=>Number(b.mean)-Number(a.mean))[0];
    const network=points.find(r=>r.phase==="page"&&r.name==="network")??longest(points.filter(r=>r.phase==="fetch"));
    const render=points.find(r=>r.phase==="page"&&r.name==="render");
    const paint=longest(points.filter(r=>r.phase==="paint"));
    if(network) add(label,"network",Math.max(0,Number(network.mean)-Number(root.mean)),Number(network.n));
    if(render) add(label,"render",Number(render.mean),Number(render.n));
    else if(paint&&network) add(label,"render",Math.max(0,Number(paint.mean)-Number(network.mean)),Number(paint.n));
  }
  return [...groups.values()].map(g=>({label:g.label,phase:g.phase,name:g.phase,mean:g.total/g.n,n:g.n}));
}
export function sampleMetrics(rows:PerfRow[]):PerfRow {
  const ordered=rows.filter(r=>Number(r.weight)>0&&Number.isFinite(Number(r.duration))).sort((a,b)=>Number(a.duration)-Number(b.duration));
  const n=ordered.reduce((n,r)=>n+Number(r.weight),0);
  const quantile=(p:number)=>{let at=0;for(const r of ordered) {at+=Number(r.weight);if(at>=n*p)return Number(r.duration);}return 0;};
  return {n,p50:quantile(0.5),p95:quantile(0.95),p99:quantile(0.99),errors:0,total:ordered.reduce((n,r)=>n+Number(r.duration)*Number(r.weight),0)};
}
async function originClientSplits(query:(sql:string)=>Promise<PerfRow[]>,scope:string,selected:string):Promise<Array<readonly [string,PerfRow[]]>> {
  const points=await query(`SELECT blob5 AS tenant, blob6 AS request, double1 AS duration, timestamp AS at, _sample_interval AS weight FROM pimwell_perf WHERE ${selected} ORDER BY at DESC LIMIT 2000`);
  const ids=[...new Set(points.map(r=>String(r.request)).filter(id=>/^[0-9a-f-]{36}$/.test(id)))];
  const roots=ids.length?await query(`SELECT blob5 AS tenant, blob6 AS request, blob4 AS colo, blob3 AS version, blob11 AS auth, double2 AS cold, _sample_interval AS weight FROM pimwell_perf WHERE ${scope} AND blob7 = 'request' AND blob6 IN (${ids.map(quote).join(",")}) LIMIT 2000`):[];
  const byRequest=new Map(roots.map(r=>[String(r.tenant??"")+":"+String(r.request),r]));
  return ["colo","version","auth","isolate"].map(name=> {
    const groups=new Map<string,PerfRow[]>();
    for(const p of points) {
      const root=byRequest.get(String(p.tenant??"")+":"+String(p.request)),label=root?String(root[name==="isolate"?"cold":name]??"Unknown"):"Unknown";
      groups.set(label,[...(groups.get(label)??[]),p]);
    }
    return [name,[...groups].map(([label,rows])=>({label,...sampleMetrics(rows)}))] as const;
  });
}
/** Detail and root indexes sample independently. Allocate each trip against its root,
 * then weight that allocation with the root's weight, never the detail's weight. */
export function tripAttribution(rows:PerfRow[]):PerfRow[] {
  if(!rows.some(r=>r.request)) return rows;
  const trips=new Map<string,PerfRow[]>(), groups=new Map<string,PerfRow>();
  for(const row of rows) {const key=String(row.tenant)+':'+String(row.request);trips.set(key,[...(trips.get(key)??[]),row]);}
  for(const points of trips.values()) {
    const root=points.find(r=>r.kind==='request');
    if(!root||Number(root.n)<=0) continue;
    const weight=Number(root.n),wall=Number(root.root_wall)/weight;
    const total=points.reduce((sum,r)=>sum+Number(r.attributed)/Number(r.n),0);
    const scale=total>wall&&total>0?wall/total:1;
    for(const row of points) {
      const key=JSON.stringify([root.label,row.name,row.kind]);
      const group=groups.get(key)??{label:root.label!,name:row.name!,kind:row.kind!,n:0,root_wall:0,attributed:0,execution:0,known_wall:0,execution_n:0};
      for(const field of ['attributed','execution','known_wall']) group[field]=Number(group[field])+Number(row[field]??0)/Number(row.n)*scale*weight;
      group.n=Number(group.n)+weight;
      group.root_wall=Number(group.root_wall)+(row.kind==='request'?wall*weight:0);
      group.execution_n=Number(group.execution_n)+Number(row.execution_n??0)/Number(row.n)*weight;
      groups.set(key,group);
    }
  }
  return [...groups.values()];
}
export function interactionPhases(ready:PerfRow[],phases:PerfRow[]):PerfRow[] {
  const groups=new Map<string,{label:string;phase:string;total:number;n:number}>(), recorded=new Map<string,number>();
  const keyFor=(p:PerfRow,phase:string)=>JSON.stringify([p.tenant??'',p.request,p.label,phase]);
  for(const point of phases) {const key=keyFor(point,String(point.phase));recorded.set(key,Math.max(recorded.get(key)??0,Number(point.mean)));}
  for(const point of ready) for(const phase of ['fetch','render','paint']) {
    const mean=recorded.get(keyFor(point,phase)),weight=Number(point.weight);
    if(mean===undefined||!(weight>0)) continue;
    const key=String(point.label)+':'+phase,group=groups.get(key)??{label:String(point.label),phase,total:0,n:0};
    group.total+=mean*weight;group.n+=weight;groups.set(key,group);
  }
  return [...groups.values()].map(g=>({label:g.label,phase:g.phase,mean:g.total/g.n,n:g.n}));
}
export type PerformanceData = {overview:PerfRow[];spark:PerfRow[];breakdown:PerfRow[];browser:PerfRow[];histogram:PerfRow[];splits:Record<string,PerfRow[]>;sql:PerfRow[];exemplars:PerfRow[];waterfall:PerfRow[];comparison:PerfRow[];triggers:PerfRow[]};
export async function readPerformance(ctx:Ctx,site:SiteRow,s:PerfSelection, detailOnly=false):Promise<PerformanceData> {
  const scope=await performanceScope(ctx,site,s.hours,s.onlyMyOrg);
  const empty:PerformanceData={overview:[],spark:[],breakdown:[],browser:[],histogram:[],splits:{},sql:[],exemplars:[],waterfall:[],comparison:[],triggers:[]};
  if(!scope.scripts.length) return empty;
  const dim=dimensions[s.kind];
  const versionFilter=s.kind==="deploys"&&s.version&&s.previous?` AND blob3 IN (${quote(s.version)},${quote(s.previous)})`:s.version?` AND blob3 = ${quote(s.version)}`:"";
  const filter=`${scope.where} AND ${population(s)}${versionFilter}${detailOnly&&s.selected?` AND ${dim} = ${quote(s.selected)}`:""}`;
  const query=(sql:string)=>analyticsQuery(ctx,sql);
  const bucket=s.hours===1?300:s.hours===24?7200:50400;
  const [overview,spark,breakdown,browser,comparison]=await Promise.all([
    query(`SELECT ${dim} AS label, ${weightedMetrics} FROM pimwell_perf WHERE ${filter} GROUP BY label ORDER BY total DESC LIMIT 200`),
    query(`SELECT ${dim} AS label, intDiv(toUInt32(timestamp), ${bucket}) AS bucket, quantileWeighted(0.5)(double1, _sample_interval) AS p50, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${filter} GROUP BY label, bucket ORDER BY label, bucket LIMIT 3000`),
    s.kind==="routes" ? query(`SELECT blob5 AS tenant, blob6 AS request, blob8 AS label, blob14 AS name, blob7 AS kind, double3 AS span, SUM(double1 * _sample_interval) AS root_wall, SUM(double17 * _sample_interval) AS attributed, SUM(IF(double19 > 0, double19, 0.0) * _sample_interval) AS execution, SUM(IF(double19 >= 0, double17, 0.0) * _sample_interval) AS known_wall, SUM(IF(double19 >= 0, _sample_interval, 0)) AS execution_n, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${scope.where} AND double20 = 2 AND double18 = 0 AND blob7 IN ('request','span') AND blob14 != 'd1.statement'${s.version?` AND blob3 = ${quote(s.version)}`:""} ${s.selected?` AND blob8 = ${quote(s.selected)}`:""} GROUP BY tenant, request, label, name, kind, span ORDER BY request, kind, span LIMIT 5000`) : Promise.resolve([]),
    s.kind==="routes" ? query(`SELECT blob5 AS tenant, blob6 AS request, blob8 AS label, blob7 AS kind, blob3 AS version, blob14 AS name, blob9 AS phase, SUM(double1 * _sample_interval) / SUM(_sample_interval) AS mean, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${scope.where} AND (blob7 = 'request' OR (blob7 = 'client' AND ((blob9 = 'page' AND blob14 IN ('network','render')) OR blob9 IN ('fetch','paint')))) GROUP BY tenant, request, label, kind, version, name, phase LIMIT 5000`) : Promise.resolve([]),
    s.kind==="deploys" && s.version && s.previous ? query(`SELECT blob8 AS label, blob3 AS version, ${weightedMetrics} FROM pimwell_perf WHERE ${scope.where} AND blob7 = 'request' AND blob3 IN (${quote(s.version)},${quote(s.previous)}) GROUP BY label, version ORDER BY label LIMIT 400`) : Promise.resolve([]),
  ]);
  const result={...empty,overview,spark,breakdown:tripAttribution(breakdown),browser:pairedBrowser(browser,s.version),comparison};
  if(s.kind==="interactions") {
    const ready=await query(`SELECT blob5 AS tenant, blob6 AS request, blob14 AS label, _sample_interval AS weight, timestamp AS at FROM pimwell_perf WHERE ${filter} ORDER BY at DESC LIMIT 2000`);
    const readyScope=ready.filter(r=>/^[0-9a-f-]{36}$/.test(String(r.request))).map(r=>`(blob5 = ${quote(String(r.tenant??''))} AND blob6 = ${quote(String(r.request))})`).join(' OR ');
    const phasePoints=readyScope?await query(`SELECT blob5 AS tenant, blob6 AS request, blob14 AS label, blob9 AS phase, SUM(double1 * _sample_interval) / SUM(_sample_interval) AS mean FROM pimwell_perf WHERE ${scope.where} AND blob7 = 'client' AND blob9 IN ('fetch','render','paint') AND (${readyScope})${versionFilter} GROUP BY tenant, request, label, phase LIMIT 5000`):[];
    const phases=interactionPhases(ready,phasePoints);
    for(const row of overview) for(const phase of ['fetch','render','paint']) { const p=phases.find(p=>p.label===row.label&&p.phase===phase); if(p) row[phase]=p.mean!; }
  }
  if(!s.selected || !(s.kind==="deploys"?comparison:overview).some(r=>r.label===s.selected)) return result;
  const selected=`${filter} AND ${dim} = ${quote(s.selected)}`;
  const histogram=[10,25,50,100,250,500,1000,2500,5000].reduceRight((expr,bound,index)=>`IF(double1 < ${bound}, ${index}, ${expr})`,"9");
  const splits={colo:"blob4",version:"blob3",auth:"blob11",isolate:"double2"};
  const [hist,splitRows,exemplars,triggers]=await Promise.all([
    query(`SELECT ${histogram} AS bucket, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${selected} GROUP BY bucket ORDER BY bucket`),
    s.kind==="interactions"||s.kind==="spinners" ? originClientSplits(query,scope.where,selected) : Promise.all(Object.entries(splits).map(async ([name,column])=>[name,await query(`SELECT ${column} AS label, ${weightedMetrics} FROM pimwell_perf WHERE ${selected} GROUP BY label ORDER BY n * p50 DESC LIMIT 100`)] as const)),
    query(`SELECT blob5 AS tenant, blob6 AS request, blob3 AS version, blob4 AS colo, double1 AS duration, double20 AS generation, IF(blob19 != '' OR blob20 != '', 1, 0) AS sourced, _sample_interval AS weight FROM pimwell_perf WHERE ${selected} ORDER BY sourced DESC, generation DESC, duration DESC LIMIT 5`),
    s.kind==="spinners"?query(`SELECT blob8 AS label, blob19 AS previous, ${weightedMetrics} FROM pimwell_perf WHERE ${selected} GROUP BY label, previous ORDER BY total DESC LIMIT 20`):Promise.resolve([]),
  ]);
  const ids=exemplars.map(r=>String(r.request)).filter(id=>/^[0-9a-f-]{36}$/.test(id));
  const exemplarScope=exemplars.filter(r=>ids.includes(String(r.request))).map(r=>`(blob6 = ${quote(String(r.request))}${r.tenant!==undefined?` AND blob5 = ${quote(String(r.tenant))}`:""})`).join(" OR ")||"blob6 = ''";
  const statementScope=s.kind==="interactions"||s.kind==="spinners" ? `(${exemplarScope})` : `${s.kind==="verbs"?"blob12":s.kind==="tools"?"blob13":dim} = ${quote(s.selected)}`;
  result.sql=await query(`SELECT blob15 AS fingerprint, blob20 AS code, blob19 AS source, blob3 AS version, ${weightedMetrics} FROM pimwell_perf WHERE ${scope.where} AND blob7 = 'span' AND double14 = 1 AND blob15 != '' AND ${statementScope}${s.version&&s.kind!=="interactions"&&s.kind!=="spinners"?` AND blob3 = ${quote(s.version)}`:""} GROUP BY fingerprint, code, source, version ORDER BY IF(code != '' OR source != '', 1, 0) DESC, p95 DESC LIMIT 20`);
  result.histogram=hist;result.splits=Object.fromEntries(splitRows);result.exemplars=exemplars.map(({tenant: _tenant,...row})=>row);result.triggers=triggers;
  const request=s.request ? ids.includes(s.request)?s.request:"" : ids[0]??"";
  const exemplarTenant=exemplars.find(r=>r.request===request)?.tenant;
  // Keep a client-supplied request ID within its exemplar tenant, even in site-wide views.
  if(request) result.waterfall=await query(`SELECT blob6 AS request, blob7 AS kind, blob14 AS name, blob9 AS phase, IF(blob7 = 'client', blob20, blob19) AS source, IF(blob7 = 'client', '', blob20) AS code, blob15 AS fingerprint, blob3 AS version, blob2 AS worker, double1 AS duration, double3 AS span, double4 AS parent, double14 AS complete, double15 AS offset, double16 AS started, double20 AS schema, _sample_interval AS weight FROM pimwell_perf WHERE ${scope.where} AND blob6 = ${quote(request)}${exemplarTenant!==undefined?` AND blob5 = ${quote(String(exemplarTenant))}`:""} AND blob7 IN ('request','rpc','span','client','other') AND NOT (blob7 = 'client' AND blob14 = 'cls') ORDER BY started, span LIMIT 300`);
  return result;
}
