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
  timestamps and `pending`, `sent`, `failed` or `no_consent`; finalization is
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

Context identifies the mailbox type and links to normal sign-in/workspace setup
pages, not credential-bearing login links. It promises neither execution,
a substantive reply nor filing into an unaddressed project. Mail UI copy reflects
one-time context rather than routine acknowledgments.

## Acceptance evidence

Native Workers tests exercise signed first/subsequent and concurrent different
messages across organization/project/agent mailboxes; concurrent identical replay;
transport, unexpected welcome, consent-storage and no-consent failures; terminal
ambiguous welcome; withdrawal and grant races; lost storage/wake responses;
legacy/byte-collision rejection; identity/tenant scope; forwarded evidence; and
the production email entry point with the fixed trusted DoH contract. Separate
welcome, DKIM, mailbox-access, login-proof and substantive-reply suites remain
regressions. Public release smoke does not claim a real external mailbox delivery
or universal provider compatibility; source/live version/rollback evidence is
recorded on the issue after the managed release.
