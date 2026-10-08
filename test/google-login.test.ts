import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setGoogleFetchForTest } from "../src/http/googleLogin";
import { createInvite } from "../src/db/invites";
import { getIdentityByEmail } from "../src/db/identities";
import { getMembership } from "../src/db/memberships";
import { ulid } from "../src/ids";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "pimwell.test";
const CLIENT = "test-client.apps.googleusercontent.com";
let priv: CryptoKey;
let jwk: JsonWebKey;
let ipSeq = 0;

function b64url(x: Uint8Array | string): string {
  const b = typeof x === "string" ? new TextEncoder().encode(x) : x;
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function idToken(claims: Record<string, unknown>): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "test-k", typ: "JWT" })), p = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  priv = kp.privateKey;
  jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
});
afterEach(() => setGoogleFetchForTest(null));

type Who = { email: string; sub?: string; hd?: string; email_verified?: boolean; name?: string };

/** Runs the whole browser flow against a stand-in Google and returns the callback response. */
async function signIn(who: Who, opts: { next?: string; tamperState?: boolean; noCookie?: boolean; session?: string; reproof?: boolean } = {}) {
  const ip = `203.0.113.${++ipSeq % 250}`;
  const qs = [opts.reproof ? "reproof=1" : "", opts.next ? `next=${encodeURIComponent(opts.next)}` : ""].filter(Boolean).join("&");
  const sess = opts.session ? `pmw_session=${opts.session}` : "";
  const start = await SELF.fetch(`https://${HOST}/login/google${qs ? `?${qs}` : ""}`, { redirect: "manual", headers: { "cf-connecting-ip": ip, ...(sess ? { cookie: sess } : {}) } });
  expect(start.status).toBe(302);
  const auth = new URL(start.headers.get("location")!);
  expect(auth.origin + auth.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  const state = auth.searchParams.get("state")!, nonce = auth.searchParams.get("nonce")!;
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(auth.searchParams.get("redirect_uri")).toBe(`https://${HOST}/login/google/callback`);
  let exchanged: URLSearchParams | null = null;
  setGoogleFetchForTest(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://oauth2.googleapis.com/token") {
      exchanged = new URLSearchParams(String(init!.body));
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: "https://accounts.google.com", aud: CLIENT, sub: who.sub ?? `sub-${who.email}`, email: who.email,
        email_verified: who.email_verified ?? true, name: who.name, nonce, iat: now, exp: now + 3600, ...(who.hd ? { hd: who.hd } : {}),
      };
      return Response.json({ id_token: await idToken(claims), access_token: "unused" });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [{ ...jwk, kid: "test-k", alg: "RS256" }] });
    return new Response("unexpected", { status: 500 });
  });
  const cbState = opts.tamperState ? state.slice(0, -2) + "xx" : state;
  const res = await SELF.fetch(`https://${HOST}/login/google/callback?code=c0de&state=${cbState}`, {
    redirect: "manual", headers: opts.noCookie ? {} : { cookie: [`pmw_gstate=${state}`, sess].filter(Boolean).join("; ") },
  });
  return { res, exchanged: exchanged as URLSearchParams | null };
}

function sessionSet(res: Response): boolean {
  return (res.headers.get("set-cookie") ?? "").includes("pmw_session=pms_");
}

