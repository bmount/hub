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
const temp = await mkdtemp(path.join(tmpdir(), 'pimwell-chat-browser-'));
const artifacts = path.resolve(process.env.CHAT_BROWSER_ARTIFACTS || await mkdtemp(path.join(tmpdir(), 'pimwell-chat-screenshots-')));
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
      headers.set('host', headers.get('x-local-browser-host'));
      headers.delete('x-local-browser-host');
      return worker.fetch(new Request(request, { headers }), env, ctx);
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
    d1Databases: ['HUB_DB'], kvNamespaces: ['RATE', 'OAUTH_KV'],
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
  await verb(member, 'channel.create', { slug: 'general', topic: 'Team conversation' });
  const longSlug = 'a'.repeat(63);
  await verb(member, 'channel.create', { slug: longSlug, display_name: 'Long channel', topic: 'T'.repeat(240) });
  await verb(member, 'channel.create', { slug: 'support', topic: 'Customer questions <img src=x onerror=alert(1)>' });
  await verb(outsider, 'channel.create', { slug: 'other-secret', topic: 'other-tenant-secret' }, 'other.pimwell.test');
  const rootMsg = await verb(member, 'chat.post', { c: 'general', body: 'Original message <script>alert(1)</script> ' + 'X'.repeat(600) });
  await verb(member, 'chat.post', { c: 'general', reply_to: rootMsg.seq, body: 'Thread reply' });
  await verb(member, 'chat.post', { c: 'general', body: 'New top-level activity' });
  browser = await chromium.launch({ headless: true });
  let requests = 0;
  async function context(token, viewport) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    if (token) await ctx.addCookies([{ name: 'pmw_session', value: token, domain: '.pimwell.test', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await ctx.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      // Never allow requests to the network, even if a rendered link/script changes.
      if (!['pimwell.test', host, 'other.pimwell.test'].includes(url.hostname)) return route.abort('blockedbyclient');
      requests++;
      const res = await mf.dispatchFetch(req.url(), { method: req.method(), headers: { ...await req.allHeaders(), 'x-local-browser-host': url.host }, body: req.postDataBuffer() || undefined });
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    return ctx;
  }
  async function noOverflow(page) {
    const widths = await page.evaluate(() => [...document.querySelectorAll('html, #list, .chat-workspace, .channel-content, .channel-rail')]
      .map(el => ({ name: el.className || el.tagName, scroll: el.scrollWidth, client: el.clientWidth })));
    for (const w of widths) expect(w.scroll, `${w.name} has horizontal overflow`).toBeLessThanOrEqual(w.client + 1);
  }
  async function tabTo(page, selector) {
    // Exercise the actual sequential keyboard path (not locator.focus()).
    for (let i = 0; i < 100; i++) {
      await page.keyboard.press('Tab');
      if (await page.locator(selector).evaluate(el => el === document.activeElement)) {
        const outline = await page.locator(selector).evaluate(el => getComputedStyle(el).outlineStyle);
        expect(outline).not.toBe('none');
        return;
      }
    }
    throw new Error(`Keyboard could not reach ${selector}`);
  }
  let lastRead = 0;
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]) {
    const ctx = await context(member, viewport);
    const page = await ctx.newPage();
    await page.goto(`${base}/c`);
    await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
    await noOverflow(page);
    await expect(page.locator('.chat-workspace')).not.toContainText('other-tenant-secret');
    await tabTo(page, '#channel-query');
    await page.keyboard.type('questions');
    await page.keyboard.press('Enter');
    await expect(page.locator('.channel-directory')).toContainText('#support');
    await expect(page.locator('.channel-directory')).not.toContainText('#general');
    await expect(page.locator('.channel-directory img')).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, `${label}-discovery.png`) });
    await page.goto(`${base}/c/general`);
    await expect(page.locator('#unread')).toBeVisible();
    await expect(page.locator('.channel-message script')).toHaveCount(0);
    await noOverflow(page);
    const rail = await page.locator('.channel-rail').boundingBox();
    const content = await page.locator('.channel-content').boundingBox();
    expect(rail && content).toBeTruthy();
    if (viewport.width > 760) expect(rail.x + rail.width).toBeLessThan(content.x);
    else expect(rail.y + rail.height).toBeLessThanOrEqual(content.y);
    await page.screenshot({ path: path.join(artifacts, `${label}-channel.png`) });
    // Discovery, channel and thread GETs must not acknowledge activity.
    expect((await verb(member, 'chat.conversations', {})).conversations.find(c => c.channel === 'general').read_seq).toBe(lastRead);
    await tabTo(page, `.channel-message a[href="/c/general/t/${rootMsg.seq}"]`);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Original message', exact: true })).toBeVisible();
    await expect(page.locator('.channel-messages')).toContainText('Thread reply');
    await noOverflow(page);
    await tabTo(page, '#chat-body');
    await page.keyboard.type(`Keyboard reply ${label}`);
    // Voice enhancement can add a microphone between the textarea and submit.
    await tabTo(page, '.channel-compose button[type="submit"]');
    await page.keyboard.press('Enter');
    await expect(page.locator('.channel-messages')).toContainText(`Keyboard reply ${label}`);
    await page.locator('.channel-compose').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, `${label}-thread-composer.png`) });
    await page.locator('.thread-root').screenshot({ path: path.join(artifacts, `${label}-thread-original.png`) });
    await page.goto(`${base}/c/${longSlug}`);
    await noOverflow(page);
    await page.goto(`${base}/c/general`);
    if (label === 'desktop') {
      // Same-title refresh must show inbound activity without acknowledging it.
      await verb(peer, 'chat.post', { c: 'general', body: 'Arrived before refresh' });
      await page.getByRole('link', { name: 'Refresh', exact: true }).click();
      await expect(page.locator('.channel-messages')).toContainText('Arrived before refresh');
      expect((await verb(member, 'chat.conversations', {})).conversations.find(c => c.channel === 'general').read_seq).toBe(lastRead);
      // A stale compose response has the SAME title/key. Show new activity and
      // keep the draft, without automatically retrying the intended write.
      await page.getByLabel('Message channel').fill('Careful stale draft <b>inert</b>');
      await verb(peer, 'chat.post', { c: 'general', body: 'Arrived during draft' });
      await page.locator('.channel-compose button[type="submit"]').click();
      await expect(page.getByRole('status').filter({ hasText: 'New activity arrived' })).toBeVisible();
      await expect(page.getByLabel('Message channel')).toHaveValue('Careful stale draft <b>inert</b>');
      await expect(page.locator('.channel-messages')).toContainText('Arrived during draft');
      await expect(page.locator('.channel-messages')).not.toContainText('Careful stale draft');
      await page.locator('.channel-compose button[type="submit"]').click();
      await expect(page.locator('.channel-messages')).toContainText('Careful stale draft <b>inert</b>');
      await expect(page.locator('.channel-message b')).toHaveCount(0);
      // Explicit same-origin form submit only; unread clears for this viewer.
      lastRead = (await verb(member, 'chat.conversations', {})).conversations.find(c => c.channel === 'general').head;
      await page.getByRole('button', { name: /Mark channel read/ }).click();
      await expect(page.locator('#unread')).toHaveCount(0);
      expect((await verb(member, 'chat.conversations', {})).conversations.find(c => c.channel === 'general').read_seq).toBe(lastRead);
      // Add another root so following viewport passes have an unread target.
      await verb(member, 'chat.post', { c: 'general', body: 'New unread root' });
    }
    await ctx.close();
    console.log(`PASS ${label}: responsive layout, safe discovery/rendering, keyboard search/reply, thread context, unread controls`);
  }
  // Explicitly keyed Docket lists still retain their DOM when the inspector
  // opens; the generic-page refresh fix must not break two-pane navigation.
  await db.prepare('INSERT INTO project (id,tenant_id,slug,kind,display_name,created_at) VALUES (?,?,?,\'repo\',?,?)')
    .bind(id(), tenant, 'site', 'Site', now).run();
  await verb(member, 'work.create', { project: 'site', kind: 'snag', title: 'Browser list retention' });
  const workCtx = await context(member, { width: 1440, height: 1000 });
  const workPage = await workCtx.newPage();
  await workPage.goto(`${base}/site/docket?kind=snag`);
  await workPage.evaluate(() => { window.__originalList = document.getElementById('list'); });
  await workPage.locator('tr[data-href]').first().click();
  await expect(workPage.locator('#inspector h1')).toHaveText('Browser list retention');
  expect(await workPage.evaluate(() => window.__originalList === document.getElementById('list'))).toBe(true);
  await workCtx.close();
  console.log('PASS same-title refresh/stale draft and explicit two-pane list retention');

  const ctx = await context(reader, { width: 390, height: 844 });
  const page = await ctx.newPage();
  await page.goto(`${base}/c/general`);
  await expect(page.getByText('You have read-only access.')).toBeVisible();
  await expect(page.locator('.channel-compose')).toHaveCount(0);
  expect((await verb(reader, 'chat.conversations', {})).conversations.find(c => c.channel === 'general').read_seq).toBe(0);
  await page.goto(`${base}/c`);
  await expect(page.locator('details.edit')).toHaveCount(0);
  await ctx.close();
  for (const [token, status] of [[outsider, 404], [null, 303]]) {
    const res = await mf.dispatchFetch(`${base}/c/general`, { headers: { 'x-local-browser-host': host, ...(token ? { cookie: `pmw_session=${token}` } : {}) }, redirect: 'manual' });
    expect(res.status).toBe(status);
  }
  console.log(`PASS reader/viewer isolation and outside-tenant/unauthenticated denials; ${requests} local browser requests. Screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
}
