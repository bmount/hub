# Git Artifacts migration cutover

Pimwell serves tenant repositories from Cloudflare Artifacts through the shared Git proxy. The selector is private database state: a row in `git_repository` marks a completed import, and `GIT_BACKEND=artifacts` makes the proxy serve that row from Artifacts. Unknown repositories and non-Git paths continue to fail closed or go to the hub as before.

The former Ardi source of truth is retired. Its Cloudflare Workers, Durable Object namespaces and R2 buckets have been deleted; the Ardi source repository remains archived on Artifacts.

The standard hub release configuration declares `GIT_BACKEND=artifacts`, `ARTIFACTS_ACCOUNT_ID`, `ARDI_REPO_CREATE=on`, the `GIT_PROXY` service binding to `pimwell-git`, and the `GIT_PUSH_STAGING` R2 binding to `pimwell-git-staging`. `ARTIFACTS_API_TOKEN` is a production secret and is not stored in the Wrangler file. Local Vitest runs derive a temporary Wrangler config from production, but remove only the production Git proxy binding and clear `GIT_BACKEND` so legacy forwarding fixtures stay isolated.

## Legacy write fence

`git_repository.legacy_write_fenced_at` is the historical per-repository legacy write fence used during the cutover. When it was set, the shared Git proxy refused new legacy `git-receive-pack` requests for that repository with 403 while fetches still drained from Ardi.

Before the fence is set, legacy receive-pack requests for imported repositories are recorded in `git_legacy_forward`. A row starts as `forwarding`. It changes to `complete` only after the upstream Ardi response body has finished streaming through the proxy. If the upstream dispatch, stream or client cancellation is ambiguous, the row becomes `unknown`. Operators must treat `forwarding` and `unknown` as not drained; elapsed time and HTTP 200 are not completion proof.

There is no public status endpoint for this historical state. Operators inspect D1 through private operational access when auditing the cutover.

## Safe cutover shape

The completed cutover shape was:

1. Set `legacy_write_fenced_at` in `git_repository` while the shared proxy still routed the repository to Ardi.
2. Wait until the repository had no `git_legacy_forward` rows in `forwarding` or `unknown`.
3. Make the final source-side copy from Ardi into Artifacts.
4. Verify the Artifacts repository ownership marker and refs.
5. Atomically select Artifacts with the completed import selector and the proxy configuration.

The proxy fence only covered requests that reached the shared proxy. It did not stop pushes already sent to an older hub or route before shared-proxy routing was effective. The source side also refused writes with Ardi's private per-repository receive-pack fence until Artifacts was selected.

The private cutover operator is `/home/pio/pio/artifacts-cutover-operator.py`. Its default mode is dry-run: it writes before/after manifests and SQL under `/home/pio/.auth/artifacts-cutover`, derives commit metadata from the verified local mirrors, and prints only non-secret paths. `--execute` is reserved for supervised cutover and applies only the four MCC repositories.

Rejected non-fast-forward Artifacts pushes may preserve the proposed tip under `refs/ardi/forks/...`. Metadata collection now follows the renamed fork ref by the proposed object id when that ref is not present in the staging advertisement.

The Git transport advertises `HEAD` from the Artifacts repository's configured default branch tip for upload-pack advertisements and protocol v2 `ls-refs`. This keeps ordinary clones on the default branch even when the storage provider has a stale native `HEAD`. Other refs, capabilities, peeled tags and pack streams pass through unchanged. The migrated repositories use `main` as their default branch.
