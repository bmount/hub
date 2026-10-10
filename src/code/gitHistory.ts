import type { ArtifactCommit } from "./artifactsRest";
import type { RefUpdate } from "./gitProtocol";
import { ZERO_OID } from "./gitProtocol";
import { HubError } from "../errors";

type CommitParents = Pick<ArtifactCommit, "hash" | "parents">;
type ReadLog = (ref: string) => Promise<CommitParents[]>;
const oid = /^[0-9a-f]{40}$/;

/** Artifacts has no protected refs. Prove ancestry in a private fork BEFORE publishing the incoming pack. */
export async function protectGitHistory(updates: RefUpdate[], readLog: ReadLog): Promise<void> {
  let calls = 0;
  const pages = new Map<string, CommitParents[]>();
  for (const update of updates) {
    if (update.newOid === ZERO_OID) throw new HubError(403, "forbidden", "published branches and tags cannot be deleted");
    if (update.oldOid === ZERO_OID || update.oldOid === update.newOid) continue;
    if (update.ref.startsWith("refs/tags/")) throw new HubError(403, "forbidden", "published tags cannot be changed");
    const queue = [update.newOid], seen = new Set<string>();
    let found = false;
    while (queue.length && !found) {
      const head = queue.pop()!;
      if (head === update.oldOid) { found = true; break; }
      if (seen.has(head)) continue;
      let commits = pages.get(head);
      if (!commits) {
        if (++calls > 512) throw new HubError(503, "unavailable", "push ancestry exceeds the validation limit; push fewer commits at a time");
        commits = await readLog(head);
        if (!Array.isArray(commits) || !commits.length || commits.length > 1000 || commits[0]!.hash !== head)
          throw new HubError(502, "unavailable", "cannot verify incoming commit ancestry");
        pages.set(head, commits);
      }
      for (let i = 0; i < commits.length; i++) {
        const commit = commits[i]!;
        if (!oid.test(commit.hash) || !Array.isArray(commit.parents) || commit.parents.some(parent => !oid.test(parent)))
          throw new HubError(502, "unavailable", "invalid incoming commit ancestry");
        if (i && commits[i - 1]!.parents[0] !== commit.hash)
          throw new HubError(502, "unavailable", "discontinuous incoming commit ancestry");
        seen.add(commit.hash);
        if (commit.hash === update.oldOid || commit.parents.includes(update.oldOid)) { found = true; break; }
        for (const parent of commit.parents.slice(1)) if (!seen.has(parent)) queue.push(parent);
      }
      const tail = commits.at(-1)!.parents[0];
      if (!found && tail && !seen.has(tail)) queue.push(tail);
    }
    if (!found) throw new HubError(403, "forbidden", "published history cannot be rewritten; merge or push a new branch");
  }
}
