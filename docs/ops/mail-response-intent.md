# Explicit human response intention (#85)

This is a small scheduling-semantics increment: a currently configured human
reader can **voluntarily record an intention to respond to a particular shared
message**, then cancel it. It is not a scheduler, a delivered notification,
an acknowledgement from someone else, or a guarantee of a substantive reply.
Preferences alone still do not create an intention. Nothing in an incoming
message, forwarded quotation, attachment or caller-supplied proof creates one.

## API and browser

Tenant-host APIs (not MCP/assistant tools):

- `POST /api/mail.response_intent`, `{ "id": "<mail id>" }`: reads only the
  caller's own intention. Returns `mail_id`, `revision`, `state`, `updated_at`,
  `can_plan`, `automatic_execution: "not_implemented"`,
  `notification: "not_requested"`, `response_guaranteed: false`.
- `POST /api/mail.set_response_intent`,
  `{ "id": "<mail id>", "state": "planned", "expected_revision": 0 }`:
  records the caller's voluntary intention. `state: "cancelled"` cancels an
  existing intention. A cancelled intention may be replanned at its current
  revision, only if current preferences still select the caller.

Both require an active human member/admin with explicit membership in this
organization. Global root authority is not a recipient assignment. Writes
require browser proof within 60 minutes. Normal host/authentication/Origin and
actual-byte request limits apply. Caller-supplied recipient identities, tenant
ids, authoritative proof, delivery outcomes and arbitrary status text are not
parameters. Admins cannot assign or change another person's intention. Multiple
configured humans may independently intend to respond; this is not exclusive
ownership, priority routing or fanout.

The browser mail inspector offers **My response intention** and native
revision-checked plan/cancel forms for eligible human browser readers. An old
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
Only revision, fixed state, update time and unique change ID are stored, never
mail content, addresses, credentials, raw prompts or transport diagnostics.

- Absent: `unset`, revision 0. Preferences do not populate it.
- Recorded: `planned`, positive revision. This means intention only.
- Preference/address availability changed: reads report `stale` while retaining
  the planned revision. No background write or automatic cancellation occurs.
- Explicit cancellation: `cancelled`, next revision.
- Corrupt/unsupported stored state: `invalid`, revision null; no silent reset.
- Loss of source/read authority: fail closed, not a made-up terminal delivery
  outcome. Staleness is a bounded current observation, not a lock or future
  authority guarantee.

Revision compare-and-swap and its audit event commit in one D1 transaction.
The write rechecks current actor membership/identity, active tenant, exact
shared mail identity/destination/verdict, the exact independent evidence
snapshot, and (for planning) exact preferences and current destination activity.
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

## Not implemented / acceptance remaining

No mail send, inbox wake, attention, automatic execution, response assignment,
access grant, consent change, notification or guidance suppression occurs.
Actual `mail.reply` has its own consent/sending/window/quota and delivery gates;
a planned intention does not satisfy them. This increment deliberately cannot
accept `sent`, `failed`, `unknown` or arbitrary delivery claims. A real reply's
outcome must be independently bound/reconciled by a later increment, not inferred
from an intention or checkbox.

#85 remains open for transactional human notification intent and durable
notification delivery/ack/failed/unknown reconciliation, genuinely scheduled
execution/cancellation semantics, and conditional setup guidance. Agent
responders require a separate bounded access design. Do not activate preferences
as fanout or use intention to promise a response/suppress context. #130's
one-time welcome and routine receipt suppression remain intact; #134's fresh
real-provider admission/wake/no-receipt acceptance is still an external
observation, not synthetic-fixture or public-smoke acceptance.
