# Ardi and the hub: integration design

Date: 2026-10-06
Status: approved design, pre-implementation
Scope: serving Ardi's git smart HTTP on tenant hosts of the hub, and
authenticating git clients with hub session tokens. Builds on the identity
spec (`2026-10-06-identity-design.md`) and Ardi's design
(`docs/superpowers/specs/2026-10-06-ardi-design.md` in the Ardi repo).
Plans: hub side `docs/superpowers/plans/2026-10-06-ardi-hub-hub-side.md` (this
repo); Ardi side `docs/superpowers/plans/2026-10-06-hub-identity.md` (Ardi repo).

## 1. Outcome

```
git clone https://acme.pimwell.com/site.git
Username: you@example.com
Password: pms_...            (a git credential from /me, or an agent run token)
```

The clone works, the push lands in Ardi's tenant `acme`, and the reflog
records the hub identity id and hub session id that did it.

## 2. Shape

```
git client --HTTPS--> pimwell-hub (owns *.pimwell.com)
                        | tenant host + git path + active tenant?
                        | yes: env.ARDI.fetch(original request)
                        v
                      ardi (no public route; workers.dev for admin)
                        | Basic auth: local token? else pms_ secret:
                        | env.HUB.fetch(POST /internal/introspect)
                        v
                      pimwell-hub /internal/introspect  -> {ok, identity, session, tenant, role}
```

Two service bindings, one in each direction: hub `ARDI` -> service `ardi`;
Ardi `HUB` -> service `pimwell-hub`. Neither Worker is reachable from the
other over the public internet.

## 3. Hub: forwarding

- Matched paths (on the raw, undecoded path):
  `^/<name>\.git/(info/refs|git-upload-pack|git-receive-pack)$` with
  `<name>` = `[A-Za-z0-9][A-Za-z0-9._-]*`. Any method is forwarded; Ardi
  answers 405 for the wrong one.
- Only top-level repositories in v1. Ardi's router accepts one path segment
  before the git suffix (`worker/src/index.ts`), so `<namespace>/<repo>.git`
  is not served; such paths stay with the hub and 404. Nested names arrive
  when Ardi supports them, by widening this one pattern.
- `.git` is required at the hub even though Ardi accepts bare names, so
  that no hub page path can ever be captured.
- Only on `<tenant>.pimwell.com` where the tenant exists and is `active`.
  Unknown or archived tenants get the hub's ordinary 404 page and nothing is
  forwarded. The apex and reserved labels are never forwarded.
- The request goes to Ardi unchanged (method, URL with host and query,
  headers, streaming body), with one deliberate exception: the `cookie`
  header is removed. Reason: `pmw_session` is a hub-wide credential
  (`Domain=.pimwell.com`) that Ardi never uses; git clients do not send it,
  but a browser opening a git URL would, and Ardi should never hold it.
- No auth at the hub. Ardi answers 401 with its Basic challenge.
- Missing `ARDI` binding: 503 `git service unavailable`.
- The check runs as the first Hono middleware; non-git requests pay one
  regex test.
- Reserved tenant labels gain `git` and `ardi`. Ardi does not need a host of
  its own in this design; the reservation keeps `git.pimwell.com` and
  `ardi.pimwell.com` free for a later admin surface and avoids a tenant
  whose URLs read like infrastructure.

## 4. Hub: git credentials for humans

Browser session tokens live in an HttpOnly cookie, so humans need a token
they can copy. New verb `session.git`:

