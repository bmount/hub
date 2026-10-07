import { AuthorizationError, authorizationErrorRedirect, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { HubError } from "../errors";
import { timingSafeEqual } from "../ids";
import { buildContext, roleFor } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { getTenantBySlug } from "../db/tenants";
import { getMembership } from "../db/memberships";
import { recordEvent } from "../db/events";
import { takeRateDetail } from "../rate";
import { CONSENT_FRESH_PROOF_MINUTES, OAUTH_SCOPES, authServer, tenantOfResource } from "../oauth/config";
import { redirectAllowed } from "../oauth/redirects";
import { PENDING_ID, bindPending, createPending, deletePending, loadPending, type Pending } from "../oauth/pending";
import { exposedVerbs, toolName } from "../mcp/policy";
import { runVerb } from "../verbs/dispatch";
import { getVerb } from "../verbs/table";
import type { Identity, Role, Tenant } from "../db/types";
import { isApex, sameOrigin } from "./login";
import { notFoundPage } from "./pages";

const SCOPE_TEXT: Record<string, (tenant: string) => string> = {
  read: (t) => `See projects, work, mail, conversations, and activity in ${t}.`,
  write: (t) => `Act for you in ${t}: file and update work, post in conversations, and create projects. Nothing it does is hidden: every action is recorded under this connection.`,
};

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { ...headers, location, "cache-control": "no-store" } });
}

/** Errors before the redirect URI is trusted render here and never redirect (MCP spec 6.2). */
function errorPage(status: number, heading: string, detail: string, headers: Record<string, string> = {}): Response {
  return htmlResponse(page(heading, `<h1>${esc(heading)}</h1><p>${esc(detail)}</p>`), status, headers);
}

/** The same page for unknown, archived, and not-yours, and for requests that expired or belong to another session (MCP spec 4.3). */
function neutralPage(headers: Record<string, string> = {}): Response {
  return errorPage(200, "You do not have access to this workspace", "This connection request cannot continue here. Start again from your assistant.", headers);
}

/** `state` is echoed to the client and kept with the pending request; a client has no use for more than this. */
const STATE_MAX = 1024;

export async function authorizePage(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  const rate = await takeRateDetail(env.RATE, "oauth_authorize_ip", request.headers.get("cf-connecting-ip") ?? "unknown", now);
  if (!rate.ok) return errorPage(429, "Too many requests", "Wait a little and try again.", { "retry-after": String(rate.retryAfterS) });
  const url = new URL(request.url);
  if ((url.searchParams.get("state") ?? "").length > STATE_MAX) return errorPage(400, "This request is not valid", "The state value is too long.");
  const allowed = await redirectAllowed(env.HUB_DB, url.searchParams.get("redirect_uri") ?? "");
  if (!allowed) return errorPage(400, "This app cannot connect", "Its return address is not one of the assistants Pimwell accepts.");
  const api = authServer(env, url.searchParams.get("resource")).getOAuthApi(env);
  let req: AuthRequest;
  try {
    req = await api.parseAuthRequest(request);
  } catch (e) {
    if (e instanceof AuthorizationError) return e.redirectTo ? redirect(e.redirectTo) : errorPage(400, "This request is not valid", e.description);
    throw e;
  }
  const slug = tenantOfResource(env, req.resource);
  if (!slug) return redirect(authorizationErrorRedirect(req, "invalid_target", "resource must be https://<tenant>.<hub>/mcp"));
  if (req.codeChallengeMethod !== "S256" || !req.codeChallenge) return redirect(authorizationErrorRedirect(req, "invalid_request", "PKCE with S256 is required"));
  // MCP spec 8.1: choosing write grants read and write together.
  const asked = req.scope.length === 0 ? ["read"] : req.scope;
  const scopes = asked.includes("write") && !asked.includes("read") ? ["read", ...asked] : asked;
  if (scopes.some((s) => !OAUTH_SCOPES.includes(s))) return redirect(authorizationErrorRedirect(req, "invalid_scope", `available scopes: ${OAUTH_SCOPES.join(" ")}`));
  const client = await api.lookupClient(req.clientId);
  if (!client) return errorPage(400, "This app cannot connect", "It is not registered.");
  const pending = await createPending(env, {
    request: req, client_id: client.clientId, client_name: (client.clientName ?? client.clientId).slice(0, 80),
    redirect_host: allowed.host, redirect_label: allowed.label, loopback: allowed.loopback, tenant_slug: slug, scopes: [...new Set(scopes)],
  }, now);
  return redirect(`/oauth/consent/${pending.id}`);
}

function pendingIdFrom(request: Request): string | null {
  const m = /^\/oauth\/consent\/([^/]+)$/.exec(new URL(request.url).pathname);
  return m && PENDING_ID.test(m[1]!) ? m[1]! : null;
}

