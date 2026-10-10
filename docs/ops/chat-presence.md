# Explicit channel presence

Presence is an explicit report, not proof that a human is reading or an agent is working. Missing reports are unknown. Expired online/away reports are stale, not inferred offline. Offline is the caller's reported status, not proof that every device is disconnected.

## API and storage

`POST /api/chat.heartbeat` takes `{ c, status }`, where status is `online`, `away`, or `offline`. It publishes only the authenticated caller in an active channel they can read. Identity, timestamps, expiry and assistant provenance are server-controlled. Online/away leases last 90 seconds; offline has no online lease.

`POST /api/chat.presence` takes `{ c }` and returns `observed_at`, `last_seen`, `expires_at` and derived state for recent eligible reports. Page loads, posts and queries never publish or renew presence. Neither verb joins a channel or changes unread cursors.

Reports live in the existing channel Durable Object, transactionally bounded to 200 identities and retained for less than 24 hours. New reports replace the caller's previous rows and prune unusable state. Reads never repair storage or backfill membership handles. Missing handles are shown as `unknown`.

Retention validates persisted rows before sorting and capping. Invalid identities, statuses, timestamps, leases or assistant flags are omitted as unknown. Shorter positive legacy leases and absent legacy assistant flags are supported. Future-dated reports are excluded, including at the completed snapshot's observation time. Multiple eligible reports for one identity are ambiguous and all are omitted; there is no invented newest-row winner. These rules preserve valid peers without mutating input or stored reports.

## Permissions and provenance

Both verbs require existing tenant access and an active channel. Agents also need an unremoved grant in that exact tenant/channel. Archived channels retain ordinary readable chat history but refuse presence calls. Durable Object binding checks reject cross-tenant/channel reuse.

Subject lookup uses bounded SQL chunks of 90 identities. Subjects need active identity and same-tenant membership. Agent subjects also need an unremoved channel grant and an active human operator who is root or has active same-tenant membership, matching agent authentication. Ineligible reports are omitted, not relabeled offline. Restored eligibility may expose the original retained report; it does not renew its timestamp or establish resumed participation.

After the DO and subject lookups, the query reloads the reader's identity, tenant and membership and requires current reader access. Human roots retain their existing membership exception; agents still need active own membership and a live authorized human operator. The final channel check uses this current identity and role and rechecks the agent grant. It refuses a snapshot after reader-access withdrawal, channel archival, grant removal or slug replacement. These are request-time checks, not session/token reauthentication or perpetual authorization after a response is sent. Subject eligibility is checked at its SQL lookup time. Cached views remain subject to the browser freshness bound below.

Native API sessions use the existing authentication rules. MCP `chat_presence` needs read scope; `chat_heartbeat` needs write scope. OAuth, Playground and agent MCP retain their existing exposure rules. No scope or channel access is granted by presence.

OAuth/Playground reports carry authoritative `via_assistant: true`; native reports reset it to false. Agent MCP reports remain attributed to the agent. Reports do not identify the publishing token, so they cannot establish token-specific revocation or work provenance. MCP text renders names as bounded quoted evidence. Auditing records argument keys only, not channel/status values or results.

Heartbeats are not replay-idempotent: every accepted call is a new report. After ambiguous delivery, query rather than blindly retrying or claiming offline was accepted.

## Browser consent and freshness

Active channel/thread pages load a content-hashed external asset. Initial polling is query-only. Sharing requires an explicit page-local action. While opted in and visible, the client reports and queries every 30 seconds. Hiding reports away once, then stops renewing online presence. Stop-sharing attempts offline and warns that a failed update leaves the previous report to expire.

Every cached snapshot expires after 90 seconds, including offline and empty directories. Participation also expires after a 90-second gap since the last report began. Expiry is checked before renewal as well as during drawing, so delayed timers cannot prolong sharing. Expiring the snapshot retires consent even if a heartbeat started more recently. Stop clicks preserve their displayed intent rather than becoming renewed Share actions.

Age uses the greater of monotonic and wall-clock elapsed time, including conservative request time. Wall rollback cannot extend monotonic freshness; forward jumps can expire early. Identical observations retain their original age, and regressed observations are rejected. The observation anchor survives errors and same-client lifecycle restoration. This does not authenticate arbitrary timestamps or guarantee monotonic server time.

The browser validates the entire channel snapshot before rendering. Names/status use `textContent`, never HTML. Responses are bounded to 256 KiB of actual streamed UTF-8 bytes before JSON parsing. An absolute eight-second budget covers headers, every body chunk and decoding, even if timer delivery is delayed. Cancellation is best effort and never blocks recovery. Late results cannot repaint an obsolete view or continue an abandoned heartbeat into a query.

Disconnects, transport failures and malformed/expired snapshots clear activity to unknown and retire sharing and queued reports. Recovery queries only until a new explicit action. Timely authentication/access denial disables publishing; an overdue denial is obsolete transport, not a current access verdict. An aborted or rejected response does not prove the server rejected the write.

Pagehide and freeze clear activity, abort requests and retire timers. Persisted pageshow or matching resume starts query-only and requires fresh consent. Pagehide takes precedence over freeze restoration. Pane replacement retires the detached client and unregisters listeners; new panes start unshared. No unreliable unload/offline delivery is claimed.

## Validation and native lifecycle limits

Vitest covers the server/DO, MCP and shipped browser asset, including permission boundaries, read-only storage, malformed records, retention, consent, transport and delayed-response races. `npm run test:browser:chat` uses a disposable local Worker and synthetic sessions for keyboard, layout, disconnect, navigation and presence behavior. Browser action/event and response-completion waits have real-clock deadlines; failures are not retried or treated as passes.

The native history fixture preserves private `no-store` headers. Persisted BFCache acceptance requires the same document and real persisted pagehide/pageshow events. Cache refusal followed by a safe fresh-document return is a separate outcome, not persisted acceptance. A supported engine naturally retaining this privacy contract is still required for persisted restoration acceptance; do not strip headers or force cache eligibility.

`CHAT_BROWSER_NATIVE_FREEZE=1 npm run test:browser:chat` enables the headed native freeze fixture. It requires an authorized display environment, real hidden-page transition, trusted freeze/resume events, the same document, immediate unknown state, query-only renewal and explicit opt-in. This native path remains unvalidated where no display fixture is available. Synthetic events and controlled clock advances are not native sleep/freeze evidence. Release and run evidence belong in the work item, not this document.
