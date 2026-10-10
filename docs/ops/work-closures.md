# Recorded closing actors

The organization and project boards expose `closures` through `work.board`
(API and MCP) and a **Recorded closures by actor** section in the browser.
Counts show distinct retained work items with structured `work.done` events
per actor in the selected tenant/project scope. Humans and agents are labeled
with identity IDs; duplicate display names are not merged.

The default list shows the top 50 actors, ordered by count then identity ID,
with exact actor total and truncation disclosure. To query a particular actor,
use the browser's **Actor identity ID** field or pass `actor` to `work.board`.
The exact-ID filter applies before the limit, so actors outside the top 50 can
be queried. `closures.actor_id` records the selected filter. The filter does
not change work columns, quest progress or scope-wide historical gaps. A
missing match reveals no directory details and is not proof of zero historical
closures. Clear the filter to return to the top-50 list.

## Attribution

Successful `work.create` calls with initial state `done` and transitions from
another state to `done` record the authenticated principal/session, not the
assigned owner. The work write and structured event share a transactional D1
batch. Event insertion checks SQLite `changes() = 1` immediately after the
work write; stale snapshot-CAS losers cannot record credit. Event failure
rolls back the work write. General audit and collaboration notifications
remain separate.

Details edits, claims and already-done updates do not create closure events.
Reopening retains historical attribution. Reclosing by the same actor does
not inflate their distinct-item count. Different closing actors may each
count the same item, so actor counts must not be summed as an organization-wide
distinct-item total. These counts are not ownership, presence, work quality
or independently verified execution.

Counts cover all retained recorded time, not just the board's two-week done
column. They exclude removed work, channel projects, foreign tenants,
inconsistent event/item/project tenant joins and other project scopes.
Inactive actors retain attribution; missing identities are labeled unknown.

`currently_done_without_record` counts current done items in the selected
scope with no structured closure record, independently of the actor filter.
It does not estimate all historical closures or prove the latest closer.
Legacy audit prose, current owners and creators are not retroactively used
as closer proof. There is no historical backfill. DB-level/import writes
without an authenticated closure actor are not credited automatically.

## Tests

`test/work-closures.test.ts` covers attribution, deduplication, transactional
rollback, stale writers, access boundaries, safe rendering, bounded actor
lists and exact actor filtering. Fixtures use disposable synthetic data;
production completion events are not manufactured for testing.
