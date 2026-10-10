import { execFileSync } from "node:child_process";
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
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  releaseModel();
  await browser?.close();
  await mf?.dispose();
  if (temp) await rm(temp, { recursive: true, force: true });
});

async function open(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addCookies([{ name: "pmw_session", value: TOKEN, domain: ".pimwell.test", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/*", async route => {
    const req = route.request();
    if (new URL(req.url()).hostname !== HOST) return route.abort("blockedbyclient");
    const response = await mf.dispatchFetch(req.url(), { method: req.method(), headers: { ...await req.allHeaders(), "x-local-browser-host": HOST }, body: req.postDataBuffer() ?? undefined });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
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
  await page.waitForFunction("!document.querySelector('#ask .send').disabled");
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

it("retains the next draft while a turn is pending rather than forking context", async () => {
  inputs.length = 0;
  holdModel = true;
  const { context, page } = await open();
  try {
    const text = page.getByRole("textbox", { name: "Your message", exact: true });
    await text.fill("Slow first question");
    await text.press("Enter");
    await page.waitForFunction("document.querySelector('#ask .send').disabled");
    await text.fill("Queued follow up");
    await text.press("Enter");
    expect(await text.inputValue()).toBe("Queued follow up");
    expect(await page.locator("#chatlog .msg.user").count()).toBe(1);
    await expect.poll(() => inputs.length).toBe(1);
    releaseModel();
    await page.waitForFunction("!document.querySelector('#ask .send').disabled");
    await text.press("Enter");
    await page.waitForFunction("document.querySelectorAll('#chatlog .msg').length === 4 && !document.querySelector('#ask .send').disabled");
    expect(inputs[1]!.map(i => i.content)).toEqual(["Slow first question", "Answer to Slow first question", "Queued follow up"]);
  } finally { releaseModel(); await context.close(); }
});
