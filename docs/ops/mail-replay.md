# Independent mail replay/storage (#134)

## Rollout status

`src/mail/replay.ts` is integrated with `handleProjectMail`. Independently
verified admission no longer depends on outbound acknowledgments. Routine
`Received` replies are removed; optional one-time welcome follows agent wake.
There is no new public API, D1 migration, binding or recovery scheduler.

`storeIndependentMailCandidate` takes original bounded bytes plus the transport
sender/destination, not a caller-supplied proof, tenant, identity, target or replay
record. It resolves current sender/destination authority and runs the pinned
mailauth Workers verifier itself. It copies the input before awaiting anything,
so the bytes authenticated, hashed and parsed cannot diverge through mutation.
Unknown DKIM proof produces no reservation/admission here; ingress stores it in
protected admin-only quarantine without consent, notification or agent wake.

This is **strict, exactly domain-aligned, full-coverage DKIM**, not universal
DMARC, SPF, ARC, mailbox login proof, proof of fresh SMTP delivery, or a claim that
all legitimate mail providers are supported. It does not trust arbitrary
Authentication-Results. A domain's valid signer can attest its From mailbox;
From/envelope binding and current human membership are additional requirements.
A signed message may legitimately arrive at several organization/project/agent
mailboxes (including Bcc): envelope destination is scoped separately and is not
claimed to be authenticated by DKIM. Unknown, failed, expired, ambiguous,
body-limited or unsigned-semantic-header signatures are not eligible.

## Atomic storage and reconciliation

- Replay scope is `(tenant id, normalized envelope email, normalized exact
  destination address, verified case-sensitive Message-ID)`. SHA-256 of a JSON
  tuple prevents separator ambiguities. The `meta` key starts with
  `mail_replay:v1:<tenant ULID>:`; different tenants/mailboxes are independent.
- `meta` values hold only internal attempt/mail/identity ids, reservation time,
  original-byte SHA-256 and `pending`/`stored` status. No raw mail, headers,
  addresses, credential links or error detail is copied into this state.
- One transactional D1 batch atomically reserves the unique key, inserts admitted
  evidence conditional on ownership, finalizes `stored`, and inserts one scoped
  `mail.received` event conditional on this attempt. Current active human,
  root/membership, tenant and exact destination identity/project authority are
  rechecked **inside the write**, not merely before verification. Renaming,
  archiving or replacing a destination cannot redirect the resolved target.
- Reservation, row storage and audit succeed/roll back together. A lost successful batch
  response is reconciled through another verified invocation as `duplicate`;
  no additional inbound row is inserted. A failed batch can be verified/retried
  after reconciling storage, because it made no outbound or wake effects.
- Same scope with different original bytes is `collision`, even if both signatures
  genuinely pass. Transport-only changes therefore conservatively block too;
  byte equality is not used as a replacement for signature verification.
- Existing pre-rollout admitted **or quarantined** rows block admission even when
  no replay record exists. Never upgrade admin-released/legacy mail into
  cryptographic proof, replace its evidence or send another notification.
- `pending`, corrupt state, identity mismatch, missing evidence, quarantine or
  administrative release produce `blocked`. No timeout, automatic reclaim,
  deletion or lease can make ambiguous state admissible again. Inspect/reconcile
  explicitly; do not blindly retry a send.
- A duplicate's row id is returned only with current caller/destination authority
  and matching tenant, identity, sender, destination, Message-ID, target ids and
  unreleased admitted verdict. There is no public replay-state read surface.
- Tenant deletion removes only its colon-delimited replay prefix in the existing
  transaction. Tests exercise deletion; deployment does not run real deletion.

Replay history has no automatic expiry: clearing it would re-enable replay of
old signatures without `x=` expiry. Retention/size policy requires a separately
reviewed admission rule, not a timer deleting dedup records.

## Consent and side effects

Storage is independent of outbound consent. It atomically writes the admission
audit, but does not grant/revoke consent, change membership, send mail or wake
an agent. An explicit withdrawal remains exactly unchanged, including a latest
withdrawal with an older active consent row. Independent authentication does not
constitute permission to reinstate outbound consent.

Ingress preserves recipient/sender refusal, actual bounded reads and rate limits.
It never falls back to receipt proof or prior consent. Valid-signature collisions,
legacy/corrupt/pending states and changed authority reject without new evidence
or side effects rather than upgrading ambiguous proof.

Stored and verified duplicate results reconcile agent delivery by stable
`mail:<mail id>` key. The tenant/identity-bound inbox now transactionally stores a
permanent id-only `mail_delivered` tombstone with the visible item. This additive
DO-local table uses `CREATE TABLE IF NOT EXISTS`; no manual migration is run.
Dedup survives 30-day acknowledged-item pruning. Only duplicate-key conflicts are
ignored, not other constraints; failed item insertion rolls back its tombstone.
A lost wake response is safely reconciled through duplicate ingress. Tombstones
have no automatic expiry; deleting them would re-enable old signed mail wakes.

There is no scheduled recovery worker in this increment. If an admission or wake
response is lost and no independent redelivery occurs, administrator reconciliation
may be needed; do not claim guaranteed eventual wake or external welcome delivery.
The existing inbox/item tenant binding remains authoritative.

After agent delivery, optional first-ever consent and atomic one-time welcome run
independently of authentication. Existing consent history prevents passive re-grant.
Unexpected optional errors log a fixed code and cannot undo admission or the wake.
Welcome ambiguous/failed states are never automatically retried. Explicit login
proof and substantive replies are unchanged. See [welcome](../mail-welcome.md).
Signed-fixture handler tests cover the production DoH path and these interruption,
concurrency, failure, consent and mailbox isolation contracts.

Native Workers signed-fixture tests cover concurrent reservation, byte collision,
RSA/Ed25519 proofs, unsigned/tampered/expired/ambiguous mail, key errors, From
binding, current authority and write races, full rollback, ambiguous successful
response, legacy/corrupt/pending state, withdrawal and tenant-scoped deletion.
