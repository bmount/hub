// Sign in with Google: authorization code flow with PKCE, state bound to the browser, and a nonce
// bound to the ID token (identity spec, Google amendment).
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { buildContext } from "../auth/context";
import { sessionCookie } from "../auth/cookie";
import { cleanNext, landingUrl } from "../auth/login";
import { admitGoogle } from "../auth/googleAdmit";
import { googleJwks, pkceChallenge, randomToken, TokenError, verifyGoogleIdToken } from "../auth/googleToken";
import { createBrowserSession, setLastProof } from "../db/sessions";
import { recordProof } from "../db/proofs";
import { recordEvent } from "../db/events";
import { takeRate } from "../rate";
import { isApex } from "./login";
import { notFoundPage } from "./pages";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "pmw_gstate";
const STATE_TTL_S = 600;

// Outbound calls to Google go through this, so tests can stand in for Google.
let googleFetch: typeof fetch = (input, init) => fetch(input, init);
export function setGoogleFetchForTest(f: typeof fetch | null): void {
  googleFetch = f ?? ((input, init) => fetch(input, init));
}

/** Regular people may confirm with Google; the hub's root confirms by email (owner, 2026-10-08). */
export function googleReproofAllowed(identity: { is_root: number }): boolean {
  return identity.is_root !== 1;
}

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(env: Env): string {
  return `https://${env.HUB_DOMAIN}/login/google/callback`;
}

