# Pimwell identity: design

Date: 2026-10-06
Status: approved design, pre-implementation
Scope: the hub control plane for tenants, identities, sessions, invites,
consent, and agent credentials. Email mailboxes, the MCP server, and messaging
get their own specs and build on this one.

## 1. Purpose

Pimwell (pimwell.com) is an internal team hub for a handful of humans and a
larger number of agents. Everything in the hub, including the Ardi git host,
needs one answer to "who is this, in which tenant, acting in which run, and
what may they do." This spec defines that answer.

Design goals:

1. Hub-owned identity. No dependency on a corporate directory. The only
   external proof in v1 is control of an email address.
2. Never send unsolicited email. The hub sends to an address only after that
   address has written to the hub. Invites travel out-of-band.
3. Agents are first-class. Most principals will be agents. Every agent has a
   responsible human, and every agent run is a distinct session that all
   activity is attributed to.
4. Multi-tenant from the start, even though there is one tenant today.
5. Long-lived human sessions, with fresh proof demanded only for sensitive
   actions.
6. Mostly Cloudflare primitives, SQLite-shaped data, schema as interface.

## 2. Non-goals for v1

- Passwords. There are none.
- Google or passkey sign-in. The schema reserves room (section 6.6); nothing
  is built.
- Per-namespace permissions. Roles live at tenant level.
- Agent-to-agent delegation, agents creating agents, or agents inviting.
- Mailboxes, agent email, and the outbound consent rules for arbitrary mail.
  This spec covers only the two auth-related addresses.
- OAuth authorization server for MCP clients. Separate spec; this one provides
  the session and fresh-proof primitives it needs.
- Public signup. Every account begins with an invite from a root or admin.
- SCIM, SSO, audit export to third parties.

## 3. Privacy rule

No organization, department, or person names appear in code, configuration,
example data, hostnames, or commit messages. Example tenants in this document
are `acme` and `blue`. Logs never contain email bodies, magic-link tokens, or
raw bearer tokens.

## 4. Object model

```
tenant                     acme.pimwell.com
  namespace (optional)     research/
    project                a repo, a tracker, later a channel or mailbox
identity                   one human or one agent, global across tenants
  membership               identity x tenant, with a role
  session                  one browser (human) or one run (agent)
```

### 4.1 Tenant

A tenant is an isolation boundary with its own subdomain, projects, and
memberships. Created only by a root. Fields: `id`, `slug` (DNS label, the
subdomain), `display_name`, `state`, `created_at`.

### 4.2 Namespace

An optional grouping inside a tenant. A super-project or team. Fields: `id`,
`tenant_id`, `slug`, `display_name`, `state`. Carries no permissions in v1.
Paths are `/<namespace>/<project>`; projects without a namespace sit at
`/<project>`. A project slug and a namespace slug cannot collide at the top
level of a tenant.

### 4.3 Project

The unit that subsystems attach to. Fields: `id`, `tenant_id`,
`namespace_id` (nullable), `slug`, `kind` (`repo`, `tracker`, later `channel`,
`mailbox`), `display_name`, `state`. Ardi repositories are projects of kind
`repo`; Ardi's per-repo Durable Object is keyed by project id.

### 4.4 Archived state

Tenants, namespaces, and projects have `state` in {`active`, `archived`}.
Archiving a namespace archives its projects. Archived objects keep their URLs,
remain readable, disappear from default listings, switchers, and search, and
reject writes. Unarchive is a single admin verb. Nothing is deleted. Both
transitions are audit events. The UI may call the archive the "cooler".

### 4.5 Identity

One row per human or agent, global. Fields: `id`, `kind` (`human`, `agent`),
`display_name`, `is_root` (humans only), `email` (humans: the invited address, unique; agents: the
reserved address `<slug>@<tenant>.pimwell.com`, see 6.5), `operator_id`
(agents only: the human identity responsible), `created_at`, `state`.

A human identity is created exactly once, by accepting an invite. A later
invite to the same email adds a membership instead.

An identity with `state = archived` is treated as signed out everywhere: its
sessions and tokens resolve to anonymous, its links and invites do not
consume, and inbound mail from its address is rejected.

### 4.6 Membership and roles

`membership(identity_id, tenant_id, role, state, created_at)`. Roles:

| Role | Scope | May |
| --- | --- | --- |
| `root` | hub | Everything. Create tenants. Invite admins. Not a membership row; a flag on the identity. |
| `admin` | tenant | Invite, change roles, create agents for anyone, manage any token, archive and unarchive. |
| `member` | tenant | Normal use. Create own agents and tokens. |
| `reader` | tenant | Read only. |

