# Git history rules

Every push to a Pimwell repository, project or `agent-src` alike, goes through `artifactPush` (`src/code/artifactPush.ts`). It stages the pack in a private, repository-owned validation cache, checks each ref update, and only then publishes. Cloudflare Artifacts itself would accept any rewrite, so these rules live in the push path:

- **Branches only move forward.** An update must contain the old tip in its history. A rewind or divergent update is refused, and the pushed commits are kept under `refs/ardi/forks/…` so nothing is lost.
- **Tags never change** and can't be deleted.
- **Any branch but the default one can be deleted**, merged or not. The push log (`git_push`) keeps the deleted tip, so a branch deleted by mistake can be pushed back while its commits still exist somewhere. Deleting the default branch is refused.

Delete a feature branch once it is merged or abandoned: `git push origin --delete <branch>`. Small changes can go straight to `main`.

A refused update gets `ng <ref> <reason>` in Git's report; the rest of the push still applies unless the client asked for an atomic push. The rules are in `src/code/gitHistory.ts` and are tested in `test/git-history.test.ts` and `test/artifacts-git.test.ts`.

## Large pushes and recovery

Initial pushes retain original history, vendored files and tags; there is no squash or stripped-source requirement. The HTTP replay limit is 100 MiB (commands plus compressed pack), not the unpacked checkout size. A ~65 MiB, 11,999-object, 33-commit repository fits. Ancestry validation permits at most 512 log requests; metadata validation has a 900-call ceiling. Larger histories can be sent in fast-forward batches without changing commit IDs.

The first push creates an owned validation cache by forking the existing repository. Later pushes reuse its objects, not its mutable canonical refs: each attempt stages under unique private `refs/tags/pimwell-stage-<push UUID>/<index>` refs. Native Git verifies the incoming pack there; ancestry is checked by object ID, and publication still sends the client's original old-OID/ref commands to the canonical repository. Concurrent attempts cannot overwrite each other's validation refs, and only canonical old-OID compare-and-swap can publish. Access is checked again before publication. Cache ownership and storage mapping are verified on every use, including readback after racing first-fork creation. Internal validation advertisements skip HEAD normalization and its unrelated metadata requests.

Private validation refs remain reachable so future thin packs can use previously published objects, including after canonical branch deletion. They are not exposed through canonical Git/ref APIs. Successful/refused replay packs are discarded as before; routine cleanup never deletes the shared object cache. Project and organization deletion discard replay data without treating a shared cache as a per-attempt temporary fork; deleting its owning repository deletes the cache too, after checking both ownership markers. A cold cache still pays the initial copy cost; large initial upload/pack processing is not made constant-time by cache reuse.

Fork requests have a 90-second deadline; other REST requests have a 20-second deadline. Native Git requests, including their status-body reads, have a 120-second deadline. All upstream work for a push shares a five-minute budget. Uploads, storage and cleanup also consume time; clients should not impose a 90-second total timeout on a large initial push. Upload completion alone is not publication evidence.

Transient upstream failures return a Git `ng` report naming the phase and push ID, rather than misleading success. A failure before publication records `refused`; a lost publishing response records `unknown` and retains the replay pack and private validation refs. Pimwell does not blindly retry a write with an ambiguous result. Before retrying, run `git ls-remote <remote>`, compare **each** branch/tag ID to the intended IDs, then fetch. If the IDs already match, publication succeeded despite the lost response; otherwise retry from the advertised tips without force-pushing. `repo_branches`, `repo_log` and `repo_file`, plus a fresh clone, provide independent readback. The durable `git_push` row records outcomes and the push ID for operator diagnosis; unknown/publishing records are never removed by routine staging cleanup.
