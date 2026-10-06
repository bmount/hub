# Pimwell Identity Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Cloudflare Worker at `pimwell.com` and `*.pimwell.com` with the D1 schema, bootstrap of the first root, invite links that create identities and memberships, long-lived browser sessions, `whoami`, and tenant, namespace, and project objects with archive state.

**Architecture:** One TypeScript Worker. Every request is classified by host (apex or tenant), the session cookie or bearer token is resolved to an identity and role, and a verb table drives `POST /api/<verb>` with role and fresh-proof enforcement in one dispatcher. Repository modules wrap D1 with plain SQL. HTML pages are small server-rendered strings.

**Tech Stack:** TypeScript, Wrangler 4, Hono 4 (routing and cookies only), D1, Workers KV (reserved, unused in phase 1), Vitest with `@cloudflare/vitest-pool-workers`, WebCrypto.

**Spec:** `docs/superpowers/specs/2026-10-06-identity-design.md`

## Global Constraints

- No organization, department, or person names in code, config, examples, hostnames, or commits. Example tenants are `acme` and `blue` (spec section 3).
- Logs never contain tokens or email bodies (spec section 3).
- Tokens, links, and session cookies are 256-bit random values stored as SHA-256 hex (spec section 10).
- Ids are 26-character ULIDs; timestamps are integer milliseconds UTC (spec section 7).
- Every tenant-scoped query filters on `tenant_id` (spec section 7).
- Unknown, archived, or non-member tenants return 404 without distinguishing (spec section 5).
- Single-use links are consumed on POST, never GET (spec section 6.1).
- State-changing cookie-authenticated requests must be POST with a matching `Origin` (spec section 6.6).
- Browser sessions: rolling 180 days from `last_seen_at`, refreshed at most hourly, absolute cap 365 days (spec section 6.6).
- Fresh proof: 60 minutes for admin changes and token or agent verbs; enforced from the verb table, not per handler (spec section 6.7).
- Every write records an `event` row with identity and session (spec section 4.7).
- Plain SQL only: no SQLite-specific syntax beyond what Postgres also accepts, except the partial unique indexes noted in Task 2 which both support.
- Commit after every task. Never leave work uncommitted at the end of a turn.

## Review Focus

1. A `Host` header with uppercase letters or a port (`Acme.pimwell.com:443`) must still resolve to tenant `acme`. Test added in Task 5.
2. Posting an already-accepted invite link a second time, including two concurrent POSTs, must create exactly one session and show the neutral page to the loser. Test added in Task 7 and Task 13.
3. An invite for an email that already has an identity must add a membership and must not create a second identity or overwrite the display name. Test added in Task 7.
4. A top-level project whose slug matches an existing namespace slug in the same tenant, or the reverse, must be rejected with 409. Test added in Task 6.
5. A request carrying a cookie for a revoked or expired session must be treated as anonymous and must clear the cookie. Test added in Task 9.

---

## File Structure

```
package.json                 scripts and dependencies
tsconfig.json
wrangler.jsonc               worker name, routes, D1 and KV bindings, vars
vitest.config.ts             workers pool, migrations injected as TEST_MIGRATIONS
.dev.vars.example            HUB_DOMAIN=localhost, HUB_BOOTSTRAP_TOKEN=dev
migrations/0001_init.sql     full schema from spec section 7
src/index.ts                 Hono app: routes to api dispatcher and pages
src/env.ts                   Env binding types
src/errors.ts                HubError(status, reason, detail)
src/ids.ts                   ulid, randomToken, sha256Hex, timingSafeEqual
src/html.ts                  esc, page, htmlResponse
src/tenant.ts                host classification, slug rules, reserved labels
src/db/types.ts              row types
src/db/tenants.ts            tenant CRUD and state
src/db/namespaces.ts         namespace CRUD, archive cascade
src/db/projects.ts           project CRUD, path lookup, slug collision rule
src/db/events.ts             recordEvent, listEvents
src/db/identities.ts         identity create and lookup, rootExists
src/db/memberships.ts        membership add, lookup, lists
src/db/invites.ts            invite create, find by token, accept, revoke
src/db/sessions.ts           browser session create, lookup, touch, revoke
src/auth/cookie.ts           session cookie read, set, clear
src/auth/context.ts          buildContext: host, tenant, identity, session, role
src/verbs/table.ts           VerbDef, registry, role ranks
src/verbs/params.ts          tiny param validators
src/verbs/bootstrap.ts
src/verbs/whoami.ts
src/verbs/tenant.ts
src/verbs/namespace.ts
src/verbs/project.ts
src/verbs/invite.ts
src/verbs/session.ts
src/verbs/index.ts           registers all verbs
src/http/api.ts              POST /api/<verb> dispatcher
src/http/pages.ts            invite, apex home, tenant home, sessions, 404
test/apply-migrations.ts     setup file
test/env.d.ts                ProvidedEnv typing
test/helpers.ts              seedTenant, seedRoot, acceptFreshInvite, apiPost
test/*.test.ts               one file per module
README.md                    local dev, test, deploy
```

Interfaces are declared in each task. Later tasks consume only the names listed under **Produces** in earlier tasks.

---

### Task 1: Project scaffold and a passing Worker test

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.dev.vars.example`, `.gitignore`, `src/env.ts`, `src/index.ts`, `test/env.d.ts`, `test/apply-migrations.ts`, `test/index.test.ts`
- Create: `migrations/.gitkeep`

**Interfaces:**
- Produces: `Env` type in `src/env.ts` with `HUB_DB: D1Database`, `RATE: KVNamespace`, `HUB_DOMAIN: string`, `HUB_BOOTSTRAP_TOKEN: string`. `app` default export from `src/index.ts` (Hono app with `fetch`).

- [ ] **Step 1: Write package.json, tsconfig, wrangler config, gitignore**

`package.json`:
```json
{
  "name": "pimwell-hub",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "migrate:local": "wrangler d1 migrations apply HUB_DB --local",
    "migrate:remote": "wrangler d1 migrations apply HUB_DB --remote",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.0",
    "vitest": "~3.1.0",
    "wrangler": "^4.0.0"
  }
}
```
If `npm install` reports a peer-dependency conflict between `vitest` and `@cloudflare/vitest-pool-workers`, pin `vitest` to the version the pool's current README names and re-run. Do not use `--legacy-peer-deps`.

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types/2023-07-01", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "pimwell-hub",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "routes": [
    { "pattern": "pimwell.com/*", "zone_name": "pimwell.com" },
    { "pattern": "*.pimwell.com/*", "zone_name": "pimwell.com" }
  ],
  "vars": { "HUB_DOMAIN": "pimwell.com" },
  "d1_databases": [
    {
      "binding": "HUB_DB",
      "database_name": "pimwell-hub",
      "database_id": "local-placeholder-until-d1-create",
      "migrations_dir": "migrations"
    }
  ],
  "kv_namespaces": [
    { "binding": "RATE", "id": "local-placeholder-until-kv-create" }
  ]
}
```
The two placeholder ids are replaced in Task 16 after `wrangler d1 create` and `wrangler kv namespace create` run against the account. Local tests and `wrangler dev` do not need real ids.

`.dev.vars.example`:
```
HUB_DOMAIN=localhost
HUB_BOOTSTRAP_TOKEN=dev-bootstrap-token-change-me
```

`.gitignore`:
```
node_modules
.wrangler
.dev.vars
dist
```

- [ ] **Step 2: Write env type and the smallest Worker**

`src/env.ts`:
```ts
export type Env = {
  HUB_DB: D1Database;
  RATE: KVNamespace;
  HUB_DOMAIN: string;
  HUB_BOOTSTRAP_TOKEN: string;
};
```

`src/index.ts`:
```ts
import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));

export default app;
```

- [ ] **Step 3: Write vitest config and test typing**

`vitest.config.ts`:
```ts
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              HUB_DOMAIN: "pimwell.test",
              HUB_BOOTSTRAP_TOKEN: "test-bootstrap-token",
            },
          },
        },
      },
    },
  };
});
```

`test/env.d.ts`:
```ts
import type { Env } from "../src/env";
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

`test/apply-migrations.ts`:
```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.HUB_DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 4: Write the failing test**

`test/index.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("answers healthz", async () => {
    const res = await SELF.fetch("https://pimwell.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
```

- [ ] **Step 5: Install and run**

Run: `npm install && npx vitest run`
Expected: 1 test passes. If it fails because `migrations/` is empty, `readD1Migrations` returns an empty array and `applyD1Migrations` is a no-op; the failure is elsewhere, read the error.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold pimwell-hub worker with vitest workers pool"
```

---

### Task 2: D1 schema migration

**Files:**
- Create: `migrations/0001_init.sql`
- Create: `test/schema.test.ts`
- Delete: `migrations/.gitkeep`

**Interfaces:**
- Produces: the tables `meta, tenant, namespace, project, identity, membership, invite, consent, auth_link, session, api_token, proof, event` with the columns below. All later tasks' SQL targets these names exactly.

- [ ] **Step 1: Write the failing test**

`test/schema.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const EXPECTED = [
  "api_token", "auth_link", "consent", "event", "identity", "invite", "membership",
  "meta", "namespace", "project", "proof", "session", "tenant",
];

