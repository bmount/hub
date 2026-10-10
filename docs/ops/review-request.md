# Review-request database failure boundary (#89)

`review.request` (API and MCP `review_request`) validates the project/branch and
reviewer identities/memberships before writing. One D1 `batch` transaction now
contains the numbered review, distinct reviewer assignments, external-reviewer
What-needs-me attention, the `review.request` event, and the returned review
snapshot. Attention links and event summaries derive the actual review number
inside that transaction, scoped to the fresh review ID and tenant. Self-reviewer
assignment remains supported but does not notify the author. No-reviewer requests
still create a review and event; they do not send an empty D1 batch.

A database statement failure in this transaction rolls back all its effects.
No attention or event write, or database lookup of the response snapshot, is
performed after committing the review. The response keeps the existing `ref` and
`review` contract. This requires no schema migration or external notifications.

Native-Workers regressions reproduce the old empty-attention batch failure
(`No SQL statements detected`) and the old committed-review-on-attention/event
failure. Those are proven code paths, **not a diagnosis of the historical live
request** without its corresponding error evidence. Isolated D1 triggers test
rollback at reviewer, attention and event insertion. Concurrent successful
requests obtain distinct review numbers; duplicate reviewer inputs do not create
duplicate assignments or attention.

## Limits and retry rule

This is atomic database creation, **not durable request idempotency**. A committed
batch can still be followed by a lost HTTP/MCP response, database transport
ambiguity, or later dispatch/audit failure. Two explicit requests still create
two reviews, even for identical branch/summary inputs. Do not blindly retry an
ambiguous result: inspect `review_list` / `review_read` (tenant-scoped) and match
author, branch, base, head and creation time first. Existing partially created
reviews are not deleted or retroactively notified by this increment.

#89 remains open for client idempotency keys bound to exact caller/tenant/payload,
read-only exact-key reconciliation, and lost-response/replay/conflict tests.
Deployment status and live acceptance belong in issue/deploy records; this
document describes the code, not a claim of rollout.
