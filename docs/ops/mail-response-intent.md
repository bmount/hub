# Explicit human response intention (#85)

This is a small scheduling-semantics increment: a currently configured human
reader can **voluntarily record an intention to respond to a particular shared
message**, optionally record a UTC respond-by time, retime it or cancel it.
Reads distinguish a passed intended deadline from an outstanding intention.
It is not a scheduler, a delivered notification,
an acknowledgement from someone else, or a guarantee of a substantive reply.
Preferences alone still do not create an intention. Nothing in an incoming
message, forwarded quotation, attachment or caller-supplied proof creates one.

## API and browser

Tenant-host APIs (not MCP/assistant tools):

- `POST /api/mail.response_intent`, `{ "id": "<mail id>" }`: reads only the
  caller's own intention. Returns `mail_id`, `revision`, `state`, `updated_at`,
  `respond_by` (UTC epoch milliseconds or null), `can_plan`, `reply_observation`
  (bounded own recorded reply evidence, below), `automatic_execution: "not_implemented"`,
  `notification: "not_requested"`, `response_guaranteed: false`.
- `POST /api/mail.set_response_intent`,
  `{ "id": "<mail id>", "state": "planned", "expected_revision": 0 }`:
  records the caller's voluntary intention. Optional `respond_by_utc`, e.g.
  `"2026-10-10T12:30"`, is **explicit UTC** at minute precision, not local time.
  Only the exact `YYYY-MM-DDTHH:mm` calendar format is accepted: offsets, `Z`,
  seconds, rollover dates and whitespace are rejected. Omitted/null/blank means
  an untimed intention; on a planned intention it explicitly clears the old
  deadline. Retiming an existing planned intention uses its current revision.
  An identical state/deadline conflicts without another audit.
  `state: "cancelled"` cancels an existing intention and does not accept a
  respond-by time. A cancelled intention may be replanned at its current
  revision, only if current preferences still select the caller.

A respond-by time must be strictly after server request time and at most 30 days
from the message's stored receipt time. Future/invalid receipt timestamps and
expired windows cannot create timed plans. Untimed legacy planning remains
compatible. The receipt snapshot is rechecked inside the write transaction.
The reply window constant is shared with actual human `mail.reply` eligibility,
but recording a deadline does **not** check or satisfy sending enabled, consent,
quota, transport, or actual reply gates. No deferred execution is reserved.
The minute input has no timezone conversion: the browser label explicitly says
UTC. This is not a local-time appointment picker.

Both require an active human member/admin with explicit membership in this
organization. Global root authority is not a recipient assignment. Writes
require browser proof within 60 minutes. Normal host/authentication/Origin and
actual-byte request limits apply. Caller-supplied recipient identities, tenant
ids, authoritative proof, delivery outcomes and arbitrary status text are not
parameters. Admins cannot assign or change another person's intention. Multiple
configured humans may independently intend to respond; this is not exclusive
ownership, priority routing or fanout.

The browser mail inspector offers **My response intention** and native
revision-checked plan/retime/cancel forms for eligible human browser readers,
including an optional UTC minute field. Existing UTC deadlines are shown as
ISO text; a passed deadline says overdue, never sent/failed. An old
proof shows the existing confirmation flow, not an active form. The inspector
key includes the full own-intention/preference eligibility/proof observation,
so navigation cannot retain an old form across changed observations. Responses
are `no-store`. Invalid state has no reset form. Private/unproven mail and
agent/reader sessions never get intention controls. An unselected human sees
no plan form. These are not claims of real-user or browser-engine layout
acceptance; native Workers HTTP tests cover the rendered forms and POSTs.

## Authority and independent admission

The source must be **shared** organization/project mail (null `recipient_id`),
with `admitted` verdict, null reason and no administrator release. Even an admin
or a private agent's human operator cannot use this feature on agent mail.
Existing mailbox access, canonical shared-mail readers and the independent
[authentication](mail-authentication.md)/[replay](mail-replay.md) pipeline remain
unchanged. A legacy receipt/admitted verdict alone is insufficient.

