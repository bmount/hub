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
  if(hit) return structuredClone(hit.rows);
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
    cacheBytes+=bytes;cache.set(key,{until:Date.now()+60_000,rows:structuredClone(rows),bytes});
  }
  return rows;
}
export type PerfScope = {where:string;scripts:string[]};
/** SQL credentials are account-wide; product authorization is checked before every cache lookup. */
export async function performanceScope(ctx:Ctx, site:SiteRow, hours:number, onlyMyOrg=false):Promise<PerfScope> {
  if(!ctx.tenant || !ctx.identity || !ctx.role || site.tenant_id!==ctx.tenant.id || (ctx.mcpProject && ctx.mcpProject.id!==site.project_id)) throw notFound("no such site");
  // Recheck membership before cached reads; account-wide root powers do not substitute for it.
  const [membership,project,attachments]=await ctx.db.batch<Record<string,unknown>>([
    ctx.db.prepare("SELECT 1 FROM membership WHERE identity_id = ? AND tenant_id = ? AND state = 'active'").bind(ctx.identity.id,ctx.tenant.id),
    ctx.db.prepare("SELECT id FROM project WHERE id = ? AND tenant_id = ? AND EXISTS (SELECT 1 FROM json_each(project.parts) WHERE value = 'repo') AND state = 'active'").bind(site.project_id,ctx.tenant.id),
    ctx.db.prepare(`SELECT a.script_name FROM site_app sa JOIN app_source a ON a.id = sa.app_id
      WHERE sa.site_id = ? AND a.tenant_id = ? AND a.project_id = ? AND a.state = 'active' ORDER BY a.script_name`).bind(site.id,ctx.tenant.id,site.project_id),
  ]);
  if(!membership!.results.length || !project!.results.length) throw notFound("no such site");
  const scripts=attachments!.results.map(r=>String(r.script_name));
  const hash=onlyMyOrg?await tenantHash(ctx.tenant.id,ctx.env.PERF_TENANT_KEY??ctx.env.HUB_INTERNAL_SECRET??ctx.env.HUB_SECRETS_KEY??""):"";
  if(onlyMyOrg&&!hash) throw new PerformanceUnavailable("Performance tenant identity is not configured.");
  if(![1,24,168].includes(hours)) throw badRequest("invalid performance range");
  return {scripts,where:`blob7 != 'synthetic' AND blob1 = ${quote(site.name)} ${onlyMyOrg?`AND blob5 = ${quote(hash)} `:""}AND blob2 IN (${scripts.length?scripts.map(quote).join(","):"''"}) AND timestamp > NOW() - INTERVAL '${hours}' HOUR`};
}
const background="(blob9 IN ('scheduled','tail','alarm','rpc') OR blob8 IN ('scheduled','tail') OR blob8 LIKE 'scheduled.%' OR blob8 LIKE 'tail.%' OR blob8 LIKE 'rpc.%' OR blob8 LIKE 'alarm%' OR blob8 LIKE 'do.alarm.%')";
export function population(selection:PerfSelection):string {
  const dim=dimensions[selection.kind];
  if(selection.kind==="spinners") return "blob7 = 'client' AND blob9 = 'spinner'";
  if(selection.kind==="interactions") return "blob7 = 'client' AND blob9 = 'ready'";
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
export function sampleSplits(points:PerfRow[],splits:Record<string,string>):Array<readonly [string,PerfRow[]]> {
  return Object.keys(splits).map(name=>{
    const groups=new Map<string,PerfRow[]>();
    for(const point of points) {
      const label=String(point[name]);
      const group=groups.get(label)??[];group.push(point);groups.set(label,group);
    }
    return [name,[...groups].map(([,rows]):PerfRow=>{
      const metrics=sampleMetrics(rows),n=Number(metrics.n);
      const errors=rows.reduce((n,r)=>n+((r.status==="5xx"||Number(r.failed)===1||Number(r.complete)===0)?Number(r.weight):0),0);
      const client_errors=rows.reduce((n,r)=>n+(r.status==="4xx"?Number(r.weight):0),0);
      return {label:rows[0]![name]!,...metrics,errors:n?errors/n*100:0,client_errors};
    }).sort((a,b)=>Number(b.n)*Number(b.p50)-Number(a.n)*Number(a.p50)).slice(0,100)] as const;
  });
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
/** Each v2 span is emitted once per request/span ID. Its recorded duration is already
 * normalized (duration * sample weight / sample weight). Aggregate trips first, cap
 * their recorded detail at root wall, then weight by the root's represented traffic.
 * No trip-row LIMIT: busy routes cannot consume another route's detail budget. */
export function routeAttributionSQL(where:string):string {
  const categories={auth:"blob14 LIKE 'auth.%'",d1:"blob14 LIKE 'd1.%'",do:"blob14 LIKE 'do.%'",external:"(blob14 LIKE 'fetch.%' OR blob14 LIKE 'GIT_PROXY.%' OR blob14 LIKE 'ARDI.%' OR blob14 LIKE 'MAIL.%')",render:"blob14 LIKE 'render.%'"};
  const all={...categories,other:`NOT (${Object.values(categories).join(' OR ')})`};
  const fields:Array<readonly [string,string,boolean]>=Object.entries(all).flatMap(([key,condition])=>[
    [`${key}_wall`,`SUM(IF(blob7 = 'span' AND ${condition}, double17, 0.0))`,true],
    [`${key}_n`,`SUM(IF(blob7 = 'span' AND ${condition}, 1.0, 0.0))`,false],
  ] as const);
  fields.push(
    ['d1_execution',"SUM(IF(blob7 = 'span' AND blob14 LIKE 'd1.%' AND double19 > 0, double19, 0.0))",true],
    ['d1_known_wall',"SUM(IF(blob7 = 'span' AND blob14 LIKE 'd1.%' AND double19 >= 0, double17, 0.0))",true],
    ['d1_execution_n',"SUM(IF(blob7 = 'span' AND blob14 LIKE 'd1.%' AND double19 >= 0, 1.0, 0.0))",false],
  );
  const rootN="SUM(IF(blob7 = 'request', _sample_interval * 1.0, 0.0))";
  const scale="IF(span_wall > root_wall AND span_wall > 0, root_wall / IF(span_wall > 0, span_wall, 1.0), 1.0)";
  // Distinct output aliases avoid WAE substituting them into inner aggregate expressions.
  return `SELECT label, SUM(root_n) AS n, SUM(root_wall * root_n) AS weighted_root_wall, ${fields.map(([name,,wall])=>`SUM(${name} * root_n${wall?` * ${scale}`:''}) AS weighted_${name}`).join(', ')} FROM (
    SELECT blob5 AS tenant, blob6 AS request, blob8 AS label, ${rootN} AS root_n, SUM(IF(blob7 = 'request', double1 * _sample_interval, 0.0)) / IF(${rootN} > 0, ${rootN}, 1.0) AS root_wall, SUM(IF(blob7 = 'span', double17, 0.0)) AS span_wall, ${fields.map(([name,sql])=>`${sql} AS ${name}`).join(', ')} FROM pimwell_perf WHERE ${where} AND double20 = 2 AND double18 = 0 AND blob7 IN ('request','span') AND blob14 != 'd1.statement' GROUP BY tenant, request, label HAVING root_n > 0
    ) GROUP BY label ORDER BY weighted_root_wall DESC LIMIT 5000`;
}
export function routeAttributionSummary(rows:PerfRow[]):PerfRow[] {
  return routeAttribution(rows.filter(r=>Number(r.n)>0).map(r=>({label:r.label!,root_n:r.n!,span_wall:0,
    ...Object.fromEntries(Object.entries(r).filter(([key])=>key.startsWith('weighted_')).map(([key,value])=>[key.slice(9),Number(value)/Number(r.n)])),
  })));
}
export function routeAttribution(rows:PerfRow[]):PerfRow[] {
  const groups=new Map<string,PerfRow>();
  for(const trip of rows) {
    const weight=Number(trip.root_n),wall=Number(trip.root_wall),total=Number(trip.span_wall);
    if(!(weight>0)) continue;
    const scale=total>wall&&total>0?wall/total:1;
    const key=String(trip.label),group=groups.get(key)??{label:key,n:0,root_wall:0};
    group.n=Number(group.n)+weight;group.root_wall=Number(group.root_wall)+wall*weight;
    for(const field of ['auth_wall','d1_wall','do_wall','external_wall','render_wall','other_wall','d1_execution','d1_known_wall']) group[field]=Number(group[field]??0)+Number(trip[field]??0)*scale*weight;
    group.execution_n=Number(group.execution_n??0)+Number(trip.d1_execution_n??0)*weight;
    for(const key of ['auth','d1','do','external','render','other']) group[`${key}_n`]=Number(group[`${key}_n`]??0)+Number(trip[`${key}_n`]??0)*weight;
    groups.set(key,group);
  }
  return [...groups.values()].flatMap(r=>[
    {label:r.label!,kind:'request',name:'request',n:r.n!,root_wall:r.root_wall!,attributed:0},
    ...Object.entries({auth:'auth.work',d1:'d1.work',do:'do.work',external:'fetch.work',render:'render.work',other:'other.work'}).filter(([key])=>Number(r[`${key}_n`])>0).map(([key,name])=>({label:r.label!,kind:'span',name,n:r[`${key}_n`]!,attributed:r[`${key}_wall`]!,...(key==='d1'?{execution:r.d1_execution!,known_wall:r.d1_known_wall!,execution_n:r.execution_n!}:{})})),
  ]);
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
export async function readPerformance(ctx:Ctx,site:SiteRow,s:PerfSelection, detailOnly=false, summaryOnly=false):Promise<PerformanceData> {
  const scope=await performanceScope(ctx,site,s.hours,s.onlyMyOrg);
  const empty:PerformanceData={overview:[],spark:[],breakdown:[],browser:[],histogram:[],splits:{},sql:[],exemplars:[],waterfall:[],comparison:[],triggers:[]};
  if(!scope.scripts.length) return empty;
  const dim=dimensions[s.kind];
  const versionFilter=s.kind==="deploys"&&s.version&&s.previous?` AND blob3 IN (${quote(s.version)},${quote(s.previous)})`:s.version?` AND blob3 = ${quote(s.version)}`:"";
  const filter=`${scope.where} AND ${population(s)}${versionFilter}`;
  const overviewFilter=`${filter}${detailOnly&&s.selected?` AND ${dim} = ${quote(s.selected)}`:""}`;
  const query=(sql:string)=>analyticsQuery(ctx,sql);
  const bucket=s.hours===1?300:s.hours===24?7200:50400;
  const bounds=[10,25,50,100,250,500,1000,2500,5000];
  const histogramMetrics=bounds.concat(Infinity).map((bound,index)=>`SUM(IF(${index?`double1 >= ${bounds[index-1]} AND `:""}${Number.isFinite(bound)?`double1 < ${bound}`:"1 = 1"}, _sample_interval, 0)) AS hist${index}`).join(", ");
  const readInspector=async()=>{
    const selected=`${filter} AND ${dim} = ${quote(s.selected)}`;
    const splits={colo:"blob4",version:"blob3",auth:"blob11",isolate:"double2"};
    const client=s.kind==="interactions"||s.kind==="spinners";
    // A strict under-limit result is the entire weighted population, not a recent sample.
    // At the sentinel, retain the four exact remote aggregates rather than truncate splits.
    const points=query(`SELECT blob5 AS tenant, blob6 AS request, blob3 AS version, blob4 AS colo, double1 AS duration, double20 AS generation, IF(blob19 != '' OR blob20 != '', 1, 0) AS sourced, _sample_interval AS weight${client?"":", blob11 AS auth, double2 AS isolate, blob10 AS status, double5 AS failed, double14 AS complete"} FROM pimwell_perf WHERE ${selected} ORDER BY sourced DESC, generation DESC, duration DESC LIMIT ${client?5:5000}`);
    const exemplarRows=points.then(rows=>rows.slice(0,5).map(({auth:_auth,isolate:_isolate,status:_status,failed:_failed,complete:_complete,...row})=>row));
    const distribution=Promise.all([
      client ? originClientSplits(query,scope.where,selected) : points.then(rows=>rows.length<5000?sampleSplits(rows,splits):Promise.all(Object.entries(splits).map(async ([name,column])=>[name,await query(`SELECT ${column} AS label, ${weightedMetrics} FROM pimwell_perf WHERE ${selected} GROUP BY label ORDER BY n * p50 DESC LIMIT 100`)] as const))),
      s.kind==="spinners"?query(`SELECT blob8 AS label, blob19 AS previous, ${weightedMetrics} FROM pimwell_perf WHERE ${selected} GROUP BY label, previous ORDER BY total DESC LIMIT 20`):Promise.resolve([]),
    ]);
    const detail=(async()=>{
      // Follow exemplar IDs immediately; slow distribution queries must not delay the waterfall.
      const exemplars=await exemplarRows;
      const ids=exemplars.map(r=>String(r.request)).filter(id=>/^[0-9a-f-]{36}$/.test(id));
      const exemplarScope=exemplars.filter(r=>ids.includes(String(r.request))).map(r=>`(blob6 = ${quote(String(r.request))}${r.tenant!==undefined?` AND blob5 = ${quote(String(r.tenant))}`:""})`).join(" OR ")||"blob6 = ''";
      const statementScope=s.kind==="interactions"||s.kind==="spinners" ? `(${exemplarScope})` : `${s.kind==="verbs"?"blob12":s.kind==="tools"?"blob13":dim} = ${quote(s.selected)}`;
      const statements=query(`SELECT blob15 AS fingerprint, blob20 AS code, blob19 AS source, blob3 AS version, ${weightedMetrics} FROM pimwell_perf WHERE ${scope.where} AND blob7 = 'span' AND double14 = 1 AND blob15 != '' AND ${statementScope}${s.version&&s.kind!=="interactions"&&s.kind!=="spinners"?` AND blob3 = ${quote(s.version)}`:""} GROUP BY fingerprint, code, source, version ORDER BY IF(code != '' OR source != '', 1, 0) DESC, p95 DESC LIMIT 20`);
      const request=s.request ? ids.includes(s.request)?s.request:"" : ids[0]??"";
      const exemplarTenant=exemplars.find(r=>r.request===request)?.tenant;
      // Keep a client-supplied request ID within its exemplar tenant, even in site-wide views.
      const waterfall=request?query(`SELECT blob6 AS request, blob7 AS kind, blob14 AS name, blob9 AS phase, IF(blob7 = 'client', blob20, blob19) AS source, IF(blob7 = 'client', '', blob20) AS code, blob15 AS fingerprint, blob3 AS version, blob2 AS worker, double1 AS duration, double3 AS span, double4 AS parent, double14 AS complete, double15 AS offset, double16 AS started, double20 AS schema, _sample_interval AS weight FROM pimwell_perf WHERE ${scope.where} AND blob6 = ${quote(request)}${exemplarTenant!==undefined?` AND blob5 = ${quote(String(exemplarTenant))}`:""} AND blob7 IN ('request','rpc','span','client','other') AND NOT (blob7 = 'client' AND blob14 = 'cls') ORDER BY started, span LIMIT 300`):Promise.resolve([]);
      const [sql,spans]=await Promise.all([statements,waterfall]);
      return {exemplars:exemplars.map(({tenant: _tenant,...row})=>row),sql,waterfall:spans};
    })();
    const [[splitRows,triggers],details]=await Promise.all([distribution,detail]);
    return {splits:Object.fromEntries(splitRows),triggers,...details};
  };
  // Start the dependent exemplar chain before independent list/distribution work fills fetch slots.
  const inspectorRead=s.selected&&!summaryOnly?readInspector():Promise.resolve(null);
  const [[overview,spark,browser,comparison,breakdown],inspector]=await Promise.all([Promise.all([
    query(`SELECT ${dim} AS label, ${weightedMetrics}, ${histogramMetrics} FROM pimwell_perf WHERE ${overviewFilter} GROUP BY label ORDER BY total DESC LIMIT 200`),
    summaryOnly ? Promise.resolve([]) : query(`SELECT ${dim} AS label, intDiv(toUInt32(timestamp), ${bucket}) AS bucket, quantileWeighted(0.5)(double1, _sample_interval) AS p50, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${overviewFilter} GROUP BY label, bucket ORDER BY label, bucket LIMIT 3000`),
    !summaryOnly && s.kind==="routes" ? query(`SELECT blob5 AS tenant, blob6 AS request, blob8 AS label, blob7 AS kind, blob3 AS version, blob14 AS name, blob9 AS phase, SUM(double1 * _sample_interval) / SUM(_sample_interval) AS mean, SUM(_sample_interval) AS n FROM pimwell_perf WHERE ${scope.where} AND (blob7 = 'request' OR (blob7 = 'client' AND ((blob9 = 'page' AND blob14 IN ('network','render')) OR blob9 IN ('fetch','paint')))) GROUP BY tenant, request, label, kind, version, name, phase LIMIT 5000`) : Promise.resolve([]),
    s.kind==="deploys" && s.version && s.previous ? query(`SELECT blob8 AS label, blob3 AS version, ${weightedMetrics} FROM pimwell_perf WHERE ${scope.where} AND blob7 = 'request' AND blob3 IN (${quote(s.version)},${quote(s.previous)}) GROUP BY label, version ORDER BY label LIMIT 400`) : Promise.resolve([]),
    !summaryOnly && s.kind==="routes" ? query(routeAttributionSQL(`${scope.where} AND blob8 != '' AND NOT ${background}${versionFilter}${detailOnly&&s.selected?` AND blob8 = ${quote(s.selected)}`:''}`)) : Promise.resolve([]),
  ]),inspectorRead]);
  const result={...empty,overview,spark,breakdown:routeAttributionSummary(breakdown),browser:pairedBrowser(browser,s.version),comparison};
  if(summaryOnly) return result;
  if(s.kind==="interactions") {
    const ready=await query(`SELECT blob5 AS tenant, blob6 AS request, blob14 AS label, _sample_interval AS weight, timestamp AS at FROM pimwell_perf WHERE ${overviewFilter} ORDER BY at DESC LIMIT 2000`);
    const readyScope=ready.filter(r=>/^[0-9a-f-]{36}$/.test(String(r.request))).map(r=>`(blob5 = ${quote(String(r.tenant??''))} AND blob6 = ${quote(String(r.request))})`).join(' OR ');
    const phasePoints=readyScope?await query(`SELECT blob5 AS tenant, blob6 AS request, blob14 AS label, blob9 AS phase, SUM(double1 * _sample_interval) / SUM(_sample_interval) AS mean FROM pimwell_perf WHERE ${scope.where} AND blob7 = 'client' AND blob9 IN ('fetch','render','paint') AND (${readyScope})${versionFilter} GROUP BY tenant, request, label, phase LIMIT 5000`):[];
    const phases=interactionPhases(ready,phasePoints);
    for(const row of overview) for(const phase of ['fetch','render','paint']) { const p=phases.find(p=>p.label===row.label&&p.phase===phase); if(p) row[phase]=p.mean!; }
  }
  if(!s.selected || !(s.kind==="deploys"?comparison:overview).some(r=>r.label===s.selected)) return result;
  // The list aggregate already scans precisely this population; count buckets there,
  // rather than making another remote scan. Never derive a distribution from quantiles.
  // Comparison can select routes outside the overview's top 200.
  const selectedRow=overview.find(r=>r.label===s.selected) ?? (s.kind==="deploys" ? (await query(`SELECT ${histogramMetrics} FROM pimwell_perf WHERE ${filter} AND ${dim} = ${quote(s.selected)}`))[0] : undefined);
  const histogram=selectedRow?bounds.concat(Infinity).flatMap((_,bucket)=>Number(selectedRow[`hist${bucket}`])>0?[{bucket,n:selectedRow[`hist${bucket}`]!}]:[]):[];
  return {...result,...inspector,histogram};
}
