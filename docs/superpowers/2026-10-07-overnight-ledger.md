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
- T3 finished: the hub repository was pushed into mcc/pimwell.git in one ordinary push (2.5 s); its main equals origin/main (d2524ce). The temporary git credential was revoked.

## Ardi boundary (owner ruling, 2026-10-07)
- The owner asked the hub session to stop changing Ardi. A background agent adding repo delete was stopped before committing; its uncommitted work was saved as docs/requests/ardi-repo-delete-unfinished.patch and discarded, and the Ardi worktree was removed. Ardi main was never touched.
- What remains, by necessity: branch pimwell-release (8024a7e) on origin, which is what ardi-pimwell runs. docs/requests/2026-10-07-ardi.md asks the Ardi session to own that deployment and to build repo delete and tenant purge.

## T4: navigation shell and deep UI, round 1 (done; continuous)
- d2524ce: one design system and shell; a deep organization home, project pages with one timeline, the organization-wide Docket, and People and helpers. Each page reads in one D1 batch.
- Found and fixed: channels (project rows of kind channel) leaked into the new project lookups. Work, pages and mail addresses now all exclude them.
- Checks: 606/606 tests. Local render 6 to 12 ms per page, 6 to 8 KB of HTML. Screenshots reviewed at desktop and true phone width.

## T5: MCP history, the Docket, skills, capabilities (done)
- 3353976: six skills served as MCP resources (pimwell://skills/<name>), as skill_list and skill_read, and at /skills. The server's instructions point new helpers at start-here.
- capabilities explains every unavailable tool. project_history pages through events. The Docket was already work_list.
- Project names that would hide a built-in page (docket, mail, skills and others) are refused.
- Check: 612/612.

## T6: MCP sandbox and Playground (stopped: needs an owner decision)
- The Playground must exercise the real auth path. The faithful design is a browser client on the organization's own host doing the real OAuth dance (dynamic registration, PKCE, the real consent page, token exchange) and then calling /mcp.
- That needs two security-relevant changes: allow https://<org>.pimwell.com/playground/callback as an OAuth redirect, and let each organization's own origin call its /mcp (CORS). The plan's guardrail says to stop on changes to a spec's security property, so this waits for the owner.
- Alternative: run the dance server-side, with no new redirect or CORS. It is less faithful to real clients, but it adds no new surface.
- Sandbox organizations and the auth stress suite are not started; they don't depend on the decision, and come next.

## T7: performance watch (started)
- Server-Timing (app;dur) is on every hub response; live public pages report 0 ms of Worker time.
- Not yet: D1 query counts in Server-Timing, and a production perf smoke script for signed-in pages.
