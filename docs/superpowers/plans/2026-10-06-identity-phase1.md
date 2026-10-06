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
    const fresh = (await findInviteByToken(db(), "x")) ?? invite;
    expect(await acceptInvite(db(), fresh, now + 20)).toBeNull();
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
