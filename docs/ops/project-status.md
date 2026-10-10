# Project status evidence contract

`project.status` (API), `project_status` (MCP) and `/<project>/status` (browser) report recorded evidence only. They do not certify healthy operation, complete ingestion, upstream Git synchronization or absence of real-world activity.

## Period and examples

- `since` defaults to seven days. `as_of` is the request's clock time; period timestamp predicates are inclusive `[since, as_of]`. Future-dated and older records are not period activity.
- Independent `totals` count matching records, not example-array lengths. Counts and examples are read in one D1 batch transaction. The project must belong to the caller's tenant; records are also tenant/project constrained.
- `filed` uses work creation timestamps; `finished` uses the current recorded close timestamps (including dropped work); `reviews` uses the latest update timestamp. These are record counts, not historical counts of all state transitions.
- `doing` is a current-state inventory, **not** period activity. A stalled example has not been updated for more than seven days. The period does not restrict this inventory.
- `deploys` counts recorded version sightings/manual deploy records, not independently verified external rollouts. `commits.count` counts mirrored commit records. Mail counts only admitted project mail; comments count scoped work-comment records.
- Example caps: 50 each for filed/finished/doing, 20 each for deploys/errors/reviews, 10 recent commits. `examples` contains `shown`, `limit` and `truncated` for each collection. MCP text uses smaller display caps (8 filed/finished, 5 deploys/errors), and discloses truncation at those actual caps. Browser headings show independent totals and describe displayed examples.
- The existing example arrays and commit/mail/comment counts remain. Consumers must use `totals` and `examples` instead of interpreting array length as a total.

## Evidence navigation

Deploy and error examples retain their record `id`. Browser links open `/apps?d=<encoded-id>` and `/apps?g=<encoded-id>`; API/MCP callers can use `deploy_read` or `trace_read`. Recent commit examples retain a normalized full `oid` and `href` when supported. Missing, short or malformed mirrored targets give null fields, not guessed links. A full target remains visible but has no code link for trackers or ambiguous repository slugs, including archived duplicates. Archived unambiguous repository history remains linkable.

Navigation does not establish destination existence, access, live deployment or causation; each destination checks its own access. MCP text carries recorded IDs and supported full references alongside the same totals and cap disclosures. The browser's status-list key reflects refreshed evidence, so a subsequent read does not retain stale example titles. No target fetching, model calls or writes are added to status reads.

## Errors: unknown occurrences, observed groups

An old error group with `last_seen` in the period is included, even if its `first_seen` predates the period. `totals.errors` counts groups last observed in the period, not newly created groups. Ordering is latest observation, not lifetime popularity.

There is **no exact per-group period occurrence ledger** today. Ingestion stores at most three samples per group per batch, retains only fifty recent samples per group, and keeps a lifetime count. Neither retained samples nor lifetime counts can establish period occurrences.

- `totals.error_occurrences` and each group's `period_count` are explicitly `null` (unknown), including when there are zero groups.
- Each error example exposes `lifetime_count` (replaces the misleading bare `count`), `period_samples` (retained sampled events in the period), and `first_seen`/`last_seen`.
- Rendering labels these units explicitly; it never displays lifetime counts as period error totals.
- This is not a universal error detector. Unregistered/inactive sources, dropped telemetry, sampling, retention and timestamp validity affect observations. Historical period group coverage is limited to each group's current last-observed timestamp; it is not an immutable group-activity ledger.

## Coverage and freshness

`coverage` includes registered and active source counts, active sources that never received telemetry, active sources whose latest receive time falls in the period, oldest/latest active last-received times, and the latest mirrored commit timestamp. Pending/disabled sources are not active observations. Null timestamps mean no corresponding observation, not healthy silence. `last_event_at` is an ingestion receive timestamp, not proof of continuous monitoring or an event-occurrence timestamp. Latest mirrored commit time is not a Git synchronization watermark.

API, MCP and browser always disclose these limits, including for empty projects. No models, new migrations, retention changes, real data operations or authentication changes are needed for this reporting increment.

## Regression evidence

`test/status-period.test.ts` exercises totals above the 50/20/10 caps and the MCP's smaller caps, recurring old groups, period sample/lifetime separation, inclusive time boundaries and future exclusion, admitted-only mail, freshness for stale/unseen/pending/disabled sources, browser rendering, reader access, anonymous denial, same-slug cross-tenant projects and malformed cross-tenant aggregate/sample rows. Existing status/reviewer tests remain intact.
