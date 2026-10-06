import type { Env } from "../env";
import { classifyHost } from "../tenant";
import { getTenantBySlug } from "../db/tenants";
import { notFoundPage } from "./pages";

/**
 * Git smart HTTP for one top-level repository, on the raw (undecoded) path (integration spec 3). Nested
 * `<namespace>/<repo>.git` waits until Ardi serves nested names; `.git` is required so no hub page is captured.
 */
const GIT_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

export function isGitPath(pathname: string): boolean {
  return GIT_PATH.test(pathname);
}

/**
 * Ardi's response to a git request on an active tenant host, the hub's 404 for an unknown or archived tenant,
 * or null when the hub serves the request itself. The hub does no git auth; Ardi challenges.
 */
export async function forwardGit(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isGitPath(url.pathname)) return null;
  const host = classifyHost(request.headers.get("host") ?? url.host, env.HUB_DOMAIN);
  if (host.kind !== "tenant") return null;
  const tenant = await getTenantBySlug(env.HUB_DB, host.slug);
  if (!tenant || tenant.state !== "active") return notFoundPage();
  if (!env.ARDI) return new Response("git service unavailable\n", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  // The original request, except the hub-wide session cookie, which Ardi never needs.
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return env.ARDI.fetch(new Request(request, { headers }));
}