The code derives the exact server-owned replay key from stored
`[from_email, to_address, message_id]` and tenant ID. It requires a well-formed
`stored` independent-admission record with matching mail/sender IDs, attempt ID,
raw-byte hash and reservation time. No caller supplies that record, and this
API does not claim to re-run original DKIM at read time or establish proof from
parsed text. Stored records are authoritative product evidence, not attacker
Authentication-Results headers. Missing, corrupt, pending, mismatched, released,
quarantined or foreign evidence fails closed (`not_found`) without returning
intention details. Original DKIM and consent handling remain unchanged.

Planning additionally requires current mailbox resolution to match the stored
exact tenant/project/address with no agent recipient, valid preference data
selecting the caller, and active tenant/project/member/human identity. Project
preferences are independent of organization preferences; neither inherits.
Cancellation does not need the caller to remain selected by preferences, or the
old project/address to remain active. It still requires active human membership,
shared independently admitted evidence and current proof. This permits an
explicit cancellation after clearing preferences, archiving a project or
renaming its address, without authorizing a new response.

## Durable states and concurrency

Existing `meta` holds
`mail_response_intent:v1:<tenant id>:<mail id>:<human id>`; no schema migration.
Only revision, fixed state, optional UTC deadline, update time and unique change
ID are stored, never
mail content, addresses, credentials, raw prompts or transport diagnostics.

- Absent: `unset`, revision 0. Preferences do not populate it.
- Recorded: `planned`, positive revision, optional `respond_by`. This means
  intention only. Legacy records without that field remain untimed.
- Intended deadline passed: reads report `overdue` at or after `respond_by`,
  retaining the planned stored state and revision. No background timer, write,
  audit, reminder, wake, cancellation, failure or reply is inferred. Reads at
  request time observe passage; an open browser pane is not a live countdown.
- Preference/address availability changed: reads report `stale` while retaining
  the planned revision. Stale eligibility takes precedence over overdue timing.
  No background write or automatic cancellation occurs.
- Explicit cancellation: `cancelled`, next revision.
- Corrupt/unsupported stored state or deadline: `invalid`, revision null; no
  silent reset. Timed records must have a safe supported UTC timestamp after
  their update time and within the reply-window budget; cancellation stores no
  deadline.
- Loss of source/read authority: fail closed, not a made-up terminal delivery
  outcome. Staleness is a bounded current observation, not a lock or future
  authority guarantee.

Revision compare-and-swap and its audit event commit in one D1 transaction.
The write rechecks current actor membership/identity, active tenant, exact
shared mail identity/destination/verdict, the exact independent evidence
snapshot, and (for planning) exact preferences and current destination activity.
Timed writes additionally recheck the exact stored receipt timestamp/window.
An audit failure rolls back the intent. Concurrent changes at one revision
commit at most one update/audit. Same-state/no-intent cancellation and stale
replays conflict instead of creating duplicate audit events.

If a POST outcome is ambiguous, **read/reload the own revision/state before
editing again**. Never blindly replay it. This is optimistic state management,
not an outbound idempotency key. No external delivery is attempted here.
Existing tenant-deletion code removes only that tenant's intent keys within its
transaction. Tests use disposable fixtures; release does not delete real data
or mutate real preferences, memberships, users, grants or consents.

Audit uses `inbound_mail` targets so existing canonical mail-event visibility
applies. The summary contains only fixed intention/cancellation semantics, no
subject, address or extra recipient list. Read status contains only the caller's
own record, not another responder's private state.

## Bounded own recorded reply evidence

A read also returns `reply_observation`, derived from existing server-owned
`outbound_mail` records, never a caller-supplied delivery claim. For a valid
stored planned intention (including observed stale/overdue states), it selects
**at most one latest** record with exact tenant, inbound source ID, caller
`sent_by`, from-mailbox and original sender destination matches, and a recorded
time at or after the current intention revision's `updated_at`. New-message
sends, other actors/tenants/sources/addresses, CC lists and earlier replies do
not match. Records are ordered by timestamp then ID, descending; the ID is a
deterministic tie-break, **not proof of the order of simultaneous sends**.

