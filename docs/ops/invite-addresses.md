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

## Independent address-control boundary (#93 follow-up)

**Syntax validation and invite possession are not address-control proof.**
The prior `acceptInvitePage` accepted a same-origin bearer POST before independent
verification: it could create an identity, record an email proof and mint a browser
session, or grant membership/root to an existing identity. A wrong logged-in identity
did not stop that grant. These were source-level and disposable-fixture findings,
not a real-user exploit claim or a retrospective relabeling of anyone's proof.

That browser bearer acceptance path is now removed. GET and legacy same-origin POST
both show a read-only invitation explaining the exact addressed email and verified
Google onboarding. Neither claims the invite nor writes identity, membership, root,
session, proof or invite-accept events. Existing sessions, legacy invite-derived
proofs, caller-supplied email fields/headers, concurrent POSTs and replay cannot
substitute for verification. Invalid, expired, revoked, consumed and archived-tenant
links remain neutral. Host and Origin checks are retained; pages remain no-store.
No new outbound verification email or consent grant is introduced.

The existing Google code flow remains the production acceptance path: browser-bound
single-use state, PKCE, nonce and cryptographic ID-token verification precede
`admitGoogle`, which requires verified email and selects invitations for that exact
normalized address. New-account membership and existing/new root invitations are
supported; the proof is `google`, never invite-derived `email`. Google account
binding, hub-address rejection and root email-only extra-check policy are unchanged.
The invitation's link leads to that normal flow, with a tenant-slug landing hint,
not an authorization claim or the invite token in the provider URL.

If Google is unconfigured, the invitation truthfully says independent verification
is unavailable and offers no acceptance button. Without a matching verified Google
account it stays unaccepted. **Email-only onboarding for new invitations remains
unavailable**; do not fall back to trusting the invite or a legacy session. Existing
email login/reproof and consent withdrawal are unchanged. #93 is not claimed fully
complete until the supported onboarding acceptance and any required email-only path
are reconciled. No schema, real identity/membership/root or credential mutations.

## Evidence

`test/invite-email.test.ts` exercises direct DB, API JSON, browser forms,
bootstrap, the unchanged MCP denial and normalized rendered/API results in
the native Workers pool. It includes actual boundary lengths, every representative
control placement, conservative unsupported formats and positive dot-atom cases.
Existing invite/Google/agent-domain/tenant authorization regressions remain.
`test/invite-ownership.test.ts` compares complete grant/proof/session/event rows
before and after actual Worker GET/POST calls: anonymous/forged email, wrong identity,
legacy proof/session, replay, concurrent requests, revoked/expired links and archived
tenants. A direct-page fixture covers unconfigured Google. Two regressions failed
against baseline `c11cfdb`; the first post-fix snapshot assertion mistakenly compared
D1 query timing metadata and was corrected to compare rows, not weaken the boundary.
The signed local-provider flow in `test/google-login.test.ts` proves new tenant and
existing/new root admission, proof provenance, exact callback replay rejection and
no grants for unverified email, wrong account or forged token signature. Existing
invite/proof tests now assert that bearer possession cannot manufacture email proof;
the first full run identified two historical expectations and was not counted passing.
Final local typecheck and full default suite pass: 1827 Workers tests/180 files
plus 7 host dependency checks. Expected poisoned-Inbox exceptions are intentional
boundary fixtures. Remote main and latest production record remained `c11cfdb`
on final fetch before integration; no upload/deploy/send effects were replayed.
Release evidence is recorded on #93 after ordinary integration and managed helper
verification; documentation alone is not a deployment or native production-user
ownership-acceptance claim.
