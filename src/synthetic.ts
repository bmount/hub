import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import type { Env } from "./env";
import { randomToken, sha256Hex, ulid } from "./ids";
import { createGrant, setLibraryGrantId } from "./db/oauthGrants";
import { authServer, libraryGrantIdOf, tenantResource } from "./oauth/config";
import { createRepo } from "./code/ardi";
import { parseAdvertisedRefs } from "./code/gitProtocol";
import { tenantHash } from "./perf";

export const SYNTHETIC_TENANT = "perf-synthetic-tenant";
export const SYNTHETIC_MEMBER = "perf-synthetic-member";
export const SYNTHETIC_JOURNEYS = ["landing", "sign-in", "home", "docket", "item", "chat-page", "mail", "tools/list", "work_read", "search_query", "chat-post", "chat-read", "git-ls-remote"] as const;
type Journey = typeof SYNTHETIC_JOURNEYS[number];
type Observation = { duration: number; version: string; colo: string; failed: boolean };

/** A marker is not authentication. Only a live credential minted for our fixed fixture can mark anonymous page traffic. */
export async function syntheticMarker(env: Env, token: string | null): Promise<boolean> {
  if (!token || token.length > 128) return false;
  return !!await env.HUB_DB.prepare(`/*perf-site:src%2Fsynthetic.ts:19:18:syntheticMarker:521dd857*/ SELECT 1 FROM session s JOIN identity i ON i.id = s.identity_id
    WHERE s.token_hash = ? AND s.identity_id = ? AND i.is_synthetic = 1 AND s.label = 'Synthetic journey'
    AND s.revoked_at IS NULL AND s.expires_at > ?`).bind(await sha256Hex(token), SYNTHETIC_MEMBER, Date.now()).first();
}

async function credential(env: Env, kind: "browser" | "git", now: number) {
  const id = ulid(now), token = randomToken("pms_");
  await env.HUB_DB.prepare(`/*perf-site:src%2Fsynthetic.ts:26:9:credential:18d2210e*/ INSERT INTO session (id, identity_id, tenant_id, kind, label, token_hash, created_at, last_seen_at, expires_at, last_proof_at)
    VALUES (?, ?, ?, ?, 'Synthetic journey', ?, ?, ?, ?, ?)`).bind(id, SYNTHETIC_MEMBER, SYNTHETIC_TENANT, kind, await sha256Hex(token), now, now, now + 240_000, now).run();
  return { id, token };
}

