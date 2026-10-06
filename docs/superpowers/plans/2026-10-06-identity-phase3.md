# Pimwell Identity Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents as first-class principals: `agent.create` and `agent.archive`, long-lived `pmw_` tokens (`token.create`, `token.revoke`, `token.list`), agent run sessions from `session.start`, the revocation cascade, the `/me` page and a tenant `/admin/agents` page, plus an internal session introspection endpoint for Ardi.

**Architecture:** Two new repositories (`src/db/agents.ts`, `src/db/apiTokens.ts`) over the existing `identity`, `membership`, `api_token`, and `session` tables; no migration. `buildContext` learns a third credential (`pmw_` bearer) and one rule for every agent credential: it is pinned to one tenant and lives only while its agent is active, its parent token is unrevoked, and its operator is still root or an active member of that tenant, checked on every request. The verb dispatcher gains three declarative flags (`longLivedToken`, `humanOnly`, `renderForm`) and applies fresh proof to any verb that declares it, so agent and token verbs can be addressed by target (agent id, tenant slug) and driven from `/me` on the apex. Introspection is a separate route that reuses the same credential check.

**Tech Stack:** TypeScript, Wrangler 4, Hono 4, D1, Vitest with `@cloudflare/vitest-pool-workers`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-identity-design.md` (sections 4.5, 4.6, 4.7, 6.5, 6.6, 6.7, 7, 8.1, 8.2, 10, 11, 12 phase 3, and the Amendments section)

**Deliberate addition not in the spec: internal introspection for Ardi (Task 9).** Ardi needs to turn a `pms_` session token it received into "who, which session, which tenant, which role" without its own copy of the identity tables. `POST /internal/introspect` answers that. It is reachable only through a Cloudflare service binding: the caller must send `x-hub-internal: <HUB_INTERNAL_SECRET>` (a Wrangler secret, compared in constant time), and any request carrying `cf-connecting-ip` is refused, because Cloudflare always adds that header on public routes and service-binding calls do not have it. Both failures return the ordinary 404 page. The body is `{token, tenant}`; the answer is `{ok: true, identity, session, tenant, role}` when the `pms_` session is valid and its identity is an active member (or root) of that tenant, else `{ok: false}` with status 200. The token is never echoed. No rate limit (internal only). The spec is not amended in this phase; this header is the record.

## Global Constraints

- Agents: "The hub creates an identity of kind `agent` with `operator_id` set to the creator (admins may name another member as operator), a `member` membership, and reserves the address `<slug>@<tenant>.pimwell.com` in `identity.email`." "An admin may set an agent to `reader`. Agents are never `admin` or `root` in v1." (spec 4.6, 6.5)
- Long-lived tokens: "`pmw_` plus 32 random bytes, base64url; stored as SHA-256." "The plaintext is shown once." "Long-lived tokens may only start sessions and read `whoami`." (spec 6.5)
- Agent runs: `POST /api/session.start` with "a `label`, and an optional `ttl` (default 24 hours, max 7 days)" returns a `pms_` session of kind `agent_run`; agent sessions have `tenant_id` fixed (spec 4.7, 6.5). `ttl` is in seconds.
- "Revoking a long-lived token revokes every session it started. Operators and admins may revoke; the agent may end its own session." (spec 6.5)
- "Agents authenticate with `Authorization: Bearer` only. They never receive cookies or magic links." (spec 6.5)
- "Agent tokens are scoped to one tenant; a cross-tenant request with an agent token is a 404 like any other unknown tenant." (spec 10)
- Fresh proof: "Mint or revoke tokens, create agents: 60 minutes", enforced in the dispatcher, on sessions of kind `browser` by cookie or bearer; "only `agent_run` sessions are exempt"; queries never demand it (spec 6.7, 8.1, Amendments 3 and 5). In this plan: `agent.create`, `agent.archive`, `token.create`, `token.revoke` = 60; `token.list` = none.
- "An identity with `state = archived` is treated as signed out everywhere: its sessions and tokens resolve to anonymous." (spec 4.5)
- Non-goals: "Agent-to-agent delegation, agents creating agents, or agents inviting." (spec 2)
- Tokens, links, and cookies are "random 256-bit values, stored hashed, never logged." Logs and event summaries never contain raw bearer tokens (spec 3, 10).
- Every write records an `event` row with `identity_id` and `session_id` (spec 4.7, 7).
- `/me` shows "sessions, tokens, consent"; tenant admin shows "agents". Pages are server-rendered, near-zero JavaScript (spec 8.2).
- No organization, department, or person names in code, config, examples, or commits. Examples use tenants `acme` and `blue` and addresses at `example.com` (spec 3).
- Plain SQL; no SQLite-only features. No migration in this phase: every column used exists in `migrations/0001_init.sql`.
- Commit after every task. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
  ```

## Review Focus

1. An agent's `pms_` run token sent in the `pmw_session` cookie (a script that copies tokens into a browser, or a confused client) must not authenticate; the cookie is treated as stale. Test in Task 2.
2. A run session touched after an hour must keep its original `expires_at`; the phase 1 rolling refresh would silently stretch a 24-hour run to 180 days. Test in Task 1.
3. An agent credential presented on the apex, or on another tenant where its operator is also a member, must resolve to anonymous (404 on tenant verbs, `whoami` null), never to the agent with no role. Tests in Task 2 and Task 6.
4. A token revoked while a run is starting: a session row created after the cascade `UPDATE` must still be dead, because the request-time check also looks at the parent token. Test in Task 2.
5. An operator who leaves the tenant (membership archived) or is archived: the agent's token and runs stop on the next request and resume if the membership is restored; nothing is silently revoked. Tests in Task 2 and Task 6.

---

## Decisions locked in by this plan

