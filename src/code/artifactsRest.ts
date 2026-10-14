import { instrumentMethods } from "../perf";
import type { Env } from "../env";
import { HubError } from "../errors";
import { packet } from "./gitProtocol";
import { sha256Hex } from "../ids";
import { seal, open } from "../models/secretbox";

export type ArtifactRepo = { name: string; remote: string; description: string | null; default_branch: string; read_only: boolean };
export type ArtifactCommit = {
  hash: string; treeHash: string; parents: string[];
  author: { name: string; email: string };
  committer: { name: string; email: string };
  authoredAt: number; committedAt: number; message: string;
};
class IncompleteArtifactRepository extends HubError {}

type ScopedToken = { plaintext: string; expires: number; cacheKey?: string };
const tokens = new Map<string, ScopedToken>();
export async function clearArtifactTokensForTest(memoryOnly = false): Promise<void> {
  const keys = [...tokens.values()].flatMap(token => token.cacheKey ? [token.cacheKey] : []);
  tokens.clear();
  if (!memoryOnly) await Promise.all(keys.map(key => caches.default.delete(key).catch(() => false)));
}
function rememberToken(key: string, token: ScopedToken): void {
  if (tokens.size >= 256) {
    for (const [name, cached] of tokens) if (cached.expires <= Date.now() + 30_000) tokens.delete(name);
    if (tokens.size >= 256) tokens.delete(tokens.keys().next().value!);
  }
  tokens.set(key, token);
}
function validToken(token: ScopedToken): boolean {
  return typeof token.plaintext === "string" && /^[\x21-\x7e]{1,2048}$/.test(token.plaintext) && Number.isFinite(token.expires) && token.expires > Date.now();
}

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
    if (/^(?:[0-9a-f]{40}|unborn) HEAD(?: |\n)/.test(text)) {
      const attrs = text.replace(/^(?:[0-9a-f]{40}|unborn) HEAD/, "").replace(/symref-target:[^ \n]+/, `symref-target:refs/heads/${branch}`);
      out.push(packet(`${target} HEAD${attrs}`));sawHead = true;
    } else out.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return sawHead ? joinPackets(out) : bytes;
}
/** Read tips from this very advertisement, never a separately cached mutable ref. */
function advertisedHead(bytes: Uint8Array, branch?: string): { head: boolean; target?: string } {
  let head = false, target: string | undefined;
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 4) throw new Error("truncated advertisement");
    const length = pktLen(bytes, offset);
    if (!length) { offset += 4;continue; }
    if (offset + length > bytes.length) throw new Error("truncated advertisement");
    const line = pktDecode.decode(bytes.subarray(offset + 4, offset + length)).split("\0", 1)[0]!;
    const ref = /^([0-9a-f]{40}|unborn) ([^ \n]+)(?: |\n|$)/.exec(line);
    if (ref?.[2] === "HEAD") head = true;
    if (branch && ref?.[2] === `refs/heads/${branch}` && ref[1] !== "unborn") target = ref[1];
    offset += length;
  }
  return { head, target };
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

export function isValidationCache(target: string): boolean { return /^pimwell-cache-[0-9a-f]{40}$/.test(target); }

