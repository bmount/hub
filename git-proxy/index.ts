import type { Env } from "../src/env";
import { classifyHost } from "../src/tenant";
import { GIT_PATH, artifactGit } from "../src/http/artifactGit";
import { handleApi } from "../src/http/api";
import { notFoundPage } from "../src/http/pages";
import { getTenantBySlug } from "../src/db/tenants";
import "../src/verbs/session";
import { cleanupGitStages } from "../src/code/gitStageCleanup";
import { fencedLegacyGit, usesArtifacts } from "../src/code/gitBackend";

type ProxyEnv = Env & { HUB: Fetcher };

/** One shared deployment, with live authorization directly against the shared database. */
export default {
  async fetch(request: Request, env: ProxyEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), host = classifyHost(request.headers.get("host") ?? url.host, env.HUB_DOMAIN);
    if (host.kind === "tenant" && GIT_PATH.test(url.pathname)) {
      const tenant = await getTenantBySlug(env.HUB_DB, host.slug);
      if (!tenant || tenant.state !== "active") return notFoundPage();
      if (url.pathname.startsWith("/agent-src/")) return env.GIT_BACKEND === "artifacts" ? artifactGit(request, env, tenant.slug) : notFoundPage();
      const repo = url.pathname.slice(1, url.pathname.indexOf(".git/"));
      return await usesArtifacts(env, tenant.slug, repo) ? artifactGit(request, env, tenant.slug) : fencedLegacyGit(request, env, tenant.slug, repo);
    }
    // Existing agent helpers use this URL. Keep Git session renewal independent of a broken hub deploy too.
    if (host.kind === "tenant" && url.pathname === "/api/session.start" && request.method === "POST") return handleApi(request, env, promise => ctx.waitUntil(promise));
    // A tenant's existing hostname also serves the workbench. Keep those requests unchanged.
    return env.HUB.fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: ProxyEnv, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupGitStages(env, Date.now()).then(result => console.log(JSON.stringify({ msg: "Git staging cleanup", ...result }))));
  },
} satisfies ExportedHandler<ProxyEnv>;
