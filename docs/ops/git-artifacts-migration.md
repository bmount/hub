# Git Artifacts migration cutover

Pimwell serves tenant repositories from Cloudflare Artifacts through the shared Git proxy. The selector is private database state: a row in `git_repository` marks a completed import, and `GIT_BACKEND=artifacts` makes the proxy serve that row from Artifacts. Unknown repositories and non-Git paths continue to fail closed or go to the hub as before.

The former Ardi source of truth is retired. Its Cloudflare Workers, Durable Object namespaces and R2 buckets have been deleted; the Ardi source repository remains archived on Artifacts.

The standard hub release configuration declares `GIT_BACKEND=artifacts`, `ARTIFACTS_ACCOUNT_ID`, `ARDI_REPO_CREATE=on`, the `GIT_PROXY` service binding to `pimwell-git`, and the `GIT_PUSH_STAGING` R2 binding to `pimwell-git-staging`. `ARTIFACTS_API_TOKEN` is a production secret and is not stored in the Wrangler file. Local Vitest runs derive a temporary Wrangler config from production, but remove only the production Git proxy binding and clear `GIT_BACKEND` so legacy forwarding fixtures stay isolated.

## Repository provisioning

Member-created repo projects provision an Artifacts repository with a tenant/project ownership marker before recording the `git_repository` selector. An existing storage name is accepted only if its ownership marker matches that exact project.

A failed create response is reconciled by reading repository metadata: a matching repository completes the create; confirmed absence rolls the project back. If storage cannot confirm the outcome, the project ID is retained with a private `repo-provision:<tenant>:<project>` marker. Retry `project.create` with the same slug, namespace and repo kind to resume without creating a new ownership ID. Completed projects still reject duplicate creates; archived or deleting projects cannot resume. Project deletion cleans up the pending marker.

Artifacts failures expose the operation, HTTP status, numeric provider error codes and a validated Cloudflare request ID when available. Provider messages, bodies and credentials are never included. Use that evidence to check provider availability and the private API token's permissions; an unknown outcome must not be treated as proof that the repository was never created.

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

The Git transport advertises `HEAD` from the Artifacts repository's configured default branch tip for upload-pack advertisements and protocol v2 `ls-refs`. This keeps ordinary clones on the default branch even when the storage provider has a stale native `HEAD`, including a v2 unborn HEAD pointing to a deleted branch. A genuinely empty default branch stays unborn. Other refs, capabilities, peeled tags and pack streams pass through unchanged. The migrated repositories use `main` as their default branch. The transport reuses the fresh metadata already checked for repository ownership, and overlaps that ownership lookup with scoped storage-token acquisition. Standalone normalization overlaps metadata with Git storage requests; mutable branch tips are never cached. Normalization takes the tip from the same advertisement, with a single default-branch log lookup only if v2 ref-prefix filtering omitted that branch. Capability-only discovery, advertisements without HEAD and unsuccessful storage responses pass through without waiting for metadata.

Scoped Artifacts tokens use a bounded isolate cache plus a short-lived edge cache, so another isolate need not mint the same token again. Edge entries are AES-GCM sealed with a domain-separated key derived from the private Artifacts API credential; both their opaque cache key and authenticated payload bind the account, namespace, repository, scope and API credential. API credential rotation changes the cache namespace. Entries expire at least 30 seconds before the storage token (at most 270 seconds in the edge cache); cache failures or invalid entries fall back to token issuance. Repository creation and project deletion evict both scopes. Every Git request still checks the live caller, memberships, operator, parent credential and storage ownership before returning any repository data; cached storage tokens are never caller authorization.
