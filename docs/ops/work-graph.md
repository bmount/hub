# The work graph

Work items can depend on each other. A **hard dependency** says "this item can't start until that one is done". The hub uses these edges to compute what's ready, what's blocked, and what to do next. People and agents get the same answers on every surface: pages, `/api`, MCP and the CLI all call the same verbs.

Parents (`parent`, the quest an item belongs to) and links (`work.link`) are informational. They never block anything.

## Using it

| Verb | What it does |
|---|---|
| `work.depend` `{id, on, remove}` | Make `id` wait on the items in `on`, or stop waiting on those in `remove`. All of it applies or none does. |
| `work.create` `{…, after, priority, estimate}` | File an item that waits on `after` from the start. |
| `work.update` `{…, priority, estimate}` | Priority 0 (urgent) to 3 (low), default 2. Estimate in hours. |
| `work.resources` `{id, resources}` | What the item needs while under way, e.g. `"prod-db, replica:shared"`. Exclusive unless marked `:shared`. |
| `work.graph` `{id}` or `{project}` | For one item: what it waits on and what waits on it, direct and all the way. Otherwise: the open items in dependency order. |
| `work.frontier` `{project, limit}` | What can start now, best first, with counts of what is blocked, claimed or waiting for a resource. Also lists work stuck behind dropped items. |
| `work.claim` / `work.release` | Take an item for an hour (claim again to renew) / hand it back to open. |
| `work.delete` `{id, confirm}` | Delete an item for good. `confirm` repeats its `project#number`. |

`work.read` and `work.list` show each item's readiness too.

## Readiness

Lifecycle state (open, doing, done, dropped) is what people and agents set. Readiness is computed from the graph whenever it is read, so it is never stale:

- **closed**: done or dropped.
- **blocked**: a hard prerequisite is not done. Dropped doesn't count as done: dependents of a dropped item stay blocked until someone removes the dependency or reopens the prerequisite. `work.frontier` lists these items as stuck.
- **claimed**: someone holds a live claim.
- **conflict**: another live claim holds a resource this item needs, and at least one side is exclusive.
- **ready**: none of the above. An item whose claim has expired is ready again.

`work.claim` checks all of this in the single SQL statement that takes the claim (`claimWork` in `src/db/work.ts`). Two claimers can't both win. A dependency added a moment before the claim blocks it, and a refused claim says why. Adding or removing a dependency also bumps the dependent's `updated_at`, so a claim prepared from an older read is refused as stale.

## Ranking

`work.frontier` orders ready items by:

1. priority;
2. the longest chain of open work from the item to the end, counting estimates in hours (unknown counts as 1, done items as 0);
3. how many open items wait on it, directly or not;
4. the shortest estimate;
5. age.

The pure functions are in `src/work/graph.ts`.

## Keeping the graph consistent

Every change to dependency edges, including deleting an item, goes through `commitGraphEdit` in `src/work/graphEdit.ts`. It reads the tenant's edges and graph revision in one snapshot, checks the change against the whole graph, and refuses it with the cycle spelled out if one would form. It then commits the change, its audit events and revision + 1 in one D1 batch.

Two edits computed from the same revision can't both commit: the second fails the revision's primary key, its batch rolls back, and it is recomputed against the new graph (up to four tries). A change that refers to a vanished item rolls back the same way. Nothing is ever half applied.

## Deleting

`work.delete` removes the item together with its dependencies (both directions), resources, links, comments and attention entries. Items under it lose their parent. Usage and app-error rows that pointed at it keep their data without the pointer. Items that waited on it stop waiting.

The activity log keeps a `work.delete` event with the item's reference and title. Deleting is for noise and mistakes; `dropped` is for work that was real but won't happen.

## Audit

Graph changes record `work.depend`, `work.undepend`, `work.resources` and `work.delete` events, each in the same batch as the change. Claims and releases record `work.claim` and `work.release`.