| Field | Value |
| --- | --- |
| Caller | humans only (`humanOnly`), fresh proof 60 minutes |
| Params | `tenant` (slug; defaults to the host's tenant), `label` (1-80 chars) |
| Effect | session row of kind `git`, pinned to that tenant (`tenant_id` set), `parent_token_id` null, expiry 90 days from creation, never rolled |
| Result | `{session_id, token, username, tenant, expires_at, clone_example}`; the token is shown once |
| Audit | event `session.git` in that tenant |

- Any role in the tenant may mint one (readers get read-only git).
- A `git` session is usable only through introspection:
  `credentialUsable(..., via = "introspect")` accepts it for a human, on its own
  tenant, with no API token. On hub pages, `/api`, and `/mcp` it is
  anonymous (cookie: stale; bearer: ignored).
- `/me` lists it among sessions (kind `git` with its label) and revokes it
  with the existing `session.revoke`; a "Git credentials" form per tenant
  calls `session.git` and shows the token once.
- Introspection touches `git` sessions (`last_seen_at`, at most hourly) so
  `/me` shows when a credential was last used.
- Introspection keeps accepting browser and agent-run sessions as today.
  Agents use their run token (`pms_` from `session.start`) as the password.

## 5. Ardi: authentication

HTTP Basic stays (git credential helpers need it). In `authenticate()`:

1. Local token lookup as today (`TenantObject.resolve`).
2. If that fails and the secret starts with `pms_`: hub introspection.
   Otherwise the existing bootstrap and 401 rules apply unchanged.

Introspection call: `env.HUB.fetch` with a freshly constructed `Request` to
`https://hub.internal/internal/introspect`, `POST`, headers exactly
`content-type: application/json` and `x-hub-internal: <HUB_INTERNAL_SECRET>`,
body `{"token", "tenant"}`, 5 s timeout. Inbound headers are never forwarded
(a forwarded `cf-connecting-ip` makes the hub answer 404).

Mapping an `ok` answer (anything malformed is a denial):

| Hub | Ardi |
| --- | --- |
| `identity.id` (must be a 26-char Crockford ULID) | principal id |
| `identity.kind` `human` / `agent` | principal kind |
| `identity.display_name` (empty: the id) | principal display |
| `identity.operator_id` | principal operator |
| `role` `root` or `admin` | role `admin`, scopes `read,write,admin` |
| `role` `member` | role `member`, scopes `read,write` |
| `role` `reader` | role `reader`, scopes `read` |
| `session.id` | identity session |
| `tenant.slug` | must equal the routed tenant |

The ULID check is a boundary: it keeps a hub answer from ever naming
Ardi's `admin` principal or any hand-made local principal.

- Username: ignored for `pms_` secrets. Credential helpers always send one,
  agents send whatever their tooling fills in, and the 256-bit secret is the
  whole credential; matching it to an email adds no security and breaks
  helpers. The README says "use your email" by convention; the recorded
  identity is always the hub's.
- On each cache miss that succeeds, the principal row is upserted in the
  TenantObject (`TenantStore::upsert_principal`, new): kind, display,
  operator and role follow the hub. The upsert opens the tenant store, so a
  hub tenant's Ardi store is created on its first authenticated request; no
  Ardi bootstrap step per tenant. The hub is the tenant authority.
- The identity carries a session, so Ardi's existing rule applies:
  hub-authenticated callers cannot mint Ardi tokens or nested sessions.
- Cache, per isolate, keyed `sha256(token) + "\n" + tenant`: positive
  answers 30 s, `{ok:false}` 5 s, at most 1000 entries (oldest evicted).
  Errors, timeouts, and non-200 answers are not cached. Consequence:
  revoking a hub session takes up to 30 s to reach Ardi.
- Fail closed: no `HUB` binding or no `HUB_INTERNAL_SECRET` means every
  `pms_` secret is a 401 (local tokens still work). Hub unreachable, 5xx,
  404 (wrong secret), or timeout: 401, logged with the status and tenant,
  never the token.

## 6. Ardi: configuration

- `ARDI_BASE_DOMAIN = "pimwell.com"`, so the forwarded Host yields the
  tenant slug through the existing routing.
- `services: [{ binding: "HUB", service: "pimwell-hub" }]`, secret
  `HUB_INTERNAL_SECRET` (same value as the hub's).
- No routes. `workers_dev: true` stays for admin and bootstrap through
  `/t/<tenant>/` paths, including `/t/<tenant>/api/<verb>`: Ardi's API is
  not reachable on tenant hosts because `/api/` there belongs to the hub.
  Repositories are created with `repo.create` on the workers.dev URL, with
  the bootstrap token or a hub token whose role maps to `admin`.
- Native `ardi serve` is unchanged: local, own tokens, no hub.

## 7. Deploy order and verification

1. Ardi: set `HUB_INTERNAL_SECRET`, deploy (binds `pimwell-hub`, which
   exists).
2. Create the smoke repository: `repo.create` `smoke` in tenant `blue` on
   the workers.dev URL.
3. Hub: deploy with the `ARDI` binding (the target now exists).
4. Mint a git credential for `blue` on `/me`, then
   `git ls-remote https://blue.pimwell.com/smoke.git` with it: exit 0. A
   wrong token: authentication failed. `nosuch.pimwell.com`: not found.
5. Push one commit; Ardi's `timeline` shows the hub identity id and the
   git session id.

## 8. Risks and limits

- 30 s revocation lag in Ardi (cache). Acceptable for an internal tool.
- Ardi's repositories are not hub `project` rows yet; listing and archive
  stay in Ardi until a later spec mirrors them.
- celld deployments of Ardi have no `pimwell-hub` service; the binding is
  absent there and `pms_` secrets fail closed.
- A local Ardi principal whose id is a valid ULID equal to a hub identity id
  would be overwritten by the upsert. Local ids are hand-chosen names; not
  guarded further.
