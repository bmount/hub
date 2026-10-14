import { installFetchTiming, transferredTrace, withTrace, span, timedEnv, traceFields, deferredTrace, serverTiming, tracedInvocation } from "../src/perf";
import type { Env } from "../src/env";
import { classifyHost } from "../src/tenant";
import { GIT_PATH, artifactGit } from "../src/http/artifactGit";
import { authorizeGit } from "../src/code/gitAccess";
import { handleApi } from "../src/http/api";
import { notFoundPage } from "../src/http/pages";
import { getTenantBySlug } from "../src/db/tenants";
import "../src/verbs/session";
import { cleanupGitStages } from "../src/code/gitStageCleanup";
import { fencedLegacyGit, usesArtifacts } from "../src/code/gitBackend";

type ProxyEnv = Env & { HUB: Fetcher };
installFetchTiming();

/** One shared deployment, with live authorization directly against the shared database. */
async function dispatch(request: Request, env: ProxyEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), host = classifyHost(request.headers.get("host") ?? url.host, env.HUB_DOMAIN);
    if (host.kind === "tenant" && GIT_PATH.test(url.pathname)) {
      const agentSrc = url.pathname.startsWith("/agent-src/"), repo = url.pathname.slice(1, url.pathname.indexOf(".git/"));
      // All promises are request-local. Fresh caller/project authorization can run
      // beside routing, without letting a routing result grant repository access.
      const tenantLookup = getTenantBySlug(env.HUB_DB, host.slug);
      const authorization = !agentSrc && env.GIT_BACKEND === "artifacts"
        ? authorizeGit(env, request.headers.get("authorization"), host.slug, repo).then(async grant => {
          const tenant = await tenantLookup;
          return grant && grant.tenant.id === tenant?.id ? grant : null;
        }) : undefined;
      // Legacy routing may not consume it; still handle a failed speculative read.
      void authorization?.catch(() => {});
      const [tenant, artifacts] = await Promise.all([
        tenantLookup, agentSrc ? false : usesArtifacts(env, host.slug, repo),
      ]);
      if (!tenant || tenant.state !== "active") return notFoundPage();
      traceFields({ tenant: tenant.id, auth: "git", route: "/:repo.git/*" });
      if (agentSrc) return env.GIT_BACKEND === "artifacts" ? artifactGit(request, env, tenant.slug) : notFoundPage();
      if (artifacts) return artifactGit(request, env, tenant.slug, authorization);
      if (repo.includes("/")) return notFoundPage();
      return fencedLegacyGit(request, env, tenant.slug, repo);
    }
    // Existing agent helpers use this URL. Keep Git session renewal independent of a broken hub deploy too.
    if (host.kind === "tenant" && url.pathname === "/api/session.start" && request.method === "POST") return handleApi(request, env, promise => ctx.waitUntil(promise));
    // A tenant's existing hostname also serves the workbench. Keep those requests unchanged.
    return env.HUB.fetch(request);
}
export default {
  async fetch(request: Request, env: ProxyEnv, ctx: ExecutionContext): Promise<Response> {
    const trace = transferredTrace(request);
    trace.route = "/:repo.git/*"; trace.auth = "git";
    return withTrace(trace, async () => {
      try {
        const response = await span("git.request", () => dispatch(request, timedEnv(env), ctx));
        trace.status = response.status;
        // Preserve a downstream hub ID when this is a workbench pass-through.
        if (!response.headers.has("x-request-id")) {
          const headers = new Headers(response.headers);
          headers.set("x-request-id", trace.id);
          headers.set("server-timing", serverTiming(performance.now()-trace.started, { trips: 0, statements: 0, ms: 0 }, trace));
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
        return response;
      } catch (error) { trace.status = 500; throw error; }
      finally { trace.ended = performance.now(); ctx.waitUntil(deferredTrace(env, trace, "pimwell-git")); }
    });
  },
  async scheduled(_controller: ScheduledController, env: ProxyEnv, ctx: ExecutionContext) {
    ctx.waitUntil(tracedInvocation(env, p => ctx.waitUntil(p), "scheduled.git.cleanup", async e => {
      await cleanupGitStages(e, Date.now());
    }, "pimwell-git"));
  },
} satisfies ExportedHandler<ProxyEnv>;
