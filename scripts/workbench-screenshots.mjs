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
    bindings: { HUB_DOMAIN: 'pimwell.test', ARDI_REPO_CREATE: 'off' },
    d1Databases: ['HUB_DB'], r2Buckets: ['GIT_PUSH_STAGING'], kvNamespaces: ['RATE', 'OAUTH_KV'],
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
  await verb(member, 'project.create', { slug: 'sample', kind: 'repo', display_name: 'Sample project' });
  await verb(member, 'project.create', { slug: 'knowledge', kind: 'workspace', display_name: 'Team knowledge' });
  for (const [kind, title] of [['quest', 'Launch the workbench'], ['wish', 'Keep project navigation visible'], ['snag', 'Fix the empty list'], ['errand', 'Review the release']]) {
    await verb(member, 'work.create', { project: 'sample', kind, title, body: 'Synthetic design fixture. Done when: reviewed and shipped.' });
  }
  await verb(member, 'wiki.write', {project: 'knowledge', slug: 'welcome', title: 'Team handbook', body: 'Synthetic team handbook for design evidence.', expected_revision: 0, note: 'Fixture'});
  const contact = await verb(member, 'person.upsert', {project: 'knowledge', name: 'Alex Example', title: 'Designer', emails: ['alex@example.test']});
  await verb(member, 'channel.create', {slug: 'general', topic: 'Team conversation'});
  await verb(member, 'chat.post', {c: 'general', body: 'Please review the compact workbench.'});
  browser = await chromium.launch({headless: true});
  const pages = {home:'/', docket:'/sample/docket', item:'/sample/w/2', board:'/sample/board', status:'/sample/status', code:'/sample/code', reviews:'/reviews', wiki:'/knowledge/wiki', files:'/knowledge/documents', contacts:'/knowledge/contacts', graph:`/knowledge/contacts/${contact.entity.id}`, mail:'/mail', chat:'/c/general', assistant:'/assistant', people:'/people', apps:'/apps', usage:'/usage', admin:'/admin/agents', search:'/search?q=workbench'};
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
    for (const [name, route] of Object.entries(pages)) {
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
    if (phase === 'after') {
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
} finally {
  await browser?.close();
  await mf?.dispose();
  await rm(temp,{recursive:true,force:true});
}
