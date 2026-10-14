import { traceFields } from "../perf";
import type { Env } from "../env";
import { classifyHost } from "../tenant";
import { getTenantBySlug } from "../db/tenants";
import { notFoundPage } from "./pages";
import { GIT_PATH, artifactGit } from "./artifactGit";
import { usesArtifacts } from "../code/gitBackend";

/**
 * Git smart HTTP for default and named repositories, on the raw (undecoded) path.
 * `.git` is required so no hub page is captured; named repositories only route to Artifacts.
 */

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
  // The Git service independently checks the live tenant and caller. Overlap its
  // work with the hub's routing/tracing lookup, but gate every returned response
  // on this lookup too; an inactive tenant must not inherit a proxy response.
  const [tenant, forwarded] = await Promise.all([
    getTenantBySlug(env.HUB_DB, host.slug),
    env.GIT_PROXY ? Promise.resolve().then(() => env.GIT_PROXY!.fetch(request)).then(response => ({ response }), error => ({ error })) : undefined,
  ]);
  if (!tenant || tenant.state !== "active") {
    if (forwarded && "response" in forwarded) await forwarded.response.body?.cancel().catch(() => {});
    return notFoundPage();
  }
  traceFields({ tenant: tenant.id, auth: "git", route: "/:repo.git/*" });
  if (forwarded) {
    if ("error" in forwarded) throw forwarded.error;
    return forwarded.response;
  }
  // An agent's own source is only ever on Artifacts.
  if (url.pathname.startsWith("/agent-src/")) return env.GIT_BACKEND === "artifacts" ? artifactGit(request, env, tenant.slug) : notFoundPage();
  if (await usesArtifacts(env, tenant.slug, url.pathname.slice(1, url.pathname.indexOf(".git/")))) return artifactGit(request, env, tenant.slug);
  if (url.pathname.slice(1, url.pathname.indexOf(".git/")).includes("/")) return new Response("repository not found\n", { status: 404 });
  if (!env.ARDI) return new Response("git service unavailable\n", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  // The original request, except the hub-wide session cookie, which Ardi never needs, and any `x-ardi-*` header.
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  // Defence in depth: `x-ardi-*` is Ardi's own header namespace; a client must never be able to set one.
  for (const name of [...headers.keys()]) if (name.startsWith("x-ardi-")) headers.delete(name);
  return env.ARDI.fetch(new Request(request, { headers }));
}
