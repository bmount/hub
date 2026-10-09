import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { classifyHost } from "../tenant";
import { buildContext } from "../auth/context";
import { clearSessionCookie, sessionCookie } from "../auth/cookie";
import { NEUTRAL_LOGIN_MESSAGE, cleanNext, consumeLink, landingUrl, openLink, requestLink } from "../auth/login";
import type { LinkPurpose } from "../db/types";
import { notFoundPage } from "./pages";
import { googleConfigured, googleReproofAllowed } from "./googleLogin";
import { HubError } from "../errors";
import { takeRateDetail } from "../rate";
import { MAX_AUTH_FORM_BODY_BYTES, readRequestForm } from "./body";

export function isApex(request: Request, env: Env): boolean {
  return classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN).kind === "apex";
}

/**
 * True when a state-changing request came from one of our own pages on this host. The one origin check for every
 * form and fetch. Browsers send `Origin: null` under some referrer policies (and the 2026-10-07 policy,
 * no-referrer, did exactly that, refusing every form). When the Origin header is null or absent, the browser's
 * own Fetch Metadata says where the request came from, and no page can forge it.
 */
export function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin === `${url.protocol}//${url.host}`) return true;
  return (origin === null || origin === "null") && request.headers.get("sec-fetch-site") === "same-origin";
}

function authToken(request: Request): string | null {
  const m = new URL(request.url).pathname.match(/^\/auth\/([A-Za-z0-9_-]{1,128})$/);
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
  const label = reproof ? (next && next.includes("/") ? "Confirm and go back" : "Confirm") : "Sign in";
  const body = `<h1>${esc(heading)}</h1>
<p>Continue as <strong>${esc(open.identity.email)}</strong>.</p>
<form method="post" action="${esc(action)}"><button type="submit">${esc(label)}</button></form>`;
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

function googleButton(env: Env, next: string | null): string {
  if (!googleConfigured(env)) return "";
  const href = "/login/google" + (next ? `?next=${encodeURIComponent(next)}` : "");
  return `<p><a class="google" href="${esc(href)}">Sign in with Google</a></p><p>Or get a link by email:</p>`;
}

function loginBody(env: Env, next: string | null, note: string): string {
  return `<h1>Sign in to Pimwell</h1>${note}
${googleButton(env, next)}
<form method="post" action="/login">
<label>Email <input type="email" name="email" required autocomplete="email" maxlength="254"></label>
${nextInput(next)}
<button type="submit">Email me a link</button>
</form>
${inboundHint(env)}`;
}

function reproofBody(env: Env, identity: { email: string; is_root: number }, next: string | null): string {
  const google = googleConfigured(env) && googleReproofAllowed(identity);
  return `<h1>One extra check</h1>
<p>This acts for you, so we confirm it's really you, <strong>${esc(identity.email)}</strong>. It takes a few seconds, and then you're back where you were.</p>
${google ? `<p><a class="button" href="/login/google?reproof=1${next ? `&amp;next=${esc(encodeURIComponent(next))}` : ""}">Continue with Google</a></p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="reproof" value="1">
${nextInput(next)}
<button type="submit"${google ? ' class="quiet"' : ""}>${google ? "Email me a link instead" : "Email me a confirmation link"}</button>
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
    return htmlResponse(page("One extra check", reproofBody(env, ctx.identity, next)), 200, extra);
  }
  const note = ctx.identity ? `<p>You are signed in as <strong>${esc(ctx.identity.email)}</strong>.</p>` : "";
  return htmlResponse(page("Sign in", loginBody(env, next, note)), 200, extra);
}

/** A form on one of this hub's organization pages (same site, our own pages). Used only for the extra check's email. */
function fromHubPage(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin") ?? "";
  const hub = env.HUB_DOMAIN.toLowerCase();
  return /^https:\/\/[a-z0-9-]+\./.test(origin) && origin.toLowerCase().endsWith(`.${hub}`) && origin.slice(8).split(".").length === hub.split(".").length + 1;
}

export async function loginPostPage(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  const crossPage = !sameOrigin(request) && fromHubPage(request, env);
  if (!sameOrigin(request) && !crossPage) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
  const now = Date.now();
  const rate = await takeRateDetail(env.RATE, "login_form_ip", request.headers.get("cf-connecting-ip") ?? "unknown", now);
  if (!rate.ok) return htmlResponse(page("Too many requests", "<h1>Too many requests</h1><p>Please try again later.</p>"), 429, { "retry-after": String(rate.retryAfterS) });
  const ctx = await buildContext(request, env, now);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  let form: FormData | null;
  try { form = await readRequestForm(request, MAX_AUTH_FORM_BODY_BYTES); }
  catch (e) {
    if (e instanceof HubError) return htmlResponse(page("Invalid request", `<h1>Invalid request</h1><p>${esc(e.detail ?? "Request body could not be read.")}</p>`), e.status, extra);
    throw e;
  }
  const field = (k: string): string => {
    const v = form?.get(k);
    return typeof v === "string" ? v : "";
  };
  const next = cleanNext(field("next"));
  const reproof = field("reproof") === "1";
  if (crossPage && !reproof) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
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
  // From the extra check on an organization's page: straight back there, which now says the link is on its way.
  if (reproof && field("return") === "1" && ctx.identity) {
    const back = await landingUrl(env, ctx.identity, next);
    return new Response(null, { status: 303, headers: { location: `${back}${back.includes("?") ? "&" : "?"}check=sent`, "cache-control": "no-store", ...extra } });
  }
  const body = reproof
    ? `<h1>Check your email</h1><p>If ${esc(email)} has written to the hub before, a confirmation link is on its way. Open it in this browser within 15 minutes.</p><p>Otherwise, send any message to <strong>login@${esc(env.HUB_DOMAIN)}</strong> from that address and open the link in the reply here.</p>`
    : `<h1>Check your email</h1><p>${esc(NEUTRAL_LOGIN_MESSAGE)}</p>${inboundHint(env)}`;
  return htmlResponse(page("Check your email", body), 200, extra);
}
