import type { Env } from "../env";
import { HubError } from "../errors";
import { ArtifactsRest, artifactNamespace, type ArtifactCommit } from "./artifactsRest";
import { authorizeGit, type GitGrant } from "./gitAccess";
import { agentSrcGrant } from "./agentSrc";
import { repoOwnership } from "./artifactPush";
import { parseAdvertisedRefs } from "./gitProtocol";
import { packFromResponse, readPack, shallowFetchBody, snapshotFiles, type SnapshotFile } from "./gitPack";
import type { ArdiChange, ArdiCommit, ArdiEntry, ArdiEvent, ArdiPage, ArdiRef } from "./ardi";

async function refs(api: ArtifactsRest, namespace: string, repo: string): Promise<ArdiRef[]> {
  const request = new Request(`https://git.internal/${repo}.git/info/refs?service=git-upload-pack`);
  const response = await api.git(namespace, repo, "info/refs", request, null, false, false);
  if (!response.ok) throw new HubError(502, "unavailable", "Git refs unavailable");
  try { return parseAdvertisedRefs(new Uint8Array(await response.arrayBuffer()), true); }
  catch { throw new HubError(502, "unavailable", "invalid Git refs"); }
}

export async function artifactRead<T>(env: Env, org: string, authorization: string, verb: string, body: Record<string, unknown>): Promise<ArdiPage<T>> {
  const requested = String(body.repo ?? "");
  const grant = requested.startsWith("agent-src/")
    ? await agentSrcGrant(env, authorization, org, requested.slice(10))
    : await authorizeGit(env, authorization, org, requested);
  if (!grant || typeof grant === "string") throw requested.startsWith("agent-src/")
    ? new HubError(404, "not_found", "repository not found")
    : new HubError(403, "forbidden", "Git access unavailable");
  return artifactReadAuthorized<T>(env, org, grant, verb, body);
}

