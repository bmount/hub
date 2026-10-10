# Git Artifacts migration cutover

Pimwell can route a tenant repository either to the legacy Ardi host or to Cloudflare Artifacts. The selector is private database state: a row in `git_repository` marks a completed import, and `GIT_BACKEND=artifacts` makes the shared Git proxy serve that row from Artifacts. Repositories without a completed import, unknown repositories and non-Git paths continue to use the legacy path or the hub as before.

## Legacy write fence

`git_repository.legacy_write_fenced_at` is the per-repository legacy write fence. When it is set, the shared Git proxy refuses new legacy `git-receive-pack` requests for that repository with 403. Fetch, clone and upload-pack still forward to Ardi. Unmigrated repositories are not fenced.

Before the fence is set, legacy receive-pack requests for imported repositories are recorded in `git_legacy_forward`. A row starts as `forwarding`. It changes to `complete` only after the upstream Ardi response body has finished streaming through the proxy. If the upstream dispatch, stream or client cancellation is ambiguous, the row becomes `unknown`. Operators must treat `forwarding` and `unknown` as not drained; elapsed time and HTTP 200 are not completion proof.

There is no public status endpoint for this state. Operators inspect and update D1 through private operational access.

## Safe cutover shape

For each repository:

1. Set `legacy_write_fenced_at` in `git_repository` while the shared proxy still routes the repository to Ardi.
2. Wait until the repository has no `git_legacy_forward` rows in `forwarding` or `unknown`.
3. Make the final source-side copy from Ardi into Artifacts.
4. Verify the Artifacts repository ownership marker and refs.
5. Atomically select Artifacts with the completed import selector and the proxy configuration.

The proxy fence only covers requests that reach the shared proxy. It does not stop pushes already sent to an older hub or route before shared-proxy routing is effective. The source side also refuses writes with Ardi's private per-repository receive-pack fence. Setting that fence enters the repository Durable Object's concurrency gate; when the call returns fenced, earlier receive-pack work in that object has completed, and later receive-pack requests return read-only. Keep the source fence held until Artifacts is selected.

The private cutover operator is `/home/pio/pio/artifacts-cutover-operator.py`. Its default mode is dry-run: it writes before/after manifests and SQL under `/home/pio/.auth/artifacts-cutover`, derives commit metadata from the verified local mirrors, and prints only non-secret paths. `--execute` is reserved for supervised cutover and applies only the four MCC repositories.

Rejected non-fast-forward Artifacts pushes may preserve the proposed tip under `refs/ardi/forks/...`. Metadata collection now follows the renamed fork ref by the proposed object id when that ref is not present in the staging advertisement.
