# Ardi integration, hub side: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Ardi's git smart HTTP on `https://<tenant>.pimwell.com/<repo>.git` by forwarding to the `ardi` Worker, and give humans a copyable, tenant-pinned git credential (`session.git`) that only introspection accepts.

**Architecture:** A first Hono middleware matches top-level git paths on active tenant hosts and hands the request (minus the hub cookie) to the `ARDI` service binding; everything else is untouched. A new session kind `git` is minted by the human-only verb `session.git` and is usable only through `credentialUsable(..., "introspect")`, which `/internal/introspect` now passes.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-10-06-ardi-hub-integration.md` (sections 3, 4, 7); identity spec `docs/superpowers/specs/2026-10-06-identity-design.md`. The Ardi side is `docs/superpowers/plans/2026-10-06-hub-identity.md` in the Ardi repo; its deploy (Task 4 there) must happen before this plan's Task 4.

## Global Constraints

- No organization or person names in code, config, examples, or commits; example tenants are `acme` and `blue`.
- Never log tokens, cookies, or request bodies.
- Forwarded paths: `^/[A-Za-z0-9][A-Za-z0-9._-]*\.git/(?:info/refs|git-upload-pack|git-receive-pack)$` on the raw path, tenant hosts only, active tenants only; top-level repositories only in v1.
- The forwarded request is the original (method, URL, headers, streaming body) except the `cookie` header, which is removed.
- Unknown or archived tenant on a git path: the hub's ordinary 404, nothing forwarded. Missing `ARDI` binding: 503 `git service unavailable`.
- The hub does no git auth.
- `session.git`: `humanOnly`, fresh proof 60 minutes, scope `public`, minRole `public`, params `tenant` (optional slug, default the host's tenant) and `label` (1-80 chars), session kind `git`, `tenant_id` set, `parent_token_id` null, expiry exactly 90 days, never rolled, event `session.git`.
- A `git` session counts only with `credentialUsable(..., via = "introspect")`, for a human, on its own tenant, with no API token. Everywhere else it is anonymous.
- Reserved tenant labels gain `git` and `ardi`.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk`.
- Other agents commit in this worktree: `git add` only the files a task names; never stash, reset, or checkout.

## Review Focus

1. A `git` credential sent to the hub's own `/api` (bearer) or as the `pmw_session` cookie must be anonymous, not a signed-in human. Test: Task 1 (`are anonymous on the hub's own API`).
2. A `git` credential minted for `acme` and presented for `blue` (where the human is also a member) must be refused by introspection. Test: Task 1 (`introspect on their own tenant only`).
3. Lookalike paths (`/site.git/HEAD`, `/ns/site.git/info/refs`, `/site/info/refs`, `/site.git/info/refs/x`, percent-encoded names) and the apex or reserved hosts must stay with the hub. Test: Task 3 (`leaves other paths and hosts to the hub`).
4. An archived tenant's git URL must 404 at the hub, not reach Ardi. Test: Task 3 (`404s unknown and archived tenants`).
5. The hub session cookie on a git request (a browser opening the URL) must not reach Ardi. Test: Task 3 (`strips the hub cookie`).

## File Structure

```
src/db/types.ts           Session kind gains "git" (Task 1)
src/db/sessions.ts        GIT_SESSION_TTL_S, createGitSession (Task 1)
src/auth/context.ts       credentialUsable via "introspect"; git sessions only there (Task 1)
src/http/internal.ts      introspect passes "introspect", touches git sessions (Task 1)
src/verbs/session.ts      session.git (Task 2)
src/verbs/index.ts        registers session.git (Task 2)
src/http/me.ts            Git credentials section, session labels (Task 2)
src/tenant.ts             reserved labels git, ardi (Task 3)
src/env.ts                ARDI?: Fetcher (Task 3)
src/http/git.ts           isGitPath, forwardGit (Task 3)
src/index.ts              forwarding middleware (Task 3)
wrangler.jsonc            services ARDI -> ardi (Task 3)
vitest.config.ts          ARDI stub service binding (Task 3)
README.md                 session.git row, Git section, deploy and smoke (Tasks 2, 4)
test/git-session.test.ts  Tasks 1, 2
test/verb-table.test.ts   session.git row (Task 2)
test/git-forward.test.ts  Task 3
```

Existing names relied on (do not rename): `credentialUsable`, `buildContext`, `roleFor` (`src/auth/context.ts`); `requireHuman`, `targetTenant` (`src/auth/authority.ts`); `getSessionByToken`, `getSessionById`, `touchSession`, `revokeSession`, `listSessions` (`src/db/sessions.ts`); `getTenantBySlug`; `recordEvent`; `randomToken`, `sha256Hex`, `ulid` (`src/ids.ts`); `classifyHost`, `isValidTenantSlug`, `RESERVED_LABELS` (`src/tenant.ts`); `notFoundPage` (`src/http/pages.ts`); `defineVerb`, `registerVerbs`; `optString`, `reqString`; `badRequest`; `esc` (`src/html.ts`); test helpers `apiPost`, `bearer`, `cookieHeaders`, `seedHuman`, `seedTenant`, `seedAgent`. In tests `HUB_DOMAIN` is `pimwell.test` and `HUB_INTERNAL_SECRET` is `test-internal-secret`. Run from the worktree root: `npx vitest run <file>`, `npm test`, `npm run typecheck`.

Precondition: `credentialUsable` already takes `via: "http" | "mcp"` (MCP phase 1, Task 3). Check before Task 1:

```bash
grep -n 'via: "http" | "mcp" = "http"' src/auth/context.ts
```
Expected: one line. If absent, finish MCP phase 1 Task 3 first.

---

### Task 1: The `git` session kind, accepted only by introspection

**Files:**
- Modify: `src/db/types.ts` (the `Session` type)
- Modify: `src/db/sessions.ts` (append)
- Modify: `src/auth/context.ts` (`credentialUsable`)
- Modify: `src/http/internal.ts`
- Create: `test/git-session.test.ts`

**Interfaces:**
- Consumes: `credentialUsable(db, identity, session, apiToken, tenant, via)`; `touchSession(db, session, now)`.
- Produces: `GIT_SESSION_TTL_S: number` (7_776_000); `createGitSession(db: D1Database, input: { identity_id: string; tenant_id: string; label: string }, now: number): Promise<{ session: Session; token: string }>`; `credentialUsable(..., via: "http" | "mcp" | "introspect" = "http")`; `Session["kind"]` includes `"git"`.

- [ ] **Step 1: Write the failing test**

Create `test/git-session.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { introspect } from "../src/http/internal";
import { credentialUsable } from "../src/auth/context";
import { createGitSession, GIT_SESSION_TTL_S, getSessionById, revokeSession } from "../src/db/sessions";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const SECRET = "test-internal-secret";