describe("schema", () => {
  it("creates every table from the spec", async () => {
    const rows = await env.HUB_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(EXPECTED);
  });

  it("records schema version 1", async () => {
    const row = await env.HUB_DB.prepare("SELECT value FROM meta WHERE key='schema_version'").first<{ value: string }>();
    expect(row?.value).toBe("1");
  });

  it("enforces unique top-level project slug per tenant", async () => {
    const now = Date.now();
    await env.HUB_DB.prepare("INSERT INTO tenant (id,slug,display_name,state,created_at) VALUES ('t1','acme','Acme','active',?)").bind(now).run();
    await env.HUB_DB.prepare("INSERT INTO project (id,tenant_id,namespace_id,slug,kind,display_name,state,created_at) VALUES ('p1','t1',NULL,'site','repo','Site','active',?)").bind(now).run();
    await expect(
      env.HUB_DB.prepare("INSERT INTO project (id,tenant_id,namespace_id,slug,kind,display_name,state,created_at) VALUES ('p2','t1',NULL,'site','repo','Site 2','active',?)").bind(now).run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL, the table list is empty.

- [ ] **Step 3: Write the migration**

`migrations/0001_init.sql`:
```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE tenant (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE namespace (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  namespace_id TEXT REFERENCES namespace(id),
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX project_top_slug ON project (tenant_id, slug) WHERE namespace_id IS NULL;
CREATE UNIQUE INDEX project_ns_slug ON project (tenant_id, namespace_id, slug) WHERE namespace_id IS NOT NULL;
CREATE INDEX project_tenant_state ON project (tenant_id, state);

CREATE TABLE identity (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_root INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL UNIQUE,
  operator_id TEXT REFERENCES identity(id),
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE membership (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  UNIQUE (identity_id, tenant_id)
);
CREATE INDEX membership_tenant ON membership (tenant_id);

CREATE TABLE invite (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenant(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  display_name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_session_id TEXT,
  revoked_at INTEGER
);
CREATE INDEX invite_tenant ON invite (tenant_id, created_at);

CREATE TABLE consent (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenant(id),
  kind TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  source_message_id TEXT,
  evidence TEXT
);
CREATE INDEX consent_email ON consent (email);

CREATE TABLE auth_link (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  tenant_id TEXT REFERENCES tenant(id),
  kind TEXT NOT NULL,
  label TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_proof_at INTEGER NOT NULL,
  revoked_at INTEGER,
  parent_token_id TEXT
);
CREATE INDEX session_identity ON session (identity_id, created_at);

CREATE TABLE api_token (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE proof (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE event (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenant(id),
  identity_id TEXT REFERENCES identity(id),
  session_id TEXT REFERENCES session(id),
  kind TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX event_tenant_time ON event (tenant_id, created_at);
```

- [ ] **Step 4: Run tests**

Run: `git rm -q migrations/.gitkeep && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add D1 schema migration for identity control plane"
```

---

### Task 3: Ids, tokens, hashing

**Files:**
- Create: `src/ids.ts`, `src/errors.ts`, `test/ids.test.ts`

**Interfaces:**
- Produces: `ulid(now?: number): string`; `randomToken(prefix: string): string` (prefix plus 43 base64url chars); `sha256Hex(input: string): Promise<string>`; `timingSafeEqual(a: string, b: string): boolean`; `class HubError extends Error { status: number; reason: string; detail?: string }`.

- [ ] **Step 1: Write the failing test**

`test/ids.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { randomToken, sha256Hex, timingSafeEqual, ulid } from "../src/ids";

describe("ulid", () => {
  it("is 26 chars of Crockford base32 and sorts by time", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_001_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(a.slice(0, 10)).toBe(ulid(1_700_000_000_000).slice(0, 10));
  });
});

describe("randomToken", () => {
  it("has the prefix and 43 url-safe chars, and does not repeat", () => {
    const t = randomToken("pms_");
    expect(t).toMatch(/^pms_[A-Za-z0-9_-]{43}$/);
    expect(randomToken("pms_")).not.toBe(t);
  });
});

describe("sha256Hex", () => {
  it("matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("timingSafeEqual", () => {
  it("compares strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ids.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/ids.ts`:
```ts
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  const out: string[] = new Array(26);
  let t = now;
  for (let i = 9; i >= 0; i--) {
    out[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) out[10 + i] = CROCKFORD[rand[i]! % 32]!;
  return out.join("");
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}
```

`src/errors.ts`:
```ts
export class HubError extends Error {
  constructor(
    public status: number,
    public reason: string,
    public detail?: string,
  ) {
    super(detail ?? reason);
    this.name = "HubError";
  }
}

export const notFound = (detail?: string) => new HubError(404, "not_found", detail);
export const forbidden = (detail?: string) => new HubError(403, "forbidden", detail);
export const conflict = (detail?: string) => new HubError(409, "conflict", detail);
export const badRequest = (detail?: string) => new HubError(400, "bad_request", detail);
export const unauthorized = (detail?: string) => new HubError(401, "unauthorized", detail);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/ids.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ids.ts src/errors.ts test/ids.test.ts
git commit -m "feat: ulid, random tokens, sha256, HubError"
```

---

### Task 4: HTML helpers

**Files:**
- Create: `src/html.ts`, `test/html.test.ts`

**Interfaces:**
- Produces: `esc(s: string): string`; `page(title: string, body: string): string` returning a full HTML document; `htmlResponse(body: string, status?: number, headers?: HeadersInit): Response`.

- [ ] **Step 1: Write the failing test**

`test/html.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { esc, htmlResponse, page } from "../src/html";

describe("html", () => {
  it("escapes the five characters", () => {
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  it("wraps a body in a document with the escaped title", () => {
    const doc = page("Acme <1>", "<p>hi</p>");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>Acme &lt;1&gt;</title>");
    expect(doc).toContain("<p>hi</p>");
  });

  it("returns an html response with no-store", () => {
    const res = htmlResponse("<p>x</p>", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/html.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/html.ts`:
```ts
const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => MAP[ch]!);
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
h1{font-size:1.5rem}table{border-collapse:collapse}td,th{padding:.25rem .75rem .25rem 0;text-align:left}
form.inline{display:inline}button{font:inherit}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function htmlResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(body, { status, headers: h });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/html.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/html.ts test/html.test.ts
git commit -m "feat: html escape, page layout, html response helper"
```

---

### Task 5: Host classification and slug rules

**Files:**
- Create: `src/tenant.ts`, `test/tenant.test.ts`

**Interfaces:**
- Produces: `RESERVED_LABELS: Set<string>`; `SLUG_RE: RegExp`; `isValidSlug(s: string): boolean` (namespaces and projects); `isValidTenantSlug(s: string): boolean` (also rejects reserved labels and leading underscore); `type HostKind = { kind: "apex" } | { kind: "tenant"; slug: string } | { kind: "unknown" }`; `classifyHost(hostHeader: string | null, hubDomain: string): HostKind`.

- [ ] **Step 1: Write the failing test**

`test/tenant.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { classifyHost, isValidSlug, isValidTenantSlug } from "../src/tenant";

describe("classifyHost", () => {
  it("recognises the apex", () => {
    expect(classifyHost("pimwell.test", "pimwell.test")).toEqual({ kind: "apex" });
  });
  it("recognises a tenant label", () => {
    expect(classifyHost("acme.pimwell.test", "pimwell.test")).toEqual({ kind: "tenant", slug: "acme" });
  });
  it("lowercases and strips a port", () => {
    expect(classifyHost("Acme.Pimwell.test:443", "pimwell.test")).toEqual({ kind: "tenant", slug: "acme" });
  });
  it("treats reserved labels, deep labels, foreign hosts and missing header as unknown", () => {
    for (const h of ["mcp.pimwell.test", "a.b.pimwell.test", "evil.example", "pimwell.test.evil.example", "_x.pimwell.test"]) {
      expect(classifyHost(h, "pimwell.test")).toEqual({ kind: "unknown" });
    }
    expect(classifyHost(null, "pimwell.test")).toEqual({ kind: "unknown" });
  });
  it("supports localhost for dev", () => {
    expect(classifyHost("acme.localhost:8787", "localhost")).toEqual({ kind: "tenant", slug: "acme" });
    expect(classifyHost("localhost:8787", "localhost")).toEqual({ kind: "apex" });
  });
});

describe("slugs", () => {
  it("accepts dns-label-like slugs", () => {
    expect(isValidSlug("acme")).toBe(true);
    expect(isValidSlug("a-1")).toBe(true);
    expect(isValidSlug("a".repeat(63))).toBe(true);
  });
  it("rejects bad slugs", () => {
    for (const s of ["", "-a", "a-", "A", "a_b", "a.b", "a".repeat(64)]) expect(isValidSlug(s)).toBe(false);
  });
  it("rejects reserved tenant labels", () => {
    for (const s of ["www", "mail", "mx", "api", "mcp", "login", "signup", "admin", "root", "static", "cdn"]) {
      expect(isValidTenantSlug(s)).toBe(false);
    }
    expect(isValidTenantSlug("acme")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tenant.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/tenant.ts`:
```ts
export const RESERVED_LABELS: Set<string> = new Set([
  "www", "mail", "mx", "api", "mcp", "login", "signup", "admin", "root", "static", "cdn",
]);

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export function isValidTenantSlug(s: string): boolean {
  return isValidSlug(s) && !s.startsWith("_") && !RESERVED_LABELS.has(s);
}

export type HostKind = { kind: "apex" } | { kind: "tenant"; slug: string } | { kind: "unknown" };

export function classifyHost(hostHeader: string | null, hubDomain: string): HostKind {
  if (!hostHeader) return { kind: "unknown" };
  const host = hostHeader.toLowerCase().split(":")[0]!;
  const domain = hubDomain.toLowerCase();
  if (host === domain) return { kind: "apex" };
  const suffix = "." + domain;
  if (!host.endsWith(suffix)) return { kind: "unknown" };
  const label = host.slice(0, host.length - suffix.length);
  if (label.includes(".") || !isValidTenantSlug(label)) return { kind: "unknown" };
  return { kind: "tenant", slug: label };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/tenant.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tenant.ts test/tenant.test.ts
git commit -m "feat: host classification, slug validation, reserved labels"
```

---

### Task 6: Tenant, namespace, project, and event repositories

**Files:**
- Create: `src/db/types.ts`, `src/db/tenants.ts`, `src/db/namespaces.ts`, `src/db/projects.ts`, `src/db/events.ts`, `test/db-objects.test.ts`

**Interfaces:**
- Consumes: `ulid` from `src/ids.ts`; `conflict`, `badRequest` from `src/errors.ts`; `isValidSlug`, `isValidTenantSlug` from `src/tenant.ts`.
- Produces (all `db: D1Database`, `now: number` in ms):
  - types `State = "active" | "archived"`, `Role = "root" | "admin" | "member" | "reader"`, rows `Tenant, Namespace, Project, Identity, Membership, Invite, Session, EventRow`.
  - `createTenant(db, { slug, display_name }, now): Promise<Tenant>`; `getTenantBySlug(db, slug): Promise<Tenant | null>`; `getTenantById(db, id)`; `listTenants(db, state: State): Promise<Tenant[]>`; `setTenantState(db, id, state, now): Promise<boolean>`.
  - `createNamespace(db, { tenant_id, slug, display_name }, now): Promise<Namespace>`; `getNamespaceBySlug(db, tenant_id, slug)`; `getNamespaceById(db, id)`; `listNamespaces(db, tenant_id, state)`; `setNamespaceState(db, id, state): Promise<boolean>` which also sets the state of every project in the namespace.
  - `createProject(db, { tenant_id, namespace_id: string | null, slug, kind, display_name }, now): Promise<Project>`; `getProjectById(db, id)`; `getProjectByPath(db, tenant_id, namespace_slug: string | null, slug)`; `listProjects(db, tenant_id, state): Promise<Project[]>`; `setProjectState(db, id, state): Promise<boolean>`.
  - `recordEvent(db, { tenant_id, identity_id, session_id, kind, target_kind, target_id, summary }, now): Promise<EventRow>`; `listEvents(db, tenant_id, limit): Promise<EventRow[]>`.

- [ ] **Step 1: Write the types**

`src/db/types.ts`:
```ts
export type State = "active" | "archived";
export type Role = "root" | "admin" | "member" | "reader";
export type IdentityKind = "human" | "agent";

export type Tenant = { id: string; slug: string; display_name: string; state: State; created_at: number };
export type Namespace = { id: string; tenant_id: string; slug: string; display_name: string; state: State; created_at: number };
export type Project = {
  id: string; tenant_id: string; namespace_id: string | null; slug: string; kind: string;
  display_name: string; state: State; created_at: number;
};
export type Identity = {
  id: string; kind: IdentityKind; display_name: string; is_root: number; email: string;
  operator_id: string | null; state: State; created_at: number;
};
export type Membership = { id: string; identity_id: string; tenant_id: string; role: Role; state: State; created_at: number };
export type Invite = {
  id: string; tenant_id: string | null; email: string; role: Role; display_name: string | null;
  token_hash: string; created_by: string | null; created_at: number; expires_at: number;
  accepted_at: number | null; accepted_session_id: string | null; revoked_at: number | null;
};
export type Session = {
  id: string; identity_id: string; tenant_id: string | null; kind: "browser" | "agent_run"; label: string | null;
  token_hash: string; created_at: number; last_seen_at: number; expires_at: number; last_proof_at: number;
  revoked_at: number | null; parent_token_id: string | null;
};
export type EventRow = {
  id: string; tenant_id: string | null; identity_id: string | null; session_id: string | null;
  kind: string; target_kind: string; target_id: string; summary: string; created_at: number;
};
```

- [ ] **Step 2: Write the failing test**

`test/db-objects.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenant, getTenantBySlug, listTenants, setTenantState } from "../src/db/tenants";
import { createNamespace, listNamespaces, setNamespaceState } from "../src/db/namespaces";
import { createProject, getProjectByPath, listProjects, setProjectState } from "../src/db/projects";
import { listEvents, recordEvent } from "../src/db/events";

const db = () => env.HUB_DB;
const now = 1_700_000_000_000;

describe("tenants", () => {
  it("creates, finds, lists by state, archives", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    expect(t.state).toBe("active");
    expect((await getTenantBySlug(db(), "acme"))?.id).toBe(t.id);
    expect((await listTenants(db(), "active")).map((x) => x.slug)).toEqual(["acme"]);
    expect(await setTenantState(db(), t.id, "archived", now + 1)).toBe(true);
    expect(await listTenants(db(), "active")).toEqual([]);
    expect((await listTenants(db(), "archived")).map((x) => x.slug)).toEqual(["acme"]);
  });
  it("rejects reserved and duplicate slugs", async () => {
    await expect(createTenant(db(), { slug: "mcp", display_name: "x" }, now)).rejects.toMatchObject({ status: 400 });
    await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    await expect(createTenant(db(), { slug: "acme", display_name: "Acme 2" }, now)).rejects.toMatchObject({ status: 409 });
  });
});

describe("namespaces and projects", () => {
  it("creates projects at top level and under a namespace, and finds by path", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const ns = await createNamespace(db(), { tenant_id: t.id, slug: "research", display_name: "Research" }, now);
    const top = await createProject(db(), { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
    const inner = await createProject(db(), { tenant_id: t.id, namespace_id: ns.id, slug: "site", kind: "repo", display_name: "Research site" }, now);
    expect((await getProjectByPath(db(), t.id, null, "site"))?.id).toBe(top.id);
    expect((await getProjectByPath(db(), t.id, "research", "site"))?.id).toBe(inner.id);
    expect((await listProjects(db(), t.id, "active")).length).toBe(2);
  });

  it("rejects a top-level project slug that matches a namespace slug, and the reverse", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    await createNamespace(db(), { tenant_id: t.id, slug: "research", display_name: "Research" }, now);
    await expect(
      createProject(db(), { tenant_id: t.id, namespace_id: null, slug: "research", kind: "repo", display_name: "x" }, now),
    ).rejects.toMatchObject({ status: 409 });
    await createProject(db(), { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
    await expect(createNamespace(db(), { tenant_id: t.id, slug: "site", display_name: "x" }, now)).rejects.toMatchObject({ status: 409 });
  });

  it("archiving a namespace archives its projects and unarchiving restores them", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const ns = await createNamespace(db(), { tenant_id: t.id, slug: "research", display_name: "Research" }, now);
    await createProject(db(), { tenant_id: t.id, namespace_id: ns.id, slug: "a", kind: "repo", display_name: "A" }, now);
    const top = await createProject(db(), { tenant_id: t.id, namespace_id: null, slug: "b", kind: "repo", display_name: "B" }, now);
    await setNamespaceState(db(), ns.id, "archived");
    expect((await listProjects(db(), t.id, "active")).map((p) => p.id)).toEqual([top.id]);
    expect((await listNamespaces(db(), t.id, "archived")).length).toBe(1);
    await setNamespaceState(db(), ns.id, "active");
    expect((await listProjects(db(), t.id, "active")).length).toBe(2);
    expect(await setProjectState(db(), top.id, "archived")).toBe(true);
    expect(await setProjectState(db(), "nope", "archived")).toBe(false);
  });

  it("isolates tenants", async () => {
    const a = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const b = await createTenant(db(), { slug: "blue", display_name: "Blue" }, now);
    await createProject(db(), { tenant_id: a.id, namespace_id: null, slug: "site", kind: "repo", display_name: "A" }, now);
    await createProject(db(), { tenant_id: b.id, namespace_id: null, slug: "site", kind: "repo", display_name: "B" }, now);
    expect((await listProjects(db(), a.id, "active")).map((p) => p.display_name)).toEqual(["A"]);
    expect((await getProjectByPath(db(), b.id, null, "site"))?.display_name).toBe("B");
  });
});

describe("events", () => {
  it("records and lists newest first", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    await recordEvent(db(), { tenant_id: t.id, identity_id: null, session_id: null, kind: "tenant.create", target_kind: "tenant", target_id: t.id, summary: "Created Acme" }, now);
    await recordEvent(db(), { tenant_id: t.id, identity_id: null, session_id: null, kind: "project.create", target_kind: "project", target_id: "p", summary: "Created p" }, now + 5);
    const rows = await listEvents(db(), t.id, 10);
    expect(rows.map((r) => r.kind)).toEqual(["project.create", "tenant.create"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/db-objects.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement the repositories**

`src/db/tenants.ts`:
```ts
import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidTenantSlug } from "../tenant";
import type { State, Tenant } from "./types";

export async function createTenant(db: D1Database, input: { slug: string; display_name: string }, now: number): Promise<Tenant> {
  if (!isValidTenantSlug(input.slug)) throw badRequest("invalid tenant slug");
  if (!input.display_name.trim()) throw badRequest("display_name required");
  const row: Tenant = { id: ulid(now), slug: input.slug, display_name: input.display_name.trim(), state: "active", created_at: now };
  try {
    await db.prepare("INSERT INTO tenant (id, slug, display_name, state, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(row.id, row.slug, row.display_name, row.state, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("tenant slug exists");
    throw e;
  }
  return row;
}

export function getTenantBySlug(db: D1Database, slug: string): Promise<Tenant | null> {
  return db.prepare("SELECT * FROM tenant WHERE slug = ?").bind(slug).first<Tenant>();
}

export function getTenantById(db: D1Database, id: string): Promise<Tenant | null> {
  return db.prepare("SELECT * FROM tenant WHERE id = ?").bind(id).first<Tenant>();
}

export async function listTenants(db: D1Database, state: State): Promise<Tenant[]> {
  const r = await db.prepare("SELECT * FROM tenant WHERE state = ? ORDER BY slug").bind(state).all<Tenant>();
  return r.results;
}

export async function setTenantState(db: D1Database, id: string, state: State, _now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE tenant SET state = ? WHERE id = ? AND state <> ?").bind(state, id, state).run();
  return r.meta.changes === 1;
}
```

`src/db/namespaces.ts`:
```ts
import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidSlug } from "../tenant";
import type { Namespace, State } from "./types";

export async function createNamespace(
  db: D1Database,
  input: { tenant_id: string; slug: string; display_name: string },
  now: number,
): Promise<Namespace> {
  if (!isValidSlug(input.slug)) throw badRequest("invalid namespace slug");
  if (!input.display_name.trim()) throw badRequest("display_name required");
  const clash = await db.prepare("SELECT 1 FROM project WHERE tenant_id = ? AND namespace_id IS NULL AND slug = ?")
    .bind(input.tenant_id, input.slug).first();
  if (clash) throw conflict("slug is used by a top-level project");
  const row: Namespace = { id: ulid(now), tenant_id: input.tenant_id, slug: input.slug, display_name: input.display_name.trim(), state: "active", created_at: now };
  try {
    await db.prepare("INSERT INTO namespace (id, tenant_id, slug, display_name, state, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.slug, row.display_name, row.state, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("namespace slug exists");
    throw e;
  }
  return row;
}

export function getNamespaceBySlug(db: D1Database, tenant_id: string, slug: string): Promise<Namespace | null> {
  return db.prepare("SELECT * FROM namespace WHERE tenant_id = ? AND slug = ?").bind(tenant_id, slug).first<Namespace>();
}

export function getNamespaceById(db: D1Database, id: string): Promise<Namespace | null> {
  return db.prepare("SELECT * FROM namespace WHERE id = ?").bind(id).first<Namespace>();
}

export async function listNamespaces(db: D1Database, tenant_id: string, state: State): Promise<Namespace[]> {
  const r = await db.prepare("SELECT * FROM namespace WHERE tenant_id = ? AND state = ? ORDER BY slug").bind(tenant_id, state).all<Namespace>();
  return r.results;
}

export async function setNamespaceState(db: D1Database, id: string, state: State): Promise<boolean> {
  const [ns] = await db.batch([
    db.prepare("UPDATE namespace SET state = ? WHERE id = ? AND state <> ?").bind(state, id, state),
    db.prepare("UPDATE project SET state = ? WHERE namespace_id = ? AND state <> ?").bind(state, id, state),
  ]);
  return ns!.meta.changes === 1;
}
```

`src/db/projects.ts`:
```ts
import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidSlug } from "../tenant";
import type { Project, State } from "./types";

const KINDS = new Set(["repo", "tracker"]);

export async function createProject(
  db: D1Database,
  input: { tenant_id: string; namespace_id: string | null; slug: string; kind: string; display_name: string },
  now: number,
): Promise<Project> {
  if (!isValidSlug(input.slug)) throw badRequest("invalid project slug");
  if (!KINDS.has(input.kind)) throw badRequest("unknown project kind");
  if (!input.display_name.trim()) throw badRequest("display_name required");
  if (input.namespace_id === null) {
    const clash = await db.prepare("SELECT 1 FROM namespace WHERE tenant_id = ? AND slug = ?").bind(input.tenant_id, input.slug).first();
    if (clash) throw conflict("slug is used by a namespace");
  } else {
    const ns = await db.prepare("SELECT 1 FROM namespace WHERE id = ? AND tenant_id = ?").bind(input.namespace_id, input.tenant_id).first();
    if (!ns) throw badRequest("namespace not in tenant");
  }
  const row: Project = {
    id: ulid(now), tenant_id: input.tenant_id, namespace_id: input.namespace_id, slug: input.slug, kind: input.kind,
    display_name: input.display_name.trim(), state: "active", created_at: now,
  };
  try {
    await db.prepare("INSERT INTO project (id, tenant_id, namespace_id, slug, kind, display_name, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.namespace_id, row.slug, row.kind, row.display_name, row.state, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("project slug exists");
    throw e;
  }
  return row;
}

export function getProjectById(db: D1Database, id: string): Promise<Project | null> {
  return db.prepare("SELECT * FROM project WHERE id = ?").bind(id).first<Project>();
}

export function getProjectByPath(db: D1Database, tenant_id: string, namespace_slug: string | null, slug: string): Promise<Project | null> {
  if (namespace_slug === null) {
    return db.prepare("SELECT * FROM project WHERE tenant_id = ? AND namespace_id IS NULL AND slug = ?").bind(tenant_id, slug).first<Project>();
  }
  return db.prepare(
    "SELECT p.* FROM project p JOIN namespace n ON n.id = p.namespace_id WHERE p.tenant_id = ? AND n.slug = ? AND p.slug = ?",
  ).bind(tenant_id, namespace_slug, slug).first<Project>();
}

export async function listProjects(db: D1Database, tenant_id: string, state: State): Promise<Project[]> {
  const r = await db.prepare("SELECT * FROM project WHERE tenant_id = ? AND state = ? ORDER BY namespace_id, slug").bind(tenant_id, state).all<Project>();
  return r.results;
}

export async function setProjectState(db: D1Database, id: string, state: State): Promise<boolean> {
  const r = await db.prepare("UPDATE project SET state = ? WHERE id = ? AND state <> ?").bind(state, id, state).run();
  return r.meta.changes === 1;
}
```

`src/db/events.ts`:
```ts
import { ulid } from "../ids";
import type { EventRow } from "./types";

export async function recordEvent(
  db: D1Database,
  e: Omit<EventRow, "id" | "created_at">,
  now: number,
): Promise<EventRow> {
  const row: EventRow = { ...e, id: ulid(now), created_at: now };
  await db.prepare(
    "INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.tenant_id, row.identity_id, row.session_id, row.kind, row.target_kind, row.target_id, row.summary, row.created_at).run();
  return row;
}

export async function listEvents(db: D1Database, tenant_id: string, limit: number): Promise<EventRow[]> {
  const r = await db.prepare("SELECT * FROM event WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(tenant_id, limit).all<EventRow>();
  return r.results;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/db-objects.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db test/db-objects.test.ts
git commit -m "feat: tenant, namespace, project, event repositories"
```

---

### Task 7: Identities, memberships, invites

**Files:**
- Create: `src/db/identities.ts`, `src/db/memberships.ts`, `src/db/invites.ts`, `test/db-identity.test.ts`

**Interfaces:**
- Consumes: `ulid`, `randomToken`, `sha256Hex` from `src/ids.ts`; `badRequest`, `conflict` from `src/errors.ts`; types from `src/db/types.ts`.
- Produces:
  - `createIdentity(db, { kind, email, display_name, is_root, operator_id }, now): Promise<Identity>`; `getIdentityByEmail(db, email)`; `getIdentityById(db, id)`; `rootExists(db): Promise<boolean>`; `normalizeEmail(s: string): string` (trim, lowercase).
  - `addMembership(db, { identity_id, tenant_id, role }, now): Promise<Membership>` (returns the existing row unchanged if one exists); `getMembership(db, identity_id, tenant_id): Promise<Membership | null>`; `listMembershipsForIdentity(db, identity_id): Promise<Array<{ membership: Membership; tenant: Tenant }>>` (active tenants and memberships only); `listMembers(db, tenant_id): Promise<Array<{ membership: Membership; identity: Identity }>>`.
  - `INVITE_TTL_MS = 7 * 24 * 3600 * 1000`; `createInvite(db, { tenant_id, email, role, display_name, created_by }, now): Promise<{ invite: Invite; token: string }>`; `findInviteByToken(db, token): Promise<Invite | null>`; `inviteIsOpen(invite, now): boolean`; `acceptInvite(db, invite, now): Promise<{ identity: Identity; created: boolean } | null>` which atomically marks the invite accepted, creates the identity if the email is new, and adds the membership (or sets `is_root` for a root invite); returns `null` if the invite was not open or another acceptance won; `setInviteAcceptedSession(db, invite_id, session_id)`; `revokeInvite(db, id, now): Promise<boolean>`; `listInvites(db, tenant_id): Promise<Invite[]>`.

- [ ] **Step 1: Write the failing test**

`test/db-identity.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenant } from "../src/db/tenants";
import { createIdentity, getIdentityByEmail, rootExists } from "../src/db/identities";
import { addMembership, getMembership, listMembershipsForIdentity } from "../src/db/memberships";
import { acceptInvite, createInvite, findInviteByToken, inviteIsOpen, INVITE_TTL_MS, revokeInvite } from "../src/db/invites";

const db = () => env.HUB_DB;
const now = 1_700_000_000_000;

describe("identities and memberships", () => {
  it("creates a human, normalises email, detects root", async () => {
    expect(await rootExists(db())).toBe(false);
    const id = await createIdentity(db(), { kind: "human", email: " Ada@Example.com ", display_name: "Ada", is_root: 1, operator_id: null }, now);
    expect(id.email).toBe("ada@example.com");
    expect((await getIdentityByEmail(db(), "ADA@example.com"))?.id).toBe(id.id);
    expect(await rootExists(db())).toBe(true);
  });

  it("adds a membership once and lists active tenants", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const id = await createIdentity(db(), { kind: "human", email: "a@example.com", display_name: "A", is_root: 0, operator_id: null }, now);
    const m1 = await addMembership(db(), { identity_id: id.id, tenant_id: t.id, role: "member" }, now);
    const m2 = await addMembership(db(), { identity_id: id.id, tenant_id: t.id, role: "admin" }, now + 1);
    expect(m2.id).toBe(m1.id);
    expect(m2.role).toBe("member");
    expect((await getMembership(db(), id.id, t.id))?.role).toBe("member");
    expect((await listMembershipsForIdentity(db(), id.id)).map((x) => x.tenant.slug)).toEqual(["acme"]);
  });
});

describe("invites", () => {
  it("creates an invite with a hashed token and 7 day expiry", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const { invite, token } = await createInvite(db(), { tenant_id: t.id, email: "New@Example.com", role: "member", display_name: null, created_by: null }, now);
    expect(token).toMatch(/^pmi_/);
    expect(invite.email).toBe("new@example.com");
    expect(invite.expires_at).toBe(now + INVITE_TTL_MS);
    expect(invite.token_hash).not.toContain(token);
    expect((await findInviteByToken(db(), token))?.id).toBe(invite.id);
    expect(await findInviteByToken(db(), "pmi_nope")).toBeNull();
    expect(inviteIsOpen(invite, now)).toBe(true);
    expect(inviteIsOpen(invite, now + INVITE_TTL_MS)).toBe(false);
  });

  it("accepting creates identity and membership once; second accept returns null", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const { invite } = await createInvite(db(), { tenant_id: t.id, email: "new@example.com", role: "member", display_name: "New", created_by: null }, now);
    const first = await acceptInvite(db(), invite, now + 10);
    expect(first?.created).toBe(true);
    expect(first?.identity.display_name).toBe("New");
    expect((await getMembership(db(), first!.identity.id, t.id))?.role).toBe("member");
    expect(await acceptInvite(db(), invite, now + 20)).toBeNull();
  });

  it("accepting with an existing identity adds a membership and keeps the display name", async () => {
    const a = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const b = await createTenant(db(), { slug: "blue", display_name: "Blue" }, now);
    const existing = await createIdentity(db(), { kind: "human", email: "ada@example.com", display_name: "Ada Original", is_root: 0, operator_id: null }, now);
    await addMembership(db(), { identity_id: existing.id, tenant_id: a.id, role: "admin" }, now);
    const { invite } = await createInvite(db(), { tenant_id: b.id, email: "ADA@example.com", role: "reader", display_name: "Overwrite Attempt", created_by: null }, now);
    const res = await acceptInvite(db(), invite, now + 1);
    expect(res?.created).toBe(false);
    expect(res?.identity.id).toBe(existing.id);
    expect(res?.identity.display_name).toBe("Ada Original");
    expect((await listMembershipsForIdentity(db(), existing.id)).map((x) => `${x.tenant.slug}:${x.membership.role}`)).toEqual(["acme:admin", "blue:reader"]);
  });

  it("a root invite sets is_root and adds no membership", async () => {
    const { invite } = await createInvite(db(), { tenant_id: null, email: "root@example.com", role: "root", display_name: "Root", created_by: null }, now);
    const res = await acceptInvite(db(), invite, now + 1);
    expect(res?.identity.is_root).toBe(1);
    expect(await listMembershipsForIdentity(db(), res!.identity.id)).toEqual([]);
    expect(await rootExists(db())).toBe(true);
  });

  it("revoked invites are not open", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const { invite, token } = await createInvite(db(), { tenant_id: t.id, email: "x@example.com", role: "member", display_name: null, created_by: null }, now);
    expect(await revokeInvite(db(), invite.id, now + 1)).toBe(true);
    const after = await findInviteByToken(db(), token);
    expect(inviteIsOpen(after!, now + 2)).toBe(false);
    expect(await acceptInvite(db(), after!, now + 3)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db-identity.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/db/identities.ts`:
```ts
import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import type { Identity, IdentityKind } from "./types";

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export async function createIdentity(
  db: D1Database,
  input: { kind: IdentityKind; email: string; display_name: string; is_root: number; operator_id: string | null },
  now: number,
): Promise<Identity> {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw badRequest("invalid email");
  if (!input.display_name.trim()) throw badRequest("display_name required");
  const row: Identity = {
    id: ulid(now), kind: input.kind, display_name: input.display_name.trim(), is_root: input.is_root, email,
    operator_id: input.operator_id, state: "active", created_at: now,
  };
  try {
    await db.prepare(
      "INSERT INTO identity (id, kind, display_name, is_root, email, operator_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(row.id, row.kind, row.display_name, row.is_root, row.email, row.operator_id, row.state, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("email exists");
    throw e;
  }
  return row;
}

export function getIdentityByEmail(db: D1Database, email: string): Promise<Identity | null> {
  return db.prepare("SELECT * FROM identity WHERE email = ?").bind(normalizeEmail(email)).first<Identity>();
}

export function getIdentityById(db: D1Database, id: string): Promise<Identity | null> {
  return db.prepare("SELECT * FROM identity WHERE id = ?").bind(id).first<Identity>();
}

export async function rootExists(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT 1 FROM identity WHERE is_root = 1 AND state = 'active' LIMIT 1").first();
  return r !== null;
}
```

`src/db/memberships.ts`:
```ts
import { ulid } from "../ids";
import type { Identity, Membership, Role, Tenant } from "./types";

export async function addMembership(
  db: D1Database,
  input: { identity_id: string; tenant_id: string; role: Role },
  now: number,
): Promise<Membership> {
  const row: Membership = { id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, role: input.role, state: "active", created_at: now };
  await db.prepare(
    "INSERT OR IGNORE INTO membership (id, identity_id, tenant_id, role, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.identity_id, row.tenant_id, row.role, row.state, row.created_at).run();
  return (await getMembership(db, input.identity_id, input.tenant_id))!;
}

export function getMembership(db: D1Database, identity_id: string, tenant_id: string): Promise<Membership | null> {
  return db.prepare("SELECT * FROM membership WHERE identity_id = ? AND tenant_id = ?").bind(identity_id, tenant_id).first<Membership>();
}

export async function listMembershipsForIdentity(db: D1Database, identity_id: string): Promise<Array<{ membership: Membership; tenant: Tenant }>> {
  const r = await db.prepare(
    `SELECT m.id AS m_id, m.identity_id, m.tenant_id, m.role, m.state AS m_state, m.created_at AS m_created_at,
            t.id AS t_id, t.slug, t.display_name, t.state AS t_state, t.created_at AS t_created_at
       FROM membership m JOIN tenant t ON t.id = m.tenant_id
      WHERE m.identity_id = ? AND m.state = 'active' AND t.state = 'active'
      ORDER BY t.slug`,
  ).bind(identity_id).all<Record<string, string | number>>();
  return r.results.map((x) => ({
    membership: { id: x.m_id as string, identity_id: x.identity_id as string, tenant_id: x.tenant_id as string, role: x.role as Role, state: x.m_state as "active", created_at: x.m_created_at as number },
    tenant: { id: x.t_id as string, slug: x.slug as string, display_name: x.display_name as string, state: x.t_state as "active", created_at: x.t_created_at as number },
  }));
}

export async function listMembers(db: D1Database, tenant_id: string): Promise<Array<{ membership: Membership; identity: Identity }>> {
  const r = await db.prepare(
    `SELECT m.id AS m_id, m.identity_id, m.tenant_id, m.role, m.state AS m_state, m.created_at AS m_created_at,
            i.id AS i_id, i.kind, i.display_name, i.is_root, i.email, i.operator_id, i.state AS i_state, i.created_at AS i_created_at
       FROM membership m JOIN identity i ON i.id = m.identity_id
      WHERE m.tenant_id = ? AND m.state = 'active'
      ORDER BY i.display_name`,
  ).bind(tenant_id).all<Record<string, string | number | null>>();
  return r.results.map((x) => ({
    membership: { id: x.m_id as string, identity_id: x.identity_id as string, tenant_id: x.tenant_id as string, role: x.role as Role, state: x.m_state as "active", created_at: x.m_created_at as number },
    identity: {
      id: x.i_id as string, kind: x.kind as "human" | "agent", display_name: x.display_name as string, is_root: x.is_root as number, email: x.email as string,
      operator_id: x.operator_id as string | null, state: x.i_state as "active", created_at: x.i_created_at as number,
    },
  }));
}
```

`src/db/invites.ts`:
```ts
import { randomToken, sha256Hex, ulid } from "../ids";
import { badRequest } from "../errors";
import { createIdentity, getIdentityByEmail, normalizeEmail } from "./identities";
import { addMembership } from "./memberships";
import type { Identity, Invite, Role } from "./types";

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const ROLES: Role[] = ["root", "admin", "member", "reader"];

export async function createInvite(
  db: D1Database,
  input: { tenant_id: string | null; email: string; role: Role; display_name: string | null; created_by: string | null },
  now: number,
): Promise<{ invite: Invite; token: string }> {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw badRequest("invalid email");
  if (!ROLES.includes(input.role)) throw badRequest("invalid role");
  if (input.role === "root" && input.tenant_id !== null) throw badRequest("root invites have no tenant");
  if (input.role !== "root" && input.tenant_id === null) throw badRequest("tenant required");
  const token = randomToken("pmi_");
  const invite: Invite = {
    id: ulid(now), tenant_id: input.tenant_id, email, role: input.role, display_name: input.display_name,
    token_hash: await sha256Hex(token), created_by: input.created_by, created_at: now, expires_at: now + INVITE_TTL_MS,
    accepted_at: null, accepted_session_id: null, revoked_at: null,
  };
  await db.prepare(
    "INSERT INTO invite (id, tenant_id, email, role, display_name, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(invite.id, invite.tenant_id, invite.email, invite.role, invite.display_name, invite.token_hash, invite.created_by, invite.created_at, invite.expires_at).run();
  return { invite, token };
}

export async function findInviteByToken(db: D1Database, token: string): Promise<Invite | null> {
  return db.prepare("SELECT * FROM invite WHERE token_hash = ?").bind(await sha256Hex(token)).first<Invite>();
}

export function inviteIsOpen(invite: Invite, now: number): boolean {
  return invite.accepted_at === null && invite.revoked_at === null && invite.expires_at > now;
}

export async function acceptInvite(db: D1Database, invite: Invite, now: number): Promise<{ identity: Identity; created: boolean } | null> {
  if (!inviteIsOpen(invite, now)) return null;
  const claim = await db.prepare(
    "UPDATE invite SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
  ).bind(now, invite.id, now).run();
  if (claim.meta.changes !== 1) return null;

  let identity = await getIdentityByEmail(db, invite.email);
  let created = false;
  if (!identity) {
    identity = await createIdentity(db, {
      kind: "human", email: invite.email, display_name: invite.display_name ?? invite.email.split("@")[0]!,
      is_root: invite.role === "root" ? 1 : 0, operator_id: null,
    }, now);
    created = true;
  } else if (invite.role === "root" && identity.is_root !== 1) {
    await db.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(identity.id).run();
    identity = { ...identity, is_root: 1 };
  }
  if (invite.role !== "root" && invite.tenant_id !== null) {
    await addMembership(db, { identity_id: identity.id, tenant_id: invite.tenant_id, role: invite.role }, now);
  }
  return { identity, created };
}

export async function setInviteAcceptedSession(db: D1Database, invite_id: string, session_id: string): Promise<void> {
  await db.prepare("UPDATE invite SET accepted_session_id = ? WHERE id = ?").bind(session_id, invite_id).run();
}

export async function revokeInvite(db: D1Database, id: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE invite SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND accepted_at IS NULL").bind(now, id).run();
  return r.meta.changes === 1;
}

export async function listInvites(db: D1Database, tenant_id: string): Promise<Invite[]> {
  const r = await db.prepare("SELECT * FROM invite WHERE tenant_id = ? ORDER BY created_at DESC").bind(tenant_id).all<Invite>();
  return r.results;
}
```

Note on atomicity: the single conditional `UPDATE` on `accepted_at` is the claim. Two concurrent accepts race only on that statement; the loser gets `changes = 0` and returns `null` before touching identity or membership. The follow-up inserts are idempotent (`INSERT OR IGNORE` for membership, unique email for identity).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/db-identity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/identities.ts src/db/memberships.ts src/db/invites.ts test/db-identity.test.ts
git commit -m "feat: identity, membership, invite repositories"
```

---

### Task 8: Browser sessions and the session cookie

**Files:**
- Create: `src/db/sessions.ts`, `src/auth/cookie.ts`, `test/sessions.test.ts`

**Interfaces:**
- Consumes: `ulid`, `randomToken`, `sha256Hex` from `src/ids.ts`; `Session` from `src/db/types.ts`.
- Produces:
  - `SESSION_ROLLING_MS = 180 days`, `SESSION_MAX_MS = 365 days`, `SESSION_TOUCH_INTERVAL_MS = 1 hour`.
  - `createBrowserSession(db, identity_id, now): Promise<{ session: Session; token: string }>` (token prefix `pms_`, `last_proof_at = now`).
  - `getSessionByToken(db, token, now): Promise<Session | null>` returning only unrevoked, unexpired sessions.
  - `touchSession(db, session, now): Promise<Session>` which, when `now - last_seen_at >= 1 hour`, sets `last_seen_at = now` and `expires_at = min(now + 180d, created_at + 365d)`; otherwise returns the row unchanged.
  - `revokeSession(db, id, now): Promise<boolean>`; `listSessions(db, identity_id, now): Promise<Session[]>` (active only, newest first); `setLastProof(db, id, now)`.
  - `COOKIE_NAME = "pmw_session"`; `sessionCookie(token: string, hubDomain: string): string` (a `Set-Cookie` header value); `clearSessionCookie(hubDomain: string): string`; `readSessionToken(request: Request): string | null`.

- [ ] **Step 1: Write the failing test**

`test/sessions.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/db/identities";
import {
  SESSION_MAX_MS, SESSION_ROLLING_MS, createBrowserSession, getSessionByToken, listSessions, revokeSession, touchSession,
} from "../src/db/sessions";
import { COOKIE_NAME, clearSessionCookie, readSessionToken, sessionCookie } from "../src/auth/cookie";

const db = () => env.HUB_DB;
const now = 1_700_000_000_000;
const HOUR = 3600 * 1000;

async function ident() {
  return createIdentity(db(), { kind: "human", email: "a@example.com", display_name: "A", is_root: 0, operator_id: null }, now);
}

describe("sessions", () => {
  it("creates and finds by token; token is not stored", async () => {
    const id = await ident();
    const { session, token } = await createBrowserSession(db(), id.id, now);
    expect(token).toMatch(/^pms_/);
    expect(session.kind).toBe("browser");
    expect(session.last_proof_at).toBe(now);
    expect(session.expires_at).toBe(now + SESSION_ROLLING_MS);
    expect((await getSessionByToken(db(), token, now + 1))?.id).toBe(session.id);
    expect(await getSessionByToken(db(), "pms_bogus", now)).toBeNull();
  });

  it("is invisible after expiry or revocation", async () => {
    const id = await ident();
    const { session, token } = await createBrowserSession(db(), id.id, now);
    expect(await getSessionByToken(db(), token, now + SESSION_ROLLING_MS)).toBeNull();
    expect(await revokeSession(db(), session.id, now + 1)).toBe(true);
    expect(await revokeSession(db(), session.id, now + 2)).toBe(false);
    expect(await getSessionByToken(db(), token, now + 3)).toBeNull();
    expect(await listSessions(db(), id.id, now + 4)).toEqual([]);
  });

  it("touch refreshes at most hourly and respects the absolute cap", async () => {
    const id = await ident();
    const { session } = await createBrowserSession(db(), id.id, now);
    const same = await touchSession(db(), session, now + HOUR - 1);
    expect(same.last_seen_at).toBe(now);
    const moved = await touchSession(db(), session, now + HOUR);
    expect(moved.last_seen_at).toBe(now + HOUR);
    expect(moved.expires_at).toBe(now + HOUR + SESSION_ROLLING_MS);
    const late = await touchSession(db(), moved, now + SESSION_MAX_MS - HOUR);
    expect(late.expires_at).toBe(now + SESSION_MAX_MS);
  });
});

describe("cookie", () => {
  it("sets a hub-wide secure cookie and clears it", () => {
    const v = sessionCookie("pms_abc", "pimwell.test");
    expect(v).toContain(`${COOKIE_NAME}=pms_abc`);
    expect(v).toContain("Domain=.pimwell.test");
    expect(v).toContain("Secure");
    expect(v).toContain("HttpOnly");
    expect(v).toContain("SameSite=Lax");
    expect(v).toContain("Path=/");
    expect(clearSessionCookie("pimwell.test")).toContain("Max-Age=0");
  });
  it("omits Domain for localhost", () => {
    expect(sessionCookie("pms_abc", "localhost")).not.toContain("Domain=");
  });
  it("reads the token from the request", () => {
    const req = new Request("https://pimwell.test/", { headers: { cookie: `other=1; ${COOKIE_NAME}=pms_xyz; z=2` } });
    expect(readSessionToken(req)).toBe("pms_xyz");
    expect(readSessionToken(new Request("https://pimwell.test/"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sessions.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/db/sessions.ts`:
```ts
import { randomToken, sha256Hex, ulid } from "../ids";
import type { Session } from "./types";

export const SESSION_ROLLING_MS = 180 * 24 * 3600 * 1000;
export const SESSION_MAX_MS = 365 * 24 * 3600 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 3600 * 1000;

export async function createBrowserSession(db: D1Database, identity_id: string, now: number): Promise<{ session: Session; token: string }> {
  const token = randomToken("pms_");
  const session: Session = {
    id: ulid(now), identity_id, tenant_id: null, kind: "browser", label: null, token_hash: await sha256Hex(token),
    created_at: now, last_seen_at: now, expires_at: now + SESSION_ROLLING_MS, last_proof_at: now, revoked_at: null, parent_token_id: null,
  };
  await db.prepare(
    `INSERT INTO session (id, identity_id, tenant_id, kind, label, token_hash, created_at, last_seen_at, expires_at, last_proof_at, revoked_at, parent_token_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(session.id, session.identity_id, session.tenant_id, session.kind, session.label, session.token_hash,
    session.created_at, session.last_seen_at, session.expires_at, session.last_proof_at).run();
  return { session, token };
}

export async function getSessionByToken(db: D1Database, token: string, now: number): Promise<Session | null> {
  return db.prepare("SELECT * FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(await sha256Hex(token), now).first<Session>();
}

export async function touchSession(db: D1Database, session: Session, now: number): Promise<Session> {
  if (now - session.last_seen_at < SESSION_TOUCH_INTERVAL_MS) return session;
  const expires_at = Math.min(now + SESSION_ROLLING_MS, session.created_at + SESSION_MAX_MS);
  await db.prepare("UPDATE session SET last_seen_at = ?, expires_at = ? WHERE id = ?").bind(now, expires_at, session.id).run();
  return { ...session, last_seen_at: now, expires_at };
}

export async function revokeSession(db: D1Database, id: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
  return r.meta.changes === 1;
}

export async function listSessions(db: D1Database, identity_id: string, now: number): Promise<Session[]> {
  const r = await db.prepare(
    "SELECT * FROM session WHERE identity_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
  ).bind(identity_id, now).all<Session>();
  return r.results;
}

export async function setLastProof(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(now, id).run();
}
```

`src/auth/cookie.ts`:
```ts
export const COOKIE_NAME = "pmw_session";

function domainAttr(hubDomain: string): string {
  return hubDomain === "localhost" ? "" : `; Domain=.${hubDomain}`;
}

export function sessionCookie(token: string, hubDomain: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 3600}${domainAttr(hubDomain)}`;
}

export function clearSessionCookie(hubDomain: string): string {
  return `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0${domainAttr(hubDomain)}`;
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}
```

The cookie `Max-Age` is the absolute cap; the real expiry is the server row. Chrome and Firefox accept `Secure` cookies from `http://localhost`, so local dev works unchanged.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/sessions.ts src/auth/cookie.ts test/sessions.test.ts
git commit -m "feat: browser sessions with rolling expiry and session cookie"
```

---

### Task 9: Request context

**Files:**
- Create: `src/auth/context.ts`, `test/context.test.ts`

**Interfaces:**
- Consumes: `classifyHost`, `HostKind` from `src/tenant.ts`; `getTenantBySlug`; `getSessionByToken`, `touchSession`; `getIdentityById`; `getMembership`; `readSessionToken`.
- Produces:
  - `type Ctx = { env: Env; db: D1Database; now: number; host: HostKind; tenant: Tenant | null; identity: Identity | null; session: Session | null; role: Role | null; authKind: "cookie" | "bearer" | null; staleCookie: boolean }`.
  - `buildContext(request: Request, env: Env, now?: number): Promise<Ctx>`.
  - `roleFor(identity: Identity | null, membership: Membership | null): Role | null` (root flag wins, then membership role, else null).
  - `rank(role: Role | null): number` (root 4, admin 3, member 2, reader 1, null 0).

Rules: a bearer token with prefix `pms_` is looked up as a session; `Authorization` wins over the cookie when both are present. `tenant` is set only when the host is a tenant label, the tenant row exists, and is active. `role` is set only when identity, tenant, and an active membership exist, or the identity is root. `staleCookie` is true when a cookie was present but resolved to no session, so the response can clear it.

- [ ] **Step 1: Write the failing test**

`test/context.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContext, rank, roleFor } from "../src/auth/context";
import { createTenant, setTenantState } from "../src/db/tenants";
import { createIdentity } from "../src/db/identities";
import { addMembership } from "../src/db/memberships";
import { createBrowserSession, revokeSession } from "../src/db/sessions";
import { COOKIE_NAME } from "../src/auth/cookie";

const db = () => env.HUB_DB;
const now = 1_700_000_000_000;

async function seed() {
  const tenant = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
  const identity = await createIdentity(db(), { kind: "human", email: "a@example.com", display_name: "A", is_root: 0, operator_id: null }, now);
  await addMembership(db(), { identity_id: identity.id, tenant_id: tenant.id, role: "admin" }, now);
  const { session, token } = await createBrowserSession(db(), identity.id, now);
  return { tenant, identity, session, token };
}

describe("buildContext", () => {
  it("resolves tenant, identity and role from a cookie", async () => {
    const s = await seed();
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.host).toEqual({ kind: "tenant", slug: "acme" });
    expect(ctx.tenant?.id).toBe(s.tenant.id);
    expect(ctx.identity?.id).toBe(s.identity.id);
    expect(ctx.role).toBe("admin");
    expect(ctx.authKind).toBe("cookie");
    expect(ctx.staleCookie).toBe(false);
  });

  it("prefers a bearer session token and reports no role off-tenant", async () => {
    const s = await seed();
    const req = new Request("https://pimwell.test/", { headers: { authorization: `Bearer ${s.token}`, cookie: `${COOKIE_NAME}=pms_stale` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.authKind).toBe("bearer");
    expect(ctx.identity?.id).toBe(s.identity.id);
    expect(ctx.tenant).toBeNull();
    expect(ctx.role).toBeNull();
  });

  it("treats a revoked session cookie as anonymous and flags it stale", async () => {
    const s = await seed();
    await revokeSession(db(), s.session.id, now + 1);
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 2);
    expect(ctx.identity).toBeNull();
    expect(ctx.staleCookie).toBe(true);
  });

  it("archived tenant resolves to no tenant", async () => {
    const s = await seed();
    await setTenantState(db(), s.tenant.id, "archived", now + 1);
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 2);
    expect(ctx.tenant).toBeNull();
    expect(ctx.role).toBeNull();
  });

  it("root gets role root on any tenant without a membership", async () => {
    const tenant = await createTenant(db(), { slug: "blue", display_name: "Blue" }, now);
    const root = await createIdentity(db(), { kind: "human", email: "r@example.com", display_name: "R", is_root: 1, operator_id: null }, now);
    const { token } = await createBrowserSession(db(), root.id, now);
    const req = new Request("https://blue.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.tenant?.id).toBe(tenant.id);
    expect(ctx.role).toBe("root");
  });
});

describe("roleFor and rank", () => {
  it("orders roles", () => {
    expect(rank("root") > rank("admin") && rank("admin") > rank("member") && rank("member") > rank("reader") && rank("reader") > rank(null)).toBe(true);
    expect(roleFor(null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/context.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/auth/context.ts`:
```ts
import type { Env } from "../env";
import { classifyHost, type HostKind } from "../tenant";
import { getTenantBySlug } from "../db/tenants";
import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import { getSessionByToken, touchSession } from "../db/sessions";
import { readSessionToken } from "./cookie";
import type { Identity, Membership, Role, Session, Tenant } from "../db/types";

export type Ctx = {
  env: Env;
  db: D1Database;
  now: number;
  host: HostKind;
  tenant: Tenant | null;
  identity: Identity | null;
  session: Session | null;
  role: Role | null;
  authKind: "cookie" | "bearer" | null;
  staleCookie: boolean;
};

const RANK: Record<Role, number> = { root: 4, admin: 3, member: 2, reader: 1 };

export function rank(role: Role | null): number {
  return role ? RANK[role] : 0;
}

export function roleFor(identity: Identity | null, membership: Membership | null): Role | null {
  if (!identity || identity.state !== "active") return null;
  if (identity.is_root === 1) return "root";
  if (membership && membership.state === "active") return membership.role;
  return null;
}

export async function buildContext(request: Request, env: Env, now: number = Date.now()): Promise<Ctx> {
  const db = env.HUB_DB;
  const host = classifyHost(request.headers.get("host"), env.HUB_DOMAIN);

  let tenant: Tenant | null = null;
  if (host.kind === "tenant") {
    const t = await getTenantBySlug(db, host.slug);
    tenant = t && t.state === "active" ? t : null;
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const cookieToken = readSessionToken(request);

  let session: Session | null = null;
  let authKind: Ctx["authKind"] = null;
  if (bearer && bearer.startsWith("pms_")) {
    session = await getSessionByToken(db, bearer, now);
    if (session) authKind = "bearer";
  } else if (cookieToken) {
    session = await getSessionByToken(db, cookieToken, now);
    if (session) authKind = "cookie";
  }
  const staleCookie = cookieToken !== null && authKind !== "bearer" && session === null;

  let identity: Identity | null = null;
  if (session) {
    session = await touchSession(db, session, now);
    identity = await getIdentityById(db, session.identity_id);
  }

  let role: Role | null = null;
  if (identity && tenant) {
    const membership = await getMembership(db, identity.id, tenant.id);
    role = roleFor(identity, membership);
  } else if (identity && identity.is_root === 1 && host.kind === "apex") {
    role = "root";
  }

  return { env, db, now, host, tenant, identity, session, role, authKind, staleCookie };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/context.ts test/context.test.ts
git commit -m "feat: request context with host, tenant, session, role resolution"
```

---

### Task 10: Verb table, params, and the API dispatcher

**Files:**
- Create: `src/verbs/table.ts`, `src/verbs/params.ts`, `src/http/api.ts`, `test/api.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Ctx`, `buildContext`, `rank`; `HubError`; `clearSessionCookie`.
- Produces:
  - `type VerbScope = "public" | "hub" | "tenant"`.
  - `type VerbDef<P, R> = { name: string; kind: "query" | "command"; scope: VerbScope; minRole: Role | "public"; freshProofMinutes: number | null; summary: string; parse: (input: Record<string, unknown>) => P; run: (ctx: Ctx, params: P) => Promise<R> }`.
  - `defineVerb<P, R>(def: VerbDef<P, R>): VerbDef<P, R>`; `registerVerbs(defs: VerbDef<any, any>[])`; `getVerb(name): VerbDef<any, any> | undefined`; `listVerbs(): VerbDef<any, any>[]`.
  - `src/verbs/params.ts`: `reqString(input, key, opts?: { max?: number }): string`; `optString(input, key, opts?): string | null`; `reqEnum<T extends string>(input, key, values: readonly T[]): T`; `optBool(input, key): boolean | null`. All throw `badRequest` with the key name.
  - `handleApi(request: Request, env: Env): Promise<Response>` mounted at `POST /api/:verb`. It accepts JSON or `application/x-www-form-urlencoded` bodies. Success: `200 {"ok":true,"result":...}`. Error: `{"ok":false,"error":reason,"detail":...}` with the `HubError` status. For form bodies on success it responds `303` to the `Referer` or `/`.

Dispatcher order: parse body → find verb (404 `unknown_verb`) → build context → scope check (`tenant` scope with `ctx.tenant === null` is 404 `not_found`; `hub` scope needs apex host, else 404) → CSRF: if `authKind === "cookie"`, the `Origin` header must equal `https://<host>` or the request is 403 `bad_origin` → auth: `minRole !== "public"` and no identity is 401 → role: `rank(ctx.role) < rank(minRole)` is 403 `forbidden` (for `hub` scope, `minRole: "root"` means `identity.is_root === 1`) → fresh proof: `freshProofMinutes !== null` and `authKind === "cookie"` and `now - session.last_proof_at > minutes*60_000` is 403 `reproof_required` → `parse` → `run`. Every response clears the cookie when `ctx.staleCookie`.

- [ ] **Step 1: Write the failing test**

`test/api.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineVerb, registerVerbs } from "../src/verbs/table";
import { reqString } from "../src/verbs/params";
import { createTenant } from "../src/db/tenants";
import { createIdentity } from "../src/db/identities";
import { addMembership } from "../src/db/memberships";
import { createBrowserSession } from "../src/db/sessions";
import { COOKIE_NAME } from "../src/auth/cookie";

const db = () => env.HUB_DB;
const HOUR = 3600 * 1000;

beforeAll(() => {
  registerVerbs([
    defineVerb({
      name: "test.echo", kind: "query", scope: "tenant", minRole: "member", freshProofMinutes: null, summary: "echo",
      parse: (i) => ({ msg: reqString(i, "msg", { max: 20 }) }),
      run: async (ctx, p) => ({ msg: p.msg, tenant: ctx.tenant!.slug, who: ctx.identity!.email }),
    }),
    defineVerb({
      name: "test.admin", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "admin",
      parse: () => ({}),
      run: async () => ({ done: true }),
    }),
    defineVerb({
      name: "test.open", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, summary: "open",
      parse: () => ({}),
      run: async () => ({ hi: true }),
    }),
  ]);
});

async function seed(role: "member" | "admin" = "member") {
  const tenant = await createTenant(db(), { slug: "acme", display_name: "Acme" }, Date.now());
  const identity = await createIdentity(db(), { kind: "human", email: "a@example.com", display_name: "A", is_root: 0, operator_id: null }, Date.now());
  await addMembership(db(), { identity_id: identity.id, tenant_id: tenant.id, role }, Date.now());
  const { session, token } = await createBrowserSession(db(), identity.id, Date.now());
  return { tenant, identity, session, token };
}

function post(host: string, verb: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://${host}/api/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("api dispatcher", () => {
  it("runs a public verb with no auth", async () => {
    const res = await post("pimwell.test", "test.open", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { hi: true } });
  });

  it("404s unknown verbs and unknown tenants alike", async () => {
    expect((await post("pimwell.test", "nope", {})).status).toBe(404);
    expect((await post("zzz.pimwell.test", "test.echo", { msg: "x" })).status).toBe(404);
  });

  it("requires auth, then role, with a bearer token", async () => {
    const s = await seed("member");
    expect((await post("acme.pimwell.test", "test.echo", { msg: "x" })).status).toBe(401);
    const ok = await post("acme.pimwell.test", "test.echo", { msg: "hi" }, { authorization: `Bearer ${s.token}` });
    expect(await ok.json()).toEqual({ ok: true, result: { msg: "hi", tenant: "acme", who: "a@example.com" } });
    const denied = await post("acme.pimwell.test", "test.admin", {}, { authorization: `Bearer ${s.token}` });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("forbidden");
  });

  it("rejects cookie auth without a matching Origin", async () => {
    const s = await seed("admin");
    const noOrigin = await post("acme.pimwell.test", "test.echo", { msg: "x" }, { cookie: `${COOKIE_NAME}=${s.token}` });
    expect(noOrigin.status).toBe(403);
    expect((await noOrigin.json()).error).toBe("bad_origin");
    const wrong = await post("acme.pimwell.test", "test.echo", { msg: "x" }, { cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://evil.example" });
    expect(wrong.status).toBe(403);
    const right = await post("acme.pimwell.test", "test.echo", { msg: "x" }, { cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test" });
    expect(right.status).toBe(200);
  });

  it("enforces fresh proof for cookie sessions", async () => {
    const s = await seed("admin");
    await db().prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60 * 1000, s.session.id).run();
    const stale = await post("acme.pimwell.test", "test.admin", {}, { cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test" });
    expect(stale.status).toBe(403);
    expect((await stale.json()).error).toBe("reproof_required");
    await db().prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 59 * 60 * 1000, s.session.id).run();
    const fresh = await post("acme.pimwell.test", "test.admin", {}, { cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test" });
    expect(fresh.status).toBe(200);
  });

  it("validates params", async () => {
    const s = await seed("member");
    const res = await post("acme.pimwell.test", "test.echo", { msg: "x".repeat(21) }, { authorization: `Bearer ${s.token}` });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain("msg");
  });

  it("accepts form bodies and redirects", async () => {
    const s = await seed("member");
    const res = await SELF.fetch("https://acme.pimwell.test/api/test.echo", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test", referer: "https://acme.pimwell.test/somewhere" },
      body: "msg=hi",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://acme.pimwell.test/somewhere");
  });

  it("clears a stale cookie", async () => {
    const res = await post("pimwell.test", "test.open", {}, { cookie: `${COOKIE_NAME}=pms_stale` });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the table and params**

`src/verbs/table.ts`:
```ts
import type { Ctx } from "../auth/context";
import type { Role } from "../db/types";

export type VerbScope = "public" | "hub" | "tenant";

export type VerbDef<P, R> = {
  name: string;
  kind: "query" | "command";
  scope: VerbScope;
  minRole: Role | "public";
  freshProofMinutes: number | null;
  summary: string;
  parse: (input: Record<string, unknown>) => P;
  run: (ctx: Ctx, params: P) => Promise<R>;
};

const REGISTRY = new Map<string, VerbDef<unknown, unknown>>();

export function defineVerb<P, R>(def: VerbDef<P, R>): VerbDef<P, R> {
  return def;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerVerbs(defs: Array<VerbDef<any, any>>): void {
  for (const d of defs) REGISTRY.set(d.name, d as VerbDef<unknown, unknown>);
}

export function getVerb(name: string): VerbDef<unknown, unknown> | undefined {
  return REGISTRY.get(name);
}

export function listVerbs(): VerbDef<unknown, unknown>[] {
  return [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}
```

`src/verbs/params.ts`:
```ts
import { badRequest } from "../errors";

type Input = Record<string, unknown>;

export function reqString(input: Input, key: string, opts: { max?: number } = {}): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) throw badRequest(`${key} is required`);
  if (opts.max !== undefined && v.length > opts.max) throw badRequest(`${key} is too long`);
  return v;
}

export function optString(input: Input, key: string, opts: { max?: number } = {}): string | null {
  const v = input[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw badRequest(`${key} must be a string`);
  if (opts.max !== undefined && v.length > opts.max) throw badRequest(`${key} is too long`);
  return v;
}

export function reqEnum<T extends string>(input: Input, key: string, values: readonly T[]): T {
  const v = input[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw badRequest(`${key} must be one of ${values.join(", ")}`);
  return v as T;
}

export function optBool(input: Input, key: string): boolean | null {
  const v = input[key];
  if (v === undefined || v === null || v === "") return null;
  if (v === true || v === "true" || v === "1" || v === "on") return true;
  if (v === false || v === "false" || v === "0" || v === "off") return false;
  throw badRequest(`${key} must be a boolean`);
}
```

- [ ] **Step 4: Implement the dispatcher and mount it**

`src/http/api.ts`:
```ts
import type { Env } from "../env";
import { buildContext, rank, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { HubError } from "../errors";
import { getVerb } from "../verbs/table";

async function readBody(request: Request): Promise<{ input: Record<string, unknown>; isForm: boolean }> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.startsWith("application/x-www-form-urlencoded") || ct.startsWith("multipart/form-data")) {
    const fd = await request.formData();
    const input: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) input[k] = typeof v === "string" ? v : "";
    return { input, isForm: true };
  }
  if (ct.startsWith("application/json")) {
    const text = await request.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HubError(400, "bad_request", "body must be a JSON object");
    return { input: parsed as Record<string, unknown>, isForm: false };
  }
  return { input: {}, isForm: false };
}

function finish(ctx: Ctx | null, env: Env, res: Response): Response {
  if (ctx?.staleCookie) res.headers.append("set-cookie", clearSessionCookie(env.HUB_DOMAIN));
  return res;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const name = url.pathname.slice("/api/".length);
  let ctx: Ctx | null = null;
  let isForm = false;
  try {
    const body = await readBody(request);
    isForm = body.isForm;
    const verb = getVerb(name);
    if (!verb) throw new HubError(404, "unknown_verb");
    ctx = await buildContext(request, env);

    if (verb.scope === "tenant" && !ctx.tenant) throw new HubError(404, "not_found");
    if (verb.scope === "hub" && ctx.host.kind !== "apex") throw new HubError(404, "not_found");

    if (ctx.authKind === "cookie") {
      const origin = request.headers.get("origin");
      const expected = `${url.protocol}//${url.host}`;
      if (origin !== expected) throw new HubError(403, "bad_origin");
    }

    if (verb.minRole !== "public") {
      if (!ctx.identity) throw new HubError(401, "unauthorized");
      const effective = verb.scope === "hub" ? (ctx.identity.is_root === 1 ? "root" : null) : ctx.role;
      if (rank(effective) < rank(verb.minRole)) throw new HubError(403, "forbidden");
      if (verb.freshProofMinutes !== null && ctx.authKind === "cookie" && ctx.session) {
        if (ctx.now - ctx.session.last_proof_at > verb.freshProofMinutes * 60_000) throw new HubError(403, "reproof_required");
      }
    }

    const params = verb.parse(body.input);
    const result = await verb.run(ctx, params);
    if (isForm) {
      const back = request.headers.get("referer") ?? `${url.protocol}//${url.host}/`;
      return finish(ctx, env, new Response(null, { status: 303, headers: { location: back } }));
    }
    return finish(ctx, env, json({ ok: true, result }, 200));
  } catch (e) {
    if (e instanceof HubError) return finish(ctx, env, json({ ok: false, error: e.reason, detail: e.detail ?? null }, e.status));
    if (e instanceof SyntaxError) return finish(ctx, env, json({ ok: false, error: "bad_request", detail: "invalid JSON" }, 400));
    console.error("verb failed", name, e instanceof Error ? e.message : String(e));
    return finish(ctx, env, json({ ok: false, error: "internal", detail: null }, 500));
  }
}
```

Replace `src/index.ts`:
```ts
import { Hono } from "hono";
import type { Env } from "./env";
import { handleApi } from "./http/api";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));
app.post("/api/*", (c) => handleApi(c.req.raw, c.env));

export default app;
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: all pass, including `test/api.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/table.ts src/verbs/params.ts src/http/api.ts src/index.ts test/api.test.ts
git commit -m "feat: verb table and POST /api dispatcher with role, origin, fresh-proof checks"
```

---

### Task 11: Bootstrap and whoami verbs

**Files:**
- Create: `src/verbs/bootstrap.ts`, `src/verbs/whoami.ts`, `src/verbs/index.ts`, `test/helpers.ts`, `test/bootstrap.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `defineVerb`, `registerVerbs`; `reqString`, `optString`; `timingSafeEqual`; `rootExists`; `createInvite`, `findInviteByToken`, `inviteIsOpen`; `listMembershipsForIdentity`; `recordEvent`.
- Produces:
  - `bootstrap` verb: scope `public`, minRole `public`, params `{ token, email, display_name }`. Behaviour: if `timingSafeEqual(token, env.HUB_BOOTSTRAP_TOKEN)` fails → 403 `forbidden`. If a root identity exists → 409 `conflict` "bootstrap already done". If an open root invite exists → 409 `conflict` "root invite pending". Otherwise create a root invite and return `{ invite_url: "https://<HUB_DOMAIN>/invite/<token>", expires_at }`. Records an event with `kind: "bootstrap"`.
  - `whoami` verb: scope `public`, minRole `public`, returns `{ identity: null }` when anonymous, else `{ identity: { id, email, display_name, is_root, kind }, session: { id, kind, created_at, last_proof_at }, tenant: { id, slug, role } | null, memberships: [{ slug, display_name, role }] }`.
  - `registerAllVerbs()` in `src/verbs/index.ts`, called once at module load in `src/index.ts`.
  - `test/helpers.ts`: `apiPost(host, verb, body, headers?)`, `seedTenant(slug)`, `seedHuman(email, { is_root?, memberships?: [{ tenant_id, role }] })` returning `{ identity, session, token }`, `cookieHeaders(token, host)` returning `{ cookie, origin }`.

- [ ] **Step 1: Write helpers and the failing test**

`test/helpers.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { COOKIE_NAME } from "../src/auth/cookie";
import { createTenant } from "../src/db/tenants";
import { createIdentity } from "../src/db/identities";
import { addMembership } from "../src/db/memberships";
import { createBrowserSession } from "../src/db/sessions";
import type { Role } from "../src/db/types";

export function apiPost(host: string, verb: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://${host}/api/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function seedTenant(slug: string) {
  return createTenant(env.HUB_DB, { slug, display_name: slug.toUpperCase() }, Date.now());
}

export async function seedHuman(email: string, opts: { is_root?: boolean; memberships?: Array<{ tenant_id: string; role: Role }> } = {}) {
  const identity = await createIdentity(env.HUB_DB, { kind: "human", email, display_name: email.split("@")[0]!, is_root: opts.is_root ? 1 : 0, operator_id: null }, Date.now());
  for (const m of opts.memberships ?? []) await addMembership(env.HUB_DB, { identity_id: identity.id, tenant_id: m.tenant_id, role: m.role }, Date.now());
  const { session, token } = await createBrowserSession(env.HUB_DB, identity.id, Date.now());
  return { identity, session, token };
}

export function cookieHeaders(token: string, host: string): Record<string, string> {
  return { cookie: `${COOKIE_NAME}=${token}`, origin: `https://${host}` };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
```

`test/bootstrap.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";
import { findInviteByToken } from "../src/db/invites";

describe("bootstrap", () => {
  it("rejects a wrong token", async () => {
    const res = await apiPost("pimwell.test", "bootstrap", { token: "wrong", email: "r@example.com", display_name: "Root" });
    expect(res.status).toBe(403);
  });

  it("creates a root invite once, then refuses", async () => {
    const res = await apiPost("pimwell.test", "bootstrap", { token: "test-bootstrap-token", email: "r@example.com", display_name: "Root" });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { invite_url: string } };
    expect(body.result.invite_url).toMatch(/^https:\/\/pimwell\.test\/invite\/pmi_/);
    const token = body.result.invite_url.split("/invite/")[1]!;
    const invite = await findInviteByToken(env.HUB_DB, token);
    expect(invite?.role).toBe("root");
    expect(invite?.tenant_id).toBeNull();
    const again = await apiPost("pimwell.test", "bootstrap", { token: "test-bootstrap-token", email: "r@example.com", display_name: "Root" });
    expect(again.status).toBe(409);
  });

  it("refuses once a root exists", async () => {
    await seedHuman("root@example.com", { is_root: true });
    const res = await apiPost("pimwell.test", "bootstrap", { token: "test-bootstrap-token", email: "r2@example.com", display_name: "R2" });
    expect(res.status).toBe(409);
  });
});

describe("whoami", () => {
  it("is null when anonymous", async () => {
    const res = await apiPost("pimwell.test", "whoami", {});
    expect(await res.json()).toEqual({ ok: true, result: { identity: null } });
  });

  it("describes identity, tenant role and memberships", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const res = await apiPost("acme.pimwell.test", "whoami", {}, bearer(h.token));
    const body = await res.json() as { result: any };
    expect(body.result.identity.email).toBe("a@example.com");
    expect(body.result.tenant).toEqual({ id: t.id, slug: "acme", role: "admin" });
    expect(body.result.memberships).toEqual([{ slug: "acme", display_name: "ACME", role: "admin" }]);
    expect(body.result.session.id).toBe(h.session.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bootstrap.test.ts`
Expected: FAIL, 404 unknown_verb.

- [ ] **Step 3: Implement**

`src/verbs/bootstrap.ts`:
```ts
import { defineVerb } from "./table";
import { reqString } from "./params";
import { timingSafeEqual } from "../ids";
import { conflict, forbidden } from "../errors";
import { rootExists } from "../db/identities";
import { createInvite } from "../db/invites";
import { recordEvent } from "../db/events";

export const bootstrap = defineVerb({
  name: "bootstrap",
  kind: "command",
  scope: "public",
  minRole: "public",
  freshProofMinutes: null,
  summary: "Create the first root invite using the bootstrap secret. Disabled once a root exists.",
  parse: (i) => ({ token: reqString(i, "token", { max: 512 }), email: reqString(i, "email", { max: 254 }), display_name: reqString(i, "display_name", { max: 80 }) }),
  run: async (ctx, p) => {
    if (!ctx.env.HUB_BOOTSTRAP_TOKEN || !timingSafeEqual(p.token, ctx.env.HUB_BOOTSTRAP_TOKEN)) throw forbidden();
    if (await rootExists(ctx.db)) throw conflict("bootstrap already done");
    const pending = await ctx.db.prepare(
      "SELECT 1 FROM invite WHERE role = 'root' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
    ).bind(ctx.now).first();
    if (pending) throw conflict("root invite pending");
    const { invite, token } = await createInvite(ctx.db, { tenant_id: null, email: p.email, role: "root", display_name: p.display_name, created_by: null }, ctx.now);
    await recordEvent(ctx.db, { tenant_id: null, identity_id: null, session_id: null, kind: "bootstrap", target_kind: "invite", target_id: invite.id, summary: "Root invite created by bootstrap" }, ctx.now);
    return { invite_url: `https://${ctx.env.HUB_DOMAIN}/invite/${token}`, expires_at: invite.expires_at };
  },
});
```

`src/verbs/whoami.ts`:
```ts
import { defineVerb } from "./table";
import { listMembershipsForIdentity } from "../db/memberships";

export const whoami = defineVerb({
  name: "whoami",
  kind: "query",
  scope: "public",
  minRole: "public",
  freshProofMinutes: null,
  summary: "Describe the caller: identity, session, role on this tenant, and memberships.",
  parse: () => ({}),
  run: async (ctx) => {
    if (!ctx.identity || !ctx.session) return { identity: null };
    const memberships = await listMembershipsForIdentity(ctx.db, ctx.identity.id);
    return {
      identity: { id: ctx.identity.id, email: ctx.identity.email, display_name: ctx.identity.display_name, is_root: ctx.identity.is_root === 1, kind: ctx.identity.kind },
      session: { id: ctx.session.id, kind: ctx.session.kind, created_at: ctx.session.created_at, last_proof_at: ctx.session.last_proof_at },
      tenant: ctx.tenant ? { id: ctx.tenant.id, slug: ctx.tenant.slug, role: ctx.role } : null,
      memberships: memberships.map((m) => ({ slug: m.tenant.slug, display_name: m.tenant.display_name, role: m.membership.role })),
    };
  },
});
```

`src/verbs/index.ts`:
```ts
import { registerVerbs } from "./table";
import { bootstrap } from "./bootstrap";
import { whoami } from "./whoami";

export function registerAllVerbs(): void {
  registerVerbs([bootstrap, whoami]);
}
```

In `src/index.ts`, add after the imports:
```ts
import { registerAllVerbs } from "./verbs/index";

registerAllVerbs();
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/verbs test/helpers.ts test/bootstrap.test.ts src/index.ts
git commit -m "feat: bootstrap and whoami verbs"
```

---

### Task 12: Tenant, namespace, and project verbs

**Files:**
- Create: `src/verbs/tenant.ts`, `src/verbs/namespace.ts`, `src/verbs/project.ts`, `test/verbs-objects.test.ts`
- Modify: `src/verbs/index.ts`

**Interfaces:**
- Consumes: repositories from Task 6; `recordEvent`; `reqString`, `optString`, `reqEnum`.
- Produces verbs (all `kind: "command"` unless noted):
  - `tenant.create` scope `hub`, minRole `root`, fresh 60, params `{ slug, display_name }` → `{ tenant }`.
  - `tenant.archive`, `tenant.unarchive` scope `hub`, minRole `root`, fresh 60, params `{ slug }` → `{ ok: true }`; 404 if no such tenant; 409 if already in that state.
  - `tenant.list` scope `hub`, minRole `root`, `kind: "query"`, params `{ state?: "active" | "archived" }` → `{ tenants }`.
  - `namespace.create` scope `tenant`, minRole `admin`, fresh 60, `{ slug, display_name }` → `{ namespace }`.
  - `namespace.archive`, `namespace.unarchive` scope `tenant`, minRole `admin`, fresh 60, `{ slug }`.
  - `project.create` scope `tenant`, minRole `member`, fresh null, `{ slug, kind, display_name, namespace? }` → `{ project }`. `namespace` is a namespace slug; it must be active or 409.
  - `project.archive`, `project.unarchive` scope `tenant`, minRole `admin`, fresh 60, `{ slug, namespace? }`.
  - `project.list` scope `tenant`, minRole `reader`, query, `{ state? }` → `{ namespaces, projects }`.
  Every command records an event `kind` equal to the verb name, `target_kind` of `tenant`, `namespace`, or `project`, and a summary like `Archived project research/site`.

- [ ] **Step 1: Write the failing test**

`test/verbs-objects.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";
import { listEvents } from "../src/db/events";
import { getTenantBySlug } from "../src/db/tenants";

describe("tenant verbs", () => {
  it("root creates, lists, archives and unarchives a tenant from the apex", async () => {
    const root = await seedHuman("r@example.com", { is_root: true });
    const made = await apiPost("pimwell.test", "tenant.create", { slug: "acme", display_name: "Acme" }, bearer(root.token));
    expect(made.status).toBe(200);
    const list = await apiPost("pimwell.test", "tenant.list", {}, bearer(root.token));
    expect(((await list.json()) as any).result.tenants.map((t: any) => t.slug)).toEqual(["acme"]);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "acme" }, bearer(root.token))).status).toBe(200);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "acme" }, bearer(root.token))).status).toBe(409);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "nope" }, bearer(root.token))).status).toBe(404);
    expect((await getTenantBySlug(env.HUB_DB, "acme"))?.state).toBe("archived");
    expect((await apiPost("pimwell.test", "tenant.unarchive", { slug: "acme" }, bearer(root.token))).status).toBe(200);
    const t = await getTenantBySlug(env.HUB_DB, "acme");
    const events = await listEvents(env.HUB_DB, t!.id, 10);
    expect(events.map((e) => e.kind)).toEqual(["tenant.unarchive", "tenant.archive", "tenant.create"]);
    expect(events[0]!.identity_id).toBe(root.identity.id);
    expect(events[0]!.session_id).toBe(root.session.id);
  });

  it("non-root cannot create tenants; tenant verbs are not served on a tenant host", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    expect((await apiPost("pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, bearer(admin.token))).status).toBe(403);
    const root = await seedHuman("r@example.com", { is_root: true });
    expect((await apiPost("acme.pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, bearer(root.token))).status).toBe(404);
  });
});

describe("namespace and project verbs", () => {
  it("admin creates a namespace, member creates projects, reader lists", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const reader = await seedHuman("v@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });

    expect((await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(member.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(admin.token))).status).toBe(200);

    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(reader.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(member.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "R Site", namespace: "research" }, bearer(member.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "x", kind: "repo", display_name: "X", namespace: "missing" }, bearer(member.token))).status).toBe(409);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "research", kind: "repo", display_name: "Clash" }, bearer(member.token))).status).toBe(409);

    const list = await apiPost("acme.pimwell.test", "project.list", {}, bearer(reader.token));
    const body = (await list.json()) as any;
    expect(body.result.namespaces.map((n: any) => n.slug)).toEqual(["research"]);
    expect(body.result.projects.map((p: any) => p.path)).toEqual(["research/site", "site"]);
  });

  it("archiving a namespace hides its projects; archive is admin only", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "a", kind: "repo", display_name: "A", namespace: "research" }, bearer(member.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "b", kind: "repo", display_name: "B" }, bearer(member.token));
    expect((await apiPost("acme.pimwell.test", "project.archive", { slug: "b" }, bearer(member.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "namespace.archive", { slug: "research" }, bearer(admin.token))).status).toBe(200);
    const active = (await (await apiPost("acme.pimwell.test", "project.list", {}, bearer(member.token))).json()) as any;
    expect(active.result.projects.map((p: any) => p.path)).toEqual(["b"]);
    const archived = (await (await apiPost("acme.pimwell.test", "project.list", { state: "archived" }, bearer(member.token))).json()) as any;
    expect(archived.result.projects.map((p: any) => p.path)).toEqual(["research/a"]);
    expect((await apiPost("acme.pimwell.test", "project.archive", { slug: "a", namespace: "research" }, bearer(admin.token))).status).toBe(409);
    expect((await apiPost("acme.pimwell.test", "project.unarchive", { slug: "a", namespace: "research" }, bearer(admin.token))).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verbs-objects.test.ts`
Expected: FAIL, 404 unknown_verb.

- [ ] **Step 3: Implement**

`src/verbs/tenant.ts`:
```ts
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { conflict, notFound } from "../errors";
import { createTenant, getTenantBySlug, listTenants, setTenantState } from "../db/tenants";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";
import type { State } from "../db/types";

async function setState(ctx: Ctx, slug: string, state: State, verb: string) {
  const t = await getTenantBySlug(ctx.db, slug);
  if (!t) throw notFound("no such tenant");
  if (t.state === state) throw conflict(`tenant already ${state}`);
  await setTenantState(ctx.db, t.id, state, ctx.now);
  await recordEvent(ctx.db, {
    tenant_id: t.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: verb, target_kind: "tenant", target_id: t.id,
    summary: `${state === "archived" ? "Archived" : "Unarchived"} tenant ${t.slug}`,
  }, ctx.now);
  return { ok: true };
}

export const tenantCreate = defineVerb({
  name: "tenant.create", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60,
  summary: "Create a tenant (root only).",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), display_name: reqString(i, "display_name", { max: 80 }) }),
  run: async (ctx, p) => {
    const tenant = await createTenant(ctx.db, p, ctx.now);
    await recordEvent(ctx.db, { tenant_id: tenant.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "tenant.create", target_kind: "tenant", target_id: tenant.id, summary: `Created tenant ${tenant.slug}` }, ctx.now);
    return { tenant };
  },
});

export const tenantArchive = defineVerb({
  name: "tenant.archive", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, summary: "Archive a tenant.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "archived", "tenant.archive"),
});

export const tenantUnarchive = defineVerb({
  name: "tenant.unarchive", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, summary: "Unarchive a tenant.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "active", "tenant.unarchive"),
});

export const tenantList = defineVerb({
  name: "tenant.list", kind: "query", scope: "hub", minRole: "root", freshProofMinutes: null, summary: "List tenants.",
  parse: (i) => ({ state: (optString(i, "state") ?? "active") as State }),
  run: async (ctx, p) => ({ tenants: await listTenants(ctx.db, p.state) }),
});
```

`src/verbs/namespace.ts`:
```ts
import { defineVerb } from "./table";
import { reqString } from "./params";
import { conflict, notFound } from "../errors";
import { createNamespace, getNamespaceBySlug, setNamespaceState } from "../db/namespaces";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";
import type { State } from "../db/types";

async function setState(ctx: Ctx, slug: string, state: State, verb: string) {
  const ns = await getNamespaceBySlug(ctx.db, ctx.tenant!.id, slug);
  if (!ns) throw notFound("no such namespace");
  if (ns.state === state) throw conflict(`namespace already ${state}`);
  await setNamespaceState(ctx.db, ns.id, state);
  await recordEvent(ctx.db, {
    tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: verb, target_kind: "namespace", target_id: ns.id,
    summary: `${state === "archived" ? "Archived" : "Unarchived"} namespace ${ns.slug}`,
  }, ctx.now);
  return { ok: true };
}

export const namespaceCreate = defineVerb({
  name: "namespace.create", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Create a namespace.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), display_name: reqString(i, "display_name", { max: 80 }) }),
  run: async (ctx, p) => {
    const namespace = await createNamespace(ctx.db, { tenant_id: ctx.tenant!.id, ...p }, ctx.now);
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "namespace.create", target_kind: "namespace", target_id: namespace.id, summary: `Created namespace ${namespace.slug}` }, ctx.now);
    return { namespace };
  },
});

export const namespaceArchive = defineVerb({
  name: "namespace.archive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Archive a namespace and its projects.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "archived", "namespace.archive"),
});

export const namespaceUnarchive = defineVerb({
  name: "namespace.unarchive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Unarchive a namespace and its projects.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "active", "namespace.unarchive"),
});
```

`src/verbs/project.ts`:
```ts
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { conflict, notFound } from "../errors";
import { getNamespaceBySlug, listNamespaces } from "../db/namespaces";
import { createProject, getProjectByPath, listProjects, setProjectState } from "../db/projects";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";
import type { Namespace, Project, State } from "../db/types";

function pathOf(p: Project, namespaces: Map<string, Namespace>): string {
  return p.namespace_id ? `${namespaces.get(p.namespace_id)?.slug ?? "?"}/${p.slug}` : p.slug;
}

async function resolveNamespace(ctx: Ctx, slug: string | null): Promise<Namespace | null> {
  if (slug === null) return null;
  const ns = await getNamespaceBySlug(ctx.db, ctx.tenant!.id, slug);
  if (!ns || ns.state !== "active") throw conflict("namespace missing or archived");
  return ns;
}

async function setState(ctx: Ctx, nsSlug: string | null, slug: string, state: State, verb: string) {
  const project = await getProjectByPath(ctx.db, ctx.tenant!.id, nsSlug, slug);
  if (!project) throw notFound("no such project");
  if (project.state === state) throw conflict(`project already ${state}`);
  await setProjectState(ctx.db, project.id, state);
  const path = nsSlug ? `${nsSlug}/${slug}` : slug;
  await recordEvent(ctx.db, {
    tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: verb, target_kind: "project", target_id: project.id,
    summary: `${state === "archived" ? "Archived" : "Unarchived"} project ${path}`,
  }, ctx.now);
  return { ok: true };
}

export const projectCreate = defineVerb({
  name: "project.create", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null, summary: "Create a project, optionally inside a namespace.",
  parse: (i) => ({
    slug: reqString(i, "slug", { max: 63 }), kind: reqString(i, "kind", { max: 20 }),
    display_name: reqString(i, "display_name", { max: 80 }), namespace: optString(i, "namespace", { max: 63 }),
  }),
  run: async (ctx, p) => {
    const ns = await resolveNamespace(ctx, p.namespace);
    const project = await createProject(ctx.db, { tenant_id: ctx.tenant!.id, namespace_id: ns?.id ?? null, slug: p.slug, kind: p.kind, display_name: p.display_name }, ctx.now);
    const path = ns ? `${ns.slug}/${project.slug}` : project.slug;
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "project.create", target_kind: "project", target_id: project.id, summary: `Created project ${path}` }, ctx.now);
    return { project: { ...project, path } };
  },
});

export const projectArchive = defineVerb({
  name: "project.archive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Archive a project.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), namespace: optString(i, "namespace", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.namespace, p.slug, "archived", "project.archive"),
});

export const projectUnarchive = defineVerb({
  name: "project.unarchive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Unarchive a project.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), namespace: optString(i, "namespace", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.namespace, p.slug, "active", "project.unarchive"),
});

export const projectList = defineVerb({
  name: "project.list", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null, summary: "List namespaces and projects by state.",
  parse: (i) => ({ state: (optString(i, "state") ?? "active") as State }),
  run: async (ctx, p) => {
    const all = new Map<string, Namespace>();
    for (const ns of [...(await listNamespaces(ctx.db, ctx.tenant!.id, "active")), ...(await listNamespaces(ctx.db, ctx.tenant!.id, "archived"))]) all.set(ns.id, ns);
    const namespaces = [...all.values()].filter((n) => n.state === p.state);
    const projects = (await listProjects(ctx.db, ctx.tenant!.id, p.state)).map((pr) => ({ ...pr, path: pathOf(pr, all) }));
    projects.sort((a, b) => a.path.localeCompare(b.path));
    return { namespaces, projects };
  },
});
```

Update `src/verbs/index.ts`:
```ts
import { registerVerbs } from "./table";
import { bootstrap } from "./bootstrap";
import { whoami } from "./whoami";
import { tenantArchive, tenantCreate, tenantList, tenantUnarchive } from "./tenant";
import { namespaceArchive, namespaceCreate, namespaceUnarchive } from "./namespace";
import { projectArchive, projectCreate, projectList, projectUnarchive } from "./project";

export function registerAllVerbs(): void {
  registerVerbs([
    bootstrap, whoami,
    tenantCreate, tenantArchive, tenantUnarchive, tenantList,
    namespaceCreate, namespaceArchive, namespaceUnarchive,
    projectCreate, projectArchive, projectUnarchive, projectList,
  ]);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/verbs test/verbs-objects.test.ts
git commit -m "feat: tenant, namespace, project verbs with archive"
```

---

### Task 13: Invite verbs and the invite acceptance page

**Files:**
- Create: `src/verbs/invite.ts`, `src/http/pages.ts`, `test/invite-flow.test.ts`
- Modify: `src/verbs/index.ts`, `src/index.ts`

**Interfaces:**
- Consumes: invite repository from Task 7; `createBrowserSession`; `sessionCookie`; `esc`, `page`, `htmlResponse`; `recordEvent`.
- Produces:
  - `invite.create` scope `tenant`, minRole `admin`, fresh 60, params `{ email, role: "admin" | "member" | "reader", display_name? }` → `{ invite_url, expires_at, invite_id }`. Records event `invite.create`. Root may also call it on a tenant host (root rank passes).
  - `invite.revoke` scope `tenant`, minRole `admin`, fresh 60, `{ invite_id }` → `{ ok: true }`; 404 if the invite is not in this tenant; 409 if already accepted or revoked.
  - `invite.list` scope `tenant`, minRole `admin`, query → `{ invites: [{ id, email, role, created_at, expires_at, status: "open" | "accepted" | "revoked" | "expired" }] }`. Never returns token hashes.
  - Pages in `src/http/pages.ts`: `invitePage(request, env): Promise<Response>` for `GET /invite/:token` and `acceptInvitePage(request, env): Promise<Response>` for `POST /invite/:token`, both on the apex host only (other hosts 404). `neutralInvitePage(): string` is the body shown for any invalid, expired, consumed, or revoked token, status 200.

Acceptance flow for `POST /invite/:token`: `Origin` must equal the apex origin (403 otherwise) → `findInviteByToken` → `acceptInvite` → on `null` show the neutral page → else `createBrowserSession`, `setInviteAcceptedSession`, record event `invite.accept` (tenant_id of the invite, identity and session of the new session), respond `303` to `https://<tenant>.<HUB_DOMAIN>/` (or `https://<HUB_DOMAIN>/` for a root invite) with `Set-Cookie`.

- [ ] **Step 1: Write the failing test**

`test/invite-flow.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { getIdentityByEmail } from "../src/db/identities";
import { getMembership } from "../src/db/memberships";
import { listEvents } from "../src/db/events";

async function makeInvite(role = "member") {
  const t = await seedTenant("acme");
  const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const res = await apiPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role, display_name: "New Person" }, bearer(admin.token));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { invite_url: string; invite_id: string } };
  return { t, admin, url: body.result.invite_url, invite_id: body.result.invite_id };
}

describe("invite verbs", () => {
  it("admin creates an apex invite link, lists it, revokes it", async () => {
    const { admin, url, invite_id } = await makeInvite();
    expect(url).toMatch(/^https:\/\/pimwell\.test\/invite\/pmi_/);
    const list = (await (await apiPost("acme.pimwell.test", "invite.list", {}, bearer(admin.token))).json()) as any;
    expect(list.result.invites).toHaveLength(1);
    expect(list.result.invites[0].status).toBe("open");
    expect(JSON.stringify(list)).not.toContain("token_hash");
    expect((await apiPost("acme.pimwell.test", "invite.revoke", { invite_id }, bearer(admin.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "invite.revoke", { invite_id }, bearer(admin.token))).status).toBe(409);
    const after = (await (await apiPost("acme.pimwell.test", "invite.list", {}, bearer(admin.token))).json()) as any;
    expect(after.result.invites[0].status).toBe("revoked");
  });

  it("members cannot invite; admins cannot invite roots", async () => {
    const t = await seedTenant("acme");
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    expect((await apiPost("acme.pimwell.test", "invite.create", { email: "x@example.com", role: "member" }, bearer(member.token))).status).toBe(403);
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    expect((await apiPost("acme.pimwell.test", "invite.create", { email: "x@example.com", role: "root" }, bearer(admin.token))).status).toBe(400);
  });

  it("another tenant's admin cannot revoke the invite", async () => {
    const { invite_id } = await makeInvite();
    const blue = await seedTenant("blue");
    const other = await seedHuman("b@example.com", { memberships: [{ tenant_id: blue.id, role: "admin" }] });
    expect((await apiPost("blue.pimwell.test", "invite.revoke", { invite_id }, bearer(other.token))).status).toBe(404);
  });
});

describe("invite acceptance page", () => {
  it("GET shows the tenant and a button without consuming; POST creates identity, membership, session", async () => {
    const { t, url } = await makeInvite();
    const get = await SELF.fetch(url);
    expect(get.status).toBe(200);
    const html = await get.text();
    expect(html).toContain("ACME");
    expect(html).toContain("<form");
    expect(await getIdentityByEmail(env.HUB_DB, "new@example.com")).toBeNull();

    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("https://acme.pimwell.test/");
    const cookie = post.headers.get("set-cookie")!;
    expect(cookie).toContain("pmw_session=pms_");
    const identity = await getIdentityByEmail(env.HUB_DB, "new@example.com");
    expect(identity?.display_name).toBe("New Person");
    expect((await getMembership(env.HUB_DB, identity!.id, t.id))?.role).toBe("member");
    const events = await listEvents(env.HUB_DB, t.id, 5);
    expect(events[0]!.kind).toBe("invite.accept");
    expect(events[0]!.identity_id).toBe(identity!.id);

    const token = cookie.split(";")[0]!.split("=")[1]!;
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, cookieHeaders(token, "acme.pimwell.test"))).json()) as any;
    expect(who.result.tenant.role).toBe("member");
  });

  it("second POST and concurrent POSTs yield exactly one session", async () => {
    const { url } = await makeInvite();
    const headers = { origin: "https://pimwell.test" };
    const [a, b] = await Promise.all([
      SELF.fetch(url, { method: "POST", redirect: "manual", headers }),
      SELF.fetch(url, { method: "POST", redirect: "manual", headers }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 303]);
    const again = await SELF.fetch(url, { method: "POST", redirect: "manual", headers });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("not valid");
    const sessions = await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM session").first<{ n: number }>();
    expect(sessions?.n).toBe(2);
  });

  it("bad tokens, wrong hosts, and bad origins", async () => {
    const { url } = await makeInvite();
    const bogus = await SELF.fetch("https://pimwell.test/invite/pmi_bogus");
    expect(bogus.status).toBe(200);
    expect(await bogus.text()).toContain("not valid");
    expect((await SELF.fetch(url.replace("https://pimwell.test", "https://acme.pimwell.test"))).status).toBe(404);
    expect((await SELF.fetch(url, { method: "POST", redirect: "manual" })).status).toBe(403);
  });

  it("a root invite lands on the apex", async () => {
    const res = await apiPost("pimwell.test", "bootstrap", { token: "test-bootstrap-token", email: "r@example.com", display_name: "Root" });
    const url = ((await res.json()) as any).result.invite_url as string;
    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("https://pimwell.test/");
    expect((await getIdentityByEmail(env.HUB_DB, "r@example.com"))?.is_root).toBe(1);
  });
});
```

Note: the test expects the admin's seeded session count plus the one accepted session to be 2 in the concurrency test, because `seedHuman` creates one session for the admin.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/invite-flow.test.ts`
Expected: FAIL, 404 unknown_verb.

- [ ] **Step 3: Implement the verbs**

`src/verbs/invite.ts`:
```ts
import { defineVerb } from "./table";
import { optString, reqEnum, reqString } from "./params";
import { conflict, notFound } from "../errors";
import { createInvite, inviteIsOpen, listInvites, revokeInvite } from "../db/invites";
import { recordEvent } from "../db/events";
import type { Invite } from "../db/types";

function status(i: Invite, now: number): "open" | "accepted" | "revoked" | "expired" {
  if (i.accepted_at !== null) return "accepted";
  if (i.revoked_at !== null) return "revoked";
  if (i.expires_at <= now) return "expired";
  return "open";
}

export const inviteCreate = defineVerb({
  name: "invite.create", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60,
  summary: "Create a single-use invite link for an email. The link is returned once and never emailed.",
  parse: (i) => ({
    email: reqString(i, "email", { max: 254 }),
    role: reqEnum(i, "role", ["admin", "member", "reader"] as const),
    display_name: optString(i, "display_name", { max: 80 }),
  }),
  run: async (ctx, p) => {
    const { invite, token } = await createInvite(ctx.db, { tenant_id: ctx.tenant!.id, email: p.email, role: p.role, display_name: p.display_name, created_by: ctx.identity!.id }, ctx.now);
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "invite.create", target_kind: "invite", target_id: invite.id, summary: `Invited ${invite.email} as ${invite.role}` }, ctx.now);
    return { invite_id: invite.id, invite_url: `https://${ctx.env.HUB_DOMAIN}/invite/${token}`, expires_at: invite.expires_at };
  },
});

