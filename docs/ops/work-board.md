# Work board counts and list reads

Increment for `pimwell#109`.

## Board contract

`work.board` (API and MCP `work_board`) returns:

- `totals.open`, `totals.doing`, `totals.done`: independently aggregated recorded counts, not array lengths. `done` retains the existing strict `closed_at > request time - 14 days` window. Dropped items and done items without a closing time are excluded.
- `stalled`: all recorded doing items strictly older than seven days, including items missing from the sample. This is not a worker health or execution claim.
- `columns`: examples from the **globally** newest 500 qualifying items, ordered by descending `updated_at`, then descending item ID. This is not 500 items per column, and a busy column can crowd out all examples in another column.
- `examples`: global sample `limit`, `shown`, and `truncated`. Exactly 500 matching records is complete, not automatically truncated.
- `quests`: existing active quest progress. Only children in the quest's own tenant and project count toward progress, including older done children; dropped children are not in the denominator.

Examples, quests and counts are read in one D1 batch. Tenant/project consistency and exclusion of channel projects apply to samples, totals and quest queries. The current tenant reader policy is unchanged; this does not implement project grants.

Browser badges and MCP headings show exact totals. Browser cards are further capped at 60 per column; MCP displays at most 40 open, 40 doing and 20 recent-done examples. Both surfaces state that examples may be incomplete; an empty sample must not claim `None` when the total is positive. List view remains available for filtered browsing.

## Work list contract

`work.list` gets project slugs in its item query, instead of one serial slug lookup per distinct project in the sample. The shared filter builder keeps the existing state, kind, owner, parent, timestamp, limit and ordering behavior. The joined variant requires the project's tenant to match the work row and excludes channel projects **before** applying LIMIT; malformed rows cannot consume the sample or expose another tenant's project slug. API/MCP still return the same work fields, `project` and `ref`.

Native-Workers regression tests meter one item-query round trip for an unfiltered list spanning 25 distinct projects. A project-filtered list uses two trips (project validation and the joined item query), with no per-item or per-project follow-ups. These measurements exclude request authentication/context reads; they are not production latency benchmarks.

## Work inspector evidence links

The inspector opens recorded `commit` references (`project@` plus a full 40-character hex ID) in the commit view, and `item` references (`project#number`) in the work view. Work numbers are positive and at most eight digits. These links stay on the current tenant host; each destination checks the viewer's access. Rendering does not fetch target titles or verify that the target exists.

Short commit IDs, malformed references and other reference kinds remain escaped plain text. External `url` links still require a safe HTTPS URL without credentials. Notes are escaped, and the inspector distinguishes recorded references from verified access or existence.

## Evidence and remaining scope

- `test/board-counts.test.ts`: more than 500 items, all stalled/recent-done items outside the sample, strict time boundaries, empty/exactly-500 completeness, deterministic ties, browser/API/MCP reporting and tenant/project/channel/quest-child boundaries.
- `test/work-list-reads.test.ts`: constant query count across 25 projects, full fields/references, filter parity, parent filters, and malformed rows before LIMIT.
- Existing work/page/performance-budget tests cover compatibility of the default non-joined shared statement.

`#109` is **not complete** with this increment: rail aggregate caching/materialization and invalidation, large-tenant query-plan/latency benchmarks, and evaluation of quest-query scaling remain. Quest results retain their existing uncapped behavior. Counts require independent reads over matching data; do not describe this as a demonstrated production speedup or indexed large-tenant redesign. No schema migration, cache, membership/data mutation, mail-auth policy change or scheduler change is required by this increment.
