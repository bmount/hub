# Mail authentication: #85 increment and remaining dependency

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
rate and size checks, **exactly one outer From mailbox matching the envelope
sender**, and successful Cloudflare reply proof before admission. Duplicate,
multiple, missing, or grouped From headers stay quarantined without consent
or a reply attempt. Display names and address case are supported through
PostalMime's address parser. Inner forwarded From headers are only evidence.

Reply failure is recorded as `authentication unknown` with a bounded local
notification result, not as forged mail or DMARC failure. Unknown mail stays
admin-only, never wakes an agent, and does not gain a new active consent.
Pre-existing consent does not authenticate a later message. No
Authentication-Results, ARC, or custom header grants admission.

Passive project mail does not reinstate revoked consent. Existing consent
rows cannot distinguish an explicit withdrawal from rollback of a failed
provisional grant, so **both** are conservatively respected. A subsequent
explicit request to `login@`/`signup@` can establish new consent only through
the existing successful reply path. This limitation must remain visible
until provenance of revocation can be recorded independently.

## #134 independent verifier increment (not yet an admission path)

`src/mail/dkim.ts` now produces an independent **DKIM proof candidate** from
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
by the **same** passing signature. Duplicate semantic headers are refused.
Unsigned Authentication-Results/ARC headers do not supply authority.

Key resolution uses only `https://cloudflare-dns.com/dns-query`, with redirects
refused, TXT/name validation, matching DNS questions/answers, a 16 KiB response
limit, at most six lookups, a two-second per-query timeout and five-second total
lookup budget. Trust is the fixed HTTPS resolver; DNSSEC validation is not
claimed. CNAME key indirection and escaped TXT records are currently unsupported
and fail closed. Header bytes are capped at 64 KiB, signatures at six and raw
mail at 10 MiB. No sender-controlled URLs or native DNS fallback are used.

The active inbound handler now bounds **actual** raw stream bytes before MIME
parsing/consent/reply and records actual byte size. The verifier is deliberately
not connected to admission yet: a valid signature can be replayed. Tests make
that limitation explicit. Receipt-based admission and consent withdrawal
behavior remain unchanged by this increment.

This is limited domain-aligned DKIM coverage, **not universal DMARC**, SPF or
ARC forwarding support. Failure/absence/unsupported formats remain unknown.

## Not completed / next increment

Routine receipt suppression, one-time verified-user welcome (#130), explicit
response-recipient configuration, and scheduled-response state are **not**
implemented by this increment. Configured recipients must never be presented
as a promise that a response will be sent.

Next: connect the verified candidate only after atomic, tenant/mailbox-bound
Message-ID replay reservation/deduplication is implemented and tested, then
remove routine Received replies. Verify that admission does not depend on an
optional welcome's delivery, that repeated delivery neither grants consent
again nor wakes an agent twice, and that revoked consent is never reinstated.
Finish one-time welcome/context under #130 separately. Missing proof must
stay unknown, not fall back to prior consent or an attacker-supplied
Authentication-Results header. No held mail may be automatically released.

No schema, tenant, membership, credential, or infrastructure changes are
required or performed by this increment. Existing held mail is not released
or relabeled automatically.
