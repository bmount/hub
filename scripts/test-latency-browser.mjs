#!/usr/bin/env node
// Entirely disposable local acceptance: real bundled Worker, D1/DOs, browser and
// synthetic sessions. No remote services, production cookies or credential files.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'pimwell-latency-browser-'));
const artifacts = path.resolve(process.env.CHAT_BROWSER_ARTIFACTS || await mkdtemp(path.join(tmpdir(), 'pimwell-latency-summary-')));
await mkdir(artifacts, { recursive: true });
const host = 'acme.pimwell.test';
const base = `https://${host}`;
let mf, browser, cacheServer;
const perfPoints = [], clientPoints = [];
const fixtureKey = randomBytes(32);
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
    import worker, { Conversation as RawConversation, Inbox as RawInbox } from './index.js';
    function measured(env, ctx) { return {...env, PERF: {writeDataPoint(p) { ctx.waitUntil(env.POINTS.fetch('https://local.invalid/', {method:'POST',body:JSON.stringify(p)})); }}}; }
    export class Conversation extends RawConversation { constructor(ctx, env) { super(ctx, measured(env, ctx)); } }
    export class Inbox extends RawInbox { constructor(ctx, env) { super(ctx, measured(env, ctx)); } }
    export default { fetch(request, env, ctx) {
      const headers = new Headers(request.headers);
      headers.set('host', headers.get('x-local-browser-host') || 'acme.pimwell.test');
      headers.delete('x-local-browser-host');
      const url = new URL(request.url); url.host = headers.get('host'); url.protocol = 'https:';
      return worker.fetch(new Request(url, new Request(request, { headers })), measured(env, ctx), ctx);
    }};
  `);
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'chat-browser-local', modulesRoot: path.join(temp, 'build'), modules: [
      { type: 'ESModule', path: path.join(temp, 'build/browser-entry.js') },
      { type: 'ESModule', path: path.join(temp, 'build/index.js') },
      ...(await readdir(path.join(temp, 'build'))).filter(f => f.endsWith('.html')).map(f => ({ type: 'Text', path: path.join(temp, 'build', f) })),
    ],
    compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { HUB_DOMAIN: 'pimwell.test', ARDI_REPO_CREATE: 'off', HUB_SECRETS_KEY: fixtureKey.toString('base64') },
    d1Databases: ['HUB_DB'], kvNamespaces: ['RATE', 'OAUTH_KV'],
    durableObjects: { CONVERSATION: { className: 'Conversation', useSQLite: true }, INBOX: { className: 'Inbox', useSQLite: true } },
    serviceBindings: { POINTS: async req => { perfPoints.push(await req.json()); return new Response(''); }, ARDI: () => new Response('Local acceptance denies external services', { status: 503 }) },
    outboundService: req => new URL(req.url).hostname === 'api.openai.com'
      ? Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Controlled fixture reply.' }] }], usage: { input_tokens: 1, output_tokens: 1 } })
      : new Response('Local acceptance denies network access', { status: 503 }),
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
  async function verb(token, name, input, hostname = host) {
    const res = await mf.dispatchFetch(`https://${hostname}/api/${name}`, { method: 'POST',
      headers: { 'x-local-browser-host': hostname, cookie: `pmw_session=${token}`, origin: `https://${hostname}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect(res.status, name).toBe(200);
    return (await res.json()).result;
  }
  await verb(member, 'channel.create', { slug: 'general', topic: 'Controlled conversation' });
  await verb(member, 'channel.create', { slug: 'support', topic: 'Controlled alternate' });
  browser = await chromium.launch({ headless: true });
  let requests = 0;
  async function context(token, viewport, live = false) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    if (token) await ctx.addCookies([{ name: 'pmw_session', value: token, domain: '.pimwell.test', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    // Deterministic HTTP fallback sends; real DO request roots are still required.
    if (!live) await ctx.routeWebSocket('**/chat/v1/ws*', ws => ws.close());
    await ctx.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      // Never allow requests to the network, even if a rendered link/script changes.
      if (!['pimwell.test', host, 'other.pimwell.test', 'browser-org.pimwell.test'].includes(url.hostname)) return route.abort('blockedbyclient');
      requests++;
      if (url.pathname === '/client/timing') clientPoints.push(...JSON.parse(req.postData() || '[]'));
      const headers = {...await req.allHeaders(), 'x-local-browser-host': url.host};
      let res = await mf.dispatchFetch(req.url(), {method:req.method(),headers,body:req.postDataBuffer() || undefined,redirect:'manual'});
      for(let i=0;res.status>=300 && res.status<400 && res.headers.has('location');i++) {
        if(i>=5) throw new Error('Too many local redirects');
        const target=new URL(res.headers.get('location'),req.url());
        if(target.hostname!==host) throw new Error('Refused external redirect');
        res=await mf.dispatchFetch(target.href,{headers:{'x-local-browser-host':host,cookie:(await ctx.cookies(target.href)).map(c=>c.name+'='+c.value).join('; ')},redirect:'manual'});
      }
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    return ctx;
  }
  const iv = randomBytes(12), key = await crypto.subtle.importKey('raw', fixtureKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, new TextEncoder().encode('sk-local-fixture-not-a-real-key'))).toString('base64');
  await db.prepare("INSERT INTO provider_credential (id,provider,label,secret_ciphertext,secret_iv,fingerprint,status,created_at) VALUES (?,'openai','fixture',?,?,'fixture','active',?)").bind(id(),ciphertext,iv.toString('base64'),now).run();
  const ctx = await context(member, {width:1440,height:1000}), page = await ctx.newPage();
  const flush = async () => { await page.evaluate(() => { Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'}); document.dispatchEvent(new Event('visibilitychange')); }); await page.waitForTimeout(100); };
  for (let i=0;i<40;i++) { await page.goto(base+'/people'); await page.waitForTimeout(60); await flush(); }
  await page.goto(base+'/c/general');
  for (let i=0;i<35;i++) {
    const link = page.locator('a[href="/c/support"]').first(); await link.evaluate(el => el.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))); await page.waitForTimeout(20); await link.evaluate(el => el.click()); await page.waitForURL(base+'/c/support'); await page.waitForTimeout(60); await flush();
    await page.locator('a[href="/c/general"]').first().evaluate(el => el.click()); await page.waitForURL(base+'/c/general'); await page.waitForTimeout(60);
  }
  for (let i=0;i<35;i++) {
    await page.locator('.channel-compose textarea').fill('Controlled '+i);
    await page.locator('.channel-compose').evaluate(el => el.requestSubmit());
    await expect(page.locator('.channel-compose textarea')).toHaveValue(''); await page.waitForTimeout(2200); await flush();
  }
  await page.goto(base+'/assistant');
  for (let i=0;i<30;i++) {
    await page.locator('#ask textarea').fill('Controlled reply');
    await page.locator('#ask').evaluate(el => el.requestSubmit());
    await expect(page.locator('#ask .send')).toBeEnabled(); await page.waitForTimeout(40); await flush();
  }
  await verb(member,'project.create',{slug:'latency',kind:'workspace',display_name:'Latency'});
  await verb(member,'work.create',{project:'latency',kind:'snag',title:'Controlled pane'});
  await page.goto(base+'/latency/docket');
  await page.locator('a[href$="/latency/w/1"]').first().evaluate(el=>el.click());
  await page.waitForURL(/\/latency\/w\/1/); await page.waitForTimeout(100); await flush();
  // Real HTTP, no Playwright routing: exercise native immutable-asset caching.
  cacheServer = createServer(async (req,res) => {
    try {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk); const body=Buffer.concat(chunks);
      if (req.url === '/client/timing') clientPoints.push(...JSON.parse(body.toString()));
      const headers={...req.headers,host,'x-local-browser-host':host,cookie:'pmw_session='+member};
      if (headers.origin) headers.origin=base;
      const result=await mf.dispatchFetch(base+req.url,{method:req.method,headers,body:body.length?body:undefined,redirect:'manual'});
      res.writeHead(result.status,Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer()));
    } catch { res.writeHead(500);res.end('Local bridge failed'); }
  });
  await new Promise(resolve=>cacheServer.listen(0,'127.0.0.1',resolve));
  const nativeStart=clientPoints.length;
  const nativeCtx=await browser.newContext(), nativePage=await nativeCtx.newPage();
  const nativeBase='http://127.0.0.1:'+cacheServer.address().port;
  for(let i=0;i<2;i++) { await nativePage.goto(nativeBase+'/people'); await nativePage.waitForTimeout(100); await nativePage.goto(nativeBase+'/skills'); }
  await nativeCtx.close();
  await flush(); await page.waitForTimeout(500);
  const persisted = perfPoints.filter(p=>p.blobs[6]==='client');
  const roots = new Set(perfPoints.filter(p => p.blobs[6] === 'request').map(p => p.blobs[5]));
  const observations = clientPoints.filter(p => p.name === 'navigation' && p.phase === 'page' || p.name === 'chat.send' && p.phase === 'ready');
  const independent = [...new Map(observations.map(p => [p.request,p])).values()];
  const joined = independent.filter(p => roots.has(p.request) && persisted.some(q=>q.blobs[5]===p.request && q.blobs[13]===p.name && q.blobs[8]===p.phase));
  const replies = clientPoints.filter(p => p.name === 'assistant.first-token');
  console.log('Validated client points:',persisted.length);
  expect(independent.length).toBeGreaterThanOrEqual(100); expect(joined.length/independent.length).toBeGreaterThanOrEqual(.95);
  expect(new Set(replies.map(p=>p.request)).size).toBe(30);
  expect(replies.every(p=>roots.has(p.request))).toBe(true);
  expect(perfPoints.filter(p=>p.doubles[9]>=0 && p.blobs[16]==='openai').length).toBeGreaterThanOrEqual(30);
  for (const name of ['pane.retained','pane.replaced','hover.eligible','hover.none','resource','resource.network','resource.cache-hit']) expect(clientPoints.some(p=>p.name===name),name).toBe(true);
  const cohort = (points,name) => { const values=points.filter(p=>p.name===name).map(p=>p.duration).sort((a,b)=>a-b);return {count:values.length,p50:values.length?values[Math.floor(values.length/2)]:null}; };
  const comparisons = {nativeResourceCache:{yes:cohort(clientPoints.slice(nativeStart),'resource.cache-hit'),no:cohort(clientPoints.slice(nativeStart),'resource.network')},paneRetention:{yes:cohort(clientPoints,'pane.retained'),no:cohort(clientPoints,'pane.replaced')},eligibleHover:{yes:cohort(clientPoints,'hover.eligible'),no:cohort(clientPoints,'hover.none')}};
  const report = {population:'local controlled Chromium + real Worker/D1/DO; scripted non-streaming provider; not production latency', comparisons, independent:independent.length, joined:joined.length, joinRate:joined.length/independent.length, replies:replies.length, counts:Object.fromEntries([...new Set(clientPoints.map(p=>p.name))].map(n=>[n,clientPoints.filter(p=>p.name===n).length])), receiverFirst:perfPoints.filter(p=>p.blobs[13]==='do.receiver.first-entry').length, receiverReused:perfPoints.filter(p=>p.blobs[13]==='do.receiver.reused').length, physicalLocation:'unknown',preHandlerStartup:'unknown'};
  console.log('Summary:',path.join(artifacts,'latency-summary.json'));
  await writeFile(path.join(artifacts,'latency-summary.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
  await ctx.close();
} catch (error) { console.error('LATENCY FAILURE', error); throw error; } finally {
  if (browser) for (const ctx of browser.contexts()) { await ctx.unrouteAll({behavior:'wait'}); await ctx.close(); }
  await browser?.close();
  if(cacheServer) await new Promise(resolve=>cacheServer.close(resolve));
  await mf?.dispose();
  await rm(temp, {recursive:true,force:true});
}
