import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seal } from "../../src/models/secretbox";

// Real browser + bundled Worker, disposable D1 and a scripted model. All network
// requests are intercepted; no production identities or credentials are used.
const HOST = "acme.pimwell.test", BASE = `https://${HOST}`;
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const TOKEN = "local-browser-fixture", ID = "00000000000000000000000001";
let temp: string, mf: Miniflare, browser: Browser;
const inputs: Array<Array<{ role: string; content: string }>> = [];
let holdModel = false, failModel = false;
const held: Array<() => void> = [];
function releaseModel() { holdModel = false; held.splice(0).forEach(resolve => resolve()); }

beforeAll(async () => {
  temp = await mkdtemp(path.join(tmpdir(), "pimwell-assistant-"));
  const build = path.join(temp, "build");
  execFileSync("node_modules/.bin/wrangler", ["deploy", "--dry-run", "--outdir", build], { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  await writeFile(path.join(build, "browser-entry.js"), `
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
    name: "assistant-browser", modulesRoot: build, modules: [
      { type: "ESModule", path: path.join(build, "browser-entry.js") },
      { type: "ESModule", path: path.join(build, "index.js") },
      ...(await readdir(build)).filter(f => f.endsWith(".html")).map(f => ({ type: "Text" as const, path: path.join(build, f) })),
    ],
    compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    bindings: { HUB_DOMAIN: "pimwell.test", HUB_SECRETS_KEY: KEY },
    d1Databases: ["HUB_DB"], kvNamespaces: ["RATE", "OAUTH_KV"],
    durableObjects: { CONVERSATION: { className: "Conversation", useSQLite: true }, INBOX: { className: "Inbox", useSQLite: true } },
    serviceBindings: { ARDI: () => new Response("Denied in local test", { status: 503 }) },
    outboundService: async request => {
      if (new URL(request.url).pathname !== "/v1/responses") return new Response("Denied in local test", { status: 503 });
      const body = await request.json() as { input: Array<{ role: string; content: string }> };
      inputs.push(body.input);
      if (holdModel) await new Promise<void>(resolve => { held.push(resolve); });
      if (failModel) { failModel = false; return Response.json({ error: "local model failure" }, { status: 503 }); }
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: `Answer to ${body.input.at(-1)!.content}` }] }], usage: { input_tokens: 3, output_tokens: 4 } });
    },
  }] }));
  const db = await mf.getD1Database("HUB_DB");
  const { unstable_splitSqlQuery } = await import("wrangler");
  for (const file of (await readdir("migrations")).filter(f => f.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(await readFile(path.join("migrations", file), "utf8"))) await db.prepare(sql).run();
  }
  const now = Date.now();
  await db.prepare("INSERT INTO tenant (id,slug,display_name,created_at) VALUES (?,'acme','Acme',?)").bind(ID, now).run();
  await db.prepare("INSERT INTO identity (id,kind,display_name,email,created_at) VALUES (?,'human','Brian','brian.mount@costplusdrugs.com',?)").bind(ID, now).run();
  await db.prepare("INSERT INTO membership (id,identity_id,tenant_id,role,created_at) VALUES (?,?,?,'member',?)").bind(ID, ID, ID, now).run();
  await db.prepare("INSERT INTO session (id,identity_id,kind,token_hash,created_at,last_seen_at,expires_at,last_proof_at) VALUES (?,?,'browser',?,?,?,?,?)")
    .bind(ID, ID, createHash("sha256").update(TOKEN).digest("hex"), now, now, now + 3600000, now).run();
  const secret = await seal(KEY, "sk-local-test-key");
  await db.prepare("INSERT INTO provider_credential (id,provider,label,secret_ciphertext,secret_iv,fingerprint,status,created_at) VALUES (?,'openai','local',?,?,'local','active',?)")
    .bind(ID, secret.ciphertext, secret.iv, now).run();
  browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] });
});

afterAll(async () => {
  releaseModel();
  await browser?.close();
  await mf?.dispose();
  if (temp) await rm(temp, { recursive: true, force: true });
});

async function open(augment?: (html: string) => string, setup?: (context: BrowserContext) => Promise<void>): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ serviceWorkers: "block", permissions: ["microphone", "clipboard-read", "clipboard-write"] });
  await context.addCookies([{ name: "pmw_session", value: TOKEN, domain: ".pimwell.test", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/*", async route => {
    const req = route.request();
    const host = new URL(req.url()).hostname;
    if (![HOST, "pimwell.test"].includes(host)) return route.abort("blockedbyclient");
    const response = await mf.dispatchFetch(req.url(), { method: req.method(), headers: { ...await req.allHeaders(), "x-local-browser-host": host }, body: req.postDataBuffer() ?? undefined, redirect: "manual" });
    let body = Buffer.from(await response.arrayBuffer());
    if (augment && response.headers.get("content-type")?.startsWith("text/html")) body = Buffer.from(augment(body.toString()));
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  if (setup) await setup(context);
  await context.addInitScript(() => {
    const w = globalThis as any;
    w.cspViolations = [];
    w.document.addEventListener('securitypolicyviolation', (e: any) => w.cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  await page.goto(`${BASE}/assistant`);
  return { context, page };
}

async function ask(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Your message", exact: true }).fill(text);
  const response = page.waitForResponse(`${BASE}/assistant/chat`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await response;
  await expect.poll(() => page.locator('#ask .send').isDisabled()).toBe(false);
}

it("keeps a serial transcript, model context, navigation and reload history", async () => {
  inputs.length = 0;
  const { context, page } = await open();
  try {
    await ask(page, "First question");
    const threadUrl = page.url();
    expect(threadUrl).toMatch(/\/assistant\?t=/);
    await page.setViewportSize({ width: 390, height: 844 });
    const draft = page.locator("#ask textarea");
    await draft.fill("Unsent draft");
    await page.locator("[data-conversations-link]").click();
    await page.waitForURL(`${threadUrl}&list=1`);
    expect(await draft.inputValue()).toBe("Unsent draft");
    await page.locator("#inspector .back").click();
    await page.waitForURL(threadUrl);
    expect(await draft.inputValue()).toBe("Unsent draft");
    await ask(page, "Follow up");
    expect(await page.locator("#chatlog .msg").allTextContents()).toEqual(["First question", "PAnswer to First question", "Follow up", "PAnswer to Follow up"]);
    expect(inputs[1]).toEqual([{ role: "user", content: "First question" }, { role: "assistant", content: "Answer to First question" }, { role: "user", content: "Follow up" }]);
    await page.locator(".assist-top a", { hasText: /^Chat$/ }).click();
    await page.waitForURL(threadUrl);
    expect(page.url()).toBe(threadUrl);
    expect(await page.locator("#chatlog .msg").count()).toBe(4);
    await page.reload();
    expect(await page.locator("#chatlog .msg").count()).toBe(4);
    await page.locator(".assist-top a", { hasText: /^Tools$/ }).click();
    await page.waitForURL(`${BASE}/assistant/tools?t=*`);
    await page.getByRole("link", { name: "Read and write", exact: true }).click();
    await page.waitForURL(`${BASE}/assistant/tools?scopes=write&t=*`);
    await page.locator("#list").getByRole("link", { name: "Chat", exact: true }).click();
    await page.waitForURL(threadUrl);
    expect(await page.locator("#chatlog .msg").count()).toBe(4);
    await page.locator(".assist-top a", { hasText: "+ New chat" }).click();
    await page.waitForURL(`${BASE}/assistant`);
    expect(await page.locator("#chatlog .msg").count()).toBe(0);
  } finally { await context.close(); }
});

it("does not overwrite navigation when a pending answer arrives after leaving Chat", async () => {
  inputs.length = 0;
  holdModel = true;
  const { context, page } = await open();
  try {
    await page.locator("#ask textarea").fill("Answer while away");
    const response = page.waitForResponse(`${BASE}/assistant/chat`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => held.length).toBe(1);
    await page.locator("#rail a[href='/docket']").click();
    await page.waitForURL(`${BASE}/docket`);
    releaseModel();
    const result = await (await response).json() as { thread: string };
    await page.waitForLoadState("networkidle");
    expect(page.url()).toBe(`${BASE}/docket`);
    await page.goto(`${BASE}/assistant?t=${result.thread}`);
    expect(await page.locator("#chatlog .msg").allTextContents()).toEqual(["Answer while away", "PAnswer to Answer while away"]);
  } finally { releaseModel(); await context.close(); }
});

it("keeps the created conversation after an error without replaying the failed turn", async () => {
  inputs.length = 0;
  failModel = true;
  const { context, page } = await open();
  try {
    await ask(page, "Question that fails");
    const threadUrl = page.url();
    expect(threadUrl).toMatch(/\/assistant\?t=/);
    expect(await page.locator("#chatlog .err").textContent()).toContain("Not done");
    expect(inputs).toHaveLength(1);
    await ask(page, "A different question");
    expect(page.url()).toBe(threadUrl);
    expect(inputs[1]).toEqual([{ role: "user", content: "A different question" }]);
    const db = await mf.getD1Database("HUB_DB");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM assistant_message WHERE thread_id = ?").bind(new URL(threadUrl).searchParams.get("t")).first()).toEqual({ n: 2 });
  } finally { failModel = false; await context.close(); }
});

it("blocks injected scripts, handlers, javascript URLs, eval, base and objects on loads and pane swaps", async () => {
  const attacks = `<script>window.cspAttack = true</script><script src="https://evil.test/attack.js"></script><script src="data:text/javascript,window.cspAttack=true"></script><base href="https://evil.test/"><object data="/privacy"></object><button id="attack" onclick="window.cspAttack=true">Attack</button><a id="attack-link" href="javascript:window.cspAttack=true">Attack link</a>`;
  const { context, page } = await open(html => html.replace('<div class="assist">', '<div class="assist"><script src="/assets/csp-fixture.js"></script>' + attacks), async context => {
    // Evaluate from an allowed static script: CDP's page.evaluate itself bypasses unsafe-eval enforcement.
    await context.route(`${BASE}/assets/csp-fixture.js`, route => route.fulfill({ contentType: 'text/javascript', body: `try { new Function('window.cspAttack=true')(); } catch { window.evalBlocked = true; }` }));
  });
  try {
    await page.locator('#attack').click();
    await page.locator('#attack-link').click();
    await page.evaluate(() => {
      const w = globalThis as any, s = w.document.createElement('script');
      s.src = w.URL.createObjectURL(new w.Blob(['window.cspAttack=true'], { type: 'text/javascript' }));
      w.document.body.append(s);
    });
    const check = () => page.evaluate(() => {
      const w = globalThis as any;
      return { attacked: w.cspAttack ?? false, evalBlocked: w.evalBlocked ?? false, base: w.document.baseURI };
    });
    expect(await check()).toEqual({ attacked: false, evalBlocked: true, base: `${BASE}/assistant` });
    await expect.poll(() => page.evaluate(() => (globalThis as any).cspViolations.map((e: any) => e.directive))).toEqual(expect.arrayContaining(['script-src-elem', 'script-src-attr', 'script-src', 'base-uri', 'object-src']));
    await expect.poll(() => page.evaluate(() => (globalThis as any).cspViolations.map((e: any) => e.blocked))).toEqual(expect.arrayContaining(['inline', 'eval', 'data', 'blob', 'https://evil.test/attack.js']));
    await ask(page, '<img src=x onerror="window.cspAttack=true">');
    expect(await page.locator('#chatlog img').count()).toBe(0);
    await page.locator('.assist-top a', { hasText: '+ New chat' }).click();
    await page.waitForURL(`${BASE}/assistant`);
    await page.locator('#attack').click();
    expect((await check()).attacked).toBe(false);
    await ask(page, 'Still works after a pane swap');
    expect(await page.locator('#chatlog .msg').count()).toBe(2);
  } finally { await context.close(); }
});

it("runs Tools in both scopes, copies on a plain page, and keeps landing animation executable", async () => {
  const { context, page } = await open();
  try {
    for (const scopes of ['read', 'write']) {
      await page.goto(`${BASE}/assistant/tools?scopes=${scopes}`);
      const card = page.locator('.card').filter({ has: page.locator('form[data-tool="whoami"]') });
      await card.locator('summary').first().click();
      await card.locator('textarea').fill('{}');
      const response = page.waitForResponse(`${BASE}/playground/call`);
      await card.getByRole('button', { name: 'Run', exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(200);
      expect(result.request().postDataJSON().scopes).toBe(scopes);
      await expect.poll(() => card.locator('.out').textContent()).toContain('brian.mount@costplusdrugs.com');
    }
    // A native form submission renders the standalone copy asset, without the workbench listener.
    await page.goto(`${BASE}/people?connect=1`);
    await page.locator('input[name="display_name"]').fill('Local copy fixture');
    await page.evaluate(() => (globalThis as any).document.querySelector('form[action="/api/agent.connect"]').setAttribute('data-reload', ''));
    await page.getByRole('button', { name: 'Make connect link', exact: true }).click();
    await page.waitForURL(`${BASE}/api/agent.connect`);
    expect(await page.locator('body.plain').count()).toBe(1);
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.getByRole('button', { name: 'Copied', exact: true }).count()).toBe(1);
    await context.clearCookies();
    await page.goto('https://pimwell.test/');
    await expect.poll(() => page.locator('#lamps .lamp').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('#mm path').count()).toBeGreaterThan(0);
  } finally { await context.close(); }
});

it.each(['http://localhost:33418/callback', 'https://claude.ai/api/mcp/auth_callback'])("allows OAuth approval redirect to %s without weakening script policy", async redirectUri => {
  const apex = 'https://pimwell.test';
  const registered = await mf.dispatchFetch(`${apex}/oauth/register`, { method: 'POST', headers: { 'x-local-browser-host': 'pimwell.test', 'content-type': 'application/json' }, body: JSON.stringify({
    client_name: 'Local CSP fixture', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
  }) });
  expect(registered.status).toBe(201);
  const { client_id } = await registered.json() as { client_id: string };
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirectUri, resource: `${BASE}/mcp`, scope: 'read', state: 'local-csp-fixture',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update('local-csp-verifier'.repeat(3)).digest('base64url') });
  // Native HTTP redirects must reach Chromium: Playwright fulfillment does not re-route redirect chains.
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await mf.dispatchFetch(`${apex}${req.url}`, { method: req.method, redirect: 'manual',
        headers: { 'x-local-browser-host': 'pimwell.test', cookie: `pmw_session=${TOKEN}`, origin: apex, 'content-type': req.headers['content-type'] ?? '' },
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end('Local fixture failed'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => {
      if (route.request().url().startsWith(local + '/')) return route.continue();
      if (route.request().url().startsWith(redirectUri + '?')) return route.fulfill({ body: 'Local callback', contentType: 'text/plain' });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(5000);
    await page.goto(`${local}/oauth/authorize?${q}`);
    // Redirect chains bypass route interception. DNS is disabled in Chromium, and the callback's
    // failed network request proves CSP allowed navigation without contacting an external provider.
    const callback = page.waitForEvent('requestfailed', { predicate: request => request.url().startsWith(redirectUri + '?') });
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const attempted = await callback;
    expect(attempted.failure()?.errorText).toMatch(/ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED)/);
    const result = new URL(attempted.url());
    expect(result.searchParams.get('state')).toBe('local-csp-fixture');
    expect(result.searchParams.get('code')).toBeTruthy();
  } finally {
    await context.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

it("records synthetic microphone audio and inserts corrected text under CSP", async () => {
  const { context, page } = await open();
  try {
    await context.route(`${BASE}/voice/transcribe`, async route => {
      expect(route.request().headers()['x-pimwell-voice']).toBe('1');
      expect(route.request().postDataBuffer()!.length).toBeGreaterThan(800);
      await route.fulfill({ json: { text: 'Synthetic speech' } });
    });
    await context.route(`${BASE}/voice/correct`, async route => {
      expect(route.request().postDataJSON().text).toBe('Synthetic speech');
      await route.fulfill({ json: { text: 'Corrected synthetic speech', changed: true } });
    });
    const mic = page.getByRole('button', { name: 'Talk. Hold, or tap to start and tap again to stop', exact: true });
    await mic.click();
    await expect.poll(() => page.locator('.voicestate').textContent(), { timeout: 5000 }).toMatch(/Listening 0:0[1-9]/);
    await mic.click();
    await expect.poll(() => page.locator('#ask textarea').inputValue()).toBe('Corrected synthetic speech');
  } finally { await context.close(); }
});

it("retains the next draft while a turn is pending rather than forking context", async () => {
  inputs.length = 0;
  holdModel = true;
  const { context, page } = await open();
  try {
    const text = page.getByRole("textbox", { name: "Your message", exact: true });
    await text.fill("Slow first question");
    await text.press("Enter");
    await expect.poll(() => page.locator('#ask .send').isDisabled()).toBe(true);
    await text.fill("Queued follow up");
    await text.press("Enter");
    expect(await text.inputValue()).toBe("Queued follow up");
    expect(await page.locator("#chatlog .msg.user").count()).toBe(1);
    await expect.poll(() => inputs.length).toBe(1);
    releaseModel();
    await expect.poll(() => page.locator('#ask .send').isDisabled()).toBe(false);
    await text.press("Enter");
    await expect.poll(() => page.locator('#chatlog .msg').count()).toBe(4);
    await expect.poll(() => page.locator('#ask .send').isDisabled()).toBe(false);
    expect(inputs[1]!.map(i => i.content)).toEqual(["Slow first question", "Answer to Slow first question", "Queued follow up"]);
  } finally { releaseModel(); await context.close(); }
});
