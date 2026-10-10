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
const temp = await mkdtemp(path.join(tmpdir(), 'pimwell-chat-browser-'));
const artifacts = path.resolve(process.env.CHAT_BROWSER_ARTIFACTS || await mkdtemp(path.join(tmpdir(), 'pimwell-chat-screenshots-')));
await mkdir(artifacts, { recursive: true });
const host = 'acme.pimwell.test';
const base = `https://${host}`;
let mf, browser, cacheBrowser, cacheServer;
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
  const presenceCalls = [];
  const disconnected = new WeakSet();
  const dropHeartbeatResponse = new WeakSet();
  const overdueHeartbeatResponse = new WeakSet();
  const overdueDeniedHeartbeatResponse = new WeakSet();
  const wrongChannelSnapshot = new WeakSet();
  const oversizedPresenceResponse = new WeakMap();
  const repeatedSnapshot = new WeakMap();
  async function context(token, viewport) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    if (token) await ctx.addCookies([{ name: 'pmw_session', value: token, domain: '.pimwell.test', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await ctx.route('**/*', async route => {
      if (disconnected.has(ctx)) return route.abort('internetdisconnected');
      const req = route.request();
      const url = new URL(req.url());
      // Never allow requests to the network, even if a rendered link/script changes.
      if (!['pimwell.test', host, 'other.pimwell.test'].includes(url.hostname)) return route.abort('blockedbyclient');
      requests++;
      if (/\/api\/chat\.(heartbeat|presence)$/.test(url.pathname)) {
        presenceCalls.push({ name: url.pathname, ...JSON.parse(req.postData() || '{}') });
      }
      const lateDenied = url.pathname === '/api/chat.heartbeat' && overdueDeniedHeartbeatResponse.has(ctx);
      const headers = { ...await req.allHeaders(), 'x-local-browser-host': url.host };
      if (lateDenied) delete headers.cookie; // Real local Worker denial; no session/grant mutations.
      const res = await mf.dispatchFetch(req.url(), { method: req.method(), headers, body: req.postDataBuffer() || undefined });
      if (lateDenied) {
        overdueDeniedHeartbeatResponse.delete(ctx);
        expect(res.status).toBe(404);
        const page = ctx.pages()[0];
        await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 8000);
      }
      if (url.pathname === '/api/chat.heartbeat' && dropHeartbeatResponse.has(ctx)) {
        dropHeartbeatResponse.delete(ctx);
        expect(res.status).toBe(200); // Write accepted, but the browser cannot know its outcome.
        await res.arrayBuffer();
        return route.abort('failed');
      }
      if (url.pathname === '/api/chat.heartbeat' && overdueHeartbeatResponse.has(ctx)) {
        overdueHeartbeatResponse.delete(ctx);
        expect(res.status).toBe(200); // Accepted write; client budget expires before success is delivered.
        const page = ctx.pages()[0];
        // Advance wall time without running timeout callbacks. This tests the absolute
        // response guard in a real browser, not native sleep or a real network delay.
        await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 8000);
      }
      if (url.pathname === oversizedPresenceResponse.get(ctx)) {
        oversizedPresenceResponse.delete(ctx);
        expect(res.status).toBe(200);
        const body = await res.json();
        body.fixturePadding = 'x'.repeat(262144); // Local-only oversized successful body.
        const responseHeaders = Object.fromEntries(res.headers);
        delete responseHeaders['content-length']; // Enforce actual bytes, not an advertised bound.
        return route.fulfill({ status: res.status, headers: responseHeaders, body: JSON.stringify(body) });
      }
      if (url.pathname === '/api/chat.presence' && repeatedSnapshot.has(ctx)) {
        expect(res.status).toBe(200);
        const actual = await res.json();
        const saved = repeatedSnapshot.get(ctx) || actual;
        repeatedSnapshot.set(ctx, saved);
        // Replay one actual successful Worker response without changing permissions.
        return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: JSON.stringify(saved) });
      }
      if (url.pathname === '/api/chat.presence' && wrongChannelSnapshot.has(ctx)) {
        wrongChannelSnapshot.delete(ctx);
        expect(res.status).toBe(200);
        const body = await res.json();
        body.result.channel = 'support'; // Fixture-only stale/wrong-channel response, no grants widened.
        return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: JSON.stringify(body) });
      }
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
  // Real Chromium + shipped assets + authentic synthetic browser sessions; no
  // production credentials. Network-disconnect tests use Chromium's offline mode.
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]) {
    const ctx = await context(member, viewport);
    const page = await ctx.newPage();
    await page.clock.install();
    const start = presenceCalls.length;
    await page.goto(`${base}/c/general`);
    const box = page.getByRole('region', { name: 'Channel presence' });
    const toggle = box.getByRole('button', { name: 'Share presence in this channel', exact: true });
    await expect(box.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(start).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(0);
    const beforeCursor = (await verb(member, 'chat.conversations', {})).conversations.find(c => c.channel === 'general').read_seq;
    await tabTo(page, '[data-presence-toggle]');
    await page.keyboard.press('Enter');
    await expect(box.locator('[data-presence-list]')).toContainText('online');
    await expect(toggle).toHaveCount(0);
    expect((await verb(member, 'chat.presence', { c: 'general' })).entries.find(e => e.handle === 'dev')).toMatchObject({ state: 'online', via_assistant: false });
    await noOverflow(page);
    await box.screenshot({ path: path.join(artifacts, `${label}-presence-online.png`) });
    // Pane replacement (not a document load/pagehide) must retire old publishers.
    const navStart = presenceCalls.length;
    await page.locator('.channel-rail a[href="/c/support"]').click();
    await expect(page.locator('[data-chat-presence]')).toHaveAttribute('data-chat-presence', 'support');
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    await page.clock.fastForward(30001);
    await expect.poll(() => presenceCalls.slice(navStart).filter(c => c.name.endsWith('presence') && c.c === 'support').length).toBeGreaterThan(1);
    expect(presenceCalls.slice(navStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(0);
    await page.goBack();
    await expect(page.locator('[data-chat-presence]')).toHaveAttribute('data-chat-presence', 'general');
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    // Back in the channel, sharing requires another explicit action.
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-list]')).toContainText('online');
    disconnected.add(ctx); await ctx.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(page.locator('[data-presence-connection]')).toContainText('Current status is unknown');
    await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-sharing]')).toContainText('any accepted heartbeat expires within 90 seconds');
    await page.locator('[data-chat-presence]').screenshot({ path: path.join(artifacts, `${label}-presence-disconnected.png`) });
    const reconnectStart = presenceCalls.length;
    disconnected.delete(ctx); await ctx.setOffline(false);
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    await page.clock.fastForward(30001);
    await expect.poll(() => presenceCalls.slice(reconnectStart).filter(c => c.name.endsWith('presence')).length).toBeGreaterThan(1);
    expect(presenceCalls.slice(reconnectStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(0);
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-list]')).toContainText('offline');
    await expect.poll(async () => (await verb(member, 'chat.presence', { c: 'general' })).entries.find(e => e.handle === 'dev').state).toBe('offline');
    // Prove true ambiguity: the local Worker accepts the write, its response is lost,
    // and polling must reconcile without renewing that report or claiming offline.
    dropHeartbeatResponse.add(ctx);
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-sharing]')).toContainText('Delivery is uncertain');
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
    expect((await verb(member, 'chat.presence', { c: 'general' })).entries.find(e => e.handle === 'dev').state).toBe('online');
    const reconcileStart = presenceCalls.length;
    await page.clock.fastForward(30001);
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(reconcileStart).map(c => c.name)).toEqual(['/api/chat.presence']);
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(reconcileStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(1);
    // An accepted heartbeat's otherwise successful response must be rejected after
    // its absolute 8s budget, even without an abort timer callback. Never auto-replay it.
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-list]')).toContainText('offline');
    overdueHeartbeatResponse.add(ctx);
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-sharing]')).toContainText('Delivery is uncertain');
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
    expect((await verb(member, 'chat.presence', { c: 'general' })).entries.find(e => e.handle === 'dev').state).toBe('online');
    const deadlineStart = presenceCalls.length;
    await page.clock.fastForward(30001);
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(deadlineStart).map(c => c.name)).toEqual(['/api/chat.presence']);
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(deadlineStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(1);
    // A real Worker-denied heartbeat delivered outside the response budget cannot
    // permanently disable current controls. Recovery queries only; new consent
    // alone sends a fresh, normally authenticated/server-authorized report.
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-list]')).toContainText('offline');
    const beforeDenied = (await verb(member, 'chat.presence', { c: 'general' })).entries.find(e => e.handle === 'dev');
    overdueDeniedHeartbeatResponse.add(ctx);
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-connection]')).toContainText('Current status is unknown');
    await expect(page.locator('[data-presence-toggle]')).toBeEnabled();
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
    expect((await verb(member, 'chat.presence', { c: 'general' })).entries.find(e => e.handle === 'dev')).toEqual(beforeDenied);
    const deniedStart = presenceCalls.length;
    await page.clock.fastForward(30001);
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(deniedStart).map(c => c.name)).toEqual(['/api/chat.presence']);
    const deniedRecovery = page.waitForResponse(res => new URL(res.url()).pathname === '/api/chat.presence');
    await page.locator('[data-presence-toggle]').click();
    await (await deniedRecovery).finished();
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    expect(presenceCalls.slice(deniedStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(1);
    // Model an abort-ignoring transport after a real Worker-accepted write. Keep
    // the response unsettled through deadline/recovery, then deliver it late.
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-list]')).toContainText('offline');
    await page.evaluate(() => {
      const original = window.fetch;
      window.__heldPresence = { accepted: false, release: null };
      window.fetch = async (url, init) => {
        if (url !== '/api/chat.heartbeat') return original(url, init);
        window.fetch = original;
        const response = await original(url, init);
        const text = await response.text();
        const saved = new Response(text, { status: response.status, headers: response.headers });
        return new Promise(resolve => {
          window.__heldPresence.release = () => resolve(saved);
          window.__heldPresence.accepted = true;
        });
      };
    });
    await page.locator('[data-presence-toggle]').click();
    await expect.poll(() => page.evaluate(() => window.__heldPresence.accepted)).toBe(true);
    expect((await verb(member, 'chat.presence', { c: 'general' })).entries.find(e => e.handle === 'dev').state).toBe('online');
    await page.clock.fastForward(8000);
    await expect(page.locator('[data-presence-sharing]')).toContainText('Delivery is uncertain');
    await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
    const abortStart = presenceCalls.length;
    await page.clock.fastForward(30001);
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(abortStart).map(c => c.name)).toEqual(['/api/chat.presence']);
    await page.locator('[data-presence-toggle]').click();
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(abortStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(1);
    const lateStart = presenceCalls.length;
    await page.evaluate(() => window.__heldPresence.release());
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    await expect(page.locator('[data-presence-list]')).toContainText('online');
    expect(presenceCalls).toHaveLength(lateStart);
    // Advance over a stalled interval, firing each due timer at most once. This is
    // a controlled browser-clock regression, not native OS sleep/freeze acceptance.
    const gapStart = presenceCalls.length;
    await page.clock.fastForward(90001);
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    await expect(page.locator('[data-presence-sharing]')).toContainText('Share explicitly again');
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(gapStart).map(c => c.name)).toEqual(['/api/chat.presence']);
    const renewedSnapshot = page.waitForResponse(res => new URL(res.url()).pathname === '/api/chat.presence');
    await page.locator('[data-presence-toggle]').click();
    await (await renewedSnapshot).finished();
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(gapStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(1);
    wrongChannelSnapshot.add(ctx);
    await page.clock.fastForward(30000);
    await expect(page.locator('[data-presence-connection]')).toContainText('Current status is unknown');
    await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    const invalidStart = presenceCalls.length;
    await page.clock.fastForward(30000);
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(invalidStart).map(c => c.name)).toEqual(['/api/chat.presence']);
    const invalidRecovery = page.waitForResponse(res => new URL(res.url()).pathname === '/api/chat.presence');
    await page.locator('[data-presence-toggle]').click();
    await (await invalidRecovery).finished();
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    expect(presenceCalls.slice(invalidStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(1);
    for (const endpoint of ['/api/chat.heartbeat', '/api/chat.presence']) {
      oversizedPresenceResponse.set(ctx, endpoint);
      await page.clock.fastForward(30000);
      await expect(page.locator('[data-presence-connection]')).toContainText('Current status is unknown');
      await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
      await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
      await expect(page.locator('[data-presence-sharing]')).toContainText('Delivery is uncertain');
      // Heartbeat was genuinely accepted; response rejection is not write rejection.
      expect((await verb(member, 'chat.presence', { c: 'general' })).entries.find(e => e.handle === 'dev').state).toBe('online');
      const boundedStart = presenceCalls.length;
      await page.clock.fastForward(30000);
      await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
      expect(presenceCalls.slice(boundedStart).map(c => c.name)).toEqual(['/api/chat.presence']);
      const boundedRecovery = page.waitForResponse(res => new URL(res.url()).pathname === '/api/chat.presence');
      await page.locator('[data-presence-toggle]').click();
      await (await boundedRecovery).finished();
      await expect(page.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
      await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
      expect(presenceCalls.slice(boundedStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(1);
    }
    // Repeated successful snapshots must not restart their age, even as actual
    // heartbeat writes succeed. This is fixture replay, not a production proxy claim.
    repeatedSnapshot.set(ctx, null);
    const captured = page.waitForResponse(res => new URL(res.url()).pathname === '/api/chat.presence');
    await page.clock.fastForward(30000);
    await (await captured).finished();
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    for (const seconds of [30, 60]) {
      const repeat = page.waitForResponse(res => new URL(res.url()).pathname === '/api/chat.presence');
      await page.clock.fastForward(30000);
      await (await repeat).finished();
      await expect(page.locator('[data-presence-freshness]')).toContainText(`at least ${seconds} seconds old`);
    }
    const expiryStart = presenceCalls.length;
    const expiryQuery = page.waitForResponse(res => new URL(res.url()).pathname === '/api/chat.presence');
    await page.clock.fastForward(30000);
    await (await expiryQuery).finished();
    await expect(page.locator('[data-presence-connection]')).toContainText('Current status is unknown');
    await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    // At the exact snapshot boundary, cancel consent BEFORE renewal: recent
    // accepted heartbeats at 30s/60s do not rejuvenate the replayed directory.
    expect(presenceCalls.slice(expiryStart).map(c => c.name)).toEqual(['/api/chat.presence']);
    const replayStart = presenceCalls.length;
    await page.clock.fastForward(30000);
    await expect(page.locator('[data-presence-list] li')).toHaveCount(0);
    expect(presenceCalls.slice(replayStart).map(c => c.name)).toEqual(['/api/chat.presence']);
    repeatedSnapshot.delete(ctx);
    await page.clock.fastForward(30000);
    await expect(page.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    expect(presenceCalls.slice(replayStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(0);
    const replayRecovery = page.waitForResponse(res => new URL(res.url()).pathname === '/api/chat.presence');
    await page.locator('[data-presence-toggle]').click();
    await (await replayRecovery).finished();
    await expect(page.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    expect(presenceCalls.slice(replayStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(1);
    expect((await verb(member, 'chat.conversations', {})).conversations.find(c => c.channel === 'general').read_seq).toBe(beforeCursor);
    await noOverflow(page);
    await ctx.close();
    console.log(`PASS ${label}: explicit presence opt-in/stop, keyboard/focus, pane disposal/back navigation, genuine Chromium offline clearing, query-only reconnect/ambiguous-delivery/absolute-deadline/overdue-denial/abort-ignoring-transport/timer-gap/wrong-channel/oversized-body/replayed-snapshot recovery, cursor unchanged`);
  }
  // Playwright routing and its default Chromium flag disable native BFCache.
  // Use an actual loopback HTTP bridge and omit ONLY that flag for this pass.
  // Host/origin translation lives entirely in the disposable test adapter.
  const cacheCalls = [];
  cacheServer = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/cache-away') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Away from channel</title><p>Local BFCache destination</p>');
        return;
      }
      if (!(pathname.startsWith('/assets/') || pathname === '/c/general' || /^\/api\/chat\.(presence|heartbeat)$/.test(pathname))) {
        res.writeHead(404); res.end(); return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (pathname.startsWith('/api/')) cacheCalls.push({ name: pathname, ...JSON.parse(body.toString()) });
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      headers.set('x-local-browser-host', host);
      if (headers.has('origin')) headers.set('origin', base);
      const result = await mf.dispatchFetch(base + req.url, {
        method: req.method, headers, body: body.length ? body : undefined,
      });
      // Preserve the real Worker's cache-control and content; never force cache eligibility.
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch { res.writeHead(500); res.end('Local bridge failed'); }
  });
  await new Promise(resolve => cacheServer.listen(0, '127.0.0.1', resolve));
  const cacheBase = `http://127.0.0.1:${cacheServer.address().port}`;
  // A headed desktop session is required for native background-tab freezing.
  // Headless Chromium keeps pages visible and silently ignores the freeze command.
  const nativeFreeze = process.env.CHAT_BROWSER_NATIVE_FREEZE === '1';
  cacheBrowser = await chromium.launch({ channel: 'chromium', headless: !nativeFreeze,
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const cacheCtx = await cacheBrowser.newContext({ viewport, serviceWorkers: 'block' });
    await cacheCtx.addCookies([{ name: 'pmw_session', value: member, url: cacheBase, httpOnly: true, sameSite: 'Lax' }]);
    const cachePage = await cacheCtx.newPage();
    const cacheDiagnostics = await cacheCtx.newCDPSession(cachePage);
    await cacheDiagnostics.send('Page.enable');
    const cacheMisses = [];
    cacheDiagnostics.on('Page.backForwardCacheNotUsed', event => cacheMisses.push(...event.notRestoredExplanations));
    await cachePage.addInitScript(() => {
      window.__cacheLifecycle = [];
      window.__cacheDocument = Math.random();
      for (const name of ['pageshow', 'pagehide']) window.addEventListener(name, event => {
        window.__cacheLifecycle.push({ name, persisted: event.persisted });
      });
    });
    await cachePage.goto(`${cacheBase}/c/general`);
    await expect(cachePage.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    await cachePage.locator('[data-presence-toggle]').click();
    await expect(cachePage.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    await expect(cachePage.locator('[data-presence-list]')).toContainText('online');
    const documentId = await cachePage.evaluate(() => window.__cacheDocument);
    // A top-level navigation, not workbench pushState or synthetic lifecycle events.
    await cachePage.goto(`${cacheBase}/cache-away`);
    const restoreStart = cacheCalls.length;
    await cachePage.goBack();
    const restored = (await cachePage.evaluate(() => window.__cacheDocument)) === documentId;
    if (restored) {
      expect(await cachePage.evaluate(() => window.__cacheLifecycle)).toEqual([
        { name: 'pageshow', persisted: false }, { name: 'pagehide', persisted: true }, { name: 'pageshow', persisted: true },
      ]);
      await expect(cachePage.locator('[data-presence-sharing]')).toContainText('Share explicitly again');
    } else {
      // Current Chromium refuses no-store pages/API results. That is not a
      // persisted-page pass: assert the authoritative reason and fresh document.
      // Do not strip private cache headers or force feature flags to obtain a pass.
      expect(cacheMisses.some(e => e.reason === 'MainResourceHasCacheControlNoStore')).toBe(true);
      expect(await cachePage.evaluate(() => window.__cacheLifecycle)).toEqual([{ name: 'pageshow', persisted: false }]);
    }
    await expect(cachePage.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    await expect(cachePage.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    // Exercise a real post-restoration 30s timer, without injecting page events/clocks.
    await expect.poll(() => cacheCalls.slice(restoreStart).filter(c => c.name.endsWith('presence')).length, { timeout: 40000 }).toBeGreaterThan(1);
    expect(cacheCalls.slice(restoreStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(0);
    await cachePage.locator('[data-chat-presence]').screenshot({ path: path.join(artifacts, `${label}-presence-native-bfcache.png`) });
    await cachePage.locator('[data-presence-toggle]').click();
    await expect.poll(() => cacheCalls.slice(restoreStart).filter(c => c.name.endsWith('heartbeat') && c.status === 'online').length).toBe(1);
    await expect(cachePage.locator('[data-presence-toggle]')).toHaveText('Stop sharing presence');
    await expect(cachePage.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    if (nativeFreeze) {
    // A real Chromium lifecycle transition without navigation/pagehide. Record
    // trusted document events after the product listeners, never dispatch fakes.
    const freezeDocument = await cachePage.evaluate(() => {
      window.__freezeLifecycle = [];
      for (const name of ['freeze', 'resume']) document.addEventListener(name, event => {
        window.__freezeLifecycle.push({ name, trusted: event.isTrusted,
          entries: document.querySelector('[data-presence-list]').children.length,
          connection: document.querySelector('[data-presence-connection]').textContent });
      });
      return window.__cacheDocument;
    });
    // Chromium only freezes background pages. A real foreground sibling tab
    // makes this document hidden; forcing the state on a visible page is a no-op.
    const hideStart = cacheCalls.length;
    const foreground = await cacheCtx.newPage();
    await foreground.goto(`${cacheBase}/cache-away`);
    await foreground.bringToFront();
    await expect.poll(() => cachePage.evaluate(() => document.visibilityState)).toBe('hidden');
    await expect.poll(() => cacheCalls.slice(hideStart).some(c => c.status === 'away')).toBe(true);
    await expect.poll(() => cacheCalls.slice(hideStart).at(-1)?.name).toBe('/api/chat.presence');
    await expect(cachePage.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    const freezeStart = cacheCalls.length;
    await cacheDiagnostics.send('Page.setWebLifecycleState', { state: 'frozen' });
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(cacheCalls.slice(freezeStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(0);
    await cacheDiagnostics.send('Page.setWebLifecycleState', { state: 'active' });
    await expect.poll(() => cachePage.evaluate(() => window.__freezeLifecycle.length)).toBe(2);
    await cachePage.bringToFront();
    await foreground.close();
    const lifecycle = await cachePage.evaluate(() => window.__freezeLifecycle);
    expect(lifecycle.map(e => ({ name: e.name, trusted: e.trusted }))).toEqual([
      { name: 'freeze', trusted: true }, { name: 'resume', trusted: true },
    ]);
    expect(lifecycle[0].entries).toBe(0);
    expect(lifecycle[0].connection).toContain('Page suspended');
    expect(await cachePage.evaluate(() => window.__cacheDocument)).toBe(freezeDocument);
    await expect(cachePage.locator('[data-presence-sharing]')).toContainText('Share explicitly again');
    await expect(cachePage.locator('[data-presence-toggle]')).toHaveText('Share presence in this channel');
    await expect(cachePage.locator('[data-presence-connection]')).toContainText('snapshot refreshed');
    await expect.poll(() => cacheCalls.slice(freezeStart).filter(c => c.name.endsWith('presence')).length, { timeout: 40000 }).toBeGreaterThan(1);
    expect(cacheCalls.slice(freezeStart).filter(c => c.name.endsWith('heartbeat'))).toHaveLength(0);
    await cachePage.locator('[data-presence-toggle]').click();
    await expect.poll(() => cacheCalls.slice(freezeStart).filter(c => c.name.endsWith('heartbeat') && c.status === 'online').length).toBe(1);
    console.log(`PASS ${label}: trusted native freeze/resume, same document, immediate unknown, real 30s query-only renewal until new consent`);
    }
    await cacheCtx.close();
    console.log(`PASS ${label}: native history ${restored ? 'persisted BFCache restore' : 'no-store cache refusal and fresh-document return'}; renewed explicit opt-in, real 30s query-only timer`);
  }
  await cacheBrowser.close(); cacheBrowser = null;
  await new Promise(resolve => cacheServer.close(resolve)); cacheServer = null;
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

  // Human connector guide is read-only product UI. This proves discoverability,
  // keyboard/mobile rendering and endpoint binding, NOT hosted-client OAuth.
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]) {
    const guideCtx = await context(reader, viewport), guidePage = await guideCtx.newPage();
    await guidePage.goto(`${base}/assistant`);
    await guidePage.locator('#list a[href="/assistant/connect"]').click();
    await expect(guidePage.locator('#list h1')).toHaveText('Use Pimwell from your own assistant');
    const endpoint = guidePage.locator('#mcp-endpoint');
    await expect(endpoint).toHaveValue(`${base}/mcp`);
    await expect(endpoint).toHaveAttribute('readonly', '');
    await expect(guidePage.locator('#list')).toContainText('reader@example.test');
    await expect(guidePage.locator('#list')).toContainText('No particular hosted client or plan is claimed tested');
    await tabTo(guidePage, '#mcp-endpoint');
    await guidePage.keyboard.press('ControlOrMeta+a');
    expect(await endpoint.evaluate(el => el.selectionEnd - el.selectionStart)).toBe(`${base}/mcp`.length);
    await noOverflow(guidePage);
    await guidePage.screenshot({ path: path.join(artifacts, `${label}-human-assistant-guide.png`) });
    await guidePage.locator('#list a[href="https://pimwell.test/me"]').click();
    await expect(guidePage.locator('#list h1')).toHaveText('Your account');
    await guidePage.locator('#list a[href="https://acme.pimwell.test/assistant/connect"]').click();
    await expect(guidePage.locator('#mcp-endpoint')).toHaveValue(`${base}/mcp`);
    await guideCtx.close();
    console.log(`PASS ${label}: human connector guide discovery, keyboard selection, endpoint/identity, account round-trip and wrapping (no hosted OAuth claim)`);
  }

  // Recorded closers are historical actors, not assignees or presence. Exercise
  // the actual board/API with only synthetic local work and browser sessions.
  const closedWork = await verb(member, 'work.create', { project: 'site', kind: 'snag', title: 'Closure evidence', owner: 'peer@example.test' });
  await verb(member, 'work.update', { id: closedWork.item.id, state: 'done' });
  await verb(member, 'work.update', { id: closedWork.item.id, state: 'open' });
  await verb(member, 'work.update', { id: closedWork.item.id, state: 'done' });
  const closures = (await verb(reader, 'work.board', { project: 'site' })).closures;
  expect(closures.actors.map(a => ({ name: a.name, items: a.items }))).toEqual([{ name: 'dev', items: 1 }]);
  expect(closures.currently_done_without_record).toBe(0);
  // Long inert directory text must wrap rather than execute or overflow.
  await db.prepare("UPDATE identity SET display_name = ? WHERE email = 'dev@example.test'")
    .bind('<img src=x onerror=alert(1)>' + 'X'.repeat(120)).run();
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]) {
    const boardCtx = await context(reader, viewport), boardPage = await boardCtx.newPage();
    await boardPage.goto(`${base}/site/board`);
    await expect(boardPage.locator('.closure-report h2')).toHaveText('Recorded closures by actor');
    await expect(boardPage.locator('.closure-counts tbody tr')).toHaveCount(1);
    await expect(boardPage.locator('.closure-counts tbody td').last()).toHaveText('1');
    await expect(boardPage.locator('.closure-report')).toContainText('including reopened items');
    await expect(boardPage.locator('.closure-report')).toContainText('Historical prose events are not attributed');
    await expect(boardPage.locator('.closure-report img')).toHaveCount(0);
    await noOverflow(boardPage);
    await boardPage.locator('.closure-report').scrollIntoViewIfNeeded();
    await boardPage.screenshot({ path: path.join(artifacts, `${label}-closure-counts.png`) });
    await boardCtx.close();
    console.log(`PASS ${label}: real board closer attribution, reclosure deduplication, safe wrapping and historical coverage`);
  }

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
  await cacheBrowser?.close();
  if (cacheServer) await new Promise(resolve => cacheServer.close(resolve));
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
}
