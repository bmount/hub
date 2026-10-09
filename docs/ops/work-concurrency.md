# Work edit and claim concurrency

`work.update` and `work.claim` use a schema-free compare-and-swap against the
snapshot read by the command. The SQL write is scoped to item, tenant and
project and matches all derived mutable fields (including null owner, parent,
lease and close time), plus `updated_at`. This detects membership-removal writes
that clear ownership without advancing the timestamp. Exactly one affected row
is required; a losing/missing-row write returns a conflict, not a fabricated
successful item. Audit, following and attention are not executed for that loss.

Claim additionally requires **current SQL state** `open` or `doing` and an
unassigned/same owner or absent/expired lease. A stale claim never implicitly
reopens a closed item. Reopening remains an explicit update from the current
closed snapshot. Reassignment clears the previous owner's lease; the new owner
must claim their own lease. Closing clears the lease and records the close time;
details edits on closed items preserve that time.

These writes advance `updated_at` to at least the previous value plus one, even
for same-millisecond/no-op writes or a request with an earlier clock. It is a
revision token for these writes, not a claim of an independently observed
wall-clock time.

## Stale clients

Both API commands and MCP tools accept optional `expected_updated_at`, the
integer `updated_at` returned by `work_read`. Single-item browser edit, state
and claim forms submit the rendered value automatically. A mismatch returns
HTTP 409 before any mutation/notification. Clients should refresh, reconcile
the user's intended edit with the current item, and submit the new revision;
never automatically replay a stale whole-form edit.

Existing clients may omit this field for compatibility. Their server-side
read/write race is still protected, but they do not get protection for changes
made *before* their command read the current item. The revision is not an
idempotency key: a repeat after an ambiguous success can conflict, and the
caller must inspect the current record instead of assuming it failed.

## Scope and remaining boundaries

The existing bulk verb delegates to the single-item update, so each write has
the same snapshot protection. Bulk requests still have partial-result semantics
and no per-item browser-rendered revision; atomic/job semantics remain #115.
Successful mutation and its later audit/notification are not one transaction;
post-write failures still require reconciliation rather than blind retries.
This increment does not claim durable command-response deduplication or an
atomic notification outbox.

Native Workers/D1 tests in `test/work-concurrency.test.ts` cover close/claim and
close/edit interleavings, competing writers, same-millisecond/ABA snapshots,
lease renewal/takeover/removal, null fields, wrong scope and vanished rows.
Native ignored-write fixtures verify rejected commands produce no audit,
following or attention. API revision validation and stale browser form
regressions are tested without modifying real memberships or work data.
