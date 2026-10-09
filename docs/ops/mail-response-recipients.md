# Shared-mailbox response-recipient preferences (#85)

This increment adds **explicit preferences, not response routing or scheduling**.
Receipt-free [independent authentication](mail-authentication.md), quarantine,
[replay](mail-replay.md), direct-agent mailbox access/wake and
[one-time welcome](../mail-welcome.md) are unchanged. A configured recipient
is not a promised substantive response, evidence of a scheduled response, or
permission to access a private mailbox. Configuration does not suppress welcome
or setup guidance. Do not use a nonempty preference list as a response guarantee.

## API

These tenant-host verbs are human-admin only and deliberately not exposed over
MCP/assistant connections. Normal authentication, role, same-Origin cookie and
tenant checks apply. Editing requires browser proof within 60 minutes.

- `POST /api/mail.response_recipients`, JSON `{ "address": "org@pimwell.com" }`:
  returns `revision`, `state`, currently eligible `recipients` (identity IDs),
  `unavailable_count`, `updated_at`, `project_id` and canonical `address`.
  `automatic_scheduling: "not_implemented"` and `response_guaranteed: false`
  are always explicit.
- `POST /api/mail.set_response_recipients`, JSON
  `{ "address": "org.project@pimwell.com", "recipients": ["<human identity id>"], "expected_revision": 0 }`:
  replaces preferences with up to ten **unique active human member/admin IDs
  with active membership in this exact organization**. Readers, agents,
  strangers, removed memberships and inactive identities are refused as a whole.
  An empty array explicitly clears preferences. No implicit defaults or
  organization-to-project inheritance exist. Root's global authority alone
  does not make root an eligible recipient without explicit membership.

Only active organization/project addresses at the hub's own domain are accepted.
Other tenants, missing/archived projects and direct-agent addresses return
`not_found`. Direct-agent mail already has its own private recipient boundary;
this API cannot reassign it. Settings bind internal tenant/project IDs, not a
caller-supplied tenant or a mutable address slug.

Read first: absent settings have revision `0`, state `unset`; explicit empty
settings have state `empty` and a positive revision. Valid nonempty settings are
`configured` only while every recipient remains eligible, otherwise `stale`.
Stale IDs are not returned (only the count); currently eligible IDs retain their
configured order. Neither state means notifications, work or replies exist.
Malformed/unsupported stored settings return `invalid`, revision `null`, no
recipients; edits fail closed for administrator reconciliation, not silent reset.

## Durability and boundaries

Existing D1 `meta` stores `mail_response_recipients:v1:<tenant id>:<project id|org>`.
No new schema/migration is needed. The revision is an optimistic edit guard, not
a replay key: identical/stale repeated commands conflict and must be reconciled
by reading. Concurrent first or later edits at one revision commit at most one
preference update and its audit event, in one D1 transaction. Membership/identity,
actor admin authority, tenant and project eligibility are repeated inside the
atomic compare-and-swap. A failing audit rolls back the preference change. Audit
text contains no recipient IDs, addresses, mail content or transport errors.
Read eligibility is a bounded current observation, not a lock or future grant.

The existing authorized tenant-deletion implementation cleans only that tenant's
preference keys as part of its transaction. Tests use disposable fixtures;
this release does not delete real tenants or edit real preferences, users,
memberships, consents, tokens or grants.

## Next increments / acceptance not claimed

A usable setup UI, explicit independently verified per-message scheduling state,
transactional notification intent, durable human delivery/ack/reconciliation,
response cancellation/failed/unknown outcomes and conditional setup guidance
remain #85 work. Scheduling must separately authorize the actual mailbox reader,
not widen grants from a preference. It must never silently reroute private-agent
mail or treat an administrator release/unknown proof as cryptographic admission.
Do not activate preference-driven fanout or suppress guidance until those effects
have a truthful durable state and boundary tests. Agent responders need a
separate bounded access/delivery design; this human-only increment does not
pretend to implement them. Real-provider mail acceptance remains #134's external
observation, not established by synthetic signed fixtures or public smoke tests.

## Tests

Native-Workers regressions cover unset/empty/configured/stale/invalid states,
org/project and tenant isolation, human-admin/origin/proof/MCP denials, unsupported
recipients/input, current eligibility changes, concurrent initial/later CAS,
atomic archive/removal races and audit rollback, explicit clear, scoped cleanup
and no send/consent/membership/attention effects. Signed handler regression proves
that preferences do not cause extra wakes, alter admitted mailbox ownership,
schedule replies or suppress one-time context; later mail still sends no routine
receipt. Existing mail access, authentication, replay, welcome, login and
substantive-reply boundaries are retained.
