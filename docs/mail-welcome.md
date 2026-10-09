# One-time newcomer mail context (#130)

## Current rollout status

`src/mail/welcome.ts` is a tested internal candidate, **not called by the live
receipt-dependent ingress handler**. Routine `Received` replies are still sent
for sender proof. Do not claim receipt suppression or receipt-free admission is
implemented. Enable the welcome only with #134's independent cryptographic proof
and atomic inbound replay handling; do not use successful/failed welcome delivery
as sender authentication. The DKIM verifier candidate alone is not an admission
policy. Never accept proof objects supplied through an API, mail body or header.

## State and boundaries

- One reservation per `(tenant_id, human identity_id)`, spanning that human's
  project, organization and agent-address mail within that organization. Different
  organizations have independent context. Sender membership/root authority and
  active organization/identity are checked; agents cannot receive human welcome.
- Only independently verified mail that is already admitted can supply context.
  The internal proof must match its stored Message-ID and sender domain; source
  identity, tenant, email and live destination must agree. Administrative release
  of unknown mail is not proof and does not qualify.
- Active consent is required and the latest explicit withdrawal wins, even if an
  older active row remains. Welcome never creates/reinstates consent. The outbound
  path rechecks consent; explicit login proof remains a separate flow.
- Atomic `INSERT ... ON CONFLICT DO NOTHING` in existing D1 `meta` reserves the
  namespaced key `mail_welcome:v1:<tenant ULID>:<identity ULID>` before sending.
  No new migration, binding or real data mutation is needed to deploy the
  inactive candidate. When integration is enabled, records contain only attempt
  and source-mail ids, timestamps, and fixed status codes.
- Status is `pending`, `sent`, `failed`, or `no_consent`, independent of inbound
  authentication/admission. An attempt-bound compare-and-set finalizes status.
  No exception fields, email contents, authentication links or credentials are
  retained in delivery diagnostics. Tenant deletion includes these keys in its
  existing transactional deletion path, without touching other tenants' keys.

## Delivery guarantees

This is **at-most-once automatic attempt**, not exactly-once delivery. Concurrent
messages cannot send multiple welcomes. A crash can leave `pending` before or
after transport submission: do not reclaim it on a timer or blindly replay a
send. `failed` and `no_consent` are terminal for automatic welcome too. Any future
retry operation must reconcile the external outcome and have its own explicit
policy; it must not become another routine acknowledgment.

The context identifies the mailbox type, links to normal sign-in/workspace setup
pages (no credential links), and does not promise execution, filing to a project,
or a substantive response. No routine response is part of this component.
Substantive replies and login proof are unaffected.

## Remaining acceptance work

1. #134 must reserve/reconcile replay atomically using the verified Message-ID,
   sender and exact tenant/mailbox scope before independent-proof admission.
2. Replace the receipt-dependent path with that verified admission path. Unknown
   proof stays fail-closed; arbitrary Authentication-Results/ARC is not authority.
3. Call welcome after durable admission, without letting welcome errors quarantine
   authenticated mail or block addressed-agent delivery/wakeup. Never fall back to
   a routine receipt as welcome retry.
4. Handler-level signed-fixture tests must prove first/concurrent/subsequent mail,
   delivery failure, no consent/withdrawal, duplicate/replayed mail, login proof,
   tenant/mailbox boundaries and unchanged substantive replies. Only then close
   #130/#85 or claim suppression is live.
