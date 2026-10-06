# Pimwell MCP server and OAuth: design

Date: 2026-10-06
Status: proposed design, pre-implementation
Scope: the MCP endpoint that lets remote assistants (Claude, ChatGPT, Claude
Code) act in a Pimwell tenant as a signed-in human, and the OAuth 2.1
authorization server that issues their tokens. Builds on the identity spec
(`2026-10-06-identity-design.md`, hereafter "identity"); every term not
defined here (tenant, identity, membership, role, session, fresh proof, verb
table, event) means what it means there.

## 1. Purpose

A user adds `https://acme.pimwell.com/mcp` as a connector in their assistant.
The assistant discovers that the server needs OAuth, sends the user's browser
to `pimwell.com`, the user signs in (existing session or magic link), reviews
a consent screen, and approves. The assistant then calls tools that are
generated from the verb table and run as that human, inside that one tenant,
under a ceiling of the scopes granted and the human's current role.

MCP access is treated as elevated and sensitive. An assistant holding a token
can be steered by any text it reads (prompt injection), runs on infrastructure
we do not control, and keeps refresh tokens for weeks. The design therefore
optimizes for: exact tenant binding, a small and boring tool surface, no
credential-minting or admin tools, instant revocation, and one query that
answers "what did my assistant do."

Design goals:

1. Standard OAuth 2.1 that Claude and ChatGPT accept without special cases.
2. Grants are hub sessions: visible in `/me/sessions`, revocable there and by
   admins, cascaded by the same rules as every other session.
3. Tools come from the verb table; nothing is hand-written per tool.
4. Mostly Cloudflare primitives: the existing Worker, D1, KV, the Workers
   OAuth provider library, and the Agents SDK MCP handler.

## 2. Non-goals for v1

- Admin, root, or credential-minting verbs over MCP (section 8.3).
- Agents (`agent_run` sessions) calling `/mcp`. Agents use `/api` with `pms_`
  tokens. Revisit in phase 3.
- Third-party OAuth clients beyond assistant connectors; no "Sign in with
  Pimwell" for other apps, no OIDC `id_token`.
- Sender-constrained tokens (DPoP, mTLS). No target client supports them.
- MCP resources, prompts, sampling, or server-initiated elicitation. Tools only.
- Cross-tenant tokens. One grant covers exactly one tenant.

## 3. Privacy rule

As identity section 3. Example tenants are `acme` and `blue`. Logs never
contain access tokens, refresh tokens, authorization codes, PKCE verifiers,
or tool results. Events record verb names and a bounded argument summary,
never results.

## 4. URL layout and binding

### 4.1 Decision: one MCP endpoint per tenant, one authorization server at the apex

| Role | URL |
| --- | --- |
| Protected resource (MCP endpoint) | `https://<tenant>.pimwell.com/mcp` |
| Resource metadata (RFC 9728) | `https://<tenant>.pimwell.com/.well-known/oauth-protected-resource/mcp`, also served at `/.well-known/oauth-protected-resource` on the tenant host |
| Authorization server issuer | `https://pimwell.com` |
| AS metadata (RFC 8414) | `https://pimwell.com/.well-known/oauth-authorization-server` |
| Authorize (consent UI) | `https://pimwell.com/oauth/authorize` |
| Token | `https://pimwell.com/oauth/token` |
| Registration (RFC 7591) | `https://pimwell.com/oauth/register` |
| Revocation (RFC 7009) | `https://pimwell.com/oauth/revoke` |

Justification:

- The tenant is the isolation boundary and is already resolved from the host
  on every request (identity 5). A per-tenant MCP URL makes the RFC 8707
  `resource` the tenant: there is no tenant picker to get wrong, no tenant
  parameter on tool calls, and a token for `acme` cannot be presented to
  `blue` because its audience is a different URL (confused deputy closed by
  construction).
- One issuer at the apex means one client registry, one consent page on the
  host that owns the hub-wide cookie, and one place to apply registration
  policy. The `.pimwell.com` cookie (identity 6.6) is already visible there.
- `mcp` is a reserved label (identity 5), so `mcp.pimwell.com` cannot
  collide with a tenant and is left unused.
- The alternative, one apex endpoint with tenant selection at consent, puts
  the tenant in token props only, makes every tool call implicitly
  tenant-scoped by hidden state, and forces a user with two tenants into one
  connector whose tenant cannot be seen from the assistant's UI. Rejected.

