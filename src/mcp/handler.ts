import type { Env } from "../env";
import { classifyHost } from "../tenant";
import { takeRateDetail } from "../rate";
import { bearerChallenge, oauthJson } from "../http/oauthMeta";
import { notFoundPage } from "../http/pages";

/** DNS-rebinding and browser-CSRF defense (MCP spec 8.7): only these browser origins, or none. */
const ALLOWED_ORIGINS = new Set(["https://claude.ai", "https://chatgpt.com"]);

export async function handleMcp(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  const host = classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN);
  if (host.kind !== "tenant") return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin !== null && !ALLOWED_ORIGINS.has(origin)) return oauthJson({ error: "forbidden_origin" }, 403);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    const r = await takeRateDetail(env.RATE, "mcp_anon_ip", ip, now);
    if (!r.ok) return oauthJson({ error: "too_many_requests" }, 429, { "retry-after": String(r.retryAfterS) });
    return bearerChallenge(env, host.slug, null);
  }
  // Every token is refused until token validation lands with the tool server.
  return bearerChallenge(env, host.slug, "invalid_token");
}
