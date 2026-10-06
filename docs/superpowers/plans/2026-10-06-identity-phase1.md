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