A user who wants both `acme` and `blue` adds two connectors and approves two
grants.

### 4.2 Exact resource binding

- The RFC 9728 document for host `acme.pimwell.com` has `resource` equal to
  `https://acme.pimwell.com/mcp` exactly (no trailing slash, lowercase host,
  no port) and `authorization_servers: ["https://pimwell.com"]`,
  `scopes_supported: ["read", "write"]`, `bearer_methods_supported:
  ["header"]`.
- `/oauth/authorize` requires the `resource` parameter. It must parse to
  `https://<label>.pimwell.com/mcp` with a valid tenant label; anything else
  is `invalid_target`. The same value must appear on the token request and
  is echoed in the token response.
- The grant stores `resource` and `tenant_id`. On every `/mcp` request the
  server checks `grant.resource == "https://" + Host + "/mcp"` and
  `grant.tenant_id == resolved tenant.id`, independent of any audience check
  the library also performs. Mismatch is `401 invalid_token`.
- Tokens are opaque (library format). Their audience (`resource`), issuer,
  and expiry live in the grant and are enforced by the resource server; no
  client reads them. If ChatGPT is later found to require JWT access
  tokens, that is a phase 3 change confined to token issuance.

### 4.3 Enumeration

Identity 5 says unknown tenants are indistinguishable from forbidden ones.
MCP discovery requires an anonymous `401` with metadata. Therefore `/mcp` and
both metadata paths respond identically for every syntactically valid,
non-reserved tenant label, whether or not the tenant exists or is archived.
The difference surfaces only after sign-in, on the consent page, as the
neutral "you do not have access to this workspace" page shown for both cases.

## 5. Components and storage

### 5.1 Decision: use `@cloudflare/workers-oauth-provider` >= 1.2, split-role

The library implements OAuth 2.1 with PKCE, RFC 7591 registration, Client ID
Metadata Documents, RFC 8414 and 9728 metadata, refresh tokens, hashed token
storage, and encrypted props, and leaves the consent page to the app. Every
2025 CVE (redirect URI validation, PKCE downgrade) is fixed well below 1.2.
Hand-rolling would re-create that surface and its bugs. No constraint forbids
the library: the one thing we need that it does not own (hub-side revocation
and role checks) is layered on top (5.3).

Split-role, as the README recommends: the authorization side is mounted on
the apex for `/oauth/*` and AS metadata; the resource side (token validation)
runs on tenant hosts for `/mcp`. The legacy unified `OAuthProvider` wrapper
is not used because it wants to own the whole Worker's routing, and the hub
Worker already routes apex and tenant hosts itself.

Pinned: exact version in `package.json`, Renovate-style bumps reviewed by
hand, library changelog read on every bump.

### 5.2 Where state lives

| Data | Store | Notes |
| --- | --- | --- |
| Client registrations (DCR, cached CIMD) | KV `OAUTH_KV` | Library-owned. |
| Authorization codes, access and refresh tokens | KV `OAUTH_KV` | Library-owned, hashed; props encrypted with token-derived keys. |
| Pending authorization requests | KV `OAUTH_KV`, key `pending:<id>`, TTL 30 min | Hub-owned; survives the magic-link round trip. |
| Grants as hub objects | D1 `oauth_grant` | Source of truth for revocation and listing. |
| Grant sessions | D1 `session`, `kind = 'oauth'` | Unit of audit, same as browser and agent runs. |
| Redirect host allowlist | D1 `oauth_redirect_allow` | Root-managed (6.2). |
| Events | D1 `event` | Every tool call (9). |
| Rate counters | Workers Rate Limiting binding, KV `RATE` fallback | 10.6. |

KV is eventually consistent (deletes can take up to about 60 s to propagate).
That is acceptable only because KV is never the revocation authority: D1 is
checked on every request (5.3).

### 5.3 Grants are sessions

New D1 table:

```
oauth_grant(id, identity_id, tenant_id, session_id, client_id, client_name,
  client_kind, redirect_host, resource, scopes, library_grant_id,
  approved_by_session_id, created_at, expires_at, revoked_at, revoked_by,
  revoke_reason)
```

- `client_kind` in {`cimd`, `dcr`}; `redirect_host` is the host (or
  `loopback`) of the redirect URI actually used; `scopes` is space-separated.
