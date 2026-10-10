import type { Env } from "../env";
import { finishLegacyForward, migrationRepo, startLegacyForward } from "./gitMigrationFence";

export async function usesArtifacts(env: Env, tenant: string, repo: string): Promise<boolean> {
  if (env.GIT_BACKEND !== "artifacts") return false;
  return !!await env.HUB_DB.prepare(`SELECT 1 FROM git_repository g JOIN project p ON p.id = g.project_id AND p.tenant_id = g.tenant_id JOIN tenant t ON t.id = g.tenant_id WHERE t.slug = ? AND p.slug = ?`)
    .bind(tenant, repo).first();
}

/** Keep legacy clients, including unmigrated repositories, working without changing their URLs. */
export function legacyGit(request: Request, ardi: Fetcher | undefined): Promise<Response> | Response {
  if (!ardi) return new Response("Git migration is not ready\n", { status: 503 });
  return ardi.fetch(sanitizedLegacyRequest(request));
}

function sanitizedLegacyRequest(request: Request): Request {
  const headers = new Headers(request.headers);headers.delete("cookie");
  for (const name of [...headers.keys()]) if (name.startsWith("x-ardi-")) headers.delete(name);
  return new Request(request, { headers });
}

function trackedResponse(response: Response, complete: (state: "complete" | "unknown", status: number | null) => Promise<void>): Response {
  if (!response.body) {
    void complete("complete", response.status);
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { reader.releaseLock();await complete("complete", response.status);controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { reader.releaseLock();await complete("unknown", response.status).catch(() => {});controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {});reader.releaseLock();await complete("unknown", response.status).catch(() => {}); },
  });
  return new Response(body, response);
}

/** Refuse newly arriving legacy writes after the private repository fence, and track forwarded writes until their upstream response body finishes. */
export async function fencedLegacyGit(request: Request, env: Env, tenant: string, repo: string): Promise<Response> {
  if (!env.ARDI) return new Response("Git migration is not ready\n", { status: 503 });
  const receivePack = new URL(request.url).pathname.endsWith("/git-receive-pack");
  if (!receivePack) return legacyGit(request, env.ARDI);
  const migrating = await migrationRepo(env, tenant, repo);
  if (!migrating) return legacyGit(request, env.ARDI);
  if (migrating.legacy_write_fenced_at !== null) return new Response("repository is read-only\n", { status: 403, headers: { "cache-control": "no-store" } });
  const id = await startLegacyForward(env, migrating, repo, new URL(request.url).pathname);
  try {
    const upstream = await env.ARDI.fetch(sanitizedLegacyRequest(request));
    return trackedResponse(upstream, (state, status) => finishLegacyForward(env, id, state, status));
  } catch (error) {
    await finishLegacyForward(env, id, "unknown", null).catch(() => {});
    throw error;
  }
}
