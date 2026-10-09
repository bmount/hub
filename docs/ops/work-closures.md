# Recorded closing actors (#140)

The organization and project boards now expose `closures` through `work.board`
(API and MCP) and a **Recorded closures by actor** section in the browser.
This is a count of distinct retained work items for which each actor has a
structured `work.done` event in the selected tenant/project scope. Agents and
humans are labeled separately with identity IDs so duplicate display names are
not merged. This is historical attribution, not current ownership, presence,
work quality or independently verified execution.

## Evidence contract

- `work.create` with initial state `done` and successful transitions from a
  different state to `done` record the authenticated principal/session, never
  the assigned owner. A dropped item is not a completed item; transitioning it
  explicitly to done is a newly recorded completion.
- The work write and structured closure event share a transactional D1 batch.
  The event's insert immediately checks SQLite `changes() = 1`; stale
  snapshot-CAS losers cannot record credit even when another writer wrote
  identical values in the same millisecond. Event insertion failure rolls back
  the work write. Existing general audit/collaboration notification behavior
  remains separate; this increment does not make all side effects atomic.
- Details edits, claims and already-done no-op updates do not create closure
  events. Reopening retains historical closure evidence. Reclosing an item by
  the same actor does not inflate that actor's distinct-item count; different
  genuine closing actors may each have one count for that item. Do not sum
  actor counts as an organization-wide distinct-item total.
- Counts cover all retained recorded time, not the board's two-week done
  column. They exclude removed work, channel-kind projects, foreign tenants,
  inconsistent event/item/project tenant joins and other project scopes.
- The directory shows the top 50 actors ordered by count then identity ID, with
  exact actor total and truncation disclosure independent of the board's
  500-item example sample. Inactive historical actors remain attribution, not
  a claim of active membership. Missing identities are labeled unknown.
- `currently_done_without_record` counts current done items in this scope
  that have **no** structured closure record. This does not estimate all
  historical closures or prove the latest closer. Legacy `work.update` prose,
  current ownership and creator identity are not retroactively interpreted as
  closer proof. The empty state explicitly does not imply nobody closed work.

No schema/migration, real user/member mutations, historical backfill, credential
or runtime changes. Only ordinary future authorized product writes begin this
tracking; tests use disposable synthetic identities/data. This increment is not
a complete historical leaderboard: #140 remains under way pending acceptance
of the prospective coverage and any separately authorized authoritative
historical attribution approach. Unsupported DB-level/import writes without an
authenticated closure actor are not credited automatically.

## Checks

`test/work-closures.test.ts` exercises human/agent API writes, actor versus owner,
creation already done, no-op/reclosure deduplication, multiple real closers,
legacy prose exclusion, same-snapshot winner/loser attribution, transactional
rollback on rejected evidence, reader-write denial, anonymous/nonmember denial,
tenant/project/channel/corrupt-join isolation, escaped actor names and bounded
actor totals/tie ordering. Four attribution/atomicity tests fail against the
previous source; two report tests also fail because the field was absent.

`npm run test:browser:chat` additionally exercises the actual bundled Worker and
synthetic authenticated Chromium at 1440, 390 and 320 pixels. It creates work
assigned to one principal but closed/reclosed by another, checks reader-visible
exact counts and historical caveats, verifies malicious/long directory text is
inert and wraps without page/list overflow, and saves closure-section
screenshots. Existing chat/presence/keyboard/disconnect/isolation checks remain.
No production completion events are manufactured for testing.

The first inspected narrow screenshot showed awkward heading/kind wrapping;
scoped table padding/column widths and the concise `Items` heading were refined,
then the suite rerun. Numeric semantics remain distinct items in the adjacent
coverage disclosure.

#132 remains blocked on native private-no-store persisted BFCache restoration
and genuine headed freeze/resume in an authorized supported-engine/display
fixture. These independent browser checks do not meet that acceptance criterion
or weaken privacy caching. Release/test/rollback evidence is recorded on #140
and in the production deploy record after ordinary main integration.
