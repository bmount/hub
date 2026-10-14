# Git history rules

Every push to a Pimwell repository, project or `agent-src` alike, goes through `artifactPush` (`src/code/artifactPush.ts`). It stages the pack in a temporary fork, checks each ref update, and only then publishes. Cloudflare Artifacts itself would accept any rewrite, so these rules live in the push path:

- **Branches only move forward.** An update must contain the old tip in its history. A rewind or divergent update is refused, and the pushed commits are kept under `refs/ardi/forks/…` so nothing is lost.
- **Tags never change** and can't be deleted.
- **Any branch but the default one can be deleted**, merged or not. The push log (`git_push`) keeps the deleted tip, so a branch deleted by mistake can be pushed back while its commits still exist somewhere. Deleting the default branch is refused.

Delete a feature branch once it is merged or abandoned: `git push origin --delete <branch>`. Small changes can go straight to `main`.

A refused update gets `ng <ref> <reason>` in Git's report; the rest of the push still applies unless the client asked for an atomic push. The rules are in `src/code/gitHistory.ts` and are tested in `test/git-history.test.ts` and `test/artifacts-git.test.ts`.

## Large pushes and recovery

Initial pushes retain original history, vendored files and tags; there is no squash or stripped-source requirement. The HTTP replay limit is 100 MiB (commands plus compressed pack), not the unpacked checkout size. A ~65 MiB, 11,999-object, 33-commit repository fits. Ancestry validation permits at most 512 log requests; metadata validation has a 900-call ceiling. Larger histories can be sent in fast-forward batches without changing commit IDs.

Validation forks copy the existing repository, so even a small incremental push can take longer than a small initial push. Fork requests have a 90-second deadline; other REST requests have a 20-second deadline. Native Git requests, including their status-body reads, have a 120-second deadline. All upstream work for a push shares a five-minute budget. Uploads, storage and cleanup also consume time; clients should not impose a 90-second total timeout on a large initial push. Upload completion alone is not publication evidence.

Transient upstream failures return a Git `ng` report naming the phase and push ID, rather than misleading success. A failure before publication records `refused`; a lost publishing response records `unknown` and retains the replay pack and validation fork. Pimwell does not blindly retry a write with an ambiguous result. Before retrying, run `git ls-remote <remote>`, compare **each** branch/tag ID to the intended IDs, then fetch. If the IDs already match, publication succeeded despite the lost response; otherwise retry from the advertised tips without force-pushing. `repo_branches`, `repo_log` and `repo_file`, plus a fresh clone, provide independent readback. The durable `git_push` row records outcomes and the push ID for operator diagnosis; unknown/publishing records are never removed by routine staging cleanup.