- **Operator liveness is checked at request time, not cascaded.** An agent credential works only while its operator identity is active and is root or holds an active membership (any role) in the agent's tenant. Removing or archiving the operator stops the agent at once; restoring the membership resumes it. A later `membership.remove` needs no extra code for this.
- **Tokens belong to agents only.** `token.create` takes an `agent_id`. A `pmw_` row whose identity is a human resolves to anonymous.
- **Agent and token verbs are addressed by target and declared `scope: "public"`.** `agent.create` takes `tenant` (slug; defaults to the host's tenant), the others take `agent_id`/`token_id`. Authorization is computed against the target's tenant with `roleIn`: operator (who must still be at least `member` there), that tenant's admin, or root. Everyone else gets 404, as if the target did not exist. This lets `/me` on the apex drive them with same-origin forms; the CSRF rule (Origin must match the host) is unchanged.
- **Dispatcher changes:** fresh proof is now checked for any verb that declares it, not only verbs with a `minRole`; `longLivedToken` marks the two verbs a `pmw_` token may call; `humanOnly` refuses agents; `renderForm` lets a form post render a page (used once: showing a new token); a form field `_back` (same-origin path) chooses the redirect target, because pages send `Referrer-Policy: no-referrer`.
- **Agent slugs:** lowercased, must pass `isValidSlug`, and may not be a reserved label or one of `postmaster`, `abuse`, `hostmaster`, `webmaster`, `noreply`, `no-reply`. An archived agent's address stays taken (nothing is deleted).
- **Agent addresses are protected:** `invite.create` rejects any address under a tenant subdomain of the hub domain, and `acceptInvite` refuses an existing identity that is not human (so an invite can never give an agent a second membership or the root flag).
- **Run sessions outlive token expiry** (up to their own ttl, max 7 days) but not token revocation.
- **Humans are accepted only on `browser` sessions** in `buildContext`. The MCP/OAuth plan will extend `credentialUsable` for `oauth` sessions.
- **Introspection does not touch `last_seen_at`**: it is a read.

## Out of scope for this phase

`agent.unarchive`, `membership.set_role`/`membership.remove` verbs (phase 4 admin pages), `event.list`, agent mailboxes, `/mcp` for agents, content negotiation (JSON/Markdown) for the new pages, deployment.

## File Structure

```
src/db/types.ts              + ApiToken, Agent (Task 1)
src/db/agents.ts             agent identities: create, find, list, archive cascade, activity counts (Task 1)
src/db/apiTokens.ts          api_token: create, resolve, list, revoke cascade, mark used (Task 1)
src/db/sessions.ts           + createAgentSession, getSessionById, listAgentRunsForOperator; touchSession keeps run expiry (Task 1)
test/helpers.ts              + seedAgent (Task 1)
src/auth/agent.ts            operatorActiveIn, agentCredentialOk (Task 2)
src/auth/context.ts          pmw_ bearer, Ctx.apiToken, authKind "token", credentialUsable (Task 2)
src/verbs/table.ts           + longLivedToken, humanOnly, renderForm (Task 3)
src/verbs/params.ts          + optInt (Task 3)
src/http/api.ts              token gate, humanOnly, fresh proof for all, renderForm, _back (Task 3)
src/verbs/whoami.ts          token- and agent-aware (Task 3)
src/auth/authority.ts        requireHuman, roleIn, targetTenant, manageableAgent (Task 4)
src/verbs/agent.ts           agent.create, agent.archive (Task 4)
src/verbs/invite.ts          reject agent-domain addresses (Task 4)
src/db/invites.ts            acceptInvite refuses non-human identities (Task 4)
src/verbs/token.ts           token.create, token.revoke, token.list (Task 5)
src/verbs/session.ts         + session.start; session.revoke for operators and admins (Task 6)
src/verbs/index.ts           register new verbs (Tasks 4, 5, 6)
src/http/me.ts               GET /me (Task 7)
src/http/adminAgents.ts      GET /admin/agents (Task 8)
src/http/pages.ts            nav links (Tasks 7, 8)
src/http/internal.ts         POST /internal/introspect (Task 9)
src/env.ts                   + HUB_INTERNAL_SECRET (Task 9)
vitest.config.ts             + HUB_INTERNAL_SECRET test binding (Task 9)
src/index.ts                 routes /me, /admin/agents, /internal/introspect (Tasks 7, 8, 9)
README.md                    verb rows, agents, introspection (Task 10)
test/db-agents.test.ts       Task 1
test/context-agents.test.ts  Task 2
test/api-agents.test.ts      Task 3
test/agent-verbs.test.ts     Task 4
test/token-verbs.test.ts     Task 5
test/agent-session.test.ts   Task 6
test/me-page.test.ts         Task 7
test/admin-agents.test.ts    Task 8
test/introspect.test.ts      Task 9
test/verb-table.test.ts      Task 10
```

Existing names this plan relies on (phases 1 and 2, do not rename): `createIdentity`, `getIdentityById`, `getIdentityByEmail`, `normalizeEmail` (`src/db/identities.ts`); `addMembership`, `getMembership`, `listMembershipsForIdentity` (`src/db/memberships.ts`); `getTenantBySlug`, `listTenants`, `createTenant` (`src/db/tenants.ts`); `createBrowserSession`, `getSessionByToken`, `touchSession`, `revokeSession`, `listSessions`, `SESSION_ROLLING_MS`, `SESSION_MAX_MS`, `SESSION_TOUCH_INTERVAL_MS` (`src/db/sessions.ts`); `createInvite`, `acceptInvite` (`src/db/invites.ts`); `listConsent`, `grantConsent` (`src/db/consent.ts`); `recordEvent` (`src/db/events.ts`); `randomToken`, `sha256Hex`, `ulid`, `timingSafeEqual` (`src/ids.ts`); `isValidSlug`, `isValidTenantSlug`, `RESERVED_LABELS` (`src/tenant.ts`); `esc`, `page`, `htmlResponse` (`src/html.ts`); `buildContext`, `Ctx`, `rank`, `roleFor` (`src/auth/context.ts`); `clearSessionCookie`, `COOKIE_NAME` (`src/auth/cookie.ts`); `defineVerb`, `registerVerbs`, `listVerbs` (`src/verbs/table.ts`); `reqString`, `optString` (`src/verbs/params.ts`); `HubError`, `badRequest`, `conflict`, `forbidden`, `notFound`, `unauthorized` (`src/errors.ts`); `notFoundPage` (`src/http/pages.ts`); `handleApi` (`src/http/api.ts`); verbs `session.list`, `session.revoke`, `session.end`, `consent.list`, `consent.revoke`; test helpers `apiPost`, `seedTenant`, `seedHuman`, `cookieHeaders`, `bearer` (`test/helpers.ts`). The Worker's default export is `{ fetch: app.fetch, email: handleEmail }`.

Run every test command from the worktree root. `npx vitest run <file>` runs one file; `npm test` runs all; `npm run typecheck` runs `tsc --noEmit`. In tests `HUB_DOMAIN` is `pimwell.test`, so an agent `bot` in tenant `acme` has the address `bot@acme.pimwell.test`.

---

### Task 1: Agent, token, and run-session repositories

**Files:**
- Modify: `src/db/types.ts` (append)
- Create: `src/db/agents.ts`, `src/db/apiTokens.ts`
- Modify: `src/db/sessions.ts` (append three functions; change `touchSession`)
- Modify: `test/helpers.ts` (append `seedAgent`)
- Test: `test/db-agents.test.ts`

**Interfaces:**
- Consumes: `ulid`, `randomToken`, `sha256Hex`; `isValidSlug`, `RESERVED_LABELS`; `badRequest`, `conflict`.
- Produces:
  - Types: `ApiToken = { id; identity_id; tenant_id; name; token_hash; scopes; created_by; created_at; expires_at: number | null; last_used_at: number | null; revoked_at: number | null }`; `Agent = { identity: Identity; membership: Membership; tenant: Tenant; slug: string }`.
  - `src/db/agents.ts`: `RESERVED_AGENT_SLUGS: Set<string>`; `normalizeAgentSlug(s): string` (throws 400 `invalid agent slug`); `agentAddress(slug, tenantSlug, hubDomain): string`; `isAgentDomainAddress(email, hubDomain): boolean`; `createAgent(db, { tenant, slug, display_name, operator_id, role: "member" | "reader", hubDomain }, now): Promise<Agent>` (409 `agent slug taken in this tenant`); `getAgentById(db, id): Promise<Agent | null>` (any state); `getAgentBySlug(db, tenant, slug, hubDomain): Promise<Agent | null>`; `listAgentsForTenant(db, tenant_id, state: State): Promise<Agent[]>`; `listAgentsForOperator(db, operator_id): Promise<Agent[]>` (active agents in active tenants); `archiveAgent(db, agent_id, now): Promise<{ archived: boolean; tokens: number; sessions: number }>`; `tenantAgentActivity(db, tenant_id, now): Promise<Map<string, { tokens: number; runs: number }>>`.
  - `src/db/apiTokens.ts`: `API_TOKEN_PREFIX = "pmw_"`; `createApiToken(db, { identity_id, tenant_id, name, created_by, expires_at }, now): Promise<{ token: ApiToken; plaintext: string }>`; `getApiTokenByToken(db, plaintext, now): Promise<ApiToken | null>` (live only); `getApiTokenById(db, id): Promise<ApiToken | null>`; `listApiTokensForIdentity(db, identity_id, now): Promise<ApiToken[]>`; `listApiTokensForTenant(db, tenant_id, now): Promise<ApiToken[]>`; `listApiTokensForOperator(db, operator_id, now): Promise<Array<{ token: ApiToken; agent_email: string; tenant_slug: string }>>`; `revokeApiToken(db, id, now): Promise<{ revoked: boolean; sessions: number }>`; `markApiTokenUsed(db, id, now): Promise<void>`.
  - `src/db/sessions.ts`: `AGENT_SESSION_DEFAULT_TTL_S = 86400`, `AGENT_SESSION_MAX_TTL_S = 604800`; `createAgentSession(db, { identity_id, tenant_id, label, parent_token_id, ttl_s }, now): Promise<{ session: Session; token: string }>`; `getSessionById(db, id): Promise<Session | null>`; `listAgentRunsForOperator(db, operator_id, now): Promise<Array<{ session: Session; agent_email: string; tenant_slug: string }>>`; `touchSession` no longer extends `expires_at` for `agent_run`.
  - `test/helpers.ts`: `seedAgent(tenant, operator, slug = "bot", role = "member")` returning `{ agent, apiToken, longLived, session, token }` (one `pmw_` token named `ci`, one run labelled `run-1`).

- [ ] **Step 1: Write the failing test**

`test/db-agents.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  archiveAgent, createAgent, getAgentById, getAgentBySlug, isAgentDomainAddress, listAgentsForOperator,
  listAgentsForTenant, normalizeAgentSlug, tenantAgentActivity,
} from "../src/db/agents";
import {
  createApiToken, getApiTokenById, getApiTokenByToken, listApiTokensForIdentity, listApiTokensForOperator,
  listApiTokensForTenant, markApiTokenUsed, revokeApiToken,
} from "../src/db/apiTokens";
import {
  createAgentSession, getSessionById, getSessionByToken, listAgentRunsForOperator, SESSION_TOUCH_INTERVAL_MS, touchSession,
} from "../src/db/sessions";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const db = () => env.HUB_DB;

describe("agent repository", () => {
  it("creates an agent identity with a reserved address and one membership", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const a = await createAgent(db(), { tenant: t, slug: " Bot ", display_name: "Build bot", operator_id: op.identity.id, role: "member", hubDomain: "pimwell.test" }, Date.now());
    expect(a.slug).toBe("bot");
    expect(a.identity).toMatchObject({ kind: "agent", email: "bot@acme.pimwell.test", operator_id: op.identity.id, is_root: 0, state: "active" });
    expect(a.membership).toMatchObject({ tenant_id: t.id, role: "member", state: "active" });
    expect((await getAgentById(db(), a.identity.id))!.tenant.slug).toBe("acme");
    expect((await getAgentBySlug(db(), t, "bot", "pimwell.test"))!.identity.id).toBe(a.identity.id);
    expect((await listAgentsForTenant(db(), t.id, "active")).map((x) => x.slug)).toEqual(["bot"]);
    expect((await listAgentsForOperator(db(), op.identity.id)).map((x) => x.identity.email)).toEqual(["bot@acme.pimwell.test"]);
    expect(await getAgentById(db(), op.identity.id)).toBeNull();
  });

  it("rejects bad and reserved slugs and duplicates in a tenant, but allows the slug in another tenant", async () => {
    for (const bad of ["-x", "a_b", "admin", "postmaster", "no-reply", ""]) expect(() => normalizeAgentSlug(bad)).toThrow("invalid agent slug");
    const acme = await seedTenant("acme");
    const blue = await seedTenant("blue");
    const op = await seedHuman("op@example.com");
    const input = { slug: "bot", display_name: "Bot", operator_id: op.identity.id, role: "member" as const, hubDomain: "pimwell.test" };
    await createAgent(db(), { ...input, tenant: acme }, Date.now());
    await expect(createAgent(db(), { ...input, tenant: acme }, Date.now())).rejects.toMatchObject({ status: 409 });
    const other = await createAgent(db(), { ...input, tenant: blue }, Date.now());
    expect(other.identity.email).toBe("bot@blue.pimwell.test");
    await expect(createAgent(db(), { ...input, slug: "x", display_name: "  ", tenant: acme }, Date.now())).rejects.toMatchObject({ status: 400 });
  });

  it("recognises addresses under tenant subdomains of the hub", () => {
    expect(isAgentDomainAddress("bot@acme.pimwell.test", "pimwell.test")).toBe(true);
    expect(isAgentDomainAddress(" X@Acme.Pimwell.Test ", "pimwell.test")).toBe(true);
    expect(isAgentDomainAddress("login@pimwell.test", "pimwell.test")).toBe(false);
    expect(isAgentDomainAddress("a@example.com", "pimwell.test")).toBe(false);
    expect(isAgentDomainAddress("a@notpimwell.test", "pimwell.test")).toBe(false);
  });
});

describe("api tokens", () => {
  it("stores only a SHA-256 hash and resolves live plaintext", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    expect(s.longLived).toMatch(/^pmw_[A-Za-z0-9_-]{43}$/);
    expect(s.apiToken.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const raw = await db().prepare("SELECT COUNT(*) AS n FROM api_token WHERE token_hash = ? OR name = ?").bind(s.longLived, s.longLived).first<{ n: number }>();
    expect(raw!.n).toBe(0);
    expect((await getApiTokenByToken(db(), s.longLived, Date.now()))!.id).toBe(s.apiToken.id);
    expect(await getApiTokenByToken(db(), s.token, Date.now())).toBeNull();
    expect(await getApiTokenByToken(db(), "pmw_nope", Date.now())).toBeNull();

    const now = Date.now();
    const short = await createApiToken(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, name: "short", created_by: op.identity.id, expires_at: now + 1000 }, now);
    expect(await getApiTokenByToken(db(), short.plaintext, now + 500)).not.toBeNull();
    expect(await getApiTokenByToken(db(), short.plaintext, now + 2000)).toBeNull();

    await markApiTokenUsed(db(), s.apiToken.id, now + 7);
    expect((await getApiTokenById(db(), s.apiToken.id))!.last_used_at).toBe(now + 7);
  });

  it("revoking a token revokes the sessions it started, and only those", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    const second = await createApiToken(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, name: "other", created_by: op.identity.id, expires_at: null }, Date.now());
    const otherRun = await createAgentSession(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, label: "run-2", parent_token_id: second.token.id, ttl_s: 3600 }, Date.now());
    expect(await revokeApiToken(db(), s.apiToken.id, Date.now())).toEqual({ revoked: true, sessions: 1 });
    expect(await getSessionByToken(db(), s.token, Date.now())).toBeNull();
    expect(await getApiTokenByToken(db(), s.longLived, Date.now())).toBeNull();
    expect(await getSessionByToken(db(), otherRun.token, Date.now())).not.toBeNull();
    expect(await revokeApiToken(db(), s.apiToken.id, Date.now())).toEqual({ revoked: false, sessions: 0 });
  });

  it("lists live tokens by agent, tenant, and operator", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const other = await seedHuman("other@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const mine = await seedAgent(t, op.identity, "mine");
    const theirs = await seedAgent(t, other.identity, "theirs");
    expect((await listApiTokensForIdentity(db(), mine.agent.identity.id, Date.now())).map((x) => x.id)).toEqual([mine.apiToken.id]);
    expect((await listApiTokensForTenant(db(), t.id, Date.now())).length).toBe(2);
    const byOp = await listApiTokensForOperator(db(), op.identity.id, Date.now());
    expect(byOp.map((x) => [x.token.id, x.agent_email, x.tenant_slug])).toEqual([[mine.apiToken.id, "mine@acme.pimwell.test", "acme"]]);
    await revokeApiToken(db(), theirs.apiToken.id, Date.now());
    expect((await listApiTokensForTenant(db(), t.id, Date.now())).map((x) => x.id)).toEqual([mine.apiToken.id]);
  });
});

describe("agent run sessions", () => {
  it("creates a pinned agent_run session with the given ttl", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    const now = Date.now();
    const r = await createAgentSession(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, label: "nightly", parent_token_id: s.apiToken.id, ttl_s: 3600 }, now);
    expect(r.token).toMatch(/^pms_/);
    expect(r.session).toMatchObject({ kind: "agent_run", tenant_id: t.id, label: "nightly", parent_token_id: s.apiToken.id, expires_at: now + 3600_000 });
    expect((await getSessionById(db(), r.session.id))!.token_hash).toBe(r.session.token_hash);
  });

  it("touching a run updates last_seen_at but never extends its expiry", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    const now = Date.now();
    const r = await createAgentSession(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, label: "x", parent_token_id: s.apiToken.id, ttl_s: 3600 }, now);
    const later = now + SESSION_TOUCH_INTERVAL_MS + 1;
    const touched = await touchSession(db(), r.session, later);
    expect(touched.last_seen_at).toBe(later);
    expect(touched.expires_at).toBe(now + 3600_000);
    expect((await getSessionById(db(), r.session.id))!.expires_at).toBe(now + 3600_000);
  });

  it("archiving an agent revokes all its tokens and sessions", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    expect(await archiveAgent(db(), s.agent.identity.id, Date.now())).toEqual({ archived: true, tokens: 1, sessions: 1 });
    expect((await getAgentById(db(), s.agent.identity.id))!.identity.state).toBe("archived");
    expect(await getApiTokenByToken(db(), s.longLived, Date.now())).toBeNull();
    expect(await getSessionByToken(db(), s.token, Date.now())).toBeNull();
    expect(await listAgentsForTenant(db(), t.id, "active")).toEqual([]);
    expect((await listAgentsForTenant(db(), t.id, "archived")).length).toBe(1);
    expect(await archiveAgent(db(), s.agent.identity.id, Date.now())).toEqual({ archived: false, tokens: 0, sessions: 0 });
    expect(await archiveAgent(db(), op.identity.id, Date.now())).toEqual({ archived: false, tokens: 0, sessions: 0 });
  });

  it("counts live tokens and runs per agent and lists an operator's runs", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    const activity = await tenantAgentActivity(db(), t.id, Date.now());
    expect(activity.get(s.agent.identity.id)).toEqual({ tokens: 1, runs: 1 });
    const runs = await listAgentRunsForOperator(db(), op.identity.id, Date.now());
    expect(runs.map((r) => [r.session.id, r.session.label, r.agent_email, r.tenant_slug])).toEqual([[s.session.id, "run-1", "bot@acme.pimwell.test", "acme"]]);
    expect(JSON.stringify(runs)).not.toContain(s.token);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db-agents.test.ts`
Expected: FAIL; `../src/db/agents` cannot be resolved.

- [ ] **Step 3: Add the types**

Append to `src/db/types.ts`:
```ts
export type ApiToken = {
  id: string; identity_id: string; tenant_id: string; name: string; token_hash: string; scopes: string;
  created_by: string; created_at: number; expires_at: number | null; last_used_at: number | null; revoked_at: number | null;
};
export type Agent = { identity: Identity; membership: Membership; tenant: Tenant; slug: string };
```

- [ ] **Step 4: Write the agent repository**

`src/db/agents.ts`:
```ts
import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidSlug, RESERVED_LABELS } from "../tenant";
import type { Agent, Identity, Membership, Role, State, Tenant } from "./types";

export const RESERVED_AGENT_SLUGS: Set<string> = new Set([
  ...RESERVED_LABELS, "postmaster", "abuse", "hostmaster", "webmaster", "noreply", "no-reply",
]);

export function normalizeAgentSlug(s: string): string {
  const slug = s.trim().toLowerCase();
  if (!isValidSlug(slug) || RESERVED_AGENT_SLUGS.has(slug)) throw badRequest("invalid agent slug");
  return slug;
}

export function agentAddress(slug: string, tenantSlug: string, hubDomain: string): string {
  return `${slug}@${tenantSlug}.${hubDomain.toLowerCase()}`;
}

/** True for any address under a tenant subdomain of the hub: those are reserved for agents (spec 6.5). */
export function isAgentDomainAddress(email: string, hubDomain: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return domain.endsWith("." + hubDomain.toLowerCase());
}

const AGENT_SELECT = `SELECT i.id AS i_id, i.display_name AS i_display_name, i.is_root, i.email, i.operator_id, i.state AS i_state, i.created_at AS i_created_at,
       m.id AS m_id, m.role, m.state AS m_state, m.created_at AS m_created_at,
       t.id AS t_id, t.slug AS t_slug, t.display_name AS t_display_name, t.state AS t_state, t.created_at AS t_created_at
  FROM identity i JOIN membership m ON m.identity_id = i.id JOIN tenant t ON t.id = m.tenant_id
 WHERE i.kind = 'agent'`;

type Row = Record<string, string | number | null>;

function toAgent(x: Row): Agent {
  const identity: Identity = {
    id: x.i_id as string, kind: "agent", display_name: x.i_display_name as string, is_root: x.is_root as number, email: x.email as string,
    operator_id: x.operator_id as string | null, state: x.i_state as State, created_at: x.i_created_at as number,
  };
  const membership: Membership = {
    id: x.m_id as string, identity_id: identity.id, tenant_id: x.t_id as string, role: x.role as Role, state: x.m_state as State, created_at: x.m_created_at as number,
  };
  const tenant: Tenant = {
    id: x.t_id as string, slug: x.t_slug as string, display_name: x.t_display_name as string, state: x.t_state as State, created_at: x.t_created_at as number,
  };
  return { identity, membership, tenant, slug: identity.email.split("@")[0]! };
}

export async function createAgent(
  db: D1Database,
  input: { tenant: Tenant; slug: string; display_name: string; operator_id: string; role: "member" | "reader"; hubDomain: string },
  now: number,
): Promise<Agent> {
  const slug = normalizeAgentSlug(input.slug);
  const display_name = input.display_name.trim();
  if (!display_name) throw badRequest("display_name required");
  const email = agentAddress(slug, input.tenant.slug, input.hubDomain);
  const identity: Identity = { id: ulid(now), kind: "agent", display_name, is_root: 0, email, operator_id: input.operator_id, state: "active", created_at: now };
  const membership: Membership = { id: ulid(now), identity_id: identity.id, tenant_id: input.tenant.id, role: input.role, state: "active", created_at: now };
  try {
    await db.batch([
      db.prepare("INSERT INTO identity (id, kind, display_name, is_root, email, operator_id, state, created_at) VALUES (?, 'agent', ?, 0, ?, ?, 'active', ?)")
        .bind(identity.id, display_name, email, input.operator_id, now),
      db.prepare("INSERT INTO membership (id, identity_id, tenant_id, role, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
        .bind(membership.id, identity.id, input.tenant.id, input.role, now),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("agent slug taken in this tenant");
    throw e;
  }
  return { identity, membership, tenant: input.tenant, slug };
}

export async function getAgentById(db: D1Database, id: string): Promise<Agent | null> {
  const row = await db.prepare(`${AGENT_SELECT} AND i.id = ?`).bind(id).first<Row>();
  return row ? toAgent(row) : null;
}

export async function getAgentBySlug(db: D1Database, tenant: Tenant, slug: string, hubDomain: string): Promise<Agent | null> {
  const row = await db.prepare(`${AGENT_SELECT} AND i.email = ?`).bind(agentAddress(slug.trim().toLowerCase(), tenant.slug, hubDomain)).first<Row>();
  return row ? toAgent(row) : null;
}

export async function listAgentsForTenant(db: D1Database, tenant_id: string, state: State): Promise<Agent[]> {
  const r = await db.prepare(`${AGENT_SELECT} AND t.id = ? AND i.state = ? ORDER BY i.email`).bind(tenant_id, state).all<Row>();
  return r.results.map(toAgent);
}

export async function listAgentsForOperator(db: D1Database, operator_id: string): Promise<Agent[]> {
  const r = await db.prepare(`${AGENT_SELECT} AND i.operator_id = ? AND i.state = 'active' AND t.state = 'active' ORDER BY t.slug, i.email`)
    .bind(operator_id).all<Row>();
  return r.results.map(toAgent);
}

/** Archive the agent and revoke every token and session it holds, in one batch (spec 6.5 cascade). */
export async function archiveAgent(db: D1Database, agent_id: string, now: number): Promise<{ archived: boolean; tokens: number; sessions: number }> {
  const r = await db.batch([
    db.prepare("UPDATE identity SET state = 'archived' WHERE id = ? AND kind = 'agent' AND state = 'active'").bind(agent_id),
    db.prepare("UPDATE api_token SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM identity WHERE id = ? AND kind = 'agent')").bind(now, agent_id, agent_id),
    db.prepare("UPDATE session SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM identity WHERE id = ? AND kind = 'agent')").bind(now, agent_id, agent_id),
  ]);
  return { archived: r[0]!.meta.changes === 1, tokens: r[1]!.meta.changes, sessions: r[2]!.meta.changes };
}

export async function tenantAgentActivity(db: D1Database, tenant_id: string, now: number): Promise<Map<string, { tokens: number; runs: number }>> {
  const [tokens, runs] = await db.batch<{ identity_id: string; n: number }>([
    db.prepare("SELECT identity_id, COUNT(*) AS n FROM api_token WHERE tenant_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY identity_id").bind(tenant_id, now),
    db.prepare("SELECT identity_id, COUNT(*) AS n FROM session WHERE tenant_id = ? AND kind = 'agent_run' AND revoked_at IS NULL AND expires_at > ? GROUP BY identity_id").bind(tenant_id, now),
  ]);
  const out = new Map<string, { tokens: number; runs: number }>();
  const slot = (id: string) => out.get(id) ?? out.set(id, { tokens: 0, runs: 0 }).get(id)!;
  for (const r of tokens!.results) slot(r.identity_id).tokens = r.n;
  for (const r of runs!.results) slot(r.identity_id).runs = r.n;
  return out;
}
```

- [ ] **Step 5: Write the token repository**

`src/db/apiTokens.ts`:
```ts
import { randomToken, sha256Hex, ulid } from "../ids";
import type { ApiToken } from "./types";

export const API_TOKEN_PREFIX = "pmw_";

export async function createApiToken(
  db: D1Database,
  input: { identity_id: string; tenant_id: string; name: string; created_by: string; expires_at: number | null },
  now: number,
): Promise<{ token: ApiToken; plaintext: string }> {
  const plaintext = randomToken(API_TOKEN_PREFIX);
  const token: ApiToken = {
    id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, name: input.name, token_hash: await sha256Hex(plaintext),
    scopes: "", created_by: input.created_by, created_at: now, expires_at: input.expires_at, last_used_at: null, revoked_at: null,
  };
  await db.prepare(
    `INSERT INTO api_token (id, identity_id, tenant_id, name, token_hash, scopes, created_by, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, NULL, NULL)`,
  ).bind(token.id, token.identity_id, token.tenant_id, token.name, token.token_hash, token.created_by, now, token.expires_at).run();
  return { token, plaintext };
}

export async function getApiTokenByToken(db: D1Database, plaintext: string, now: number): Promise<ApiToken | null> {
  if (!plaintext.startsWith(API_TOKEN_PREFIX)) return null;
  return db.prepare("SELECT * FROM api_token WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
    .bind(await sha256Hex(plaintext), now).first<ApiToken>();
}

export function getApiTokenById(db: D1Database, id: string): Promise<ApiToken | null> {
  return db.prepare("SELECT * FROM api_token WHERE id = ?").bind(id).first<ApiToken>();
}

const LIVE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

export async function listApiTokensForIdentity(db: D1Database, identity_id: string, now: number): Promise<ApiToken[]> {
  const r = await db.prepare(`SELECT * FROM api_token WHERE identity_id = ? AND ${LIVE} ORDER BY created_at DESC`).bind(identity_id, now).all<ApiToken>();
  return r.results;
}

export async function listApiTokensForTenant(db: D1Database, tenant_id: string, now: number): Promise<ApiToken[]> {
  const r = await db.prepare(`SELECT * FROM api_token WHERE tenant_id = ? AND ${LIVE} ORDER BY created_at DESC`).bind(tenant_id, now).all<ApiToken>();
  return r.results;
}

export async function listApiTokensForOperator(db: D1Database, operator_id: string, now: number): Promise<Array<{ token: ApiToken; agent_email: string; tenant_slug: string }>> {
  const r = await db.prepare(
    `SELECT a.*, i.email AS agent_email, t.slug AS tenant_slug
       FROM api_token a JOIN identity i ON i.id = a.identity_id JOIN tenant t ON t.id = a.tenant_id
      WHERE i.operator_id = ? AND i.state = 'active' AND t.state = 'active'
        AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ?)
      ORDER BY a.created_at DESC`,
  ).bind(operator_id, now).all<ApiToken & { agent_email: string; tenant_slug: string }>();
  return r.results.map(({ agent_email, tenant_slug, ...token }) => ({ token, agent_email, tenant_slug }));
}

/** Revoke the token and every session it started, in one batch (spec 6.5). */
export async function revokeApiToken(db: D1Database, id: string, now: number): Promise<{ revoked: boolean; sessions: number }> {
  const r = await db.batch([
    db.prepare("UPDATE api_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id),
    db.prepare("UPDATE session SET revoked_at = ? WHERE parent_token_id = ? AND revoked_at IS NULL").bind(now, id),
  ]);
  return { revoked: r[0]!.meta.changes === 1, sessions: r[1]!.meta.changes };
}

export async function markApiTokenUsed(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE api_token SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}
```

