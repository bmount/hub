#!/usr/bin/env node
// Disposable design evidence: actual Worker, D1/DOs, shipped browser assets,
// synthetic sessions. No remote services, production cookies or credential files.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';
import { SQL_CATALOG } from '../src/perfCatalog.ts';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'pimwell-chat-browser-'));
const artifacts = path.resolve(process.env.WORKBENCH_ARTIFACTS || await mkdtemp(path.join(tmpdir(), 'pimwell-chat-screenshots-')));
await mkdir(artifacts, { recursive: true });
const host = 'acme.pimwell.test';
const base = `https://${host}`;
let mf, browser, cacheBrowser, cacheServer, chatClient;
const perfPoints = [];
let counter = 0;
const id = () => String(++counter).padStart(26, '0');
const now = Date.now();
try {
  execFileSync(path.join(root, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--outdir', path.join(temp, 'build')], {
    cwd: root, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  // Miniflare's HTTP bridge rewrites Host to loopback. Recover the synthetic
  // browser host only in this temporary test entry; auth/verbs remain unchanged.
  await writeFile(path.join(temp, 'build/browser-entry.js'), `
    import worker from './index.js';
    export { Conversation, Inbox } from './index.js';
    export default { fetch(request, env, ctx) {
      const headers = new Headers(request.headers);
      headers.set('host', headers.get('x-local-browser-host') || 'acme.pimwell.test');
      headers.delete('x-local-browser-host');
      const url = new URL(request.url); url.host = headers.get('host'); url.protocol = 'https:';
      env = {...env, PERF: {writeDataPoint(point) { ctx.waitUntil(env.PERF_SINK.fetch('https://perf.invalid', {method:'POST',body:JSON.stringify(point)})); }}};
      return worker.fetch(new Request(url, new Request(request, { headers })), env, ctx);
    }};
  `);
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'chat-browser-local', modulesRoot: path.join(temp, 'build'), modules: [
      { type: 'ESModule', path: path.join(temp, 'build/browser-entry.js') },
      { type: 'ESModule', path: path.join(temp, 'build/index.js') },
      ...(await readdir(path.join(temp, 'build'))).filter(f => f.endsWith('.html')).map(f => ({ type: 'Text', path: path.join(temp, 'build', f) })),
    ],
    compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { HUB_DOMAIN: 'pimwell.test', ARDI_REPO_CREATE: 'off', HUB_SECRETS_KEY: randomBytes(32).toString('base64'), ARTIFACTS_ACCOUNT_ID:'a'.repeat(32), PERF_ANALYTICS_TOKEN:'synthetic-read-only' },
    d1Databases: ['HUB_DB'], r2Buckets: ['GIT_PUSH_STAGING'], kvNamespaces: ['RATE', 'OAUTH_KV'],
    durableObjects: { CONVERSATION: { className: 'Conversation', useSQLite: true }, INBOX: { className: 'Inbox', useSQLite: true } },
    serviceBindings: { PERF_SINK: async request => { perfPoints.push(await request.json()); return new Response(null,{status:204}); }, ARDI: async request => {
      // Synthetic git host only; never sends a request outside this process.
      const body = await request.json(), verb = new URL(request.url).pathname.split('/api/')[1];
      const a = 'a'.repeat(40), b = 'b'.repeat(40);
      const commit = oid => ({oid,tree:a,parents:oid === b ? [a] : [],summary:oid === b ? 'Keep navigation visible' : 'Start the workbench',message:'Synthetic repository evidence.',author_name:'Alex Example',author_email:'alex@example.test',author_time:Math.floor(now/1000),committer_name:'Alex Example',committer_email:'alex@example.test',commit_time:Math.floor(now/1000),principal:null,session:null,trailer_principal:null,trailer_session:null});
      const ok = result => Response.json({ok:true,result,next:null});
      if (verb === 'refs.list') return ok({refs:[{name:'refs/heads/main',target:a},{name:'refs/heads/topic',target:b}]});
      if (verb === 'log') return ok({commits:body.ref === 'refs/heads/main' ? [commit(a)] : [commit(b),commit(a)]});
      if (verb === 'commit.show') return ok({...commit(body.oid),changes:body.oid === b ? [{path:'app.ts',prev_path:null,prev_blob:a,new_blob:b,kind:'modify'}] : []});
      if (verb === 'tree.list') return ok({entries:[{kind:'blob',mode:'100644',name:'app.ts',oid:b}]});
      if (verb === 'file.show' && body.path === 'app.ts') { const text = body.rev === a ? 'export const navigation = false;\n' : 'export const navigation = true;\n'; return ok({content_b64:Buffer.from(text).toString('base64'),size:text.length,oid:b,path:body.path,rev:body.rev}); }
      return Response.json({ok:false,error:'No synthetic path'},{status:404});
    } },
    outboundService: async request => {
      if(new URL(request.url).hostname !== 'api.cloudflare.com') return new Response('Local acceptance denies network access', {status:503});
      const sql=await request.text(), version='11111111-1111-4111-8111-111111111111',previous='22222222-2222-4222-8222-222222222222',rid='33333333-3333-4333-8333-333333333333';
      const metric={n:120,p50:40,p95:180,p99:500,errors:1.2,total:15000}, label=sql.includes('substring(blob14,6) AS label')?'work.read':sql.includes('substring(blob14,5) AS label')?'work_read':sql.includes('blob14 AS label')?'pane.swap':'/:project/docket';
      const code=Object.keys(SQL_CATALOG)[0],source=JSON.stringify(SQL_CATALOG[code].sites[0]);
      let data;
      if(sql.includes('AS schema')) data=[{request:rid,kind:'request',name:'request',phase:'GET',source,code:'',fingerprint:'',version,worker:'sample-worker',duration:180,span:0,parent:0,complete:1,offset:0,started:now,schema:2,weight:1},{request:rid,kind:'span',name:'d1.first',phase:'GET',source,code,fingerprint:'abcdef01',version,worker:'sample-worker',duration:100,span:1,parent:0,complete:1,offset:20,started:now+20,schema:2,weight:1},{request:rid,kind:'client',name:'pane.swap',phase:'fetch',source:JSON.stringify({file:'src/clientTimingScript.ts',line:19,fn:'point'}),code:'',fingerprint:'',version,worker:'sample-worker',duration:220,span:0,parent:0,complete:1,offset:0,started:now-10,schema:2,weight:1}];
      else if(sql.includes('GROUP BY label, previous')) data=[{label:'/:project/docket',previous:'/:project',...metric}];
      else if(sql.includes('AS mean')) data=[{request:rid,label:'/:project/docket',kind:'request',version,name:'request',phase:'GET',mean:180,n:120},{request:rid,label:'/:project/docket',kind:'client',version,name:'pane.swap',phase:'fetch',mean:220,n:120},{request:rid,label:'/:project/docket',kind:'client',version,name:'pane.swap',phase:'paint',mean:250,n:120}];
      else if(sql.includes('AS cold')) data=[{request:rid,version,colo:'LHR',auth:'cookie',cold:0,weight:1}];
      else if(sql.includes('blob6 AS request')&&!sql.includes('double17')) data=[{request:rid,version,colo:'LHR',duration:180,weight:1}];
      else if(sql.includes('SELECT blob15')) data=[{fingerprint:'abcdef01',code,source,version,...metric}];
      else if(sql.includes('IF(double1 < 10')) data=[{bucket:1,n:60},{bucket:2,n:30},{bucket:4,n:20},{bucket:7,n:10}];
      else if(sql.includes('double17')) data=[{label:'/:project/docket',name:'request',kind:'request',attributed:2400,execution:0,n:120},{label:'/:project/docket',name:'auth.buildContext',kind:'span',attributed:2400,execution:0,n:120},{label:'/:project/docket',name:'d1.first',kind:'span',attributed:12000,execution:2400,known_wall:12000,execution_n:120,n:120},{label:'/:project/docket',name:'do.stub.CONVERSATION.fetch',kind:'span',attributed:4800,execution:0,n:120}];
      else if(sql.includes('intDiv')) data=Array.from({length:12},(_,i)=>({label,bucket:i,p50:30+i*4,n:10}));
      else if(sql.includes('GROUP BY label, version')) data=[{label,version,...metric},{label,version:previous,...metric,p95:140}];
      else if(sql.includes('double2 AS label')) data=[{label:0,...metric},{label:1,...metric,n:12,p95:350}];
      else if(sql.includes('blob4 AS label')) data=[{label:'LHR',...metric},{label:'DFW',...metric,n:50}];
      else if(sql.includes('blob3 AS label')) data=[{label:version,...metric}];
      else if(sql.includes('blob11 AS label')) data=[{label:'cookie',...metric}];
      else data=[{label,...metric}];
      return Response.json({data});
    },
    // No persistence directory: everything, including sessions and memberships,
    // is in this process's temporary Miniflare storage and disposed in finally.
  }] }));
  const db = await mf.getD1Database('HUB_DB');
  for (const file of (await readdir(path.join(root, 'migrations'))).filter(f => f.endsWith('.sql')).sort()) {
    // Wrangler's SQL parser handles multiline statements and comments.
    const { unstable_splitSqlQuery } = await import('wrangler');
    for (const sql of unstable_splitSqlQuery(await readFile(path.join(root, 'migrations', file), 'utf8'))) await db.prepare(sql).run();
  }
  const tenant = id();
  const otherTenant = id();
  for (const [tid, slug] of [[tenant, 'acme'], [otherTenant, 'other']]) {
    await db.prepare('INSERT INTO tenant (id,slug,display_name,created_at) VALUES (?,?,?,?)').bind(tid, slug, slug.toUpperCase(), now).run();
  }
  async function human(name, tid, role) {
    const identity = id();
    const token = randomBytes(32).toString('hex'); // local-only, never logged
    await db.prepare('INSERT INTO identity (id,kind,display_name,email,created_at) VALUES (?,\'human\',?,?,?)').bind(identity, name, `${name}@example.test`, now).run();
    await db.prepare('INSERT INTO membership (id,identity_id,tenant_id,role,created_at) VALUES (?,?,?,?,?)').bind(id(), identity, tid, role, now).run();
    await db.prepare('INSERT INTO session (id,identity_id,kind,token_hash,created_at,last_seen_at,expires_at,last_proof_at) VALUES (?,?,\'browser\',?,?,?,?,?)')
      .bind(id(), identity, createHash('sha256').update(token).digest('hex'), now, now, now + 3600000, now).run();
    return token;
  }
  const member = await human('dev', tenant, 'admin');
  const reader = await human('reader', tenant, 'reader');
  const peer = await human('peer', tenant, 'member');
  const outsider = await human('outsider', otherTenant, 'admin');
  async function verb(token, name, input, hostname = host) {
    const res = await mf.dispatchFetch(`https://${hostname}/api/${name}`, { method: 'POST',
      headers: { 'x-local-browser-host': hostname, cookie: `pmw_session=${token}`, origin: `https://${hostname}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect(res.status, name).toBe(200);
    return (await res.json()).result;
  }
  await verb(member, 'project.create', { slug: 'sample', kind: 'repo', display_name: 'Sample project' });
  await verb(member, 'project.create', { slug: 'knowledge', kind: 'workspace', display_name: 'Team knowledge' });
  for (const [kind, title] of [['quest', 'Launch the workbench'], ['wish', 'Keep project navigation visible'], ['snag', 'Fix the empty list'], ['errand', 'Review the release']]) {
    await verb(member, 'work.create', { project: 'sample', kind, title, body: 'Synthetic design fixture. Done when: reviewed and shipped.' });
  }
  await verb(member, 'wiki.write', {project: 'knowledge', slug: 'welcome', title: 'Team handbook', body: 'Synthetic team handbook for design evidence.', expected_revision: 0, note: 'Fixture'});
  const contact = await verb(member, 'person.upsert', {project: 'knowledge', name: 'Alex Example', title: 'Designer', emails: ['alex@example.test']});
  const company = await verb(member, 'company.upsert', {project:'knowledge',name:'Example Company',sector:'Design'});
  await verb(member,'connection.add',{project:'knowledge',a:contact.entity.id,b:company.entity.id,type:'advisor',source:'Synthetic fixture'});
  await verb(member, 'channel.create', {slug: 'general', topic: 'Team conversation'});
  const chatRoot = await verb(member, 'chat.post', {c: 'general', body: 'Please review the compact workbench.'});
  await verb(peer,'chat.post',{c:'general',reply_to:chatRoot.seq,body:'The navigation stays visible while I read this thread.'});
  const viewerId = await db.prepare("SELECT id FROM identity WHERE email = 'dev@example.test'").first('id');
  const peerId = await db.prepare("SELECT id FROM identity WHERE email = 'peer@example.test'").first('id');
  const readerId = await db.prepare("SELECT id FROM identity WHERE email = 'reader@example.test'").first('id');
  await verb(member,'chat.open',{kind:'direct',members:[peerId],client_id:'design-direct'});
  await verb(member,'chat.open',{kind:'group',members:[peerId,readerId],client_id:'design-group'});
  const mailId = id(), assistantId = id();
  await verb(member, 'review.request', {project:'sample',branch:'topic',title:'Keep navigation visible',summary:'Synthetic review of the workbench.',reviewers:['peer@example.test']});
  const sampleId = await db.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'sample'").bind(tenant).first('id');
  await db.prepare("INSERT INTO repository (tenant_id,project_id,name,storage_name,is_default,created_at) VALUES (?,?,'default','sample',1,?)").bind(tenant,sampleId,now).run();
  for (const name of ['api','web']) await db.prepare("INSERT INTO repository (tenant_id,project_id,name,storage_name,is_default,created_at) VALUES (?,?,?,?,0,?)").bind(tenant,sampleId,name,`sample/${name}`,now).run();
  await verb(member,'work.link',{id:'sample#2',target_kind:'commit',target_ref:'sample/api@'+'b'.repeat(40),note:'Synthetic non-default repository commit'});
  await verb(member,'review.request',{project:'sample',repo:'api',branch:'topic',title:'Review the API repository',reviewers:['peer@example.test']});
  await db.prepare("INSERT INTO app_deploy (id,tenant_id,project_id,script_name,version_id,tag,message,seen_at) VALUES (?,?,?,?,?,?,?,?)").bind('synthetic-deploy',tenant,sampleId,'sample-worker','b'.repeat(40),'workbench','Synthetic deploy record; not a live rollout.',now).run();
  await db.prepare("INSERT INTO site (id,tenant_id,project_id,name,hostnames,created_at) VALUES ('performance-site',?,?, 'workbench.example.com','[\"workbench.example.com\"]',?)").bind(tenant,sampleId,now).run();
  for(const [i,version] of ['22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111'].entries()) {
    const deployment='44444444-4444-4444-8444-444444444444',commit=String(i?'b':'a').repeat(40),message=JSON.stringify({release:1,environment:'production',version,deployment,commit});
    await db.prepare("INSERT INTO app_deploy (id,tenant_id,project_id,script_name,version_id,tag,message,seen_at) VALUES (?,?,?,?,?,?,?,?)").bind('performance-deploy-'+i,tenant,sampleId,'sample-worker',version+':'+deployment,commit,message,now+i).run();
  }
  await db.prepare("INSERT INTO inbound_mail (id,tenant_id,project_id,identity_id,from_email,to_address,subject,received_at,size,verdict,text,attachments,forwarded) VALUES (?,?,?,?,?,?,?, ?,100,'admitted',?,'[]',0)")
    .bind(mailId,tenant,sampleId,viewerId,'peer@example.test','acme.sample@pimwell.test','Review the communication views',now,'Can you check the Mail inspector and reply actions?').run();
  await db.prepare("INSERT INTO outbound_mail (id,tenant_id,from_address,to_address,subject,text,in_reply_to,sent_by,status,error,created_at) VALUES (?,?,?,?,?,?,?,?,'refused','sending_off',?)")
    .bind(id(),tenant,'acme.sample@pimwell.test','peer@example.test','Re: Review the communication views','Thanks; I will check them.',mailId,viewerId,now).run();
  await db.prepare("UPDATE tenant SET mail_out = 1 WHERE id = ?").bind(tenant).run();
  for (const [threadId,title] of [[assistantId,'What needs attention?'],[id(),'Review recent changes']]) {
    await db.prepare("INSERT INTO assistant_thread (id,tenant_id,identity_id,title,scopes,created_at,updated_at) VALUES (?,?,?,?,'read',?,?)").bind(threadId,tenant,viewerId,title,now,now).run();
  }
  for (const [role,text] of [['user','What needs my attention today?'],['assistant','Review **sample#2** and the communication views.']]) {
    await db.prepare("INSERT INTO assistant_message (id,thread_id,tenant_id,role,text,created_at) VALUES (?,?,?,?,?,?)").bind(id(),assistantId,tenant,role,text,now + counter).run();
  }
  {
    for (let n=1;n<=10;n++) await verb(member, 'project.create', {slug:'team-'+n,kind:n%2 ? 'tracker' : 'wiki',display_name:'Team '+n});
    const viewer = await db.prepare("SELECT id FROM identity WHERE email = 'dev@example.test'").first('id');
    const work = await db.prepare("SELECT id FROM work_item WHERE project_id = ? AND number = 2").bind(sampleId).first('id');
    for (let n=1;n<=5;n++) await db.prepare("INSERT INTO attention (id,tenant_id,identity_id,reason,item_id,summary,created_at) VALUES (?,?,?,'comment',?,?,?)").bind(id(),tenant,viewer,work,'Review navigation change '+n,now+n).run();
    await verb(member, 'research.save', {project:'knowledge',slug:'findings',expected_revision:0,topic:'Workbench findings',summary:'Synthetic research fixture.',status:'draft',sources:[],note:'Fixture'});
    await verb(member, 'file.put', {project:'knowledge',path:'notes.txt',content_type:'text/plain',expected_revision:0,base64:Buffer.from('Synthetic file fixture.').toString('base64')});
    await verb(member, 'file.put', {project:'knowledge',path:'handbook/notes.txt',content_type:'text/plain',expected_revision:0,base64:Buffer.from('Folder fixture.').toString('base64')});
    await verb(member,'person.upsert',{project:'knowledge',id:contact.entity.id,expected_revision:1,name:'Alex Example',title:'Designer',emails:['alex@example.test'],links:[{kind:'research',ref:'findings'},{kind:'file',ref:'notes.txt'}]});
  }
  const rootToken = await human('root',tenant,'admin');
  await db.prepare("UPDATE identity SET is_root = 1 WHERE email = 'root@example.test'").run();
  await verb(member,'agent.create',{tenant:'acme',slug:'build',display_name:'Build agent'});
  await verb(member,'usage.report',{provider:'openai',model:'synthetic-model',input_tokens:1200,output_tokens:400,cost_usd:0.02,work:'sample#2'});
  await db.prepare("INSERT INTO app_source (id,tenant_id,project_id,script_name,state,created_by,created_at,last_event_at) VALUES (?,?,?,'sample-worker','active',?,?,?)").bind(id(),tenant,sampleId,viewerId,now,now).run();
  await db.prepare("INSERT INTO site_app (site_id,app_id) SELECT 'performance-site',id FROM app_source WHERE tenant_id = ? AND script_name = 'sample-worker'").bind(tenant).run();
  await db.prepare("INSERT INTO app_error_group (id,tenant_id,project_id,script_name,fingerprint,kind,title,last_message,count,first_seen,last_seen) VALUES (?,?,?,'sample-worker','synthetic-error','exception','Workbench request failed','Synthetic exception for design evidence',3,?,?)").bind('synthetic-error',tenant,sampleId,now,now).run();
  await db.prepare("INSERT INTO situation (id,tenant_id,identity_id,thread_id,title,question,report,created_at) VALUES (?,?,?,?,'Investigate the workbench','Why did the workbench request fail?','Synthetic report: inspect the recorded error group.',?)").bind('synthetic-situation',tenant,viewerId,assistantId,now).run();
  browser = await chromium.launch({headless: true});
  const pages = {multiSidebar:'/sample/code?repo=api', multiCode:'/sample/code?repo=api', multiCommit:'/sample/code?repo=api&c='+'b'.repeat(40), multiFiles:'/sample/files?repo=web&f=app.ts', multiItem:'/sample/w/2', multiReviews:'/sample/reviews?repo=api', home:'/', overview:'/sample', workspace:'/knowledge', docket:'/sample/docket', item:'/sample/w/2', workGraph:'/sample/graph', frontier:'/sample/frontier', board:'/sample/board', status:'/sample/status', code:'/sample/code', commit:'/sample/code?c='+ 'b'.repeat(40), codeFiles:'/sample/files', codeFile:'/sample/files?f=app.ts', reviews:'/sample/reviews', review:'/sample/reviews/1', deploys:'/apps?project=sample#deploys', deploy:'/apps?project=sample&d=synthetic-deploy', wiki:'/knowledge/wiki', wikiPage:'/knowledge/wiki/welcome', research:'/knowledge/wiki?view=research', researchRecord:'/knowledge/wiki/findings?view=research', files:'/knowledge/documents', fileRecord:'/knowledge/documents?path=notes.txt', contacts:'/knowledge/contacts', contact:`/knowledge/contacts/${contact.entity.id}`, graph:`/knowledge/contacts/${contact.entity.id}?view=graph`, attention:'/attention', attentionItem:'/attention?done=1&work=sample%232', mail:'/mail', mailMessage:`/mail/${mailId}?project=sample`, chat:'/c/general', chatThread:`/c/general/t/${chatRoot.seq}`, assistant:`/assistant?t=${assistantId}`,  people:'/people', apps:'/apps', usage:'/usage', admin:'/admin/agents', person:'/people/dev%40example.test', agent:'/people/acme.build%40pimwell.test', connect:'/people?connect=1', invite:'/people?invite=1', appGroup:'/apps?g=synthetic-error', situations:'/situations', situation:'/situations?s=synthetic-situation', usagePerson:'/usage?days=30&who=dev%40example.test', mailSettings:'/mail?addresses=1', mailRecipients:'/mail/recipients', account:'https://pimwell.test/me', sessions:'https://pimwell.test/me/sessions', models:'https://pimwell.test/admin/models', orgs:'https://pimwell.test/admin/orgs', adminApps:'https://pimwell.test/admin/apps', newProject:'/projects/new', intent:'/do', chatDirectory:'/c', chatInbox:'/inbox', assistantNew:'/assistant', contactNew:'/knowledge/contacts?new=1', upload:'/knowledge/documents?upload=1', wikiNew:'/knowledge/wiki?new=1', skill:'/skills/start-here', skills:'/skills', tools:'/assistant/tools', archive:'/archive', organizations:'https://pimwell.test/', newWork:'/new?project=sample', search:'/search?q=workbench', performance:'/apps?project=sample&site=workbench.example.com&view=performance', performanceRoute:'/apps?project=sample&site=workbench.example.com&view=performance&selected=%2F%3Aproject%2Fdocket', performanceVerb:'/apps?project=sample&site=workbench.example.com&view=performance&kind=verbs', performanceTool:'/apps?project=sample&site=workbench.example.com&view=performance&kind=tools', performanceInteraction:'/apps?project=sample&site=workbench.example.com&view=performance&kind=interactions&selected=pane.swap', performanceSpinner:'/apps?project=sample&site=workbench.example.com&view=performance&kind=spinners&selected=pane.swap', performanceDeploy:'/apps?project=sample&site=workbench.example.com&view=performance&kind=deploys'};
  const phase = process.env.WORKBENCH_PHASE || 'before';
  const manifest = [];
  for (const [label, viewport] of [['1440', {width:1440,height:900}], ['1920',{width:1920,height:1080}], ['390',{width:390,height:844}]]) {
    await db.prepare('UPDATE attention SET done_at = NULL WHERE tenant_id = ?').bind(tenant).run();
    const ctx = await browser.newContext({viewport, timezoneId:'America/Chicago', serviceWorkers:'block'});
    await ctx.addCookies([{name:'pmw_session',value:member,domain:'.pimwell.test',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
    // Routing follows Worker redirects in-process (Chromium bypasses route
    // interception after a redirect). Expose the final URL to the real client.
    await ctx.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        const finalURL = response.headers.get('x-local-final-url');
        if (finalURL) Object.defineProperty(response, 'url', {value:finalURL});
        return response;
      };
    });
    await ctx.routeWebSocket('**/*', ws => ws.close());
    await ctx.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (![host,'pimwell.test'].includes(url.hostname)) return route.abort();
      const requestHeaders = {...await req.allHeaders(),'x-local-browser-host':url.hostname,...(url.hostname === 'pimwell.test' ? {cookie:`pmw_session=${rootToken}`} : {})};
      let res = await mf.dispatchFetch(req.url(), {method:req.method(), headers:requestHeaders, body:req.postDataBuffer() || undefined, redirect:'manual'});
      let finalURL = req.url();
      for (let n=0; res.status >= 300 && res.status < 400 && res.headers.has('location'); n++) {
        if (n > 5) throw new Error('Redirect loop');
        const target = new URL(res.headers.get('location'),req.url());
        if (![host,'pimwell.test'].includes(target.hostname)) throw new Error('External redirect refused');
        finalURL = target.href;
        res = await mf.dispatchFetch(target.href,{headers:{'x-local-browser-host':target.hostname,cookie:`pmw_session=${target.hostname === 'pimwell.test' ? rootToken : member}`},redirect:'manual'});
      }
      await route.fulfill({status:res.status,headers:{...Object.fromEntries(res.headers),'x-local-final-url':finalURL},body:Buffer.from(await res.arrayBuffer())});
    });
    const page = await ctx.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    async function flushTiming() {
      await page.evaluate(() => { Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'}); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'}); });
    }
    async function joinedPoint(id, predicate) {
      await expect.poll(() => perfPoints.some(p => p.blobs[6] === 'client' && p.blobs[5] === id && predicate(p)), {timeout:10000}).toBe(true);
      await expect.poll(() => perfPoints.some(p => p.blobs[5] === id && ['request','rpc'].includes(p.blobs[6])), {timeout:10000}).toBe(true);
    }
    let searchPosition;
    for (const [name, route] of Object.entries(pages).filter(([name]) => !process.env.WORKBENCH_PAGES || process.env.WORKBENCH_PAGES.split(',').includes(name))) {
      if (name === 'attention') await db.prepare('UPDATE attention SET done_at = NULL WHERE tenant_id = ?').bind(tenant).run();
      const response = await page.goto(route.startsWith('https:') ? route : base+route);
      expect(response.status(), name).toBe(200);
      await page.locator('main').waitFor();
      expect(browserErrors, name+' browser errors').toEqual([]);
      if (name.startsWith('multi')) {
        await expect(page.locator('#explorer')).toContainText('Code');
        for (const repo of ['default','api','web']) await expect(page.locator(`#explorer a[href$="/sample/code?repo=${repo}"]`).first()).toBeVisible();
        await expect(page.locator('#explorer button[aria-label*="clone URL"]')).toHaveCount(3);
        if (name === 'multiSidebar' && viewport.width >= 1280) await page.locator('#explorer summary a[href$="/sample/code"]').evaluate(el => el.scrollIntoView({block:'start'}));
        if (name === 'multiItem') await expect(page.locator('#inspector a[href$="/sample/code?c='+ 'b'.repeat(40)+'&repo=api"]')).toContainText('sample/api@');
        if (name === 'multiCode') {
          await expect(page.locator('#list input[name="repo"]')).toHaveValue('api');
          await page.locator('#list summary').filter({hasText:'New repository'}).click();
          await expect(page.locator('#list form[action="/api/repo.create"] input[name="name"]')).toBeVisible();
          await page.locator('#list form[action="/api/repo.create"] input[name="name"]').fill('cli');
          await page.locator('#list summary').filter({hasText:'New repository'}).click();
          await page.locator('#list a').filter({hasText:'Keep navigation visible'}).click();
          await expect(page).toHaveURL(/repo=api.*c=b{40}/);
          await expect(page.locator('#inspector')).toContainText('Keep navigation visible');
          await page.goBack();
          await expect(page).toHaveURL(/\/sample\/code\?repo=api$/);
          await expect(page.locator('main.panes')).toHaveClass(/one/);
        }
        if (name === 'multiFiles') await expect(page.locator('#inspector a').filter({hasText:'History'})).toHaveAttribute('href',/repo=web/);
        if (name === 'multiReviews') {
          await expect(page.locator('#list')).toContainText('Review the API repository');
          await expect(page.locator('#list')).not.toContainText('Synthetic review of the workbench');
        }
      }
      for (const time of await page.locator('time[data-local-time]').all()) {
        await expect(time).not.toContainText('UTC');
        await expect(time).toHaveAttribute('title', /.+/);
        await expect(time).not.toContainText(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/);
      }
      await page.screenshot({path:path.join(artifacts,`${phase}-${name}-${label}.png`),fullPage:false});
      await flushTiming();
      await joinedPoint(response.headers()['x-request-id'], p => p.blobs[13] === 'navigation' && p.blobs[8] === 'page');
      manifest.push({phase,name,route,viewport,file:`${phase}-${name}-${label}.png`});
      if (phase === 'after') {
        // One menu control per width: the Menu link below 1280 px, the sidebar toggle at and above it.
        expect(await page.locator('.bar .menu:visible, .bar [data-toggle-sidebar]:visible').count(), name+' menu controls').toBe(1);
        await expect(page.locator('#rail')).not.toContainText('Your account');
        await expect(page.locator('form[action="/api/session.end"]')).toHaveCount(1);
        const darkButtons = await page.evaluate(()=>{
          const probe=document.createElement('span'); probe.style.backgroundColor='var(--ink)'; document.body.append(probe);
          const dark=getComputedStyle(probe).backgroundColor; probe.remove();
          return [...document.querySelectorAll('button,a.button')].filter(e=>e.checkVisibility() && getComputedStyle(e).backgroundColor === dark).length;
        });
        expect(darkButtons,name+' one primary action').toBeLessThanOrEqual(1);
        const searchBox = page.locator('.jump input');
        if (viewport.width === 1440 && await searchBox.count()) {
          const rect = await searchBox.boundingBox();
          searchPosition ??= rect.x;
          expect(Math.abs(rect.x - searchPosition), name+' stable search position').toBeLessThan(1);
        }
        if (name === 'newWork') await expect(page.locator('.bar .file')).toHaveCount(0);
        else if (!route.startsWith('https:')) await expect(page.locator('.bar .file')).toHaveClass(/quiet/);
        if (route.startsWith('https:')) await expect(page.locator('.status .keys')).toHaveText('');
        if (name === 'search') {
          await expect(page.locator('#list input[name=q]')).toHaveCount(0);
          await expect(page.locator('#list table')).toHaveCount(1);
          await expect(page.locator('#list th')).toHaveText(['Kind','Reference','Title','Project','When']);
          const kinds = await page.locator('#list tbody tr td:first-child').allTextContents();
          expect(kinds).toEqual([...kinds].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'})));
          expect(await page.locator('#list td').evaluateAll(cells=>cells.every(c=>c.textContent.trim()))).toBe(true);
        }
        if (name === 'people') {
          const agentName = page.locator('#list table[aria-label=Agents] tbody tr td:first-child');
          await expect(agentName).not.toContainText('Source');
          await expect(page.locator('#list table[aria-label=Agents] th')).toContainText(['Name','Source']);
          if (viewport.width >= 760) {
          const copied = page.locator('#list .wb-address').first();
          const email = await copied.locator('code').innerText();
          await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedAddress=value;}}}));
          await copied.locator('button').click();
          expect(await page.evaluate(()=>window.copiedAddress)).toBe(email);
          }
        }
        if (['newWork','situations','invite'].includes(name) && viewport.width === 1440) {
          expect(await page.locator('.wb-form-row').evaluateAll(rows=>rows.every(row=>{
            const label=row.querySelector('label').getBoundingClientRect(), field=row.querySelector('input,textarea,select').getBoundingClientRect();
            return label.bottom <= field.top;
          })),name+' labels above fields').toBe(true);
          expect(await page.locator('.voice-field').evaluateAll(boxes=>boxes.every(box=>{
            const field=box.querySelector('textarea').getBoundingClientRect(), mic=box.querySelector('.mic').getBoundingClientRect();
            return mic.left >= field.left && mic.right <= field.right && mic.top >= field.top && mic.bottom <= field.bottom;
          })),name+' inset microphone').toBe(true);
        }
        if (name === 'usage') {
          await expect(page.locator('#list table')).toHaveCount(1);
          await expect(page.locator('#list select[name=group]')).toBeVisible();
          await expect(page.locator('#list th')).toHaveText(['Group','Cost (USD)','Calls','Input','Output']);
          await page.locator('select[name=group]').selectOption('model');
          await expect(page).toHaveURL(/group=model/);
          await expect(page.locator('#list table')).toHaveCount(1);
          await page.reload();
          await expect(page.locator('select[name=group]')).toHaveValue('model');
          await page.goto(route.startsWith('https:') ? route : base+route);
        }
        if (name === 'mailSettings') {
          const on = (await page.locator('#inspector #sending dd').innerText()).replace('✎','');
          await expect(page.locator('#list .head')).toContainText('Sending '+on.trim().toLowerCase());
          const boxes = await page.locator('[aria-label=Mailboxes] a').allTextContents();
          expect(boxes.indexOf('Team 2')).toBeLessThan(boxes.indexOf('Team 10'));
        }
        if (name === 'fileRecord') {
          await expect(page.locator('#inspector')).not.toContainText('SHA-256');
          await expect(page.locator('#inspector table')).toHaveCount(0);
          await expect(page.locator('#inspector')).toContainText('modified');
          await expect(page.locator('#inspector button').last()).toHaveText('Remove file and all downloads');
          await expect(page.locator('#inspector button').last()).toHaveClass(/quiet destructive/);
        }
        if (name === 'board') await expect(page.locator('.wb-board-columns h2')).toContainText(['Open','Under way','Done lately']);
        if (name === 'orgs') await expect(page.locator('#list table[aria-label=Organizations] tbody tr')).toHaveCount(2);
        if (['admin','appGroup','person','fileRecord'].includes(name) && viewport.width === 1440) {
          expect(await page.locator('.wb-section dl').evaluateAll(rows=>rows.every(row=>{
            const label=row.querySelector('dt').getBoundingClientRect(), value=row.querySelector('dd').getBoundingClientRect();
            return value.left-label.right <= 20;
          })),name+' adjacent labels').toBe(true);
        }
        if (['fileRecord','sessions','search','appGroup'].includes(name)) {
          expect(await page.locator('time[data-local-time]').evaluateAll(times=>times.every(t=>! /\\d{4}-\\d{2}-\\d{2}T/.test(t.textContent) && t.title.length > 10))).toBe(true);
        }
        await expect(page.locator('.card,.grid,.onramp,.intent-card,.bars,.board,.bcol,.bcard,.progress,.closure-counts,.diff')).toHaveCount(0);
        await expect(page.locator('#rail #org-places')).toHaveCount(1);
        await expect(page.locator('#rail #explorer')).toHaveCount(1);
        await expect(page.locator('.bar .wb-breadcrumb')).toBeVisible();
        expect(await page.locator('.pane').evaluateAll(panes => panes.every(p => p.scrollWidth <= p.clientWidth + 1)), `${name}: pane horizontal overflow`).toBe(true);
        if (!route.startsWith('https:')) {
        await expect(page.locator('#explorer')).toHaveCount(1);
        expect(await page.locator('#explorer .wb-tree').count()).toBeGreaterThanOrEqual(1);
        await expect(page.locator('#rail #explorer')).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
        const visibleNavigation = await page.evaluate(() => ['rail','explorer'].map(id => {const r=document.getElementById(id).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;}));
        expect(visibleNavigation).toEqual(viewport.width >= 1280 ? [true,true] : [false,false]);
        if (viewport.width < 760) await expect(page.locator('.tabs')).toBeVisible();
        } else expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
      }
      if (phase === 'after' && name.startsWith('performance')) {
        await expect(page.locator('#list h1')).toHaveText('Performance');
        await expect(page.locator('#list')).not.toContainText('Performance unavailable');
        await expect(page.locator('#list table')).toBeVisible();
        await expect(page.locator('#explorer')).toContainText('Site: workbench.example.com');
        if(name === 'performance') {
          const listBefore=await page.locator('#list').evaluate(el=>el.scrollTop);
          await page.locator('#list tr[data-href] a').first().click();
          await page.waitForURL(/selected=/);
          await expect(page.locator('#inspector')).toContainText('Latency histogram');
          await expect(page.locator('#inspector')).toContainText('Request waterfall');
          expect(await page.locator('#list').evaluate(el=>el.scrollTop)).toBe(listBefore);
          await page.goBack();await expect(page.locator('#inspector')).toBeHidden();
          await page.reload();await expect(page.locator('#list h1')).toHaveText('Performance');
        }
        if(name === 'performanceRoute') {
          await expect(page.locator('#inspector')).toContainText('Where the time goes');
          await expect(page.locator('#inspector a[href*="/files?ref="]').first()).toHaveAttribute('href',/ref=b{40}/);
        }
      }
      if (phase === 'after' && name === 'board') {
        // Native selects size to their longest option, including unselected names.
        await db.prepare("UPDATE identity SET display_name = ? WHERE email = 'dev@example.test'").bind('<img src=x onerror=alert(1)>' + 'X'.repeat(120)).run();
        await page.reload();
        expect(await page.locator('.pane').evaluateAll(panes => panes.every(p => p.scrollWidth <= p.clientWidth + 1)), 'Board: long person picker overflow').toBe(true);
        await db.prepare("UPDATE identity SET display_name = 'dev' WHERE email = 'dev@example.test'").run();
        await page.reload();
      }
      if (phase === 'after' && ['people','apps','situations','usage','search','sessions'].includes(name)) {
        await expect(page.locator('#list .card, #list .grid, #list .bars')).toHaveCount(0);
        const link = name === 'people' ? page.locator('#list a').filter({hasText:/^Build agent$/}) :
          name === 'apps' ? page.locator('#list a').filter({hasText:/^Workbench request failed$/}) :
          name === 'situations' ? page.locator('#list a').filter({hasText:/^Investigate the workbench$/}) :
          name === 'usage' ? page.locator('#list a').filter({hasText:/^dev$/}) :
          name === 'sessions' ? page.locator('#list tr[data-href] a').first() :
          page.locator('#list a').filter({hasText:/^Launch the workbench$/});
        const initialURL = page.url();
        await page.evaluate(()=>{window.orgList=document.getElementById('list'); window.orgRail=document.getElementById('rail');});
        await link.first().click();
        await expect(page.locator('#inspector')).toBeVisible();
        const selectedURL = page.url();
        expect(selectedURL).not.toBe(initialURL);
        expect(await page.evaluate(()=>window.orgList === document.getElementById('list') && window.orgRail === document.getElementById('rail'))).toBe(true);
        if (name === 'search') {
          await expect(page.locator('#inspector h1')).toContainText('Launch the workbench');
          expect(new URL(selectedURL).searchParams.get('q')).toBe('workbench');
          await expect(page.locator('#inspector a.button')).toHaveAttribute('href','/sample/w/1');
        }
        if (name === 'people') await expect(page.locator('#inspector')).toContainText('Active tokens');
        if (name === 'apps') await expect(page.locator('#inspector a.button')).toContainText('File a snag');
        if (name === 'situations') await expect(page.locator('#inspector form[action="/api/situation.resolve"]')).toBeVisible();
        if (name === 'usage') await expect(page.getByRole('table',{name:'Recorded calls',exact:true})).toBeVisible();
        if (name === 'sessions') await expect(page.locator('#inspector form[action="/api/session.revoke"]')).toBeVisible();
        const closeURL = new URL(await page.locator('#inspector a.back').getAttribute('href'),selectedURL).href;
        await page.reload();
        await expect(page.locator('#inspector')).toBeVisible();
        await page.screenshot({path:path.join(artifacts,`${phase}-${name}-selected-${label}.png`),fullPage:false});
        manifest.push({phase,name:name+'-selected',route:selectedURL,viewport,file:`${phase}-${name}-selected-${label}.png`});
        await page.locator('#inspector [data-close-inspector]').click();
        await expect(page).toHaveURL(closeURL);
        await page.goBack();
        await expect(page).toHaveURL(selectedURL);
        await expect(page.locator('#inspector')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(closeURL);
      }
      if (phase === 'after' && ['admin','models','orgs','adminApps','mailSettings','mailRecipients'].includes(name)) {
        const summary = page.locator('.wb-inline-edit > summary').first();
        await summary.click();
        await expect(page.locator('.wb-inline-edit[open] form').first()).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.wb-inline-edit[open]')).toHaveCount(0);
      }
      if (phase === 'after' && name === 'newWork') {
        await expect(page.locator('#list form[action="/api/work.create"]')).toBeVisible();
        await expect(page.locator('#inspector')).not.toBeVisible();
        await page.locator('#new-project').selectOption('team-1');
        await page.locator('#new-kind').selectOption('errand');
        await page.locator('#new-title').fill('Browser filed work '+label);
        await page.locator('#list button[type=submit]').click();
        await expect(page.locator('#inspector h1')).toContainText('Browser filed work '+label);
        await expect(page.locator('.bar .file')).toHaveCount(1);
        await page.locator('.bar .file').click();
        await expect(page.locator('#list h1')).toHaveText('File work');
        await expect(page.locator('.bar .file')).toHaveCount(0);
      }
      if (phase === 'after' && ['attention','attentionItem','mail','mailMessage','chat','chatThread','assistant'].includes(name)) {
        if (name.startsWith('attention')) {
          await expect(page.getByRole('table',{name:'Needs me',exact:true})).toBeVisible();
          if (name === 'attentionItem') {
            await expect(page.locator('#inspector h1')).toContainText('Keep project navigation visible');
            await expect(page.locator('#inspector form[action="/api/work.update"]')).not.toHaveCount(0);
            await page.locator('#inspector [data-close-inspector]').click();
            await expect(page).toHaveURL(/attention\?done=1$/);
          }
        }
        if (name === 'mail' || name === 'mailMessage') {
          await expect(page.getByRole('table',{name:'Mail',exact:true})).toBeVisible();
          if (name === 'mailMessage') {
            await expect(page.locator('#inspector form[action="/api/mail.reply"]')).toBeVisible();
            await expect(page.locator('#inspector form[action="/api/mail.propose_work"]')).toBeVisible();
            await expect(page.locator('#inspector [data-delivery=blocked]')).toBeVisible();
            await page.locator('#inspector [data-close-inspector]').click();
            await expect(page).toHaveURL(/mail\?project=sample$/);
          }
        }
        if (name === 'chat' || name === 'chatThread') {
          await expect(page.locator('#explorer a[href="/c?kind=direct"]')).toHaveCount(1);
          await expect(page.locator('#explorer a[href="/c?kind=group"]')).toHaveCount(1);
          await expect(page.locator('#list .channel-messages')).toBeVisible();
          await expect(page.locator('#inspector [data-chat-presence]')).toBeVisible();
          if (name === 'chatThread') await expect(page.locator('#inspector .thread-root')).toBeVisible();
        }
        if (name === 'assistant') {
          await expect(page.getByRole('table',{name:'Conversations',exact:true})).toBeVisible();
          await expect(page.locator('#inspector #chatlog')).toContainText('What needs my attention today?');
          await expect(page.locator('#inspector #ask')).toBeVisible();
        }
      }
      if (phase === 'after' && ['wiki','research','files','contacts'].includes(name)) {
        await expect(page.locator('#list .wb-toolbar')).not.toHaveCount(0);
        await page.evaluate(() => { window.knowledgeList = document.getElementById('list'); });
        await page.locator('#list a').filter({hasText: name === 'wiki' ? 'Team handbook' : name === 'research' ? 'Workbench findings' : name === 'files' ? /^notes.txt$/ : 'Alex Example'}).first().click();
        await expect(page.locator('#inspector h1')).toBeVisible();
        expect(await page.evaluate(() => window.knowledgeList === document.getElementById('list')),name+' retains working pane').toBe(true);
        const selected = page.url();
        await page.reload();
        expect(page.url()).toBe(selected);
        await expect(page.locator('#inspector h1')).toBeVisible();
        await page.locator('[data-close-inspector]').click();
        await expect(page.locator('main.panes')).toHaveClass(/one/);
        await page.goBack();
        await expect(page.locator('#inspector h1')).toBeVisible();
      }
      if (phase === 'after' && name === 'files') {
        await page.locator('#list a').filter({hasText:/^Upload$/}).click();
        await expect(page.locator('#inspector form[action="/knowledge/documents/upload"]')).toHaveAttribute('enctype','multipart/form-data');
        await page.locator('#inspector input[type=file]').setInputFiles({name:'browser-knowledge-'+label+'.txt',mimeType:'text/plain',buffer:Buffer.from('Native knowledge upload')});
        const uploaded = page.waitForResponse(r=>r.url().endsWith('/knowledge/documents/upload'));
        await page.locator('#inspector button').filter({hasText:/^Upload$/}).click();
        expect((await uploaded).status()).toBe(200);
        await expect(page.locator('#list table[aria-label=Files]')).toContainText('browser-knowledge-'+label+'.txt');
      }
      if (phase === 'after' && name === 'wikiPage') {
        await page.locator('#inspector summary[aria-label="Change Content"]').click();
        await page.locator('#inspector textarea[name=body]').fill('Inline browser revision');
        await page.locator('#inspector form[action="/api/wiki.write"] input[name=note]').fill('Browser edit');
        await page.locator('#inspector button').filter({hasText:'Save revision'}).click();
        await expect(page.locator('#inspector .prose')).toHaveText('Inline browser revision');
      }
      if (phase === 'after' && name === 'graph') {
        await expect(page.locator('#list svg[aria-label="Contact neighborhood"]')).toBeVisible();
        await expect(page.locator('#inspector h1')).toHaveText('Alex Example');
        await expect(page.locator('#inspector table[aria-label=Connections]')).toContainText('Example Company');
        if (viewport.width >= 1280) {
          const working = await page.locator('#list').boundingBox(), inspector = await page.locator('#inspector').boundingBox();
          expect(working.x + working.width <= inspector.x).toBe(true);
          expect(inspector.x + inspector.width <= viewport.width).toBe(true);
        }
        if (viewport.width < 760) {
          await page.locator('#list svg [data-node]').first().scrollIntoViewIfNeeded();
          await page.screenshot({path:path.join(artifacts,`${phase}-graph-neighborhood-${label}.png`),fullPage:false});
          manifest.push({phase,name:'graph-neighborhood',route,viewport,file:`${phase}-graph-neighborhood-${label}.png`});
        }
        await page.locator('#list svg a').filter({hasText:'Example Company'}).click();
        await expect(page.locator('#inspector h1')).toHaveText('Example Company');
        await expect(page.locator('#list svg')).toBeVisible();
        await page.goBack();
        await expect(page.locator('#inspector h1')).toHaveText('Alex Example');
      }
      if (phase === 'after' && ['home','overview','workspace'].includes(name)) {
        await expect(page.locator('#list .card, #list .grid, #list .onramp')).toHaveCount(0);
        await expect(page.locator('#list .wb-toolbar')).toHaveCount(1);
        if (viewport.width === 1440) {
          expect(await page.locator('#list').evaluate(el => el.scrollHeight <= el.clientHeight), name+' fits without scrolling').toBe(true);
        }
        await page.evaluate(() => { window.overviewList = document.getElementById('list'); });
        const link = page.locator('#list tr[data-href] a').first();
        await link.click();
        await expect(page.locator('#inspector h1')).toBeVisible();
        expect(await page.evaluate(() => window.overviewList === document.getElementById('list')),name+' retains working pane').toBe(true);
        const selectedURL = page.url();
        await page.reload();
        expect(page.url()).toBe(selectedURL);
        await expect(page.locator('#inspector h1')).toBeVisible();
        await page.screenshot({path:path.join(artifacts,`${phase}-${name}-selected-${label}.png`),fullPage:false});
        manifest.push({phase,name:name+'-selected',route:new URL(selectedURL).pathname+new URL(selectedURL).search,viewport,file:`${phase}-${name}-selected-${label}.png`});
        await page.locator('[data-close-inspector]').click();
        await expect(page.locator('main.panes')).toHaveClass(/one/);
        await page.goBack();
        await expect(page.locator('#inspector h1')).toBeVisible();
        await page.goForward();
        await expect(page.locator('main.panes')).toHaveClass(/one/);
        if (name === 'workspace') {
          await page.locator('#list a').filter({hasText:'New page',exact:true}).click();
          await expect(page.locator('#inspector form')).toHaveAttribute('action','/api/wiki.write');
          await page.locator('#inspector input[name=slug]').fill('browser-page');
          await page.locator('#inspector input[name=title]').fill('Browser created page');
          await page.locator('#inspector input[name=note]').fill('Acceptance');
          if (label === '1440') {
            await page.getByRole('button',{name:'Create page',exact:true}).click();
            await expect(page).toHaveURL(/\/knowledge\/wiki\/browser-page$/);
            await expect(page.locator('#list')).toContainText('Browser created page');
          }
          await page.goto(base+'/knowledge?resource=upload');
          await expect(page.locator('#inspector form')).toHaveAttribute('data-reload','');
          if (label === '1440') {
            await page.locator('#inspector input[type=file]').setInputFiles({name:'browser.txt',mimeType:'text/plain',buffer:Buffer.from('Browser uploaded file')});
            const uploaded = page.waitForResponse(r => r.url().endsWith('/knowledge/documents/upload'));
            await page.getByRole('button',{name:'Upload',exact:true}).click();
            // Native form redirects are followed in-process by this local bridge.
            expect((await uploaded).headers()['x-local-final-url']).toBe(base+'/knowledge/documents');
            await expect(page.locator('#list')).toContainText('browser.txt');
          }
          await page.goto(base+'/knowledge?resource=share');
          await expect(page.locator('#inspector')).toContainText('Only workspace members');
        }
        if (name === 'home' && label === '1440' && process.env.WORKBENCH_PAGES) {
          await page.goto(base+'/');
          await page.evaluate(() => { window.homeList = document.getElementById('list'); });
          await page.locator('#list table[aria-label="Needs me"] a').first().click();
          await expect(page.locator('#inspector h1')).toContainText('Keep project navigation visible');
          expect(await page.evaluate(() => window.homeList === document.getElementById('list'))).toBe(true);
          await page.locator('[data-close-inspector]').click();
          await expect(page.locator('#list')).toContainText('Nothing needs you right now.');
        }
      }
      if (phase === 'after' && ['board','status','code','reviews','codeFiles','deploys'].includes(name)) {
        await expect(page.locator('#list .wb-toolbar')).toHaveCount(1);
        await expect(page.locator('#list .card')).toHaveCount(0);
        const row = page.locator('#list tr[data-href]').first();
        await page.evaluate(() => { window.viewList = document.getElementById('list'); });
        await row.locator('a').first().click();
        await expect(page.locator('#inspector .back')).toHaveCount(1);
        await expect(page.locator('#inspector')).toBeVisible();
        expect(await page.evaluate(() => window.viewList === document.getElementById('list')), name+' retains its list').toBe(true);
        const selectedURL = page.url();
        await page.reload();
        expect(page.url()).toBe(selectedURL);
        await expect(page.locator('#inspector')).toBeVisible();
        if (['board','status'].includes(name)) {
          await expect(page.locator('#list tr[aria-selected="true"]').first()).toHaveCount(1);
          await expect(page.locator('#inspector input[name=expected_updated_at]').first()).toHaveCount(1);
        }
        if (viewport.width >= 1280) {
          await page.keyboard.press('Escape');
          await expect(page.locator('main.panes')).toHaveClass(/one/);
          await page.goBack();
          await expect(page.locator('#inspector')).toBeVisible();
        }
      }
      if (phase === 'after' && name === 'workGraph') {
        await page.locator('#list a').filter({hasText:'sample#2 '}).click();
        await expect(page).toHaveURL(/\/sample\/graph\?work=sample%232$/);
        await expect(page.locator('#inspector')).toContainText('Dependencies and resources');
        if (viewport.width >= 1280) {
          const listBox = await page.locator('#list').boundingBox(), inspectorBox = await page.locator('#inspector').boundingBox();
          expect(inspectorBox.x).toBeGreaterThan(listBox.x);
        } else {
          const listBox = await page.locator('#list').boundingBox(), inspectorBox = await page.locator('#inspector').boundingBox();
          expect(inspectorBox.y).toBeGreaterThan(listBox.y);
        }
        const add = page.locator('#inspector form[action="/api/work.depend"]').filter({has:page.locator('input[name="on"]:not([type="hidden"])')});
        await page.locator('#inspector .wb-add-dependency').first().locator('summary').click();
        await add.locator('input[name="on"]').fill('sample#1');
        await add.getByRole('button', {name:'Add', exact:true}).click();
        await expect(page.locator('#list tr').filter({hasText:'sample#2 '})).toContainText('blocked: waits on sample#1');
        await page.screenshot({path:path.join(artifacts,`${phase}-dependency-blocked-${label}.png`),fullPage:false});
        manifest.push({phase,name:'dependency-blocked',route:'/sample/graph?work=sample%232',viewport,file:`${phase}-dependency-blocked-${label}.png`});
        await page.reload();
        await expect(page.locator('#list tr[aria-selected="true"]')).toContainText('sample#2');
        await page.goto(base+'/sample/frontier');
        await expect(page.locator('#list [aria-label="Readiness counts"]')).toContainText('Blocked 1');
        await expect(page.locator('#list')).not.toContainText('Keep project navigation visible');
        await page.goto(base+'/sample/graph?work=sample%232');
        await page.locator('#inspector form[action="/api/work.depend"]').filter({has:page.locator('input[name="remove"]')}).getByRole('button', {name:'Remove dependency'}).click();
        await expect(page.locator('#list tr').filter({hasText:'sample#2 '})).toContainText('ready');
        await page.goto(base+'/sample/frontier');
        await expect(page.locator('#list')).toContainText('Keep project navigation visible');
        await page.goto(base+'/sample/docket');
      }
      if (phase === 'after' && name === 'docket') {
        await expect(page.locator('.wb-table tbody tr')).toHaveCount(4);
        await expect(page.locator('.bar .wb-breadcrumb')).toContainText('Sample project');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const row = page.locator('.wb-table tbody tr').filter({hasText:'Keep project navigation visible'});
        await row.locator('a').click();
        await expect(page).toHaveURL(/\/sample\/w\/2$/);
        await expect(page.locator('.wb-table tr[aria-selected="true"]')).toContainText('Keep project navigation visible');
        await page.reload();
        await expect(page.locator('.wb-table tr[aria-selected="true"]')).toContainText('Keep project navigation visible');
        await page.goto(base+'/sample/docket');
        await page.emulateMedia({colorScheme:'dark'});
        await page.screenshot({path:path.join(artifacts,`${phase}-docket-dark-${label}.png`),fullPage:false});
        manifest.push({phase,name:'docket-dark',route,viewport,file:`${phase}-docket-dark-${label}.png`});
        await page.emulateMedia({colorScheme:'light'});
      }
    }
    if (phase === 'after' && !process.env.WORKBENCH_PAGES) {
      await page.goto(base+'/sample/docket');
      if (viewport.width >= 1280) {
        expect(await page.locator('#list').evaluate(el => el.clientWidth)).toBeGreaterThanOrEqual(900);
        for (const title of await page.locator('.work-title').all()) {
          expect(await title.evaluate(el => el.scrollHeight)).toBeLessThanOrEqual(28);
          expect(await title.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap');
        }
        await expect(page.locator('#explorer summary')).not.toContainText(['Open ']);
        await page.locator('[data-toggle-sidebar]').click();
        await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
        await page.reload();
        await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
        await expect(page.locator('[data-toggle-sidebar]')).toHaveAttribute('aria-expanded','false');
        await page.locator('#list tbody a').filter({hasText:'Keep project navigation visible'}).click();
        await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
        await page.locator('[data-toggle-sidebar]').click();
        await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);
        expect(await page.locator('#list').evaluate(el => el.clientWidth)).toBeGreaterThanOrEqual(640);
        const titleEdit = page.locator('#inspector h1 details');
        await titleEdit.locator('summary').click();
        await titleEdit.locator('input[name=title]').fill('Cancelled title');
        await page.keyboard.press('Escape');
        await expect(titleEdit).not.toHaveAttribute('open');
        await expect(titleEdit.locator('input[name=title]')).toHaveValue('Keep project navigation visible');
        await expect(page.locator('#inspector summary')).not.toContainText(['Edit ']);
        await page.goto(base+'/sample/docket');
        const repository = page.locator('#explorer details').filter({has:page.locator('summary a[href$="/sample/code"]')});
        await repository.locator('.wb-chevron').first().click();
        await expect(repository).not.toHaveAttribute('open');
        await page.reload();
        await expect(repository).not.toHaveAttribute('open');
        await page.locator('#explorer summary a[href$="/sample/code"]').click();
        await expect(page).toHaveURL(/\/sample\/code$/);
        await expect(repository).not.toHaveAttribute('open');
        await page.locator('#rail a[href$="/mail"]').click();
        await expect(page).toHaveURL(/\/mail$/);
        await expect(page.locator('#explorer')).toHaveAttribute('data-project','sample');
        await page.locator('#project-filter').fill('knowledge');
        await expect(page.locator('[aria-label="Other projects"] li:visible')).toHaveCount(1);
        await page.locator('.project-switcher a[href$="/knowledge"]').click();
        await expect(page).toHaveURL(/\/knowledge$/);
        await expect(page.locator('#explorer')).toHaveAttribute('data-project','knowledge');
        await page.reload();
        await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);
        await page.setViewportSize({width:1100,height:900});
        await page.locator('.bar .menu').click();
        await expect.poll(async () => (await page.locator('#rail').boundingBox()).x).toBeGreaterThanOrEqual(0);
        await expect(page.locator('#explorer')).toBeVisible();
        await page.locator('#rail>.railhead .close').click();
      } else {
        await page.locator('.bar .menu').click();
        await expect.poll(async () => (await page.locator('#rail').boundingBox()).x).toBeGreaterThanOrEqual(0);
        await expect(page.locator('#explorer')).toBeVisible();
        await page.locator('#rail>.railhead .close').click();
      }
      await page.setViewportSize(viewport);
      // Two real page types exercise the shared selection and mutation client.
      await page.goto(base+'/sample/docket?kind=wish');
      await expect(page.getByRole('button', {name:'Show',exact:true})).toHaveCount(0);
      await page.locator('select[name="closed"]').selectOption('1');
      await expect(page).toHaveURL(/closed=1/);
      await page.locator('select[name="closed"]').selectOption('');
      await expect(page.locator('#list')).toContainText('Keep project navigation visible');
      await page.goto(base+'/sample/docket?kind=wish');
      await expect(page.locator('main.panes')).toHaveClass('panes one');
      await page.locator('#list input[data-filter]').fill('navigation');
      await expect(page).toHaveURL(/filter=navigation/);
      if (viewport.width >= 1280) {
        await page.locator('#explorer a').filter({hasText:/^Board/}).click();
        await expect(page).toHaveURL(/\/sample\/board\?filter=navigation$/);
        await page.locator('#explorer details').filter({has:page.locator('summary a[href*="/sample/code"]:not([href*="repo="])')}).evaluate(el => { el.open = true; });
        await page.locator('#explorer a[href*="/sample/files?repo=default"]').click();
        await expect(page).toHaveURL(/\/sample\/files\?repo=default&filter=navigation$/);
        await page.goBack();
        await expect(page).toHaveURL(/\/sample\/board\?filter=navigation$/);
        await page.goBack();
        await expect(page).toHaveURL(/\/sample\/docket\?kind=wish&filter=navigation$/);
        await expect(page.locator('#list input[data-filter]')).toHaveValue('navigation');
      }
      await expect(page.locator('#list')).toHaveAttribute('data-key', 'docket:sample:kind=wish');
      await page.evaluate(() => { window.retainedList = document.getElementById('list'); });
      await page.locator('#list tbody a').click();
      await expect(page.locator('#inspector h1')).toContainText('Keep project navigation visible');
      expect(await page.evaluate(() => window.retainedList === document.getElementById('list'))).toBe(true);
      await expect(page.locator('#list input[data-filter]')).toHaveValue('navigation');
      const titleEdit = page.locator('#inspector h1 details');
      await titleEdit.locator('summary').click();
      await titleEdit.locator('input[name=title]').fill('Keep navigation in place');
      await titleEdit.locator('input[name=title]').press('Enter');
      await expect(page.locator('#inspector h1')).toContainText('Keep navigation in place');
      if (viewport.width >= 1280) {
        expect(await page.locator('#inspector').evaluate(el => el.getBoundingClientRect().width)).toBe(390);
        await page.locator('.wb-resizer').focus();
        await page.keyboard.press('ArrowLeft');
        expect(await page.locator('#inspector').evaluate(el => el.getBoundingClientRect().width)).toBe(410);
      }
      await page.reload();
      await expect(page.locator('#inspector h1')).toContainText('Keep navigation in place');
      await expect(page.locator('#list input[data-filter]')).toHaveValue('navigation');
      await page.locator('[data-close-inspector]').click();
      await expect(page.locator('main.panes')).toHaveClass('panes one');
      await page.goBack();
      await expect(page.locator('#inspector h1')).toContainText('Keep navigation in place');
      await page.goForward();
      await expect(page.locator('main.panes')).toHaveClass('panes one');
      await page.goto(base+'/sample/docket');
      await page.keyboard.press('j');
      await expect(page.locator('#inspector h1')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('main.panes')).toHaveClass('panes one');
      await verb(member, 'work.update', {id:'sample#2', title:'Keep project navigation visible'});
      await page.goto(base+'/sample/w/2');
      const composer = page.locator('.wb-comment textarea');
      const compactHeight = await composer.evaluate(el=>el.getBoundingClientRect().height);
      await composer.focus();
      expect(await composer.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThan(compactHeight);
      await expect(page.locator('#inspector')).not.toContainText('Recorded below');
      await page.goto(base+'/people');
      await page.evaluate(() => { window.retainedList = document.getElementById('list'); });
      await page.locator('#list a').filter({hasText:/^peer$/}).click();
      await expect(page.locator('#inspector h1')).toContainText('peer');
      expect(await page.evaluate(() => window.retainedList === document.getElementById('list'))).toBe(true);
      await page.locator('#inspector select[name=role]').selectOption('reader');
      await page.getByRole('button', {name:'Change role', exact:true}).click();
      await expect(page.locator('#inspector select[name=role]')).toHaveValue('reader');
      await page.reload();
      await expect(page.locator('#inspector select[name=role]')).toHaveValue('reader');
      await page.locator('[data-close-inspector]').click();
      await expect(page.locator('main.panes')).toHaveClass('panes one');
      await page.goBack();
      await expect(page.locator('#inspector h1')).toContainText('peer');
      await page.goForward();
      await expect(page.locator('main.panes')).toHaveClass('panes one');
      await verb(member, 'member.set_role', {email:'peer@example.test', role:'member'});
      console.log(`Shell and master–detail browser acceptance passed at ${viewport.width}px (single sidebar, selection and inline edits).`);
    }
    if (viewport.width === 1440) {
      await page.goto(base+'/sample/docket');
      const selectResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/sample/w/2' && r.request().resourceType() === 'fetch');
      await page.locator('#list tr[data-href="/sample/w/2"] a').first().click();
      const selection = await selectResponse;
      await expect(page.locator('#inspector h1')).toContainText('Keep project navigation visible');
      await page.waitForTimeout(50);
      await flushTiming();
      const selectId = selection.headers()['x-request-id'];
      for (const name of ['navigation','pane.swap','inspector.open']) await joinedPoint(selectId,p => p.blobs[13] === name);
      for (const phase of ['ready','fetch','render']) await joinedPoint(selectId,p => p.blobs[13] === 'docket.select' && p.blobs[8] === phase);
      const ready = perfPoints.find(p => p.blobs[5] === selectId && p.blobs[13] === 'docket.select' && p.blobs[8] === 'ready');
      const fetched = perfPoints.find(p => p.blobs[5] === selectId && p.blobs[13] === 'docket.select' && p.blobs[8] === 'fetch');
      expect(ready.doubles[0]).toBeGreaterThanOrEqual(fetched.doubles[0]);
      await joinedPoint(selectId,p => p.blobs[8] === 'spinner');
      await joinedPoint(selectId,p => ['docket.select','list.select'].includes(p.blobs[13]) && p.blobs[8] === 'paint');
      // A real server mutation, not a manufactured browser event.
      await page.goto(base+'/new?project=sample');
      await page.locator('input[name=title]').fill('Timing audit fixture');
      const submitResponse = page.waitForResponse(r => r.request().method() === 'POST' && r.request().resourceType() === 'fetch');
      await page.locator('#list button[type=submit]').click();
      const submitted = await submitResponse;
      await expect(page).toHaveURL(/\/sample\/w\/\d+$/);
      await page.waitForTimeout(50);
      await flushTiming();
      const submitId = submitted.headers()['x-request-id'];
      await joinedPoint(submitId,p => p.blobs[13] === 'form.submit' && p.blobs[8] === 'fetch');
      await joinedPoint(submitId,p => p.blobs[8] === 'spinner');
      await db.prepare("DELETE FROM work_item WHERE project_id = ? AND title = 'Timing audit fixture'").bind(sampleId).run();
      console.log('Browser timing navigation, pane, form, paint and spinner joins passed.');
    }
    await ctx.close();
  }
  await writeFile(path.join(artifacts,`${phase}-manifest.json`),JSON.stringify(manifest,null,2));
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await mf?.dispose();
  await rm(temp,{recursive:true,force:true});
}