function stateCookie(value: string, maxAge: number): string {
  return `${STATE_COOKIE}=${value}; Path=/login/google; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function readStateCookie(request: Request): string | null {
  const m = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)pmw_gstate=([A-Za-z0-9_-]{20,100})/);
  return m ? m[1]! : null;
}

/** `reproof`: an extra check for someone already signed in here; it refreshes their session and never switches who they are. */
type Pending = { nonce: string; verifier: string; next: string | null; reproof?: { identity_id: string; session_id: string } };

function problem(title: string, text: string, status = 200, clearState = true): Response {
  const body = `<h1>${esc(title)}</h1><p>${text}</p><p><a href="/login">Back to sign in</a></p>`;
  return htmlResponse(page(title, body), status, clearState ? { "set-cookie": stateCookie("", 0) } : {});
}

export async function googleStartPage(request: Request, env: Env): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  if (!googleConfigured(env)) return problem("Google sign-in is not set up yet", "Use your email address to sign in for now.", 503, false);
  const ctx = await buildContext(request, env);
  if (!(await takeRate(env.RATE, "ip", ctx.ip, Date.now()))) return problem("Too many attempts", "Wait a minute and try again.", 429, false);
  const state = randomToken(), nonce = randomToken(), verifier = randomToken(48);
  const pending: Pending = { nonce, verifier, next: cleanNext(new URL(request.url).searchParams.get("next")) };
  let hint: string | null = null;
  if (new URL(request.url).searchParams.get("reproof") === "1") {
    if (!ctx.identity || ctx.identity.kind !== "human" || ctx.session?.kind !== "browser") return problem("Sign in first", "The extra check is for someone already signed in.", 400, false);
    if (!googleReproofAllowed(ctx.identity)) return problem("Confirm by email", "The hub's root account confirms with an emailed link.", 403, false);
    pending.reproof = { identity_id: ctx.identity.id, session_id: ctx.session.id };
    hint = ctx.identity.email;
  }
  await env.OAUTH_KV.put(`google:${state}`, JSON.stringify(pending), { expirationTtl: STATE_TTL_S });
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(env), response_type: "code", scope: "openid email profile",
    state, nonce, code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", prompt: "select_account",
  });
  if (hint) q.set("login_hint", hint);
  return new Response(null, {
    status: 302,
    headers: { location: `${AUTH_URL}?${q}`, "set-cookie": stateCookie(state, STATE_TTL_S), "cache-control": "no-store" },
  });
}

const REFUSALS: Record<string, [string, string]> = {
  not_listed: ["This Google account is not on the list yet",
    "Pimwell is invite-only for now. If someone is expecting you, ask them for an invite, or sign in with the address they invited."],
  unverified: ["Google has not verified this email address", "Verify the address with Google, then try again."],
  unavailable: ["This account cannot sign in", "Ask whoever invited you to Pimwell."],
  other_google_account: ["That address is linked to a different Google account",
    "Sign in with the Google account you used before, or use your email address to sign in."],
};

export async function googleCallbackPage(request: Request, env: Env): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  if (!googleConfigured(env)) return problem("Google sign-in is not set up yet", "Use your email address to sign in for now.", 503);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const cookieState = readStateCookie(request);
  // The state must come back to the same browser that started the sign-in, and only once.
  if (!state || !cookieState || state !== cookieState) return problem("That sign-in did not start here", "Start again from the sign-in page.", 400);
  const raw = await env.OAUTH_KV.get(`google:${state}`);
  await env.OAUTH_KV.delete(`google:${state}`);
  if (!raw) return problem("That sign-in expired", "Start again from the sign-in page.", 400);
  const pending = JSON.parse(raw) as Pending;
  if (url.searchParams.get("error")) return problem("Google sign-in was cancelled", "Nothing was changed.");
  const code = url.searchParams.get("code");
  if (!code) return problem("Google did not send a sign-in code", "Start again from the sign-in page.", 400);

  let claims;
  try {
    const res = await googleFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri(env),
        grant_type: "authorization_code", code_verifier: pending.verifier,
      }),
    });
    if (!res.ok) throw new TokenError(`token exchange failed (${res.status})`);
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new TokenError("no id_token");
    claims = await verifyGoogleIdToken(body.id_token, { clientId: env.GOOGLE_CLIENT_ID!, nonce: pending.nonce, keys: googleJwks(googleFetch) });
  } catch (e) {
    console.log("google sign-in failed", e instanceof TokenError ? e.message : e instanceof Error ? e.name : "unknown");
    return problem("Google sign-in did not complete", "Start again from the sign-in page.", 400);
  }

  const now = Date.now();
  const admitted = await admitGoogle(env.HUB_DB, claims, now, env.HUB_DOMAIN);
  if (!admitted.ok) {
    await recordEvent(env.HUB_DB, {
      tenant_id: null, identity_id: null, session_id: null, kind: "login.google.refused", target_kind: "google_account",
      target_id: claims.sub, summary: `Google sign-in refused (${admitted.reason})`,
    }, now);
    const [title, text] = REFUSALS[admitted.reason]!;
    return problem(title, esc(text), 403);
  }
  const { identity } = admitted;
  if (pending.reproof) {
    // The extra check confirms the person already here, in this browser's session; nobody else.
    const here = await buildContext(request, env, now);
    if (identity.id !== pending.reproof.identity_id) {
      return problem("That's a different account", `That Google account is ${esc(claims.email)}. You're signed in here as ${esc(here.identity?.email ?? "someone else")}: choose that account, or confirm by email.`, 403);
    }
    if (here.session?.id !== pending.reproof.session_id) return problem("That check started in another sign-in", "Start the check again from the page you were on.", 400);
    await recordProof(env.HUB_DB, { identity_id: identity.id, kind: "google", subject: claims.email }, now);
    await setLastProof(env.HUB_DB, here.session.id, now);
    await recordEvent(env.HUB_DB, { tenant_id: null, identity_id: identity.id, session_id: here.session.id, kind: "login.reproof", target_kind: "identity", target_id: identity.id, summary: "Confirmed with Google (extra check)" }, now);
    const h = new Headers({ location: await landingUrl(env, identity, pending.next), "cache-control": "no-store" });
    h.append("set-cookie", stateCookie("", 0));
    return new Response(null, { status: 303, headers: h });
  }
  await recordProof(env.HUB_DB, { identity_id: identity.id, kind: "google", subject: claims.email }, now);
  const { session, token } = await createBrowserSession(env.HUB_DB, identity.id, now);
  const extra = [
    admitted.created ? "new account" : null,
    admitted.invitesAccepted ? `${admitted.invitesAccepted} invite(s) accepted` : null,
    admitted.grantsApplied ? `${admitted.grantsApplied} membership(s) granted` : null,
  ].filter(Boolean).join(", ");
  await recordEvent(env.HUB_DB, {
    tenant_id: null, identity_id: identity.id, session_id: session.id, kind: "login.google", target_kind: "identity",
    target_id: identity.id, summary: `Signed in with Google${extra ? ` (${extra})` : ""}`,
  }, now);
  const headers = new Headers({ location: await landingUrl(env, identity, pending.next), "cache-control": "no-store" });
  headers.append("set-cookie", sessionCookie(token, env.HUB_DOMAIN));
  headers.append("set-cookie", stateCookie("", 0));
  return new Response(null, { status: 303, headers });
}
