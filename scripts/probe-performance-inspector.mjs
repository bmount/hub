#!/usr/bin/env node
// Live, authorized, cache-cold summary + progressive completion measurement.
// Six distinct scopes rotate >=72 seconds apart, beyond the 60-second SQL cache.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';

const origin = 'https://mcc.pimwell.com';
const dir = process.env.PERF_PROBE_OUTPUT || path.join(os.homedir(), '.local/state/pimwell/perf/268-progressive');
const credential = (await readFile(path.join(os.homedir(), '.config/pimwell/mcc.token'), 'utf8')).trim();
await mkdir(dir, { recursive: true });
const label = 'tmp-268-progressive-' + Date.now();
let token;
async function api(name, args, auth = token) {
  const res = await fetch(origin + '/api/' + name, { method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw Error(name + ' failed: HTTP ' + res.status);
  return payload.result;
}
const rows = [];
const percentile = (values, p) => values.slice().sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
try {
  token = (await api('session.start', { label, ttl: 3600 }, credential)).session_token;
  if (!token) throw Error('No session');
  await sleep(62000);
  for (let i=0; i<100; i++) {
    if (i) await sleep(12000);
    const hours=[1,24,168][Math.floor((i%6)/2)], own=i%2===1;
    const url=origin + '/apps?' + new URLSearchParams({ project:'pimwell', site:'pimwell.com', view:'performance', selected:'/apps', hours:String(hours), only_my_org:String(own) });
    const started=performance.now();
    const res=await fetch(url,{headers:{authorization:'Bearer '+token},redirect:'error',cache:'no-store'});
    const html=await res.text(), timing=res.headers.get('server-timing')||'';
    const summaryElapsed=performance.now()-started;
    const summaryValid=res.status===200 && html.includes('data-performance-load=') && html.includes('Represented events') && !html.includes('Performance unavailable');
    const detailAttempts=[];
    // Match the UI's retry action, retaining its time and every failed attempt.
    // Detail outages must not discard otherwise valid first-response measurements.
    for(let attempt=0;summaryValid&&attempt<3;attempt++) {
      try {
        const details=await fetch(url+'&details=1',{headers:{authorization:'Bearer '+token,'x-performance-details':'1'},redirect:'error',cache:'no-store'});
        const panes=await details.json();
        const valid=details.status===200 && typeof panes.inspector==='string' && !panes.inspector.includes('data-performance-load') && panes.inspector.includes('Latency histogram') && panes.inspector.includes('Slowest D1 statements');
        detailAttempts.push({status:details.status,valid,timing:details.headers.get('server-timing')});
        if(valid) break;
      } catch {detailAttempts.push({valid:false,networkError:true});}
      if(attempt<2) await sleep(1000);
    }
    const fullElapsed=performance.now()-started;
    const row={i,at:new Date().toISOString(),hours,own,status:res.status,summaryValid,summaryMs:Number(timing.match(/app;dur=([\d.]+)/)?.[1]),summaryElapsed,fullElapsed,timing,detailAttempts};
    rows.push(row);
    await writeFile(path.join(dir,'reads.json'),JSON.stringify({method:'100 signed-in agent-run opens, six hours/org scopes round-robin, >=12 seconds between opens, >=72 seconds between repeats; 62-second initial expiry. Summary document then authorized progressive JSON. All outliers and failed attempts included. Up to two progressive detail retries (one-second delay) model the UI retry action; full elapsed includes retries. App dispatch and end-to-end completion both recorded.',rows},null,2));
    console.log(JSON.stringify(row));
  }
  const result={n:rows.length,summarySuccesses:rows.filter(r=>r.summaryValid).length,detailSuccesses:rows.filter(r=>r.detailAttempts.at(-1)?.valid).length,detailRetries:rows.reduce((n,r)=>n+Math.max(0,r.detailAttempts.length-1),0),summaryDispatchP50:percentile(rows.map(r=>r.summaryMs),.5),summaryDispatchP95:percentile(rows.map(r=>r.summaryMs),.95),summaryElapsedP95:percentile(rows.map(r=>r.summaryElapsed),.95),fullElapsedP95:percentile(rows.map(r=>r.fullElapsed),.95)};
  await writeFile(path.join(dir,'summary.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  if(token) {
    const {sessions}=await api('session.list',{});
    for(const session of sessions.filter(s=>s.label===label)) await api('session.revoke',{session_id:session.id});
  }
}
