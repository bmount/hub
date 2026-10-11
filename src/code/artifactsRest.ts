import type { Env } from "../env";
import { HubError } from "../errors";
import { packet } from "./gitProtocol";

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

const pktDecode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function pktLen(bytes: Uint8Array, offset: number): number {
  const text = pktDecode.decode(bytes.subarray(offset, offset + 4));
  if (!/^[0-9a-fA-F]{4}$/.test(text)) throw new Error("bad packet");
  const length = Number.parseInt(text, 16);
  if (length !== 0 && (length < 4 || length > 65520)) throw new Error("bad packet");
  return length;
}
function joinPackets(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;for (const part of parts) { result.set(part, offset);offset += part.length; }return result;
}
function replaceHeadAdvert(bytes: Uint8Array, branch: string, target: string): Uint8Array {
  const out: Uint8Array[] = [];
  let sawHead = false;
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 4) throw new Error("truncated advertisement");
    const length = pktLen(bytes, offset);
    if (!length) { out.push(bytes.subarray(offset, offset + 4));offset += 4;continue; }
    if (offset + length > bytes.length) throw new Error("truncated advertisement");
    const payload = bytes.subarray(offset + 4, offset + length), nul = payload.indexOf(0);
    const text = pktDecode.decode(nul < 0 ? payload : payload.subarray(0, nul));
    const caps = nul < 0 ? "" : "\0" + pktDecode.decode(payload.subarray(nul + 1));
    if (/^[0-9a-f]{40} HEAD\n?$/.test(text)) {
      const cleanCaps = caps ? caps.replace(/symref=HEAD:[^ \n\0]+/, `symref=HEAD:refs/heads/${branch}`) : "";
      out.push(packet(`${target} HEAD${cleanCaps}\n`));sawHead = true;
    } else out.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return sawHead ? joinPackets(out) : bytes;
}
function replaceV2Head(bytes: Uint8Array, branch: string, target: string): Uint8Array {
  const out: Uint8Array[] = [];
  let sawHead = false;
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 4) throw new Error("truncated advertisement");
    const length = pktLen(bytes, offset);
    if (!length) { out.push(bytes.subarray(offset, offset + 4));offset += 4;continue; }
    if (offset + length > bytes.length) throw new Error("truncated advertisement");
    const text = pktDecode.decode(bytes.subarray(offset + 4, offset + length));
    if (/^[0-9a-f]{40} HEAD(?: |\n)/.test(text)) {
      const attrs = text.replace(/^[0-9a-f]{40} HEAD/, "").replace(/symref-target:[^ \n]+/, `symref-target:refs/heads/${branch}`);
      out.push(packet(`${target} HEAD${attrs}`));sawHead = true;
    } else out.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return sawHead ? joinPackets(out) : bytes;
}
async function looksLikeV2LsRefs(source: ReadableStream<Uint8Array> | null, encoding: string | null): Promise<boolean> {
  if (!source) return false;
  let stream: ReadableStream<Uint8Array> = source;
  if (encoding) {
    if (encoding !== "gzip") return false;
    stream = source.pipeThrough(new DecompressionStream("gzip"));
  }
  const reader = stream.getReader();
  let bytes = new Uint8Array(0);
  try {
    for (;;) {
      const next = await reader.read();if (next.done) break;
      if (bytes.length + next.value.length > 4096) return false;
      const joined = new Uint8Array(bytes.length + next.value.length);joined.set(bytes);joined.set(next.value, bytes.length);bytes = joined;
    }
  } catch { return false; }
  finally { reader.releaseLock(); }
  try {
    for (let offset = 0; offset < bytes.length;) {
      if (bytes.length - offset < 4) return false;
      const length = pktLen(bytes, offset);offset += 4;
      if (!length) continue;
      if (offset + length - 4 > bytes.length) return false;
      const line = pktDecode.decode(bytes.subarray(offset, offset + length - 4)).trim();
      if (line === "command=ls-refs") return true;
      offset += length - 4;
    }
  } catch { return false; }
  return false;
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
    const url = new URL(request.url), upstream = new URL(`${this.remote(namespace, repo)}/${tail}`);
    upstream.search = url.search;
    const headers = new Headers();
    for (const name of ["content-type", "content-encoding", "accept", "git-protocol", "user-agent"]) {
      const value = request.headers.get(name);if (value) headers.set(name, value);
    }
    let inspect: ReadableStream<Uint8Array> | null = null;
    if (tail === "git-upload-pack" && request.method === "POST" && body) [body, inspect] = body.tee();
    const normalizeV0 = tail === "info/refs" && url.searchParams.get("service") === "git-upload-pack";
    const normalizeV2 = tail === "git-upload-pack" && request.method === "POST" && await looksLikeV2LsRefs(inspect, request.headers.get("content-encoding"));
    headers.set("authorization", `Bearer ${await this.repoToken(namespace, repo, write ? "write" : "read")}`);
    let response: Response;
    try { response = await fetch(upstream, { method: request.method, headers, body, redirect: "manual" }); }
    catch { throw new HubError(503, "unavailable", "Git storage did not answer"); }
    if (!normalizeV0 && !normalizeV2) return response;
    const [info, commits] = await Promise.all([this.info(namespace, repo), this.log(namespace, repo, "main", 1).catch(() => [])]);
    const branch = info.default_branch || "main", target = branch === "main" ? commits[0]?.hash : (await this.log(namespace, repo, branch, 1).catch(() => []))[0]?.hash;
    if (!/^[0-9a-f]{40}$/.test(target ?? "")) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    let replaced: Uint8Array;
    try { replaced = normalizeV0 ? replaceHeadAdvert(bytes, branch, target!) : replaceV2Head(bytes, branch, target!); }
    catch { return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers }); }
    return new Response(replaced, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
