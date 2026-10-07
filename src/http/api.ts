import { sameOrigin } from "./login";
import type { Env } from "../env";
import { buildContext, type Ctx } from "../auth/context";
import { checkAccess, checkScope } from "../verbs/dispatch";
import { clearSessionCookie } from "../auth/cookie";
import { HubError } from "../errors";
import { htmlResponse, page } from "../html";
import { getVerb } from "../verbs/table";
import { note } from "../log";
import { recordEvent } from "../db/events";
import { esc } from "../html";

async function readBody(request: Request): Promise<{ input: Record<string, unknown>; isForm: boolean }> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.startsWith("application/x-www-form-urlencoded") || ct.startsWith("multipart/form-data")) {
    const fd = await request.formData();
    const input: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) input[k] = typeof v === "string" ? v : "";
    return { input, isForm: true };
  }
  if (ct.startsWith("application/json")) {
    const text = await request.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HubError(400, "bad_request", "body must be a JSON object");
    return { input: parsed as Record<string, unknown>, isForm: false };
  }
  return { input: {}, isForm: false };
}

function finish(ctx: Ctx | null, env: Env, res: Response): Response {
  if (ctx?.staleCookie) res.headers.append("set-cookie", clearSessionCookie(env.HUB_DOMAIN));
  return res;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const REASONS: Record<string, string> = {
  forbidden: "You don't have permission to do that here.",
  not_found: "That doesn't exist, or you can't see it.",
  bad_origin: "The form came from another site, so it was refused. Reload the page and try again.",
  bad_request: "Something in the form isn't right.",
  conflict: "That clashes with the current state.",
  rate_limited: "Too many tries. Wait a minute and try again.",
  unauthorized: "Sign in first.",
};

/** The Ray ID, so a person can point at the exact log line (docs/ops/logging.md). */
const reference = (request: Request) => { const ray = request.headers.get("cf-ray"); return ray ? `<p><small>Reference: <code>${esc(ray)}</code></small></p>` : ""; };

/** A readable page for a refused form, instead of raw JSON. */
function formError(e: HubError, request: Request): string {
  const back = request.headers.get("referer");
  const self = new URL(request.url).origin;
  const href = back && back.startsWith(self + "/") ? esc(back) : "/";
  return `<h1>Not done</h1><p class="lede">${esc(REASONS[e.reason] ?? "That was refused.")}</p>${e.detail ? `<p>${esc(e.detail)}</p>` : ""}<p><a href="${href}">Go back</a></p>${reference(request)}`;
}

/** Refusals of sensitive actions go in the audit trail with who tried, so they can be reconstructed later. */
async function auditRefusal(ctx: Ctx | null, name: string, e: HubError): Promise<void> {
  const verb = getVerb(name);
  if (!ctx?.identity || !verb || verb.kind !== "command") return;
  if (verb.freshProofMinutes === null && verb.minRole !== "admin" && verb.minRole !== "root") return;
  try {
    await recordEvent(ctx.db, {
      tenant_id: ctx.tenant?.id ?? null, identity_id: ctx.identity.id, session_id: ctx.session?.id ?? null, kind: "verb.refused",
      target_kind: "verb", target_id: name, summary: `${name} refused: ${e.reason}${e.detail ? ` (${e.detail.slice(0, 200)})` : ""}`,
    }, ctx.now);
  } catch (err) {
    console.error(JSON.stringify({ msg: "audit failed", verb: name, error: err instanceof Error ? err.name : "error" }));
  }
}

export async function handleApi(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const name = url.pathname.slice("/api/".length);
  note(request, { verb: name.slice(0, 64), via: "api" });
  let ctx: Ctx | null = null;
  let isForm = false;
  try {
    const body = await readBody(request);
    isForm = body.isForm;
    if (isForm && name === "login.verify") throw new HubError(400, "bad_request", "login.verify does not accept form bodies");
    const verb = getVerb(name);
    if (!verb) throw new HubError(404, "unknown_verb");
    ctx = await buildContext(request, env, Date.now(), waitUntil, { longLivedToken: true });

    if (ctx.host.kind === "unknown") throw new HubError(404, "not_found");
    checkScope(ctx, verb);

    if (ctx.authKind === "cookie") {
      if (!sameOrigin(request)) throw new HubError(403, "bad_origin");
    }

    checkAccess(ctx, verb);

    const params = verb.parse(body.input);
    const result = await verb.run(ctx, params);
    if (isForm && verb.renderForm) return finish(ctx, env, htmlResponse(page(verb.name, verb.renderForm(result))));
    if (isForm) {
      const self = `${url.protocol}//${url.host}`;
      let back = "/";
      const asked = body.input._back;
      const fromResult = asked === "@result" && verb.formBack ? verb.formBack(result) : null;
      if (fromResult && /^\/[A-Za-z0-9/_.?=&%-]*$/.test(fromResult) && !fromResult.startsWith("//")) {
        back = fromResult;
      } else if (typeof asked === "string" && /^\/[A-Za-z0-9/_.?=&%-]*$/.test(asked) && !asked.startsWith("//")) {
        back = asked;
      } else {
        try {
          const ref = request.headers.get("referer");
          if (ref) {
            const r = new URL(ref);
            if (r.origin === self) back = ref;
          }
        } catch { /* malformed referer: fall back to / */ }
      }
      return finish(ctx, env, new Response(null, { status: 303, headers: { location: back, "cache-control": "no-store" } }));
    }
    return finish(ctx, env, json({ ok: true, result }, 200));
  } catch (e) {
    if (e instanceof HubError) {
      note(request, { error: { reason: e.reason, detail: e.detail ?? null } });
      await auditRefusal(ctx, name, e);
      if (isForm && e.reason === "reproof_required") {
        const next = ctx?.tenant ? `&next=${ctx.tenant.slug}` : "";
        return finish(ctx, env, new Response(null, { status: 303, headers: { location: `https://${env.HUB_DOMAIN}/login?reproof=1${next}`, "cache-control": "no-store" } }));
      }
      if (isForm) return finish(ctx, env, htmlResponse(page("Not done", formError(e, request)), e.status));
      return finish(ctx, env, json({ ok: false, error: e.reason, detail: e.detail ?? null, ...(e.data ? { data: e.data } : {}) }, e.status));
    }
    if (e instanceof SyntaxError) return finish(ctx, env, json({ ok: false, error: "bad_request", detail: "invalid JSON" }, 400));
    note(request, { error: { reason: "internal", detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } });
    console.error(JSON.stringify({ msg: "verb failed", verb: name, ray: request.headers.get("cf-ray"), stack: e instanceof Error ? e.stack ?? null : null }));
    if (isForm) return finish(ctx, env, htmlResponse(page("Not done", `<h1>That didn't work</h1><p>Something went wrong on our side, and it is in the log. Nothing was changed.</p><p><a href="javascript:history.back()">Go back</a></p>${reference(request)}`), 500));
    return finish(ctx, env, json({ ok: false, error: "internal", detail: null }, 500));
  }
}