Agents default to `member`. An admin may set an agent to `reader`. Agents are
never `admin` or `root` in v1. Every permission check is
`(identity, tenant) -> role`, nothing else.

### 4.7 Session

One row per human browser login or agent run. Fields: `id`, `identity_id`,
`tenant_id` (agents: fixed; humans: null, tenant is chosen per request),
`kind` (`browser`, `agent_run`), `label` (agent runs), `token_hash`,
`created_at`, `last_seen_at`, `expires_at`, `last_proof_at`,
`revoked_at`, `parent_token_id` (agent runs: the long-lived token used to
mint it).

Sessions are the unit of audit and of revocation. Every write anywhere in the
hub records `identity_id` and `session_id`.

## 5. Routing and deployment

- Zone `pimwell.com` on Cloudflare. One Worker, `pimwell-hub`, bound to
  routes `pimwell.com/*` and `*.pimwell.com/*` via a proxied wildcard DNS
  record. Workers Custom Domains are not used because they cannot wildcard.
  Universal SSL covers the first-level wildcard; second-level hosts are not
  used.
- The apex `pimwell.com` is the hub root: root login, tenant list for roots,
  invite acceptance, magic-link verification, and the tenant switcher.
- `<tenant>.pimwell.com` serves that tenant. The Worker resolves the host
  label to a tenant on every request; unknown or archived tenants return 404
  without revealing which. Anonymous callers and signed-in non-members get
  the same 404 from a tenant's pages and from its tenant-scoped API verbs.
- Reserved labels that are never tenant slugs: `www`, `mail`, `mx`, `api`,
  `mcp`, `login`, `signup`, `admin`, `root`, `static`, `cdn`, and any label
  starting with `_`.
- Bindings: D1 `HUB_DB`, `send_email` `MAIL`, email handler for
  `login@pimwell.com` and `signup@pimwell.com`, KV `RATE` for rate limits.
- Configuration lives in `wrangler.jsonc`. Secrets: `HUB_BOOTSTRAP_TOKEN`
  (section 9).

## 6. Authentication

### 6.1 Invite

1. A root (any tenant) or admin (own tenant) creates an invite: `email`,
   `tenant_id`, `role`, optional `display_name`. The hub stores
   `invite(id, tenant_id, email, role, token_hash, created_by, created_at,
   expires_at, accepted_at, accepted_session_id)` with a 7-day expiry and
   returns the link `https://pimwell.com/invite/<token>` once.
2. The hub never sends the invite. The inviter delivers it out-of-band.
3. `GET /invite/<token>` renders a page naming the tenant and role, with a
   button. `POST /invite/<token>` consumes it: creates the identity if the
   email is new, creates the membership (or sets the root flag), and
   redirects to the tenant. A browser session is started only when the
   acceptance created the identity. Accepting for an email that already has
   an identity adds the membership but never mints a session; if the request
   already carries that identity's own session it redirects into the tenant,
   otherwise it shows a page saying access was added. The GET/POST split
   exists because corporate link scanners prefetch URLs and would otherwise
   burn single-use links.
4. Invites are single-use. Expired or consumed links show the same neutral
   page.
5. Creating an invite for an email that already holds an active membership
   in the tenant is rejected with 409. Role changes go through
   `membership.set_role`.

### 6.2 Consent ledger

`consent(id, email, tenant_id nullable, kind, granted_at, revoked_at,
source_message_id, evidence)`.

Rule: the hub may send email to address X only if a `consent` row for X
exists with `revoked_at` null. In v1 the only way to create one is an inbound
email from X to `login@` or `signup@pimwell.com` that Cloudflare delivered
(so SPF or DKIM passed) and that the Worker matched to a known identity.
Consent is per address, not per tenant, in v1.

This rule applies to every sender in the hub, including future agent
mailboxes. The email spec will add more ways to grant and revoke consent but
not remove the rule.

### 6.3 Magic link, outbound

1. `POST /login` with `email`. Always responds "if that address is known and
   has consented, a link is on its way." No enumeration.
2. If the email belongs to a human identity and has unrevoked consent, the
   hub creates `auth_link(id, identity_id, token_hash, purpose, created_at,
   expires_at, used_at)` with a 15-minute expiry and `purpose` in
   {`login`, `reproof`}, then sends one message via the `MAIL` binding from
   `login@pimwell.com` containing `https://pimwell.com/auth/<token>`.
