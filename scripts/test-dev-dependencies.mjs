// Host-side checks: native Sharp and Node Undici do not run inside the Workers test isolate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";

const root = new URL("../", import.meta.url);
const require = createRequire(new URL("package.json", root));
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
const patched = { sharp: "0.35.5", undici: "7.29.1" };

// Check every nested copy, not just the hoisted dependency. Exact versions correspond
// to the reviewed overrides; changing them requires updating this review/test too.
function assertPatched(packages) {
  for (const [name, version] of Object.entries(patched)) {
    const copies = Object.entries(packages).filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);
    assert.ok(copies.length, `missing ${name}`);
    for (const [path, entry] of copies) {
      // mailauth's production Undici 8 is outside this dev-chain override.
      if (name === "undici" && !entry.dev) continue;
      assert.equal(entry.version, version, `unreviewed ${path}`);
      assert.ok(entry.integrity, `missing integrity for ${path}`);
    }
  }
}

test("synthetic Browser Rendering SDK has no Node downloader dependencies", () => {
  assert.ok(manifest.dependencies["@cloudflare/playwright"]);
  assert.equal(manifest.dependencies["@cloudflare/puppeteer"], undefined);
  for (const path of Object.keys(lock.packages)) {
    for (const name of ["@puppeteer/browsers", "extract-zip", "basic-ftp"]) {
      assert.ok(!path.endsWith(`/node_modules/${name}`) && path !== `node_modules/${name}`, path);
    }
  }
});

test("lockfile contains only reviewed patched development Sharp/Undici copies", () => {
  assertPatched(lock.packages);
});

test("guard rejects vulnerable nested copies, missing dependencies and integrity", () => {
  for (const [name, version] of [["sharp", "0.35.2"], ["sharp", "0.35.4"], ["undici", "7.29.0"]]) {
    const packages = { ...lock.packages, [`node_modules/example/node_modules/${name}`]: { version, dev: true, integrity: "fixture" } };
    assert.throws(() => assertPatched(packages), /unreviewed/);
  }
  assert.throws(() => assertPatched({}), /missing sharp/);
  const packages = { ...lock.packages, "node_modules/sharp": { version: patched.sharp, dev: true } };
  assert.throws(() => assertPatched(packages), /missing integrity/);
});

test("all locked Sharp native/WASM packages and libvips match the patched release", () => {
  const binaries = Object.entries(lock.packages).filter(([path]) => path.includes("/node_modules/@img/sharp-") || path.startsWith("node_modules/@img/sharp-"));
  assert.ok(binaries.length);
  for (const [path, entry] of binaries) {
    assert.equal(entry.version, path.includes("sharp-libvips-") ? "1.3.4" : patched.sharp, path);
    assert.ok(entry.integrity, path);
  }
});

test("overrides are Miniflare-only and do not downgrade production mailauth Undici", () => {
  assert.equal(manifest.overrides.sharp, undefined);
  assert.equal(manifest.overrides.undici, undefined);
  for (const [name, version] of Object.entries(patched)) assert.equal(manifest.overrides.miniflare[name], version);
  const mailauthRequire = createRequire(require.resolve("mailauth/package.json"));
  assert.equal(mailauthRequire("undici/package.json").version, "8.11.2");
});

test("every installed Miniflare resolves the reviewed Sharp and Undici", () => {
  const copies = Object.keys(lock.packages).filter(path => path === "node_modules/miniflare" || path.endsWith("/node_modules/miniflare"));
  assert.ok(copies.length);
  for (const path of copies) {
    const fromMiniflare = createRequire(new URL(`${path}/package.json`, root));
    assert.equal(fromMiniflare("sharp").versions.sharp, patched.sharp, path);
    assert.equal(fromMiniflare("undici/package.json").version, patched.undici, path);
  }
});

test("patched native Sharp decodes SVG and resizes/re-encodes PNG", async () => {
  const sharp = require("sharp");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
  const png = await sharp(svg).resize(2, 2).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  assert.deepEqual([...data], Array(4).fill([255, 0, 0]).flat());
});

test("compressed chat probe captures 100 real compressed frames and reconciles a dropped ack without resubmission", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-compression-'));
  const records = new Map(); let sends = 0, reads = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const params = body ? JSON.parse(body) : {};
    let result;
    if (req.url === '/api/session.start') result = { session_token: 'synthetic-session' };
    else if (req.url === '/chat/v1/getChats') result = { conversations: [{ channel: 'tmp-test', id: 'conversation' }] };
    else if (req.url === '/api/chat.read') result = { head: sends };
    else if (req.url === '/api/chat.post_status') {
      reads++;
      assert.equal(records.get(params.idempotency_key).text, params.intent.body);
      assert.equal(records.get(params.idempotency_key).reply_to, params.intent.reply_to);
      result = { head: sends, record: { committed: { seq: sends } }, intent_check: { matches: true } };
    } else { res.writeHead(404).end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  const wss = new WebSocketServer({ server, perMessageDeflate: true });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'connected' }));
    ws.on('message', data => {
      const command = JSON.parse(data); sends++;
      assert.equal(command.method, 'sendMessage');
      assert.ok(!records.has(command.params.client_id), 'no mutation retries');
      records.set(command.params.client_id, command.params);
      ws.send(JSON.stringify({ ok: true, request_id: command.request_id, server_request_id: `root-${sends}`, result: { head: sends, msg_id: `message-${sends}` } }));
    });
  });
  try {
    await writeFile(join(dir, 'token'), 'synthetic-token', { mode: 0o600 });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    for (const drop of [false, true]) {
      const captureDir = join(dir, drop ? 'stall' : 'run');
      const child = spawn(process.execPath, ['scripts/probe-chat-compression.mjs'], { cwd: root, env: { ...process.env,
        PIMWELL_ORIGIN: `http://127.0.0.1:${server.address().port}`, PIMWELL_CHANNEL: 'tmp-test', PIMWELL_CAPTURE_DIR: captureDir,
        PIMWELL_TOKEN_FILE: join(dir, 'token'), PIMWELL_INTERVAL_MS: '0', PIMWELL_COUNT: drop ? '1' : '100',
        PIMWELL_ACK_TIMEOUT_MS: '100', PIMWELL_DROP_ACK: drop ? '1' : '0' }, stdio: 'pipe' });
      let stderr = ''; child.stderr.on('data', d => stderr += d); child.stdout.resume();
      const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
      const capture = JSON.parse(await readFile(join(captureDir, 'capture.json'), 'utf8'));
      assert.equal(capture.automatic_resubmissions, 0);
      assert.equal(capture.summary.compressed_frames, drop ? 1 : 100);
      assert.equal(capture.summary.joins, drop ? 0 : 100);
      if (drop) {
        assert.equal(capture.commands[0].ack, null);
        assert.equal(capture.commands[0].reconciliation.intent_check.matches, true);
        assert.ok(capture.commands[0].command.params.text);
        assert.ok(capture.commands[0].command.params.client_id);
      }
    }
    assert.equal(sends, 101); assert.equal(reads, 101);
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("patched development Undici request/response API works without external network", async () => {
  const { MockAgent, request } = require("undici");
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  try {
    dispatcher.get("https://dependency-test.invalid").intercept({ path: "/", method: "GET" }).reply(200, { ok: true });
    const response = await request("https://dependency-test.invalid/", { dispatcher });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await response.body.json(), { ok: true });
    dispatcher.assertNoPendingInterceptors();
  } finally {
    await dispatcher.close();
  }
});
