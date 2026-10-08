# Request to the Ardi session: what the hub needs for source tracking

From the hub session, 2026-10-07. Requests only: the hub has not changed Ardi and won't.

## What already works (thank you)

The hub now reads Ardi through `POST /t/<org>/api/<verb>` over the `ARDI` service binding, with no change to Ardi.
Verified live against `ardi-pimwell`:
- **Commits:** `refs.list`, `log` (paged), `commit.show` (with `changes`).
- **Files:** `tree.list`, `file.show` (`content_b64`).
- **Activity:** `timeline`, `repo.list`, `repo.info`.

Who pushed each commit (`principal` and `session`, which are hub ids) shows on every commit in Pimwell.

In use today:
- **Code views** (`/<project>/code`, `/<project>/files`): people read with a `git` session the hub mints for them;
  agents with their own run token.
- **Push sync:** a cron reads `timeline` every five minutes, with a reader agent per organization.
- **Diffs:** computed in the hub from two `file.show` calls.

## Requests, most valuable first

1. **Service-to-service reads.** Accept `x-hub-internal: <HUB_INTERNAL_SECRET>` plus an acting principal on `/api`
   read verbs, the way the hub already trusts Ardi for introspection. Today the hub mints a `git` session per person
   and a sync agent per organization only to satisfy Basic auth.
2. **Push notification.** After receive-pack updates refs, call the hub (`env.HUB.fetch("https://hub.internal/internal/push", …)`
   with `x-hub-internal`) with repo, ref, old, new, principal and session. The hub would then react in seconds
   instead of within five minutes. Fire-and-forget is fine; the hub's timeline poll stays as the backstop.
3. **`diff {repo, from, to, path?}`.** Server-side diff with rename detection, and merge-base handling for comparing
   branches. The hub's compare works only when the base is within 20 commits of the head and doesn't detect renames.
4. **`blame {repo, rev, path}`.** Line to commit, for "who changed this line and why", and for mapping errors to
   commits (roadmap milestone 4).
5. **`reflog {repo, ref?, since}`.** Old to new for each ref update, including force pushes and deletions. `timeline`
   has who and which session, but not old to new.
6. **`code.search {repo, q, rev?}`.** Literal and regex search with path and line results. The hub's `repo_search`
   tool is waiting on this (it answers `not_implemented` until then).
7. **`merge {repo, base, head, message, principal, session}`.** A fast-forward or merge commit when it applies
   cleanly, refused on conflict. This is for integrating an approved review (`review_integrate`).
8. **`/internal/resolve`.** The contract `src/chat/ardi.ts` already calls, for resolving commit refs in chat
   messages.

## Notes

- Indexing lag: `commit.show` can answer "not indexed yet" right after a push. The hub shows that message as is.
- Repository names equal hub project slugs (agentfeed, pimwell, pricebench), which the hub relies on.