async function mcpCredential(env: Env, browserId: string, now: number, ctx: ExecutionContext) {
  const resource = tenantResource(env, "perf-synthetic"), server = authServer(env, resource), api = server.getOAuthApi(env);
  const client = await api.createClient({ clientName: "Synthetic journey", redirectUris: [`https://${env.HUB_DOMAIN}/signed-out`], tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code"], responseTypes: ["code"] });
  let libraryId: string | null = null;
  try {
  const verifier = randomToken(""), challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const request = await api.parseAuthRequest(new Request(`https://${env.HUB_DOMAIN}/oauth/authorize?` + new URLSearchParams({ client_id: client.clientId, redirect_uri: `https://${env.HUB_DOMAIN}/signed-out`, response_type: "code", scope: "read write", resource, code_challenge: challenge, code_challenge_method: "S256" })));
  const { grant, session } = await createGrant(env.HUB_DB, { identity_id: SYNTHETIC_MEMBER, tenant_id: SYNTHETIC_TENANT, client_id: client.clientId, client_name: "Synthetic journey", client_kind: "dcr", redirect_host: env.HUB_DOMAIN, resource, scopes: ["read", "write"], approved_by_session_id: browserId, last_proof_at: now }, now);
  await env.HUB_DB.batch([
    env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:40:5:mcpCredential:aa51233c*/ UPDATE session SET expires_at = ? WHERE id = ?").bind(now + 240_000, session.id),
    env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:41:5:mcpCredential:ec44f43e*/ UPDATE oauth_grant SET expires_at = ? WHERE id = ?").bind(now + 240_000, grant.id),
  ]);
  const { redirectTo } = await api.completeAuthorization({ request, userId: SYNTHETIC_MEMBER, scope: ["read", "write"], metadata: { grant_id: grant.id }, props: { grant_id: grant.id, session_id: session.id, identity_id: SYNTHETIC_MEMBER, tenant_id: SYNTHETIC_TENANT, resource, scopes: ["read", "write"] } });
  const code = new URL(redirectTo).searchParams.get("code")!;
  libraryId = libraryGrantIdOf(code)!;
  await setLibraryGrantId(env.HUB_DB, grant.id, libraryId, await sha256Hex(code));
  const response = await server.fetch(new Request(`https://${env.HUB_DOMAIN}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.clientId, redirect_uri: `https://${env.HUB_DOMAIN}/signed-out`, code_verifier: verifier, resource }) }), env, ctx);
  const result = await response.json() as { access_token?: string };
  if (!response.ok || !result.access_token) throw new Error("Synthetic MCP credential failed");
  const mintedId = libraryId;
  return { token: result.access_token, async close() { try { await api.revokeGrant(mintedId, SYNTHETIC_MEMBER); } finally { await api.deleteClient(client.clientId); } } };
  } catch (error) {
    try { if (libraryId) await api.revokeGrant(libraryId, SYNTHETIC_MEMBER); } finally { await api.deleteClient(client.clientId); }
    throw error;
  }
}

export async function recordSynthetic(env: Env, journey: Journey, point: Observation, at = Date.now()): Promise<void> {
  const previous = await env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:59:26:recordSynthetic:fd61fc46*/ SELECT failed FROM synthetic_run WHERE journey = ?").bind(journey).first<{failed:number}>();
  await env.HUB_DB.prepare(`/*perf-site:src%2Fsynthetic.ts:60:9:recordSynthetic:d8833caf*/ INSERT INTO synthetic_run (journey, at, duration, failed, version, colo) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(journey) DO UPDATE SET at = excluded.at, duration = excluded.duration, failed = excluded.failed, version = excluded.version, colo = excluded.colo`).bind(journey, at, point.duration, +point.failed, point.version, point.colo).run();
  const tenant = await tenantHash(SYNTHETIC_TENANT, env.PERF_TENANT_KEY ?? env.HUB_INTERNAL_SECRET ?? env.HUB_SECRETS_KEY ?? "");
  env.PERF?.writeDataPoint({ indexes: [`synthetic:${journey}`], blobs: ["pimwell.com", "pimwell-hub", point.version, point.colo, tenant, crypto.randomUUID(), "synthetic", journey, "journey", point.failed ? "5xx" : "2xx", "synthetic", "", "", journey], doubles: [point.duration, 0, 0, 0, +point.failed, -1, -1, -1, -1, -1, 1, 0, 0, 1, 0, at, point.duration, 0, -1, 2] });
  // One Situation per failure episode, not one every five minutes. No model call or real-user data.
  if (point.failed && !previous?.failed) {
    const id = ulid(at), thread = ulid(at), title = `Synthetic journey failed: ${journey}`;
    await env.HUB_DB.batch([
      env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:68:7:recordSynthetic:4471ec87*/ INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, 'read', ?, ?)").bind(thread, SYNTHETIC_TENANT, SYNTHETIC_MEMBER, title, at, at),
      env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:69:7:recordSynthetic:fc1a53e5*/ INSERT INTO situation (id, tenant_id, identity_id, thread_id, title, question, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, SYNTHETIC_TENANT, SYNTHETIC_MEMBER, thread, title, title, `The fixed live journey failed. Version ${point.version}; colo ${point.colo || "unknown"}. No response contents or credentials retained.`, at),
    ]);
  }
}

function metadata(response: Response | null, env: Env): Pick<Observation,"version"|"colo"> {
  return { version: response?.headers.get("x-pimwell-version") ?? env.WORKER_VERSION?.id ?? "unknown", colo: response?.headers.get("x-pimwell-colo") ?? response?.headers.get("cf-ray")?.split("-").at(-1) ?? "unknown" };
}

/** Fixed fixture setup and the public exchange are both inside the Git journey timer. */
export async function gitLsRemote(env: Env, journeyFetch: (url: string, init?: RequestInit) => Promise<Response>, authorization: string, now: number): Promise<Pick<Observation, "version" | "colo">> {
  const provision = () => createRepo(env, env.HUB_DB, { identity_id: SYNTHETIC_MEMBER, tenant_id: SYNTHETIC_TENANT, org: "perf-synthetic", name: "fixture" }, now);
  const exchange = () => journeyFetch(`https://perf-synthetic.${env.HUB_DOMAIN}/fixture.git/info/refs?service=git-upload-pack`, { headers: { authorization }, signal: AbortSignal.timeout(25_000) });
  let response = await exchange();
  // A successful public exchange already checked routing, caller and ownership.
  // Only inspect provisioning state after an error: an unmapped new fixture may
  // be fenced off from the retired backend with 503 rather than storage 404.
  const missingMapping = response.status === 503 && !await env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:86:60:gitLsRemote:a8fde622*/ SELECT 1 FROM git_repository WHERE tenant_id = ? AND project_id = 'perf-synthetic-repo'").bind(SYNTHETIC_TENANT).first();
  if (response.status === 404 || missingMapping) {
    await response.body?.cancel();await provision();response = await exchange();
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("application/x-git-upload-pack-advertisement")) throw new Error("Synthetic Git failed");
  parseAdvertisedRefs(new Uint8Array(await response.arrayBuffer()));
  return metadata(response, env);
}

/** All destinations and fixture arguments are fixed in code; credentials never leave this Worker/browser service. */
export async function runSynthetic(env: Env, ctx: ExecutionContext): Promise<void> {
  const now = Date.now(), completed = new Set<Journey>();
  let origin = metadata(null, env);
  let browser: Browser | undefined, web: Awaited<ReturnType<typeof credential>> | undefined, git: Awaited<ReturnType<typeof credential>> | undefined, mcp: Awaited<ReturnType<typeof mcpCredential>> | undefined;
  const observe = async (journey: Journey, fn: () => Promise<Pick<Observation,"version"|"colo">>) => {
    const start = performance.now(); let info = origin, failed = false;
    try { info = await fn(); } catch { failed = true; }
    await recordSynthetic(env, journey, { ...info, failed, duration: performance.now()-start }); completed.add(journey);
  };
  try {
    if (!env.SYNTHETIC_BROWSER) throw new Error("Synthetic browser binding missing");
    web = await credential(env, "browser", now); git = await credential(env, "git", now);
    browser = await puppeteer.launch(env.SYNTHETIC_BROWSER);
    const page = await browser.newPage();
    // No third-party request can receive our ephemeral marker or cookies.
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (!([env.HUB_DOMAIN, `perf-synthetic.${env.HUB_DOMAIN}`].includes(url.hostname)) || url.protocol !== "https:") { void request.abort(); return; }
      const headers: Record<string,string> = { ...request.headers(), "x-pimwell-synthetic": web!.token };
      // Headless MCP clients have no Origin. Keep the server browser-origin policy unchanged.
      if (url.pathname === "/mcp") delete headers.origin;
      void request.continue({ headers });
    });
    // Chromium reaches the public route. Same-Worker fetch() can bypass a zone route to its origin.
    const journeyFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const { signal: _signal, ...options } = init;
      const result = await page.evaluate(async (url, options) => {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
        return { status: response.status, headers: Array.from(response.headers.entries()), body: await response.text() };
      }, url, options);
      return new Response(result.body, { status: result.status, headers: result.headers });
    };
    try {
      const probe = await page.goto(`https://${env.HUB_DOMAIN}/healthz`, { waitUntil: "load", timeout: 10_000 });
      const headers = probe?.headers() ?? {};
      origin = { version: headers["x-pimwell-version"] ?? origin.version, colo: headers["x-pimwell-colo"] ?? headers["cf-ray"]?.split("-").at(-1) ?? "unknown" };
    } catch { /* origin may be unreachable */ }
    const navigate = async (url: string, signedIn: boolean) => {
      const response = await page.goto(url, { waitUntil: "load", timeout: 10_000 });
      const headers = response?.headers() ?? {};
      if (!response || response.status() !== 200 || new URL(page.url()).pathname !== new URL(url).pathname) throw new Error("Synthetic navigation failed");
      if (signedIn && !await page.$("[data-perf-page]")) {
        // The frame's collector metadata is the readiness marker, not a guessed sleep.
        if (!await page.$('script[src*="/assets/timing."]')) throw new Error("Synthetic frame not rendered");
      }
      await page.evaluate(() => new Promise<void>(resolve => (globalThis as unknown as {requestAnimationFrame: (fn: () => void) => void}).requestAnimationFrame(() => (globalThis as unknown as {requestAnimationFrame: (fn: () => void) => void}).requestAnimationFrame(() => resolve()))));
      return { version: headers["x-pimwell-version"] ?? env.WORKER_VERSION?.id ?? "unknown", colo: headers["x-pimwell-colo"] ?? headers["cf-ray"]?.split("-").at(-1) ?? "unknown" };
    };
    await observe("landing", () => navigate(`https://${env.HUB_DOMAIN}/`, false));
    await observe("sign-in", () => navigate(`https://${env.HUB_DOMAIN}/login`, false));
    await page.setCookie({ name: "pmw_session", value: web.token, domain: `.${env.HUB_DOMAIN}`, path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
    const base = `https://perf-synthetic.${env.HUB_DOMAIN}`;
    for (const [journey, path] of [["home","/"],["docket","/docket"],["item","/perf-synthetic/w/1"],["chat-page","/c/synthetic"],["mail","/mail"]] as const) await observe(journey, () => navigate(base+path, true));
    mcp = await mcpCredential(env, web.id, now, ctx);
    const rpc = async (method: string, params?: object) => {
      const response = await journeyFetch(base+"/mcp", { method: "POST", headers: { authorization: `Bearer ${mcp!.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-pimwell-synthetic": web!.token }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? {params} : {}) }), signal: AbortSignal.timeout(25_000) });
      const text = await response.text();
      const data = JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find(line=>line.startsWith("data:"))!.slice(5) : text) as {error?:unknown;result?:{isError?:boolean}};
      if (!response.ok || data.error || !data.result || data.result.isError) throw new Error("Synthetic MCP failed");
      return metadata(response, env);
    };
    await observe("tools/list", () => rpc("tools/list"));
    await observe("work_read", () => rpc("tools/call", { name: "work_read", arguments: { id: "perf-synthetic#1" } }));
    await observe("search_query", () => rpc("tools/call", { name: "search_query", arguments: { q: "Synthetic fixture" } }));
    const api = async (verb: string, args: object) => {
      const response = await journeyFetch(base+"/api/"+verb, { method: "POST", headers: { "content-type": "application/json", "x-pimwell-synthetic": web!.token }, body: JSON.stringify(args), signal: AbortSignal.timeout(25_000) });
      const data = await response.json() as {ok?:boolean;error?:unknown;result?:Record<string,unknown>};
      if (!response.ok || data.error) throw new Error("Synthetic chat failed");
      return { info: metadata(response, env), data };
    };
    let posted = false;
    await observe("chat-post", async () => { const result = await api("chat.post", { c: "synthetic", body: `Synthetic check ${Math.floor(now/300_000)}`, idempotency_key: `synthetic-${Math.floor(now/300_000)}` }); posted = true; return result.info; });
    await observe("chat-read", async () => { const result = await api("chat.read", { c: "synthetic", limit: 1 }); if (!posted || !JSON.stringify(result.data).includes(`Synthetic check ${Math.floor(now/300_000)}`)) throw new Error("Synthetic read did not see post"); return result.info; });
    await observe("git-ls-remote", () => gitLsRemote(env, (url, options) => fetch(url, { ...options, redirect: "manual" }), `Basic ${btoa("synthetic:"+git!.token)}`, now));
  } catch { /* Setup failures are observations, never swallowed as a successful tick. */ }
  finally {
    try { await browser?.close(); } catch { /* credentials still expire */ }
    try { await mcp?.close(); } catch { /* D1 grant expiry is the authorization boundary */ }
    await env.HUB_DB.batch([
      env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:176:7:runSynthetic:3e8499a3*/ UPDATE event SET session_id = NULL WHERE identity_id = ?").bind(SYNTHETIC_MEMBER),
      env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:177:7:runSynthetic:ab06c962*/ DELETE FROM oauth_grant WHERE identity_id = ? AND (expires_at <= ? OR approved_by_session_id = ?)").bind(SYNTHETIC_MEMBER, Date.now(), web?.id ?? ""),
      env.HUB_DB.prepare("/*perf-site:src%2Fsynthetic.ts:178:7:runSynthetic:7986d436*/ DELETE FROM session WHERE identity_id = ? AND (expires_at <= ? OR id IN (?, ?)) AND id NOT IN (SELECT session_id FROM oauth_grant)").bind(SYNTHETIC_MEMBER, Date.now(), web?.id ?? "", git?.id ?? ""),
    ]);
    for (const journey of SYNTHETIC_JOURNEYS) if (!completed.has(journey)) await recordSynthetic(env, journey, { ...origin, duration: Math.max(0,Date.now()-now), failed: true });
  }
}
