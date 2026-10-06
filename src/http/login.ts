import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { classifyHost } from "../tenant";
import { buildContext } from "../auth/context";
import { clearSessionCookie, sessionCookie } from "../auth/cookie";
import { NEUTRAL_LOGIN_MESSAGE, cleanNext, consumeLink, openLink, requestLink } from "../auth/login";
import type { LinkPurpose } from "../db/types";
import { notFoundPage } from "./pages";

export function isApex(request: Request, env: Env): boolean {
  return classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN).kind === "apex";
}

export function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  return request.headers.get("origin") === `${url.protocol}//${url.host}`;
}

function authToken(request: Request): string | null {
  const m = new URL(request.url).pathname.match(/^\/auth\/([A-Za-z0-9_-]+)$/);
  return m ? m[1]! : null;
}

export function neutralLinkPage(): string {
  return page("Sign-in link", `<h1>This sign-in link is not valid</h1><p>It may have expired or been used already. <a href="/login">Ask for a new one</a>.</p>`);
}

function wrongBrowserPage(): string {
  return page("Confirm it's you", `<h1>Open this link where you asked for it</h1><p>This confirmation link only works in the browser that is signed in and asked for it. It has not been used.</p>`);
}

export async function authLinkPage(request: Request, env: Env): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  const token = authToken(request);
  const open = token ? await openLink(env, token, Date.now()) : null;
  if (!open) return htmlResponse(neutralLinkPage());
  const next = cleanNext(new URL(request.url).searchParams.get("next"));
  const action = `/auth/${token}` + (next ? `?next=${next}` : "");
  const reproof = open.link.purpose === "reproof";
  const heading = reproof ? "Confirm it's you" : "Sign in to Pimwell";
  const body = `<h1>${esc(heading)}</h1>
<p>Continue as <strong>${esc(open.identity.email)}</strong>.</p>
<form method="post" action="${esc(action)}"><button type="submit">${reproof ? "Confirm" : "Sign in"}</button></form>`;
  return htmlResponse(page(heading, body));
}

export async function consumeLinkPage(request: Request, env: Env): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  if (!sameOrigin(request)) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
  const now = Date.now();
  const ctx = await buildContext(request, env, now);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const token = authToken(request);
  if (!token) return htmlResponse(neutralLinkPage(), 200, extra);
  const r = await consumeLink(env, ctx, token, new URL(request.url).searchParams.get("next"), now);
  if (r.kind === "invalid") return htmlResponse(neutralLinkPage(), 200, extra);
  if (r.kind === "wrong_browser") return htmlResponse(wrongBrowserPage(), 200, extra);
  const headers = new Headers({ location: r.location, "cache-control": "no-store" });
  if (r.newToken) headers.append("set-cookie", sessionCookie(r.newToken, env.HUB_DOMAIN));
  else if (ctx.staleCookie) headers.append("set-cookie", clearSessionCookie(env.HUB_DOMAIN));
  return new Response(null, { status: 303, headers });
}

function nextInput(next: string | null): string {
  return next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";
}

function inboundHint(env: Env): string {
  return `<p>Or send any message to <strong>login@${esc(env.HUB_DOMAIN)}</strong> from your address. The reply carries a link. The hub only writes to addresses that have written to it first.</p>`;
}

function loginBody(env: Env, next: string | null, note: string): string {
  return `<h1>Sign in to Pimwell</h1>${note}
<form method="post" action="/login">
<label>Email <input type="email" name="email" required autocomplete="email" maxlength="254"></label>
${nextInput(next)}
<button type="submit">Email me a link</button>
</form>
${inboundHint(env)}`;
}

function reproofBody(env: Env, email: string, next: string | null): string {
  return `<h1>Confirm it's you</h1>
<p>This action needs a recent proof that you control <strong>${esc(email)}</strong>.</p>
<form method="post" action="/login">
<input type="hidden" name="reproof" value="1">
${nextInput(next)}
<button type="submit">Email me a confirmation link</button>
</form>
<p>If you have never written to the hub, send any message to <strong>login@${esc(env.HUB_DOMAIN)}</strong> from that address and open the link in the reply in this browser.</p>`;
}

export async function loginPage(request: Request, env: Env): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const url = new URL(request.url);
  const next = cleanNext(url.searchParams.get("next"));
  if (url.searchParams.get("reproof") === "1" && ctx.identity && ctx.session?.kind === "browser") {
    return htmlResponse(page("Confirm it's you", reproofBody(env, ctx.identity.email, next)), 200, extra);
  }
  const note = ctx.identity ? `<p>You are signed in as <strong>${esc(ctx.identity.email)}</strong>.</p>` : "";
  return htmlResponse(page("Sign in", loginBody(env, next, note)), 200, extra);
}

export async function loginPostPage(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  if (!sameOrigin(request)) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
  const now = Date.now();
  const ctx = await buildContext(request, env, now);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const form = await request.formData().catch(() => null);
  const field = (k: string): string => {
    const v = form?.get(k);
    return typeof v === "string" ? v : "";
  };
  const next = cleanNext(field("next"));
  const reproof = field("reproof") === "1";
  let email: string;
  let purpose: LinkPurpose;
  let session_id: string | null = null;
  if (reproof) {
    if (!ctx.identity || !ctx.session || ctx.session.kind !== "browser") return htmlResponse(page("Sign in", loginBody(env, next, "")), 200, extra);
    email = ctx.identity.email;
    purpose = "reproof";
    session_id = ctx.session.id;
  } else {
    email = field("email").slice(0, 254);
    purpose = "login";
  }
  // Off the response path when possible, so timing does not reveal known addresses.
  const work = requestLink(env, { email, purpose, ip: ctx.ip, next, session_id }, now)
    .catch((e) => console.log("login request failed", e instanceof Error ? e.name : "unknown"));
  if (waitUntil) waitUntil(work);
  else await work;
  const body = reproof
    ? `<h1>Check your email</h1><p>If ${esc(email)} has written to the hub before, a confirmation link is on its way. Open it in this browser within 15 minutes.</p><p>Otherwise, send any message to <strong>login@${esc(env.HUB_DOMAIN)}</strong> from that address and open the link in the reply here.</p>`
    : `<h1>Check your email</h1><p>${esc(NEUTRAL_LOGIN_MESSAGE)}</p>${inboundHint(env)}`;
  return htmlResponse(page("Check your email", body), 200, extra);
}
