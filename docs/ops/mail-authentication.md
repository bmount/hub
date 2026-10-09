# Receipt-free mail authentication (#85/#134)

## Verified platform contract (2026-10-09)

The authoritative [Cloudflare email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
exposes envelope `from`/`to`, ordinary `headers`, raw MIME, and forwarding/reply actions.
It documents that `reply()` requires a valid DMARC result, is allowed only once
per event, binds the reply recipient and sender domain, and rejects inbound
mail with more than 100 References entries. The interface does not expose a
typed authentication verdict. The [headers reference](https://developers.cloudflare.com/email-service/reference/headers/)
controls **outgoing** headers; it is not an ingress authenticity guarantee.

Thus successful `reply()` supplies proof; failed delivery does **not** mean
DMARC failure. Consent, MIME, transport, duplicate replies, and References
limits can prevent proof from becoming available. Exception text is not a
trusted verdict either.

## Implemented boundary

Organization, project, and agent mail requires an active human member/root,
rate and actual-byte size checks, **exactly one outer From mailbox matching the
envelope sender**, and strict independent cryptographic DKIM proof on the
original bytes. Atomic tenant/sender/exact-mailbox/Message-ID replay storage and
scoped audit precede admission. Routine receipts are not sent. Duplicate,
multiple, missing, or grouped From headers stay quarantined without new consent
or notification. Display names and address case are supported through
PostalMime's address parser. Inner forwarded From headers are only evidence.

Unknown proof stays admin-only, never wakes an agent, and does not gain new
consent. Neither pre-existing consent nor welcome success authenticates mail.
No Authentication-Results, ARC, or custom header grants admission. Optional
welcome failure does not downgrade verified evidence. `login@`/`signup@` retain
successful Cloudflare reply proof; reply failure never implies DMARC failure.

Passive project mail does not reinstate revoked consent. Existing consent
rows cannot distinguish an explicit withdrawal from rollback of a failed
provisional grant, so **both** are conservatively respected. A subsequent
explicit request to `login@`/`signup@` can establish new consent only through
the existing successful reply path. This limitation must remain visible
until provenance of revocation can be recorded independently.

## Independent verifier and admission policy

`src/mail/dkim.ts` produces independent **DKIM proof** from
original bytes using pinned `mailauth@7.1.1` in strict mode. Tests run inside
the existing Workers pool, not just Node. Native RSA-SHA256 and Ed25519-SHA256
fixtures pass. A narrow version-pinned adapter translates Node's `rsa-sha256`
digest alias to Workers' `sha256` spelling; mailauth still owns all parsing,
canonicalization, key validation and native cryptographic verification. There
is no global crypto patch or hand-written verifier. Changing this dependency
requires rechecking that private adapter interface and signed fixtures.

Policy requires exact signing-domain alignment (not relaxed organizational
alignment), exactly one outer From bound to the expected envelope, agreement
between address parsers, an unambiguous Message-ID, non-testing keys, RSA keys
of at least 2048 bits, valid signature time and no `l=` body limit—even one
covering the currently complete body. Each present semantic header affecting
content, copied-mail permissions, reply targets or threading must be covered
by the **same** passing signature. This includes **every outer `Content-*`
header**, not only Content-Type, Transfer-Encoding and Disposition: Content-ID,
Content-Description, Content-Language and future MIME extensions cannot carry
unsigned semantic authority. Fully signed mixed-case/folded MIME fields work;
unsigned extensions and duplicate semantic headers are refused. Inner MIME part
headers are protected by the full signed body hash, not separately by `h=`.
Coverage from different passing signatures is never combined; a later complete
signature may pass even if an earlier signature lacks coverage.
Unsigned Authentication-Results/ARC headers do not supply authority.

Key resolution in `src/mail/dkim-dns.ts` uses only
`https://cloudflare-dns.com/dns-query`, with redirects refused, validated DNS
names, matching TXT questions and a 16 KiB response limit. At most six actual
network queries (including CNAME followups) share a five-second per-message
budget and two-second per-query timeout. Trust is the fixed HTTPS resolver;
DNSSEC validation is not claimed. No sender-controlled URLs or native DNS
fallback are used.

Provider-style CNAME key delegation is supported: up to four connected aliases,
with case/trailing-dot normalization, whether bundled in one recursive response
or requiring followup TXT queries. Every answer must belong to that chain.
Cycles, conflicting/duplicate aliases, CNAME+TXT at the same owner, unrelated
answers and unsupported record types fail closed. Additional sections cannot
supply a key. Exactly one final TXT record is required: the pinned verifier reads
only the first record, so multiple records are refused rather than letting answer
order choose authority. Delegation never changes the required original signing
`d=`/From/envelope domain alignment.

Split quoted TXT strings support RFC 1035 decimal-byte and printable literal
escapes. Malformed, non-printable/non-ASCII strings, segments over 255 bytes,
more than 32 segments or presentation data over 8 KiB are refused. Escaped DNS
*names* remain unsupported. Tests exercise real RSA/Ed25519 signed bytes and the
production email entry point with provider-style delegated/escaped keys; these
are synthetic trusted-resolver responses, not evidence of real provider delivery.
Header bytes are capped at 64 KiB, signatures at six and raw mail at 10 MiB.

The handler bounds **actual** raw stream bytes before parsing, verification or
consent and records actual size. The verifier is connected only through atomic
replay storage: a valid signature alone is not enough to bypass conflicting,
legacy or pending state. See [replay](mail-replay.md) for storage, audit and
permanent agent-wake dedup, including lost-response reconciliation.

This is limited domain-aligned DKIM coverage, **not universal DMARC**, SPF or
ARC forwarding support. Failure/absence/unsupported formats remain unknown.

## Scope and remaining limitations

Routine receipt suppression and [one-time welcome](../mail-welcome.md) are
implemented in the ingress integration, with signed native-Workers handler tests.
Explicit response-recipient configuration and scheduled-response state remain
separate work; setup links do not promise a substantive reply. No held mail is
automatically released or relabeled. No D1 migration, real tenant/membership or
credential changes are performed by deployment. The inbox adds a non-destructive
DO-local mail dedup table through its existing initialization path.

Proof remains deliberately limited: no universal DMARC, SPF/ARC forwarding or
fresh-delivery guarantee. DNS chains beyond the bounded limits, escaped DNS names,
non-ASCII TXT data and other unsupported proof remain accurately unknown and
fail-closed. Real provider compatibility and external
mail delivery require separate observations; public deployment smoke tests do
not prove them. Interrupted effects can require administrator reconciliation if
there is no independently verified redelivery; this release adds no recovery
scheduler. Never retry an ambiguous welcome automatically.
