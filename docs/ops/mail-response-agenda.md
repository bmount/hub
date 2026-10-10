# Own human response agenda (#85)

A read-only agenda makes outstanding own human intentions discoverable across
shared messages, including optional UTC deadlines, overdue and stale observations.
It is **not automatic scheduling**, responder assignment, a reminder, delivery
acknowledgement, a complete due queue or a guaranteed substantive response.
[Recipient preferences](mail-response-recipients.md) alone never create entries.
[Own intention semantics](mail-response-intent.md), independent admission,
consent, actual reply gates and one-time welcome behavior remain unchanged.

## API and browser

- Tenant-host `POST /api/mail.response_agenda`, JSON `{}`; optional
  `{ "before": "<mail identity id>" }` continues a scan.
- Browser-only human member/admin page `/mail/agenda`, linked from Mail.
  `?before=<mail identity id>` scans older records. **Start a fresh scan**
  returns to the first page. No edits, send controls or implicit transitions.
- The query is human-only, minimum member role, not an MCP/assistant tool.
  Normal API authentication/host/Origin restrictions apply. Reading does not
  require fresh proof. The page requires a browser cookie/session; actual
  intention writes still require fresh proof and revision CAS in the inspector.

The response has `entries`, `scanned`, `scan_limit: 20`, `has_more`,
`next_before`, `coverage: "own_recorded_shared_source_scan_mail_id_desc"`,
`order: "mail_id_desc_not_deadline_priority"`,
`automatic_execution: "not_implemented"`, `notification: "not_requested"`,
`response_guaranteed: false`.

An entry contains **only** `mail_id`, own `revision`, `state` (`planned`,
`overdue`, `stale`), `updated_at`, `respond_by` (UTC epoch milliseconds or null)
and `can_plan`. It has no subject, body, address, identity details, raw proof,
outbound metadata, transport diagnostics or another responder's intention.
The page links to the canonical message inspector and renders deadlines in
explicit ISO UTC; untimed entries say Untimed. Stale takes precedence over
passed deadlines, exactly as in the inspector. Dates come from the same
validated intention decoder, not permissive rendering of arbitrary metadata.

## Coverage, order and limits

This is a **scan page**, not an exhaustive list of outstanding obligations.
The initial query joins the caller's exact tenant/mail/human intention key
against currently shared, admitted, unreleased, reason-free source mail under
active human/member/tenant authority. It scans at most twenty candidate records
in descending lexical mail-ID order, plus one lookahead candidate solely to
establish continuation. IDs are a deterministic scan order, **not deadline
priority or guaranteed receipt chronology**. The lookahead is never an entry.

Each scanned source is independently rechecked. Terminal (`cancelled`,
`completed`), invalid, or now-unproven/unavailable records can consume scan
slots without becoming entries. Invalid state is never reset. An empty page
with `has_more: true` must still be continued using `next_before`; it does not
mean no older outstanding intentions exist. The cursor is the last scanned
shared-source mail ID, not a responder state, proof of independent admission,
permission to read that source, an outbound idempotency key or an execution
checkpoint. A syntactically valid foreign/arbitrary cursor only changes the
ordering bound within the authenticated caller's tenant scan; it grants nothing.
No caller can select another tenant/responder or alter the page size.

No global obligation count, skipped-reason count or due-priority ordering is
claimed. `scanned` counts candidate own records, not proven outstanding entries.
`has_more: false` means no older candidate was observed in the initial scan,
not that no response was sent or no later concurrent intention can exist.
Newly created intents on older mail, cancellation, replanning, source or authority
changes can affect subsequent pages. There is no cross-page snapshot lock;
start a fresh scan to reconcile concurrent activity.

## Boundary checks and effects

Active human identity, explicit active member/admin membership and active tenant
are checked before scanning and again before returning, **including empty
scans**. Root authority without current membership is not an assignment.
Private-agent, foreign-tenant, quarantined or administrator-released sources
never become entries, even for an admin or the private agent's operator.

Every entry uses the existing intention reader's exact independent replay/source,
intention, preference and address-availability checks. This requires valid
server-owned stored replay evidence matching the message/sender, not an admitted
verdict alone or forged Authentication-Results. A missing/unproven source is
omitted, never exposed as a synthetic delivery outcome. A source/revision/proof/
preference change during the final per-entry observation conflicts the **whole
request**, rather than returning partial stale controls. Database failures
propagate, not a successful empty agenda. The page reports conflict/reload,
not stale intention links. Each entry is a bounded observation, not a lock
against changes after its final query; inspector reads and all writes retain
their own checks.

The agenda reuses the reader with reply comparison disabled: no outbound record
is selected for these observations. It costs two actor-authority queries, one
bounded candidate query and the existing bounded per-candidate checks (at most
20 candidates), not a constant-query aggregation. It never scans unbounded
application results or claims to be a durable execution service. Server filtering
may still examine more rows internally; no database index-performance claim is
made. No schema, cron, queue, runtime/binding change or actual preference/member
mutation is required.

No meta/event/attention/outbound/consent/grant write, notification, reminder,
inbox wake, completion, cancellation, retry, login-proof refresh or receipt/
welcome suppression occurs. A passed deadline remains a human intention,
not an inferred send failure. No mail content or raw tool/prompt data is added
to telemetry. Browser responses remain no-store; navigation list keys include
the whole scan result so changed entries and continuations are not retained.

Native Workers tests cover org/project intentions, own-only metadata, empty-page
continuation, bounds/order, terminal/invalid/proof/private/foreign/released
omissions, authority and source interleavings, database failures, UTC rendering,
non-MCP/agent/reader/Origin/host denials, stale-proof reads and unchanged tables.
These are synthetic product-state and HTTP acceptance, **not** browser-engine
layout, real-human fulfillment, live-provider delivery or #134's fresh signed
primary admission/wake/no-receipt acceptance. #85 still needs transactional
human notification intent/delivery reconciliation and genuinely scheduled
execution; the agenda does not implement either.