async function addRule(kind: "email" | "domain", value: string, grants: Array<{ tenant_id: string | null; role: string }> = []) {
  const id = ulid(Date.now());
  await env.HUB_DB.prepare("INSERT INTO signin_rule (id, kind, value, created_at) VALUES (?, ?, ?, ?)").bind(id, kind, value, Date.now()).run();
  for (const g of grants) {
    await env.HUB_DB.prepare("INSERT INTO signin_grant (id, rule_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(ulid(Date.now()) + Math.random().toString(36).slice(2, 6), id, g.tenant_id, g.role, Date.now()).run();
  }
  return id;
}

describe("Sign in with Google", () => {
  it("shows the Google button on the sign-in page", async () => {
    const html = await (await SELF.fetch(`https://${HOST}/login`)).text();
    expect(html).toContain('href="/login/google"');
  });

  it("turns away an address that is not on the list, and writes nothing", async () => {
    const { res, exchanged } = await signIn({ email: "stranger@example.org" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not on the list");
    expect(sessionSet(res)).toBe(false);
    expect(await getIdentityByEmail(env.HUB_DB, "stranger@example.org")).toBeNull();
    expect(exchanged!.get("code_verifier")).toBeTruthy();
  });

  it("accepts an open root invite for the verified address and makes that person root", async () => {
    await createInvite(env.HUB_DB, { tenant_id: null, email: "owner@example.com", role: "root", display_name: "Owner", created_by: null }, Date.now());
    const { res } = await signIn({ email: "Owner@Example.com" });
    expect(res.status).toBe(303);
    expect(sessionSet(res)).toBe(true);
    const id = await getIdentityByEmail(env.HUB_DB, "owner@example.com");
    expect(id?.is_root).toBe(1);
    const proof = await env.HUB_DB.prepare("SELECT kind FROM proof WHERE identity_id = ?").bind(id!.id).first<{ kind: string }>();
    expect(proof?.kind).toBe("google");
  });

  it("admits a verified Workspace account on a listed domain and grants its project", async () => {
    const commons = await seedTenant("commons");
    await addRule("domain", "company.example", [{ tenant_id: commons.id, role: "member" }]);
    const { res } = await signIn({ email: "colleague@company.example", hd: "company.example", name: "A Colleague" }, { next: "commons" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://commons.${HOST}/`);
    const id = await getIdentityByEmail(env.HUB_DB, "colleague@company.example");
    expect(id?.display_name).toBe("A Colleague");
    expect((await getMembership(env.HUB_DB, id!.id, commons.id))?.role).toBe("member");
  });

  it("refuses a domain address without Google's hosted-domain claim", async () => {
    await addRule("domain", "company.example");
    const { res } = await signIn({ email: "someone@company.example" });
    expect(res.status).toBe(403);
    expect(await getIdentityByEmail(env.HUB_DB, "someone@company.example")).toBeNull();
  });

  it("refuses an address Google has not verified, even when listed", async () => {
    await addRule("email", "pat@example.net");
    const { res } = await signIn({ email: "pat@example.net", email_verified: false });
    expect(res.status).toBe(403);
    expect(await getIdentityByEmail(env.HUB_DB, "pat@example.net")).toBeNull();
  });

  it("gives an every-tenant admin grant on all tenants, and on tenants created later", async () => {
    const a = await seedTenant("north"), b = await seedTenant("south");
    await addRule("email", "deputy@example.com", [{ tenant_id: null, role: "admin" }]);
    const { res } = await signIn({ email: "deputy@example.com" });
    expect(res.status).toBe(303);
    const id = (await getIdentityByEmail(env.HUB_DB, "deputy@example.com"))!;
    expect((await getMembership(env.HUB_DB, id.id, a.id))?.role).toBe("admin");
    expect((await getMembership(env.HUB_DB, id.id, b.id))?.role).toBe("admin");
    expect(id.is_root).toBe(0);

    const root = await seedHuman("root@example.com", { is_root: true });
    const made = await apiPost(HOST, "tenant.create", { slug: "gamma", display_name: "Gamma" }, cookieHeaders(root.token, HOST));
    expect(made.status).toBe(200);
    const gamma = (await made.json() as { result: { tenant: { id: string } } }).result.tenant;
    expect((await getMembership(env.HUB_DB, id.id, gamma.id))?.role).toBe("admin");
  });

  it("raises but never lowers an existing membership", async () => {
    const t = await seedTenant("delta");
    const pre = await seedHuman("lead@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await addRule("email", "lead@example.com", [{ tenant_id: t.id, role: "reader" }]);
    const { res } = await signIn({ email: "lead@example.com" });
    expect(res.status).toBe(303);
    expect((await getMembership(env.HUB_DB, pre.identity.id, t.id))?.role).toBe("admin");
  });

  it("lets an existing person sign in with Google without any rule", async () => {
    await seedHuman("member@example.com");
    const { res } = await signIn({ email: "member@example.com" });
    expect(res.status).toBe(303);
    expect(sessionSet(res)).toBe(true);
  });

  it("refuses the same address from a different Google account", async () => {
    await seedHuman("held@example.com");
    expect((await signIn({ email: "held@example.com", sub: "first" })).res.status).toBe(303);
    const second = await signIn({ email: "held@example.com", sub: "second" });
    expect(second.res.status).toBe(403);
    expect(await second.res.text()).toContain("different Google account");
  });

  it("refuses a callback whose state does not match this browser", async () => {
    await seedHuman("x@example.com");
    expect((await signIn({ email: "x@example.com" }, { tamperState: true })).res.status).toBe(400);
    expect((await signIn({ email: "x@example.com" }, { noCookie: true })).res.status).toBe(400);
  });

  it("refuses to reuse a state", async () => {
    await seedHuman("y@example.com");
    const { res } = await signIn({ email: "y@example.com" });
    expect(res.status).toBe(303);
    // The state was deleted on first use; replaying the callback fails.
    const replay = await SELF.fetch(`https://${HOST}/login/google/callback?code=c0de&state=AAAAAAAAAAAAAAAAAAAAAAAA`, {
      redirect: "manual", headers: { cookie: "pmw_gstate=AAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    expect(replay.status).toBe(400);
  });
});

describe("the extra check", () => {
  const stale = (id: string) => env.HUB_DB.prepare("UPDATE session SET last_proof_at = 0 WHERE id = ?").bind(id).run();

  it("shows the check up front, confirms with Google in this session, and returns to the form", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await stale(pat.session.id);
    const h = cookieHeaders(pat.token, "acme.pimwell.test");
    const page = await (await SELF.fetch("https://acme.pimwell.test/people?connect=1&name=Build%20box", { headers: h })).text();
    expect(page).toContain("One extra check");
    expect(page).toContain("https://pimwell.test/login/google?reproof=1&amp;next=acme%2Fpeople%3Fconnect%3D1%26name%3DBuild%2520box");
    expect(page).not.toContain('action="/api/agent.connect"');

    const { res } = await signIn({ email: "pat@example.com" }, { session: pat.token, reproof: true, next: "acme/people?connect=1&name=Build%20box" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://acme.pimwell.test/people?connect=1&name=Build%20box");
    expect(sessionSet(res)).toBe(false);
    const after = await (await SELF.fetch("https://acme.pimwell.test/people?connect=1&name=Build%20box", { headers: h })).text();
    expect(after).toContain('action="/api/agent.connect"');
    expect(after).toContain('value="Build box"');
  });

  it("never switches who you are, and keeps root on email", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await seedHuman("kim@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const { res } = await signIn({ email: "kim@example.com" }, { session: pat.token, reproof: true, next: "acme/people?connect=1" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("different account");
    const root = await seedHuman("root@example.com", { is_root: true });
    const r = await SELF.fetch(`https://${HOST}/login/google?reproof=1`, { redirect: "manual", headers: { cookie: `pmw_session=${root.token}`, "cf-connecting-ip": "203.0.113.77" } });
    expect(r.status).toBe(403);
  });

  it("emails a link from the organization's page and comes straight back saying so", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await stale(pat.session.id);
    const post = (body: string, origin = "https://acme.pimwell.test") => SELF.fetch(`https://${HOST}/login`, { method: "POST", redirect: "manual",
      headers: { cookie: `pmw_session=${pat.token}`, origin, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" }, body });
    const r = await post("reproof=1&return=1&next=acme%2Fpeople%3Fconnect%3D1");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://acme.pimwell.test/people?connect=1&check=sent");
    const page = await (await SELF.fetch(r.headers.get("location")!, { headers: cookieHeaders(pat.token, "acme.pimwell.test") })).text();
    expect(page).toContain("A link is on its way");
    expect((await post("email=pat%40example.com")).status).toBe(403);
    expect((await post("reproof=1&return=1", "https://evil.example")).status).toBe(403);
  });
});

