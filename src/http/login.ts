import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { classifyHost } from "../tenant";
import { buildContext } from "../auth/context";
import { clearSessionCookie, sessionCookie } from "../auth/cookie";
import { cleanNext, consumeLink, openLink } from "../auth/login";
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