async function introspectAs(token: string, tenant: string): Promise<any> {
  const res = await introspect(new Request("https://hub.internal/internal/introspect", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-internal": SECRET },
    body: JSON.stringify({ token, tenant }),
  }), env);
  return res.json();
}

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const human = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const git = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: acme.id, label: "laptop" }, Date.now());
  return { acme, blue, human, git };
}

describe("git sessions", () => {
  it("are pinned to one tenant, last 90 days, and have no parent token", async () => {
    const { acme, human, git } = await setup();
    expect(GIT_SESSION_TTL_S).toBe(90 * 86400);
    expect(git.token.startsWith("pms_")).toBe(true);
    const row = await getSessionById(env.HUB_DB, git.session.id);
    expect(row).toMatchObject({ kind: "git", identity_id: human.identity.id, tenant_id: acme.id, label: "laptop", parent_token_id: null, revoked_at: null });
    expect(row!.expires_at - row!.created_at).toBe(GIT_SESSION_TTL_S * 1000);
  });

  it("introspect on their own tenant only", async () => {
    const { human, git } = await setup();
    expect(await introspectAs(git.token, "acme")).toEqual({
      ok: true,
      identity: { id: human.identity.id, kind: "human", display_name: "m", email: "m@example.com", operator_id: null },
      session: { id: git.session.id, kind: "git", label: "laptop" },
      tenant: { slug: "acme" },
      role: "member",
    });
    expect(await introspectAs(git.token, "blue")).toEqual({ ok: false });
  });

  it("count only on the introspection path", async () => {
    const { acme, blue, human, git } = await setup();
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme, "introspect")).toBe(true);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, blue, "introspect")).toBe(false);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme)).toBe(false);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme, "mcp")).toBe(false);
    // Browser sessions keep introspecting, as before.
    expect(await credentialUsable(env.HUB_DB, human.identity, human.session, null, acme, "introspect")).toBe(true);
  });

  it("stop introspecting when the membership ends, the session expires, or it is revoked", async () => {
    const { acme, human, git } = await setup();
    const setMembership = (state: string) => env.HUB_DB.prepare("UPDATE membership SET state = ? WHERE identity_id = ? AND tenant_id = ?").bind(state, human.identity.id, acme.id).run();
    await setMembership("archived");
    expect(await introspectAs(git.token, "acme")).toEqual({ ok: false });
    await setMembership("active");
    expect((await introspectAs(git.token, "acme")).ok).toBe(true);
    await env.HUB_DB.prepare("UPDATE session SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, git.session.id).run();
    expect(await introspectAs(git.token, "acme")).toEqual({ ok: false });
    const other = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: acme.id, label: "desk" }, Date.now());
    expect((await introspectAs(other.token, "acme")).ok).toBe(true);
    await revokeSession(env.HUB_DB, other.session.id, Date.now());
    expect(await introspectAs(other.token, "acme")).toEqual({ ok: false });
  });

  it("record their last use without extending the expiry", async () => {
    const { git } = await setup();
    const before = Date.now() - 2 * 3600_000;
    await env.HUB_DB.prepare("UPDATE session SET last_seen_at = ? WHERE id = ?").bind(before, git.session.id).run();
    expect((await introspectAs(git.token, "acme")).ok).toBe(true);
    const row = await getSessionById(env.HUB_DB, git.session.id);
    expect(row!.last_seen_at).toBeGreaterThan(before);
    expect(row!.expires_at).toBe(git.session.expires_at);
  });

  it("are anonymous on the hub's own API, by bearer or cookie", async () => {
    const { git } = await setup();
    const byBearer = await apiPost("acme.pimwell.test", "whoami", {}, bearer(git.token));
    expect(await byBearer.json()).toEqual({ ok: true, result: { identity: null } });
    const byCookie = await apiPost("acme.pimwell.test", "whoami", {}, cookieHeaders(git.token, "acme.pimwell.test"));
    expect(await byCookie.json()).toEqual({ ok: true, result: { identity: null } });
    expect(byCookie.headers.get("set-cookie") ?? "").toContain("pmw_session=");
    expect((await apiPost("acme.pimwell.test", "session.list", {}, bearer(git.token))).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/git-session.test.ts`
Expected: FAIL; `createGitSession` and `GIT_SESSION_TTL_S` are not exported from `src/db/sessions`.

- [ ] **Step 3: Add the session kind and the constructor**

In `src/db/types.ts`, in the `Session` type, replace
`kind: "browser" | "agent_run" | "oauth";` with `kind: "browser" | "agent_run" | "oauth" | "git";`.

Append to `src/db/sessions.ts`:

```ts

export const GIT_SESSION_TTL_S = 90 * 24 * 3600;

/**
 * A human's git credential (integration spec 4): pinned to one tenant, a fixed 90-day expiry (never rolled),
 * no parent token, and usable only through introspection.
 */
export async function createGitSession(
  db: D1Database,
  input: { identity_id: string; tenant_id: string; label: string },
  now: number,
): Promise<{ session: Session; token: string }> {
  const token = randomToken("pms_");
  const session: Session = {
    id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, kind: "git", label: input.label,
    token_hash: await sha256Hex(token), created_at: now, last_seen_at: now, expires_at: now + GIT_SESSION_TTL_S * 1000,
    last_proof_at: now, revoked_at: null, parent_token_id: null,
  };
  await db.prepare(
    `INSERT INTO session (id, identity_id, tenant_id, kind, label, token_hash, created_at, last_seen_at, expires_at, last_proof_at, revoked_at, parent_token_id)
     VALUES (?, ?, ?, 'git', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(session.id, session.identity_id, session.tenant_id, session.label, session.token_hash, now, now, session.expires_at, now).run();
  return { session, token };
}
```

- [ ] **Step 4: Accept git sessions on the introspection path only**

In `src/auth/context.ts`, in `credentialUsable`:
- Replace `tenant: Tenant | null, via: "http" | "mcp" = "http",` with `tenant: Tenant | null, via: "http" | "mcp" | "introspect" = "http",`.
- Directly after the closing `}` of the `if (via === "mcp" || (session !== null && session.kind === "oauth")) { ... }` block, insert:

```ts
  // Git credentials (integration spec 4) count only for internal introspection, for their human, on their own tenant.
  if (session !== null && session.kind === "git") {
    return via === "introspect" && identity.kind === "human" && apiToken === null && tenant !== null && session.tenant_id === tenant.id;
  }
```
- In the doc comment above the function, add the line ` * Git sessions: only with via "introspect" (the Ardi service binding), pinned to their tenant.` before ` */`.

In `src/http/internal.ts`:
- Replace `import { getSessionByToken } from "../db/sessions";` with `import { getSessionByToken, touchSession } from "../db/sessions";`.
- Replace `if (!identity || !(await credentialUsable(db, identity, session, null, tenant))) return denied();` with
  `if (!identity || !(await credentialUsable(db, identity, session, null, tenant, "introspect"))) return denied();`.
- Replace `  if (!role) return denied();` with:

```ts
  if (!role) return denied();
  // Shows on /me when a git credential was last used; at most one write per hour, expiry unchanged.
  if (session.kind === "git") await touchSession(db, session, now);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/git-session.test.ts test/introspect.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean (if a `switch` over `Session["kind"]` elsewhere now reports a missing case, add `case "git":` beside `case "agent_run":` there).

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/types.ts src/db/sessions.ts src/auth/context.ts src/http/internal.ts test/git-session.test.ts
git commit -F - <<'EOF'
feat: git session kind, accepted only by internal introspection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 2: `session.git` and the Git credentials section on `/me`

**Files:**
- Modify: `src/verbs/session.ts`
- Modify: `src/verbs/index.ts`
- Modify: `src/http/me.ts`
- Modify: `test/verb-table.test.ts` (one `TABLE` row)
- Modify: `test/git-session.test.ts` (append)
- Modify: `README.md` (Verbs table row)

**Interfaces:**
- Consumes: `createGitSession` (Task 1); `requireHuman`, `targetTenant`; `recordEvent`.
- Produces: verb `session.git` with params `{ tenant?: string; label: string }` and result `GitCredential = { session_id: string; token: string; username: string; tenant: string; expires_at: number; clone_example: string }`; export `sessionGit`.

- [ ] **Step 1: Write the failing tests**

In `test/verb-table.test.ts`, after the line `  "session.start": T("tenant", "reader", null, { longLived: true }),` insert:

```ts
  "session.git": T("public", "public", 60, { humanOnly: true }),
```

In `test/git-session.test.ts`, replace the first line `import { env } from "cloudflare:test";` with `import { env, SELF } from "cloudflare:test";`, and replace `import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";` with `import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";`. Then append:

```ts
describe("session.git", () => {
  it("mints a tenant-pinned git credential for any member, shown once, with an event", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("g@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
    const res = await apiPost("pimwell.test", "session.git", { tenant: "acme", label: " laptop " }, bearer(h.token));
    expect(res.status).toBe(200);
    const r = ((await res.json()) as any).result;
    expect(r).toMatchObject({ username: "g@example.com", tenant: "acme", clone_example: "git clone https://acme.pimwell.test/<repo>.git" });
    expect(r.token.startsWith("pms_")).toBe(true);
    expect(await getSessionById(env.HUB_DB, r.session_id)).toMatchObject({ kind: "git", identity_id: h.identity.id, tenant_id: acme.id, label: "laptop", expires_at: r.expires_at });
    expect((await introspectAs(r.token, "acme")).role).toBe("reader");
    const ev = await env.HUB_DB.prepare("SELECT kind, tenant_id, identity_id, session_id FROM event WHERE kind = 'session.git' AND target_id = ?").bind(r.session_id).first();
    expect(ev).toEqual({ kind: "session.git", tenant_id: acme.id, identity_id: h.identity.id, session_id: h.session.id });
  });

  it("defaults the tenant to the host and 404s tenants the caller is not in", async () => {
    const acme = await seedTenant("acme");
    await seedTenant("cold");
    const h = await seedHuman("g@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const here = ((await (await apiPost("acme.pimwell.test", "session.git", { label: "desk" }, bearer(h.token))).json()) as any).result;
    expect(here.tenant).toBe("acme");
    for (const tenant of ["cold", "nosuch"]) {
      const res = await apiPost("pimwell.test", "session.git", { tenant, label: "x" }, bearer(h.token));
      expect({ tenant, status: res.status, error: ((await res.json()) as any).error }).toEqual({ tenant, status: 404, error: "not_found" });
    }
    const none = await apiPost("pimwell.test", "session.git", { label: "x" }, bearer(h.token));
    expect(none.status).toBe(400);
  });

  it("refuses agents, anonymous callers, a blank label, and a stale proof", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("g@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, h.identity);
    expect((await apiPost("acme.pimwell.test", "session.git", { label: "x" }, bearer(s.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "session.git", { label: "x" })).status).toBe(401);
    expect((await apiPost("acme.pimwell.test", "session.git", { label: "   " }, bearer(h.token))).status).toBe(400);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, h.session.id).run();
    const stale = await apiPost("acme.pimwell.test", "session.git", { label: "x" }, bearer(h.token));
    expect(((await stale.json()) as any).error).toBe("reproof_required");
  });

  it("is minted from the /me form, shown once, and listed with its label", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("g@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const me = await SELF.fetch("https://pimwell.test/me", { headers: cookieHeaders(h.token, "pimwell.test") });
    const page = await me.text();
    expect(page).toContain(`action="/api/session.git"`);
    expect(page).toContain(`name="tenant" value="acme"`);
    const form = await SELF.fetch("https://pimwell.test/api/session.git", {
      method: "POST",
      headers: { ...cookieHeaders(h.token, "pimwell.test"), "content-type": "application/x-www-form-urlencoded" },
      body: "tenant=acme&label=laptop",
    });
    expect(form.status).toBe(200);
    const shown = await form.text();
    expect(shown).toMatch(/pms_[A-Za-z0-9_-]{43}/);
    expect(shown).toContain("git clone https://acme.pimwell.test/&lt;repo&gt;.git");
    expect(shown).toContain("g@example.com");
    const after = await (await SELF.fetch("https://pimwell.test/me", { headers: cookieHeaders(h.token, "pimwell.test") })).text();
    expect(after).toContain("git (laptop)");
    expect(after).not.toMatch(/pms_[A-Za-z0-9_-]{43}/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/git-session.test.ts test/verb-table.test.ts`
Expected: FAIL; `session.git` is an unknown verb (404 `unknown_verb`) and the verb table lacks it.

- [ ] **Step 3: Write the verb**

In `src/verbs/session.ts`:
- Replace `import { optInt, reqString } from "./params";` with `import { optInt, optString, reqString } from "./params";`.
- Replace the `../db/sessions` import with:

```ts
import {
  AGENT_SESSION_DEFAULT_TTL_S, AGENT_SESSION_MAX_TTL_S, createAgentSession, createGitSession, getSessionById, listSessions, revokeSession,
} from "../db/sessions";
```
- Replace `import { roleIn } from "../auth/authority";` with `import { requireHuman, roleIn, targetTenant } from "../auth/authority";`.
- After the existing imports add `import { esc } from "../html";`.
- Append:

```ts

type GitCredential = { session_id: string; token: string; username: string; tenant: string; expires_at: number; clone_example: string };

export const sessionGit = defineVerb({
  name: "session.git", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Mint a git credential: a pms_ token for one tenant's git host, valid 90 days, usable nowhere else. Shown once.",
  parse: (i) => ({ tenant: optString(i, "tenant", { max: 63 }), label: reqString(i, "label", { max: 80 }).trim() }),
  run: async (ctx, p): Promise<GitCredential> => {
    const { identity, session } = requireHuman(ctx);
    if (!p.label) throw badRequest("label is required");
    const { tenant } = await targetTenant(ctx, p.tenant);
    const git = await createGitSession(ctx.db, { identity_id: identity.id, tenant_id: tenant.id, label: p.label }, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: tenant.id, identity_id: identity.id, session_id: session.id, kind: "session.git", target_kind: "session", target_id: git.session.id,
      summary: `Created git credential "${p.label}"`,
    }, ctx.now);
    return {
      session_id: git.session.id, token: git.token, username: identity.email, tenant: tenant.slug, expires_at: git.session.expires_at,
      clone_example: `git clone https://${tenant.slug}.${ctx.env.HUB_DOMAIN.toLowerCase()}/<repo>.git`,
    };
  },
  renderForm: (r: GitCredential) => `<h1>New git credential for ${esc(r.tenant)}</h1>
<p>Copy the password now: it will not be shown again. It works only for git on ${esc(r.tenant)} and expires in 90 days.</p>
<p>Username: <code>${esc(r.username)}</code></p>
<p>Password:</p>
<pre>${esc(r.token)}</pre>
<p>Try it: <code>${esc(r.clone_example)}</code>. Revoke it under Sessions on <a href="/me">your account</a>.</p>`,
});
```

`badRequest` is already imported in this file (`import { badRequest, forbidden, notFound, unauthorized } from "../errors";`).

In `src/verbs/index.ts`:
- Replace `import { sessionEnd, sessionList, sessionRevoke, sessionStart } from "./session";` with `import { sessionEnd, sessionGit, sessionList, sessionRevoke, sessionStart } from "./session";`.
- Replace `    sessionList, sessionRevoke, sessionEnd, sessionStart,` with `    sessionList, sessionRevoke, sessionEnd, sessionStart, sessionGit,`.

- [ ] **Step 4: Add the `/me` section**

In `src/http/me.ts`:
- In the Sessions table row, replace `esc(s.kind), when(s.created_at), when(s.last_seen_at),` with
  `esc(s.kind) + (s.kind === "git" && s.label ? ` (${esc(s.label)})` : ""), when(s.created_at), when(s.last_seen_at),`.
- Directly after the statement that ends with ``+ `<form method="post" action="/api/session.end"><button type="submit">Sign out</button></form>`;`` insert:

```ts

  const gitTenants = me.is_root === 1 ? (await listTenants(ctx.db, "active")).map((t) => t.slug) : memberships.map((m) => m.tenant.slug);
  body += `<h2>Git credentials</h2><p>A password for <code>git clone https://&lt;tenant&gt;.${esc(env.HUB_DOMAIN)}/&lt;repo&gt;.git</code>, with your email as the username. It works only for git on that tenant, lasts 90 days, and is listed under Sessions as <code>git</code>.</p>`
    + (gitTenants.length === 0 ? "<p>You are not a member of any tenant.</p>" : gitTenants.map((slug) =>
      `<form method="post" action="/api/session.git"><input type="hidden" name="tenant" value="${esc(slug)}">`
      + `<label>Label <input name="label" required maxlength="80" placeholder="laptop"></label> `
      + `<button type="submit">New git credential for ${esc(slug)}</button></form>`).join(""));
```

`listMembershipsForIdentity` returns only active memberships in active tenants, as `{ membership, tenant }` pairs; `listTenants` is already imported.

- [ ] **Step 5: Add the README verb row**

In `README.md`, in the Verbs table, after the row `| session.start | tenant | long-lived `pmw_` token only | |` add:

```markdown
| session.git (`label`, `tenant` on the apex) | any | humans: any role in the tenant | 60 min |
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/git-session.test.ts test/verb-table.test.ts test/me-page.test.ts && npm test && npm run typecheck`
Expected: PASS. If `test/verb-table.test.ts`'s `listVerbs` check reports `session.git` as an MCP violation, the verb has no `mcp` declaration and must not get one (credential verbs are banned from MCP).

- [ ] **Step 7: Commit**

```bash
git add src/verbs/session.ts src/verbs/index.ts src/http/me.ts test/verb-table.test.ts test/git-session.test.ts README.md
git commit -F - <<'EOF'
feat: session.git mints tenant-pinned git credentials, from the API and /me

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 3: Forward git smart HTTP on tenant hosts to Ardi

**Files:**
- Create: `src/http/git.ts`
- Modify: `src/index.ts`, `src/env.ts`, `src/tenant.ts`, `wrangler.jsonc`, `vitest.config.ts`
- Create: `test/git-forward.test.ts`

**Interfaces:**
- Consumes: `classifyHost`, `getTenantBySlug`, `notFoundPage`.
- Produces: `isGitPath(pathname: string): boolean`; `forwardGit(request: Request, env: Env): Promise<Response | null>` (null: the hub serves it); `Env.ARDI?: Fetcher`.

- [ ] **Step 1: Add the binding and the test stub**

In `wrangler.jsonc`, after the `"send_email"` line add:

```jsonc
  // Git smart HTTP on tenant hosts goes to Ardi (docs/superpowers/specs/2026-10-06-ardi-hub-integration.md).
  "services": [{ "binding": "ARDI", "service": "ardi" }],
```

In `src/env.ts`, after `HUB_INTERNAL_SECRET?: string;` add:

```ts
  /** The Ardi git host (service binding); absent means git URLs answer 503. */
  ARDI?: Fetcher;
```

In `vitest.config.ts`, inside `miniflare: { ... }`, after the `bindings: { ... },` entry add:

```ts
            // Stands in for the Ardi Worker: echoes what reached it, so tests can check the forward.
            serviceBindings: {
              async ARDI(request: Request) {
                const body = request.body ? await request.text() : "";
                return Response.json({
                  method: request.method, url: request.url, authorization: request.headers.get("authorization"),
                  cookie: request.headers.get("cookie"), gitProtocol: request.headers.get("git-protocol"),
                  contentType: request.headers.get("content-type"), body,
                }, { headers: { "x-ardi-stub": "1" } });
              },
            },
```

- [ ] **Step 2: Write the failing test**

Create `test/git-forward.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { forwardGit, isGitPath } from "../src/http/git";
import { isValidTenantSlug } from "../src/tenant";
import { seedTenant } from "./helpers";

const forwarded = (res: Response) => res.headers.get("x-ardi-stub") === "1";

describe("git forwarding to Ardi", () => {
  it("forwards info/refs on an active tenant host unchanged", async () => {
    await seedTenant("acme");
    const res = await SELF.fetch("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack", {
      headers: { authorization: "Basic eDpwbXNfeA==", "git-protocol": "version=2" },
    });
    expect(res.status).toBe(200);
    expect(forwarded(res)).toBe(true);
    expect(await res.json()).toMatchObject({
      method: "GET", url: "https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack",
      authorization: "Basic eDpwbXNfeA==", gitProtocol: "version=2", cookie: null, body: "",
    });
  });

  it("streams upload-pack and receive-pack bodies through", async () => {
    await seedTenant("acme");
    for (const [op, type] of [["git-upload-pack", "application/x-git-upload-pack-request"], ["git-receive-pack", "application/x-git-receive-pack-request"]]) {
      const res = await SELF.fetch(`https://acme.pimwell.test/site.git/${op}`, {
        method: "POST", headers: { "content-type": type }, body: new TextEncoder().encode("0014command=ls-refs\n0000"),
      });
      expect(forwarded(res)).toBe(true);
      expect(await res.json()).toMatchObject({ method: "POST", url: `https://acme.pimwell.test/site.git/${op}`, contentType: type, body: "0014command=ls-refs\n0000" });
    }
  });

  it("strips the hub cookie", async () => {
    await seedTenant("acme");
    const res = await SELF.fetch("https://acme.pimwell.test/site.git/info/refs?service=git-receive-pack", { headers: { cookie: "pmw_session=pms_abc; other=1" } });
    expect(forwarded(res)).toBe(true);
    expect(((await res.json()) as any).cookie).toBeNull();
  });

  it("404s unknown and archived tenants without forwarding", async () => {
    const unknown = await SELF.fetch("https://nosuch.pimwell.test/site.git/info/refs?service=git-upload-pack");
    expect(unknown.status).toBe(404);
    expect(forwarded(unknown)).toBe(false);
    const acme = await seedTenant("acme");
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(acme.id).run();
    const archived = await SELF.fetch("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack");
    expect(archived.status).toBe(404);
    expect(forwarded(archived)).toBe(false);
  });

  it("leaves other paths and hosts to the hub", async () => {
    await seedTenant("acme");
    for (const path of ["/", "/site.git", "/site.git/HEAD", "/site.git/info/refs/x", "/ns/site.git/info/refs", "/site/info/refs", "/.git/info/refs", "/%73ite.git/info/refs", "/me"]) {
      const res = await SELF.fetch(`https://acme.pimwell.test${path}`);
      expect({ path, forwarded: forwarded(res) }).toEqual({ path, forwarded: false });
    }
    for (const host of ["pimwell.test", "www.pimwell.test", "git.pimwell.test"]) {
      const res = await SELF.fetch(`https://${host}/site.git/info/refs`);
      expect({ host, status: res.status, forwarded: forwarded(res) }).toEqual({ host, status: 404, forwarded: false });
    }
    const healthz = await SELF.fetch("https://acme.pimwell.test/healthz");
    expect(await healthz.text()).toBe("ok");
  });

  it("matches only top-level .git smart-HTTP paths", () => {
    for (const p of ["/site.git/info/refs", "/a.b_c-d.git/git-upload-pack", "/Site9.git/git-receive-pack"]) expect({ p, ok: isGitPath(p) }).toEqual({ p, ok: true });
    for (const p of ["/site/info/refs", "/a/b.git/info/refs", "/site.git/info/refs/", "/-x.git/info/refs", "/site.git/objects/info/packs", "/site.git"]) expect({ p, ok: isGitPath(p) }).toEqual({ p, ok: false });
  });

  it("answers 503 when the ARDI binding is missing", async () => {
    await seedTenant("acme");
    const res = await forwardGit(new Request("https://acme.pimwell.test/site.git/info/refs"), { ...env, ARDI: undefined });
    expect(res!.status).toBe(503);
    expect(await res!.text()).toBe("git service unavailable\n");
  });

  it("reserves git and ardi as tenant labels", () => {
    expect(isValidTenantSlug("git")).toBe(false);
    expect(isValidTenantSlug("ardi")).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/git-forward.test.ts`
Expected: FAIL; `../src/http/git` does not exist.

- [ ] **Step 4: Write the forwarder and reserve the labels**

Create `src/http/git.ts`:

```ts
import type { Env } from "../env";
import { classifyHost } from "../tenant";
import { getTenantBySlug } from "../db/tenants";
import { notFoundPage } from "./pages";

/**
 * Git smart HTTP for one top-level repository, on the raw (undecoded) path (integration spec 3). Nested
 * `<namespace>/<repo>.git` waits until Ardi serves nested names; `.git` is required so no hub page is captured.
 */
const GIT_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

export function isGitPath(pathname: string): boolean {
  return GIT_PATH.test(pathname);
}

/**
 * Ardi's response to a git request on an active tenant host, the hub's 404 for an unknown or archived tenant,
 * or null when the hub serves the request itself. The hub does no git auth; Ardi challenges.
 */
export async function forwardGit(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isGitPath(url.pathname)) return null;
  const host = classifyHost(request.headers.get("host") ?? url.host, env.HUB_DOMAIN);
  if (host.kind !== "tenant") return null;
  const tenant = await getTenantBySlug(env.HUB_DB, host.slug);
  if (!tenant || tenant.state !== "active") return notFoundPage();
  if (!env.ARDI) return new Response("git service unavailable\n", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  // The original request, except the hub-wide session cookie, which Ardi never needs.
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return env.ARDI.fetch(new Request(request, { headers }));
}
```

In `src/index.ts`:
- After `import { introspect } from "./http/internal";` add `import { forwardGit } from "./http/git";`.
- Directly after `const app = new Hono<{ Bindings: Env }>();` insert:

```ts

// Git smart HTTP on tenant hosts belongs to Ardi (integration spec 3); everything else stays here.
app.use("*", async (c, next) => {
  const forwarded = await forwardGit(c.req.raw, c.env);
  if (forwarded) return forwarded;
  await next();
});
```

In `src/tenant.ts`, replace `"www", "mail", "mx", "api", "mcp", "login", "signup", "admin", "root", "static", "cdn",` with
`"www", "mail", "mx", "api", "mcp", "login", "signup", "admin", "root", "static", "cdn", "git", "ardi",`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/git-forward.test.ts test/tenant.test.ts test/index.test.ts && npm test && npm run typecheck`
Expected: PASS. If the pool fails at startup with a message that service `ardi` cannot be found, the `serviceBindings.ARDI` override from Step 1 is not inside `poolOptions.workers.miniflare`; move it there.

- [ ] **Step 6: Commit**

```bash
git add src/http/git.ts src/index.ts src/env.ts src/tenant.ts wrangler.jsonc vitest.config.ts test/git-forward.test.ts
git commit -F - <<'EOF'
feat: forward git smart HTTP on tenant hosts to Ardi; reserve git and ardi labels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 4: README, deploy, and the end-to-end smoke against `blue`

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1-3; the deployed `ardi` Worker with `HUB` bound and `HUB_INTERNAL_SECRET` set (Ardi plan Task 4, Steps 1-6).
- Produces: a deployed hub that serves `https://blue.pimwell.com/smoke.git`.

- [ ] **Step 1: Write the README section**

In `README.md`, after the `## Internal introspection (Ardi)` section's last code block, append:

````markdown

## Git (Ardi)

Repositories live in the Ardi Worker; the hub forwards git traffic on tenant hosts to it over the `ARDI`
service binding (`wrangler.jsonc`). Design: `docs/superpowers/specs/2026-10-06-ardi-hub-integration.md`.

```sh
git clone https://acme.pimwell.com/site.git
# Username: your email (any username works; the password decides who you are)
# Password: a git credential from https://pimwell.com/me, or an agent's run token
```

- Humans: on `/me`, "Git credentials", pick the tenant and a label. The `pms_` password is shown once,
  works only for git on that tenant, lasts 90 days, and is revoked under Sessions (kind `git`). From the
  terminal: `POST /api/session.git` with `{"tenant":"acme","label":"laptop"}` (fresh proof, 60 min).
- Agents: the run token from `session.start` is the password; the agent's address is a fine username.
- Store it with a credential helper (`git config --global credential.helper osxkeychain`, or `store`).
- Roles: root and admin may do everything (Ardi `admin`), members read and push (`write`), readers fetch.
- Revoking a credential reaches Ardi within 30 seconds (Ardi caches introspection answers).
- Only top-level repositories (`/<repo>.git`). Ardi's `/api/<verb>` is not served on tenant hosts
  (`/api/` is the hub's); create repositories on Ardi's workers.dev URL:
  `curl -u you@example.com:pms_... -X POST https://ardi.<subdomain>.workers.dev/t/acme/api/repo.create -d '{"name":"site"}'`
  (needs root or tenant admin).
- `git`, `ardi`, and every other reserved label are never tenants. Unknown or archived tenants answer 404.

Deploy order: Ardi first (it binds `pimwell-hub`, and the hub's `ARDI` binding needs the `ardi` Worker
to exist), then the hub. Both hold the same `HUB_INTERNAL_SECRET`.
````

- [ ] **Step 2: Verify and commit the README**

Run: `npm test && npm run typecheck`
Expected: PASS.

```bash
git add README.md
git commit -F - <<'EOF'
docs: README git section, credentials, and deploy order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

- [ ] **Step 3: Confirm the prerequisites**

Run: `npx wrangler deployments list --name ardi | head -5`
Expected: at least one deployment created after the Ardi plan's Task 4 (the Ardi side is live with `HUB` bound).

Run: `grep -n 'oauth-kv-pending-deploy' wrangler.jsonc`
Expected: no output. If the placeholder KV id is still there, finish MCP phase 1 Task 10's KV step first; `wrangler deploy` rejects it.

- [ ] **Step 4: Deploy the hub**

Run: `npm run deploy`
Expected: success, with `env.ARDI (ardi)` listed among the bindings.

- [ ] **Step 5: Mint a git credential on `blue`**

In a browser signed in as a root or `blue` admin, open `https://pimwell.com/me`, use "New git credential for blue" with label `smoke`, and copy the password into the shell:

```sh
export PMS='<the pms_ password shown once>'
```

(From the terminal instead: `curl -s -X POST https://pimwell.com/api/session.git -H 'content-type: application/json' -H 'origin: https://pimwell.com' -b 'pmw_session=<cookie value>' -d '{"tenant":"blue","label":"smoke"}'` and take `result.token`.)

- [ ] **Step 6: Smoke the git path end to end**

```sh
AUTH="Authorization: Basic $(printf 'you@example.com:%s' "$PMS" | base64)"
git -c credential.helper= -c http.extraHeader="$AUTH" ls-remote https://blue.pimwell.com/smoke.git; echo "exit $?"
git -c credential.helper= -c http.extraHeader="Authorization: Basic $(printf 'x:pms_wrong' | base64)" ls-remote https://blue.pimwell.com/smoke.git; echo "exit $?"
curl -s -o /dev/null -w '%{http_code}\n' 'https://nosuch.pimwell.com/smoke.git/info/refs?service=git-upload-pack'
curl -s -o /dev/null -w '%{http_code}\n' https://pimwell.com/healthz
```
Expected: the first prints nothing (or the refs, if the Ardi smoke already pushed) and `exit 0`; the second prints an authentication failure and a non-zero exit; then `404` (unknown tenant, not forwarded), then `200` (hub pages unaffected). The `smoke` repository was created in the Ardi plan, Task 4.

- [ ] **Step 7: Push and check attribution**

```sh
tmp=$(mktemp -d) && cd "$tmp" && git init -q -b main && echo hello > README && git add README \
  && git -c user.name=smoke -c user.email=smoke@example.com commit -q -m smoke \
  && git -c credential.helper= -c http.extraHeader="$AUTH" push https://blue.pimwell.com/smoke.git main; echo "exit $?"
curl -s -u "x:$PMS" -X POST "$ARDI_URL/t/blue/api/whoami" -H 'content-type: application/json' -d '{}'
```
Expected: the push reports `main -> main` and `exit 0` (or `! [rejected]` if the Ardi smoke pushed a different `main` first; then push to `refs/heads/smoke-hub` instead). `whoami` returns `principal` equal to your hub identity id and `session` equal to the git credential's session id (both shown on `/me`). Then:

```sh
curl -s -u "x:$PMS" -X POST "$ARDI_URL/t/blue/api/timeline" -H 'content-type: application/json' -d "{\"repo\":\"smoke\",\"principal\":\"<your hub identity id>\"}"
```
Expected: `"ok":true` with at least one event naming that principal and the git session id. `$ARDI_URL` is the workers.dev URL printed by the Ardi deploy.

- [ ] **Step 8: Revoke and confirm**

On `/me`, revoke the `git (smoke)` session. Wait 31 seconds, then rerun the first `ls-remote` from Step 6.
Expected: authentication failure.

---

## Self-Review

**Spec coverage:** spec 3 forwarding (paths, top-level only, active tenants, unchanged request minus cookie, 404, 503, middleware, reserved labels): Task 3. Spec 4 `session.git` (human-only, fresh proof, tenant pinned, 90 days, event, `/me`, introspection only, touch): Tasks 1 and 2. Spec 7 deploy order and smoke: Task 4, after the Ardi plan's Task 4. README clone instructions: Task 4.

**Placeholder scan:** none; the only values supplied at run time are the operator's own token, cookie, hub identity id, and the workers.dev URL printed by the Ardi deploy.

**Type consistency:** `createGitSession`/`GIT_SESSION_TTL_S` (Task 1) are what Task 2 imports; `via: "introspect"` is used in Task 1's code and tests; `forwardGit`/`isGitPath` (Task 3) match the test imports; `GitCredential` fields match the test's assertions and `renderForm`.

**Review Focus:** each of the five lines has a named test in Tasks 1 and 3.