3. `GET /auth/<token>` renders a page with a button. `POST /auth/<token>`
   consumes it: for `login`, start a browser session; for `reproof`, set
   `last_proof_at` on the current session. Either way redirect to the
   intended tenant or the switcher.
4. Rate limits: 3 sends per address per hour, 20 per IP per hour, stored in
   KV. Exceeding limits still returns the neutral response.

The link is not bound to the requesting browser, because the inbound path
(6.4) has no requesting browser. The mitigations are the short expiry, single
use, the POST step, and the page showing the account about to be signed in.

### 6.4 Magic link, inbound

The Worker's `email` handler receives mail to `login@` and `signup@`.

1. Reject (`setReject`) if the envelope sender is not the `email` of a human
   identity, or if the identity is archived. No reply is sent to unknown
   senders.
2. After the rate check (item 3), record consent for the sender address if
   none exists (this is the signup step; `signup@` and `login@` behave identically, two names exist for
   discoverability).
3. Create an `auth_link` as in 6.3 and reply with `message.reply()`. Cloudflare
   permits `reply` only on DMARC-passing mail, only to the original sender,
   and only from the receiving domain, which is exactly what we want. If
   `reply` throws (no DMARC pass), the consent just recorded is revoked, no
   link is sent, and `login.reply_failed` is logged. Consent therefore sticks
   only when the reply succeeded. Rate limiting (3 per sender per hour)
   happens before consent is granted; a limited message grants nothing, and
   `login.inbound_limited` is logged once per window.
4. The Worker does not parse `Authentication-Results`; its presence on
   Worker-delivered mail is not reliable. Cloudflare's SPF/DKIM gate plus the
   `reply` DMARC gate are the trust boundary.

### 6.5 Agents

1. A member or admin creates an agent in a tenant: `slug`, `display_name`.
   The hub creates an identity of kind `agent` with `operator_id` set to the
   creator (admins may name another member as operator), a `member`
   membership, and reserves the address `<slug>@<tenant>.pimwell.com` in
   `identity.email`. No mailbox exists until the email spec.
2. The creator mints a long-lived token: `api_token(id, identity_id,
   tenant_id, name, token_hash, scopes, created_by, created_at, expires_at,
   last_used_at, revoked_at)`. The plaintext is shown once. Tokens are
   `pmw_` plus 32 random bytes, base64url; stored as SHA-256.
3. At the start of a run the agent calls `POST /api/session/start` with its
   long-lived token, a `label`, and an optional `ttl` (default 24 hours,
   max 7 days). The hub creates a session of kind `agent_run` and returns a
   session token (`pms_` prefix) that the agent uses for everything else.
   Long-lived tokens may only start sessions and read `whoami`.
4. Revoking a long-lived token revokes every session it started. Operators
   and admins may revoke; the agent may end its own session.
5. Agents authenticate with `Authorization: Bearer` only. They never receive
   cookies or magic links.

### 6.6 Browser sessions

- Cookie `pmw_session`, `Secure`, `HttpOnly`, `SameSite=Lax`,
  `Domain=.pimwell.com`, so one login spans the apex and all tenants. The
  cookie carries a random session token; the row holds its hash.
- Rolling expiry: 180 days from `last_seen_at`, refreshed at most once per
  hour to limit writes. Absolute cap 365 days from creation.
- Any state-changing request must be a `POST` with an `Origin` header that
  matches the host, or carry a bearer token. This is the CSRF control.
- Users see and revoke their sessions at `/me/sessions`. Admins can revoke
  any session in their tenant; roots any session.
- Fresh proof (6.7) is a property of sessions of kind `browser`, enforced
  whether the token arrives by cookie or by bearer header.

Reserved for later proofs: `proof(id, identity_id, kind, subject,
created_at)` with `kind` in {`email`, `google`, `passkey`}. Accepting an
invite or consuming a magic link records an `email` proof. Google sign-in
will add a `google` proof bound to an existing identity only, never creating
one.

### 6.7 Fresh proof

`session.last_proof_at` is set when a session is created and whenever a
`reproof` link is consumed. Sensitive verbs declare a maximum age:

| Verb class | Maximum age of last proof |
| --- | --- |
| Approve an OAuth/MCP client (future spec) | 600 minutes |
| Admin changes: roles, archive, tenant settings | 60 minutes |
| Mint or revoke tokens, create agents | 60 minutes |

