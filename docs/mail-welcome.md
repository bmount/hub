# One-time newcomer mail context (#130)

## Rollout contract

`handleProjectMail` now uses independently verified original-byte DKIM and
atomic replay/evidence/audit storage before admission. Organization, project and
agent mail never sends routine `Received` replies, including when proof is
unknown. Unknown proof stays admin-only quarantine and does not wake agents or
grant consent. The welcome is optional **after** admission and addressed-agent
wake. Its delivery result is never sender authentication. There is no API that
accepts proof objects from mail bodies/headers or external callers.

This is strict, exactly aligned, full-coverage DKIM, **not universal DMARC** or
proof of a fresh SMTP delivery. Legitimate unsupported mail remains unknown.
See [authentication](ops/mail-authentication.md) and [replay](ops/mail-replay.md).
Explicit `login@`/`signup@` proof and substantive replies remain separate flows.

## State and boundaries

- One atomic reservation per `(tenant_id, human identity_id)`, across that
  human's organization, project and agent mailbox arrivals. Different humans
  and organizations have independent context. Active human, organization,
  membership/root authority, source row and destination are checked.
- Only independently proven, already admitted, unreleased evidence qualifies.
  Proof Message-ID/domain must match the stored source. Admin release of unknown
  mail never qualifies as proof or automatically triggers guidance.
- Verified inbound can establish **first-ever** outbound consent with a single
  conditional insert. Any existing consent history prevents passive re-grant,
  including explicit withdrawal or legacy failed-provisional-grant revocation.
  Concurrent first arrivals cannot insert multiple grants. The welcome requires
  active consent, and `sendMail` rechecks the latest withdrawal before delivery.
- Existing D1 `meta` holds `mail_welcome:v1:<tenant ULID>:<identity ULID>`.
  `INSERT ... ON CONFLICT DO NOTHING` reserves before attempting delivery. No new
  D1 migration or binding is needed. State contains only attempt/source-mail ids,
  timestamps, a fixed optional `setup_guidance` observation and `pending`,
  `sent`, `failed` or `no_consent`; finalization is
  attempt-bound. No exception names/messages, email bodies, login links or
  credentials are retained in delivery diagnostics.
- Tenant deletion includes only that tenant's colon-delimited keys in its
  existing transaction. Deployment does not execute real deletion or membership
  changes.

## Delivery guarantees and interruption

The guarantee is **at-most-once automatic welcome attempt**, not exactly-once
external delivery. Concurrent different messages cannot send several welcomes.
A crash or ambiguous transport outcome can leave `pending` before or after mail
submission. Never reclaim it on a timer or blindly replay a send. `failed` and
`no_consent` are terminal for automatic welcome too. Future explicit retries
require outcome reconciliation and a separately reviewed policy.

Unexpected optional consent/welcome failures never undo admission and cannot
prevent the earlier agent wake. A storage or wake failure is reconciled by
another independently verified ingress invocation with the stable stored mail
id; no unbound send is replayed. This release does not add a scheduled recovery
worker, and an interrupted message not redelivered may need administrator
reconciliation. See replay documentation for audit and permanent wake dedup.

Context identifies the mailbox type and links to normal sign-in, not
credential-bearing login links. It promises neither execution, a substantive
reply nor filing into an unaddressed project. Mail UI copy reflects one-time
context rather than routine acknowledgments.

## Conditional setup guidance (#85)

The same one-time welcome includes **response-recipient setup guidance only**
when the exact shared organization/project mailbox's preferences are absent or
validly explicitly empty. It links to the selected `/mail/recipients?address=…`
page and says that a **human organization administrator** can edit preferences.
Recipients who are not admins gain no management access from the link.
Preferences do not grant access, notify anyone, schedule responses or guarantee
replies. Configuration does not suppress the welcome itself or authenticate mail.

A valid nonempty preference list omits setup guidance, including when some or
all recipients become unavailable. Corrupt/unsupported data also omits it:
unknown is not evidence of absence. No recipient ids, labels, email addresses or
staleness details appear in the outgoing context. No organization/project
inheritance occurs. Direct-agent mail already has an explicit owner; shared
preferences never apply and no setup guidance is sent for it.

Reservation checks the exact preference snapshot (including absent data), stored
source destination/project/owner and current target availability atomically.
A changed snapshot refuses reservation with no send or silent retry. An eligible
later ingress invocation may try again only when **no reservation exists**;
it is not a replay of an outgoing attempt. Once reserved, the fixed
`setup_guidance` value is `no_configured_recipients` or `not_applicable`, retained
through finalization. Legacy records without the field are not reset or resent.
The mail explicitly describes the **reservation-time** observation, not future
configuration: preferences can change during transport. No lock or continuing
authority guarantee is implied.

This adds no recurring setup notices, per-message acknowledgments, response
scheduler, human notification or private-agent fanout. A later preference change
never triggers another welcome/guidance send. #85 still needs separately
boundary-tested actual notification/scheduling/delivery semantics; a preference
or self-recorded intention never substitutes for a substantive reply.

## Acceptance evidence

Native Workers tests exercise signed first/subsequent and concurrent different
messages across organization/project/agent mailboxes; concurrent identical replay;
transport, unexpected welcome, consent-storage and no-consent failures; terminal
ambiguous welcome; withdrawal and grant races; lost storage/wake responses;
legacy/byte-collision rejection; identity/tenant scope; forwarded evidence; and
the production email entry point with the fixed trusted DoH contract. Separate
welcome, DKIM, mailbox-access, login-proof and substantive-reply suites remain
regressions. Conditional-guidance tests cover unset/empty/nonempty/stale/corrupt
preferences, namespace isolation, exact destination/owner binding, configuration
and target changes before reservation, legacy/terminal deduplication, and
reservation-time wording. Signed production-entry tests verify unchanged proof,
mailbox ownership, no extra wake, one welcome and no later routine receipt. Public release smoke does not claim a real external mailbox delivery
or universal provider compatibility; source/live version/rollback evidence is
recorded on the issue after the managed release.
