# Independent mail replay/storage candidate (#134)

## Rollout status

`src/mail/replay.ts` is an internal, tested **inactive candidate**. The live
`handleProjectMail` still uses the receipt-dependent proof path. Neither this
increment nor the earlier DKIM/welcome candidates completes #134/#85/#130.
There is no new API, migration, binding, scheduler or deployed data operation.

`storeIndependentMailCandidate` takes original bounded bytes plus the transport
sender/destination, not a caller-supplied proof, tenant, identity, target or replay
record. It resolves current sender/destination authority and runs the pinned
mailauth Workers verifier itself. It copies the input before awaiting anything,
so the bytes authenticated, hashed and parsed cannot diverge through mutation.
Unknown DKIM proof produces no reservation/admission here; eventual ingress must
continue its protected quarantine path for unknown proof.

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
  evidence conditional on ownership, and finalizes `stored`. Current active human,
  root/membership, tenant and exact destination identity/project authority are
  rechecked **inside the write**, not merely before verification. Renaming,
  archiving or replacing a destination cannot redirect the resolved target.
- Reservation and row storage succeed/roll back together. A lost successful batch
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

Storage is independent of outbound consent. It does not grant/revoke consent,
change membership, send a receipt/welcome, write audit events or deliver an agent
wakeup. An explicit withdrawal remains exactly unchanged, including a latest
withdrawal with an older active consent row. Independent authentication does not
constitute permission to reinstate outbound consent.

Before enabling this candidate in ingress:

1. Preserve recipient/sender refusal, bounded original reads and ingress rate
   limits; keep unknown proof quarantined and unread by agents. Never fall back to
   a receipt as independent proof.
2. Integrate admitted storage with **idempotent/reconcilable** audit and addressed
   agent inbox delivery using the stable stored mail id. A lost storage response
   must not silently lose a wake, and must not blindly replay un-deduplicated
   side effects. Current candidate returns `stored`/`duplicate` only, not a
   claim that a wake or audit occurred.
3. Call the separately atomic one-time welcome only after durable admission;
   optional welcome failure/consent denial must not quarantine mail or prevent
   agent delivery. Preserve explicit login proof and substantive replies.
4. Test the actual handler with signed fixtures for first/concurrent/subsequent
   mail, replay/collision, all recipient/tenant/agent visibility boundaries,
   withdrawn/no consent, delivery failures and interruption reconciliation.
   Replace receipt-based expectations/UI copy truthfully only with that rollout.

Native Workers signed-fixture tests cover concurrent reservation, byte collision,
RSA/Ed25519 proofs, unsigned/tampered/expired/ambiguous mail, key errors, From
binding, current authority and write races, full rollback, ambiguous successful
response, legacy/corrupt/pending state, withdrawal and tenant-scoped deletion.
