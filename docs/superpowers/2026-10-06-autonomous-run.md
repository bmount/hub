# Autonomous run, 2026-10-06: what shipped and the calls made

Scope requested: identity phase 2, then identity phase 3, the MCP OAuth spec and build, wiring Ardi to hub identity, the email mailboxes spec, Ardi phase 4, and messaging.

## Shipped to production (pimwell.com, main)

| Work | Main at | Notes |
| --- | --- | --- |
| Identity phase 2: consent ledger, magic links both ways, reproof | f7a9637 | Email Routing rules still a user action |
| Identity phase 3: agents, pmw_ tokens, run sessions, /me, /admin/agents, introspection | 3fa7cdd | |
| MCP phase 1: OAuth 2.1 server at the apex, per-tenant /mcp, read-only tools | e6f5a79 | Manual Claude Code run is a user action |
| Ardi integration, hub side: git sessions, session.git, forwarding to Ardi | 5d13558 | Ardi side on branch `hub-identity`, deployed as Worker `ardi-pimwell` |
| Messaging phase 1: channels, threads, links, wakeups, loop limits, catch-up, read-only MCP, pages | c9bbd71 | Exit run on `blue` is a user action |

Specs written: MCP OAuth, mailboxes, messaging, Ardi-hub integration. Identity spec amended.

Not done: Ardi phase 4 (owned by the other Ardi session; doing it here would collide), mailbox implementation (spec only), Ardi `/internal/resolve` (ticket and commit titles in chat stay unverified until it exists).

## Rulings made without the user (what it costs if wrong)

### Identity phase 2
- P2-1 `requestLink` never throws; fails closed. Cost: none.
- P2-2 Inbound consent only sticks when the DMARC-gated reply succeeds; rate check runs before consent. Cost: an honest sender whose DMARC fails gets no consent.
- P2-3 Unverified inbound consent revoked on any failure after the grant (finally block). Cost: a rare stuck row, revocable.

### Identity phase 3
- P3-1 `pmw_` tokens resolve only on the API; anonymous on pages. Cost: none.
- P3-2 Uniform 404 on token.revoke; operator must still be a member to revoke runs; tenant admins revoke only agent runs. Cost: none.

### MCP phase 1
- M-1 A forged refresh token has no side effect; revoke only on a retired hash with the same client. Cost: none.
- M-2 MCP per-grant counters in an atomic D1 table. Cost: one D1 write per call.
- M-3 (superseded by M-4) Code replay revokes the grant.
- M-4 Code replay revokes only when the presented code's hash matches the one stored at approval. Cost: none.
- KV namespace: the account already had an unrelated `OAUTH_KV`; the hub uses a new `pimwell-oauth`. Cost: none.

### Ardi integration
- A-1 Introspection accepts only `git` and `agent_run` sessions, never browser sessions. Cost: humans mint a git credential once on /me.
- A-2 Ardi's default wrangler config stays celld-compatible; the Cloudflare config is a separate file. Cost: two config files.
- A-3 Deployed as a separate Worker `ardi-pimwell` with its own R2 bucket so the other session's `ardi` Worker is untouched. Cost: separate storage; merging is that session's call.
- Staging tenant `blue` inserted directly into the hub database to test forwarding. Cost: one row.

### Messaging phase 1
- C-1 Durable Object RPC returns refusals as values. Cost: callers must check results.
- C-2 Channels are hidden from project verbs and listings. Cost: none.
- C-3 Tenant-binding mismatch may throw across RPC (invariant guard). Cost: none.
- C-4, C-5, C-7 (tightens spec 6.5) Hop = 1 + max(target hop, newest wake to this agent anywhere in the conversation within 10 minutes, acked or not). Cost: agent chains die sooner; humans unaffected.
- C-6 Index outbox rows never dropped. Cost: retries forever with capped backoff.
- C-8 Agent retractions exempt from rate window and tripwire. Cost: none.
- C-9 Only wake items may be dropped after 20 attempts; human notifications retry. Cost: none.
- C-10 `i→l` added to handle look-alikes. Cost: some handle pairs auto-suffix.
- C-11 Muted agents may retract their own messages (the kill switch still blocks). Cost: none.
- Real-time (WebSockets) deferred to messaging phase 2; phase 1 uses a 20 s long poll. Cost: pages update on reload.

### Scope
- Ardi phase 4 not implemented here. Cost: it waits for the session that owns Ardi.

Full ledgers with every review, fix round, and deferred minor were kept outside the repo in the job's scratch directory.
