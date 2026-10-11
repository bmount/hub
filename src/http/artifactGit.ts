import type { Env } from "../env";
import { ArtifactsRest, artifactNamespace } from "../code/artifactsRest";
import { authorizeGit } from "../code/gitAccess";
import { agentSrcGrant } from "../code/agentSrc";
import { artifactPush, repoOwnership } from "../code/artifactPush";
import { HubError } from "../errors";

/** Smart-HTTP paths on a tenant host: /<repo>.git for project repositories, /agent-src/<agent>.git for an agent's own source. */
export const GIT_PATH = /^\/(?:(agent-src)\/)?([A-Za-z0-9][A-Za-z0-9._-]*)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export async function artifactGit(request: Request, env: Env, tenant: string): Promise<Response> {
  const url = new URL(request.url), match = GIT_PATH.exec(url.pathname);
  if (!match) return new Response("not found\n", { status: 404 });
  const agentSrc = !!match[1], repo = match[2]!, tail = match[3]!;
  const service = tail === "info/refs" ? url.searchParams.get("service") : tail;
  if (!["git-upload-pack", "git-receive-pack"].includes(service ?? "")) return new Response("smart HTTP only\n", { status: 400 });
  if (request.method !== (tail === "info/refs" ? "GET" : "POST")) return new Response("method not allowed\n", { status: 405 });
  try {
    const found = agentSrc ? await agentSrcGrant(env, request.headers.get("authorization"), tenant, repo) : await authorizeGit(env, request.headers.get("authorization"), tenant, repo);
    if (found === "not_found") return new Response("not found\n", { status: 404 });
    if (!found || found === "unauthenticated") return new Response("authentication required\n", { status: 401, headers: { "www-authenticate": 'Basic realm="pimwell git"' } });
    const grant = found;
    const write = service === "git-receive-pack";
    if (write && !grant.write) return new Response("read-only access\n", { status: 403 });
    const api = new ArtifactsRest(env), namespace = artifactNamespace(grant.tenant.slug);
    const info = await api.info(namespace, grant.project.slug);
    if (info.description !== repoOwnership(grant.tenant.id, grant.project.id)) throw new HubError(503, "unavailable", "repository migration is not ready");
    if (write && info.read_only) return new Response("repository is read-only\n", { status: 403 });
    if (tail === "git-receive-pack") return await artifactPush(request, env, grant, api, agentSrc
      ? async () => { const again = await agentSrcGrant(env, request.headers.get("authorization"), tenant, repo); return typeof again === "string" ? null : again; }
      : undefined);
    const upstream = await api.git(namespace, grant.project.slug, tail, request, request.body, write);
    if (!upstream.ok) throw new HubError(502, "unavailable", "Git storage is temporarily unavailable");
    const headers = new Headers({ "cache-control": "no-store" });
    for (const name of ["content-type", "content-encoding", "git-protocol"]) {
      const value = upstream.headers.get(name);if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    const status = error instanceof HubError ? error.status : 503;
    return new Response(`${error instanceof HubError ? error.message : "Git temporarily unavailable"}\n`, { status, headers: { "cache-control": "no-store" } });
  }
}