/** Internal only: the hub may share the live grant it obtained for this request. */
export async function artifactReadAuthorized<T>(env: Env, org: string, grant: GitGrant, verb: string, body: Record<string, unknown>): Promise<ArdiPage<T>> {
  const repo = grant.repository?.storage_name ?? grant.project.slug;
  const repoName = grant.repository && !grant.repository.is_default ? grant.repository.name : "";
  const api = new ArtifactsRest(env), namespace = artifactNamespace(org);
  // Content-addressed data is safe to reuse only after this request's live grant. Include
  // the account and ownership IDs so a reused storage name cannot inherit another repo's data.
  const cacheKey = (kind: string, hash: string, path = "") => new Request(`https://code-immutable.internal/${encodeURIComponent(JSON.stringify([api.account, grant.tenant.id, grant.project.id, repo, kind, hash, path]))}`);
  const immutable = async <V>(kind: string, hash: string, load: () => Promise<V>, path = ""): Promise<V> => {
    const key = cacheKey(kind, hash, path);
    const hit = await caches.default.match(key);
    if (hit) return await hit.json() as V;
    const value = await load();
    await caches.default.put(key, Response.json(value, { headers: { "cache-control": "max-age=604800" } }));
    return value;
  };
  const metadata = async (commit: ArtifactCommit, requireIndexed = false): Promise<ArdiCommit> => {
    const by = await env.HUB_DB.prepare(`/*perf-site:src%2Fcode%2FartifactRead.ts:33:22:metadata:f5f778ba*/
      SELECT e.identity_id, e.session_id FROM (SELECT 1) seed LEFT JOIN code_event e ON e.rowid = (
        SELECT rowid FROM code_event WHERE tenant_id = ?1 AND project_id = ?2 AND repo = ?3 AND kind = 'commit' AND target = ?4 ORDER BY at, ardi_id LIMIT 1)
      WHERE ?5 = 0 OR EXISTS (SELECT 1 FROM repository_commit WHERE tenant_id = ?1 AND project_id = ?2 AND repo = ?3 AND oid = ?4)`)
      .bind(grant.tenant.id, grant.project.id, repoName, commit.hash, requireIndexed ? 1 : 0).first<{ identity_id: string | null; session_id: string | null }>();
    if (requireIndexed && !by) throw new HubError(503, "unavailable", "repository history metadata is not ready");
    return { oid: commit.hash, tree: commit.treeHash, parents: commit.parents, author_name: commit.author.name, author_email: commit.author.email,
      author_time: commit.authoredAt, committer_name: commit.committer.name, committer_email: commit.committer.email, commit_time: commit.committedAt,
      summary: commit.message.split("\n")[0] ?? "", message: commit.message, principal: by?.identity_id ?? null, session: by?.session_id ?? null,
      trailer_principal: null, trailer_session: null };
  };
  const revision = String(body.rev ?? body.ref ?? "HEAD"), path = String(body.path ?? "");
  if (path.split("/").some(segment => segment === "." || segment === "..")) throw new HubError(400, "bad_request", "invalid repository path");
  // These results were populated only after checking the storage ownership marker.
  // A live repository mapping is still mandatory on every hit; refs and HEAD never hit here.
  if (verb === "file.read" && /^[0-9a-f]{40}$/.test(revision)) {
    const hit = await caches.default.match(cacheKey("read", revision, path));
    if (hit) return { result: await hit.json() as T, next: null };
  }
  if (verb === "snapshot" && /^[0-9a-f]{40}$/.test(revision)) {
    const hit = await caches.default.match(cacheKey("snapshot", revision));
    if (hit) return { result: { oid: revision, files: await hit.json() } as T, next: null };
  }
  const liveRefs = (verb === "snapshot" || verb === "log") && !/^[0-9a-f]{40}$/.test(revision) ? refs(api, namespace, repo) : null;
  const snapshotRefs = verb === "snapshot" ? await liveRefs : null;
  const findRef = (all: ArdiRef[], name: string) => {
    const found = all.find(ref => ref.name === name) ?? (!name.startsWith("refs/") ? all.find(ref => ref.name === `refs/heads/${name}`) ?? all.find(ref => ref.name === `refs/tags/${name}`) : undefined);
    return found ? all.find(ref => ref.name === `${found.name}^{}`)?.target ?? found.target : null;
  };
  if (snapshotRefs) {
    const oid = findRef(snapshotRefs, revision);
    if (oid) {
      const hit = await caches.default.match(cacheKey("snapshot", oid));
      if (hit) return { result: { oid, files: await hit.json() } as T, next: null };
    }
  }
  // Like immutable file/snapshot hits, a cached commit was ownership-checked when
  // filled. Resolve the branch live and still check scoped index/attribution now.
  if (verb === "log" && Number(body.limit) === 1 && !body.path && !body.since && revision !== "HEAD") {
    const oid = liveRefs ? findRef(await liveRefs, revision) : revision;
    const hit = oid ? await caches.default.match(cacheKey("commit", oid)) : null;
    const commit = hit ? await hit.json() as ArtifactCommit : null;
    if (commit && commit.hash === oid) {
      return { result: { commits: [await metadata(commit, true)] } as T, next: null };
    }
  }
  const [info, indexedRoot] = await Promise.all([
    api.info(namespace, repo),
    verb === "file.read" && /^[0-9a-f]{40}$/.test(revision)
      ? env.HUB_DB.prepare("SELECT tree_hash FROM repository_commit WHERE tenant_id = ? AND project_id = ? AND repo = ? AND oid = ?")
        .bind(grant.tenant.id, grant.project.id, repoName, revision).first<{ tree_hash: string }>()
      : null,
    liveRefs,
  ]);
  if (info.description !== repoOwnership(grant.tenant.id, grant.project.id)) throw new HubError(503, "unavailable", "repository migration is not ready");
  const page = (result: unknown, next: string | null = null) => ({ result: result as T, next });
  const at = revision;
  let refList: Promise<ArdiRef[]> | null = null;
  const resolve = async (revision: string): Promise<string> => {
    let target = revision;
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      refList ??= liveRefs ?? refs(api, namespace, repo);
      const all = await refList;
      const name = revision === "HEAD" ? `refs/heads/${info.default_branch}` : revision;
      const found = findRef(all, name);
      if (!found) throw new HubError(404, "not_found", "revision not found");target = found;
    }
    // Snapshot decoding verifies the requested commit itself; a log round trip adds
    // no coverage, and cached snapshots have already passed that verification.
    if (verb === "snapshot") return target;
    const commit = await immutable("commit", target, async () => {
      const result = (await api.log(namespace, repo, target, 1))[0];
      if (!result) throw new HubError(404, "not_found", "revision not found");
      return result;
    });
    if (!commit) throw new HubError(404, "not_found", "revision not found");return commit.hash;
  };
  const treeCache = new Map<string, ArtifactsTreeEntry[]>();
  const tree = async (hash: string) => {
    if (!treeCache.has(hash)) treeCache.set(hash, await immutable("tree", hash, () => api.tree(namespace, repo, hash)));return treeCache.get(hash)!;
  };
  const pathEntry = async (root: string, path: string): Promise<ArtifactsTreeEntry | null> => {
    let current = root;
    const segments = path.split("/").filter(Boolean);
    if (segments.some(segment => segment === "." || segment === "..")) throw new HubError(400, "bad_request", "invalid repository path");
    for (let i = 0; i < segments.length; i++) {
      const entry = (await tree(current)).find(item => item.name === segments[i]);
      if (!entry) return null;if (i === segments.length - 1) return entry;
      if (entry.type !== "tree") return null;current = entry.hash;
    }
    return { name: "", hash: root, type: "tree", mode: "40000" };
  };
  const changes = async (before: string | null, after: string, prefix = "", depth = 0): Promise<ArdiChange[]> => {
    if (depth > 64) throw new HubError(413, "too_large", "repository tree too deep");
    const [old, fresh] = await Promise.all([before ? tree(before) : [], tree(after)]);
    const all = new Map<string, { old?: ArtifactsTreeEntry; fresh?: ArtifactsTreeEntry }>([...old.map(entry => [entry.name, { old: entry, fresh: fresh.find(item => item.name === entry.name) }] as const),
      ...fresh.filter(entry => !old.some(item => item.name === entry.name)).map(entry => [entry.name, { old: undefined, fresh: entry }] as const)]);
    const result: ArdiChange[] = [];
    for (const [name, pair] of all) {
      if (pair.old?.hash === pair.fresh?.hash && pair.old?.mode === pair.fresh?.mode) continue;
      const path = prefix + name;
      if (pair.fresh?.type === "tree") {
        if (pair.old && pair.old.type !== "tree") result.push({ path, prev_path: null, prev_blob: pair.old.hash, new_blob: null, kind: "delete" });
        result.push(...await changes(pair.old?.type === "tree" ? pair.old.hash : null, pair.fresh.hash, path + "/", depth + 1));
      }
      else if (pair.old?.type === "tree") {
        const remove = async (hash: string, base: string, level: number): Promise<void> => {
          if (level > 64) throw new HubError(413, "too_large", "repository tree too deep");
          for (const entry of await tree(hash)) {
            if (entry.type === "tree") await remove(entry.hash, base + entry.name + "/", level + 1);
            else result.push({ path: base + entry.name, prev_path: null, prev_blob: entry.hash, new_blob: null, kind: "delete" });
          }
        };
        await remove(pair.old.hash, path + "/", depth + 1);
        if (pair.fresh) result.push({ path, prev_path: null, prev_blob: null, new_blob: pair.fresh.hash, kind: "add" });
      } else result.push({ path, prev_path: null, prev_blob: pair.old?.hash ?? null, new_blob: pair.fresh?.hash ?? null, kind: !pair.old ? "add" : !pair.fresh ? "delete" : "modify" });
    }
    return result;
  };
  if (verb === "refs.list") return page({ refs: (await refs(api, namespace, repo)).filter(ref => ref.name !== "HEAD" && !ref.name.endsWith("^{}")) });
  if (verb === "file.show") {
    const oid = await resolve(at), path = String(body.path ?? "");
    if (path.split("/").some(segment => segment === "." || segment === "..")) throw new HubError(400, "bad_request", "invalid repository path");
    return page(await immutable("file", oid, () => api.file(namespace, repo, oid, path), path));
  }
  if (verb === "file.read" || verb === "tree.list") {
    const oid = indexedRoot ? at : await resolve(at);
    const root = indexedRoot?.tree_hash ?? (await immutable("commit", oid, async () => {
      const result = (await api.log(namespace, repo, oid, 1))[0];
      if (!result) throw new HubError(404, "not_found", "revision not found");
      return result;
    })).treeHash;
    const read = async () => {
      const entry = await pathEntry(root, path);
      if (verb === "file.read" && entry && entry.type !== "tree")
        return immutable("file", oid, () => api.file(namespace, repo, oid, path), path);
      if (!entry || entry.type !== "tree") throw new HubError(404, "not_found", "directory not found");
      return { entries: (await tree(entry.hash)).map(item => ({ name: item.name, oid: item.hash, mode: item.mode,
        kind: item.type === "tree" ? "tree" : item.type === "gitlink" ? "commit" : "blob" } satisfies ArdiEntry)) };
    };
    return page(verb === "file.read" ? await immutable("read", oid, read, path) : await read());
  }
  if (verb === "snapshot") {
    // A commit's files never change, so one fetch per commit serves every later search of it.
    const oid = await resolve(at), key = cacheKey("snapshot", oid);
    const hit = await caches.default.match(key);
    if (hit) return page({ oid, files: await hit.json() });
    const request = new Request(`https://git.internal/${repo}.git/git-upload-pack`, { method: "POST", headers: { "content-type": "application/x-git-upload-pack-request", "git-protocol": "version=2" } });
    const response = await api.git(namespace, repo, "git-upload-pack", request, new Blob([shallowFetchBody(oid)]).stream(), false);
    if (!response.ok) throw new HubError(502, "unavailable", "Git snapshot unavailable");
    let files: SnapshotFile[];
    try { files = snapshotFiles(readPack(packFromResponse(new Uint8Array(await response.arrayBuffer()))), oid); }
    catch { throw new HubError(502, "unavailable", "Git snapshot unreadable"); }
    await caches.default.put(key, Response.json(files, { headers: { "cache-control": "max-age=604800" } }));
    return page({ oid, files });
  }
  if (verb === "commit.show") {
    const commit = await api.readCommit<ArtifactCommit>(namespace, repo, String(body.oid ?? ""));
    const parent = commit.parents[0] ? await api.readCommit<ArtifactCommit>(namespace, repo, commit.parents[0]) : null;
    return page({ ...await metadata(commit), changes: await changes(parent?.treeHash ?? null, commit.treeHash) });
  }
  if (verb === "log") {
    const limit = Math.max(1, Math.min(Number(body.limit) || 20, 100)), path = typeof body.path === "string" ? body.path : null;
    const oid = await resolve(at);
    const head = await immutable("commit", oid, async () => (await api.log(namespace, repo, oid, 1))[0]);
    if (!head) throw new HubError(404, "not_found", "revision not found");
    const cursor = body.since ? String(body.since) : null;
    if (cursor && !/^[0-9a-f]{40}$/.test(cursor)) throw new HubError(400, "bad_request", "invalid history cursor");
    const indexed = await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FartifactRead.ts:130:27:artifactRead:9d06043d*/ SELECT 1 FROM repository_commit WHERE tenant_id = ? AND project_id = ? AND repo = ? AND oid = ?").bind(grant.tenant.id, grant.project.id, repoName, head.hash).first();
    if (!indexed) throw new HubError(503, "unavailable", "repository history metadata is not ready");
    // Opening a review needs only the live branch tip, not its entire ancestry.
    if (limit === 1 && !path && !cursor) return page({ commits: [await metadata(head)] });
    const nodes = (await env.HUB_DB.prepare(`/*perf-site:src%2Fcode%2FartifactRead.ts:132:26:artifactRead:a9639cf3*/ WITH RECURSIVE reachable(oid) AS (
      SELECT ? UNION SELECT parent.value FROM reachable r JOIN repository_commit c ON c.oid = r.oid AND c.project_id = ? AND c.repo = ? JOIN json_each(c.parents_json) parent
    ) SELECT c.oid, c.tree_hash, c.parents_json FROM reachable r JOIN repository_commit c ON c.oid = r.oid AND c.project_id = ? AND c.tenant_id = ? AND c.repo = ? ORDER BY c.generation DESC, c.commit_time DESC, c.oid DESC`)
      .bind(head.hash, grant.project.id, repoName, grant.project.id, grant.tenant.id, repoName).all<{ oid: string; tree_hash: string; parents_json: string }>()).results;
    const position = cursor ? nodes.findIndex(node => node.oid === cursor) : -1;
    if (cursor && position === -1) throw new HubError(400, "bad_request", "history cursor is not reachable from this revision");
    const selected: string[] = [];
    for (const node of nodes.slice(position + 1)) {
      if (path) {
        const parentId = (JSON.parse(node.parents_json) as string[])[0];
        const parent = parentId ? nodes.find(item => item.oid === parentId) : null;
        const [before, after] = await Promise.all([parent ? pathEntry(parent.tree_hash, path) : null, pathEntry(node.tree_hash, path)]);
        if (before?.hash === after?.hash && before?.mode === after?.mode) continue;
      }
      selected.push(node.oid);if (selected.length > limit) break;
    }
    const shown = selected.slice(0, limit);
    return page({ commits: await Promise.all(shown.map(async hash => metadata(await immutable("commit", hash, () => api.readCommit<ArtifactCommit>(namespace, repo, hash))))) }, selected.length > limit ? shown.at(-1)! : null);
  }
  if (verb === "timeline") {
    const since = body.since ? Number(body.since) : null, limit = Math.max(1, Math.min(Number(body.limit) || 100, 1000));
    if (since !== null && !Number.isSafeInteger(since)) throw new HubError(400, "bad_request", "invalid event cursor");
    const seq = since === null ? 0 : Math.max(0, Math.floor((since - 1_000_000_000_000) / 8192));
    const rows = (await env.HUB_DB.prepare(`/*perf-site:src%2Fcode%2FartifactRead.ts:155:25:artifactRead:ff06034b*/ SELECT seq, identity_id, session_id, published_json, commits_json, completed_at FROM git_push WHERE project_id = ? AND tenant_id = ? AND repo = ? AND state = 'complete' AND seq >= ? ORDER BY seq ${since === null ? "DESC" : "ASC"} LIMIT ?`)
      .bind(grant.project.id, grant.tenant.id, repo, seq, limit + 1).all<{ seq: number; identity_id: string | null; session_id: string | null; published_json: string; commits_json: string; completed_at: number }>()).results;
    if (since === null) rows.reverse();
    const events: ArdiEvent[] = rows.flatMap(row => {
      const base = 1_000_000_000_000 + row.seq * 8192;
      const shared = { principal: row.identity_id, session: row.session_id, time: Math.floor(row.completed_at / 1000) };
      const refs = (JSON.parse(row.published_json ?? "[]") as Array<{ ref: string; newOid: string; outcome: string }>).filter(update => update.outcome === "ok");
      const commits = JSON.parse(row.commits_json ?? "[]") as Array<{ hash: string; ref: string; summary: string }>;
      return [...refs.map((update, index) => ({ ...shared, id: base + index, kind: "ref", ref: update.ref, target: update.newOid, summary: null })),
        ...commits.map((commit, index) => ({ ...shared, id: base + 4096 + index, kind: "commit", ref: commit.ref, target: commit.hash, summary: commit.summary }))];
    });
    const eligible = since === null ? events.slice(-limit) : events.filter(event => event.id > since);
    const result = eligible.slice(0, limit);
    return page({ events: result }, eligible.length > limit ? String(result.at(-1)!.id) : null);
  }
  throw new HubError(400, "bad_request", "unsupported repository read");
}