export async function validationRepository(repo: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repo));
  return `pimwell-cache-${Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

export class ArtifactsRest {
  readonly account: string;
  constructor(private env: Env, private deadline?: AbortSignal) {
    if (!env.ARTIFACTS_API_TOKEN || !env.ARTIFACTS_ACCOUNT_ID || !/^[a-f0-9]{32}$/.test(env.ARTIFACTS_ACCOUNT_ID))
      throw new HubError(503, "unavailable", "Artifacts is not configured");
    this.account = env.ARTIFACTS_ACCOUNT_ID;
  }
  /** Share one budget across fork, validation, publication and response-body reads. */
  withDeadline(milliseconds: number): ArtifactsRest {
    return new ArtifactsRest(this.env, AbortSignal.timeout(milliseconds));
  }
  private signal(milliseconds: number): AbortSignal {
    const timeout = AbortSignal.timeout(milliseconds);
    return this.deadline ? AbortSignal.any([this.deadline, timeout]) : timeout;
  }
  private base(namespace: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(namespace)) throw new HubError(400, "bad_request", "invalid storage namespace");
    return `https://api.cloudflare.com/client/v4/accounts/${this.account}/artifacts/namespaces/${encodeURIComponent(namespace)}`;
  }
  private repoPath(repo: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(repo)) throw new HubError(400, "bad_request", "invalid Git repository");
    return `/repos/${encodeURIComponent(repo)}`;
  }
  private async request(namespace: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST", timeout = 20_000): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.base(namespace) + path, {
        method, redirect: "manual", signal: this.signal(timeout),
        headers: { authorization: `Bearer ${this.env.ARTIFACTS_API_TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HubError(503, "unavailable", `Artifacts ${path.endsWith("/fork") ? "repository fork" : method} did not answer within ${timeout / 1000}s`); }
    if (response.status === 404) throw new HubError(404, "not_found", "repository not found");
    if (!response.ok) throw await this.failure(response, method, path);
    return response;
  }
  private async failure(response: Response, method: string, path: string, data?: unknown): Promise<HubError> {
    const payload = data ?? await response.json().catch(() => null);
    const errors = (payload as { errors?: { code?: unknown }[] } | null)?.errors;
    // Upstream prose can echo credentials. Only numeric codes and a validated request ID are safe evidence.
    const codes = Array.isArray(errors) ? errors.slice(0, 5).map(e => e?.code).filter(c => typeof c === "number" && Number.isSafeInteger(c)).join(",") : "";
    const ray = response.headers.get("cf-ray") ?? "";
    const operation = path === "/repos" && method === "POST" ? "create repository" : method;
    const ErrorType = method === "GET" && response.status === 409 && Array.isArray(errors) && errors.length === 1 && errors[0]?.code === 10303 ? IncompleteArtifactRepository : HubError;
    return new ErrorType(502, "unavailable", `Artifacts request failed (${operation}; HTTP ${response.status}${codes ? `; codes ${codes}` : ""}${/^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/.test(ray) ? `; request ${ray}` : ""}). Check Artifacts availability and API token permissions.`);
  }
  async call<T>(namespace: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST", timeout = 20_000): Promise<T> {
    const response = await this.request(namespace, path, body, method, timeout);
    const data = await response.json().catch(() => null) as { success?: boolean; result?: T } | null;
    if (data?.success !== true) throw await this.failure(response, method, path, data);
    return data.result as T;
  }
  async info(namespace: string, repo: string): Promise<ArtifactRepo> {
    const info = await this.call<ArtifactRepo>(namespace, this.repoPath(repo));
    if (info.name !== repo || info.remote !== this.remote(namespace, repo)) throw new HubError(502, "unavailable", "Artifacts repository mapping mismatch");
    return { name: info.name, remote: info.remote, description: info.description, default_branch: info.default_branch, read_only: info.read_only };
  }
  async create(namespace: string, repo: string, description: string): Promise<void> {
    await this.call(namespace, "/repos", { name: repo, description, default_branch: "main" });
    await this.invalidateRepoTokens(namespace, repo);
  }
  private async rememberFork(namespace: string, source: string, target: string, description: string, proof: "reserved" | "accepted" | "ready"): Promise<void> {
    await this.env.HUB_DB.prepare("INSERT INTO artifact_fork_ownership (account, namespace, target, source, description, proof, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, namespace, target) DO UPDATE SET proof = CASE WHEN artifact_fork_ownership.proof IN ('ready', 'deleting') THEN artifact_fork_ownership.proof ELSE excluded.proof END WHERE source = excluded.source AND description = excluded.description")
      .bind(this.account, namespace, target, source, description, proof, Date.now()).run();
  }
  private async ownsFork(namespace: string, target: string, description: string, reserved = false): Promise<boolean> {
    const row = await this.env.HUB_DB.prepare("SELECT description, proof FROM artifact_fork_ownership WHERE account = ? AND namespace = ? AND target = ?")
      .bind(this.account, namespace, target).first<{ description: string; proof: string }>();
    return row?.description === description && (row.proof === "accepted" || row.proof === "ready" || row.proof === "deleting" || (reserved && row.proof === "reserved"));
  }
  async fork(namespace: string, repo: string, target: string, description?: string): Promise<void> {
    this.repoPath(target);
    const id = target.slice("pimwell-stage-".length);
    const temporary = target === `pimwell-stage-${id}` && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) && description === `Pimwell temporary validation ${id}`;
    if (temporary) {
      // An unguessable, absent target can be reserved before a request whose response may be lost.
      try { await this.info(namespace, target);throw new HubError(409, "conflict", "temporary repository already exists"); }
      catch (error) { if (!(error instanceof HubError) || error.status !== 404) throw error; }
      await this.rememberFork(namespace, repo, target, description!, "reserved");
    }
    // A fork copies the existing object store, not just this push's delta.
    await this.call(namespace, this.repoPath(repo) + "/fork", { name: target, description, default_branch_only: false }, "POST", 90_000);
    if (description) await this.rememberFork(namespace, repo, target, description, "accepted");
  }
  private async deleteOwnedFork(namespace: string, target: string, description: string, reserved = false, source = target): Promise<void> {
    try {
      try {
        const info = await this.info(namespace, target);
        if (info.description !== description) throw new HubError(409, "conflict", "validation repository ownership mismatch; nothing deleted");
        await this.rememberFork(namespace, source, target, description, "accepted");
      } catch (error) {
        if (!(error instanceof IncompleteArtifactRepository) || !await this.ownsFork(namespace, target, description, reserved)) throw error;
      }
      // Tombstone before the request: a lost delete response remains retryable and cannot be reused.
      await this.env.HUB_DB.prepare("UPDATE artifact_fork_ownership SET proof = 'deleting' WHERE account = ? AND namespace = ? AND target = ? AND description = ?")
        .bind(this.account, namespace, target, description).run();
      // Asynchronous deletion can acknowledge without a JSON body. Keep proof until absence is confirmed.
      const response = await this.request(namespace, this.repoPath(target), undefined, "DELETE");
      if (response.status !== 202 && response.status !== 204) {
        const data = await response.json().catch(() => null) as { success?: boolean } | null;
        if (data?.success !== true) throw await this.failure(response, "DELETE", this.repoPath(target), data);
      }
    } catch (error) {
      if (!(error instanceof HubError) || error.status !== 404) throw error;
      await this.env.HUB_DB.prepare("DELETE FROM artifact_fork_ownership WHERE account = ? AND namespace = ? AND target = ?").bind(this.account, namespace, target).run();
    }
  }
  /** Reuse objects, never refs: each incoming attempt writes its own private validation refs. */
  async prepareValidation(namespace: string, repo: string, target: string, ownership: string, pushId?: string): Promise<string> {
    if (target !== await validationRepository(repo)) throw new HubError(400, "bad_request", "invalid validation repository");
    const description = `${ownership} validation cache for ${repo}`;
    let stored = await this.env.HUB_DB.prepare("SELECT target FROM artifact_fork_ownership WHERE account = ? AND namespace = ? AND source = ? AND description = ?")
      .bind(this.account, namespace, repo, description).first<{ target: string }>();
    if (!stored) {
      try {
        const info = await this.info(namespace, target);
        if (info.description !== description) throw new HubError(409, "conflict", "validation repository ownership mismatch");
        return target; // Preserve existing deterministic caches; never guess a legacy ownership backfill.
      } catch (error) { if (!(error instanceof HubError) || error.status !== 404) throw error; }
      const unique = `pimwell-cache-${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().slice(0, 8)}`;
      try { await this.info(namespace, unique);throw new HubError(409, "conflict", "validation target already exists"); }
      catch (error) { if (!(error instanceof HubError) || error.status !== 404) throw error; }
      // Atomic reservation makes concurrent first pushes select the same unguessable physical target.
      await this.env.HUB_DB.prepare("INSERT OR IGNORE INTO artifact_fork_ownership VALUES (?, ?, ?, ?, ?, 'reserved', ?)")
        .bind(this.account, namespace, unique, repo, description, Date.now()).run();
      stored = await this.env.HUB_DB.prepare("SELECT target FROM artifact_fork_ownership WHERE account = ? AND namespace = ? AND source = ? AND description = ?")
        .bind(this.account, namespace, repo, description).first<{ target: string }>();
    }
    target = stored!.target;
    if (await this.env.HUB_DB.prepare("SELECT 1 FROM artifact_fork_ownership WHERE account = ? AND namespace = ? AND target = ? AND proof = 'deleting'")
      .bind(this.account, namespace, target).first()) throw new HubError(409, "conflict", "validation repository cleanup pending");
    if (!isValidationCache(target)) throw new HubError(409, "conflict", "validation repository mapping mismatch");
    if (pushId) await this.env.HUB_DB.prepare("UPDATE git_push SET shadow = ? WHERE id = ? AND namespace = ? AND repo = ?")
      .bind(target, pushId, namespace, repo).run();
    try {
      const info = await this.info(namespace, target);
      if (info.description !== description) throw new HubError(409, "conflict", "validation repository ownership mismatch");
      await this.rememberFork(namespace, repo, target, description, "ready");
      return target;
    } catch (error) { if (!(error instanceof HubError) || error.status !== 404) throw error; }
    await this.fork(namespace, repo, target, description).catch(() => {});
    if ((await this.info(namespace, target)).description !== description)
      throw new HubError(409, "conflict", "validation repository ownership mismatch");
    await this.rememberFork(namespace, repo, target, description, "ready");
    return target;
  }
  /** Never delete a live repository without verifying its tenant/project ownership marker. */
  async deleteProject(namespace: string, repo: string, ownership: string): Promise<void> {
    let exists = true;
    try {
      const info = await this.info(namespace, repo);
      if (info.description !== ownership) throw new HubError(409, "conflict", "repository ownership mismatch; nothing deleted");
    } catch (error) {
      if (!(error instanceof HubError) || error.status !== 404) throw error;
      exists = false;
    }
    const cache = await validationRepository(repo);
    await this.deleteOwnedFork(namespace, cache, `${ownership} validation cache for ${repo}`, false, repo);
    const stored = await this.env.HUB_DB.prepare("SELECT target FROM artifact_fork_ownership WHERE account = ? AND namespace = ? AND source = ? AND description = ?")
      .bind(this.account, namespace, repo, `${ownership} validation cache for ${repo}`).first<{ target: string }>();
    if (stored && stored.target !== cache) {
      if (!isValidationCache(stored.target)) throw new HubError(409, "conflict", "validation repository mapping mismatch");
      await this.deleteOwnedFork(namespace, stored.target, `${ownership} validation cache for ${repo}`, true, repo);
    }
    if (exists) {
      try {
        const response = await this.request(namespace, this.repoPath(repo), undefined, "DELETE");
        if (response.status !== 202 && response.status !== 204) {
          const data = await response.json().catch(() => null) as { success?: boolean } | null;
          if (data?.success !== true) throw await this.failure(response, "DELETE", this.repoPath(repo), data);
        }
      } catch (error) { if (!(error instanceof HubError) || error.status !== 404) throw error; }
    }
    await this.invalidateRepoTokens(namespace, repo);
  }
  /** Routine cleanup may remove a failed cache, but never a readable shared object store. */
  async cleanupIncompleteValidation(namespace: string, repo: string, ownership: string): Promise<boolean> {
    const description = `${ownership} validation cache for ${repo}`;
    const stored = await this.env.HUB_DB.prepare("SELECT target, proof FROM artifact_fork_ownership WHERE account = ? AND namespace = ? AND source = ? AND description = ?")
      .bind(this.account, namespace, repo, description).first<{ target: string; proof: string }>();
    if (!stored || stored.proof === "ready" || !isValidationCache(stored.target)) return false;
    const cache = stored.target;
    if (stored.proof === "deleting") {
      await this.deleteOwnedFork(namespace, cache, description, cache !== await validationRepository(repo), repo);
      return true;
    }
    try {
      const info = await this.info(namespace, cache);
      if (info.description !== description) throw new HubError(409, "conflict", "validation repository ownership mismatch");
      await this.rememberFork(namespace, repo, cache, description, "ready");
      return false;
    }
    catch (error) {
      if (error instanceof HubError && error.status === 404) {
        await this.deleteOwnedFork(namespace, cache, description, false, repo);
        return true;
      }
      if (!(error instanceof IncompleteArtifactRepository)) throw error;
    }
    await this.deleteOwnedFork(namespace, cache, description, cache !== await validationRepository(repo), repo);
    return true;
  }
  async deleteTemporary(namespace: string, repo: string, id: string): Promise<void> {
    if (repo !== `pimwell-stage-${id}` || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new HubError(400, "bad_request", "not a temporary repository");
    await this.deleteOwnedFork(namespace, repo, `Pimwell temporary validation ${id}`, true);
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
  private async invalidateRepoTokens(namespace: string, repo: string): Promise<void> {
    for (const key of tokens.keys()) if (key.startsWith(`${this.account}/${namespace}/${repo}/`)) tokens.delete(key);
    await Promise.all((["read", "write"] as const).map(async scope => {
      try { await caches.default.delete((await this.tokenCache(namespace, repo, scope)).url); } catch { /* Best-effort eviction; tokens still expire. */ }
    }));
  }
  private async tokenCache(namespace: string, repo: string, scope: "read" | "write"): Promise<{ key: string; url: string; secret: string }> {
    this.base(namespace);this.repoPath(repo);
    // Edge caches span isolates. Seal credentials and bind both the cache key and
    // decrypted payload to the account, API credential, namespace, repo and scope.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`Artifacts scoped token cache v1:${this.env.ARTIFACTS_API_TOKEN}`)));
    const secret = btoa(String.fromCharCode(...digest));
    const id = await sha256Hex(`${this.account}/${namespace}/${repo}/${scope}/${secret}`);
    return { key: `${this.account}/${namespace}/${repo}/${scope}/${id}`, url: `https://pimwell-artifacts-token.invalid/v1/${id}`, secret };
  }
  async repoToken(namespace: string, repo: string, scope: "read" | "write"): Promise<string> {
    const cache = await this.tokenCache(namespace, repo, scope);
    const cached = tokens.get(cache.key);
    if (cached && cached.expires > Date.now() + 30_000) return cached.plaintext;
    try {
      const hit = await caches.default.match(cache.url);
      if (hit) {
        const token = JSON.parse(await open(cache.secret, await hit.json())) as ScopedToken & { context: string };
        if (token.context === cache.key && validToken(token) && token.expires > Date.now() + 30_000) {
          rememberToken(cache.key, { plaintext: token.plaintext, expires: token.expires, cacheKey: cache.url });
          return token.plaintext;
        }
      }
    } catch { /* A missing, corrupt or unavailable edge cache is only a miss. */ }
    const result = await this.call<{ plaintext: string; expires_at: string }>(namespace, "/tokens", { repo, scope, ttl: 300 });
    const token = { plaintext: result.plaintext, expires: Date.parse(result.expires_at), cacheKey: cache.url };
    if (!validToken(token)) throw new HubError(502, "unavailable", "Artifacts token unavailable");
    rememberToken(cache.key, token);
    const ttl = Math.floor((token.expires - Date.now() - 30_000) / 1000);
    if (ttl > 0) try {
      const encrypted = await seal(cache.secret, JSON.stringify({ plaintext: token.plaintext, expires: token.expires, context: cache.key }));
      await caches.default.put(cache.url, Response.json(encrypted, { headers: { "cache-control": `max-age=${Math.min(ttl, 270)}` } }));
    } catch { /* Cache availability never controls Git authorization or storage. */ }
    return token.plaintext;
  }
  async git(namespace: string, repo: string, tail: string, request: Request, body: ReadableStream<Uint8Array> | null, write: boolean, normalizeHead = true, headInfo?: ArtifactRepo): Promise<Response> {
    if (!["info/refs", "git-upload-pack", "git-receive-pack"].includes(tail)) throw new HubError(400, "bad_request", "invalid Git operation");
    const url = new URL(request.url), upstream = new URL(`${this.remote(namespace, repo)}/${tail}`);
    upstream.search = url.search;
    const headers = new Headers();
    for (const name of ["content-type", "content-encoding", "accept", "git-protocol", "user-agent"]) {
      const value = request.headers.get(name);if (value) headers.set(name, value);
    }
    let inspect: ReadableStream<Uint8Array> | null = null;
    if (tail === "git-upload-pack" && request.method === "POST" && body) [body, inspect] = body.tee();
    const normalizeV0 = normalizeHead && tail === "info/refs" && url.searchParams.get("service") === "git-upload-pack";
    const normalizeV2 = normalizeHead && tail === "git-upload-pack" && request.method === "POST" && await looksLikeV2LsRefs(inspect, request.headers.get("content-encoding"));
    // v2 discovery advertises capabilities, not refs. Overlap fresh metadata with
    // token/storage I/O, but never retain promises across Worker invocations.
    const needsHead = normalizeV2 || (normalizeV0 && !request.headers.get("git-protocol")?.split(":").includes("version=2"));
    const metadata = needsHead ? (headInfo ? Promise.resolve({ info: headInfo }) : this.info(namespace, repo).then(info => ({ info }), error => ({ error }))) : null;
    headers.set("authorization", `Bearer ${await this.repoToken(namespace, repo, write ? "write" : "read")}`);
    let response: Response;
    try { response = await fetch(upstream, { method: request.method, headers, body, redirect: "manual", signal: this.signal(120_000) }); }
    catch { throw new HubError(503, "unavailable", "Git storage did not answer within 120s; run git ls-remote before retrying"); }
    if (!response.ok || (!normalizeV0 && !normalizeV2)) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const original = () => new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    try { if (!advertisedHead(bytes).head) return original(); }
    catch { return original(); }
    const result = await (metadata ?? this.info(namespace, repo).then(info => ({ info }), error => ({ error })));
    if ("error" in result) throw result.error;
    const branch = result.info.default_branch || "main";
    // v2 ref-prefix can omit the default branch; only then is a log lookup needed.
    const target = advertisedHead(bytes, branch).target ?? (await this.log(namespace, repo, branch, 1).catch(() => []))[0]?.hash;
    if (!/^[0-9a-f]{40}$/.test(target ?? "")) return original();
    let replaced: Uint8Array;
    try { replaced = normalizeV0 ? replaceHeadAdvert(bytes, branch, target!) : replaceV2Head(bytes, branch, target!); }
    catch { return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers }); }
    return new Response(replaced, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
instrumentMethods(ArtifactsRest, "artifacts");