function consentBody(env: Env, p: Pending, identity: Identity, tenant: Tenant, role: Role): string {
  const shown = p.loopback ? new URL(p.request.redirectUri).host : p.redirect_host;
  const toolsOf = (s: string) => exposedVerbs(role, p.scopes).filter((v) => v.mcp!.scope === s).map((v) => `<li><code>${esc(toolName(v.name))}</code> ${esc(v.mcp!.title)}</li>`).join("");
  const scopes = p.scopes.map((s) => `<li>${esc(SCOPE_TEXT[s]?.(tenant.display_name) ?? s)} <details><summary>Tools</summary><ul>${toolsOf(s) || "<li>None at your role.</li>"}</ul></details></li>`).join("");
  const form = (decision: "approve" | "deny", label: string) =>
    `<form class="inline" method="post" action="/oauth/consent/${esc(p.id)}"><input type="hidden" name="form_token" value="${esc(p.form_token!)}">`
    + `<input type="hidden" name="decision" value="${decision}"><button type="submit">${label}</button></form>`;
  return `<h1>Allow an assistant to act as you in <strong>${esc(tenant.display_name)}</strong> (<code>${esc(tenant.slug)}.${esc(env.HUB_DOMAIN)}</code>)</h1>
<p>Access codes will be sent to</p>
<p style="font:600 2rem/1.2 ui-monospace,monospace;margin:.25rem 0">${esc(shown)}</p>
<p>${esc(p.redirect_label)}</p>
${p.loopback ? `<p role="alert"><strong>This connects a program on your own computer.</strong> Approve only if you started this from a terminal in the last few minutes.</p>` : ""}
<p>The app calls itself "${esc(p.client_name)}" (name supplied by the app).</p>
<p>Signed in as <strong>${esc(identity.display_name)}</strong> &lt;${esc(identity.email)}&gt;. Not you? <form class="inline" method="post" action="/api/session.end"><button type="submit">Sign out</button></form></p>
<h2>It will be able to</h2>
<ul>${scopes}</ul>
<p>Access lasts up to 90 days. Revoke any time at <a href="/me">${esc(env.HUB_DOMAIN)}/me</a>.</p>
<p>${form("approve", "Approve")} ${form("deny", "Deny")}</p>`;
}

export async function consentPage(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  const ctx = await buildContext(request, env, now);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const id = pendingIdFrom(request);
  const pending = id ? await loadPending(env, id, now) : null;
  if (!id || !pending) return neutralPage(extra);
  const next = encodeURIComponent(`/oauth/consent/${id}`);
  if (!ctx.identity || !ctx.session || ctx.session.kind !== "browser") return redirect(`/login?next=${next}`, extra);
  if (now - ctx.session.last_proof_at > CONSENT_FRESH_PROOF_MINUTES * 60_000) return redirect(`/login?reproof=1&next=${next}`, extra);
  const bound = await bindPending(env, pending, ctx.session.id, now);
  if (!bound) return neutralPage(extra);
  const tenant = await getTenantBySlug(ctx.db, bound.tenant_slug);
  const role = tenant && tenant.state === "active" ? roleFor(ctx.identity, await getMembership(ctx.db, ctx.identity.id, tenant.id)) : null;
  if (!tenant || role === null) return neutralPage(extra);
  const res = htmlResponse(page("Connect an assistant", consentBody(env, bound, ctx.identity, tenant, role)), 200, extra);
  // Chromium applies form-action to the redirect that follows a form post, so the client's origin must be allowed too.
  res.headers.set("content-security-policy",
    `default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${new URL(bound.request.redirectUri).origin}`);
  return res;
}

export async function consentPost(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void, now: number = Date.now()): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  if (!sameOrigin(request)) return errorPage(403, "Forbidden", "This form must be sent from the Pimwell page that showed it.");
  const ctx = await buildContext(request, env, now, waitUntil);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const id = pendingIdFrom(request);
  const form = await request.formData().catch(() => null);
  const field = (k: string): string => {
    const v = form?.get(k);
    return typeof v === "string" ? v : "";
  };
  const formToken = field("form_token");
  if (!id || !ctx.identity || !ctx.session || ctx.session.kind !== "browser" || !formToken) return neutralPage(extra);
  if (field("decision") === "deny") {
    const p = await loadPending(env, id, now);
    if (!p || p.session_id !== ctx.session.id || !p.form_token || !timingSafeEqual(p.form_token, formToken)) return neutralPage(extra);
    await deletePending(env, id);
    await recordEvent(ctx.db, {
      tenant_id: null, identity_id: ctx.identity.id, session_id: ctx.session.id, kind: "oauth.grant.deny", target_kind: "oauth_client",
      target_id: p.client_id, summary: `Denied "${p.client_name}" for ${p.tenant_slug}`,
    }, now);
    return redirect(authorizationErrorRedirect(p.request, "access_denied"), extra);
  }
  if (field("decision") !== "approve") return neutralPage(extra);
  try {
    const result = (await runVerb(ctx, getVerb("oauth.grant.approve")!, { pending_id: id, form_token: formToken })) as { redirect_to: string };
    return redirect(result.redirect_to, extra);
  } catch (e) {
    if (e instanceof HubError && e.reason === "reproof_required") return redirect(`/login?reproof=1&next=${encodeURIComponent(`/oauth/consent/${id}`)}`, extra);
    if (e instanceof HubError) return neutralPage(extra);
    throw e;
  }
}
