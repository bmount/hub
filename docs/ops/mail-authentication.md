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

## Not completed / next increment

Routine receipt suppression, one-time verified-user welcome (#130), explicit
response-recipient configuration, and scheduled-response state are **not**
implemented by this increment. Configured recipients must never be presented
as a promise that a response will be sent.

To remove the receipt proof dependency safely, obtain a documented,
non-forgeable per-message Cloudflare ingress authentication contract, or
integrate an established cryptographic DKIM verifier over the original raw
bytes with trusted DNS, strict From/envelope binding and aligned signing
domain checks. Verify body/header coverage, duplicate From, altered bodies,
unaligned signatures, DNS errors/timeouts, and forwarded messages in the
Workers runtime. Missing proof must stay unknown, not fall back to prior
consent or an attacker-supplied Authentication-Results header.

No schema, tenant, membership, credential, or infrastructure changes are
required or performed by this increment. Existing held mail is not released
or relabeled automatically.
