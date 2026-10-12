import { ArtifactsRest, artifactNamespace, type ArtifactCommit } from "./artifactsRest";
import type { GitGrant } from "./gitAccess";
import { authorizeGit } from "./gitAccess";
import { protectGitHistory } from "./gitHistory";
import { saveGitReplay } from "./gitReplay";
import { indexCommitNodes, type CommitNode } from "./gitCommitIndex";
import { packet, parseAdvertisedRefs, peekCommands, refAllowed, replaceCommands, reportOutcomes, ZERO_OID } from "./gitProtocol";
import type { RefOutcome, RefUpdate } from "./gitProtocol";
import type { Env } from "../env";
import { HubError } from "../errors";

export function repoOwnership(tenantId: string, projectId: string): string { return `Pimwell tenant ${tenantId} project ${projectId}`; }

async function responseBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();if (next.done) break;
      size += next.value.length;
      if (size > 1024 * 1024) throw new HubError(502, "unavailable", "Git status response too large");
      parts.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {});throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);let offset = 0;
  for (const part of parts) { result.set(part, offset);offset += part.length; }return result;
}

async function advertisedCommitTargets(api: ArtifactsRest, namespace: string, repo: string, updates: RefUpdate[]): Promise<Map<string, string>> {
  const response = await api.git(namespace, repo, "info/refs", new Request(`https://git.internal/${repo}.git/info/refs?service=git-upload-pack`), null, false);
  if (!response.ok) throw new HubError(502, "unavailable", "Git refs unavailable");
  let refs;
  try { refs = parseAdvertisedRefs(new Uint8Array(await response.arrayBuffer())); }
  catch { throw new HubError(502, "unavailable", "invalid Git refs"); }
  const byName = new Map(refs.map(ref => [ref.name, ref.target]));
  const result = new Map<string, string>();
  for (const update of updates) {
    if (update.newOid !== ZERO_OID) {
      const target = byName.get(`${update.ref}^{}`) ?? byName.get(update.ref) ?? update.newOid;
      result.set(update.ref, target);
    }
  }
  return result;
}

function statusResponse(outcomes: RefOutcome[], capabilities: string[]): Response {
  const parts = [packet("unpack ok\n"), ...outcomes.map(update => packet(`${update.outcome === "ok" ? "ok" : "ng"} ${update.ref}${update.outcome === "ok" ? "" : ` ${update.reason ?? "push outcome unknown; fetch before retrying"}`}\n`)), new TextEncoder().encode("0000")];
  const length = parts.reduce((sum, part) => sum + part.length, 0), report = new Uint8Array(length);
  let offset = 0;for (const part of parts) { report.set(part, offset);offset += part.length; }
  if (!capabilities.some(cap => cap === "side-band" || cap === "side-band-64k"))
    return new Response(report, { headers: { "content-type": "application/x-git-receive-pack-result" } });
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < report.length; start += 1000) {
    const payload = report.subarray(start, start + 1000), header = new TextEncoder().encode((payload.length + 5).toString(16).padStart(4, "0"));
    const frame = new Uint8Array(payload.length + 5);frame.set(header);frame[4] = 1;frame.set(payload, 5);chunks.push(frame);
  }
  chunks.push(new TextEncoder().encode("0000"));
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk);controller.close(); } }), { headers: { "content-type": "application/x-git-receive-pack-result" } });
}

async function defaultBranch(api: ArtifactsRest, namespace: string, repo: string): Promise<string> {
  return `refs/heads/${(await api.info(namespace, repo)).default_branch || "main"}`;
}

/** Any branch but the default can be deleted (pre-release, Brian 2026-10-12); the push log keeps its old tip. */
async function deletableBranch(update: RefUpdate, main: () => Promise<string>): Promise<boolean> {
  return update.ref.startsWith("refs/heads/") && update.oldOid !== ZERO_OID && update.ref !== await main();
}

