# Explicit channel presence increment (#132)

## Contract

- `POST /api/chat.heartbeat` accepts `{ c, status }`, where status is `online`, `away`, or `offline`. It publishes **only the authenticated caller's identity** in an active channel the caller can read. No client-controlled identity, TTL, timestamp, session label, or free-text status is accepted into stored presence.
- `POST /api/chat.presence` accepts `{ c }` and returns channel-scoped recent explicit heartbeats, server `observed_at`, `last_seen` (last heartbeat, not last message/read/work), `expires_at`, and derived state. Query/post/page loads never publish or renew presence. Missing entries are **unknown**, never inferred offline.
- Online/away expire after **90 seconds**, becoming **stale** at the exact boundary. Explicit offline is distinct from stale: it is the caller's reported status, not proof that every client/device is disconnected. Heartbeats do not prove the agent is doing work or the human is reading.
- State is per identity/channel, last heartbeat wins (including multiple tabs/devices). It is not a count of connections. Up to 200 recent identities are stored transactionally in the existing channel Durable Object's KV; no D1 or SQL schema migration or new binding. Reads omit records older than 24 hours; the next heartbeat prunes/replaces bounded stored records. This is not a permanent presence directory or activity history.
- The existing tenant/channel policy applies to both verbs. Agents need an explicit channel grant; humans need organization access. Archived channels refuse both verbs but keep ordinary readable chat history. Read results recheck subject identity and organization membership state and agent channel membership, so retained heartbeats from removed/archived subjects are not exposed. DO binding checks reject cross-tenant/channel reuse.
- Native browser/agent-run API sessions can call these verbs. Long-lived tokens retain their existing restriction to run/session setup; assistant/OAuth/Playground connections cannot call these API-only verbs. This increment deliberately does **not** add MCP exposure or widen connection scopes. A future agent tool surface needs its own scope/contract review and tests.

## Browser behavior

Active channel/thread pages load a content-hashed external script. Presence publishing is **opt-in for that page** via “Share presence in this channel.” Loading a page polls the query only. Without JavaScript, no heartbeat is published and status remains unknown.

While opted in and visible, a heartbeat/query refresh occurs every 30 seconds. Hiding the page reports away once, then stops renewing online presence; delayed/closed/disconnected tabs expire naturally. Stop-sharing sends explicit offline when possible, while honestly warning that a failed update leaves the previous heartbeat to expire. No unreliable unload/offline delivery is claimed. A back/forward-cache restore requires explicit opt-in again.

Names and status are rendered using DOM `textContent`, not HTML. Cached online/away entries expire locally using a monotonic clock and conservative full request round-trip subtraction, independent of client wall-clock skew. Fetches are bounded to eight seconds. Disconnect, failed refresh or access denial clears cached activity and says current status is unknown; authentication/permission denials stop publishing and disable the sharing control. Presence queries do not auto-join a channel or clear unread cursors.

## Evidence and remaining acceptance

`test/chat-presence.test.ts` covers exact TTL boundaries, stale/offline/unknown distinctions, retention/capacity/concurrent updates, authoritative identity/timestamps, no implicit heartbeat/message/wake/cursor effects, channel/tenant isolation, archived channels, revoked subject/viewer access, agent grants, readers, cookie-origin checks, authentication and invalid statuses. `test/chat-presence-client.test.ts` executes the actual shipped asset against a mocked DOM/transport to test opt-in, hidden-page behavior, cache expiry, stop-sharing, back/forward restoration, safe text rendering and disconnected/denied states. `test/verb-table.test.ts` pins access and verifies no author-like input enters parsed parameters.

A real authenticated desktop/mobile browser accessibility/visual and network-disconnect pass remains required before closing #132. Mocked DOM and API tests are not visual acceptance. Native agent API publishing is implemented/tested; operator-managed runner adoption (#133) and MCP exposure are not claimed here. This product increment does not modify the scheduler or publish presence on behalf of the running worker.