A request past the limit returns 403 with `reason: reproof_required`; the
HTML surface redirects to `/login?reproof=1` which sends a `reproof` link to
the session's own address, using the outbound path, which requires consent.
A human without consent (never emailed the hub) can only re-prove via the
inbound path. Agent sessions have no fresh-proof concept; their verbs are
not in the sensitive set. The check applies to every session of kind
`browser`, by cookie or by bearer; only `agent_run` sessions are exempt.

## 7. Storage

D1 database `HUB_DB`, single region. Schema version in `meta`. All ids are
26-character ULIDs. Timestamps are integer milliseconds UTC. Every
tenant-scoped table carries `tenant_id` and every query that is not
root-scoped filters on it.

Tables: `meta`, `tenant`, `namespace`, `project`, `identity`, `membership`,
`invite`, `consent`, `auth_link`, `session`, `api_token`, `proof`, `event`.

`event(id, tenant_id nullable, identity_id, session_id, kind, target_kind,
target_id, summary, created_at)` is the audit log for every write in this
spec. Subsystems with their own timelines (Ardi) also mirror hub-relevant
events here.

Indexes: `identity(email)` unique; `membership(identity_id, tenant_id)`
unique; `session(token_hash)` unique; `api_token(token_hash)` unique;
`invite(token_hash)` unique; `auth_link(token_hash)` unique;
`consent(email)`; `event(tenant_id, created_at)`; `project(tenant_id,
namespace_id, slug)` unique.

The schema is plain SQL without SQLite-only features so a future move to
Postgres via Hyperdrive is a migration, not a rewrite. `pimwell export`
(later) dumps the database as one SQLite file.

## 8. Surfaces

The Worker is TypeScript. Unlike Ardi, no Rust core is warranted: there is no
pack parsing, and the control plane is request handling plus SQL.

### 8.1 Verb table

Following Ardi, every operation is declared once (name, kind, params, result,
required role, fresh-proof age, idempotency) and the HTTP and HTML surfaces
are generated from it. CLI and MCP exposure of these verbs comes with the
later specs, but the table is shaped for it now.

v1 verbs:

| Verb | Role | Fresh proof |
| --- | --- | --- |
| `tenant.create`, `tenant.archive`, `tenant.unarchive` | root | 60 min |
| `namespace.create`, `namespace.archive`, `namespace.unarchive` | admin | 60 min |
| `project.create`, `project.archive`, `project.unarchive` | member (create), admin (archive) | 60 min for archive |
| `invite.create`, `invite.revoke`, `invite.list` | admin; admin-role invites root only | 60 min (create, revoke) |
| `invite.accept` | public link | n/a |
| `login.request`, `login.verify` | public | n/a |
| `membership.set_role`, `membership.remove` | admin | 60 min |
| `agent.create`, `agent.archive` | member (own), admin (any) | 60 min |
| `token.create`, `token.revoke`, `token.list` | member (own), admin (any) | 60 min |
| `session.start` (agent), `session.end`, `session.list`, `session.revoke` | token holder / owner / admin | none |
| `consent.list`, `consent.revoke` | owner, admin | none |
| `whoami` | any | none |
| `event.list` | member (own tenant) | none |

Fresh proof applies to commands, not queries: a verb that only reads (such
as `invite.list` or `tenant.list`) never demands it. Inviting someone with
the `admin` role is root-only in v1; tenant admins invite `member` and
`reader`.

### 8.2 HTTP

`POST /api/<verb>` with JSON, bearer or cookie auth, responses with a stable
error shape `{error, reason, detail}`. Browsable HTML pages for: invite
accept, login, auth verify, tenant switcher, `/me` (sessions, tokens,
consent), tenant admin (members, invites, agents), and the archive. Pages are
server-rendered with near-zero JavaScript, no forms beyond the ones listed.
Content negotiation returns JSON or Markdown for the same pages, as Ardi
does.

## 9. Bootstrap and administration

- First run: `HUB_BOOTSTRAP_TOKEN` secret. A request to
  `POST /api/bootstrap` with it, while no root exists, creates the first root
  identity with the given email and returns an invite-style link. Afterwards
  the endpoint is disabled.