- Approval creates one `session` row: `kind = 'oauth'`, `identity_id` the
  human, `tenant_id` fixed to the grant's tenant, `label` the client name,
  `token_hash` the hash of a random value that is discarded (the session is
  never a bearer credential; it exists for audit, listing, and revocation),
  `last_proof_at` copied from the approving browser session,
  `expires_at` = grant expiry.
- The library grant's encrypted props carry `{grant_id, session_id,
  identity_id, tenant_id, resource, scopes}`. The library's userId is the
  identity id.
- Session kind enum gains `oauth`. Identity 6.7's fresh-proof check exempts
  non-browser sessions; that is safe because no fresh-proof verb is ever
  exposed over MCP (8.3), and the dispatcher asserts it (8.4).
- `oauth` sessions authenticate only on `/mcp`. `/api/*` and HTML pages
  never accept library tokens; `buildContext` keeps accepting only `pms_`
  bearers and cookies. `/mcp` ignores cookies entirely.

Per-request check on `/mcp`, after the library validates the token: one D1
query joining `oauth_grant`, `session`, `identity`, `membership`, `tenant`
that requires grant and session unrevoked and unexpired, identity active,
membership active (or identity root), tenant active. Any failure is
`401 invalid_token` with the `WWW-Authenticate` header (7.1). The session's
`last_seen_at` is touched at most hourly, as for browser sessions.

## 6. Client registration

### 6.1 Mechanisms

| Mechanism | Used by | Policy |
| --- | --- | --- |
| CIMD (`client_id` is an https URL) | ChatGPT (preferred), Claude when supported | Fetch with https only, no IP-literal or private-range hosts, 5 s timeout, 8 KB cap, no redirects, cached 1 h. Document's `client_id` must equal its URL. |
| DCR (`POST /oauth/register`) | Claude, Claude Code | Public clients only (`token_endpoint_auth_method: none`). Rate limited (10.6). Unused registrations purged after 30 days. |

`client_name`, `logo_uri`, `client_uri`, and similar fields from either
mechanism are self-asserted and displayed as such. Logos are not displayed
in v1.

### 6.2 Decision: redirect URIs are allowlisted by host

Pimwell is an internal hub with a known set of assistants. Registration (DCR
request or fetched CIMD) is rejected unless every `redirect_uri` matches an
entry in `oauth_redirect_allow(id, pattern, label, created_by, created_at)`.
Seeded entries:

| Pattern | Label |
| --- | --- |
| `https://claude.ai/api/mcp/auth_callback` | Claude |
| `https://chatgpt.com/connector/oauth/*` (single path segment) | ChatGPT |
| `https://chatgpt.com/connector_platform_oauth_redirect` | ChatGPT |
| `http://localhost/callback`, `http://127.0.0.1/callback`, any port | Local app (loopback) |

Rules: https required except loopback; loopback matches ignore the port only
(RFC 8252), path must match exactly; no wildcards in host; no fragments; no
query strings beyond what the pattern allows. Roots manage the list with
verbs `oauth.redirect.allow` and `oauth.redirect.disallow` (root, 60 min
fresh proof). Disallowing a host revokes every grant whose `redirect_host`
it covered.

The check runs three times: at registration (wrapping `/oauth/register`
before the library sees it, and after each CIMD fetch), at authorize (the
`redirect_uri` in the request must be registered for the client and still
allowlisted), and the library's own exact-match redirect check at token
exchange. Errors before the redirect URI is trusted render a Pimwell error
page and never redirect (no open redirect).

## 7. Authorization flow

### 7.1 Discovery

1. Client calls `POST https://acme.pimwell.com/mcp` without a token.
2. Server returns `401` with `WWW-Authenticate: Bearer
   resource_metadata="https://acme.pimwell.com/.well-known/oauth-protected-resource/mcp"`.
   A valid token lacking a needed scope gets `403` with `error=
   "insufficient_scope", scope="write"`.
3. Client fetches the RFC 9728 document, then the RFC 8414 document from the
   first authorization server. AS metadata advertises
   `code_challenge_methods_supported: ["S256"]`, `grant_types_supported:
   ["authorization_code", "refresh_token"]`, `response_types_supported:
   ["code"]`, `token_endpoint_auth_methods_supported: ["none"]`,
   `client_id_metadata_document_supported: true`, `registration_endpoint`,
   `revocation_endpoint`, `scopes_supported`.
4. All discovery, registration, and token endpoints answer well under 10 s;
   none call out except the bounded CIMD fetch.

### 7.2 Authorize

`GET https://pimwell.com/oauth/authorize?...`

1. The library parses the request. Reject without redirect if the client is
   unknown or the `redirect_uri` fails 6.2. Reject with redirect
   (`invalid_request`) if PKCE is missing or not `S256`; `plain` is refused.
   Reject `invalid_target` if `resource` is missing or malformed (4.2).
   Reject `invalid_scope` for scopes outside {`read`, `write`}; an empty
   scope means `read`.
2. Store the parsed request as `pending:<id>` in KV (30 min) and continue
   at `GET /oauth/consent/<id>`. Long query strings never ride through login.
3. No session: redirect to `/login?next=/oauth/consent/<id>`. The user signs
   in by outbound or inbound magic link (identity 6.3, 6.4) and returns.
4. Session's `last_proof_at` older than 600 minutes: redirect to
   `/login?reproof=1&next=...` (identity 6.7).
5. Resolve the tenant from `resource`. Not a member, tenant unknown, or
   archived: the neutral no-access page. Identity is an agent: refused
   (agents never hold OAuth grants).
6. Render the consent page (7.3).

### 7.3 Consent page

Shown every time; v1 never auto-approves, even for a client with an existing
grant. Content, top to bottom:

1. Headline: "Allow an assistant to act as you in **Acme**
   (`acme.pimwell.com`)".
2. Where codes will be sent, the most prominent element: the redirect host
   in large monospace type (`claude.ai`, `chatgpt.com`) with the allowlist
   label; for loopback, a warning block: "This connects a program on your
   own computer. Approve only if you started this from a terminal in the
   last few minutes."
3. Client name in quotes with "(name supplied by the app)", plus the CIMD
   URL host for CIMD clients. Never the only identifying text.
4. Signed in as: display name and email, with "not you? sign out".
5. Scopes in plain language, each expandable to the exact tool list:
   - `read`: "See projects, activity, and your profile in Acme."
   - `write`: "Create and change things in Acme as you. It cannot invite
     people, change roles, archive anything, or create tokens."
   If the user's role is `reader`, `write` is shown struck through with
   "your role does not allow this" and is not granted.
6. Duration: "Access lasts up to 90 days. Revoke any time at
   pimwell.com/me/sessions."
7. Buttons: Approve and Deny, each a separate POST form.

Protections:

- Headers: `Content-Security-Policy: frame-ancestors 'none'; default-src
  'self'; form-action 'self'`, `X-Frame-Options: DENY`, `Cache-Control:
  no-store`, `Referrer-Policy: no-referrer`.
- `POST /oauth/consent/<id>` requires the identity 6.6 controls (Origin equals
  `https://pimwell.com`) plus a hidden form token: HMAC of `(pending id,
  session id)`. A pending request is bound to the first session that views
  it; a different session gets the neutral page.
- Approval runs the verb `oauth.grant.approve` (hub scope, any member of the
  target tenant, fresh proof 600 minutes) through the normal dispatcher, so
  role and fresh-proof enforcement is the table's, not the page's.
- The pending entry is deleted on approve or deny (single use).
- Deny redirects to the validated `redirect_uri` with
  `error=access_denied` and the client's `state`.

### 7.4 Approve, code, token

1. `oauth.grant.approve` writes `oauth_grant` and the `oauth` session in one
   D1 batch, records event `oauth.grant.approve`, then calls the library's
   complete-authorization helper with the props (5.3), granted scopes, and
   resource. The library issues a code (single use, 5 min) and the 302 to
   the `redirect_uri` with `code`, `state`, and `iss`.
2. Client exchanges at `/oauth/token` (form-urlencoded) with
   `code_verifier`. Library verifies PKCE, redirect URI, and client; the hub
   wrapper verifies `resource` equals the grant's. Response includes
   `access_token`, `token_type`, `expires_in`, `refresh_token`, `scope`.
3. Refresh at `/oauth/token` with `grant_type=refresh_token`: the hub wrapper
   first checks the D1 grant (5.3 query minus the per-request touch). A
   revoked, expired, or orphaned grant is `400 invalid_grant`, which tells
   Claude and ChatGPT to restart authorization.

## 8. Scopes and tools

### 8.1 Scopes

| Scope | Covers |
| --- | --- |
| `read` | Exposed verbs of kind `query`. |
| `write` | Exposed verbs of kind `command`. Implies nothing about `read`; consent grants `read write` together when write is chosen. |

Effective permission for a tool call, recomputed on every request:

`exposed(verb) AND scope_granted(verb) AND rank(current role) >= verb.minRole AND verb.minRole <= member`

The token acts as the human; it never exceeds the human's current role, and
it never reaches admin verbs even when the human is an admin.

### 8.2 Verb table additions

`VerbDef` gains:

- `params`: a JSON Schema (draft 2020-12) object, replacing hand-written
  `parse` for MCP and HTTP alike (parse becomes schema validation).
- `result`: JSON Schema of the result.
- `mcp`: `null` (default, not exposed) or `{ scope: "read" | "write",
  destructive: boolean, title: string }`.

Exposure is opt-in per verb. A table test fails if any verb with `mcp` set
violates 8.3.

### 8.3 Never exposed over MCP in v1

- Any verb with `minRole` of `admin` or `root`, or `scope: "hub"`.
- Any verb with `freshProofMinutes !== null`.
- Credential and access management: `token.*`, `agent.*`, `session.*`,
  `invite.*`, `consent.*`, `membership.*`, `oauth.*`, `login.*`,
  `bootstrap`.
- Anything that sends mail or reaches outside the hub.

### 8.4 v1 tool list

| Tool | Verb | Scope | Notes |
| --- | --- | --- | --- |
| `whoami` | `whoami` | read | Identity, tenant, role, granted scopes. |
| `project_list` | `project.list` | read | Paged. |
| `event_list` | `event.list` | read | Tenant events, paged; filter by `session_id` to see an assistant's own actions. |
| `project_create` | `project.create` | write | Non-destructive. |

Tools grow as subsystems (Ardi repos, tracker, messaging) add verbs with
`mcp` set; each addition is reviewed against 8.3 and 10.5.

### 8.5 Tool generation

- Name: verb name with `.` replaced by `_` (fits `^[a-zA-Z0-9_-]{1,64}$`).
- Description: the verb `summary`, then one line on scope, then for
  destructive tools: "Destructive. Only call after the user has explicitly
  confirmed this exact action in the conversation; pass confirm: true."
- `inputSchema` from `params`; `outputSchema` from `result`.
- Annotations: `readOnlyHint` for queries, `destructiveHint` from `mcp`,
  `idempotentHint` from the table's idempotency, `openWorldHint: false`.
- `tools/list` is computed per request from the token's scopes and the
  human's current role, so a downgraded user's assistant stops seeing write
  tools without re-consent.
- Calls go through the same dispatcher as `/api` with a context whose
  `session` is the grant's `oauth` session, so every write records that
  session id.

### 8.6 Results

- `content`: one text block of Markdown, written for a model: a one-line
  summary, then a compact table or list, then a `next_cursor` line when
  paged. The same renderer serves `/api` Markdown negotiation.
- `structuredContent`: the JSON result, matching `outputSchema`.
- Size: list verbs take `limit` (default 25, max 100) and `cursor`. Any
  result over 20,000 characters of Markdown is truncated at a row boundary
  with "truncated; N more, pass cursor=...". Errors are `isError: true`
  with the stable `{error, reason}` shape in text.

### 8.7 Transport

`createMcpHandler` from the Agents SDK (stateless, Streamable HTTP, MCP SDK
v2), not the deprecated `McpAgent`; no Durable Object per connection. The
`/mcp` route validates the bearer (library resource side plus 5.3 check),
builds the hub context, and passes it as `authInfo`, which handlers read
from `context.http.authInfo`. Requests with an `Origin` header that is not
`https://claude.ai`, `https://chatgpt.com`, or absent are refused `403`
(DNS-rebinding and browser-CSRF defense).

## 9. Audit

- Every `tools/call`, success or failure, writes `event(kind='mcp.call',
  tenant_id, identity_id, session_id=<oauth session>, target_kind='verb',
  target_id=<verb>, summary)`. Summary is the verb, outcome, and argument
  keys with values truncated to 64 characters; never results.
- Commands also write their usual domain events with the same session id.
- Lifecycle events: `oauth.client.register`, `oauth.grant.approve`,
  `oauth.grant.deny`, `oauth.grant.refresh` (at most one per grant per
  day), `oauth.grant.revoke`, `mcp.denied` (scope or role ceiling hit).
- "What did my assistant do": `event.list` with `session_id`, linked from
  each `oauth` row in `/me/sessions`.

## 10. Lifetimes, revocation, role changes

### 10.1 Lifetimes

| Item | Lifetime |
| --- | --- |
| Pending authorization request | 30 min |
| Authorization code | 5 min, single use |
| Access token | 60 min |
| Refresh token | 30 days idle; rotated on every use; old token dead after use |
| Grant | 90 days absolute, then re-consent with fresh proof |
| CIMD cache | 1 h |
| Unused DCR client | purged after 30 days |

Every client is public, so every refresh rotates (OAuth 2.1). Reuse of a
rotated refresh token is treated as theft: the grant is revoked.

### 10.2 Revocation

Revoking a grant sets `oauth_grant.revoked_at` and `session.revoked_at` in
one D1 batch (effective on the next request, because D1 is checked every
request), then deletes the library grant and its tokens from KV
(best-effort; KV lag is harmless).

| Who | Where | Scope |
| --- | --- | --- |
| The human | `/me/sessions` (oauth rows show client, redirect host, tenant, scopes, last used) | own grants |
| Admin | tenant admin page, sessions tab | grants in their tenant |
| Root | any | any |
| Client | `/oauth/revoke` (RFC 7009) | its own token |

`session.revoke` on an `oauth` session revokes its grant, so existing
session tooling works unchanged.

### 10.3 Cascades

| Trigger | Effect |
| --- | --- |
| Identity archived | All its grants revoked. |
| `membership.remove` | All its grants in that tenant revoked. |
| Tenant archived | Requests fail the tenant check (5.3); grants revoked. |
| Redirect host disallowed | Grants with that `redirect_host` revoked. |
| Browser session that approved is revoked | No effect; the grant is its own session. Users revoke grants separately. |

### 10.4 Role changes

The ceiling is recomputed per request (8.1). Downgrade to `reader`: write
tools vanish from `tools/list` and write calls get `403 insufficient_scope`;
the grant survives and regains write if the role is restored. Promotion to
`admin` adds nothing (8.3).

### 10.5 Destructive tools

A verb marked `destructive` (archive, delete, overwrite, anything not
trivially reversible) requires a boolean `confirm` param that must be
`true`; absent or false returns `isError` with "confirmation required" and
no side effect. This is a speed bump for injected instructions, not a
security boundary; the boundary is that genuinely dangerous verbs are not
exposed at all (8.3). v1 exposes no destructive tools.

### 10.6 Rate limits

| Subject | Limit |
| --- | --- |
| `/oauth/register` per IP | 10 / hour; 200 / day globally |
| `/oauth/authorize` per IP | 60 / hour |
| `/oauth/token` per client | 60 / minute |
| `/mcp` per grant | 120 / minute, 2,000 / hour |
| `/mcp` write calls per grant | 30 / minute |
| Unauthenticated `/mcp` per IP | 60 / minute |

Exceeding returns `429` with `Retry-After`; MCP limits also write one
`mcp.denied` event per window.

## 11. Threat model

| Threat | Mitigation |
| --- | --- |
| DCR spam fills KV | Per-IP and global registration limits; 30-day purge; registration only for allowlisted redirect hosts, so spam cannot produce a usable client. |
| Redirect URI abuse, open redirect | Host allowlist (6.2) checked at register, authorize, and token; exact match; errors before the redirect is trusted never redirect; library >= 1.2 includes the 2025 redirect validation fix. |
| PKCE downgrade, code interception | S256 required, `plain` refused, codes single use and 5 min; library >= 1.2 includes the 2025 PKCE fix. |
| Consent phishing with a lookalike client name | Redirect host is the dominant element; client name labeled self-asserted; allowlist means codes can only reach known assistant hosts or the user's own machine. |
| Malicious local app via loopback | Loopback warning on consent; fresh proof within 600 min; grant visible and revocable; attacker already on the machine is out of scope. |
| Clickjacking the consent page | `frame-ancestors 'none'`, `X-Frame-Options: DENY`. |
| CSRF on approve | POST only, Origin check, form token bound to pending id and session, pending id bound to first viewing session. |
| Login CSRF (attacker's session approves into victim's assistant) | Consent page names the signed-in account prominently; magic-link page shows the account (identity 6.3). |
| Token theft from client storage or logs | 60-min access tokens; rotating refresh with reuse detection; hashed at rest; never logged; one-click revoke. |
| Confused deputy across tenants | Per-tenant resource; grant tenant and resource checked against Host on every request (4.2). |
| Token replay against `/api` or HTML | Library tokens are not accepted outside `/mcp` (5.3). |
| Stale access after offboarding | D1 check per request; cascades (10.3). |
| Prompt-injection-driven misuse | No admin, credential, mail, or fresh-proof verbs (8.3); role ceiling; `confirm` on destructive tools; write rate limit; every call audited and attributable to one grant. |
| Exfiltration via tool results | Tools return only what the human could read in the UI; no tool reaches outside the hub; no mail tools. Residual risk accepted and documented to users. |
| CIMD fetch as SSRF | https only, public hosts only, no redirects, 5 s, 8 KB. |
| DNS rebinding or browser calling `/mcp` | Origin allowlist on `/mcp`; cookies ignored. |
| Tenant enumeration via MCP discovery | Uniform 401 and metadata for every valid label (4.3). |
| Library vulnerability | Pinned version, changelog review, D1 as the second, independent authorization check. |

## 12. Testing

- Unit: resource parsing and Host binding; redirect allowlist matcher
  (loopback ports, path exactness, single-segment wildcard, rejects for
  userinfo, IP literals, fragments, case tricks); effective-permission
  function over the role x scope x verb matrix; tool generation (names,
  schemas, annotations); Markdown renderer truncation; table test enforcing
  8.3 on every verb with `mcp` set.
- Integration under the Workers vitest pool with local D1 and KV, driving
  the full dance with a test client: anonymous `/mcp` 401 header, both
  metadata documents, DCR, authorize redirect to login, magic-link sign-in,
  reproof at 601 minutes, consent render (headers asserted), CSRF and
  Origin rejection, approve, code exchange with a correct and a wrong PKCE
  verifier, wrong `resource`, `tools/list` per scope and role, tool call
  writing an `mcp.call` event, refresh rotation and reuse detection,
  revocation from `/me` effective on the next call, every cascade in 10.3,
  token for `acme` rejected on `blue`, unknown and real tenant labels giving
  identical anonymous responses, library tokens rejected on `/api`.
- Manual end to end, phase 1 exit: Claude Code (`claude mcp add --transport
  http`) and claude.ai connector against staging tenant `blue`: connect,
  consent, call each read tool, revoke in `/me/sessions`, observe the
  client re-prompt. Phase 2 repeats with ChatGPT.

## 13. Phasing

Prerequisites: identity phases 1 to 3 (sessions, magic links, reproof,
`/me`).

1. Read-only, one tenant, Claude. Library wiring (apex AS, `OAUTH_KV`),
   per-tenant metadata and `/mcp` with `createMcpHandler`, DCR with redirect
   allowlist (seeded, no management verbs yet), consent page and
   `oauth.grant.approve`, `oauth_grant` plus `oauth` sessions, per-request D1
   check, revocation from `/me/sessions` and cascades, `read` scope with
   `whoami`, `project_list`, `event_list`, `mcp.call` events, rate limits.
   Exit: the manual Claude Code and claude.ai run against `blue`.
2. Write and ChatGPT. `write` scope and `project_create`, `confirm` handling,
   CIMD, ChatGPT redirect entries and end-to-end run, admin grant view and
   revoke, `oauth.redirect.allow`/`disallow`, refresh-reuse revocation.
3. Growth. Tools from new subsystems (Ardi, tracker) under review against
   8.3; decide on agent `pms_` access to `/mcp`; JWT access tokens only if a
   client requires them.

## 14. Open risks

- Assistant clients change OAuth behavior without notice (CIMD vs DCR
  preference, redirect paths). The allowlist will reject a new redirect
  path until a root adds it; that failure is loud and safe.
- KV eventual consistency on client registration: a client that registers
  and immediately authorizes from another edge may briefly not be found.
  Accepted; clients retry.
- D1 single-region latency adds one query per MCP call. Acceptable at
  internal scale.
- Prompt injection cannot be prevented server-side; the tool surface is the
  control. Every new exposed verb is a security review item.
