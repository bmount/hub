import type { Ctx } from "../auth/context";
import { tenantHash } from "../perf";
import type { SiteRow } from "../verbs/sites";
import { badRequest, notFound } from "../errors";

export type PerfRow = Record<string,string|number>;
export type PerfKind = "routes"|"verbs"|"tools"|"interactions"|"spinners"|"deploys";
export type PerfSelection = {kind:PerfKind;hours:1|24|168;selected:string;version:string;previous:string;request:string};
const dimensions = {routes:"blob8",verbs:"substring(blob14,6)",tools:"substring(blob14,5)",interactions:"blob14",spinners:"blob14",deploys:"blob8"} as const;
export function performanceSelection(params:URLSearchParams):PerfSelection {
  const kind=params.get("kind")??"routes", hours=Number(params.get("hours")??24);
  if (!Object.hasOwn(dimensions,kind) || ![1,24,168].includes(hours)) throw badRequest("invalid performance view");
  const selected=params.get("selected")??"",version=params.get("version")??"",previous=params.get("previous")??"",request=params.get("request")??"";
  if(selected.length>200 || [version,previous].some(v=>v && !/^[a-zA-Z0-9-]{1,64}$/.test(v)) || (request && !/^[0-9a-f-]{36}$/.test(request))) throw badRequest("invalid performance selection");
  return {kind:kind as PerfKind,hours:hours as 1|24|168,selected,version,previous,request};
}
export const weightedMetrics = `SUM(_sample_interval) AS n,
  quantileWeighted(0.5)(double1, _sample_interval) AS p50,
  quantileWeighted(0.95)(double1, _sample_interval) AS p95,
  quantileWeighted(0.99)(double1, _sample_interval) AS p99,
  SUM(IF(blob7 = 'request', IF(blob10 IN ('4xx','5xx'), 1.0, 0.0), double5) * _sample_interval) / SUM(_sample_interval) * 100 AS errors,
  SUM(double1 * _sample_interval) AS total`;
