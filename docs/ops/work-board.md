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

## Request-local quest child aggregation

Quest progress uses one materialized child-count aggregation per board request, in
place of two correlated `work_item` child scans per quest. It groups by parent **and
project**, restricts children to the requested tenant/project and non-channel
projects, then left-joins the active quests in that same scope. Tenant/project
consistency checks remain on both sides. Empty and dropped-only quests report
zero, not one from a synthetic left-join row. Children count directly, not
recursively: a nested quest counts as one child of its parent. Done children still
count regardless of their age or `closed_at`; dropped children do not count.
Quest order and the existing uncapped result contract are unchanged.

`MATERIALIZED` means a temporary result inside this SQL statement, **not** a
persistent table or cross-request cache. Reopens, state changes and reparenting
are reflected on the next read without invalidation machinery. No migration is
required. The query still reads matching child rows and may use a temporary
grouping table; this is not constant-cost access or a demonstrated improvement
for every possible data distribution (for example, one quest with many unrelated
parents).

`test/board-quest-scaling.test.ts` compares actual query results with the previous
correlated SQL for every fixture. Its native-Workers local D1 benchmark has 80
quests and 4,000 children in one project, tested under both organization and
project scopes. `EXPLAIN QUERY PLAN` must materialize child counts with no
correlated subqueries; the previous plan has two correlated subqueries. D1
`meta.rows_read` for the new **quest statement alone** must be less than one tenth
of the previous statement's reads, with identical quest counts (4,000 total,
2,000 done). This deliberately adverse local fixture is read-work evidence, not
a production latency measurement or total page-cost benchmark. Other board
queries, authentication reads and rail work are not included in that ratio.

## Evidence and remaining scope

- `test/board-counts.test.ts`: more than 500 items, all stalled/recent-done items outside the sample, strict time boundaries, empty/exactly-500 completeness, deterministic ties, browser/API/MCP reporting and tenant/project/channel/quest-child boundaries.
- `test/work-list-reads.test.ts`: constant query count across 25 projects, full fields/references, filter parity, parent filters, and malformed rows before LIMIT.
- `test/board-quest-scaling.test.ts`: query-plan/read-work comparison, differential result parity, zero/mixed/dropped/nested/non-quest/old-done children, state/reparent/reopen freshness, absent/channel project scope and malformed tenant/project/parent boundaries; browser/MCP progress compatibility.
- Existing work/page/performance-budget tests cover compatibility of the default non-joined shared statement.

`#109` is **not complete**: rail aggregate caching/materialization and invalidation,
broader large-tenant/many-project distribution and production latency benchmarks,
and uncapped quest-result scaling remain. Counts require independent reads over
matching data; the scoped local quest benchmark does not demonstrate a production
speedup or an indexed large-tenant redesign. No schema migration, persistent
cache, membership/data mutation, mail-auth policy change or scheduler change is
required by these increments.
