import type { Env } from "../env";
import { HubError } from "../errors";

export type ArtifactRepo = { name: string; remote: string; description: string | null; default_branch: string; read_only: boolean };
export type ArtifactCommit = {
  hash: string; treeHash: string; parents: string[];
  author: { name: string; email: string };
  committer: { name: string; email: string };
  authoredAt: number; committedAt: number; message: string;
};
const tokens = new Map<string, { plaintext: string; expires: number }>();
export function clearArtifactTokensForTest(): void { tokens.clear(); }

export function artifactNamespace(tenant: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenant)) throw new HubError(400, "bad_request", "invalid Git organization");
  // Pimwell permits one-character names; Artifacts requires at least two. '_' cannot occur in a tenant slug.
  return tenant.length === 1 ? `${tenant}_` : tenant;
}

export class ArtifactsRest {
  readonly account: string;
  constructor(private env: Env) {
    if (!env.ARTIFACTS_API_TOKEN || !env.ARTIFACTS_ACCOUNT_ID || !/^[a-f0-9]{32}$/.test(env.ARTIFACTS_ACCOUNT_ID))
      throw new HubError(503, "unavailable", "Artifacts is not configured");
    this.account = env.ARTIFACTS_ACCOUNT_ID;
  }
  private base(namespace: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(namespace)) throw new HubError(400, "bad_request", "invalid storage namespace");
    return `https://api.cloudflare.com/client/v4/accounts/${this.account}/artifacts/namespaces/${encodeURIComponent(namespace)}`;
  }
  private repoPath(repo: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(repo)) throw new HubError(400, "bad_request", "invalid Git repository");
    return `/repos/${encodeURIComponent(repo)}`;
  }
  private async request(namespace: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.base(namespace) + path, {
        method, redirect: "manual", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${this.env.ARTIFACTS_API_TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HubError(503, "unavailable", "Artifacts did not answer"); }
    if (response.status === 404) throw new HubError(404, "not_found", "repository not found");
    if (!response.ok) throw new HubError(502, "unavailable", "Artifacts request failed");
    return response;
  }
  async call<T>(namespace: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await this.request(namespace, path, body, method);
    const data = await response.json().catch(() => null) as { success?: boolean; result?: T } | null;
    if (data?.success !== true) throw new HubError(502, "unavailable", "Artifacts request failed");
    return data.result as T;
  }
  async info(namespace: string, repo: string): Promise<ArtifactRepo> {
    const info = await this.call<ArtifactRepo>(namespace, this.repoPath(repo));
    if (info.name !== repo || info.remote !== this.remote(namespace, repo)) throw new HubError(502, "unavailable", "Artifacts repository mapping mismatch");
    return { name: info.name, remote: info.remote, description: info.description, default_branch: info.default_branch, read_only: info.read_only };
  }
  async create(namespace: string, repo: string, description: string): Promise<void> {
    await this.call(namespace, "/repos", { name: repo, description, default_branch: "main" });
  }
  async fork(namespace: string, repo: string, target: string, description?: string): Promise<void> {
    this.repoPath(target);
    await this.call(namespace, this.repoPath(repo) + "/fork", { name: target, description, default_branch_only: false });
  }
  async deleteTemporary(namespace: string, repo: string, id: string): Promise<void> {
    if (repo !== `pimwell-stage-${id}` || !/^[0-9a-f-]{36}$/.test(id)) throw new HubError(400, "bad_request", "not a temporary repository");
    const info = await this.info(namespace, repo);
    if (info.description !== `Pimwell temporary validation ${id}`) throw new HubError(409, "conflict", "temporary repository ownership mismatch");
    await this.call(namespace, this.repoPath(repo), undefined, "DELETE");
  }
  async log(namespace: string, repo: string, ref: string, limit = 1000, offset = 0): Promise<ArtifactCommit[]> {
    return this.call(namespace, this.repoPath(repo) + `/log?${new URLSearchParams({ ref, limit: String(limit), offset: String(offset) })}`);
  }
  async readCommit<T>(namespace: string, repo: string, oid: string): Promise<T> {
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new HubError(400, "bad_request", "invalid commit id");
    return this.call<T>(namespace, this.repoPath(repo) + `/commit/${oid}`);
  }
  async tree(namespace: string, repo: string, hash: string): Promise<ArtifactsTreeEntry[]> {
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new HubError(400, "bad_request", "invalid tree id");
    return this.call(namespace, this.repoPath(repo) + `/tree/${hash}`);
  }
  async file(namespace: string, repo: string, ref: string, path: string): Promise<{ content_b64: string; size: number }> {
    const response = await this.request(namespace, this.repoPath(repo) + `/file?${new URLSearchParams({ ref, path })}`);
    const reader = response.body?.getReader();
    if (!reader) return { content_b64: "", size: 0 };
    let size = 0;const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();if (next.done) break;
        size += next.value.length;
        if (size <= 400_000) chunks.push(next.value);else chunks.length = 0;
      }
    } finally { reader.releaseLock(); }
    if (size > 400_000) return { content_b64: "", size };
    let text = "";for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 8192) text += String.fromCharCode(...chunk.subarray(i, i + 8192));
    return { content_b64: btoa(text), size };
  }
  remote(namespace: string, repo: string): string {
    this.base(namespace);this.repoPath(repo);
    return `https://${this.account}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`;
  }
  async repoToken(namespace: string, repo: string, scope: "read" | "write"): Promise<string> {
    this.repoPath(repo);
    const key = `${this.account}/${namespace}/${repo}/${scope}`;
    const cached = tokens.get(key);
    if (cached && cached.expires > Date.now() + 30_000) return cached.plaintext;
    const result = await this.call<{ plaintext: string; expires_at: string }>(namespace, "/tokens", { repo, scope, ttl: 300 });
    const expires = Date.parse(result.expires_at);
    if (typeof result.plaintext !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(result.plaintext) || !Number.isFinite(expires) || expires <= Date.now())
      throw new HubError(502, "unavailable", "Artifacts token unavailable");
    if (tokens.size >= 256) {
      for (const [name, token] of tokens) if (token.expires <= Date.now() + 30_000) tokens.delete(name);
      if (tokens.size >= 256) tokens.delete(tokens.keys().next().value!);
    }
    tokens.set(key, { plaintext: result.plaintext, expires });
    return result.plaintext;
  }
  async git(namespace: string, repo: string, tail: string, request: Request, body: ReadableStream<Uint8Array> | null, write: boolean): Promise<Response> {
    if (!["info/refs", "git-upload-pack", "git-receive-pack"].includes(tail)) throw new HubError(400, "bad_request", "invalid Git operation");
    const upstream = new URL(`${this.remote(namespace, repo)}/${tail}`);
    upstream.search = new URL(request.url).search;
    const headers = new Headers();
    for (const name of ["content-type", "content-encoding", "accept", "git-protocol", "user-agent"]) {
      const value = request.headers.get(name);if (value) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${await this.repoToken(namespace, repo, write ? "write" : "read")}`);
    try { return await fetch(upstream, { method: request.method, headers, body, redirect: "manual" }); }
    catch { throw new HubError(503, "unavailable", "Git storage did not answer"); }
  }
}
