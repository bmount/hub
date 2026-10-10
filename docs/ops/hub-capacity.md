# Hub capacity: always-connected agents and heavy MCP use

Pimwell is a hub. Agents stay connected around the clock and executives work in the Assistant or their own MCP
client all day. What each of those costs, and the limits that keep one busy connection from crowding out the rest:

| Path | Cost per call | Limit | Test |
| --- | --- | --- | --- |
| MCP call (`tools/list`, `tools/call`) | 2 D1 round trips: grant check, then both rate windows in one batch; the tool's own reads share them | 120 a minute and 2000 an hour per assistant connection | `test/mcp-budget.test.ts` (budget 3) |
| Signed-in page | 1 round trip for sign-in and rail, then the page's own batch | none beyond Cloudflare | `test/perf-budget.test.ts` (budget 4) |
| Agent waiting for work (`inbox_wait`) | Held in the agent's inbox Durable Object for up to 20 seconds, no D1 work while waiting | per-identity inbox, one wait at a time | messaging tests |
| Anonymous `/mcp` (the 401 every client sees first) | 0 round trips; the KV counter write happens after the response | 60 a minute per IP | `test/rate-failopen.test.ts` |
| Assistant turn | Up to 8 model rounds and 6 tool calls a round; each tool call costs the same as an MCP call | 120 turns an hour per person | `test/assistant.test.ts` |
| Push sync | Every 5 minutes: one head read and up to three forward pages per repository, at most 300 imported events | four Ardi reads per repository per run; unfinished pages resume next cron | `test/sync.test.ts` |

## Git checkpoints and lag

`code_sync.cursor` stores a versioned JSON checkpoint: forward event ID, initial head cutoff, backfill/live phase, observed head and times. Only its numeric forward ID is sent to Ardi. The initial head is captured once, before walking from `since=0`; an unfiltered Ardi read returns the newest page, not the oldest. Events at or below the cutoff are mirrored quietly, without work links or ops notices. Higher IDs are live pushes, including arrivals during backfill. The phase stays backfill until a forward read has no continuation. Failed reads keep the last completed page and original cutoff.

Legacy numeric checkpoints replay from zero under a new quiet cutoff to recover previously omitted history. Existing event rows remain deduplicated. No schema migration is required.

Project status reports the checkpoint, last run/error, head-observation time and last caught-up time. Pending event-ID span is not an event count. Observed event-time lag is the nonnegative gap between the observed head's event time and the latest imported event's time; it is unknown before any import, and zero when the observed head is reached. Missing/legacy checkpoints report unknown. These observations can become stale and do not prove continuous upstream freshness or healthy operation.

## Rules

- **Counters that must not be lost live in D1** (atomic upserts in `rate_counter`). Counters that only guard a 401 or
  a mail address live in KV.
- **Don't wait on bookkeeping.** Sweeps, counter writes on the anonymous path, and request logs run after the
  response (`waitUntil`).
- **Each new surface gets a round-trip budget test** before it ships. The Server-Timing header on every response
  shows round trips, statements and time, and the request log records the same.