- [ ] **Step 6: Extend the session repository**

In `src/db/sessions.ts`, replace the whole `touchSession` function with:
```ts
export async function touchSession(db: D1Database, session: Session, now: number): Promise<Session> {
  if (now - session.last_seen_at < SESSION_TOUCH_INTERVAL_MS) return session;
  // Only browser sessions roll; an agent run keeps the expiry it was started with.
  const expires_at = session.kind === "browser" ? Math.min(now + SESSION_ROLLING_MS, session.created_at + SESSION_MAX_MS) : session.expires_at;
  await db.prepare("UPDATE session SET last_seen_at = ?, expires_at = ? WHERE id = ?").bind(now, expires_at, session.id).run();
  return { ...session, last_seen_at: now, expires_at };
}
```
Append:
```ts
export const AGENT_SESSION_DEFAULT_TTL_S = 24 * 3600;
export const AGENT_SESSION_MAX_TTL_S = 7 * 24 * 3600;

export async function createAgentSession(
  db: D1Database,
  input: { identity_id: string; tenant_id: string; label: string; parent_token_id: string; ttl_s: number },
  now: number,
): Promise<{ session: Session; token: string }> {
  const token = randomToken("pms_");
  const session: Session = {
    id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, kind: "agent_run", label: input.label,
    token_hash: await sha256Hex(token), created_at: now, last_seen_at: now, expires_at: now + input.ttl_s * 1000,
    last_proof_at: now, revoked_at: null, parent_token_id: input.parent_token_id,
  };
  await db.prepare(
    `INSERT INTO session (id, identity_id, tenant_id, kind, label, token_hash, created_at, last_seen_at, expires_at, last_proof_at, revoked_at, parent_token_id)
     VALUES (?, ?, ?, 'agent_run', ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(session.id, session.identity_id, session.tenant_id, session.label, session.token_hash,
    now, now, session.expires_at, now, session.parent_token_id).run();
  return { session, token };
}

export function getSessionById(db: D1Database, id: string): Promise<Session | null> {
  return db.prepare("SELECT * FROM session WHERE id = ?").bind(id).first<Session>();
}

export async function listAgentRunsForOperator(db: D1Database, operator_id: string, now: number): Promise<Array<{ session: Session; agent_email: string; tenant_slug: string }>> {
  const r = await db.prepare(
    `SELECT s.*, i.email AS agent_email, t.slug AS tenant_slug
       FROM session s JOIN identity i ON i.id = s.identity_id JOIN tenant t ON t.id = s.tenant_id
      WHERE i.operator_id = ? AND s.kind = 'agent_run' AND s.revoked_at IS NULL AND s.expires_at > ?
      ORDER BY s.created_at DESC`,
  ).bind(operator_id, now).all<Session & { agent_email: string; tenant_slug: string }>();
  return r.results.map(({ agent_email, tenant_slug, ...session }) => ({ session, agent_email, tenant_slug }));
}
```

- [ ] **Step 7: Add the test helper**

In `test/helpers.ts`, replace the imports `import { createBrowserSession } from "../src/db/sessions";` and `import type { Role } from "../src/db/types";` with:
```ts
import { createAgent } from "../src/db/agents";
import { createApiToken } from "../src/db/apiTokens";
import { AGENT_SESSION_DEFAULT_TTL_S, createAgentSession, createBrowserSession } from "../src/db/sessions";
import type { Identity, Role, Tenant } from "../src/db/types";
```
Append:
```ts
export async function seedAgent(tenant: Tenant, operator: Identity, slug = "bot", role: "member" | "reader" = "member") {
  const agent = await createAgent(env.HUB_DB, { tenant, slug, display_name: slug, operator_id: operator.id, role, hubDomain: env.HUB_DOMAIN }, Date.now());
  const { token: apiToken, plaintext: longLived } = await createApiToken(env.HUB_DB, { identity_id: agent.identity.id, tenant_id: tenant.id, name: "ci", created_by: operator.id, expires_at: null }, Date.now());
  const { session, token } = await createAgentSession(env.HUB_DB, { identity_id: agent.identity.id, tenant_id: tenant.id, label: "run-1", parent_token_id: apiToken.id, ttl_s: AGENT_SESSION_DEFAULT_TTL_S }, Date.now());
  return { agent, apiToken, longLived, session, token };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/db-agents.test.ts && npm test && npm run typecheck`
Expected: PASS. Existing session tests still pass (browser sessions roll exactly as before).

- [ ] **Step 9: Commit**

```bash
git add src/db/types.ts src/db/agents.ts src/db/apiTokens.ts src/db/sessions.ts test/helpers.ts test/db-agents.test.ts
git commit -F - <<'EOF'
feat: agent, api token, and run session repositories

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 2: Request context for agent credentials

**Files:**
- Create: `src/auth/agent.ts`
- Modify: `src/auth/context.ts`
- Test: `test/context-agents.test.ts`

**Interfaces:**
- Consumes: `getApiTokenByToken`, `API_TOKEN_PREFIX` (Task 1); `touchSession` (Task 1); `getIdentityById`, `getMembership`; `seedAgent` (Task 1).
- Produces:
  - `src/auth/agent.ts`: `operatorActiveIn(db, operator_id: string | null, tenant_id): Promise<boolean>`; `agentCredentialOk(db, agent: Identity, tenant_id, parent_token_id: string | null): Promise<boolean>`.
  - `src/auth/context.ts`: `Ctx.apiToken: ApiToken | null`; `Ctx.authKind: "cookie" | "bearer" | "token" | null`; exported `credentialUsable(db, identity, session: Session | null, apiToken: ApiToken | null, tenant: Tenant | null): Promise<boolean>`.
  - Behaviour: a `pmw_` bearer sets `authKind: "token"`, `identity` = the agent, `session: null`. Agent credentials resolve only on their own tenant host, only while the agent is active, the parent token is unrevoked, and the operator is root or an active member there; otherwise the request is anonymous. A cookie carrying a non-browser session is stale.

- [ ] **Step 1: Write the failing test**

`test/context-agents.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/auth/context";
import { createApiToken } from "../src/db/apiTokens";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const db = () => env.HUB_DB;
const ctxFor = (host: string, headers: Record<string, string>, now = Date.now() + 1) =>
  buildContext(new Request(`https://${host}/`, { headers }), env, now);

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, blue, op, s };
}

describe("agent credentials in buildContext", () => {
  it("resolves a pmw_ token on its own tenant as the agent, with no session", async () => {
    const { acme, s } = await setup();
    const ctx = await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.longLived}` });
    expect(ctx.authKind).toBe("token");
    expect(ctx.apiToken?.id).toBe(s.apiToken.id);
    expect(ctx.identity?.id).toBe(s.agent.identity.id);
    expect(ctx.session).toBeNull();
    expect(ctx.tenant?.id).toBe(acme.id);
    expect(ctx.role).toBe("member");
  });

  it("resolves a run session on its own tenant", async () => {
    const { s } = await setup();
    const ctx = await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` });
    expect(ctx.authKind).toBe("bearer");
    expect(ctx.session?.kind).toBe("agent_run");
    expect(ctx.apiToken).toBeNull();
    expect(ctx.role).toBe("member");
  });

  it("is anonymous on the apex and on another tenant, even one the operator belongs to", async () => {
    const { s } = await setup();
    for (const host of ["pimwell.test", "blue.pimwell.test"]) {
      for (const tok of [s.longLived, s.token]) {
        const ctx = await ctxFor(host, { authorization: `Bearer ${tok}` });
        expect(ctx.identity).toBeNull();
        expect(ctx.session).toBeNull();
        expect(ctx.apiToken).toBeNull();
        expect(ctx.authKind).toBeNull();
        expect(ctx.role).toBeNull();
      }
    }
  });

  it("never accepts an agent session from a cookie", async () => {
    const { s } = await setup();
    const ctx = await ctxFor("acme.pimwell.test", { cookie: `pmw_session=${s.token}` });
    expect(ctx.identity).toBeNull();
    expect(ctx.staleCookie).toBe(true);
  });

  it("stops while the operator is not an active member or is archived, and resumes when restored", async () => {
    const { acme, op, s } = await setup();
    const check = async () => (await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` })).identity?.id ?? null;
    const checkToken = async () => (await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.longLived}` })).identity?.id ?? null;
    await db().prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(op.identity.id, acme.id).run();
    expect(await check()).toBeNull();
    expect(await checkToken()).toBeNull();
    await db().prepare("UPDATE membership SET state = 'active' WHERE identity_id = ? AND tenant_id = ?").bind(op.identity.id, acme.id).run();
    expect(await check()).toBe(s.agent.identity.id);
    await db().prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(op.identity.id).run();
    expect(await check()).toBeNull();
    expect(await checkToken()).toBeNull();
  });

  it("accepts a root operator with no membership", async () => {
    const acme = await seedTenant("acme");
    const root = await seedHuman("root@example.com", { is_root: true });
    const s = await seedAgent(acme, root.identity);
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` })).identity?.id).toBe(s.agent.identity.id);
  });

  it("rejects a run whose parent token is revoked even if the run row was not", async () => {
    const { s } = await setup();
    await db().prepare("UPDATE api_token SET revoked_at = ? WHERE id = ?").bind(Date.now(), s.apiToken.id).run();
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.token}` })).identity).toBeNull();
  });

  it("rejects an archived agent, an expired token, and a token held by a human", async () => {
    const { acme, op, s } = await setup();
    const now = Date.now();
    const short = await createApiToken(db(), { identity_id: s.agent.identity.id, tenant_id: acme.id, name: "short", created_by: op.identity.id, expires_at: now + 1000 }, now);
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${short.plaintext}` }, now + 500)).identity).not.toBeNull();
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${short.plaintext}` }, now + 2000)).identity).toBeNull();
    const human = await createApiToken(db(), { identity_id: op.identity.id, tenant_id: acme.id, name: "h", created_by: op.identity.id, expires_at: null }, now);
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${human.plaintext}` })).identity).toBeNull();
    await db().prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(s.agent.identity.id).run();
    expect((await ctxFor("acme.pimwell.test", { authorization: `Bearer ${s.longLived}` })).identity).toBeNull();
  });

  it("does not touch a run used on the wrong host", async () => {
    const { s } = await setup();
    const later = Date.now() + 2 * 3600_000;
    await ctxFor("blue.pimwell.test", { authorization: `Bearer ${s.token}` }, later);
    const row = await db().prepare("SELECT last_seen_at FROM session WHERE id = ?").bind(s.session.id).first<{ last_seen_at: number }>();
    expect(row!.last_seen_at).toBe(s.session.last_seen_at);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/context-agents.test.ts`
Expected: FAIL; `authKind` is `null` for the `pmw_` token and the cross-tenant run resolves to the agent.

- [ ] **Step 3: Write the agent credential check**

`src/auth/agent.ts`:
```ts
import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import type { Identity } from "../db/types";

/** The operator is an active human who is root or holds an active membership (any role) in the tenant. */
export async function operatorActiveIn(db: D1Database, operator_id: string | null, tenant_id: string): Promise<boolean> {
  if (!operator_id) return false;
  const op = await getIdentityById(db, operator_id);
  if (!op || op.kind !== "human" || op.state !== "active") return false;
  if (op.is_root === 1) return true;
  const m = await getMembership(db, op.id, tenant_id);
  return m !== null && m.state === "active";
}

/** An agent credential is usable while the agent is active, its parent token (for runs) is unrevoked, and its operator is live. */
export async function agentCredentialOk(db: D1Database, agent: Identity, tenant_id: string, parent_token_id: string | null): Promise<boolean> {
  if (agent.kind !== "agent" || agent.state !== "active") return false;
  if (parent_token_id !== null) {
    const t = await db.prepare("SELECT identity_id, tenant_id, revoked_at FROM api_token WHERE id = ?")
      .bind(parent_token_id).first<{ identity_id: string; tenant_id: string; revoked_at: number | null }>();
    if (!t || t.revoked_at !== null || t.identity_id !== agent.id || t.tenant_id !== tenant_id) return false;
  }
  return operatorActiveIn(db, agent.operator_id, tenant_id);
}
```

- [ ] **Step 4: Teach buildContext the new credentials**

In `src/auth/context.ts`:

Add imports:
```ts
import { API_TOKEN_PREFIX, getApiTokenByToken } from "../db/apiTokens";
import { agentCredentialOk } from "./agent";
```
and change the type import to `import type { ApiToken, Identity, Membership, Role, Session, Tenant } from "../db/types";`.

In `type Ctx`, add `apiToken: ApiToken | null;` after `session: Session | null;`, and change `authKind` to `authKind: "cookie" | "bearer" | "token" | null;`.

Add this exported function above `buildContext`:
```ts
/** Humans: browser sessions only. Agents: pinned to one tenant and alive only while agent, parent token, and operator are (spec 6.5, 10). */
export async function credentialUsable(db: D1Database, identity: Identity, session: Session | null, apiToken: ApiToken | null, tenant: Tenant | null): Promise<boolean> {
  if (identity.state !== "active") return false;
  if (identity.kind === "human") return apiToken === null && session !== null && session.kind === "browser";
  if (session && session.kind !== "agent_run") return false;
  const pinned = session ? session.tenant_id : apiToken ? apiToken.tenant_id : null;
  if (!tenant || pinned !== tenant.id) return false;
  return agentCredentialOk(db, identity, tenant.id, session ? session.parent_token_id : null);
}
```

In `buildContext`, replace everything from `let session: Session | null = null;` down to and including the closing `}` of the `if (session) { ... }` identity block with:
```ts
  let session: Session | null = null;
  let apiToken: ApiToken | null = null;
  let authKind: Ctx["authKind"] = null;
  let staleCookie = false;
  if (bearer && bearer.startsWith("pms_")) {
    session = await getSessionByToken(db, bearer, now);
    if (session) authKind = "bearer";
  } else if (bearer && bearer.startsWith(API_TOKEN_PREFIX)) {
    apiToken = await getApiTokenByToken(db, bearer, now);
    if (apiToken) authKind = "token";
  } else if (cookieToken) {
    session = await getSessionByToken(db, cookieToken, now);
    // Agents authenticate by bearer only (spec 6.5); a run token in a cookie is stale.
    if (session && session.kind !== "browser") session = null;
    if (session) authKind = "cookie";
    else staleCookie = true;
  }

  let identity: Identity | null = null;
  if (session) identity = await getIdentityById(db, session.identity_id);
  else if (apiToken) identity = await getIdentityById(db, apiToken.identity_id);
  if (identity && !(await credentialUsable(db, identity, session, apiToken, tenant))) identity = null;
  if (!identity && authKind !== null) {
    if (authKind === "cookie") staleCookie = true;
    session = null;
    apiToken = null;
    authKind = null;
  }
  if (session) session = await touchSession(db, session, now);
```
Change the final `return` to:
```ts
  return { env, db, now, ip, waitUntil, host, tenant, identity, session, apiToken, role, authKind, staleCookie };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/context-agents.test.ts && npm test && npm run typecheck`
Expected: PASS, including the phase 1 `test/context.test.ts` cases.

- [ ] **Step 6: Commit**

