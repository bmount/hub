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

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'pimwell-chat-browser-'));
const artifacts = path.resolve(process.env.WORKBENCH_ARTIFACTS || await mkdtemp(path.join(tmpdir(), 'pimwell-chat-screenshots-')));
await mkdir(artifacts, { recursive: true });
const host = 'acme.pimwell.test';
const base = `https://${host}`;
let mf, browser, cacheBrowser, cacheServer, chatClient;
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
    bindings: { HUB_DOMAIN: 'pimwell.test', ARDI_REPO_CREATE: 'off', HUB_SECRETS_KEY: randomBytes(32).toString('base64') },
    d1Databases: ['HUB_DB'], r2Buckets: ['GIT_PUSH_STAGING'], kvNamespaces: ['RATE', 'OAUTH_KV'],
    durableObjects: { CONVERSATION: { className: 'Conversation', useSQLite: true }, INBOX: { className: 'Inbox', useSQLite: true } },
    serviceBindings: { ARDI: async request => {
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
    outboundService: () => new Response('Local acceptance denies network access', { status: 503 }),
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
  await verb(member, 'chat.post', {c: 'general', body: 'Please review the compact workbench.'});
  await verb(member, 'review.request', {project:'sample',branch:'topic',title:'Keep navigation visible',summary:'Synthetic review of the workbench.',reviewers:['peer@example.test']});
  const sampleId = await db.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'sample'").bind(tenant).first('id');
  await db.prepare("INSERT INTO app_deploy (id,tenant_id,project_id,script_name,version_id,tag,message,seen_at) VALUES (?,?,?,?,?,?,?,?)").bind('synthetic-deploy',tenant,sampleId,'sample-worker','b'.repeat(40),'workbench','Synthetic deploy record; not a live rollout.',now).run();
  if (process.env.WORKBENCH_PAGES) {
    for (let n=1;n<=10;n++) await verb(member, 'project.create', {slug:'team-'+n,kind:n%2 ? 'tracker' : 'wiki',display_name:'Team '+n});
    const viewer = await db.prepare("SELECT id FROM identity WHERE email = 'dev@example.test'").first('id');
    const work = await db.prepare("SELECT id FROM work_item WHERE project_id = ? AND number = 2").bind(sampleId).first('id');
    for (let n=1;n<=5;n++) await db.prepare("INSERT INTO attention (id,tenant_id,identity_id,reason,item_id,summary,created_at) VALUES (?,?,?,'comment',?,?,?)").bind(id(),tenant,viewer,work,'Review navigation change '+n,now+n).run();
    await verb(member, 'research.save', {project:'knowledge',slug:'findings',expected_revision:0,topic:'Workbench findings',summary:'Synthetic research fixture.',status:'draft',sources:[],note:'Fixture'});
    await verb(member, 'file.put', {project:'knowledge',path:'notes.txt',content_type:'text/plain',expected_revision:0,base64:Buffer.from('Synthetic file fixture.').toString('base64')});
    await verb(member, 'file.put', {project:'knowledge',path:'handbook/notes.txt',content_type:'text/plain',expected_revision:0,base64:Buffer.from('Folder fixture.').toString('base64')});
    await verb(member,'person.upsert',{project:'knowledge',id:contact.entity.id,expected_revision:1,name:'Alex Example',title:'Designer',emails:['alex@example.test'],links:[{kind:'research',ref:'findings'},{kind:'file',ref:'notes.txt'}]});
  }
  browser = await chromium.launch({headless: true});
  const pages = {home:'/', overview:'/sample', workspace:'/knowledge', docket:'/sample/docket', item:'/sample/w/2', workGraph:'/sample/graph', frontier:'/sample/frontier', board:'/sample/board', status:'/sample/status', code:'/sample/code', commit:'/sample/code?c='+ 'b'.repeat(40), codeFiles:'/sample/files', codeFile:'/sample/files?f=app.ts', reviews:'/sample/reviews', review:'/sample/reviews/1', deploys:'/apps?project=sample#deploys', deploy:'/apps?project=sample&d=synthetic-deploy', wiki:'/knowledge/wiki', wikiPage:'/knowledge/wiki/welcome', research:'/knowledge/wiki?view=research', researchRecord:'/knowledge/wiki/findings?view=research', files:'/knowledge/documents', fileRecord:'/knowledge/documents?path=notes.txt', contacts:'/knowledge/contacts', contact:`/knowledge/contacts/${contact.entity.id}`, graph:`/knowledge/contacts/${contact.entity.id}?view=graph`, mail:'/mail', chat:'/c/general', assistant:'/assistant', people:'/people', apps:'/apps', usage:'/usage', admin:'/admin/agents', search:'/search?q=workbench'};
  const phase = process.env.WORKBENCH_PHASE || 'before';
  const manifest = [];
  for (const [label, viewport] of [['1440', {width:1440,height:900}], ['1920',{width:1920,height:1080}], ['390',{width:390,height:844}]]) {
    const ctx = await browser.newContext({viewport, serviceWorkers:'block'});
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
      if (url.hostname !== host) return route.abort();
      let res = await mf.dispatchFetch(req.url(), {method:req.method(), headers:{...await req.allHeaders(),'x-local-browser-host':host}, body:req.postDataBuffer() || undefined, redirect:'manual'});
      let finalURL = req.url();
      for (let n=0; res.status >= 300 && res.status < 400 && res.headers.has('location'); n++) {
        if (n > 5) throw new Error('Redirect loop');
        const target = new URL(res.headers.get('location'),req.url());
        if (target.hostname !== host) throw new Error('External redirect refused');
        finalURL = target.href;
        res = await mf.dispatchFetch(target.href,{headers:{'x-local-browser-host':host,cookie:`pmw_session=${member}`},redirect:'manual'});
      }
      await route.fulfill({status:res.status,headers:{...Object.fromEntries(res.headers),'x-local-final-url':finalURL},body:Buffer.from(await res.arrayBuffer())});
    });
    const page = await ctx.newPage();
    for (const [name, route] of Object.entries(pages).filter(([name]) => !process.env.WORKBENCH_PAGES || process.env.WORKBENCH_PAGES.split(',').includes(name))) {
      const response = await page.goto(base+route);
      expect(response.status(), name).toBe(200);
      await page.locator('main').waitFor();
      await page.screenshot({path:path.join(artifacts,`${phase}-${name}-${label}.png`),fullPage:false});
      manifest.push({phase,name,route,viewport,file:`${phase}-${name}-${label}.png`});
      if (phase === 'after') {
        await expect(page.locator('.bar .wb-breadcrumb')).toBeVisible();
        await expect(page.locator('#explorer')).toHaveCount(1);
        await expect(page.locator('#explorer .wb-tree')).toHaveCount(1);
        await expect(page.locator('#rail #explorer')).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
        const visibleNavigation = await page.evaluate(() => ['rail','explorer'].map(id => {const r=document.getElementById(id).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;}));
        expect(visibleNavigation).toEqual(viewport.width >= 1280 ? [true,true] : [false,false]);
        if (viewport.width < 760) await expect(page.locator('.tabs')).toBeVisible();
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
        await add.locator('input[name="on"]').fill('sample#1');
        await add.getByRole('button', {name:'Add dependency', exact:true}).click();
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
        const repository = page.locator('#explorer details').filter({has:page.locator('summary',{hasText:'Repository and code'})});
        await repository.locator('.wb-chevron').click();
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
        await page.locator('[data-toggle-sidebar]').click();
        await expect.poll(async () => (await page.locator('#rail').boundingBox()).x).toBeGreaterThanOrEqual(0);
        await expect(page.locator('#explorer')).toBeVisible();
        await page.locator('#rail>.railhead .close').click();
      } else {
        await page.locator('[data-toggle-sidebar]').click();
        await expect.poll(async () => (await page.locator('#rail').boundingBox()).x).toBeGreaterThanOrEqual(0);
        await expect(page.locator('#explorer')).toBeVisible();
        await page.locator('#rail>.railhead .close').click();
      }
      await page.setViewportSize(viewport);
      // Two real page types exercise the shared selection and mutation client.
      await page.goto(base+'/sample/docket?kind=wish');
      await expect(page.locator('main.panes')).toHaveClass('panes one');
      await page.locator('#list input[data-filter]').fill('navigation');
      await expect(page).toHaveURL(/filter=navigation/);
      if (viewport.width >= 1280) {
        await page.locator('#explorer a').filter({hasText:/^Board/}).click();
        await expect(page).toHaveURL(/\/sample\/board\?filter=navigation$/);
        await page.locator('#explorer details').filter({has:page.locator('summary', {hasText:'Repository and code'})}).evaluate(el => { el.open = true; });
        await page.locator('#explorer a').filter({hasText:/^Code files/}).click();
        await expect(page).toHaveURL(/\/sample\/files\?filter=navigation$/);
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
