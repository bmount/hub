# Invite address validation (#93)

## Creation policy

`normalizeInviteEmail` in `src/db/invites.ts` implements a conservative supported
mailbox format, not universal RFC 5322 syntax:

- Raw input is at most 254 ASCII characters. C0 controls, DEL and non-ASCII
  characters are refused **before** normalization, including leading/trailing
  tabs and newlines. Outer ASCII spaces are trimmed; existing lower-case
  identity normalization is retained.
- Exactly one `@`, an ASCII dot-atom local part of at most 64 characters and
  a dotted DNS-style domain. Local dots cannot lead, trail or repeat. Domain
  labels are 1–63 alphanumeric/hyphen characters, with no leading/trailing
  hyphen, empty label or trailing dot.
- Plus tags, subdomains, ASCII punycode labels and dot-atom punctuation are
  supported. Display-name/address lists, comments, quoted local parts, domain
  literals, single-label domains and internationalized mailbox syntax are not.

Both the `invite.create` parser and the shared DB creation function enforce
this policy. Direct/internal and bootstrap root-invite creation cannot skip
validation. Rejected creation does not create an invite, identity, membership,
email proof or successful invite audit. HTTP failure auditing and existing
session-touch/rate accounting remain; rejection is not a no-telemetry claim.
No DNS lookup or outbound verification message is added.

The browser creation form reminds the inviter to check the complete address.
The API result includes the normalized address, and the invite-ready page
renders that address safely with a spelling/ownership warning. Plausible typos
still pass. MCP assistant connections still cannot create invites, even with
write consent; this increment adds no new exposure or grant.

## Unresolved address-ownership acceptance boundary

**Syntax validation does not prove address ownership or fix bearer invite
acceptance. #93 is not complete.** Inspection of `acceptInvitePage` shows that
a same-origin POST with an open invite token currently accepts it before any
address-control check. For a new identity it creates an identity, records an
email proof and mints a browser session; for an existing identity it can add
membership or promote a root without minting a new session. A different logged-in
identity does not prevent the acceptance effect. The token itself is not
independent evidence that its holder controls the addressed mailbox. These
are source-level findings, not a claim of exploit observation against real
users or a retrospective relabeling of their proofs.

The Google admission path separately requires verified Google email claims
and looks up invites for that exact email; that path must remain bound to the
verified identity. A follow-up must require independent exact-address proof
before *any* invite claim/grant/session/proof mutation, including bootstrap/root
and existing-account cases. Do not treat a legacy invite-derived session or
proof as independent proof, and do not merely block new session creation while
allowing membership/root changes. Require wrong-identity, anonymous, expired,
unverified/forged email, stale/revoked proof, concurrent claim and replay tests.
A safe new-person onboarding path must be preserved (verified Google already
supports invited addresses); any email onboarding addition must retain the
existing authenticated login proof and consent boundaries. This release does
not perform schema, real identity/membership, root or credential mutations.

## Evidence

`test/invite-email.test.ts` exercises direct DB, API JSON, browser forms,
bootstrap, the unchanged MCP denial and normalized rendered/API results in
the native Workers pool. It includes actual boundary lengths, every representative
control placement, conservative unsupported formats and positive dot-atom cases.
Existing invite/Google/agent-domain/tenant authorization regressions remain.
Release and completion evidence is recorded on #93; documentation alone is
not a deployment or ownership-acceptance claim.
