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

## Browser setup

Human admins with a browser session can open **Mail → Set response-recipient
preferences** (`/mail/recipients`). Select the organization or an active project
mailbox, then choose up to ten currently eligible people. Direct-agent addresses
cannot be selected or reassigned. The page is unavailable to agents, assistant
connections, non-admins, other tenants and anonymous callers. Editing displays
the existing extra-proof flow when browser confirmation is over 60 minutes old;
reads do not require a new proof.

The form uses ordinary checkbox controls and a native POST to the existing
command, with the displayed `expected_revision`. Unchecking all choices
**explicitly clears preferences**. Browser saves store selected people in the
form's display order (name, then ID), not a priority/routing order. The form
requires exactly one `_recipients_present=1` marker; missing or duplicate
markers fail without implicitly clearing. Repeated `recipients` fields become
an array only for this verb, with the same duplicate/size/ID/eligibility
validation as JSON. All existing Origin/authentication and actual-byte request
bounds apply; other form verbs' parsing is unchanged. No JavaScript is required
for selection or saving.

Stale preferences show the unavailable count, never removed/foreign IDs or
labels, and warn that saving replaces the list. Invalid stored preferences
have no save/reset form. The page refuses a partial form if eligibility changes
between its reads or if more than 200 eligible people exist; reload/reconcile or
use the explicit revision-checked API rather than silently dropping unseen
selections. Current eligible names/emails are shown only to the authorized
human admin and are escaped. Pane keys include current selection, revision,
eligibility and fresh-proof observations, preventing navigation from retaining
an obsolete form. Responses are `no-store`.

A successful POST redirects back to the selected mailbox with current state;
a stale or repeated save conflicts. An ambiguous save must be reconciled by
reloading/reading its revision and selection, **not blindly resubmitted**. Page
reads and preference saves do not send mail, wake anyone, change membership,
consent or mailbox grants, schedule responses, or suppress existing guidance.
The page explicitly discloses that automatic scheduling is not implemented and
that preferences do not guarantee a reply.

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

Explicit independently verified per-message scheduling state, transactional
notification intent, durable human delivery/ack/reconciliation,
response cancellation/failed/unknown outcomes and conditional setup guidance
remain #85 work. Scheduling must separately authorize the actual mailbox reader,
not widen grants from a preference. It must never silently reroute private-agent
mail or treat an administrator release/unknown proof as cryptographic admission.
Do not activate preference-driven fanout or suppress guidance until those effects
have a truthful durable state and boundary tests. Agent responders need a
separate bounded access/delivery design; this human-only increment does not
pretend to implement them. Browser preference setup is implemented, but local
native-Workers form/page acceptance is not a live-admin configuration test or
proof of actual human notification/delivery. Real-provider mail acceptance remains #134's external
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
substantive-reply boundaries are retained. Browser setup regressions cover
admin discoverability, native multi-checkbox POST and explicit clear, independent
org/project forms, fresh-proof and Origin gates, stale/corrupt/no-choice/overflow
states, safe rendering, private/foreign/archived addresses, revoked sessions,
changed pane keys, marker/recipient validation, membership changes between
display and save, optimistic conflicts and no mail/consent/attention effects.
These are native-Workers HTTP acceptance tests, not real-provider mail or a
claim of browser-engine layout testing.
