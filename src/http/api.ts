import type { Env } from "../env";
import { buildContext, type Ctx } from "../auth/context";
import { checkAccess, checkScope } from "../verbs/dispatch";
import { clearSessionCookie } from "../auth/cookie";
import { HubError } from "../errors";
import { htmlResponse, page } from "../html";
import { getVerb } from "../verbs/table";

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

export async function handleApi(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const name = url.pathname.slice("/api/".length);
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
      const origin = request.headers.get("origin");
      const expected = `${url.protocol}//${url.host}`;
      if (origin !== expected) throw new HubError(403, "bad_origin");
    }

    checkAccess(ctx, verb);

    const params = verb.parse(body.input);
    const result = await verb.run(ctx, params);
    if (isForm && verb.renderForm) return finish(ctx, env, htmlResponse(page(verb.name, verb.renderForm(result))));
    if (isForm) {
      const self = `${url.protocol}//${url.host}`;
      let back = "/";
      const asked = body.input._back;
      if (typeof asked === "string" && /^\/[A-Za-z0-9/_.?=&-]*$/.test(asked) && !asked.startsWith("//")) {
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
      if (isForm && e.reason === "reproof_required") {
        const next = ctx?.tenant ? `&next=${ctx.tenant.slug}` : "";
        return finish(ctx, env, new Response(null, { status: 303, headers: { location: `https://${env.HUB_DOMAIN}/login?reproof=1${next}`, "cache-control": "no-store" } }));
      }
      return finish(ctx, env, json({ ok: false, error: e.reason, detail: e.detail ?? null, ...(e.data ? { data: e.data } : {}) }, e.status));
    }
    if (e instanceof SyntaxError) return finish(ctx, env, json({ ok: false, error: "bad_request", detail: "invalid JSON" }, 400));
    console.error("verb failed", name, e instanceof Error ? e.name : "error");
    return finish(ctx, env, json({ ok: false, error: "internal", detail: null }, 500));
  }
}
