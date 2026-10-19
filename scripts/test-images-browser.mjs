#!/usr/bin/env node
// Entirely disposable local acceptance: real bundled Worker, D1/DOs, browser and
// synthetic sessions. No remote services, production cookies or credential files.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'pimwell-images-browser-'));
const artifacts = path.resolve(process.env.IMAGE_BROWSER_ARTIFACTS || await mkdtemp(path.join(tmpdir(), 'pimwell-images-screenshots-')));
await mkdir(artifacts, { recursive: true });
const host = 'acme.pimwell.test';
const base = `https://${host}`;
let mf, browser;
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
      ...(await readdir(path.join(temp, 'build'))).filter(f => (f.endsWith('.html') || f.endsWith(".txt"))).map(f => ({ type: 'Text', path: path.join(temp, 'build', f) })),
    ],
    compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { HUB_DOMAIN: 'pimwell.test', ARDI_REPO_CREATE: 'off' },
    r2Buckets: ['GIT_PUSH_STAGING'], d1Databases: ['HUB_DB'], kvNamespaces: ['RATE', 'OAUTH_KV'],
    durableObjects: { CONVERSATION: { className: 'Conversation', useSQLite: true }, INBOX: { className: 'Inbox', useSQLite: true } },
    serviceBindings: { ARDI: () => new Response('Local acceptance denies external services', { status: 503 }) },
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

  await verb(member, 'project.create', {slug:'visuals',kind:'workspace',display_name:'Visuals'});
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  await verb(member, 'file.put', {project:'visuals',path:'plan.png',content_type:'image/png',base64:png,expected_revision:0});
  const imageUrl = '/visuals/documents/download?path=plan.png&revision=1';
  const body = '![Synthetic plan](' + imageUrl + ')';
  await verb(member, 'wiki.write', {project:'visuals',slug:'debug-visuals',title:'Debug visuals',body,expected_revision:0,note:'Synthetic image'});
  const work = await verb(member, 'work.create', {project:'visuals',kind:'snag',title:'Image evidence',body});
  await verb(member, 'work.comment', {id:work.item.id,body});
  browser = await chromium.launch({headless:true});
  async function context(token, viewport) {
    const ctx = await browser.newContext({viewport,serviceWorkers:'block'});
    if (token) await ctx.addCookies([{name:'pmw_session',value:token,domain:host,path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
    await ctx.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.hostname !== host) return route.abort('blockedbyclient');
      let res = await mf.dispatchFetch(req.url(), {method:req.method(),headers:{...await req.allHeaders(),'x-local-browser-host':host},body:req.postDataBuffer() || undefined,redirect:'manual'});
      for (let redirects = 0; res.status >= 300 && res.status < 400 && res.headers.has('location'); redirects++) {
        if (redirects >= 5) throw new Error('Too many local redirects');
        const target = new URL(res.headers.get('location'), req.url());
        if (target.hostname !== host) throw new Error('Refused external redirect');
        res = await mf.dispatchFetch(target.href, {headers:{'x-local-browser-host':host,cookie:(await ctx.cookies(target.href)).map(c => c.name + '=' + c.value).join('; ')},redirect:'manual'});
      }
      await route.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:Buffer.from(await res.arrayBuffer())});
    });
    return ctx;
  }
  for (const width of [1440,390]) {
    const ctx = await context(reader,{width,height:900});
    const page = await ctx.newPage();
    await page.goto(base + '/visuals/wiki/debug-visuals');
    const image = page.locator('.project-image img');
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute('alt','Synthetic plan');
    await expect.poll(() => image.evaluate(i => i.complete && i.naturalWidth > 0)).toBe(true);
    const bounds = await image.boundingBox();
    expect(bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.height).toBeLessThanOrEqual(480);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('link',{name:'Open original · revision 1'}).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(new URL(popup.url()).searchParams.get('revision')).toBe('1');
    await popup.close();
    await page.goto(base + '/visuals/w/' + work.item.number);
    await expect(page.locator('.project-image img')).toHaveCount(2);
    await ctx.close();
  }
  const author = await context(member,{width:1440,height:900});
  const page = await author.newPage();
  await page.goto(base + '/visuals/wiki?new=1');
  await page.getByLabel('Slug',{exact:true}).fill('browser-authored');
  await page.getByLabel('Title',{exact:true}).fill('Browser authored');
  await page.getByLabel('Markdown',{exact:true}).fill(body);
  await page.getByLabel('Revision note',{exact:true}).fill('Browser image');
  await page.getByRole('button',{name:'Create page',exact:true}).click();
  await expect(page.locator('.project-image img')).toHaveCount(1);
  const authorPopup = page.waitForEvent('popup');
  await page.getByRole('link',{name:'Open original · revision 1'}).click();
  await (await authorPopup).close();
  // Files-page submissions must preserve bytes with progressive navigation active.
  // Also remove the explicit escape hatch to exercise the script's multipart guard.
  for (const nativeMarker of [true, false]) {
    const filePath = `browser-${nativeMarker}.txt`;
    const versions = [Buffer.from('First version\r\nUTF-8: café\n'), Buffer.from('Replacement\nDifferent bytes\r\n')];
    for (const [index, bytes] of versions.entries()) {
      await page.goto(base + '/visuals/documents?upload=1');
      await expect.poll(() => page.evaluate(() => window.__pwCopy)).toBe(1);
      await page.getByLabel('File', {exact:true}).setInputFiles({name:filePath,mimeType:'text/plain',buffer:bytes});
      await page.getByLabel('Folder/name (blank uses filename)', {exact:true}).fill(filePath);
      const form = page.locator('form[enctype="multipart/form-data"]');
      await expect(form).toHaveAttribute('data-reload', '');
      if (!nativeMarker) await form.evaluate(f => f.removeAttribute('data-reload'));
      const submitted = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/documents/upload'));
      await form.getByRole('button', {name:'Upload',exact:true}).click();
      const request = await submitted;
      expect(request.headers()['content-type']).toContain('multipart/form-data; boundary=');
      expect(request.headers()['x-workbench']).toBeUndefined();
      await expect(page.getByRole('heading', {name:'Upload a file or version'})).toHaveCount(0);
      const stored = await verb(member,'file.get',{project:'visuals',path:filePath,revision:index+1,include_base64:true});
      expect(Buffer.from(stored.base64,'base64')).toEqual(bytes);
    }
    const original = await verb(member,'file.get',{project:'visuals',path:filePath,revision:1,include_base64:true});
    expect(Buffer.from(original.base64,'base64')).toEqual(versions[0]);
  }
  await author.close();
  for (const token of [null,outsider]) {
    const ctx = await context(token,{width:390,height:900});
    const page = await ctx.newPage();
    const response = await page.goto(base + imageUrl);
    expect(response.status()).not.toBe(200);
    await page.goto(base + '/visuals/wiki/debug-visuals');
    await expect(page.locator('.project-image img')).toHaveCount(0);
    await ctx.close();
  }
  console.log('PASS image browser acceptance: reader desktop/mobile, original, work evidence, browser authoring, Files upload/version byte preservation with native marker and multipart guard, outsider/anonymous denial');
} finally {
  await browser?.close();
  await mf?.dispose();
  await rm(temp,{recursive:true,force:true});
}
