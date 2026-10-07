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

# Round 2 (docs/superpowers/plans/2026-10-08-overnight-2.md)

## N1: in-context Playground (done)
- e21dc10: /playground runs MCP calls inside the signed-in organization, with no OAuth. A call needs: tenant host, active org, a human browser session by cookie, same origin, the x-pimwell-playground header and JSON. Scopes are read, or read and write. Every call is audited as playground.call or playground.denied, and has its own rate bucket.
- Supersedes the T6 stop: the owner chose the in-context design.

## N2: auth stress suite, write scope (done)
- 4d39e65: the stress suite crosses every credential kind with every host and verb exposure. Write is now offered at consent, as MCP spec 8.1 allows; choosing write grants read and write.

## N3: mail to structure (done)
- 12690c2: mail.propose_work turns a message into up to 8 proposed work items, each quoting the message exactly (checked after normalization). The live model check returned three correct proposals and ignored an injected instruction.
- Lesson: adding a verb means updating the pinned tool lists. Always run the full suite.

## N4: performance watch, part 2 (done)
- 8ecaf27: Server-Timing now reports D1 round trips, statements and time. buildContext reads tenant, session, identity and membership in one batch: three fewer round trips on every signed-in page.
- Budget: test/perf-budget holds every signed-in page to 5 round trips or fewer. Measured: / 2, /docket 3, /<project> 3, work item 5, /people 2, /mail 3, /c 2, /playground 1, /archive 4, /skills 1.
- Ruling: the plan's "6 statements, a batch counts as one" is enforced on round trips (statements vary with batching), and set at 5, today's worst page. Cost if wrong: one number to change.
- 05ede91: the anonymous /mcp 401, the first hop of every assistant connecting, waited on a KV write: 347 ms median. The anonymous bucket already failed open on write, so the write now runs in waitUntil: 37 ms median. The email buckets still wait (they fail closed).
- Production smoke (node scripts/perf-smoke.mjs <org>), 9 runs each, median: apex / 33 ms, /privacy 24, /login 24, OAuth metadata 24, org home 69 (anonymous 404, one D1 trip of 37 ms), /mcp 401 37. p90 spikes of 250 to 500 ms are cold first hits.

## N5: deep UI, round 2 (done)
- 551775d, a174aab: each work item page has an Edit panel (title, kind, owner, quest, details). The current owner and quest stay selectable even when the usual lists leave them out, so saving never drops them. Sending an empty body now clears the details; leaving it out still changes nothing.
- The Docket filters by owner, quest and "mine". Chips keep the other filters, and empty states say what emptied the list. Pages read in one batch after the project lookup; the work item page went from 5 round trips to 4, and the budget tightened to 4.
- The search shortcut (`/`) waits for search to exist, as the plan said.
- Screens checked at desktop and at true phone width.
- Fixed: auth-stress "limits calls per connection" flaked when its 125 calls straddled a minute boundary. It now sends up to 241 calls (twice the limit plus one).

## Pimwell builds Pimwell, round 2
- Done: pimwell#50, #51, #52, #59, #63. Under way: #53 (sandbox orgs remain) and #62 (helper addresses, first half). All linked to their commits.
- Filed as done: #73 (edit and filters), #74 and #75 (snags: write never offered; slow first MCP hop), #76 and #77 (calls: in-context Playground; leave Ardi alone, with the owner's words). The Historian's one-hour credentials were revoked after each run.

## N7: helper addresses (first half done; rest waits for the owner)
- 2b67c05: projects and helpers share one name space per organization, enforced inside each INSERT. Archived helpers keep their names; channels don't hold names. Production had no collisions.
- Ruling: the address move itself waits. Today every address under an organization subdomain is reserved for helpers (identity spec 6.5). With helpers at <org>.<name>@pimwell.com, something must stop a human identity, invite or sign-in link from using a pimwell.com address. Sign-in mail to a helper's address would otherwise land in mail that members can read. That is a security property, and the plan's guardrail stops there. The production identity migration is also worth a nod first. Cost of waiting: helpers keep their current addresses one more day.

## N6: sandbox organizations (not started; waits for the owner)
- Ruling: letting any member create organizations changes who may create a tenant (root only today). That waits for the owner's nod.
