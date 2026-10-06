import type { Env } from "../env";
import { authServer, issuer } from "../oauth/config";
import { loadRedirectPatterns, matchRedirect } from "../oauth/redirects";
import { recordEvent } from "../db/events";
import { takeRateDetail } from "../rate";
import { isApex } from "./login";
import { oauthJson } from "./oauthMeta";
import { notFoundPage } from "./pages";

const REGISTER_BODY_MAX = 8 * 1024;
const tooLarge = () => oauthJson({ error: "invalid_client_metadata", error_description: "registration body is larger than 8 KB" }, 413);

/**
 * RFC 7591 registration (MCP spec 6). The hub checks policy before the library sees the request:
 * rate limits, public clients only, and every redirect URI on the allowlist.
 */
export async function registerEndpoint(request: Request, env: Env, ectx: ExecutionContext, now: number = Date.now()): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  for (const [bucket, subject] of [["oauth_register_ip", ip], ["oauth_register_all", "all"]] as const) {
    const r = await takeRateDetail(env.RATE, bucket, subject, now);
    if (!r.ok) return oauthJson({ error: "too_many_requests" }, 429, { "retry-after": String(r.retryAfterS) });
  }
  if (Number(request.headers.get("content-length") ?? "0") > REGISTER_BODY_MAX) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > REGISTER_BODY_MAX) return tooLarge();
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    meta = parsed as Record<string, unknown>;
  } catch {
    return oauthJson({ error: "invalid_client_metadata", error_description: "body must be a JSON object" }, 400);
  }
  if (meta.token_endpoint_auth_method !== "none") {
    return oauthJson({ error: "invalid_client_metadata", error_description: "only public clients (token_endpoint_auth_method none) may register" }, 400);
  }
  const uris = meta.redirect_uris;
  const patterns = await loadRedirectPatterns(env.HUB_DB);
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && matchRedirect(patterns, u) !== null)) {
    return oauthJson({ error: "invalid_redirect_uri", error_description: "every redirect_uri must be an allowed assistant callback" }, 400);
  }
  const forwarded = new Request(`${issuer(env)}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: text });
  const res = await authServer(env, null).fetch(forwarded, env, ectx);
  if (res.status === 201) {
    const body = (await res.clone().json()) as { client_id?: string; client_name?: string };
    await recordEvent(env.HUB_DB, {
      tenant_id: null, identity_id: null, session_id: null, kind: "oauth.client.register", target_kind: "oauth_client",
      target_id: body.client_id ?? "unknown", summary: `Registered "${(body.client_name ?? "unnamed").slice(0, 80)}"`,
    }, now);
  }
  return res;
}