const quote = (s:string) => `'${s.replace(/\\/g,"\\\\").replace(/'/g,"''")}'`;
const cache=new Map<string,{until:number;rows:PerfRow[];bytes:number}>();
let cacheBytes=0;
export function clearPerformanceCache():void {cache.clear();cacheBytes=0;}
export class PerformanceUnavailable extends Error {}
export async function analyticsQuery(ctx:Ctx, sql:string):Promise<PerfRow[]> {
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
export async function performanceScope(ctx:Ctx, site:SiteRow, hours:number):Promise<PerfScope> {
  if(!ctx.tenant || !ctx.identity || !ctx.role || site.tenant_id!==ctx.tenant.id || (ctx.mcpProject && ctx.mcpProject.id!==site.project_id)) throw notFound("no such site");
  const project=await ctx.db.prepare("/*perf-site:src%2Fapps%2Fperformance.ts:55:23:performanceScope:e8c7cd55*/ SELECT id FROM project WHERE id = ? AND tenant_id = ? AND kind = 'repo' AND state = 'active'").bind(site.project_id,ctx.tenant.id).first();
  if(!project) throw notFound("no such site");
  const scripts=(await ctx.db.prepare(`/*perf-site:src%2Fapps%2Fperformance.ts:57:24:performanceScope:7a84f38e*/ SELECT a.script_name FROM site_app sa JOIN app_source a ON a.id = sa.app_id
    WHERE sa.site_id = ? AND a.tenant_id = ? AND a.project_id = ? AND a.state = 'active' ORDER BY a.script_name`).bind(site.id,ctx.tenant.id,site.project_id).all<{script_name:string}>()).results.map(r=>r.script_name);
  const hash=await tenantHash(ctx.tenant.id,ctx.env.PERF_TENANT_KEY??ctx.env.HUB_INTERNAL_SECRET??ctx.env.HUB_SECRETS_KEY??"");
  if(!hash) throw new PerformanceUnavailable("Performance tenant identity is not configured.");
  if(![1,24,168].includes(hours)) throw badRequest("invalid performance range");
  return {scripts,where:`blob1 = ${quote(site.name)} AND blob5 = ${quote(hash)} AND blob2 IN (${scripts.length?scripts.map(quote).join(","):"''"}) AND timestamp > NOW() - INTERVAL '${hours}' HOUR`};
}
export function population(selection:PerfSelection):string {
  const dim=dimensions[selection.kind];
  if(selection.kind==="spinners") return "blob7 = 'client' AND blob9 = 'spinner'";
  if(selection.kind==="interactions") return "blob7 = 'client' AND blob9 = 'paint'";
  if(selection.kind==="verbs") return "blob7 = 'span' AND blob14 LIKE 'verb.%' AND double14 = 1";
  if(selection.kind==="tools") return "blob7 = 'span' AND blob14 LIKE 'mcp.%' AND substring(blob14,5) NOT LIKE '%.%' AND double14 = 1";
  return `blob7 = 'request' AND ${dim} != ''`;
}
export function pairedBrowser(rows:PerfRow[],version=""):PerfRow[] {
  const roots=new Map(rows.filter(r=>r.kind==="request"&&(!version||r.version===version)).map(r=>[String(r.request),r]));
  const clients=new Map<string,PerfRow[]>();
  for(const r of rows) if(r.kind==="client"&&roots.has(String(r.request))) {const key=String(r.request);clients.set(key,[...(clients.get(key)??[]),r]);}
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
  const points=await query(`SELECT blob6 AS request, double1 AS duration, timestamp AS at, _sample_interval AS weight FROM pimwell_perf WHERE ${selected} ORDER BY at DESC LIMIT 2000`);
  const ids=[...new Set(points.map(r=>String(r.request)).filter(id=>/^[0-9a-f-]{36}$/.test(id)))];
  const roots=ids.length?await query(`SELECT blob6 AS request, blob4 AS colo, blob3 AS version, blob11 AS auth, double2 AS cold, _sample_interval AS weight FROM pimwell_perf WHERE ${scope} AND blob7 = 'request' AND blob6 IN (${ids.map(quote).join(",")}) LIMIT 2000`):[];
  const byRequest=new Map(roots.map(r=>[String(r.request),r]));
  return ["colo","version","auth","isolate"].map(name=> {
    const groups=new Map<string,PerfRow[]>();
    for(const p of points) {
      const root=byRequest.get(String(p.request)),label=root?String(root[name==="isolate"?"cold":name]??"Unknown"):"Unknown";
      groups.set(label,[...(groups.get(label)??[]),p]);
    }
    return [name,[...groups].map(([label,rows])=>({label,...sampleMetrics(rows)}))] as const;
  });
}
export type PerformanceData = {overview:PerfRow[];spark:PerfRow[];breakdown:PerfRow[];browser:PerfRow[];histogram:PerfRow[];splits:Record<string,PerfRow[]>;sql:PerfRow[];exemplars:PerfRow[];waterfall:PerfRow[];comparison:PerfRow[];triggers:PerfRow[]};
export async function readPerformance(ctx:Ctx,site:SiteRow,s:PerfSelection):Promise<PerformanceData> {
  const scope=await performanceScope(ctx,site,s.hours);
  const empty:PerformanceData={overview:[],spark:[],breakdown:[],browser:[],histogram:[],splits:{},sql:[],exemplars:[],waterfall:[],comparison:[],triggers:[]};
  if(!scope.scripts.length) return empty;
  const dim=dimensions[s.kind];
  const versionFilter=s.kind==="deploys"&&s.version&&s.previous?` AND blob3 IN (${quote(s.version)},${quote(s.previous)})`:s.version?` AND blob3 = ${quote(s.version)}`:"";
  const filter=`${scope.where} AND ${population(s)}${versionFilter}`;
  const query=(sql:string)=>analyticsQuery(ctx,sql);
  const bucket=s.hours===1?300:s.hours===24?7200:50400;
  const [overview,spark,breakdown,browser,comparison]=await Promise.all([
    query(`SELECT ${dim} AS label, ${weightedMetrics} FROM pimwell_perf WHERE ${filter} GROUP BY label ORDER BY ${s.kind==="spinners"?"total":"n * p50"} DESC LIMIT 200`),
    query(`SELECT ${dim} AS label, intDiv(toUInt32(timestamp), ${bucket}) AS bucket, quantileWeighted(0.5)(double1, _sample_interval) AS p50, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${filter} GROUP BY label, bucket ORDER BY label, bucket LIMIT 3000`),
    s.kind==="routes" ? query(`SELECT blob8 AS label, blob14 AS name, blob7 AS kind, SUM(double17 * _sample_interval) AS attributed, SUM(IF(double19 > 0, double19, 0.0) * _sample_interval) AS execution, SUM(IF(double19 >= 0, double17, 0.0) * _sample_interval) AS known_wall, SUM(IF(double19 >= 0, _sample_interval, 0)) AS execution_n, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${scope.where} AND double20 = 2 AND double18 = 0 AND blob7 IN ('request','span') AND blob14 != 'd1.statement'${s.version?` AND blob3 = ${quote(s.version)}`:""} GROUP BY label, name, kind LIMIT 2000`) : Promise.resolve([]),
    s.kind==="routes" ? query(`SELECT blob6 AS request, blob8 AS label, blob7 AS kind, blob3 AS version, blob14 AS name, blob9 AS phase, SUM(double1 * _sample_interval) / SUM(_sample_interval) AS mean, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${scope.where} AND (blob7 = 'request' OR (blob7 = 'client' AND ((blob9 = 'page' AND blob14 IN ('network','render')) OR blob9 IN ('fetch','paint')))) GROUP BY request, label, kind, version, name, phase LIMIT 5000`) : Promise.resolve([]),
    s.kind==="deploys" && s.version && s.previous ? query(`SELECT blob8 AS label, blob3 AS version, ${weightedMetrics} FROM pimwell_perf WHERE ${scope.where} AND blob7 = 'request' AND blob3 IN (${quote(s.version)},${quote(s.previous)}) GROUP BY label, version ORDER BY label LIMIT 400`) : Promise.resolve([]),
  ]);
  const result={...empty,overview,spark,breakdown,browser:pairedBrowser(browser,s.version),comparison};
  if(!s.selected || !(s.kind==="deploys"?comparison:overview).some(r=>r.label===s.selected)) return result;
  const selected=`${filter} AND ${dim} = ${quote(s.selected)}`;
  const histogram=[10,25,50,100,250,500,1000,2500,5000].reduceRight((expr,bound,index)=>`IF(double1 < ${bound}, ${index}, ${expr})`,"9");
  const splits={colo:"blob4",version:"blob3",auth:"blob11",isolate:"double2"};
  const [hist,splitRows,exemplars,triggers]=await Promise.all([
    query(`SELECT ${histogram} AS bucket, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${selected} GROUP BY bucket ORDER BY bucket`),
    s.kind==="interactions"||s.kind==="spinners" ? originClientSplits(query,scope.where,selected) : Promise.all(Object.entries(splits).map(async ([name,column])=>[name,await query(`SELECT ${column} AS label, ${weightedMetrics} FROM pimwell_perf WHERE ${selected} GROUP BY label ORDER BY n * p50 DESC LIMIT 100`)] as const)),
    query(`SELECT blob6 AS request, blob3 AS version, blob4 AS colo, double1 AS duration, _sample_interval AS weight FROM pimwell_perf WHERE ${selected} ORDER BY duration DESC LIMIT 5`),
    s.kind==="spinners"?query(`SELECT blob8 AS label, blob19 AS previous, ${weightedMetrics} FROM pimwell_perf WHERE ${selected} GROUP BY label, previous ORDER BY total DESC LIMIT 20`):Promise.resolve([]),
  ]);
  const ids=exemplars.map(r=>String(r.request)).filter(id=>/^[0-9a-f-]{36}$/.test(id));
  const statementScope=s.kind==="interactions"||s.kind==="spinners" ? `blob6 IN (${ids.length?ids.map(quote).join(","):"''"})` : `${s.kind==="verbs"?"blob12":s.kind==="tools"?"blob13":dim} = ${quote(s.selected)}`;
  result.sql=await query(`SELECT blob15 AS fingerprint, blob20 AS code, blob19 AS source, blob3 AS version, ${weightedMetrics} FROM pimwell_perf WHERE ${scope.where} AND blob7 = 'span' AND double14 = 1 AND blob15 != '' AND ${statementScope}${s.version&&s.kind!=="interactions"&&s.kind!=="spinners"?` AND blob3 = ${quote(s.version)}`:""} GROUP BY fingerprint, code, source, version ORDER BY p95 DESC LIMIT 20`);
  result.histogram=hist;result.splits=Object.fromEntries(splitRows);result.exemplars=exemplars;result.triggers=triggers;
  const request=s.request ? ids.includes(s.request)?s.request:"" : ids[0]??"";
  // Request IDs narrow an already-authorized scope; they never grant access to a foreign trace.
  if(request) result.waterfall=await query(`SELECT blob6 AS request, blob7 AS kind, blob14 AS name, blob9 AS phase, IF(blob7 = 'client', blob20, blob19) AS source, IF(blob7 = 'client', '', blob20) AS code, blob15 AS fingerprint, blob3 AS version, blob2 AS worker, double1 AS duration, double3 AS span, double4 AS parent, double14 AS complete, double15 AS offset, double16 AS started, double20 AS schema, _sample_interval AS weight FROM pimwell_perf WHERE ${scope.where} AND blob6 = ${quote(request)} AND blob7 IN ('request','rpc','span','client','other') AND NOT (blob7 = 'client' AND blob14 = 'cls') ORDER BY started, span LIMIT 300`);
  return result;
}
