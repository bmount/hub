#!/usr/bin/env node
// Read-only access to loop state. Emit guarded UPDATEs; never INSERT usage.
// Usage: node scripts/backfill-loop-usage.mjs <state-dir> <ledger.json> <items.json>
// ledger/items are wrangler d1 execute --json results, scoped to the chosen org.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export function attributionUpdates(usage, results, ledger, items) {
  const runs = new Map(results.map(r=>[r.runId,r]));
  const reported = new Map(usage.filter(r=>r.phase==='reported').map(r=>[r.runId,r]));
  const updates=[],skipped=[];
  const used=new Set();
  for(const [runId,u] of reported){
    const run=runs.get(runId), item=items.find(i=>i.ref===run?.ref);
    if(!item || item.created_at < (item.velocity_since??item.project_created_at) || Date.parse(u.at)<(item.velocity_since??item.project_created_at)) {skipped.push({runId,reason:'no eligible current item'});continue;}
    const matches=ledger.filter(m=>m.tenant_id===item.tenant_id&&m.source==='reported'&&m.client==='pi-product-loop'&&m.created_at===Date.parse(u.at)&&m.input_tokens===u.input_tokens&&m.cached_tokens===u.cached_tokens&&m.output_tokens===u.output_tokens);
    if(matches.length!==1 || used.has(matches[0].id)){skipped.push({runId,reason:'missing, duplicate or ambiguous ledger match',matches:matches.length});continue;}
    const m=matches[0];used.add(m.id);
    if(m.work_item_id===item.id&&m.project_id===item.project_id)continue;
    if(m.work_item_id!==null||m.project_id!==null){skipped.push({runId,reason:'existing different attribution'});continue;}
    updates.push({runId,ledger:m,item});
  }
  return {updates,skipped};
}
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
export function updateSql({ledger:m,item:i,runId}) {
  return `-- run ${runId}\nUPDATE model_call SET work_item_id = ${quote(i.id)}, project_id = ${quote(i.project_id)} WHERE id = ${quote(m.id)} AND tenant_id = ${quote(i.tenant_id)} AND identity_id = ${quote(m.identity_id)} AND work_item_id IS NULL AND project_id IS NULL AND source = 'reported' AND client = 'pi-product-loop' AND created_at = ${m.created_at} AND input_tokens = ${m.input_tokens} AND cached_tokens = ${m.cached_tokens} AND output_tokens = ${m.output_tokens} AND EXISTS (SELECT 1 FROM work_item w JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id WHERE w.id = ${quote(i.id)} AND w.tenant_id = model_call.tenant_id AND w.project_id = ${quote(i.project_id)} AND w.created_at >= COALESCE(p.velocity_since,p.created_at));`;
}
const unwrap=x=>Array.isArray(x)&&x[0]?.results?x.flatMap(r=>r.results):x;
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]==='--self-test'){
    const u={runId:'r',phase:'reported',at:'2026-10-12T00:00:00Z',input_tokens:100,cached_tokens:80,output_tokens:10};
    const m={id:'m',tenant_id:'t',source:'reported',client:'pi-product-loop',created_at:Date.parse(u.at),input_tokens:100,cached_tokens:80,output_tokens:10,work_item_id:null,project_id:null};
    const i={id:'i',ref:'p#1',project_id:'p',tenant_id:'t',created_at:1,velocity_since:1};
    const run={runId:'r',ref:'p#1'};
    const f=(ledger=[m],items=[i])=>attributionUpdates([u,u],[run],ledger,items);
    assert.equal(f().updates.length,1);assert.equal(f([m,m]).updates.length,0);
    assert.equal(f([{...m,input_tokens:99}]).updates.length,0);
    assert.equal(f([{...m,work_item_id:'i',project_id:'p'}]).updates.length,0);
    assert.equal(f([m],[{...i,created_at:0}]).updates.length,0);
    assert.equal(f([m],[]).updates.length,0);
    console.log('Backfill matching: exact, unique, eligible, idempotent; no inserts.');
  }else{
    const [dir,ledgerFile,itemsFile]=process.argv.slice(2);
    if(!dir||!ledgerFile||!itemsFile)throw Error('give state-dir ledger.json items.json');
    const lines=async file=>(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
    const result=attributionUpdates(await lines(`${dir}/usage.jsonl`),await lines(`${dir}/results.jsonl`),unwrap(JSON.parse(await readFile(ledgerFile,'utf8'))),unwrap(JSON.parse(await readFile(itemsFile,'utf8'))));
    console.error(JSON.stringify({updates:result.updates.length,skipped:result.skipped}));
    console.log(result.updates.map(updateSql).join('\n'));
  }
}
