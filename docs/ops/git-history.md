# Git history rules

Every push to a Pimwell repository, project or `agent-src` alike, goes through `artifactPush` (`src/code/artifactPush.ts`). It stages the pack in a temporary fork, checks each ref update, and only then publishes. Cloudflare Artifacts itself would accept any rewrite, so these rules live in the push path:

- **Branches only move forward.** An update must contain the old tip in its history. A rewind or divergent update is refused, and the pushed commits are kept under `refs/ardi/forks/…` so nothing is lost.
- **Tags never change** and can't be deleted.
- **Any branch but the default one can be deleted**, merged or not. The push log (`git_push`) keeps the deleted tip, so a branch deleted by mistake can be pushed back while its commits still exist somewhere. Deleting the default branch is refused.

Delete a feature branch once it is merged or abandoned: `git push origin --delete <branch>`. Small changes can go straight to `main`.

A refused update gets `ng <ref> <reason>` in Git's report; the rest of the push still applies unless the client asked for an atomic push. The rules are in `src/code/gitHistory.ts` and are tested in `test/git-history.test.ts` and `test/artifacts-git.test.ts`.