/** Stage the pack using native Git, prove allowed changes, then replay it to the published repo using Git's old-OID checks. */
export async function artifactPush(request: Request, env: Env, grant: GitGrant, api: ArtifactsRest,
  // Access is checked again before publishing, by the same rule that granted it (project repo or agent source).
  reauthorize: () => Promise<GitGrant | null> = () => authorizeGit(env, request.headers.get("authorization"), grant.tenant.slug, grant.project.slug)): Promise<Response> {
  if (!env.GIT_PUSH_STAGING) throw new HubError(503, "unavailable", "Git push validation storage is not configured");
  if (!request.body) throw new HubError(400, "bad_request", "push body required");
  if (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity")
    throw new HubError(400, "bad_request", "compressed HTTP command bodies are not supported");
  let peeked;
  try { peeked = await peekCommands(request.body); }
  catch { throw new HubError(400, "bad_request", "invalid Git push commands"); }
  const { updates, capabilities, prefixBytes, stream } = peeked;
  // Git probes authentication with a flush-only POST before a large chunked upload.
  if (!updates.length) { await stream.cancel();return new Response(null, { headers: { "content-type": "application/x-git-receive-pack-result" } }); }
  if (updates.some(update => !refAllowed(update.ref, grant.refPrefixes))) {
    await stream.cancel();throw new HubError(403, "forbidden", "push includes a reserved or unauthorized ref");
  }
  const id = crypto.randomUUID(), namespace = artifactNamespace(grant.tenant.slug), repo = grant.project.slug;
  const shadow = `pimwell-stage-${id}`, replayKey = `git-push/${grant.tenant.id}/${grant.project.id}/${id}`;
  const db = env.HUB_DB, storage = env.GIT_PUSH_STAGING;
  await db.prepare(`INSERT INTO git_push (id, tenant_id, project_id, identity_id, session_id, namespace, repo, shadow, replay_key, updates_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?)`)
    .bind(id, grant.tenant.id, grant.project.id, grant.identity.id, grant.session.id, namespace, repo, shadow, replayKey, JSON.stringify(updates), Date.now()).run();
  let disposable = true;
  try {
    await api.fork(namespace, repo, shadow, `Pimwell temporary validation ${id}`);
    const [save, stage] = stream.tee();
    const [, staged] = await Promise.all([saveGitReplay(storage, replayKey, save), api.git(namespace, shadow, "git-receive-pack", request, stage, true)]);
    if (!staged.ok) throw new HubError(502, "unavailable", "Git staging failed");
    const stagedOutcomes = reportOutcomes(await responseBytes(staged), updates);
    if (stagedOutcomes.some(update => update.outcome !== "ok"))
      throw new HubError(409, "conflict", "Git could not stage every ref; fetch before retrying");
    const publish: RefUpdate[] = [], refused = new Map<string, string>(), forks = new Map<string, string>();
    let defaultRef: Promise<string> | undefined;
    let calls = 0;
    for (const update of updates) {
      try {
        await protectGitHistory([update], async ref => {
          if (++calls > 512) throw new HubError(503, "unavailable", "push ancestry validation limit reached");
          return (await api.log(namespace, shadow, ref)).map(commit => ({ hash: commit.hash, parents: commit.parents }));
        }, deletion => deletableBranch(deletion, () => defaultRef ??= defaultBranch(api, namespace, repo)));
        publish.push(update);
      } catch (error) {
        if (!(error instanceof HubError) || error.status !== 403) throw error;
        refused.set(update.ref, error.message);
        if (update.newOid !== ZERO_OID) {
          const fork = `refs/ardi/forks/${update.ref.slice(5)}/${grant.identity.id}-${id}`;
          forks.set(update.ref, fork);publish.push({ oldOid: ZERO_OID, newOid: update.newOid, ref: fork });
        }
      }
    }
    if (refused.size && capabilities.includes("atomic")) {
      const outcomes = updates.map(update => ({ ...update, outcome: "ng" as const, reason: refused.get(update.ref) ?? "atomic push rejected" }));
      await db.prepare("UPDATE git_push SET state = 'refused', outcomes_json = ?, completed_at = ? WHERE id = ?").bind(JSON.stringify(outcomes), Date.now(), id).run();
      return statusResponse(outcomes, capabilities);
    }
    // Revocation during staging must prevent publishing, without exposing the storage credential.
    const current = await reauthorize();
    if (!current?.write || updates.some(update => !refAllowed(update.ref, current.refPrefixes)))
      throw new HubError(403, "forbidden", "Git access ended before publishing");
    const outcomes: RefOutcome[] = updates.map(update => ({ ...update, outcome: "ng", reason: refused.get(update.ref) }));
    const refTargets = await advertisedCommitTargets(api, namespace, shadow, publish);
    const introduced: Array<CommitNode & { summary: string; ref: string }> = [];
    const visited = new Set<string>();
    for (const update of publish) {
      const target = refTargets.get(update.ref);if (!target) continue;
      const queue = [target];
      while (queue.length) {
        const hash = queue.pop()!;if (visited.has(hash)) continue;visited.add(hash);
        if (++calls > 900) throw new HubError(503, "unavailable", "push metadata validation limit reached; push fewer commits at a time");
        try { await api.readCommit(namespace, repo, hash);continue; }
        catch (error) { if (!(error instanceof HubError) || error.status !== 404) throw error; }
        if (++calls > 900) throw new HubError(503, "unavailable", "push metadata validation limit reached; push fewer commits at a time");
        const commit = await api.readCommit<ArtifactCommit>(namespace, shadow, hash);
        introduced.push({ hash, treeHash: commit.treeHash, parents: commit.parents, committedAt: commit.committedAt, summary: commit.message.split("\n")[0]!.slice(0, 300), ref: update.ref });
        for (const parent of commit.parents) queue.push(parent);
      }
    }
    await indexCommitNodes(db, grant.tenant.id, grant.project.id, introduced);
    await db.prepare("UPDATE git_push SET commits_json = ? WHERE id = ?").bind(JSON.stringify(introduced), id).run();
    let actual: RefOutcome[] = [];
    if (publish.length) {
      const saved = await storage.get(replayKey);
      if (!saved) throw new HubError(503, "unavailable", "Git replay unavailable");
      await db.prepare("UPDATE git_push SET state = 'publishing' WHERE id = ?").bind(id).run();
      disposable = false; // An ambiguous upstream response must retain the durable recovery record and pack.
      const canonical = await api.git(namespace, repo, "git-receive-pack", request, replaceCommands(saved.body, prefixBytes, publish, capabilities), true);
      if (!canonical.ok) throw new HubError(502, "unavailable", "Git publishing response unavailable; fetch before retrying");
      actual = reportOutcomes(await responseBytes(canonical), publish);
      for (const outcome of outcomes) {
        // A refusal with nothing saved in its place stays a refusal, with its reason.
        if (refused.has(outcome.ref) && !forks.has(outcome.ref)) continue;
        const ref = forks.get(outcome.ref) ?? outcome.ref, result = actual.find(update => update.ref === ref);
        if (forks.has(outcome.ref)) {
          outcome.reason = `${refused.get(outcome.ref)}${result?.outcome === "ok" ? `; saved as ${ref}` : ""}`;
        } else { outcome.outcome = result?.outcome ?? "unknown";outcome.reason = result?.reason; }
      }
    }
    const state = actual.some(update => update.outcome === "unknown") || outcomes.some(update => update.outcome === "unknown") ? "unknown" : "complete";
    const accepted = new Set(actual.filter(update => update.outcome === "ok").map(update => update.ref));
    const commits = introduced.filter(commit => accepted.has(commit.ref));
    const row = await db.prepare("SELECT seq, identity_id FROM git_push WHERE id = ?").bind(id).first<{ seq: number; identity_id: string | null }>();
    const now = Date.now();
    const events = commits.map((commit, index) => db.prepare(`INSERT OR IGNORE INTO code_event (tenant_id, project_id, ardi_id, kind, identity_id, session_id, ref, target, summary, at) VALUES (?, ?, ?, 'commit', ?, ?, ?, ?, ?, ?)`)
      .bind(grant.tenant.id, grant.project.id, 1_000_000_000_000 + row!.seq * 8192 + 4096 + index, row!.identity_id, grant.session.id, commit.ref, commit.hash, commit.summary, now));
    for (let offset = 0; offset < events.length; offset += 100) await db.batch(events.slice(offset, offset + 100));
    await db.prepare("UPDATE git_push SET state = ?, outcomes_json = ?, published_json = ?, commits_json = ?, completed_at = ? WHERE id = ?").bind(state, JSON.stringify(outcomes), JSON.stringify(actual), JSON.stringify(commits), now, id).run();
    disposable = state === "complete";
    return statusResponse(outcomes, capabilities);
  } catch (error) {
    await db.prepare("UPDATE git_push SET state = ?, completed_at = ? WHERE id = ?").bind(disposable ? "refused" : "unknown", Date.now(), id).run().catch(() => {});
    throw error;
  } finally {
    if (disposable) {
      await stream.cancel().catch(() => {});
      await storage.delete(replayKey).catch(() => {});
      await api.deleteTemporary(namespace, shadow, id).catch(() => {});
    }
  }
}