export const inviteRevoke = defineVerb({
  name: "invite.revoke", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Revoke an open invite.",
  parse: (i) => ({ invite_id: reqString(i, "invite_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const invite = await ctx.db.prepare("SELECT * FROM invite WHERE id = ? AND tenant_id = ?").bind(p.invite_id, ctx.tenant!.id).first<Invite>();
    if (!invite) throw notFound("no such invite");
    if (!inviteIsOpen(invite, ctx.now)) throw conflict(`invite is ${status(invite, ctx.now)}`);
    await revokeInvite(ctx.db, invite.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "invite.revoke", target_kind: "invite", target_id: invite.id, summary: `Revoked invite for ${invite.email}` }, ctx.now);
    return { ok: true };
  },
});

export const inviteList = defineVerb({
  name: "invite.list", kind: "query", scope: "tenant", minRole: "admin", freshProofMinutes: null, summary: "List invites for this tenant.",
  parse: () => ({}),
  run: async (ctx) => ({
    invites: (await listInvites(ctx.db, ctx.tenant!.id)).map((i) => ({
      id: i.id, email: i.email, role: i.role, display_name: i.display_name, created_at: i.created_at, expires_at: i.expires_at, status: status(i, ctx.now),
    })),
  }),
});
```

Add to `src/verbs/index.ts` imports and the `registerVerbs` array: `import { inviteCreate, inviteList, inviteRevoke } from "./invite";` and `inviteCreate, inviteRevoke, inviteList,`.

- [ ] **Step 4: Implement the pages**

`src/http/pages.ts`:
```ts
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { classifyHost } from "../tenant";
import { acceptInvite, findInviteByToken, inviteIsOpen, setInviteAcceptedSession } from "../db/invites";
import { getTenantById } from "../db/tenants";
import { createBrowserSession } from "../db/sessions";
import { sessionCookie } from "../auth/cookie";
import { recordEvent } from "../db/events";

export function neutralInvitePage(): string {
  return page("Invite", `<h1>This invite link is not valid</h1><p>It may have expired, been used already, or been revoked. Ask the person who invited you for a new link.</p>`);
}

export function notFoundPage(): Response {
  return htmlResponse(page("Not found", `<h1>Not found</h1>`), 404);
}

function tokenFromPath(request: Request): string | null {
  const m = new URL(request.url).pathname.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
  return m ? m[1]! : null;
}

export async function invitePage(request: Request, env: Env): Promise<Response> {
  if (classifyHost(request.headers.get("host"), env.HUB_DOMAIN).kind !== "apex") return notFoundPage();
  const token = tokenFromPath(request);
  const now = Date.now();
  const invite = token ? await findInviteByToken(env.HUB_DB, token) : null;
  if (!invite || !inviteIsOpen(invite, now)) return htmlResponse(neutralInvitePage());
  const tenant = invite.tenant_id ? await getTenantById(env.HUB_DB, invite.tenant_id) : null;
  if (invite.tenant_id && (!tenant || tenant.state !== "active")) return htmlResponse(neutralInvitePage());
  const target = tenant ? `<strong>${esc(tenant.display_name)}</strong> as ${esc(invite.role)}` : `the hub as <strong>root</strong>`;
  const body = `<h1>You're invited</h1>
<p>Join ${target} with the address <strong>${esc(invite.email)}</strong>.</p>
<form method="post" action="/invite/${esc(token!)}"><button type="submit">Accept and sign in</button></form>`;
  return htmlResponse(page("Invite", body));
}

export async function acceptInvitePage(request: Request, env: Env): Promise<Response> {
  if (classifyHost(request.headers.get("host"), env.HUB_DOMAIN).kind !== "apex") return notFoundPage();
  const url = new URL(request.url);
  if (request.headers.get("origin") !== `${url.protocol}//${url.host}`) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
  const token = tokenFromPath(request);
  const now = Date.now();
  const invite = token ? await findInviteByToken(env.HUB_DB, token) : null;
  if (!invite) return htmlResponse(neutralInvitePage());
  if (invite.tenant_id) {
    const tenant = await getTenantById(env.HUB_DB, invite.tenant_id);
    if (!tenant || tenant.state !== "active") return htmlResponse(neutralInvitePage());
  }
  const accepted = await acceptInvite(env.HUB_DB, invite, now);
  if (!accepted) return htmlResponse(neutralInvitePage());
  const { session, token: sessionToken } = await createBrowserSession(env.HUB_DB, accepted.identity.id, now);
  await setInviteAcceptedSession(env.HUB_DB, invite.id, session.id);
  await recordEvent(env.HUB_DB, {
    tenant_id: invite.tenant_id, identity_id: accepted.identity.id, session_id: session.id, kind: "invite.accept", target_kind: "invite", target_id: invite.id,
    summary: `${accepted.identity.email} accepted invite as ${invite.role}`,
  }, now);
  let location = `https://${env.HUB_DOMAIN}/`;
  if (invite.tenant_id) {
    const tenant = await getTenantById(env.HUB_DB, invite.tenant_id);
    location = `https://${tenant!.slug}.${env.HUB_DOMAIN}/`;
  }
  return new Response(null, { status: 303, headers: { location, "set-cookie": sessionCookie(sessionToken, env.HUB_DOMAIN), "cache-control": "no-store" } });
}
```

In `src/index.ts` add:
```ts
import { acceptInvitePage, invitePage } from "./http/pages";

app.get("/invite/:token", (c) => invitePage(c.req.raw, c.env));
app.post("/invite/:token", (c) => acceptInvitePage(c.req.raw, c.env));
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/invite.ts src/verbs/index.ts src/http/pages.ts src/index.ts test/invite-flow.test.ts
git commit -m "feat: invite verbs and invite acceptance page"
```

---

### Task 14: Session verbs and the sessions page

**Files:**
- Create: `src/verbs/session.ts`, `test/session-verbs.test.ts`
- Modify: `src/verbs/index.ts`, `src/http/pages.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `listSessions`, `revokeSession`; `clearSessionCookie`; `recordEvent`.
- Produces:
  - `session.list` scope `public`, minRole `member`-equivalent: implemented as minRole `public` with an explicit identity check inside (`401` when anonymous) because it must work on the apex where there is no tenant role. Returns `{ sessions: [{ id, kind, label, created_at, last_seen_at, expires_at, last_proof_at, current: boolean }] }`.
  - `session.revoke` scope `public`, same auth rule, params `{ session_id }`: the session must belong to the caller, or the caller is root; else 404. Records event `session.revoke` with `tenant_id: null`.
  - `session.end` scope `public`, same auth rule, no params: revokes the current session and, for cookie auth, the response also clears the cookie. Records event `session.end`.
  - `sessionsPage(request, env)` for `GET /me/sessions` on the apex: lists the caller's sessions with a revoke form per row (`POST /api/session.revoke` with hidden `session_id`) and a sign-out form (`POST /api/session.end`). Anonymous callers get 401 with a plain page.

- [ ] **Step 1: Write the failing test**

`test/session-verbs.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedHuman } from "./helpers";
import { createBrowserSession, getSessionByToken } from "../src/db/sessions";

describe("session verbs", () => {
  it("lists own sessions and marks the current one", async () => {
    const h = await seedHuman("a@example.com");
    const other = await createBrowserSession(env.HUB_DB, h.identity.id, Date.now());
    const res = (await (await apiPost("pimwell.test", "session.list", {}, bearer(h.token))).json()) as any;
    expect(res.result.sessions).toHaveLength(2);
    expect(res.result.sessions.find((s: any) => s.id === h.session.id).current).toBe(true);
    expect(res.result.sessions.find((s: any) => s.id === other.session.id).current).toBe(false);
    expect((await apiPost("pimwell.test", "session.list", {})).status).toBe(401);
  });

  it("revokes own session, not another identity's", async () => {
    const a = await seedHuman("a@example.com");
    const b = await seedHuman("b@example.com");
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: b.session.id }, bearer(a.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: a.session.id }, bearer(a.token))).status).toBe(200);
    expect(await getSessionByToken(env.HUB_DB, a.token, Date.now())).toBeNull();
    const root = await seedHuman("r@example.com", { is_root: true });
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: b.session.id }, bearer(root.token))).status).toBe(200);
  });

  it("ends the current session and clears the cookie", async () => {
    const h = await seedHuman("a@example.com");
    const res = await apiPost("pimwell.test", "session.end", {}, cookieHeaders(h.token, "pimwell.test"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await getSessionByToken(env.HUB_DB, h.token, Date.now())).toBeNull();
  });

  it("serves the sessions page to a signed-in human", async () => {
    const h = await seedHuman("a@example.com");
    const res = await SELF.fetch("https://pimwell.test/me/sessions", { headers: { cookie: `pmw_session=${h.token}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(h.session.id);
    expect(html).toContain('action="/api/session.revoke"');
    expect(html).toContain('action="/api/session.end"');
    expect((await SELF.fetch("https://pimwell.test/me/sessions")).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-verbs.test.ts`
Expected: FAIL, 404 unknown_verb.

- [ ] **Step 3: Implement the verbs**

`src/verbs/session.ts`:
```ts
import { defineVerb } from "./table";
import { reqString } from "./params";
import { notFound, unauthorized } from "../errors";
import { listSessions, revokeSession } from "../db/sessions";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";
import type { Session } from "../db/types";

function requireIdentity(ctx: Ctx) {
  if (!ctx.identity || !ctx.session) throw unauthorized();
  return { identity: ctx.identity, session: ctx.session };
}

export const sessionList = defineVerb({
  name: "session.list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, summary: "List your active sessions.",
  parse: () => ({}),
  run: async (ctx) => {
    const { identity, session } = requireIdentity(ctx);
    const rows = await listSessions(ctx.db, identity.id, ctx.now);
    return {
      sessions: rows.map((s) => ({
        id: s.id, kind: s.kind, label: s.label, created_at: s.created_at, last_seen_at: s.last_seen_at,
        expires_at: s.expires_at, last_proof_at: s.last_proof_at, current: s.id === session.id,
      })),
    };
  },
});

export const sessionRevoke = defineVerb({
  name: "session.revoke", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, summary: "Revoke one of your sessions (root: any session).",
  parse: (i) => ({ session_id: reqString(i, "session_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity, session } = requireIdentity(ctx);
    const target = await ctx.db.prepare("SELECT * FROM session WHERE id = ?").bind(p.session_id).first<Session>();
    if (!target || (target.identity_id !== identity.id && identity.is_root !== 1)) throw notFound("no such session");
    await revokeSession(ctx.db, target.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: null, identity_id: identity.id, session_id: session.id, kind: "session.revoke", target_kind: "session", target_id: target.id, summary: `Revoked session ${target.id}` }, ctx.now);
    return { ok: true };
  },
});

export const sessionEnd = defineVerb({
  name: "session.end", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, summary: "Sign out: revoke the current session.",
  parse: () => ({}),
  run: async (ctx) => {
    const { identity, session } = requireIdentity(ctx);
    await revokeSession(ctx.db, session.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: null, identity_id: identity.id, session_id: session.id, kind: "session.end", target_kind: "session", target_id: session.id, summary: "Signed out" }, ctx.now);
    ctx.staleCookie = ctx.authKind === "cookie";
    return { ok: true };
  },
});
```

`session.end` sets `ctx.staleCookie` so the dispatcher's `finish` clears the cookie; no dispatcher change is needed.

Register in `src/verbs/index.ts`: `import { sessionEnd, sessionList, sessionRevoke } from "./session";` and add `sessionList, sessionRevoke, sessionEnd,` to the array.

- [ ] **Step 4: Add the page**

Append to `src/http/pages.ts`:
```ts
import { buildContext } from "../auth/context";
import { listSessions } from "../db/sessions";

export async function sessionsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  if (ctx.host.kind !== "apex") return notFoundPage();
  if (!ctx.identity || !ctx.session) return htmlResponse(page("Sign in", `<h1>Sign in required</h1>`), 401);
  const rows = await listSessions(env.HUB_DB, ctx.identity.id, ctx.now);
  const tr = rows.map((s) => `<tr>
<td>${esc(s.id)}${s.id === ctx.session!.id ? " (this one)" : ""}</td>
<td>${esc(s.kind)}</td>
<td>${new Date(s.created_at).toISOString()}</td>
<td>${new Date(s.last_seen_at).toISOString()}</td>
<td><form class="inline" method="post" action="/api/session.revoke"><input type="hidden" name="session_id" value="${esc(s.id)}"><button type="submit">Revoke</button></form></td>
</tr>`).join("");
  const body = `<h1>Your sessions</h1>
<p>${esc(ctx.identity.display_name)} &lt;${esc(ctx.identity.email)}&gt;</p>
<table><thead><tr><th>Id</th><th>Kind</th><th>Started</th><th>Last seen</th><th></th></tr></thead><tbody>${tr}</tbody></table>
<form method="post" action="/api/session.end"><button type="submit">Sign out</button></form>`;
  return htmlResponse(page("Sessions", body));
}
```
Move the two new imports to the top of the file with the others.

In `src/index.ts` add:
```ts
import { sessionsPage } from "./http/pages";
app.get("/me/sessions", (c) => sessionsPage(c.req.raw, c.env));
```
(merge the import with the existing `./http/pages` import).

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/session.ts src/verbs/index.ts src/http/pages.ts src/index.ts test/session-verbs.test.ts
git commit -m "feat: session list, revoke, end verbs and sessions page"
```

---

### Task 15: Apex home, tenant home, archive page, 404

**Files:**
- Create: `test/pages.test.ts`
- Modify: `src/http/pages.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `buildContext`; `listMembershipsForIdentity`; `listTenants`; `listNamespaces`, `listProjects`.
- Produces:
  - `homePage(request, env)` mounted at `GET /`. Apex, anonymous: a page titled "Pimwell" with one sentence "Sign in with an invite link." and status 200. Apex, signed in: "Your tenants" list, one link per active membership to `https://<slug>.<HUB_DOMAIN>/`, plus for roots a "All tenants" section listing every active tenant, plus a link to `/me/sessions`. Tenant host: requires `ctx.role` (else 404, same as unknown tenant); shows tenant display name, the caller's role, namespaces and active projects as `path` text, and a link to `/archive`.
  - `archivePage(request, env)` mounted at `GET /archive` on tenant hosts: archived namespaces and projects, same auth rule.
  - Every unmatched route returns `notFoundPage()`, including on unknown hosts.

- [ ] **Step 1: Write the failing test**

`test/pages.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";

const cookie = (token: string) => ({ cookie: `pmw_session=${token}` });

describe("pages", () => {
  it("apex anonymous and signed-in", async () => {
    const anon = await SELF.fetch("https://pimwell.test/");
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain("invite link");
    const t = await seedTenant("acme");
    await seedTenant("blue");
    const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const html = await (await SELF.fetch("https://pimwell.test/", { headers: cookie(h.token) })).text();
    expect(html).toContain("https://acme.pimwell.test/");
    expect(html).not.toContain("https://blue.pimwell.test/");
    expect(html).toContain("/me/sessions");
    const root = await seedHuman("r@example.com", { is_root: true });
    const rootHtml = await (await SELF.fetch("https://pimwell.test/", { headers: cookie(root.token) })).text();
    expect(rootHtml).toContain("https://blue.pimwell.test/");
  });

  it("tenant home requires membership and shows projects", async () => {
    const t = await seedTenant("acme");
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const stranger = await seedHuman("s@example.com");
    await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(member.token));
    expect((await SELF.fetch("https://acme.pimwell.test/")).status).toBe(404);
    expect((await SELF.fetch("https://acme.pimwell.test/", { headers: cookie(stranger.token) })).status).toBe(404);
    const html = await (await SELF.fetch("https://acme.pimwell.test/", { headers: cookie(member.token) })).text();
    expect(html).toContain("ACME");
    expect(html).toContain("member");
    expect(html).toContain("site");
    expect(html).toContain('href="/archive"');
  });

  it("archive page lists archived projects only", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await apiPost("acme.pimwell.test", "project.create", { slug: "old", kind: "repo", display_name: "Old" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "new", kind: "repo", display_name: "New" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.archive", { slug: "old" }, bearer(admin.token));
    const html = await (await SELF.fetch("https://acme.pimwell.test/archive", { headers: cookie(admin.token) })).text();
    expect(html).toContain("old");
    expect(html).not.toContain(">new<");
  });

  it("unknown hosts and paths are 404", async () => {
    expect((await SELF.fetch("https://zzz.pimwell.test/")).status).toBe(404);
    expect((await SELF.fetch("https://evil.example/")).status).toBe(404);
    expect((await SELF.fetch("https://pimwell.test/nope")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pages.test.ts`
Expected: FAIL, `/` returns Hono's default 404.

- [ ] **Step 3: Implement**

Append to `src/http/pages.ts` (imports at top: `listMembershipsForIdentity` from `../db/memberships`, `listTenants` from `../db/tenants`, `listNamespaces` from `../db/namespaces`, `listProjects` from `../db/projects`, and `State` from `../db/types`):
```ts
function listSection(title: string, items: string[]): string {
  return `<h2>${esc(title)}</h2>` + (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : `<p>None.</p>`);
}

async function tenantListing(env: Env, tenant_id: string, state: State): Promise<string> {
  const namespaces = await listNamespaces(env.HUB_DB, tenant_id, state);
  const all = new Map([...namespaces, ...(await listNamespaces(env.HUB_DB, tenant_id, state === "active" ? "archived" : "active"))].map((n) => [n.id, n]));
  const projects = await listProjects(env.HUB_DB, tenant_id, state);
  const paths = projects.map((p) => (p.namespace_id ? `${all.get(p.namespace_id)?.slug ?? "?"}/${p.slug}` : p.slug)).sort();
  return listSection("Namespaces", namespaces.map((n) => esc(n.slug))) + listSection("Projects", paths.map((p) => `<code>${esc(p)}</code>`));
}

export async function homePage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind === "apex") {
    if (!ctx.identity) return htmlResponse(page("Pimwell", `<h1>Pimwell</h1><p>Sign in with an invite link.</p>`), 200, extra);
    const memberships = await listMembershipsForIdentity(env.HUB_DB, ctx.identity.id);
    let body = `<h1>Pimwell</h1><p>${esc(ctx.identity.display_name)} · <a href="/me/sessions">sessions</a></p>`;
    body += listSection("Your tenants", memberships.map((m) => `<a href="https://${esc(m.tenant.slug)}.${esc(env.HUB_DOMAIN)}/">${esc(m.tenant.display_name)}</a> (${esc(m.membership.role)})`));
    if (ctx.identity.is_root === 1) {
      const tenants = await listTenants(env.HUB_DB, "active");
      body += listSection("All tenants", tenants.map((t) => `<a href="https://${esc(t.slug)}.${esc(env.HUB_DOMAIN)}/">${esc(t.display_name)}</a>`));
    }
    return htmlResponse(page("Pimwell", body), 200, extra);
  }
  if (!ctx.tenant || !ctx.role) return notFoundPage();
  const body = `<h1>${esc(ctx.tenant.display_name)}</h1><p>You are ${esc(ctx.role)} · <a href="/archive">archive</a> · <a href="https://${esc(env.HUB_DOMAIN)}/">hub</a></p>` + (await tenantListing(env, ctx.tenant.id, "active"));
  return htmlResponse(page(ctx.tenant.display_name, body), 200, extra);
}

export async function archivePage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role) return notFoundPage();
  const body = `<h1>${esc(ctx.tenant.display_name)} archive</h1><p><a href="/">back</a></p>` + (await tenantListing(env, ctx.tenant.id, "archived"));
  return htmlResponse(page("Archive", body));
}
```
Also import `clearSessionCookie` from `../auth/cookie` at the top of `pages.ts`.

Update `src/index.ts` to its final phase 1 form:
```ts
import { Hono } from "hono";
import type { Env } from "./env";
import { handleApi } from "./http/api";
import { acceptInvitePage, archivePage, homePage, invitePage, notFoundPage, sessionsPage } from "./http/pages";
import { registerAllVerbs } from "./verbs/index";

registerAllVerbs();

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));
app.post("/api/*", (c) => handleApi(c.req.raw, c.env));
app.get("/", (c) => homePage(c.req.raw, c.env));
app.get("/archive", (c) => archivePage(c.req.raw, c.env));
app.get("/invite/:token", (c) => invitePage(c.req.raw, c.env));
app.post("/invite/:token", (c) => acceptInvitePage(c.req.raw, c.env));
app.get("/me/sessions", (c) => sessionsPage(c.req.raw, c.env));
app.notFound(() => notFoundPage());

export default app;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/http/pages.ts src/index.ts test/pages.test.ts
git commit -m "feat: apex home, tenant home, archive page, 404"
```

---

### Task 16: README, local run, and first deployment

**Files:**
- Create: `README.md`
- Modify: `wrangler.jsonc` (real D1 and KV ids)

**Interfaces:**
- Produces: a documented path from clone to a running staging deployment with one root and one tenant `blue`.

- [ ] **Step 1: Write the README**

`README.md`:
```markdown
# pimwell-hub

Control plane for the pimwell team hub: tenants, identities, sessions, invites.
Design: `docs/superpowers/specs/2026-10-06-identity-design.md`.

## Local

    npm install
    cp .dev.vars.example .dev.vars
    npm run migrate:local
    npm run dev

Then bootstrap the first root (the token is the one in `.dev.vars`):

    curl -s -X POST http://localhost:8787/api/bootstrap \
      -H 'content-type: application/json' \
      -d '{"token":"dev-bootstrap-token-change-me","email":"you@example.com","display_name":"You"}'

Open the returned `invite_url` (it will say `https://localhost/...`; use `http://localhost:8787/invite/<token>`),
accept, and you are root. Tenants are served at `http://<slug>.localhost:8787/`.

## Test

    npm test
    npm run typecheck

## Deploy

One-time, with an account that can create resources:

    npx wrangler d1 create pimwell-hub          # paste database_id into wrangler.jsonc
    npx wrangler kv namespace create RATE       # paste id into wrangler.jsonc
    npx wrangler secret put HUB_BOOTSTRAP_TOKEN # a long random string
    npm run migrate:remote
    npm run deploy

DNS: a proxied wildcard `A` or `AAAA` record for `*` and the apex must exist in the zone so the
two Workers routes receive traffic. Universal SSL covers `pimwell.com` and `*.pimwell.com`.

After deploy, bootstrap once against `https://pimwell.com/api/bootstrap` with the secret and accept the
invite in a browser. To call verbs from the terminal, copy the `pmw_session` cookie value from the browser
and send it with a matching `Origin` header:

    curl -s -X POST https://pimwell.com/api/tenant.create \
      -H 'content-type: application/json' -H 'origin: https://pimwell.com' \
      -b 'pmw_session=<cookie value>' \
      -d '{"slug":"blue","display_name":"Blue"}'

## Verbs

`POST /api/<verb>` with a JSON body. Responses are `{"ok":true,"result":...}` or
`{"ok":false,"error":"<reason>","detail":...}`. Auth is the `pmw_session` cookie (with a matching
`Origin` header) or `Authorization: Bearer pms_...` for a session token.

| Verb | Host | Role | Fresh proof |
| --- | --- | --- | --- |
| bootstrap | apex | public (secret) | |
| whoami | any | public | |
| tenant.create, tenant.archive, tenant.unarchive, tenant.list | apex | root | 60 min |
| namespace.create, namespace.archive, namespace.unarchive | tenant | admin | 60 min |
| project.create | tenant | member | |
| project.archive, project.unarchive | tenant | admin | 60 min |
| project.list | tenant | reader | |
| invite.create, invite.revoke, invite.list | tenant | admin | 60 min |
| session.list, session.revoke, session.end | any | signed in | |

Phase 1 has no re-proof flow; a session older than 60 minutes cannot run the fresh-proof verbs
until phase 2 adds magic links. Accept a new invite to get a fresh session in the meantime.
```

- [ ] **Step 2: Create cloud resources and fill in ids**

Run, with the user's Cloudflare login (`npx wrangler login` if needed):
```bash
npx wrangler d1 create pimwell-hub
npx wrangler kv namespace create RATE
```
Paste the printed `database_id` and KV `id` into `wrangler.jsonc`, replacing the two placeholder strings. If the user has not yet authorised deployment, stop here, commit the README, and report that Step 2 onward needs their login.

- [ ] **Step 3: Set the secret, migrate, deploy**

```bash
openssl rand -base64 48 | npx wrangler secret put HUB_BOOTSTRAP_TOKEN
npm run migrate:remote
npm run deploy
```
Expected: `wrangler deploy` prints both routes. If it errors on `/memberships` with an account-owned token, switch to the user-owned login for this step and record the failure in the README's Deploy section.

- [ ] **Step 4: Smoke test**

```bash
curl -s https://pimwell.com/healthz            # ok
curl -s https://blue.pimwell.com/              # 404 page (tenant does not exist yet)
```
Then bootstrap with the secret value, accept the invite in a browser, confirm `https://pimwell.com/` shows the signed-in apex, and create tenant `blue` with the cookie-based `curl` from the README. Confirm `https://blue.pimwell.com/` renders for the root.

- [ ] **Step 5: Commit**

```bash
git add README.md wrangler.jsonc
git commit -m "docs: README with local, test, and deploy steps; real resource ids"
```

---

## Self-review notes

- Spec coverage for phase 1: tenants, namespaces, projects, archive (Tasks 6, 12, 15); identity and memberships (Task 7); invites out-of-band with GET/POST split (Tasks 7, 13); browser sessions with rolling expiry and hub-wide cookie (Task 8); CSRF origin rule, fresh-proof enforcement from the table, enumeration-neutral responses (Tasks 10, 13); `whoami` and bootstrap (Task 11); events on every write (Tasks 12, 13, 14); routing and reserved labels (Task 5); README and deploy (Task 16). Consent, magic links, agents, api tokens, and admin pages are phases 2 to 4 as the spec says; their tables exist from Task 2 so later migrations are additive.
- Deviations from the spec, deliberate: `session.list`, `session.revoke`, and `session.end` are `scope: "public"` with an internal identity check so they work on the apex where no tenant role exists. `tenant.list` is added (the spec lists `tenant.create` and archive only) because the root home page needs it and the verb table rule says every surface comes from a verb.
- Review Focus items are pinned by: host case and port (Task 5 test), double and concurrent accept (Task 7 and Task 13 tests), existing-identity invite (Task 7 test), slug collision both directions (Task 6 test), stale cookie (Task 9 and Task 10 tests).