```bash
git add src/auth/agent.ts src/auth/context.ts test/context-agents.test.ts
git commit -F - <<'EOF'
feat: resolve pmw_ tokens and pin agent credentials to tenant and live operator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 3: Dispatcher flags, fresh proof for every declaring verb, and whoami

**Files:**
- Modify: `src/verbs/table.ts`, `src/verbs/params.ts`, `src/http/api.ts`, `src/verbs/whoami.ts`
- Test: `test/api-agents.test.ts`

**Interfaces:**
- Consumes: `Ctx.apiToken`, `authKind: "token"` (Task 2); `seedAgent` (Task 1); `esc`, `page`, `htmlResponse`.
- Produces:
  - `VerbDef` optional fields: `longLivedToken?: boolean`, `humanOnly?: boolean`, `renderForm?: (result: R) => string`.
  - `optInt(input, key, { min, max }): number | null` in `src/verbs/params.ts` (accepts numbers and digit strings; else 400 `<key> must be an integer from <min> to <max>`).
  - Dispatcher order: unknown verb 404; scope 404s; cookie Origin; `pmw_` token on a verb without `longLivedToken` → 403 `forbidden`; `minRole` checks; `humanOnly` with an agent → 403 `forbidden`; fresh proof for any verb with `freshProofMinutes` when the session is `browser`; parse; run. A form post with `renderForm` gets 200 HTML; other form posts 303 to `_back` (a same-origin path matching `^/[A-Za-z0-9/_.?=&-]*$`, not `//`), else the same-origin referer, else `/`.
  - `whoami` (now `longLivedToken: true`) returns `{ identity: null }` when anonymous, else `{ identity: { id, email, display_name, is_root, kind, operator_id }, session: { id, kind, label, created_at, expires_at, last_proof_at } | null, token: { id, name } | null, tenant, memberships }`.

- [ ] **Step 1: Write the failing test**

`test/api-agents.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineVerb, registerVerbs } from "../src/verbs/table";
import { optInt, reqString } from "../src/verbs/params";
import { esc } from "../src/html";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

beforeAll(() => {
  registerVerbs([
    defineVerb({ name: "test.member", kind: "query", scope: "tenant", minRole: "member", freshProofMinutes: null, summary: "m", parse: () => ({}), run: async (ctx) => ({ who: ctx.identity!.email }) }),
    defineVerb({ name: "test.humans", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, humanOnly: true, summary: "h", parse: () => ({}), run: async () => ({ done: true }) }),
    defineVerb({ name: "test.fresh", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, summary: "f", parse: () => ({}), run: async () => ({ done: true }) }),
    defineVerb({
      name: "test.render", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, summary: "r",
      parse: (i) => ({ v: reqString(i, "v", { max: 40 }) }), run: async (_c, p) => ({ v: p.v }), renderForm: (r) => `<p id="out">${esc(r.v)}</p>`,
    }),
    defineVerb({ name: "test.int", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, summary: "i", parse: (i) => ({ n: optInt(i, "n", { min: 1, max: 10 }) }), run: async (_c, p) => p }),
  ]);
});

const stale = (id: string) => env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, id).run();
const form = (host: string, verb: string, fields: Record<string, string>, token: string) =>
  SELF.fetch(`https://${host}/api/${verb}`, {
    method: "POST", redirect: "manual",
    headers: { ...cookieHeaders(token, host), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

async function setup() {
  const acme = await seedTenant("acme");
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, op, s };
}

describe("long-lived tokens in the dispatcher", () => {
  it("may call whoami and nothing else", async () => {
    const { op, s } = await setup();
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, bearer(s.longLived))).json()) as any;
    expect(who.result.identity).toMatchObject({ id: s.agent.identity.id, kind: "agent", email: "bot@acme.pimwell.test", operator_id: op.identity.id, is_root: false });
    expect(who.result.session).toBeNull();
    expect(who.result.token).toEqual({ id: s.apiToken.id, name: "ci" });
    expect(who.result.tenant.role).toBe("member");
    const denied = await apiPost("acme.pimwell.test", "test.member", {}, bearer(s.longLived));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).detail).toContain("session.start");
    expect((await apiPost("acme.pimwell.test", "project.list", {}, bearer(s.longLived))).status).toBe(403);
  });

  it("lets a run session call member verbs but not human-only ones", async () => {
    const { s } = await setup();
    expect((await apiPost("acme.pimwell.test", "test.member", {}, bearer(s.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "test.humans", {}, bearer(s.token))).status).toBe(403);
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, bearer(s.token))).json()) as any;
    expect(who.result.session).toMatchObject({ id: s.session.id, kind: "agent_run", label: "run-1" });
    expect(who.result.token).toBeNull();
  });
});

