import { SELF } from "cloudflare:test";
import { cookieHeaders } from "./helpers";

export const APEX = "https://pimwell.test";
export const LOOPBACK = "http://localhost:33418/callback";
export const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
export const resourceFor = (slug: string) => `https://${slug}.pimwell.test/mcp`;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256 pair, as a client makes it. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export function register(body: Record<string, unknown>, ip = "203.0.113.10") {
  return SELF.fetch(`${APEX}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body),
  });
}

/** DCR the way Claude Code does it. Returns the client_id. */
export async function registerClient(redirect = LOOPBACK, name = "Claude Code"): Promise<string> {
  const res = await register({
    client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export type AuthorizeOpts = {
  client_id: string; challenge: string; redirect_uri?: string; resource?: string | null; scope?: string | null; method?: string | null; state?: string;
};

/** An authorization URL; `null` leaves a parameter out. */
export function authorizeUrl(o: AuthorizeOpts): string {
  const q = new URLSearchParams({ response_type: "code", client_id: o.client_id, redirect_uri: o.redirect_uri ?? LOOPBACK, state: o.state ?? "st-123" });
  if (o.method !== null) {
    q.set("code_challenge", o.challenge);
    q.set("code_challenge_method", o.method ?? "S256");
  }
  if (o.scope !== null) q.set("scope", o.scope ?? "read");
  if (o.resource !== null) q.set("resource", o.resource ?? resourceFor("acme"));
  return `${APEX}/oauth/authorize?${q}`;
}

export function authorize(o: AuthorizeOpts, headers: Record<string, string> = {}) {
  return SELF.fetch(authorizeUrl(o), { redirect: "manual", headers });
}

export function pendingIdOf(res: Response): string {
  const loc = res.headers.get("location") ?? "";
  const m = /\/oauth\/consent\/([A-Za-z0-9_-]{43})$/.exec(loc);
  if (!m) throw new Error(`no pending id in ${res.status} ${loc}`);
  return m[1]!;
}

export function viewConsent(id: string, token: string | null) {
  return SELF.fetch(`${APEX}/oauth/consent/${id}`, { redirect: "manual", headers: token ? { cookie: `pmw_session=${token}` } : {} });
}

export function formTokenOf(html: string): string {
  const m = /name="form_token" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("no form token on the page");
  return m[1]!;
}

export function decide(id: string, token: string, form_token: string, decision: string, headers: Record<string, string> = cookieHeaders(token, "pimwell.test")) {
  return SELF.fetch(`${APEX}/oauth/consent/${id}`, {
    method: "POST", redirect: "manual",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ form_token, decision }).toString(),
  });
}

/** Register, authorize, view consent, and approve as the human whose browser session is `token`. */
export async function connect(token: string, opts: { slug?: string; redirect?: string; scope?: string } = {}) {
  const redirect = opts.redirect ?? LOOPBACK;
  const client_id = await registerClient(redirect);
  const { verifier, challenge } = await pkce();
  const id = pendingIdOf(await authorize({ client_id, challenge, redirect_uri: redirect, resource: resourceFor(opts.slug ?? "acme"), scope: opts.scope }));
  const page = await viewConsent(id, token);
  const res = await decide(id, token, formTokenOf(await page.text()), "approve");
  if (res.status !== 302) throw new Error(`approve failed ${res.status}`);
  const location = new URL(res.headers.get("location")!);
  return { client_id, verifier, redirect, code: location.searchParams.get("code")!, location };
}

export function tokenRequest(fields: Record<string, string>, path = "/oauth/token") {
  return SELF.fetch(`${APEX}${path}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  });
}

export type Tokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string; resource: string };

/** connect() plus the code exchange: a working assistant connection. */
export async function connectWithTokens(token: string, opts: { slug?: string; scope?: string } = {}) {
  const c = await connect(token, opts);
  const res = await tokenRequest({
    grant_type: "authorization_code", code: c.code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: c.verifier,
    resource: resourceFor(opts.slug ?? "acme"),
  });
  if (res.status !== 200) throw new Error(`token exchange failed ${res.status} ${await res.text()}`);
  return { ...c, tokens: (await res.json()) as Tokens };
}

export function refresh(client_id: string, refresh_token: string, resource?: string) {
  const fields: Record<string, string> = { grant_type: "refresh_token", refresh_token, client_id };
  if (resource) fields.resource = resource;
  return tokenRequest(fields);
}

let rpcId = 0;

/** One MCP JSON-RPC call over Streamable HTTP, as a 2025-06-18 client sends it. */
export function mcpPost(slug: string, token: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const h: Record<string, string> = {
    "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers,
  };
  if (token) h.authorization = `Bearer ${token}`;
  return SELF.fetch(`https://${slug}.pimwell.test/mcp`, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
}

export const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } };

/** The JSON-RPC message in a response, whether it came as JSON or as an SSE event. */
export async function rpcBody(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    return JSON.parse(data[data.length - 1]!);
  }
  return JSON.parse(text);
}
