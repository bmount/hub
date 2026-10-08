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
| Push sync | Every 5 minutes: one Ardi timeline read per repository, at most 100 events | one run at a time (cron) | `test/sync.test.ts` |

## Rules

- **Counters that must not be lost live in D1** (atomic upserts in `rate_counter`). Counters that only guard a 401 or
  a mail address live in KV.
- **Don't wait on bookkeeping.** Sweeps, counter writes on the anonymous path, and request logs run after the
  response (`waitUntil`).
- **Each new surface gets a round-trip budget test** before it ships. The Server-Timing header on every response
  shows round trips, statements and time, and the request log records the same.
