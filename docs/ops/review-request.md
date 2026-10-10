# Review requests

`review.request` (API and MCP `review_request`) validates the project, branch and
reviewer memberships before creating a review. One D1 transaction contains the
numbered review, distinct reviewer assignments, external-reviewer What-needs-me
attention, the `review.request` event and the response snapshot. Statement failures
roll back all these effects. Attention links and event summaries use the actual
review number. Self-reviewers are assigned but not notified; no-reviewer requests
never send an empty D1 batch.

## Safe retries

Persist an `idempotency_key` (1–64 characters) and the request before sending.
Reuse both on retry. Keys are bound to the tenant and caller identity, not the
session, and retained indefinitely. An exact retry returns the original `ref` and
`review` snapshot with `replayed: true`, without reading the branch or repeating
assignments, attention or events. The snapshot is creation evidence, not current
review status; use `review_read` for current status and comments.

Binding covers the resolved project ID, parsed branch/base, title, summary and
reviewer list, including its order and spelling. Defaults and the `refs/heads/`
prefix are normalized by parsing. A changed intent with the same key returns a
conflict, including when two different intents race. Concurrent exact retries
create one review. Caller authorization and active project checks still apply
before returning a snapshot. Invalid or corrupt durable records fail closed.

The key and snapshot are stored together with the creation effects in the existing
D1 `meta` table, under `review_request:v1:<tenant>:<caller>:<key digest>`. No schema
migration is required. Tenant deletion removes only that tenant's records. There
are no outbound notifications or automatic expiry/reclaim operations.

Without a key, each request creates a new review. After an ambiguous response,
inspect `review_list` / `review_read` and match author, branch, base, head and
creation time before deciding to create another. Old reviews are not retroactively
bound to new keys or repaired. Database atomicity alone cannot prevent a lost
HTTP/MCP response, so callers must persist keys for new requests.