describe("fresh proof and forms", () => {
  it("applies fresh proof to a public verb for browser sessions only", async () => {
    const { op, s } = await setup();
    expect((await apiPost("pimwell.test", "test.fresh", {}, bearer(op.token))).status).toBe(200);
    await stale(op.session.id);
    const res = await apiPost("pimwell.test", "test.fresh", {}, bearer(op.token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("reproof_required");
    await stale(s.session.id);
    expect((await apiPost("acme.pimwell.test", "test.fresh", {}, bearer(s.token))).status).toBe(200);
    expect((await apiPost("pimwell.test", "test.fresh", {})).status).toBe(200);
  });

  it("renders a page for verbs with renderForm, JSON otherwise", async () => {
    const h = await seedHuman("a@example.com");
    const res = await form("pimwell.test", "test.render", { v: "<x>" }, h.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain('<p id="out">&lt;x&gt;</p>');
    const json = (await (await apiPost("pimwell.test", "test.render", { v: "y" })).json()) as any;
    expect(json.result).toEqual({ v: "y" });
  });

  it("redirects form posts to a same-origin _back path only", async () => {
    const h = await seedHuman("a@example.com");
    const ok = await form("pimwell.test", "test.humans", { _back: "/me" }, h.token);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/me");
    for (const bad of ["//evil.example/x", "https://evil.example/", "/a\\b", "/x\r\nset-cookie: a=b"]) {
      const res = await form("pimwell.test", "test.humans", { _back: bad }, h.token);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("parses integers strictly", async () => {
    expect(((await (await apiPost("pimwell.test", "test.int", { n: 3 })).json()) as any).result).toEqual({ n: 3 });
    expect(((await (await apiPost("pimwell.test", "test.int", { n: "7" })).json()) as any).result).toEqual({ n: 7 });
    expect(((await (await apiPost("pimwell.test", "test.int", {})).json()) as any).result).toEqual({ n: null });
    for (const n of [0, 11, 2.5, "3x", "", true]) {
      const res = await apiPost("pimwell.test", "test.int", { n });
      if (n === "") expect(res.status).toBe(200);
      else expect(res.status).toBe(400);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api-agents.test.ts`
Expected: FAIL; `optInt` is not exported and `whoami` with a `pmw_` token returns `identity: null`.

- [ ] **Step 3: Add the VerbDef flags and optInt**

In `src/verbs/table.ts`, replace the `VerbDef` type with:
```ts
export type VerbDef<P, R> = {
  name: string;
  kind: "query" | "command";
  scope: VerbScope;
  minRole: Role | "public";
  freshProofMinutes: number | null;
  summary: string;
  /** Callable with a long-lived pmw_ token. Spec 6.5: only session.start and whoami. */
  longLivedToken?: boolean;
  /** Refused for agent identities: agents never create agents or manage credentials (spec 2). */
  humanOnly?: boolean;
  /** For form posts: render this HTML body instead of redirecting (used to show a new token once). */
  renderForm?: (result: R) => string;
  parse: (input: Record<string, unknown>) => P;
  run: (ctx: Ctx, params: P) => Promise<R>;
};
```
Append to `src/verbs/params.ts`:
```ts
export function optInt(input: Input, key: string, opts: { min: number; max: number }): number | null {
  const v = input[key];
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < opts.min || n > opts.max) throw badRequest(`${key} must be an integer from ${opts.min} to ${opts.max}`);
  return n;
}
```

- [ ] **Step 4: Update the dispatcher**

In `src/http/api.ts`, add the import `import { htmlResponse, page } from "../html";`.

Replace the block that starts with `if (verb.minRole !== "public") {` and ends with the `return finish(ctx, env, new Response(null, { status: 303, ... }));` of the `if (isForm) { ... }` branch (that is, everything between the cookie Origin check and `return finish(ctx, env, json({ ok: true, result }, 200));`) with:
```ts
    // A long-lived pmw_ token may only start a run or ask whoami (spec 6.5).
    if (ctx.authKind === "token" && verb.longLivedToken !== true) {
      throw new HubError(403, "forbidden", "a long-lived token may only call session.start and whoami");
    }

    if (verb.minRole !== "public") {
      if (verb.scope === "tenant" && ctx.role === null) throw new HubError(404, "not_found");
      if (!ctx.identity) throw new HubError(401, "unauthorized");
      const effective = verb.scope === "hub" ? (ctx.identity.is_root === 1 ? "root" : null) : ctx.role;
      if (rank(effective) < rank(verb.minRole)) throw new HubError(403, "forbidden");
    }
    if (verb.humanOnly === true && ctx.identity && ctx.identity.kind !== "human") throw new HubError(403, "forbidden", "agents may not call this verb");
    // Fresh proof is a property of browser sessions, by cookie or bearer; agent runs and long-lived tokens are exempt (spec 6.7).
    if (verb.freshProofMinutes !== null && ctx.session && ctx.session.kind === "browser") {
      if (ctx.now - ctx.session.last_proof_at > verb.freshProofMinutes * 60_000) throw new HubError(403, "reproof_required");
    }

    const params = verb.parse(body.input);
    const result = await verb.run(ctx, params);
    if (isForm && verb.renderForm) return finish(ctx, env, htmlResponse(page(verb.name, verb.renderForm(result))));
    if (isForm) {
      const self = `${url.protocol}//${url.host}`;
      let back = "/";
      const asked = body.input._back;
      if (typeof asked === "string" && /^\/[A-Za-z0-9/_.?=&-]*$/.test(asked) && !asked.startsWith("//")) {
        back = asked;
      } else {
        try {
          const ref = request.headers.get("referer");
          if (ref) {
            const r = new URL(ref);
            if (r.origin === self) back = ref;
          }
        } catch { /* malformed referer: fall back to / */ }
      }
      return finish(ctx, env, new Response(null, { status: 303, headers: { location: back, "cache-control": "no-store" } }));
    }
```

- [ ] **Step 5: Make whoami describe tokens and agents**

Replace `src/verbs/whoami.ts` with:
```ts
import { defineVerb } from "./table";
import { listMembershipsForIdentity } from "../db/memberships";

export const whoami = defineVerb({
  name: "whoami",
  kind: "query",
  scope: "public",
  minRole: "public",
  freshProofMinutes: null,
  longLivedToken: true,
  summary: "Describe the caller: identity, session or long-lived token, role on this tenant, and memberships.",
  parse: () => ({}),
  run: async (ctx) => {
    if (!ctx.identity) return { identity: null };
    const memberships = await listMembershipsForIdentity(ctx.db, ctx.identity.id);
    const s = ctx.session;
    return {
      identity: {
        id: ctx.identity.id, email: ctx.identity.email, display_name: ctx.identity.display_name, is_root: ctx.identity.is_root === 1,
        kind: ctx.identity.kind, operator_id: ctx.identity.operator_id,
      },
      session: s ? { id: s.id, kind: s.kind, label: s.label, created_at: s.created_at, expires_at: s.expires_at, last_proof_at: s.last_proof_at } : null,
      token: ctx.apiToken ? { id: ctx.apiToken.id, name: ctx.apiToken.name } : null,
      tenant: ctx.tenant && ctx.role !== null ? { id: ctx.tenant.id, slug: ctx.tenant.slug, role: ctx.role } : null,
      memberships: memberships.map((m) => ({ slug: m.tenant.slug, display_name: m.tenant.display_name, role: m.membership.role })),
    };
  },
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/api-agents.test.ts && npm test && npm run typecheck`
Expected: PASS, including `test/api.test.ts`, `test/reproof.test.ts`, and `test/bootstrap.test.ts` (whoami only gained fields).

- [ ] **Step 7: Commit**

```bash
git add src/verbs/table.ts src/verbs/params.ts src/http/api.ts src/verbs/whoami.ts test/api-agents.test.ts
git commit -F - <<'EOF'
feat: dispatcher token gate, human-only verbs, form pages, and agent-aware whoami

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 4: agent.create and agent.archive

**Files:**
- Create: `src/auth/authority.ts`, `src/verbs/agent.ts`
- Modify: `src/verbs/index.ts`, `src/verbs/invite.ts`, `src/db/invites.ts`
- Test: `test/agent-verbs.test.ts`

**Interfaces:**
- Consumes: `createAgent`, `getAgentById`, `archiveAgent`, `isAgentDomainAddress` (Task 1); `humanOnly`, fresh proof for public verbs (Task 3); `rank`, `roleFor`, `Ctx`; `getIdentityByEmail`, `normalizeEmail`; `getMembership`; `getTenantBySlug`; `recordEvent`.
- Produces:
  - `src/auth/authority.ts`: `requireHuman(ctx): { identity: Identity; session: Session }` (401 otherwise); `roleIn(ctx, tenant_id): Promise<Role | null>`; `targetTenant(ctx, slug: string | null): Promise<{ tenant: Tenant; role: Role }>` (400 `tenant is required`, 404 when unknown, archived, or the caller has no role); `manageableAgent(ctx, agent: Agent | null): Promise<Agent>` (operator who is at least `member` there, tenant admin, or root; else 404 `no such agent`).
  - `src/verbs/agent.ts`: `agentView(agent): { id, slug, address, display_name, tenant, role, operator_id, state, created_at }`; verbs:
    - `agent.create`: command, scope `public`, minRole `public`, fresh 60, `humanOnly`. Params `{ tenant?: slug (defaults to host tenant), slug, display_name, operator?: email, role?: "member" | "reader" }`. Caller needs at least `member` in the tenant (403 otherwise; 404 if no role). Only admins/roots may name another operator, who must be a human with at least `member` there (400 otherwise). Result `{ agent: agentView }`. Event `agent.create`, `target_kind: "identity"`.
    - `agent.archive`: command, scope `public`, minRole `public`, fresh 60, `humanOnly`. Params `{ agent_id }`. Result `{ ok: true, tokens_revoked, sessions_revoked }`. 409 if already archived. Event `agent.archive`.
  - `invite.create` rejects addresses under a tenant subdomain (400 `addresses under tenant domains are reserved for agents`); `acceptInvite` returns `null` for an existing non-human identity.

- [ ] **Step 1: Write the failing test**

`test/agent-verbs.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSessionByToken } from "../src/db/sessions";
import { getApiTokenByToken } from "../src/db/apiTokens";
import { acceptInvite, createInvite } from "../src/db/invites";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

const ev = (kind: string) => env.HUB_DB.prepare("SELECT tenant_id, identity_id, session_id, target_id, summary FROM event WHERE kind = ?").bind(kind).first<Record<string, string>>();
const stale = (id: string) => env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, id).run();

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
  const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const reader = await seedHuman("r@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
  return { acme, blue, admin, member, reader };
}

describe("agent.create", () => {
  it("lets a member create their own agent on the tenant host or from the apex", async () => {
    const { acme, member } = await setup();
    const res = await apiPost("acme.pimwell.test", "agent.create", { slug: "Bot", display_name: "Build bot" }, bearer(member.token));
    expect(res.status).toBe(200);
    const a = ((await res.json()) as any).result.agent;
    expect(a).toMatchObject({ slug: "bot", address: "bot@acme.pimwell.test", display_name: "Build bot", tenant: "acme", role: "member", operator_id: member.identity.id, state: "active" });
    expect(await ev("agent.create")).toMatchObject({ tenant_id: acme.id, identity_id: member.identity.id, session_id: member.session.id, target_id: a.id });
    const apex = await apiPost("pimwell.test", "agent.create", { tenant: "acme", slug: "two", display_name: "Two", role: "reader" }, bearer(member.token));
    expect(((await apex.json()) as any).result.agent).toMatchObject({ address: "two@acme.pimwell.test", role: "reader" });
    expect((await apiPost("pimwell.test", "agent.create", { slug: "three", display_name: "Three" }, bearer(member.token))).status).toBe(400);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "bot", display_name: "Again" }, bearer(member.token))).status).toBe(409);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "x", display_name: "X", role: "admin" }, bearer(member.token))).status).toBe(400);
  });

  it("refuses readers, non-members, anonymous callers, agents, and stale proof", async () => {
    const { acme, member, reader } = await setup();
    const outsider = await seedHuman("out@example.com");
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A" }, bearer(reader.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A" }, bearer(outsider.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.create", { tenant: "blue", slug: "a", display_name: "A" }, bearer(member.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.create", { tenant: "nope", slug: "a", display_name: "A" }, bearer(member.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A" })).status).toBe(401);
    const s = await seedAgent(acme, member.identity);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "child", display_name: "C" }, bearer(s.token))).status).toBe(403);
    await stale(member.session.id);
    const res = await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A" }, bearer(member.token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("reproof_required");
  });

  it("lets only an admin name another operator, who must be a human member", async () => {
    const { admin, member, reader } = await setup();
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A", operator: "admin@example.com" }, bearer(member.token))).status).toBe(403);
    const ok = await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A", operator: "M@Example.com" }, bearer(admin.token));
    expect(((await ok.json()) as any).result.agent.operator_id).toBe(member.identity.id);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "b", display_name: "B", operator: "r@example.com" }, bearer(admin.token))).status).toBe(400);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "c", display_name: "C", operator: "nobody@example.com" }, bearer(admin.token))).status).toBe(400);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "d", display_name: "D", operator: "a@acme.pimwell.test" }, bearer(admin.token))).status).toBe(400);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "e", display_name: "E", operator: reader.identity.email }, bearer(admin.token))).status).toBe(400);
  });

  it("lets a root create an agent in any tenant", async () => {
    await setup();
    const root = await seedHuman("root@example.com", { is_root: true });
    expect((await apiPost("pimwell.test", "agent.create", { tenant: "blue", slug: "r", display_name: "R" }, bearer(root.token))).status).toBe(200);
  });
});

describe("agent.archive", () => {
  it("lets the operator archive, revoking tokens and sessions, once", async () => {
    const { acme, member } = await setup();
    const s = await seedAgent(acme, member.identity);
    const res = await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(member.token));
    expect(((await res.json()) as any).result).toEqual({ ok: true, tokens_revoked: 1, sessions_revoked: 1 });
    expect(await getSessionByToken(env.HUB_DB, s.token, Date.now())).toBeNull();
    expect(await getApiTokenByToken(env.HUB_DB, s.longLived, Date.now())).toBeNull();
    expect(await ev("agent.archive")).toMatchObject({ tenant_id: acme.id, session_id: member.session.id, target_id: s.agent.identity.id });
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(member.token))).status).toBe(409);
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, bearer(s.token))).json()) as any;
    expect(who.result.identity).toBeNull();
  });

  it("lets an admin archive any agent in the tenant and hides agents from everyone else", async () => {
    const { acme, admin, member, reader } = await setup();
    const other = await seedHuman("o@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, member.identity);
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(other.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(reader.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: member.identity.id }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: "NOPE" }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(s.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(admin.token))).status).toBe(200);
  });
});

describe("agent addresses are not invitable", () => {
  it("rejects invites to tenant-domain addresses and never accepts for an agent identity", async () => {
    const { acme, blue, admin, member } = await setup();
    const res = await apiPost("acme.pimwell.test", "invite.create", { email: "x@acme.pimwell.test", role: "member" }, bearer(admin.token));
    expect(res.status).toBe(400);
    const s = await seedAgent(acme, member.identity);
    const { invite } = await createInvite(env.HUB_DB, { tenant_id: blue.id, email: s.agent.identity.email, role: "member", display_name: null, created_by: null }, Date.now());
    expect(await acceptInvite(env.HUB_DB, invite, Date.now())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agent-verbs.test.ts`
Expected: FAIL; `agent.create` returns 404 `unknown_verb`.

- [ ] **Step 3: Write the authority helpers**

`src/auth/authority.ts`:
```ts
import { getMembership } from "../db/memberships";
import { getTenantBySlug } from "../db/tenants";
import { badRequest, notFound, unauthorized } from "../errors";
import { rank, roleFor, type Ctx } from "./context";
import type { Agent, Identity, Role, Session, Tenant } from "../db/types";

export function requireHuman(ctx: Ctx): { identity: Identity; session: Session } {
  if (!ctx.identity || !ctx.session) throw unauthorized();
  return { identity: ctx.identity, session: ctx.session };
}

/** The caller's role in a tenant named by a target, not by the host. */
export async function roleIn(ctx: Ctx, tenant_id: string): Promise<Role | null> {
  if (!ctx.identity) return null;
  if (ctx.tenant && ctx.tenant.id === tenant_id) return ctx.role;
  return roleFor(ctx.identity, await getMembership(ctx.db, ctx.identity.id, tenant_id));
}

/** Tenant from a slug parameter, else the host. Unknown, archived, or roleless: 404 like any hidden tenant (spec 5). */
export async function targetTenant(ctx: Ctx, slug: string | null): Promise<{ tenant: Tenant; role: Role }> {
  const s = slug?.trim().toLowerCase() || ctx.tenant?.slug || null;
  if (!s) throw badRequest("tenant is required");
  const tenant = ctx.tenant && ctx.tenant.slug === s ? ctx.tenant : await getTenantBySlug(ctx.db, s);
  if (!tenant || tenant.state !== "active") throw notFound("no such tenant");
  const role = await roleIn(ctx, tenant.id);
  if (role === null) throw notFound("no such tenant");
  return { tenant, role };
}

/** Operator (still at least a member there), that tenant's admin, or root. Anyone else: 404, as if the agent did not exist. */
export async function manageableAgent(ctx: Ctx, agent: Agent | null): Promise<Agent> {
  if (!agent || agent.tenant.state !== "active" || !ctx.identity) throw notFound("no such agent");
  const role = await roleIn(ctx, agent.tenant.id);
  if (rank(role) >= rank("admin")) return agent;
  if (agent.identity.operator_id === ctx.identity.id && rank(role) >= rank("member")) return agent;
  throw notFound("no such agent");
}
```

- [ ] **Step 4: Write the agent verbs**

`src/verbs/agent.ts`:
```ts
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, conflict, forbidden } from "../errors";
import { archiveAgent, createAgent, getAgentById } from "../db/agents";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { getMembership } from "../db/memberships";
import { recordEvent } from "../db/events";
import { rank, roleFor } from "../auth/context";
import { manageableAgent, requireHuman, targetTenant } from "../auth/authority";
import type { Agent } from "../db/types";

export function agentView(a: Agent) {
  return {
    id: a.identity.id, slug: a.slug, address: a.identity.email, display_name: a.identity.display_name, tenant: a.tenant.slug,
    role: a.membership.role, operator_id: a.identity.operator_id, state: a.identity.state, created_at: a.identity.created_at,
  };
}

function agentRole(i: Record<string, unknown>): "member" | "reader" {
  const v = optString(i, "role", { max: 10 }) ?? "member";
  if (v !== "member" && v !== "reader") throw badRequest("role must be one of member, reader");
  return v;
}

export const agentCreate = defineVerb({
  name: "agent.create", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Create an agent in a tenant with the reserved address <slug>@<tenant>. You operate it unless an admin names another member.",
  parse: (i) => ({
    tenant: optString(i, "tenant", { max: 63 }),
    slug: reqString(i, "slug", { max: 63 }),
    display_name: reqString(i, "display_name", { max: 80 }),
    operator: optString(i, "operator", { max: 254 }),
    role: agentRole(i),
  }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const { tenant, role } = await targetTenant(ctx, p.tenant);
    if (rank(role) < rank("member")) throw forbidden("readers may not create agents");
    let operator = identity;
    if (p.operator && normalizeEmail(p.operator) !== identity.email) {
      if (rank(role) < rank("admin")) throw forbidden("only an admin may name another operator");
      const other = await getIdentityByEmail(ctx.db, p.operator);
      const m = other ? await getMembership(ctx.db, other.id, tenant.id) : null;
      if (!other || other.kind !== "human" || rank(roleFor(other, m)) < rank("member")) throw badRequest("operator must be a human member or admin of this tenant");
      operator = other;
    }
    const agent = await createAgent(ctx.db, { tenant, slug: p.slug, display_name: p.display_name, operator_id: operator.id, role: p.role, hubDomain: ctx.env.HUB_DOMAIN }, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: tenant.id, identity_id: identity.id, session_id: session.id, kind: "agent.create", target_kind: "identity", target_id: agent.identity.id,
      summary: `Created agent ${agent.identity.email} operated by ${operator.email}`,
    }, ctx.now);
    return { agent: agentView(agent) };
  },
});

export const agentArchive = defineVerb({
  name: "agent.archive", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Archive an agent you operate (admins: any agent in the tenant). Revokes all its tokens and sessions.",
  parse: (i) => ({ agent_id: reqString(i, "agent_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const agent = await manageableAgent(ctx, await getAgentById(ctx.db, p.agent_id));
    if (agent.identity.state !== "active") throw conflict("agent already archived");
    const r = await archiveAgent(ctx.db, agent.identity.id, ctx.now);
    if (!r.archived) throw conflict("agent already archived");
    await recordEvent(ctx.db, {
      tenant_id: agent.tenant.id, identity_id: identity.id, session_id: session.id, kind: "agent.archive", target_kind: "identity", target_id: agent.identity.id,
      summary: `Archived agent ${agent.identity.email}; revoked ${r.tokens} token(s) and ${r.sessions} session(s)`,
    }, ctx.now);
    return { ok: true, tokens_revoked: r.tokens, sessions_revoked: r.sessions };
  },
});
```

- [ ] **Step 5: Protect agent addresses from invites**

In `src/verbs/invite.ts`, add `badRequest` to the `../errors` import, add `import { isAgentDomainAddress } from "../db/agents";`, and make this the first line of `inviteCreate.run`:
```ts
    if (isAgentDomainAddress(p.email, ctx.env.HUB_DOMAIN)) throw badRequest("addresses under tenant domains are reserved for agents");
```
In `src/db/invites.ts`, in `acceptInvite`, replace
```ts
  if (pre && pre.state !== "active") return null;
```
with
```ts
  if (pre && (pre.state !== "active" || pre.kind !== "human")) return null;
```

- [ ] **Step 6: Register the verbs**

In `src/verbs/index.ts` add `import { agentArchive, agentCreate } from "./agent";` and append `agentCreate, agentArchive,` to the `registerVerbs([...])` list.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/agent-verbs.test.ts && npm test && npm run typecheck`
Expected: PASS, including `test/invite-flow.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/auth/authority.ts src/verbs/agent.ts src/verbs/index.ts src/verbs/invite.ts src/db/invites.ts test/agent-verbs.test.ts
git commit -F - <<'EOF'
feat: agent.create and agent.archive; agent addresses are not invitable

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 5: token.create, token.revoke, token.list

**Files:**
- Create: `src/verbs/token.ts`
- Modify: `src/verbs/index.ts`
- Test: `test/token-verbs.test.ts`

**Interfaces:**
- Consumes: `createApiToken`, `getApiTokenById`, `revokeApiToken`, `listApiTokensForIdentity`, `listApiTokensForTenant`, `listApiTokensForOperator`, `getAgentById` (Task 1); `optInt`, `renderForm`, `humanOnly` (Task 3); `requireHuman`, `manageableAgent` (Task 4); `esc`; `recordEvent`.
- Produces:
  - `tokenView(t: ApiToken): { id, name, agent_id, tenant_id, created_by, created_at, expires_at, last_used_at }` (never `token_hash`).
  - `token.create`: command, scope `public`, minRole `public`, fresh 60, `humanOnly`. Params `{ agent_id, name (max 80), expires_in_days?: 1..365 }`. Result `{ token: "pmw_…", token_id, name, agent_id, agent: <address>, tenant: <slug>, expires_at }`. 409 for an archived agent. Event `token.create` (`target_kind: "api_token"`), summary without the plaintext. Form posts render a page showing the token once.
  - `token.revoke`: command, scope `public`, minRole `public`, fresh 60, `humanOnly`. Params `{ token_id }`. Result `{ ok: true, sessions_revoked }`. 404 when not manageable, 409 when already revoked. Event `token.revoke`.
  - `token.list`: query, scope `public`, minRole `public`, no fresh proof, `humanOnly`. Params `{ agent_id? }`. With `agent_id`: that agent's live tokens (manageable only). Without, on a tenant host where the caller is admin or root: every live token in the tenant. Otherwise: live tokens of agents the caller operates. Result `{ tokens: tokenView[] }`.

- [ ] **Step 1: Write the failing test**

`test/token-verbs.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getApiTokenByToken } from "../src/db/apiTokens";
import { getSessionByToken } from "../src/db/sessions";
import { archiveAgent } from "../src/db/agents";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

async function setup() {
  const acme = await seedTenant("acme");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const other = await seedHuman("o@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, admin, op, other, s };
}

describe("token.create", () => {
  it("returns the plaintext once and stores only its hash", async () => {
    const { acme, op, s } = await setup();
    const before = Date.now();
    const res = await apiPost("pimwell.test", "token.create", { agent_id: s.agent.identity.id, name: "deploy", expires_in_days: 30 }, bearer(op.token));
    expect(res.status).toBe(200);
    const r = ((await res.json()) as any).result;
    expect(r.token).toMatch(/^pmw_[A-Za-z0-9_-]{43}$/);
    expect(r).toMatchObject({ name: "deploy", agent_id: s.agent.identity.id, agent: "bot@acme.pimwell.test", tenant: "acme" });
    expect(r.expires_at).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
    expect(r.expires_at).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000);
    expect((await getApiTokenByToken(env.HUB_DB, r.token, Date.now()))!.id).toBe(r.token_id);
    const ev = await env.HUB_DB.prepare("SELECT tenant_id, session_id, target_id, summary FROM event WHERE kind = 'token.create'").first<Record<string, string>>();
    expect(ev).toMatchObject({ tenant_id: acme.id, session_id: op.session.id, target_id: r.token_id });
    expect(ev!.summary).not.toContain(r.token);
    const list = await (await apiPost("pimwell.test", "token.list", { agent_id: s.agent.identity.id }, bearer(op.token))).text();
    expect(list).not.toContain(r.token);
    expect(list).not.toContain("token_hash");
  });

  it("validates expiry and refuses non-managers, agents, archived agents, and stale proof", async () => {
    const { admin, op, other, s } = await setup();
    const body = { agent_id: s.agent.identity.id, name: "x" };
    expect((await apiPost("pimwell.test", "token.create", { ...body, expires_in_days: 0 }, bearer(op.token))).status).toBe(400);
    expect((await apiPost("pimwell.test", "token.create", { ...body, expires_in_days: 366 }, bearer(op.token))).status).toBe(400);
    expect((await apiPost("pimwell.test", "token.create", { ...body, name: "" }, bearer(op.token))).status).toBe(400);
    expect((await apiPost("pimwell.test", "token.create", { ...body, name: "   " }, bearer(op.token))).status).toBe(400);
    const forever = ((await (await apiPost("pimwell.test", "token.create", body, bearer(op.token))).json()) as any).result;
    expect(forever.expires_at).toBeNull();
    expect((await apiPost("pimwell.test", "token.create", body, bearer(other.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "token.create", body, bearer(s.token))).status).toBe(403);
    expect((await apiPost("pimwell.test", "token.create", body, bearer(admin.token))).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, op.session.id).run();
    expect(((await (await apiPost("pimwell.test", "token.create", body, bearer(op.token))).json()) as any).error).toBe("reproof_required");
    await archiveAgent(env.HUB_DB, s.agent.identity.id, Date.now());
    expect((await apiPost("pimwell.test", "token.create", body, bearer(admin.token))).status).toBe(409);
  });

  it("shows the token on a page for form posts", async () => {
    const { op, s } = await setup();
    const res = await SELF.fetch("https://pimwell.test/api/token.create", {
      method: "POST", redirect: "manual",
      headers: { ...cookieHeaders(op.token, "pimwell.test"), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ agent_id: s.agent.identity.id, name: "<b>web</b>" }).toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toMatch(/pmw_[A-Za-z0-9_-]{43}/);
    expect(html).toContain("will not be shown again");
    expect(html).toContain("&lt;b&gt;web&lt;/b&gt;");
    expect(html).not.toContain("<b>web</b>");
  });
});

describe("token.revoke", () => {
  it("revokes the token and its sessions for the operator, once", async () => {
    const { acme, op, s } = await setup();
    const res = await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(op.token));
    expect(((await res.json()) as any).result).toEqual({ ok: true, sessions_revoked: 1 });
    expect(await getSessionByToken(env.HUB_DB, s.token, Date.now())).toBeNull();
    const ev = await env.HUB_DB.prepare("SELECT tenant_id, target_id FROM event WHERE kind = 'token.revoke'").first<Record<string, string>>();
    expect(ev).toEqual({ tenant_id: acme.id, target_id: s.apiToken.id });
    expect((await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(op.token))).status).toBe(409);
  });

  it("lets an admin revoke and hides tokens from other members", async () => {
    const { admin, other, s } = await setup();
    expect((await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(other.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "token.revoke", { token_id: "NOPE" }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(s.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(admin.token))).status).toBe(200);
  });
});

describe("token.list", () => {
  it("lists by agent, by operator, and for admins by tenant", async () => {
    const { acme, admin, op, other, s } = await setup();
    const theirs = await seedAgent(acme, other.identity, "theirs");
    const ids = async (host: string, body: object, token: string) =>
      (((await (await apiPost(host, "token.list", body, bearer(token))).json()) as any).result.tokens as any[]).map((t) => t.id).sort();
    expect(await ids("pimwell.test", {}, op.token)).toEqual([s.apiToken.id]);
    expect(await ids("acme.pimwell.test", {}, op.token)).toEqual([s.apiToken.id]);
    expect(await ids("acme.pimwell.test", {}, admin.token)).toEqual([s.apiToken.id, theirs.apiToken.id].sort());
    expect(await ids("pimwell.test", { agent_id: theirs.agent.identity.id }, admin.token)).toEqual([theirs.apiToken.id]);
    expect((await apiPost("pimwell.test", "token.list", { agent_id: theirs.agent.identity.id }, bearer(op.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "token.list", {})).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/token-verbs.test.ts`
Expected: FAIL; `token.create` returns 404 `unknown_verb`.

- [ ] **Step 3: Write the token verbs**

`src/verbs/token.ts`:
```ts
import { defineVerb } from "./table";
import { optInt, optString, reqString } from "./params";
import { badRequest, conflict, notFound } from "../errors";
import { getAgentById } from "../db/agents";
import {
  createApiToken, getApiTokenById, listApiTokensForIdentity, listApiTokensForOperator, listApiTokensForTenant, revokeApiToken,
} from "../db/apiTokens";
import { recordEvent } from "../db/events";
import { rank } from "../auth/context";
import { manageableAgent, requireHuman } from "../auth/authority";
import { esc } from "../html";
import type { ApiToken } from "../db/types";

export function tokenView(t: ApiToken) {
  return {
    id: t.id, name: t.name, agent_id: t.identity_id, tenant_id: t.tenant_id, created_by: t.created_by,
    created_at: t.created_at, expires_at: t.expires_at, last_used_at: t.last_used_at,
  };
}

type Created = { token: string; token_id: string; name: string; agent_id: string; agent: string; tenant: string; expires_at: number | null };

export const tokenCreate = defineVerb({
  name: "token.create", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Mint a long-lived pmw_ token for an agent you operate (admins: any agent in the tenant). The token is shown once.",
  parse: (i) => ({
    agent_id: reqString(i, "agent_id", { max: 26 }),
    name: reqString(i, "name", { max: 80 }),
    expires_in_days: optInt(i, "expires_in_days", { min: 1, max: 365 }),
  }),
  run: async (ctx, p): Promise<Created> => {
    const { identity, session } = requireHuman(ctx);
    const agent = await manageableAgent(ctx, await getAgentById(ctx.db, p.agent_id));
    if (agent.identity.state !== "active") throw conflict("agent is archived");
    const name = p.name.trim();
    if (!name) throw badRequest("name is required");
    const expires_at = p.expires_in_days === null ? null : ctx.now + p.expires_in_days * 86_400_000;
    const { token, plaintext } = await createApiToken(ctx.db, {
      identity_id: agent.identity.id, tenant_id: agent.tenant.id, name, created_by: identity.id, expires_at,
    }, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: agent.tenant.id, identity_id: identity.id, session_id: session.id, kind: "token.create", target_kind: "api_token", target_id: token.id,
      summary: `Created token "${token.name}" for ${agent.identity.email}`,
    }, ctx.now);
    return { token: plaintext, token_id: token.id, name: token.name, agent_id: agent.identity.id, agent: agent.identity.email, tenant: agent.tenant.slug, expires_at };
  },
  renderForm: (r: Created) => `<h1>New token for ${esc(r.agent)}</h1>
<p>Token <strong>${esc(r.name)}</strong>. Copy it now: it will not be shown again.</p>
<pre>${esc(r.token)}</pre>
<p>Start a run with <code>POST https://${esc(r.tenant)}.&lt;hub&gt;/api/session.start</code> and <code>Authorization: Bearer &lt;token&gt;</code>.</p>
<p><a href="/me">Back</a></p>`,
});

export const tokenRevoke = defineVerb({
  name: "token.revoke", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Revoke a long-lived token and every session it started.",
  parse: (i) => ({ token_id: reqString(i, "token_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const t = await getApiTokenById(ctx.db, p.token_id);
    if (!t) throw notFound("no such token");
    await manageableAgent(ctx, await getAgentById(ctx.db, t.identity_id));
    if (t.revoked_at !== null) throw conflict("token already revoked");
    const r = await revokeApiToken(ctx.db, t.id, ctx.now);
    if (!r.revoked) throw conflict("token already revoked");
    await recordEvent(ctx.db, {
      tenant_id: t.tenant_id, identity_id: identity.id, session_id: session.id, kind: "token.revoke", target_kind: "api_token", target_id: t.id,
      summary: `Revoked token "${t.name}"; ended ${r.sessions} session(s)`,
    }, ctx.now);
    return { ok: true, sessions_revoked: r.sessions };
  },
});

export const tokenList = defineVerb({
  name: "token.list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, humanOnly: true,
  summary: "List live long-lived tokens: one agent's, your agents', or (admins on a tenant host) the tenant's.",
  parse: (i) => ({ agent_id: optString(i, "agent_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity } = requireHuman(ctx);
    let rows: ApiToken[];
    if (p.agent_id) {
      const agent = await manageableAgent(ctx, await getAgentById(ctx.db, p.agent_id));
      rows = await listApiTokensForIdentity(ctx.db, agent.identity.id, ctx.now);
    } else if (ctx.tenant && rank(ctx.role) >= rank("admin")) {
      rows = await listApiTokensForTenant(ctx.db, ctx.tenant.id, ctx.now);
    } else {
      rows = (await listApiTokensForOperator(ctx.db, identity.id, ctx.now)).map((x) => x.token);
    }
    return { tokens: rows.map(tokenView) };
  },
});
```

- [ ] **Step 4: Register the verbs**

In `src/verbs/index.ts` add `import { tokenCreate, tokenList, tokenRevoke } from "./token";` and append `tokenCreate, tokenRevoke, tokenList,` to the `registerVerbs([...])` list.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/token-verbs.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/token.ts src/verbs/index.ts test/token-verbs.test.ts
git commit -F - <<'EOF'
feat: token.create, token.revoke, and token.list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 6: session.start and run revocation by operators and admins

**Files:**
- Modify: `src/verbs/session.ts`, `src/verbs/index.ts`
- Test: `test/agent-session.test.ts`

**Interfaces:**
- Consumes: `createAgentSession`, `getSessionById`, `AGENT_SESSION_DEFAULT_TTL_S`, `AGENT_SESSION_MAX_TTL_S`, `markApiTokenUsed` (Task 1); `Ctx.apiToken`, `authKind: "token"` (Task 2); `optInt`, `longLivedToken` (Task 3); `roleIn` (Task 4); `getIdentityById`; `rank`.
- Produces:
  - `session.start`: command, scope `tenant`, minRole `reader`, no fresh proof, `longLivedToken: true`. Params `{ label (max 80), ttl?: seconds 60..604800 }`. Requires `authKind === "token"` (403 otherwise). Result `{ session_id, session_token: "pms_…", expires_at, tenant: <slug> }`. Marks the token used. Event `session.start` with `identity_id` = agent, `session_id` = the new run.
  - `session.revoke` now also allows: the operator of the session's agent, and an admin (or root) of the session's tenant. Event `tenant_id` = the target session's `tenant_id`.

- [ ] **Step 1: Write the failing test**

`test/agent-session.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getApiTokenById } from "../src/db/apiTokens";
import { getSessionByToken } from "../src/db/sessions";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

const DAY = 86_400_000;

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, blue, op, s };
}
const start = (host: string, token: string, body: object = { label: "nightly" }) => apiPost(host, "session.start", body, bearer(token));
const list = (host: string, token: string) => apiPost(host, "project.list", {}, bearer(token));

describe("session.start", () => {
  it("trades a long-lived token for a 24 hour run pinned to the tenant", async () => {
    const { acme, s } = await setup();
    const before = Date.now();
    const res = await start("acme.pimwell.test", s.longLived);
    expect(res.status).toBe(200);
    const r = ((await res.json()) as any).result;
    expect(r.session_token).toMatch(/^pms_/);
    expect(r.tenant).toBe("acme");
    expect(r.expires_at).toBeGreaterThanOrEqual(before + DAY);
    expect(r.expires_at).toBeLessThanOrEqual(Date.now() + DAY);
    const row = await getSessionByToken(env.HUB_DB, r.session_token, Date.now());
    expect(row).toMatchObject({ id: r.session_id, kind: "agent_run", tenant_id: acme.id, label: "nightly", parent_token_id: s.apiToken.id, identity_id: s.agent.identity.id });
    expect((await getApiTokenById(env.HUB_DB, s.apiToken.id))!.last_used_at).not.toBeNull();
    const ev = await env.HUB_DB.prepare("SELECT tenant_id, identity_id, session_id, summary FROM event WHERE kind = 'session.start'").first<Record<string, string>>();
    expect(ev).toMatchObject({ tenant_id: acme.id, identity_id: s.agent.identity.id, session_id: r.session_id });
    expect(ev!.summary).not.toContain(s.longLived);
    expect(ev!.summary).not.toContain(r.session_token);

    expect((await list("acme.pimwell.test", r.session_token)).status).toBe(200);
    expect((await list("blue.pimwell.test", r.session_token)).status).toBe(404);
    const who = (await (await apiPost("pimwell.test", "whoami", {}, bearer(r.session_token))).json()) as any;
    expect(who.result.identity).toBeNull();
  });

  it("honours ttl bounds in seconds", async () => {
    const { s } = await setup();
    const before = Date.now();
    const hour = ((await (await start("acme.pimwell.test", s.longLived, { label: "x", ttl: 3600 })).json()) as any).result;
    expect(hour.expires_at).toBeGreaterThanOrEqual(before + 3600_000);
    expect(hour.expires_at).toBeLessThanOrEqual(Date.now() + 3600_000);
    expect((await start("acme.pimwell.test", s.longLived, { label: "x", ttl: 604800 })).status).toBe(200);
    for (const ttl of [59, 604801, "abc", -5]) expect((await start("acme.pimwell.test", s.longLived, { label: "x", ttl })).status).toBe(400);
    expect((await start("acme.pimwell.test", s.longLived, {})).status).toBe(400);
  });

  it("needs a long-lived token, on its own tenant", async () => {
    const { op, s } = await setup();
    expect((await start("acme.pimwell.test", s.token)).status).toBe(403);
    expect((await start("acme.pimwell.test", op.token)).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "session.start", { label: "x" })).status).toBe(404);
    expect((await start("blue.pimwell.test", s.longLived)).status).toBe(404);
    expect((await start("pimwell.test", s.longLived)).status).toBe(404);
  });
});

describe("revocation cascade", () => {
  it("revoking the token ends its runs and blocks new ones", async () => {
    const { op, s } = await setup();
    const r = ((await (await start("acme.pimwell.test", s.longLived)).json()) as any).result;
    const res = await apiPost("pimwell.test", "token.revoke", { token_id: s.apiToken.id }, bearer(op.token));
    expect(((await res.json()) as any).result.sessions_revoked).toBe(2);
    expect((await list("acme.pimwell.test", r.session_token)).status).toBe(404);
    expect((await list("acme.pimwell.test", s.token)).status).toBe(404);
    expect((await start("acme.pimwell.test", s.longLived)).status).toBe(404);
  });

  it("archiving the agent ends everything", async () => {
    const { op, s } = await setup();
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(op.token))).status).toBe(200);
    expect((await list("acme.pimwell.test", s.token)).status).toBe(404);
    expect((await start("acme.pimwell.test", s.longLived)).status).toBe(404);
  });

  it("pauses the agent while its operator is not an active member, and resumes after", async () => {
    const { acme, op, s } = await setup();
    const setState = (state: string) => env.HUB_DB.prepare("UPDATE membership SET state = ? WHERE identity_id = ? AND tenant_id = ?").bind(state, op.identity.id, acme.id).run();
    await setState("archived");
    expect((await list("acme.pimwell.test", s.token)).status).toBe(404);
    expect((await start("acme.pimwell.test", s.longLived)).status).toBe(404);
    await setState("active");
    expect((await list("acme.pimwell.test", s.token)).status).toBe(200);
    expect((await start("acme.pimwell.test", s.longLived)).status).toBe(200);
  });
});

describe("session.revoke and session.end for runs", () => {
  it("lets the operator and a tenant admin revoke a run, and nobody else", async () => {
    const { acme, op, s } = await setup();
    const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
    const other = await seedHuman("o@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: s.session.id }, bearer(other.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: op.session.id }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: s.session.id }, bearer(op.token))).status).toBe(200);
    expect(await getSessionByToken(env.HUB_DB, s.token, Date.now())).toBeNull();
    const ev = await env.HUB_DB.prepare("SELECT tenant_id FROM event WHERE kind = 'session.revoke'").first<{ tenant_id: string }>();
    expect(ev!.tenant_id).toBe(acme.id);
    const r = ((await (await start("acme.pimwell.test", s.longLived)).json()) as any).result;
    expect((await apiPost("acme.pimwell.test", "session.revoke", { session_id: r.session_id }, bearer(admin.token))).status).toBe(200);
    expect(await getSessionByToken(env.HUB_DB, r.session_token, Date.now())).toBeNull();
  });

  it("lets the agent end its own run on its tenant", async () => {
    const { s } = await setup();
    expect((await apiPost("acme.pimwell.test", "session.end", {}, bearer(s.token))).status).toBe(200);
    expect(await getSessionByToken(env.HUB_DB, s.token, Date.now())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agent-session.test.ts`
Expected: FAIL; `session.start` returns 404 `unknown_verb`.

- [ ] **Step 3: Add session.start and widen session.revoke**

In `src/verbs/session.ts`:

Replace the imports with:
```ts
import { defineVerb } from "./table";
import { optInt, reqString } from "./params";
import { forbidden, notFound, unauthorized } from "../errors";
import {
  AGENT_SESSION_DEFAULT_TTL_S, AGENT_SESSION_MAX_TTL_S, createAgentSession, getSessionById, listSessions, revokeSession,
} from "../db/sessions";
import { markApiTokenUsed } from "../db/apiTokens";
import { getIdentityById } from "../db/identities";
import { recordEvent } from "../db/events";
import { rank, type Ctx } from "../auth/context";
import { roleIn } from "../auth/authority";
import type { Session } from "../db/types";
```

Add below `requireIdentity`:
```ts
/** Own session, root, the operator of the session's agent, or an admin of the session's tenant (spec 6.5, 6.6). */
async function mayRevoke(ctx: Ctx, target: Session): Promise<boolean> {
  const me = ctx.identity!;
  if (target.identity_id === me.id || me.is_root === 1) return true;
  if (me.kind !== "human") return false;
  const owner = await getIdentityById(ctx.db, target.identity_id);
  if (owner && owner.kind === "agent" && owner.operator_id === me.id) return true;
  return target.tenant_id !== null && rank(await roleIn(ctx, target.tenant_id)) >= rank("admin");
}
```

Replace the `run` of `sessionRevoke` with:
```ts
  run: async (ctx, p) => {
    const { identity, session } = requireIdentity(ctx);
    const target = await getSessionById(ctx.db, p.session_id);
    if (!target || !(await mayRevoke(ctx, target))) throw notFound("no such session");
    await revokeSession(ctx.db, target.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: target.tenant_id, identity_id: identity.id, session_id: session.id, kind: "session.revoke", target_kind: "session", target_id: target.id, summary: `Revoked session ${target.id}` }, ctx.now);
    return { ok: true };
  },
```
and change its `summary` to `"Revoke a session: your own, a run of an agent you operate, or (admins) any run in your tenant; roots any session."`.

Append:
```ts
export const sessionStart = defineVerb({
  name: "session.start", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null, longLivedToken: true,
  summary: "Start an agent run: trade a long-lived pmw_ token for a pms_ session token pinned to this tenant (ttl in seconds, default 1 day, max 7).",
  parse: (i) => ({ label: reqString(i, "label", { max: 80 }), ttl: optInt(i, "ttl", { min: 60, max: AGENT_SESSION_MAX_TTL_S }) }),
  run: async (ctx, p) => {
    if (ctx.authKind !== "token" || !ctx.apiToken || !ctx.identity) throw forbidden("session.start needs a long-lived pmw_ token");
    const { session, token } = await createAgentSession(ctx.db, {
      identity_id: ctx.identity.id, tenant_id: ctx.apiToken.tenant_id, label: p.label, parent_token_id: ctx.apiToken.id,
      ttl_s: p.ttl ?? AGENT_SESSION_DEFAULT_TTL_S,
    }, ctx.now);
    await markApiTokenUsed(ctx.db, ctx.apiToken.id, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: ctx.apiToken.tenant_id, identity_id: ctx.identity.id, session_id: session.id, kind: "session.start", target_kind: "session", target_id: session.id,
      summary: `Started run "${p.label}" with token "${ctx.apiToken.name}"`,
    }, ctx.now);
    return { session_id: session.id, session_token: token, expires_at: session.expires_at, tenant: ctx.tenant!.slug };
  },
});
```

- [ ] **Step 4: Register the verb**

In `src/verbs/index.ts` change the session import to `import { sessionEnd, sessionList, sessionRevoke, sessionStart } from "./session";` and append `sessionStart,` to the `registerVerbs([...])` list.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/agent-session.test.ts && npm test && npm run typecheck`
Expected: PASS, including `test/session-verbs.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/session.ts src/verbs/index.ts test/agent-session.test.ts
git commit -F - <<'EOF'
feat: session.start for agent runs; operators and admins revoke runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 7: The /me page

**Files:**
- Create: `src/http/me.ts`
- Modify: `src/index.ts` (route), `src/http/pages.ts` (apex nav link)
- Test: `test/me-page.test.ts`

**Interfaces:**
- Consumes: `listAgentsForOperator`, `listApiTokensForOperator`, `listAgentRunsForOperator` (Task 1); `listSessions`; `listMembershipsForIdentity`; `listTenants`; `listConsent`; `buildContext`, `rank`; `clearSessionCookie`; `notFoundPage`; verbs `session.revoke`, `session.end`, `agent.create`, `agent.archive`, `token.create`, `token.revoke`, `consent.revoke`; the `_back` form field (Task 3).
- Produces: `mePage(request, env): Promise<Response>` at `GET /me` on the apex. 404 on other hosts; 401 page without a human browser session. Sections: Sessions, Agents you operate (each with a new-token form and an archive button), New agent (one form per tenant where the caller is at least `member`; roots: every active tenant), Tokens, Agent runs, Mail consent. Every form posts to `/api/<verb>` with `_back=/me` except `token.create` (renders the token page).

- [ ] **Step 1: Write the failing test**

`test/me-page.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grantConsent } from "../src/db/consent";
import { createAgent } from "../src/db/agents";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const get = (host: string, headers: Record<string, string> = {}) => SELF.fetch(`https://${host}/me`, { headers });

describe("/me", () => {
  it("is the apex account page for a signed-in human only", async () => {
    const acme = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, op.identity);
    expect((await get("pimwell.test")).status).toBe(401);
    expect((await get("acme.pimwell.test", { cookie: `pmw_session=${op.token}` })).status).toBe(404);
    expect((await get("pimwell.test", { authorization: `Bearer ${s.token}` })).status).toBe(401);
    expect((await get("pimwell.test", { cookie: `pmw_session=${s.token}` })).status).toBe(401);
  });

  it("shows sessions, agents, tokens, runs, and consent with working forms and no secrets", async () => {
    const acme = await seedTenant("acme");
    const blue = await seedTenant("blue");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "reader" }] });
    const s = await seedAgent(acme, op.identity);
    await grantConsent(env.HUB_DB, { email: "op@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
    const res = await get("pimwell.test", { cookie: `pmw_session=${op.token}` });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(op.session.id);
    expect(html).toContain('action="/api/session.end"');
    expect(html).toContain("bot@acme.pimwell.test");
    expect(html).toContain('action="/api/token.create"');
    expect(html).toContain(`name="agent_id" value="${s.agent.identity.id}"`);
    expect(html).toContain('action="/api/agent.archive"');
    expect(html).toContain('action="/api/token.revoke"');
    expect(html).toContain(`name="token_id" value="${s.apiToken.id}"`);
    expect(html).toContain("run-1");
    expect(html).toContain(`name="session_id" value="${s.session.id}"`);
    expect(html).toContain('action="/api/agent.create"');
    expect(html).toContain('name="tenant" value="acme"');
    expect(html).not.toContain('name="tenant" value="blue"');
    expect(html).toContain("inbound_email");
    expect(html).toContain('action="/api/consent.revoke"');
    expect(html).toContain('name="_back" value="/me"');
    for (const secret of [s.longLived, s.token, op.token, s.apiToken.token_hash, s.session.token_hash]) expect(html).not.toContain(secret);
  });

  it("escapes agent names and offers roots every tenant", async () => {
    const acme = await seedTenant("acme");
    await seedTenant("blue");
    const root = await seedHuman("root@example.com", { is_root: true });
    await createAgent(env.HUB_DB, { tenant: acme, slug: "x", display_name: "<script>x</script>", operator_id: root.identity.id, role: "member", hubDomain: env.HUB_DOMAIN }, Date.now());
    const html = await (await get("pimwell.test", { cookie: `pmw_session=${root.token}` })).text();
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain('name="tenant" value="acme"');
    expect(html).toContain('name="tenant" value="blue"');
  });

  it("is linked from the apex home", async () => {
    const h = await seedHuman("a@example.com");
    const html = await (await SELF.fetch("https://pimwell.test/", { headers: { cookie: `pmw_session=${h.token}` } })).text();
    expect(html).toContain('href="/me"');
    expect(html).toContain('href="/me/sessions"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/me-page.test.ts`
Expected: FAIL; `GET /me` returns 404.

- [ ] **Step 3: Write the page**

`src/http/me.ts`:
```ts
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { listAgentRunsForOperator, listSessions } from "../db/sessions";
import { listMembershipsForIdentity } from "../db/memberships";
import { listTenants } from "../db/tenants";
import { listAgentsForOperator } from "../db/agents";
import { listApiTokensForOperator } from "../db/apiTokens";
import { listConsent } from "../db/consent";
import { notFoundPage } from "./pages";

const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));
const BACK = `<input type="hidden" name="_back" value="/me">`;

function button(verb: string, fields: Record<string, string>, label: string): string {
  const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<form class="inline" method="post" action="/api/${esc(verb)}">${hidden}${BACK}<button type="submit">${esc(label)}</button></form>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "<p>None.</p>";
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export async function mePage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex") return notFoundPage(extra);
  if (!ctx.identity || !ctx.session || ctx.identity.kind !== "human") {
    return htmlResponse(page("Sign in", `<h1>Sign in required</h1><p><a href="/login">Sign in</a></p>`), 401, extra);
  }
  const me = ctx.identity;
  const [sessions, memberships, agents, tokens, runs, consents] = await Promise.all([
    listSessions(ctx.db, me.id, ctx.now),
    listMembershipsForIdentity(ctx.db, me.id),
    listAgentsForOperator(ctx.db, me.id),
    listApiTokensForOperator(ctx.db, me.id, ctx.now),
    listAgentRunsForOperator(ctx.db, me.id, ctx.now),
    listConsent(ctx.db, me.email),
  ]);
  const creatable = me.is_root === 1
    ? (await listTenants(ctx.db, "active")).map((t) => t.slug)
    : memberships.filter((m) => rank(m.membership.role) >= rank("member")).map((m) => m.tenant.slug);

  let body = `<h1>Your account</h1><p>${esc(me.display_name)} &lt;${esc(me.email)}&gt; · <a href="/">hub</a></p>`;

  body += `<h2>Sessions</h2>` + table(["Id", "Kind", "Started", "Last seen", ""], sessions.map((s) => [
    `${esc(s.id)}${s.id === ctx.session!.id ? " (this one)" : ""}`, esc(s.kind), when(s.created_at), when(s.last_seen_at),
    button("session.revoke", { session_id: s.id }, "Revoke"),
  ])) + `<form method="post" action="/api/session.end"><button type="submit">Sign out</button></form>`;

  body += `<h2>Agents you operate</h2>` + table(["Address", "Name", "Tenant", "Role", "Created", ""], agents.map((a) => [
    `<code>${esc(a.identity.email)}</code>`, esc(a.identity.display_name), esc(a.tenant.slug), esc(a.membership.role), when(a.identity.created_at),
    `<form class="inline" method="post" action="/api/token.create"><input type="hidden" name="agent_id" value="${esc(a.identity.id)}"><input name="name" placeholder="token name" required maxlength="80"><button type="submit">New token</button></form> `
      + button("agent.archive", { agent_id: a.identity.id }, "Archive"),
  ]));

  body += `<h2>New agent</h2>` + (creatable.length === 0 ? "<p>You cannot create agents in any tenant.</p>" : creatable.map((slug) =>
    `<form method="post" action="/api/agent.create"><input type="hidden" name="tenant" value="${esc(slug)}">${BACK}`
    + `<label>Slug <input name="slug" required maxlength="63" pattern="[a-z0-9-]+"></label> `
    + `<label>Name <input name="display_name" required maxlength="80"></label> `
    + `<button type="submit">Create agent in ${esc(slug)}</button></form>`).join(""));

  body += `<h2>Tokens</h2>` + table(["Name", "Agent", "Tenant", "Created", "Last used", "Expires", ""], tokens.map((t) => [
    esc(t.token.name), `<code>${esc(t.agent_email)}</code>`, esc(t.tenant_slug), when(t.token.created_at), when(t.token.last_used_at),
    when(t.token.expires_at), button("token.revoke", { token_id: t.token.id }, "Revoke"),
  ]));

  body += `<h2>Agent runs</h2>` + table(["Label", "Agent", "Tenant", "Started", "Expires", ""], runs.map((r) => [
    esc(r.session.label ?? ""), `<code>${esc(r.agent_email)}</code>`, esc(r.tenant_slug), when(r.session.created_at), when(r.session.expires_at),
    button("session.revoke", { session_id: r.session.id }, "Revoke"),
  ]));

  const active = consents.some((c) => c.revoked_at === null);
  body += `<h2>Mail consent</h2><p>The hub emails ${esc(me.email)} only while consent is active.</p>`
    + table(["Kind", "Granted", "Revoked"], consents.map((c) => [esc(c.kind), when(c.granted_at), c.revoked_at === null ? "" : when(c.revoked_at)]))
    + (active ? button("consent.revoke", {}, "Stop emails to this address") : `<p>To allow sign-in links by email, write to login@${esc(env.HUB_DOMAIN)} from this address.</p>`);

  return htmlResponse(page("Your account", body), 200, extra);
}
```

- [ ] **Step 4: Route and link it**

In `src/index.ts` add `import { mePage } from "./http/me";` and, next to the `/me/sessions` route, `app.get("/me", (c) => mePage(c.req.raw, c.env));`.

In `src/http/pages.ts`, in `homePage`, replace
```ts
    let body = `<h1>Pimwell</h1><p>${esc(ctx.identity.display_name)} · <a href="/me/sessions">sessions</a></p>`;
```
with
```ts
    let body = `<h1>Pimwell</h1><p>${esc(ctx.identity.display_name)} · <a href="/me">account</a> · <a href="/me/sessions">sessions</a></p>`;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/me-page.test.ts && npm test && npm run typecheck`
Expected: PASS, including `test/pages.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/http/me.ts src/index.ts src/http/pages.ts test/me-page.test.ts
git commit -F - <<'EOF'
feat: /me page with sessions, agents, tokens, runs, and consent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 8: The tenant /admin/agents page

**Files:**
- Create: `src/http/adminAgents.ts`
- Modify: `src/index.ts` (route), `src/http/pages.ts` (tenant nav link for admins)
- Test: `test/admin-agents.test.ts`

**Interfaces:**
- Consumes: `listAgentsForTenant`, `tenantAgentActivity` (Task 1); `getIdentityById`; `buildContext`, `rank`; `clearSessionCookie`; `notFoundPage`; verb `agent.archive` (Task 4); `_back` (Task 3).
- Produces: `adminAgentsPage(request, env): Promise<Response>` at `GET /admin/agents` on a tenant host. Admins and roots of that tenant only; everyone else, and the apex, get the 404 page. Lists active agents (address, name, role, operator address, live tokens, live runs, created, Archive button with `_back=/admin/agents`) and archived agents (read only). The tenant home shows an `agents` link to admins.

- [ ] **Step 1: Write the failing test**

`test/admin-agents.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const page = (host: string, token?: string) => SELF.fetch(`https://${host}/admin/agents`, { headers: token ? { cookie: `pmw_session=${token}` } : {} });

async function setup() {
  const acme = await seedTenant("acme");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, admin, op, s };
}

describe("/admin/agents", () => {
  it("shows every agent in the tenant to an admin, with operator and activity", async () => {
    const { admin, s } = await setup();
    const res = await page("acme.pimwell.test", admin.token);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("bot@acme.pimwell.test");
    expect(html).toContain("op@example.com");
    expect(html).toMatch(/<td>1<\/td><td>1<\/td>/);
    expect(html).toContain('action="/api/agent.archive"');
    expect(html).toContain(`name="agent_id" value="${s.agent.identity.id}"`);
    expect(html).toContain('name="_back" value="/admin/agents"');
    expect(html).not.toContain(s.longLived);
    expect(html).not.toContain(s.apiToken.token_hash);
  });

  it("is a 404 for members, anonymous callers, other tenants, and the apex", async () => {
    const { admin, op } = await setup();
    await seedTenant("blue");
    expect((await page("acme.pimwell.test", op.token)).status).toBe(404);
    expect((await page("acme.pimwell.test")).status).toBe(404);
    expect((await page("blue.pimwell.test", admin.token)).status).toBe(404);
    expect((await page("pimwell.test", admin.token)).status).toBe(404);
  });

  it("archives from the page and lists the agent as archived", async () => {
    const { admin, s } = await setup();
    const res = await SELF.fetch("https://acme.pimwell.test/api/agent.archive", {
      method: "POST", redirect: "manual",
      headers: { cookie: `pmw_session=${admin.token}`, origin: "https://acme.pimwell.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ agent_id: s.agent.identity.id, _back: "/admin/agents" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/agents");
    const html = await (await page("acme.pimwell.test", admin.token)).text();
    const archived = html.slice(html.indexOf("<h2>Archived</h2>"));
    expect(archived).toContain("bot@acme.pimwell.test");
    expect(html.slice(0, html.indexOf("<h2>Archived</h2>"))).not.toContain("bot@acme.pimwell.test");
  });

  it("links from the tenant home for admins only", async () => {
    const { admin, op } = await setup();
    const home = (token: string) => SELF.fetch("https://acme.pimwell.test/", { headers: { cookie: `pmw_session=${token}` } }).then((r) => r.text());
    expect(await home(admin.token)).toContain('href="/admin/agents"');
    expect(await home(op.token)).not.toContain('href="/admin/agents"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-agents.test.ts`
Expected: FAIL; `GET /admin/agents` returns 404 for the admin.

- [ ] **Step 3: Write the page**

`src/http/adminAgents.ts`:
```ts
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { listAgentsForTenant, tenantAgentActivity } from "../db/agents";
import { getIdentityById } from "../db/identities";
import { notFoundPage } from "./pages";
import type { Agent } from "../db/types";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export async function adminAgentsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.identity || ctx.identity.kind !== "human" || rank(ctx.role) < rank("admin")) return notFoundPage(extra);
  const tenant = ctx.tenant;
  const [active, archived, activity] = await Promise.all([
    listAgentsForTenant(ctx.db, tenant.id, "active"),
    listAgentsForTenant(ctx.db, tenant.id, "archived"),
    tenantAgentActivity(ctx.db, tenant.id, ctx.now),
  ]);
  const operatorIds = [...new Set([...active, ...archived].map((a) => a.identity.operator_id).filter((x): x is string => x !== null))];
  const operators = new Map<string, string>();
  for (const id of operatorIds) {
    const op = await getIdentityById(ctx.db, id);
    if (op) operators.set(id, op.email);
  }
  const opOf = (a: Agent) => esc(a.identity.operator_id ? operators.get(a.identity.operator_id) ?? "unknown" : "none");

  const activeRows = active.map((a) => {
    const act = activity.get(a.identity.id) ?? { tokens: 0, runs: 0 };
    return `<tr><td><code>${esc(a.identity.email)}</code></td><td>${esc(a.identity.display_name)}</td><td>${esc(a.membership.role)}</td><td>${opOf(a)}</td>`
      + `<td>${act.tokens}</td><td>${act.runs}</td><td>${when(a.identity.created_at)}</td>`
      + `<td><form class="inline" method="post" action="/api/agent.archive"><input type="hidden" name="agent_id" value="${esc(a.identity.id)}">`
      + `<input type="hidden" name="_back" value="/admin/agents"><button type="submit">Archive</button></form></td></tr>`;
  }).join("");
  const archivedRows = archived.map((a) =>
    `<tr><td><code>${esc(a.identity.email)}</code></td><td>${esc(a.identity.display_name)}</td><td>${opOf(a)}</td><td>${when(a.identity.created_at)}</td></tr>`).join("");

  const body = `<h1>${esc(tenant.display_name)} agents</h1><p><a href="/">back</a></p>`
    + (active.length
      ? `<table><thead><tr><th>Address</th><th>Name</th><th>Role</th><th>Operator</th><th>Tokens</th><th>Runs</th><th>Created</th><th></th></tr></thead><tbody>${activeRows}</tbody></table>`
      : "<p>None.</p>")
    + `<h2>Archived</h2>`
    + (archived.length
      ? `<table><thead><tr><th>Address</th><th>Name</th><th>Operator</th><th>Created</th></tr></thead><tbody>${archivedRows}</tbody></table>`
      : "<p>None.</p>");
  return htmlResponse(page("Agents", body), 200, extra);
}
```

- [ ] **Step 4: Route and link it**

In `src/index.ts` add `import { adminAgentsPage } from "./http/adminAgents";` and `app.get("/admin/agents", (c) => adminAgentsPage(c.req.raw, c.env));`.

In `src/http/pages.ts`, change the context import to `import { buildContext, rank } from "../auth/context";` and in `homePage`, replace the tenant `body` line
```ts
  const body = `<h1>${esc(ctx.tenant.display_name)}</h1><p>You are ${esc(ctx.role)} · <a href="/archive">archive</a> · <a href="https://${esc(env.HUB_DOMAIN)}/">hub</a></p>` + (await tenantListing(env, ctx.tenant.id, "active"));
```
with
```ts
  const agentsLink = rank(ctx.role) >= rank("admin") ? ` · <a href="/admin/agents">agents</a>` : "";
  const body = `<h1>${esc(ctx.tenant.display_name)}</h1><p>You are ${esc(ctx.role)} · <a href="/archive">archive</a>${agentsLink} · <a href="https://${esc(env.HUB_DOMAIN)}/">hub</a></p>` + (await tenantListing(env, ctx.tenant.id, "active"));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/admin-agents.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http/adminAgents.ts src/index.ts src/http/pages.ts test/admin-agents.test.ts
git commit -F - <<'EOF'
feat: tenant /admin/agents page with archive

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 9: Internal session introspection for Ardi

**Files:**
- Create: `src/http/internal.ts`
- Modify: `src/env.ts`, `vitest.config.ts`, `src/index.ts`
- Test: `test/introspect.test.ts`

**Interfaces:**
- Consumes: `credentialUsable`, `roleFor` (Task 2, phase 1); `getSessionByToken`; `getIdentityById`; `getTenantBySlug`; `getMembership`; `isValidTenantSlug`; `sha256Hex`, `timingSafeEqual`; `notFoundPage`; `seedAgent` (Task 1).
- Produces:
  - `Env.HUB_INTERNAL_SECRET?: string` (Wrangler secret; unset means the endpoint is closed).
  - `isInternalCall(request, env): Promise<boolean>`; `introspect(request, env, now?): Promise<Response>`; route `POST /internal/introspect`.
  - Contract: not internal → the 404 page. Internal → status 200 JSON, `{ ok: false }` or `{ ok: true, identity: { id, kind, display_name, email, operator_id }, session: { id, kind, label }, tenant: { slug }, role }`.

- [ ] **Step 1: Write the failing test**

`test/introspect.test.ts`:
```ts
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { introspect } from "../src/http/internal";
import { revokeSession } from "../src/db/sessions";
import { revokeApiToken } from "../src/db/apiTokens";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const SECRET = "test-internal-secret";
const req = (body: unknown, headers: Record<string, string> = { "x-hub-internal": SECRET }) =>
  new Request("https://hub.internal/internal/introspect", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const call = async (body: unknown, headers?: Record<string, string>) => {
  const res = await introspect(req(body, headers), env);
  return { status: res.status, text: await res.text() };
};

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const human = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const s = await seedAgent(acme, human.identity);
  return { acme, blue, human, s };
}

describe("internal introspection", () => {
  it("is a 404 without the right secret, without a configured secret, or from a public route", async () => {
    const { human } = await setup();
    const body = { token: human.token, tenant: "acme" };
    expect((await call(body, {})).status).toBe(404);
    expect((await call(body, { "x-hub-internal": "wrong" })).status).toBe(404);
    expect((await call(body, { "x-hub-internal": SECRET + "x" })).status).toBe(404);
    expect((await call(body, { "x-hub-internal": SECRET, "cf-connecting-ip": "198.51.100.7" })).status).toBe(404);
    const closed = await introspect(req(body), { ...env, HUB_INTERNAL_SECRET: undefined });
    expect(closed.status).toBe(404);
    const empty = await introspect(req(body, { "x-hub-internal": "" }), { ...env, HUB_INTERNAL_SECRET: "" });
    expect(empty.status).toBe(404);
  });

  it("describes a human browser session that is a member of the tenant, without echoing the token", async () => {
    const { human } = await setup();
    const r = await call({ token: human.token, tenant: "acme" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({
      ok: true,
      identity: { id: human.identity.id, kind: "human", display_name: "m", email: "m@example.com", operator_id: null },
      session: { id: human.session.id, kind: "browser", label: null },
      tenant: { slug: "acme" },
      role: "member",
    });
    expect(r.text).not.toContain(human.token);
  });

  it("gives roots their role on any tenant and refuses non-members", async () => {
    await setup();
    const root = await seedHuman("root@example.com", { is_root: true });
    const out = await seedHuman("out@example.com");
    expect(JSON.parse((await call({ token: root.token, tenant: "blue" })).text).role).toBe("root");
    expect(JSON.parse((await call({ token: out.token, tenant: "acme" })).text)).toEqual({ ok: false });
  });

  it("describes an agent run on its own tenant and refuses it elsewhere", async () => {
    const { human, s } = await setup();
    const ok = JSON.parse((await call({ token: s.token, tenant: "acme" })).text);
    expect(ok).toMatchObject({
      ok: true, identity: { id: s.agent.identity.id, kind: "agent", email: "bot@acme.pimwell.test", operator_id: human.identity.id },
      session: { id: s.session.id, kind: "agent_run", label: "run-1" }, tenant: { slug: "acme" }, role: "member",
    });
    expect(JSON.parse((await call({ token: s.token, tenant: "blue" })).text)).toEqual({ ok: false });
    expect(JSON.parse((await call({ token: s.longLived, tenant: "acme" })).text)).toEqual({ ok: false });
  });

  it("refuses revoked sessions, revoked parent tokens, and malformed input", async () => {
    const { human, s } = await setup();
    await revokeApiToken(env.HUB_DB, s.apiToken.id, Date.now());
    expect(JSON.parse((await call({ token: s.token, tenant: "acme" })).text)).toEqual({ ok: false });
    await revokeSession(env.HUB_DB, human.session.id, Date.now());
    expect(JSON.parse((await call({ token: human.token, tenant: "acme" })).text)).toEqual({ ok: false });
    for (const body of ["not json", [], {}, { token: 5, tenant: "acme" }, { token: "pms_x", tenant: "-bad-" }, { token: "pms_x", tenant: "www" }]) {
      const r = await call(body);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text)).toEqual({ ok: false });
    }
  });

  it("is routed for POST only", async () => {
    const { human } = await setup();
    const post = await worker.fetch!(req({ token: human.token, tenant: "acme" }) as never, env, createExecutionContext());
    expect(post.status).toBe(200);
    expect(((await post.json()) as any).ok).toBe(true);
    const get = await worker.fetch!(new Request("https://hub.internal/internal/introspect", { headers: { "x-hub-internal": SECRET } }) as never, env, createExecutionContext());
    expect(get.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/introspect.test.ts`
Expected: FAIL; `../src/http/internal` cannot be resolved.

- [ ] **Step 3: Configure the secret**

In `src/env.ts` add the field `HUB_INTERNAL_SECRET?: string;` to `Env`.

In `vitest.config.ts`, add `HUB_INTERNAL_SECRET: "test-internal-secret",` to `miniflare.bindings` after `HUB_BOOTSTRAP_TOKEN`.

- [ ] **Step 4: Write the endpoint**

`src/http/internal.ts`:
```ts
import type { Env } from "../env";
import { credentialUsable, roleFor } from "../auth/context";
import { getSessionByToken } from "../db/sessions";
import { getIdentityById } from "../db/identities";
import { getTenantBySlug } from "../db/tenants";
import { getMembership } from "../db/memberships";
import { isValidTenantSlug } from "../tenant";
import { sha256Hex, timingSafeEqual } from "../ids";
import { notFoundPage } from "./pages";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
const denied = () => json({ ok: false });

/**
 * Service-binding calls only. Bindings deliver whatever URL the caller wrote, so the host proves nothing;
 * the shared secret does, and a cf-connecting-ip header (always present on public routes) disqualifies.
 */
export async function isInternalCall(request: Request, env: Env): Promise<boolean> {
  const secret = env.HUB_INTERNAL_SECRET;
  const given = request.headers.get("x-hub-internal");
  if (!secret || !given) return false;
  if (request.headers.has("cf-connecting-ip")) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  return timingSafeEqual(await sha256Hex(given), await sha256Hex(secret));
}

export async function introspect(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  if (!(await isInternalCall(request, env))) return notFoundPage();
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return denied();
    input = parsed as Record<string, unknown>;
  } catch {
    return denied();
  }
  const token = typeof input.token === "string" ? input.token : "";
  const slug = typeof input.tenant === "string" ? input.tenant.trim().toLowerCase() : "";
  if (!token.startsWith("pms_") || token.length > 128 || !isValidTenantSlug(slug)) return denied();

  const db = env.HUB_DB;
  const [session, tenant] = await Promise.all([getSessionByToken(db, token, now), getTenantBySlug(db, slug)]);
  if (!session || !tenant || tenant.state !== "active") return denied();
  const identity = await getIdentityById(db, session.identity_id);
  if (!identity || !(await credentialUsable(db, identity, session, null, tenant))) return denied();
  const role = roleFor(identity, await getMembership(db, identity.id, tenant.id));
  if (!role) return denied();
  return json({
    ok: true,
    identity: { id: identity.id, kind: identity.kind, display_name: identity.display_name, email: identity.email, operator_id: identity.operator_id },
    session: { id: session.id, kind: session.kind, label: session.label },
    tenant: { slug: tenant.slug },
    role,
  });
}
```

- [ ] **Step 5: Route it**

In `src/index.ts` add `import { introspect } from "./http/internal";` and, before `app.notFound(...)`, `app.post("/internal/introspect", (c) => introspect(c.req.raw, c.env));`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/introspect.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/http/internal.ts src/env.ts vitest.config.ts src/index.ts test/introspect.test.ts
git commit -F - <<'EOF'
feat: internal session introspection over a service binding

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 10: Table-driven verb test and README

**Files:**
- Create: `test/verb-table.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `listVerbs`, `registerAllVerbs`; all verbs above; `seedAgent`, `seedHuman`, `seedTenant`, `apiPost`, `bearer`.
- Produces: one test file that pins every registered verb's declaration (scope, role, fresh proof, flags) to the spec 8.1 table as amended, and checks fresh-proof, role, long-lived-token, and human-only enforcement for every verb through HTTP (spec 11: "Every verb runs through the table-driven HTTP test that asserts role and fresh-proof enforcement").

- [ ] **Step 1: Write the test**

`test/verb-table.test.ts`:
```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listVerbs } from "../src/verbs/table";
import { registerAllVerbs } from "../src/verbs/index";
import { rank } from "../src/auth/context";
import type { Role } from "../src/db/types";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

beforeAll(() => registerAllVerbs());

type Decl = { scope: string; minRole: string; fresh: number | null; longLived?: true; humanOnly?: true };
const T = (scope: string, minRole: string, fresh: number | null, flags: Partial<Decl> = {}): Decl => ({ scope, minRole, fresh, ...flags });

const TABLE: Record<string, Decl> = {
  bootstrap: T("hub", "public", null),
  whoami: T("public", "public", null, { longLived: true }),
  "tenant.create": T("hub", "root", 60), "tenant.archive": T("hub", "root", 60), "tenant.unarchive": T("hub", "root", 60), "tenant.list": T("hub", "root", null),
  "namespace.create": T("tenant", "admin", 60), "namespace.archive": T("tenant", "admin", 60), "namespace.unarchive": T("tenant", "admin", 60),
  "project.create": T("tenant", "member", null), "project.archive": T("tenant", "admin", 60), "project.unarchive": T("tenant", "admin", 60), "project.list": T("tenant", "reader", null),
  "invite.create": T("tenant", "admin", 60), "invite.revoke": T("tenant", "admin", 60), "invite.list": T("tenant", "admin", null),
  "session.list": T("public", "public", null), "session.revoke": T("public", "public", null), "session.end": T("public", "public", null),
  "session.start": T("tenant", "reader", null, { longLived: true }),
  "login.request": T("hub", "public", null), "login.verify": T("hub", "public", null),
  "consent.list": T("public", "public", null), "consent.revoke": T("public", "public", null),
  "agent.create": T("public", "public", 60, { humanOnly: true }), "agent.archive": T("public", "public", 60, { humanOnly: true }),
  "token.create": T("public", "public", 60, { humanOnly: true }), "token.revoke": T("public", "public", 60, { humanOnly: true }),
  "token.list": T("public", "public", null, { humanOnly: true }),
};

const verbs = () => listVerbs().filter((v) => !v.name.startsWith("test."));
const hostFor = (scope: string) => (scope === "tenant" ? "acme.pimwell.test" : "pimwell.test");

describe("verb table", () => {
  it("declares every verb exactly as the table says", () => {
    expect(verbs().map((v) => v.name).sort()).toEqual(Object.keys(TABLE).sort());
    for (const v of verbs()) {
      const d = TABLE[v.name]!;
      const got: Decl = { scope: v.scope, minRole: v.minRole, fresh: v.freshProofMinutes };
      if (v.longLivedToken) got.longLived = true;
      if (v.humanOnly) got.humanOnly = true;
      expect({ name: v.name, ...got }).toEqual({ name: v.name, ...d });
      if (v.kind === "query") expect(v.freshProofMinutes).toBeNull();
    }
  });

  it("demands fresh proof from a stale browser session on every verb that declares it", async () => {
    await seedTenant("acme");
    const root = await seedHuman("root@example.com", { is_root: true });
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 601 * 60_000, root.session.id).run();
    for (const v of verbs().filter((x) => x.freshProofMinutes !== null)) {
      const res = await apiPost(hostFor(v.scope), v.name, {}, bearer(root.token));
      expect({ verb: v.name, status: res.status, error: ((await res.json()) as any).error }).toEqual({ verb: v.name, status: 403, error: "reproof_required" });
    }
  });

  it("enforces the minimum role on every role-gated verb", async () => {
    const acme = await seedTenant("acme");
    const reader = await seedHuman("r@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
    // A reader on acme (tenant verbs) or a non-root on the apex (hub verbs) is below every gate except reader-level ones.
    for (const v of verbs().filter((x) => x.minRole !== "public" && rank(x.minRole as Role) > rank("reader"))) {
      const res = await apiPost(hostFor(v.scope), v.name, {}, bearer(reader.token));
      expect({ verb: v.name, status: res.status, error: ((await res.json()) as any).error }).toEqual({ verb: v.name, status: 403, error: "forbidden" });
    }
  });

  it("refuses a long-lived token on every verb but session.start and whoami", async () => {
    const acme = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, op.identity);
    for (const v of verbs()) {
      const body = v.name === "session.start" ? { label: "x" } : {};
      const res = await apiPost("acme.pimwell.test", v.name, body, bearer(s.longLived));
      const expected = v.longLivedToken ? 200 : v.scope === "hub" ? 404 : 403;
      expect({ verb: v.name, status: res.status }).toEqual({ verb: v.name, status: expected });
    }
  });

  it("refuses agent runs on every human-only verb", async () => {
    const acme = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, op.identity);
    for (const v of verbs().filter((x) => x.humanOnly)) {
      const res = await apiPost("acme.pimwell.test", v.name, {}, bearer(s.token));
      expect({ verb: v.name, status: res.status }).toEqual({ verb: v.name, status: 403 });
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/verb-table.test.ts`
Expected: PASS once Tasks 1–9 are in. If the first case fails, a verb's declaration drifted from spec 8.1: fix the verb, not the table, unless the spec was amended.

- [ ] **Step 3: Update the README**

In `README.md`, in the verb table, add after the `consent.list, consent.revoke` row:
```markdown
| agent.create, agent.archive | any (`tenant` param on the apex) | humans: member for own agents, admin for any agent in the tenant | 60 min |
| token.create, token.revoke | any | humans: the agent's operator, or a tenant admin | 60 min |
| token.list | any | humans: operator, or tenant admin | |
| session.start | tenant | long-lived `pmw_` token only | |
```
Append at the end of the file:
````markdown
## Agents

An agent is an identity with the reserved address `<slug>@<tenant>.pimwell.com`, a membership in one tenant, and a human operator. Create agents and mint tokens on `https://pimwell.com/me` (the new token is shown once). Tenant admins see every agent at `https://<tenant>.pimwell.com/admin/agents`.

A run starts by trading the long-lived token for a run session on the agent's tenant host:

```sh
curl -s https://acme.pimwell.com/api/session.start \
  -H "authorization: Bearer $PMW_TOKEN" -H 'content-type: application/json' \
  -d '{"label":"nightly build","ttl":86400}'
```

Use the returned `pms_` token as the bearer for everything else in the run, always on `https://acme.pimwell.com`. On any other host the run is anonymous. The long-lived token itself may only call `session.start` and `whoami`.

Revoking a token ends every run it started. Archiving an agent revokes all its tokens and runs. An agent works only while its operator is an active member (or root) of its tenant; if the operator leaves, the agent stops until the membership is restored.

## Internal introspection (Ardi)

`POST /internal/introspect` turns a `pms_` session token into `{ok, identity, session, tenant, role}` for one tenant. It answers only service-binding calls that carry `x-hub-internal: <HUB_INTERNAL_SECRET>`; requests through the public routes (which always carry `cf-connecting-ip`) get 404.

```sh
openssl rand -base64 32 | npx wrangler secret put HUB_INTERNAL_SECRET
```

In the calling Worker's `wrangler.jsonc`, bind the hub and give it the same secret:

```jsonc
"services": [{ "binding": "HUB", "service": "pimwell-hub" }]
```

```ts
const res = await env.HUB.fetch("https://hub.internal/internal/introspect", {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-internal": env.HUB_INTERNAL_SECRET },
  body: JSON.stringify({ token, tenant: "acme" }),
});
```
````

- [ ] **Step 4: Run all tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/verb-table.test.ts README.md
git commit -F - <<'EOF'
test: table-driven verb declarations and enforcement; README agents and introspection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```