- Cloudflare access for deployment: one account-owned API token created via
  `POST /accounts/{id}/tokens` from the user's login, with only these
  permission groups: Workers Scripts Write, Workers Routes Write (zone
  `pimwell.com`), Workers KV Storage Write, D1 Write, Email Routing Rules
  Write (zone), Email Routing Addresses Write, DNS Write (zone, resources
  limited to `pimwell.com`), plus Account Settings Read and User Memberships
  Read if `wrangler deploy` still requires them. A script `scripts/
  make-deploy-token.sh` performs this and prints the permission groups it
  resolved, so the minimal set is reproducible. The token is stored in the
  CI secret store and never in the repo.
- Email: zone onboarded to Email Sending (already enabled). Email Routing
  rules for `login@` and `signup@` point at the Worker. DMARC policy for
  `pimwell.com` set to `p=reject` once sending is verified.

## 10. Security considerations

- Tokens, magic links, invite links, and session cookies are random 256-bit
  values, stored hashed, never logged.
- No account enumeration: login, invite, and auth pages respond identically
  for unknown, expired, and consumed inputs.
- Link prefetch defense: every single-use link is consumed on POST, not GET.
- Rate limits on login requests and on inbound mail processing per sender.
- Consent is the only gate on outbound mail and is checked at the single
  `sendMail` function; there is no other path to the `MAIL` binding. The
  binding may additionally be restricted to `login@pimwell.com` as the only
  sender address.
- Tenant resolution happens once per request from the host header and is
  passed explicitly; no query runs without a tenant filter unless the verb is
  root-scoped.
- Optional Turnstile on the login form if abuse appears; free tier suffices.
- Fresh-proof ages are enforced in the verb dispatcher from the table, not
  per handler.
- Agent tokens are scoped to one tenant; a cross-tenant request with an agent
  token is a 404 like any other unknown tenant.

## 11. Testing

- Unit: token generation and hashing, consent rule, fresh-proof check, host
  to tenant resolution, invite and link state machines.
- Integration under the Workers vitest pool with a local D1: invite, accept,
  login both directions (inbound via a synthetic `ForwardableEmailMessage`),
  consent gating (no consent means no send), reproof, session revocation
  cascades, archive visibility, enumeration-neutral responses, CSRF rejection.
- Deployed smoke test against a staging tenant `blue`: real inbound mail to
  `login@`, real outbound magic link to a verified test address, agent
  session lifecycle through the HTTP API.
- Every verb runs through the table-driven HTTP test that asserts role and
  fresh-proof enforcement.

## 12. Phasing

1. Worker skeleton, routing, D1 schema, bootstrap, invite create and accept,
   browser sessions, `whoami`, tenant and project objects with archive.
2. Consent ledger, outbound magic link, inbound email handler, reproof.
3. Agents, long-lived tokens, agent sessions, revocation cascade, `/me`.
4. Admin pages, event log, deploy token script, staging deployment.

Later, separate specs: Google proof; passkeys; email mailboxes and agent
mail; OAuth provider and MCP server; messaging.

## 13. Open risks

- Email Sending is in public beta. If it regresses, outbound magic links
  pause but the inbound path (`reply`, GA) keeps logins working.
- Corporate mail systems may rewrite or delay the inbound path; the
  15-minute link expiry may need tuning for the inbound case.
- D1 is single-region; latency from distant edges is tens of milliseconds
  per query. Acceptable for an internal tool; revisit if read replication
  reaches GA.
- Account-owned API tokens had a known Wrangler incompatibility in 2025;
  if it persists, fall back to a user-owned token with the same groups.
- The hub-wide cookie means one compromised session grants every tenant that
  identity belongs to. Mitigated by revocation and fresh proof, accepted for
  an internal deployment.

## Amendments (2026-10-06)

Rulings from the phase 1 reviews, folded into the sections above:

1. 6.1: accepting an invite for an email that already has an identity adds
   the membership or root flag but never mints a session; only an identity
   created by that acceptance gets one. A request already carrying that
   identity's session is redirected into the tenant.
2. 6.1: an invite for an email with an active membership in the tenant is
   rejected (409); role changes come later via `membership.set_role`.
3. 8.1: fresh proof applies to commands, not queries; admin-role invites are
   root-only in v1.
4. 5: anonymous and non-member callers get 404 on tenant-scoped API verbs as
   well as pages.
5. 6.6, 6.7: fresh proof is enforced on sessions of kind `browser` whether the
   token arrives by cookie or bearer.
6. 4.5: archived identities are treated as signed out everywhere.
7. 6.4: inbound consent is kept only when the DMARC-gated reply succeeds, and
   the rate limit is applied before consent is granted.