The fixed observation states are:

- `not_applicable`: absent/invalid/cancelled intention; no current planned
  revision to compare. This is not a statement about send history.
- `no_record`: no matching recorded attempt in this bounded range. This does
  **not** mean unattempted or definitely unsent: the existing send path records
  after transport, so a lost result/write can leave no row.
- `transport_accepted`: the matching record's status is `sent`. This is the
  product's stored transport acceptance, **not recipient delivery, a read
  receipt, or proof of a substantive response**.
- `consent_refused`: the matching record reports `refused`, a local consent
  refusal, not a recipient delivery observation.
- `outcome_unknown`: `failed`/unsupported status or invalid ID/timestamp. A
  transport exception can follow acceptance, so it does not prove non-send.
  Future, fractional or unsupported date observations never render as accepted.

`outbound_id` and `recorded_at` identify the selected record when structurally
valid, otherwise null. The object always states
`recipient_delivery: "not_observed"`, `fulfillment: "not_inferred"`, and
`coverage: "latest_recorded_matching_own_reply_since_revision_time"`.
No subject, body, address, raw status or transport error is returned by this
observation. The browser's **Own recorded reply evidence** panel uses fixed
truthful wording and includes the observation in its pane invalidation key.
Existing canonical readable-reply rendering remains separate and unchanged.

The final bounded query anchors the outbound selection to active human/member
and tenant authority, exact shared source identity/destination/verdict, and the
exact independent replay and intention snapshots. A source/authority/revision
change during this read refuses the observation rather than leaking stale
attempt details. This is a bounded database observation, not a future authority
lock. Unset/invalid/cancelled intentions expose no reply record.

**This is temporal matching, not causal binding.** A reply and revision sharing
a millisecond may match without the reply having been initiated by that
revision. Retiming/replanning starts a new time range; earlier replies disappear
from this observation, not from canonical history. Only the latest record is
shown: an unknown latest attempt is not upgraded by an older accepted record.
The panel is not a complete send history or an idempotency/retry oracle.

Reads do not change the intention, complete it, audit, send, retry, request
notification, wake an agent or suppress guidance. A planned/overdue/stale state
remains distinct even when a reply record reports transport acceptance. Before
retrying an ambiguous real send, reconcile with authoritative outbound effects;
this read cannot repair the existing post-transport recording gap. Durable
pre-send reservation and content/action binding remain separate #105/#85 work.
Native Workers tests cover stored and actual test-transport reply records,
metadata-only rendering, revision ranges, transaction-time boundary changes,
and absence/failure ambiguity; they are not live-provider delivery acceptance.

## Not implemented / acceptance remaining

Optional respond-by times are self-recorded human plans, not genuine automated
scheduling, durable execution/resumption or a delivery attempt. Past intended
times do not generate notices or suppress setup guidance. Boundary tests cover
native Workers HTTP forms and server state, not browser-engine picker layout,
real-human timed work or provider delivery acceptance.

No mail send, inbox wake, attention, automatic execution, response assignment,
access grant, consent change, notification or guidance suppression occurs.
Actual `mail.reply` has its own consent/sending/window/quota and delivery gates;
a planned intention does not satisfy them. This increment deliberately cannot
accept `sent`, `failed`, `unknown` or arbitrary delivery claims as intention
transitions. The new read-only observation reconciles only matching existing
reply records. A real reply's causal action binding, durable pre-send state,
recipient delivery and substantive fulfillment must not be inferred from an
intention, checkbox, timestamp or transport acceptance.

#85 remains open for transactional human notification intent and durable
notification delivery/ack/failed/unknown reconciliation, genuinely scheduled
execution/cancellation semantics. Conditional setup guidance within the existing
one-time welcome is implemented separately (see [contract](../mail-welcome.md));
no intention suppresses it. Agent responders require a separate bounded access
design. Do not activate preferences
as fanout or use intention to promise a response/suppress context. #130's
one-time welcome and routine receipt suppression remain intact; #134's fresh
real-provider admission/wake/no-receipt acceptance is still an external
observation, not synthetic-fixture or public-smoke acceptance.
