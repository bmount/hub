# Overnight ledger, 2026-10-07

Plan: docs/superpowers/plans/2026-10-07-overnight.md. One entry per task: what shipped, commits, rulings (what, why, cost if wrong), checks.

## T0: mailbox names never collide (done)
- 914d54f, then 30a08fd: a conservative reserved list in src/reserved.ts (248 names: infrastructure, accounts, mailboxes, company roles, helper words, brands). Owner asked for it to be conservative, including names like "ceo".
- Ruling: helpers keep a narrower list (accounts, mailboxes, roles), because their address is scoped to an organization; "claude", "bot", "dev" stay available. Cost if wrong: a helper name that reads as official inside one org.

## T1: a test suite that can be trusted (done)
- b3de562: vitest 4.1 with pool-workers 0.22. The old pool's isolated-storage snapshots failed randomly on SQLite sidecar files (a known bug in 0.5-0.12).
- Storage is per file now. test/apply-migrations.ts wipes every table before each test, restores migration seed rows, and empties KV. Chat tests use a fresh tenant id per test.
- Ruling: npm override pins the pool's miniflare to workerd 1.20261006.1, the same runtime wrangler ships, so compatibility_date stays at production's 2026-09-01. Cost if wrong: a mismatch between the pool's miniflare and a newer workerd; tests would fail loudly.
- npm 10 crashed in its resolver; the install used npm 11, with the esbuild and workerd install scripts approved explicitly.
- Check: three consecutive full runs, 591/591.

## Ardi release (done; background agent)
- Ardi branch pimwell-release (8024a7e) merges hub-identity into Ardi main (streaming ingest and fetch); deployed as ardi-pimwell, version 2431f8f8.
- The 13.5 MB PriceBench push that returned 500 now goes through in one push (10.1 s); the clone is clean (fsck strict), with the same commits.
- Ardi main was not touched. Note: the Ardi session was later told to merge everything to main; reconcile pimwell-release with Ardi main when that lands.

## T2: work items (done)
- 4e9ce78, 71581f5: wishes, snags, errands, quests, calls, sparks (names in src/work/names.ts), per-project numbers, claims with one-hour leases, links, events, verbs over pages, the API and MCP. The Docket at /<project>/docket.
- Ruling: work.create also accepts source kind, reference, time and an initial state, so history and mail-derived items are faithful. Cost if wrong: none; all optional.
- Check: 598/598, then 599 after the source fields.

## T3: Pimwell builds Pimwell (done, except the repo push)
- The project mcc/pimwell (repo kind) was created. The helper Historian (historian@mcc.pimwell.com, sponsored by the owner) filed 72 items through the real API: 9 quests, 20 calls, 34 wishes, 7 errands, 2 sparks.
- Each item carries the owner's words and their date; 36 links point to delivering commits. Historian's credentials (1 hour) were revoked after.
- Ruling: Historian keeps the old helper address form until helpers move to <org>.<name>@pimwell.com (filed as an open errand). Cost if wrong: one address to migrate.
- Pending: push the hub repository into mcc/pimwell.git with one ordinary push, after the Ardi delete work deploys (it redeploys ardi-pimwell).
