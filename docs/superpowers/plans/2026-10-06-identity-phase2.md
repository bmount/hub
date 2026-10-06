# Pimwell Identity Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email-based sign-in for the hub: a consent ledger, outbound magic links from `/login`, inbound sign-in by writing to `login@` or `signup@`, the reproof flow that refreshes `last_proof_at`, and `email` proof rows.

**Architecture:** Three new repositories (`consent`, `auth_link`, `proof`) over the existing phase 1 tables. One mail module owns every outbound message: `sendMail` checks consent, builds a hand-written RFC 5322 message, and either replies to an inbound message or sends through the `MAIL` binding. `src/auth/login.ts` holds the link state machine (issue, open, consume) shared by the HTML pages, the `login.*` verbs, and the Worker's new `email` handler. Rate limits are fixed hourly windows in the `RATE` KV namespace.

**Tech Stack:** TypeScript, Wrangler 4, Hono 4, D1, Workers KV, `send_email` binding and `cloudflare:email` `EmailMessage`, Vitest with `@cloudflare/vitest-pool-workers`. No new npm dependencies; MIME is built by hand.

**Spec:** `docs/superpowers/specs/2026-10-06-identity-design.md` (sections 6.2, 6.3, 6.4, 6.6, 6.7, 9, 10, 12 phase 2, and the Amendments section)

## Global Constraints

- "The hub may send email to address X only if a `consent` row for X exists with `revoked_at` null." Consent is checked in one function, `hasActiveConsent`, and enforced in one place, `sendMail` in `src/mail/send.ts`; "there is no other path to the `MAIL` binding" (spec 6.2, 10).
- In v1 consent is created only by "an inbound email from X to `login@` or `signup@pimwell.com` that Cloudflare delivered ... and that the Worker matched to a known identity." Consent is per address, not per tenant (spec 6.2).
- Magic links: "random 256-bit values, stored hashed, never logged"; 15-minute expiry; single use; `purpose` in {`login`, `reproof`}; consumed on POST, never GET (spec 6.3, 10).
- "No account enumeration: login, invite, and auth pages respond identically for unknown, expired, and consumed inputs." `POST /login` "always responds 'if that address is known and has consented, a link is on its way.'" (spec 6.3, 10).
- Rate limits: "3 sends per address per hour, 20 per IP per hour, stored in KV. Exceeding limits still returns the neutral response." Inbound mail processing is limited per sender with the same address bucket (spec 6.3, 10).
- Logs never contain email bodies, magic-link tokens, or raw bearer tokens. Log only error names, never messages or addresses (spec 3).
- The Worker "does not parse `Authentication-Results`". Cloudflare's SPF/DKIM gate plus the `reply` DMARC gate are the trust boundary (spec 6.4).
- `reply()` works only on DMARC-passing mail, only to the original sender, only from the receiving domain, once per message. If it throws, consent is still recorded, no link is sent, and an event is recorded (spec 6.4).
- Tenant isolation: tenant-scoped queries filter on `tenant_id`; unknown, archived, or non-member tenants return 404 on pages and tenant-scoped verbs (spec 5, 7).
- Fresh proof: 60 minutes for admin changes, tokens, and agents; 600 minutes for MCP client approval (future spec, not built). Fresh proof applies to commands on sessions of kind `browser`, by cookie or bearer (spec 6.7, Amendments).
- Archived identities are treated as signed out everywhere: no link, no consent, no inbound reply (spec 4.5).
- Every write records an `event` row with identity and session where one exists (spec 4.7).
- No organization, department, or person names in code, config, examples, or commits. Examples use tenants `acme` and `blue` and addresses at `example.com` (spec 3).
- Plain SQL only; no schema change is needed in this phase (tables `consent`, `auth_link`, `proof` exist in `migrations/0001_init.sql`).
- Commit after every task. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
  ```

## Review Focus

1. Address case and whitespace: an envelope sender `A@Example.COM` or a form entry ` A@Example.com` must match the stored lowercase identity and its consent. Tests in Task 3 and Task 7.
2. Link scanners: a GET or HEAD of `/auth/<token>` (corporate mail prefetch) must never consume the link. Test in Task 4.
3. A reproof link opened in another browser or a phone mail app must not be consumed, must say where to open it, and must still work in the browser that asked. Test in Task 4.
4. Two concurrent POSTs of the same sign-in link must produce exactly one session; the loser sees the neutral page. Test in Task 4.
5. `next` must not become an open redirect: a URL, a reserved label, or a tenant the identity does not belong to lands on the apex switcher. Test in Task 4.

---

## Decisions locked in by this plan

- **MIME:** hand-built in `src/mail/mime.ts` (plain text, 7bit, CRLF, header-injection checks). No `mimetext` dependency.
- **Outbound call shape:** first `env.MAIL.send(new EmailMessage(from, to, raw))` with the same MIME used for replies. It is verified to work in the local runtime (the builder shape `env.MAIL.send({ from, to, subject, text })` is rejected locally with "could not parse email"). Fallback, if the deployed smoke test in Task 10 shows production rejecting raw sends to unverified recipients: replace that one line in `sendMail` with `await env.MAIL.send({ from, to, subject: mail.subject, text: mail.text });`.
- **Binding:** `"send_email": [{ "name": "MAIL", "allowed_sender_addresses": ["login@pimwell.com"] }]`.
- **Test seam:** `setTestTransport` in `src/mail/send.ts` replaces only the `MAIL` call. Tests that need to read an outbound message call page or API handlers directly (`loginPostPage`, `handleApi`) rather than through `SELF`, so the test and the handler share one module instance. Replies always go through the (fake) inbound message's `reply`.
- **`next`:** carried as `?next=<tenant slug>` on the link URL, validated with `isValidTenantSlug`, honored only if the identity is root or an active member of that active tenant. No migration.
- **Login link in a browser already signed in as the same identity:** refresh `last_proof_at` on that session instead of minting a new one. This is also how a human without consent re-proves: write to `login@`, open the reply's link in the same browser.
- **`login.verify` over the API** returns the new browser session token in the JSON body (`session_token`), since the API cannot set cookies. For a reproof link it returns `session_token: null`.

## Out of scope for this phase

`/me` consent page (phase 3 builds `/me`), Turnstile, agent sessions, `membership.set_role`, DMARC `p=reject` (after the smoke test passes, Task 10 records it as a follow-up).

## File Structure

```
wrangler.jsonc               + send_email MAIL binding (Task 2)
src/env.ts                   + MAIL: SendEmail (Task 2)
src/index.ts                 + /login, /auth/:token routes; default export { fetch, email } (Tasks 4, 5, 7)
src/db/types.ts              + LinkPurpose, AuthLink, Consent, ProofKind, Proof (Task 1)
src/db/consent.ts            consent ledger: grant, active check, list, revoke (Task 1)
src/db/authLinks.ts          auth_link create, find, open check, atomic claim (Task 1)
src/db/proofs.ts             proof rows (Task 1)
src/http/pages.ts            invite acceptance records an email proof (Task 1)
src/mail/mime.ts             buildMime, safeMessageId (Task 2)
src/mail/send.ts             sendMail: the only outbound path; setTestTransport (Task 2)
src/rate.ts                  takeRate: hourly KV counters (Task 3)
src/auth/login.ts            requestLink, issueLink, openLink, consumeLink, landingUrl, cleanNext (Tasks 3, 4)
src/auth/context.ts          + Ctx.ip (Task 5)
src/http/login.ts            /login and /auth/<token> pages (Tasks 4, 5)
site/index.html              + "Sign in" link in the closing section (Task 5)
src/verbs/login.ts           login.request, login.verify (Task 6)
src/verbs/consent.ts         consent.list, consent.revoke (Task 9)
src/verbs/index.ts           register new verbs (Tasks 6, 9)
src/mail/inbound.ts          handleEmail for login@ and signup@ (Task 7)
src/http/api.ts              form posts that need reproof redirect to /login?reproof=1 (Task 8)
scripts/email-routing.sh     idempotent Email Routing rules via the Cloudflare API (Task 10)
README.md                    sign-in, reproof, email setup (Tasks 8, 9, 10)
test/db-auth.test.ts         Task 1
test/mail.test.ts            Task 2
test/login-request.test.ts   Task 3
test/auth-link.test.ts       Task 4
test/login-page.test.ts      Task 5
test/login-verbs.test.ts     Task 6
test/inbound.test.ts         Task 7
test/reproof.test.ts         Task 8
test/consent-verbs.test.ts   Task 9
```

Existing names this plan relies on (phase 1, do not rename): `normalizeEmail`, `getIdentityByEmail`, `getIdentityById`, `createIdentity` (`src/db/identities.ts`); `createBrowserSession`, `getSessionByToken`, `setLastProof` (`src/db/sessions.ts`); `getMembership` (`src/db/memberships.ts`); `getTenantBySlug` (`src/db/tenants.ts`); `recordEvent` (`src/db/events.ts`); `randomToken`, `sha256Hex`, `ulid` (`src/ids.ts`); `isValidTenantSlug`, `classifyHost` (`src/tenant.ts`); `esc`, `page`, `htmlResponse` (`src/html.ts`); `buildContext`, `Ctx` (`src/auth/context.ts`); `sessionCookie`, `clearSessionCookie`, `COOKIE_NAME` (`src/auth/cookie.ts`); `defineVerb`, `registerVerbs` (`src/verbs/table.ts`); `reqString`, `optString`, `optBool` (`src/verbs/params.ts`); `HubError`, `badRequest`, `notFound`, `unauthorized` (`src/errors.ts`); `notFoundPage` (`src/http/pages.ts`); `handleApi` (`src/http/api.ts`); test helpers `apiPost`, `seedTenant`, `seedHuman`, `cookieHeaders`, `bearer` (`test/helpers.ts`).

Run every test command from the worktree root. `npx vitest run <file>` runs one file; `npm test` runs all; `npm run typecheck` runs `tsc --noEmit`.

---

### Task 1: Consent, auth link, and proof repositories

**Files:**
- Modify: `src/db/types.ts` (append types)
- Create: `src/db/consent.ts`, `src/db/authLinks.ts`, `src/db/proofs.ts`
- Modify: `src/http/pages.ts` (`acceptInvitePage`: record an email proof)
- Test: `test/db-auth.test.ts`

**Interfaces:**
- Consumes: `normalizeEmail` from `src/db/identities.ts`; `randomToken`, `sha256Hex`, `ulid` from `src/ids.ts`.
- Produces:
  - Types in `src/db/types.ts`: `LinkPurpose = "login" | "reproof"`; `AuthLink = { id; identity_id; token_hash; purpose: LinkPurpose; created_at; expires_at; used_at: number | null }`; `Consent = { id; email; tenant_id: string | null; kind: string; granted_at; revoked_at: number | null; source_message_id: string | null; evidence: string | null }`; `ProofKind = "email" | "google" | "passkey"`; `Proof = { id; identity_id; kind: ProofKind; subject; created_at }`.
  - `src/db/consent.ts`: `getActiveConsent(db, email): Promise<Consent | null>`, `hasActiveConsent(db, email): Promise<boolean>`, `grantConsent(db, { email, kind, source_message_id, evidence }, now): Promise<{ consent: Consent; created: boolean }>`, `listConsent(db, email): Promise<Consent[]>` (newest first), `revokeConsent(db, email, now): Promise<number>` (rows revoked).
  - `src/db/authLinks.ts`: `AUTH_LINK_TTL_MS = 900000`, `createAuthLink(db, identity_id, purpose, now): Promise<{ link: AuthLink; token: string }>` (token prefix `pml_`), `findAuthLinkByToken(db, token): Promise<AuthLink | null>`, `authLinkIsOpen(link, now): boolean`, `claimAuthLink(db, id, now): Promise<boolean>`.
  - `src/db/proofs.ts`: `recordProof(db, { identity_id, kind, subject }, now): Promise<Proof>`, `listProofs(db, identity_id): Promise<Proof[]>` (oldest first).

- [ ] **Step 1: Write the failing test**

`test/db-auth.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grantConsent, hasActiveConsent, listConsent, revokeConsent } from "../src/db/consent";
import { AUTH_LINK_TTL_MS, authLinkIsOpen, claimAuthLink, createAuthLink, findAuthLinkByToken } from "../src/db/authLinks";
import { listProofs, recordProof } from "../src/db/proofs";
import { getIdentityByEmail } from "../src/db/identities";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";

const db = () => env.HUB_DB;

describe("consent ledger", () => {
  it("grants once per address, normalizes case, revokes, and re-grants", async () => {
    const now = Date.now();
    expect(await hasActiveConsent(db(), "a@example.com")).toBe(false);
    const first = await grantConsent(db(), { email: " A@Example.com", kind: "inbound_email", source_message_id: "<m1@example.com>", evidence: null }, now);
    expect(first.created).toBe(true);
    expect(first.consent.email).toBe("a@example.com");
    expect(first.consent.tenant_id).toBeNull();
    const again = await grantConsent(db(), { email: "a@example.com", kind: "inbound_email", source_message_id: "<m2@example.com>", evidence: null }, now + 1);
    expect(again.created).toBe(false);
    expect(again.consent.id).toBe(first.consent.id);
    expect(await hasActiveConsent(db(), "A@EXAMPLE.COM")).toBe(true);
    expect(await revokeConsent(db(), "a@example.com", now + 2)).toBe(1);
    expect(await hasActiveConsent(db(), "a@example.com")).toBe(false);
    expect(await revokeConsent(db(), "a@example.com", now + 3)).toBe(0);
    const regranted = await grantConsent(db(), { email: "a@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, now + 4);
    expect(regranted.created).toBe(true);
    expect((await listConsent(db(), "a@example.com")).map((c) => c.revoked_at === null)).toEqual([true, false]);
  });
});

describe("auth links", () => {
  it("stores only the hash, expires after 15 minutes, and claims exactly once", async () => {
    const h = await seedHuman("a@example.com");
    const now = Date.now();
    const { link, token } = await createAuthLink(db(), h.identity.id, "login", now);
    expect(token).toMatch(/^pml_[A-Za-z0-9_-]{43}$/);
    const raw = await db().prepare("SELECT * FROM auth_link WHERE id = ?").bind(link.id).first<Record<string, unknown>>();
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(AUTH_LINK_TTL_MS).toBe(15 * 60 * 1000);
    expect(link.expires_at - link.created_at).toBe(AUTH_LINK_TTL_MS);
    const found = (await findAuthLinkByToken(db(), token))!;
    expect(found.id).toBe(link.id);
    expect(found.purpose).toBe("login");
    expect(authLinkIsOpen(found, now + AUTH_LINK_TTL_MS - 1)).toBe(true);
    expect(authLinkIsOpen(found, now + AUTH_LINK_TTL_MS)).toBe(false);
    const results = await Promise.all([claimAuthLink(db(), link.id, now + 1), claimAuthLink(db(), link.id, now + 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(authLinkIsOpen((await findAuthLinkByToken(db(), token))!, now + 2)).toBe(false);
    expect(await findAuthLinkByToken(db(), `pml_${"A".repeat(43)}`)).toBeNull();
  });

  it("will not claim an expired link", async () => {
    const h = await seedHuman("a@example.com");
    const now = Date.now();
    const { link } = await createAuthLink(db(), h.identity.id, "reproof", now);
    expect(await claimAuthLink(db(), link.id, now + AUTH_LINK_TTL_MS)).toBe(false);
  });
});

describe("proofs", () => {
  it("records an email proof", async () => {
    const h = await seedHuman("a@example.com");
    await recordProof(db(), { identity_id: h.identity.id, kind: "email", subject: "a@example.com" }, Date.now());
    expect((await listProofs(db(), h.identity.id)).map((p) => [p.kind, p.subject])).toEqual([["email", "a@example.com"]]);
  });

  it("accepting an invite records an email proof for a new identity", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const created = (await (await apiPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role: "member" }, bearer(admin.token))).json()) as { result: { invite_url: string } };
    const post = await SELF.fetch(created.result.invite_url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(303);
    const identity = (await getIdentityByEmail(db(), "new@example.com"))!;
    expect((await listProofs(db(), identity.id)).map((p) => [p.kind, p.subject])).toEqual([["email", "new@example.com"]]);
  });

  it("accepting an invite for an existing identity also records a proof", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const old = await seedHuman("old@example.com");
    const created = (await (await apiPost("acme.pimwell.test", "invite.create", { email: "old@example.com", role: "member" }, bearer(admin.token))).json()) as { result: { invite_url: string } };
    const post = await SELF.fetch(created.result.invite_url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(200);
    expect(await listProofs(db(), old.identity.id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db-auth.test.ts`
Expected: FAIL with "Failed to load url ../src/db/consent" (module does not exist).

- [ ] **Step 3: Add the row types**

Append to `src/db/types.ts`:
```ts
export type LinkPurpose = "login" | "reproof";
export type AuthLink = {
  id: string; identity_id: string; token_hash: string; purpose: LinkPurpose;
  created_at: number; expires_at: number; used_at: number | null;
};
export type Consent = {
  id: string; email: string; tenant_id: string | null; kind: string; granted_at: number;
  revoked_at: number | null; source_message_id: string | null; evidence: string | null;
};
export type ProofKind = "email" | "google" | "passkey";
export type Proof = { id: string; identity_id: string; kind: ProofKind; subject: string; created_at: number };
```

- [ ] **Step 4: Write the consent repository**

`src/db/consent.ts`:
```ts
import { ulid } from "../ids";
import { normalizeEmail } from "./identities";
import type { Consent } from "./types";

export function getActiveConsent(db: D1Database, email: string): Promise<Consent | null> {
  return db.prepare("SELECT * FROM consent WHERE email = ? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1")
    .bind(normalizeEmail(email)).first<Consent>();
}

// The consent rule (spec 6.2). sendMail is the only caller that gates delivery on it.
export async function hasActiveConsent(db: D1Database, email: string): Promise<boolean> {
  return (await getActiveConsent(db, email)) !== null;
}

export async function grantConsent(
  db: D1Database,
  input: { email: string; kind: string; source_message_id: string | null; evidence: string | null },
  now: number,
): Promise<{ consent: Consent; created: boolean }> {
  const existing = await getActiveConsent(db, input.email);
  if (existing) return { consent: existing, created: false };
  const row: Consent = {
    id: ulid(now), email: normalizeEmail(input.email), tenant_id: null, kind: input.kind, granted_at: now,
    revoked_at: null, source_message_id: input.source_message_id, evidence: input.evidence,
  };
  await db.prepare(
    "INSERT INTO consent (id, email, tenant_id, kind, granted_at, revoked_at, source_message_id, evidence) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)",
  ).bind(row.id, row.email, row.kind, row.granted_at, row.source_message_id, row.evidence).run();
  return { consent: row, created: true };
}

export async function listConsent(db: D1Database, email: string): Promise<Consent[]> {
  const r = await db.prepare("SELECT * FROM consent WHERE email = ? ORDER BY granted_at DESC, id DESC")
    .bind(normalizeEmail(email)).all<Consent>();
  return r.results;
}

export async function revokeConsent(db: D1Database, email: string, now: number): Promise<number> {
  const r = await db.prepare("UPDATE consent SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL")
    .bind(now, normalizeEmail(email)).run();
  return r.meta.changes;
}
```

- [ ] **Step 5: Write the auth link repository**

`src/db/authLinks.ts`:
```ts
import { randomToken, sha256Hex, ulid } from "../ids";
import type { AuthLink, LinkPurpose } from "./types";

export const AUTH_LINK_TTL_MS = 15 * 60 * 1000;

export async function createAuthLink(db: D1Database, identity_id: string, purpose: LinkPurpose, now: number): Promise<{ link: AuthLink; token: string }> {
  const token = randomToken("pml_");
  const link: AuthLink = {
    id: ulid(now), identity_id, token_hash: await sha256Hex(token), purpose,
    created_at: now, expires_at: now + AUTH_LINK_TTL_MS, used_at: null,
  };
  await db.prepare(
    "INSERT INTO auth_link (id, identity_id, token_hash, purpose, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
  ).bind(link.id, link.identity_id, link.token_hash, link.purpose, link.created_at, link.expires_at).run();
  return { link, token };
}

export async function findAuthLinkByToken(db: D1Database, token: string): Promise<AuthLink | null> {
  return db.prepare("SELECT * FROM auth_link WHERE token_hash = ?").bind(await sha256Hex(token)).first<AuthLink>();
}

export function authLinkIsOpen(link: AuthLink, now: number): boolean {
  return link.used_at === null && link.expires_at > now;
}

// Atomic single-use claim: exactly one concurrent caller sees true.
export async function claimAuthLink(db: D1Database, id: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE auth_link SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, id, now).run();
  return r.meta.changes === 1;
}
```

- [ ] **Step 6: Write the proof repository**

`src/db/proofs.ts`:
```ts
import { ulid } from "../ids";
import type { Proof, ProofKind } from "./types";

export async function recordProof(db: D1Database, input: { identity_id: string; kind: ProofKind; subject: string }, now: number): Promise<Proof> {
  const row: Proof = { id: ulid(now), identity_id: input.identity_id, kind: input.kind, subject: input.subject, created_at: now };
  await db.prepare("INSERT INTO proof (id, identity_id, kind, subject, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.identity_id, row.kind, row.subject, row.created_at).run();
  return row;
}

export async function listProofs(db: D1Database, identity_id: string): Promise<Proof[]> {
  const r = await db.prepare("SELECT * FROM proof WHERE identity_id = ? ORDER BY created_at, id").bind(identity_id).all<Proof>();
  return r.results;
}
```

- [ ] **Step 7: Record a proof on invite acceptance**

In `src/http/pages.ts` add the import:
```ts
import { recordProof } from "../db/proofs";
```
In `acceptInvitePage`, directly after the line `if (!accepted) return htmlResponse(neutralInvitePage());` insert:
```ts
  await recordProof(env.HUB_DB, { identity_id: accepted.identity.id, kind: "email", subject: accepted.identity.email }, now);
```
This covers both the new-identity branch and the existing-identity branch below it.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/db-auth.test.ts && npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/db/types.ts src/db/consent.ts src/db/authLinks.ts src/db/proofs.ts src/http/pages.ts test/db-auth.test.ts
git commit -F - <<'EOF'
feat: consent ledger, auth link, and proof repositories

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 2: MIME builder, the MAIL binding, and sendMail

**Files:**
- Modify: `wrangler.jsonc`, `src/env.ts`
- Create: `src/mail/mime.ts`, `src/mail/send.ts`
- Test: `test/mail.test.ts`

**Interfaces:**
- Consumes: `hasActiveConsent` (Task 1); `normalizeEmail`; `ulid`.
- Produces:
  - `Env.MAIL: SendEmail`.
  - `src/mail/mime.ts`: `MimeInput = { from; to; subject; text; messageId; date: Date; inReplyTo: string | null }`, `buildMime(m: MimeInput): string` (throws on unsafe header or non-ASCII body), `safeMessageId(v: string | null): string | null`.
  - `src/mail/send.ts`: `Outbound = { to: string; subject: string; text: string }`, `SendResult = "sent" | "no_consent" | "failed"`, `SentMail = { from; to; subject; text; raw }`, `senderAddress(env): string` (`login@<HUB_DOMAIN>`), `sendMail(env, mail: Outbound, now, opts?: { replyTo?: ForwardableEmailMessage }): Promise<SendResult>`, `setTestTransport(t: ((m: SentMail) => Promise<void>) | null): void`.

- [ ] **Step 1: Write the failing test**

`test/mail.test.ts`:
```ts
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { buildMime, safeMessageId } from "../src/mail/mime";
import { sendMail, setTestTransport, type SentMail } from "../src/mail/send";
import { grantConsent, revokeConsent } from "../src/db/consent";

const consent = (email: string) => grantConsent(env.HUB_DB, { email, kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
const base = { from: "login@pimwell.test", to: "a@example.com", subject: "s", text: "t", messageId: "<x1@pimwell.test>", date: new Date(Date.UTC(2026, 9, 6)), inReplyTo: null };

describe("buildMime", () => {
  it("builds a CRLF plain-text message with threading headers on replies", () => {
    const raw = buildMime({ ...base, subject: "Your Pimwell sign-in link", text: "line one\nline two", inReplyTo: "<orig@example.com>" });
    expect(raw).toContain("From: login@pimwell.test\r\n");
    expect(raw).toContain("To: a@example.com\r\n");
    expect(raw).toContain("Subject: Your Pimwell sign-in link\r\n");
    expect(raw).toContain("Message-ID: <x1@pimwell.test>\r\n");
    expect(raw).toContain("In-Reply-To: <orig@example.com>\r\n");
    expect(raw).toContain("References: <orig@example.com>\r\n");
    expect(raw).toContain("Auto-Submitted: auto-replied\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8\r\n");
    expect(raw).toContain("\r\n\r\nline one\r\nline two\r\n");
    expect(raw).not.toMatch(/[^\r]\n/);
  });

  it("marks non-replies auto-generated and omits threading headers", () => {
    const raw = buildMime(base);
    expect(raw).toContain("Auto-Submitted: auto-generated\r\n");
    expect(raw).not.toContain("In-Reply-To");
  });

  it("refuses header injection and non-ASCII bodies", () => {
    expect(() => buildMime({ ...base, subject: "s\r\nBcc: b@example.com" })).toThrow();
    expect(() => buildMime({ ...base, to: "a@example.com\nBcc: b@example.com" })).toThrow();
    expect(() => buildMime({ ...base, text: "café" })).toThrow();
  });

  it("accepts only well-formed message ids", () => {
    expect(safeMessageId(" <a.b@example.com> ")).toBe("<a.b@example.com>");
    expect(safeMessageId("<a b@example.com>")).toBeNull();
    expect(safeMessageId("<a@example.com>\r\nBcc: x")).toBeNull();
    expect(safeMessageId("a@example.com")).toBeNull();
    expect(safeMessageId(null)).toBeNull();
  });
});

describe("sendMail", () => {
  const sent: SentMail[] = [];
  afterEach(() => {
    sent.length = 0;
    setTestTransport(null);
  });
  const capture = () => setTestTransport(async (m) => { sent.push(m); });

  it("refuses without consent and never reaches the transport", async () => {
    capture();
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now())).toBe("no_consent");
    expect(sent).toHaveLength(0);
  });

  it("sends from login@ once consent exists, and stops after revoke", async () => {
    capture();
    await consent("a@example.com");
    expect(await sendMail(env, { to: "A@Example.com", subject: "s", text: "t" }, Date.now())).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toBe("login@pimwell.test");
    expect(sent[0]!.to).toBe("a@example.com");
    expect(sent[0]!.raw).toContain("Subject: s\r\n");
    expect(sent[0]!.raw).toMatch(/Message-ID: <[0-9A-Z]{26}@pimwell\.test>\r\n/);
    await revokeConsent(env.HUB_DB, "a@example.com", Date.now());
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now())).toBe("no_consent");
    expect(sent).toHaveLength(1);
  });

  it("reports failure without throwing", async () => {
    setTestTransport(async () => { throw new Error("boom"); });
    await consent("a@example.com");
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now())).toBe("failed");
    expect(await sendMail(env, { to: "a@example.com", subject: "café", text: "t" }, Date.now())).toBe("failed");
  });

  it("replies through the inbound message from the receiving address, gated by the same consent check", async () => {
    capture();
    const replies: Array<{ from: string; to: string }> = [];
    const message = {
      from: "a@example.com", to: "signup@pimwell.test", headers: new Headers({ "message-id": "<orig@example.com>" }),
      reply: async (m: EmailMessage) => { replies.push({ from: m.from, to: m.to }); return { messageId: "<r1@pimwell.test>" }; },
    } as unknown as ForwardableEmailMessage;
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now(), { replyTo: message })).toBe("no_consent");
    expect(replies).toHaveLength(0);
    await consent("a@example.com");
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now(), { replyTo: message })).toBe("sent");
    expect(replies).toEqual([{ from: "signup@pimwell.test", to: "a@example.com" }]);
    expect(sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail.test.ts`
Expected: FAIL with "Failed to load url ../src/mail/mime".

- [ ] **Step 3: Add the binding and the Env field**

In `wrangler.jsonc`, insert before `"kv_namespaces"`:
```jsonc
  "send_email": [{ "name": "MAIL", "allowed_sender_addresses": ["login@pimwell.com"] }],
```
`src/env.ts` becomes:
```ts
export type Env = {
  HUB_DB: D1Database;
  RATE: KVNamespace;
  MAIL: SendEmail;
  HUB_DOMAIN: string;
  HUB_BOOTSTRAP_TOKEN: string;
};
```

- [ ] **Step 4: Write the MIME builder**

`src/mail/mime.ts`:
```ts
export type MimeInput = {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  date: Date;
  inReplyTo: string | null;
};

const HEADER_SAFE = /^[\x20-\x7e]*$/;
const BODY_SAFE = /^[\t\r\n\x20-\x7e]*$/;
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/;

function header(name: string, value: string): string {
  if (!HEADER_SAFE.test(value)) throw new Error(`unsafe ${name} header`);
  return `${name}: ${value}`;
}

export function safeMessageId(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return MESSAGE_ID.test(t) ? t : null;
}

// Minimal RFC 5322 message: ASCII plain text, 7bit, CRLF line endings.
export function buildMime(m: MimeInput): string {
  if (!BODY_SAFE.test(m.text)) throw new Error("body must be ASCII");
  const lines = [
    header("From", m.from),
    header("To", m.to),
    header("Subject", m.subject),
    header("Date", m.date.toUTCString()),
    header("Message-ID", m.messageId),
  ];
  if (m.inReplyTo) lines.push(header("In-Reply-To", m.inReplyTo), header("References", m.inReplyTo));
  lines.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    `Auto-Submitted: ${m.inReplyTo ? "auto-replied" : "auto-generated"}`,
  );
  const body = m.text.replace(/\r?\n/g, "\r\n");
  return `${lines.join("\r\n")}\r\n\r\n${body}\r\n`;
}
```

- [ ] **Step 5: Write sendMail**

`src/mail/send.ts`:
```ts
import { EmailMessage } from "cloudflare:email";
import type { Env } from "../env";
import { ulid } from "../ids";
import { normalizeEmail } from "../db/identities";
import { hasActiveConsent } from "../db/consent";
import { buildMime, safeMessageId } from "./mime";

export type Outbound = { to: string; subject: string; text: string };
export type SendResult = "sent" | "no_consent" | "failed";
export type SentMail = { from: string; to: string; subject: string; text: string; raw: string };

let testTransport: ((m: SentMail) => Promise<void>) | null = null;

// Tests only: replaces the MAIL binding call. Replies still go through message.reply.
export function setTestTransport(t: ((m: SentMail) => Promise<void>) | null): void {
  testTransport = t;
}

export function senderAddress(env: Env): string {
  return `login@${env.HUB_DOMAIN}`;
}

// The only path to outbound mail (spec 10). Consent is checked here for both
// the MAIL binding and inbound replies.
export async function sendMail(env: Env, mail: Outbound, now: number, opts: { replyTo?: ForwardableEmailMessage } = {}): Promise<SendResult> {
  const reply = opts.replyTo ?? null;
  const to = normalizeEmail(reply ? reply.from : mail.to);
  if (!(await hasActiveConsent(env.HUB_DB, to))) return "no_consent";
  const from = reply ? reply.to.trim().toLowerCase() : senderAddress(env);
  try {
    const raw = buildMime({
      from, to, subject: mail.subject, text: mail.text,
      messageId: `<${ulid(now)}@${env.HUB_DOMAIN}>`, date: new Date(now),
      inReplyTo: reply ? safeMessageId(reply.headers.get("message-id")) : null,
    });
    if (reply) await reply.reply(new EmailMessage(from, reply.from, raw));
    else if (testTransport) await testTransport({ from, to, subject: mail.subject, text: mail.text, raw });
    else await env.MAIL.send(new EmailMessage(from, to, raw));
    return "sent";
  } catch (e) {
    console.log("mail delivery failed", reply ? "reply" : "send", e instanceof Error ? e.name : "unknown");
    return "failed";
  }
}
```

- [ ] **Step 6: Run tests and check the single-path rule**

Run: `npx vitest run test/mail.test.ts && npm test && npm run typecheck`
Expected: PASS. Miniflare picks up the new `send_email` binding from `wrangler.jsonc`; existing tests stay green.

Run: `grep -rn "MAIL\.\|\.reply(" src`
Expected: matches only in `src/mail/send.ts`.

- [ ] **Step 7: Commit**

```bash
git add wrangler.jsonc src/env.ts src/mail/mime.ts src/mail/send.ts test/mail.test.ts
git commit -F - <<'EOF'
feat: MAIL binding, hand-built MIME, and consent-gated sendMail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 3: Rate limits and issuing outbound links

**Files:**
- Create: `src/rate.ts`, `src/auth/login.ts`
- Test: `test/login-request.test.ts`

**Interfaces:**
- Consumes: `createAuthLink` (Task 1), `hasActiveConsent` (Task 1), `sendMail`, `setTestTransport`, `SentMail` (Task 2), `getIdentityByEmail`, `normalizeEmail`, `recordEvent`, `isValidTenantSlug`, `sha256Hex`.
- Produces:
  - `src/rate.ts`: `RATE_WINDOW_MS = 3600000`, `RATE_LIMITS = { addr: 3, ip: 20 }`, `RateBucket = "addr" | "ip"`, `takeRate(kv, bucket, subject, now): Promise<boolean>` (true means allowed and counted).
  - `src/auth/login.ts`: `NEUTRAL_LOGIN_MESSAGE: string`; `cleanNext(next: string | null | undefined): string | null`; `authUrl(env, token, next): string`; `linkMail(purpose, url): { subject; text }`; `LinkRequest = { email; purpose: LinkPurpose; ip; next: string | null; session_id: string | null }`; `issueLink(env, { identity, purpose, next, via: "outbound" | "inbound", session_id }, now): Promise<string>` (returns the URL); `requestLink(env, req: LinkRequest, now): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`test/login-request.test.ts`:
```ts
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authUrl, cleanNext, linkMail, requestLink } from "../src/auth/login";
import { setTestTransport, type SentMail } from "../src/mail/send";
import { grantConsent } from "../src/db/consent";
import { createIdentity } from "../src/db/identities";
import { takeRate } from "../src/rate";
import { seedHuman } from "./helpers";

const sent: SentMail[] = [];
beforeEach(() => setTestTransport(async (m) => { sent.push(m); }));
afterEach(() => {
  sent.length = 0;
  setTestTransport(null);
});

const consent = (email: string) => grantConsent(env.HUB_DB, { email, kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
const linkCount = async () => (await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM auth_link").first<{ n: number }>())!.n;
const ask = (email: string, ip = "198.51.100.1", now = Date.now(), next: string | null = null) =>
  requestLink(env, { email, purpose: "login", ip, next, session_id: null }, now);

describe("takeRate", () => {
  it("allows the limit per subject per hour, then refuses", async () => {
    const now = Date.now();
    const got = [];
    for (let i = 0; i < 4; i++) got.push(await takeRate(env.RATE, "addr", "a@example.com", now));
    expect(got).toEqual([true, true, true, false]);
    expect(await takeRate(env.RATE, "addr", "b@example.com", now)).toBe(true);
    expect(await takeRate(env.RATE, "addr", "a@example.com", now + 3600 * 1000)).toBe(true);
  });

  it("does not store the subject in the key", async () => {
    await takeRate(env.RATE, "addr", "a@example.com", Date.now());
    const keys = (await env.RATE.list()).keys.map((k) => k.name);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("example.com");
  });
});

describe("requestLink", () => {
  it("sends a 15-minute login link to a consented human", async () => {
    const h = await seedHuman("a@example.com");
    await consent("a@example.com");
    await ask(" A@Example.com", "198.51.100.1", Date.now(), "acme");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("a@example.com");
    expect(sent[0]!.from).toBe("login@pimwell.test");
    expect(sent[0]!.text).toMatch(/https:\/\/pimwell\.test\/auth\/pml_[A-Za-z0-9_-]{43}\?next=acme/);
    const row = await env.HUB_DB.prepare("SELECT identity_id, purpose, expires_at - created_at AS ttl FROM auth_link").first<{ identity_id: string; purpose: string; ttl: number }>();
    expect(row).toEqual({ identity_id: h.identity.id, purpose: "login", ttl: 15 * 60 * 1000 });
    const ev = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'auth_link.create'").first<{ summary: string }>();
    expect(ev!.summary).toBe("Issued login link (outbound)");
  });

  it("does nothing for unknown, unconsented, agent, archived, or malformed addresses", async () => {
    await seedHuman("quiet@example.com");
    const gone = await seedHuman("gone@example.com");
    await consent("gone@example.com");
    await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(gone.identity.id).run();
    await createIdentity(env.HUB_DB, { kind: "agent", email: "bot@acme.pimwell.test", display_name: "Bot", is_root: 0, operator_id: gone.identity.id }, Date.now());
    await consent("bot@acme.pimwell.test");
    for (const email of ["nobody@example.com", "quiet@example.com", "gone@example.com", "bot@acme.pimwell.test", "not-an-email", ""]) await ask(email);
    expect(sent).toHaveLength(0);
    expect(await linkCount()).toBe(0);
  });

  it("caps sends at 3 per address per hour across IPs", async () => {
    await seedHuman("a@example.com");
    await consent("a@example.com");
    const now = Date.now();
    for (let i = 0; i < 5; i++) await ask("a@example.com", `198.51.100.${i}`, now);
    expect(sent).toHaveLength(3);
    expect(await linkCount()).toBe(3);
    await ask("a@example.com", "198.51.100.9", now + 3600 * 1000);
    expect(sent).toHaveLength(4);
  });

  it("caps requests at 20 per IP per hour, counting unknown addresses", async () => {
    await seedHuman("a@example.com");
    await consent("a@example.com");
    const now = Date.now();
    for (let i = 0; i < 20; i++) await ask(`x${i}@example.com`, "203.0.113.7", now);
    await ask("a@example.com", "203.0.113.7", now);
    expect(sent).toHaveLength(0);
    await ask("a@example.com", "203.0.113.8", now);
    expect(sent).toHaveLength(1);
  });

  it("sends a reproof link with reproof wording", async () => {
    const h = await seedHuman("a@example.com");
    await consent("a@example.com");
    await requestLink(env, { email: "a@example.com", purpose: "reproof", ip: "198.51.100.1", next: null, session_id: h.session.id }, Date.now());
    expect(sent[0]!.subject).toBe("Confirm it's you on Pimwell");
    const ev = await env.HUB_DB.prepare("SELECT session_id FROM event WHERE kind = 'auth_link.create'").first<{ session_id: string }>();
    expect(ev!.session_id).toBe(h.session.id);
  });
});

describe("helpers", () => {
  it("cleanNext accepts only tenant slugs", () => {
    expect(cleanNext("acme")).toBe("acme");
    expect(cleanNext(" ACME ")).toBe("acme");
    expect(cleanNext("https://evil.example")).toBeNull();
    expect(cleanNext("login")).toBeNull();
    expect(cleanNext("")).toBeNull();
    expect(cleanNext(null)).toBeNull();
  });

  it("authUrl and linkMail", () => {
    expect(authUrl(env, "pml_x", null)).toBe("https://pimwell.test/auth/pml_x");
    expect(authUrl(env, "pml_x", "acme")).toBe("https://pimwell.test/auth/pml_x?next=acme");
    expect(linkMail("login", "https://pimwell.test/auth/pml_x").text).toContain("https://pimwell.test/auth/pml_x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/login-request.test.ts`
Expected: FAIL with "Failed to load url ../src/auth/login".

- [ ] **Step 3: Write the rate limiter**

`src/rate.ts`:
```ts
import { sha256Hex } from "./ids";

export const RATE_WINDOW_MS = 3600 * 1000;
export const RATE_LIMITS = { addr: 3, ip: 20 } as const;
export type RateBucket = keyof typeof RATE_LIMITS;

// Fixed hourly window in KV. Subjects are hashed so keys hold no addresses.
// KV is eventually consistent; a burst at the edge may slightly exceed the cap.
export async function takeRate(kv: KVNamespace, bucket: RateBucket, subject: string, now: number): Promise<boolean> {
  const window = Math.floor(now / RATE_WINDOW_MS);
  const key = `rl:${bucket}:${window}:${await sha256Hex(subject.trim().toLowerCase())}`;
  const used = Number((await kv.get(key)) ?? "0");
  if (used >= RATE_LIMITS[bucket]) return false;
  await kv.put(key, String(used + 1), { expirationTtl: 2 * 3600 });
  return true;
}
```

- [ ] **Step 4: Write link issuing**

`src/auth/login.ts`:
```ts
import type { Env } from "../env";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { hasActiveConsent } from "../db/consent";
import { createAuthLink } from "../db/authLinks";
import { recordEvent } from "../db/events";
import { isValidTenantSlug } from "../tenant";
import { takeRate } from "../rate";
import { sendMail } from "../mail/send";
import type { Identity, LinkPurpose } from "../db/types";

export const NEUTRAL_LOGIN_MESSAGE = "If that address is known and has consented, a link is on its way. It expires in 15 minutes.";

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

export function cleanNext(next: string | null | undefined): string | null {
  if (!next) return null;
  const s = next.trim().toLowerCase();
  return isValidTenantSlug(s) ? s : null;
}

export function authUrl(env: Env, token: string, next: string | null): string {
  return `https://${env.HUB_DOMAIN}/auth/${token}` + (next ? `?next=${encodeURIComponent(next)}` : "");
}

export function linkMail(purpose: LinkPurpose, url: string): { subject: string; text: string } {
  if (purpose === "reproof") {
    return {
      subject: "Confirm it's you on Pimwell",
      text: [
        "A browser signed in as you asked to confirm a sensitive action on Pimwell.",
        "",
        "Open this link in that same browser within 15 minutes:",
        url,
        "",
        "If this was not you, ignore this message.",
      ].join("\n"),
    };
  }
  return {
    subject: "Your Pimwell sign-in link",
    text: [
      "Open this link within 15 minutes to sign in to Pimwell:",
      url,
      "",
      "The link works once. If you did not ask for it, ignore this message.",
    ].join("\n"),
  };
}

export type LinkRequest = { email: string; purpose: LinkPurpose; ip: string; next: string | null; session_id: string | null };

export async function issueLink(
  env: Env,
  input: { identity: Identity; purpose: LinkPurpose; next: string | null; via: "outbound" | "inbound"; session_id: string | null },
  now: number,
): Promise<string> {
  const { link, token } = await createAuthLink(env.HUB_DB, input.identity.id, input.purpose, now);
  await recordEvent(env.HUB_DB, {
    tenant_id: null, identity_id: input.identity.id, session_id: input.session_id, kind: "auth_link.create",
    target_kind: "auth_link", target_id: link.id, summary: `Issued ${input.purpose} link (${input.via})`,
  }, now);
  return authUrl(env, token, cleanNext(input.next));
}

// Outbound path (spec 6.3). Returns nothing: callers always answer neutrally.
export async function requestLink(env: Env, req: LinkRequest, now: number): Promise<void> {
  const email = normalizeEmail(req.email);
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return;
  if (!(await takeRate(env.RATE, "ip", req.ip, now))) return;
  const identity = await getIdentityByEmail(env.HUB_DB, email);
  if (!identity || identity.kind !== "human" || identity.state !== "active") return;
  // Early exit so no link or rate budget is spent; sendMail enforces the same rule.
  if (!(await hasActiveConsent(env.HUB_DB, email))) return;
  if (!(await takeRate(env.RATE, "addr", email, now))) return;
  const url = await issueLink(env, { identity, purpose: req.purpose, next: req.next, via: "outbound", session_id: req.session_id }, now);
  await sendMail(env, { to: email, ...linkMail(req.purpose, url) }, now);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/login-request.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rate.ts src/auth/login.ts test/login-request.test.ts
git commit -F - <<'EOF'
feat: KV rate limits and consent-gated outbound sign-in links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 4: Consuming links and the /auth/<token> pages

**Files:**
- Modify: `src/auth/login.ts` (append)
- Create: `src/http/login.ts`
- Modify: `src/index.ts` (routes)
- Test: `test/auth-link.test.ts`

**Interfaces:**
- Consumes: `findAuthLinkByToken`, `authLinkIsOpen`, `claimAuthLink` (Task 1); `recordProof` (Task 1); `cleanNext` (Task 3); `createBrowserSession`, `setLastProof`; `getTenantBySlug`; `getMembership`; `getIdentityById`; `buildContext`, `Ctx`; `sessionCookie`, `clearSessionCookie`; `notFoundPage`.
- Produces:
  - In `src/auth/login.ts`: `landingUrl(env, identity, next): Promise<string>`; `openLink(env, token, now): Promise<{ link: AuthLink; identity: Identity } | null>`; `ConsumeResult = { kind: "invalid" } | { kind: "wrong_browser" } | { kind: "ok"; identity: Identity; session: Session; newToken: string | null; purpose: LinkPurpose; location: string }`; `consumeLink(env, ctx: Ctx, token, next, now): Promise<ConsumeResult>`.
  - In `src/http/login.ts`: `isApex(request, env): boolean`, `sameOrigin(request): boolean`, `neutralLinkPage(): string`, `authLinkPage(request, env): Promise<Response>` (GET), `consumeLinkPage(request, env): Promise<Response>` (POST).
  - Routes `GET /auth/:token`, `POST /auth/:token`.

- [ ] **Step 1: Write the failing test**

`test/auth-link.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTH_LINK_TTL_MS, createAuthLink, findAuthLinkByToken } from "../src/db/authLinks";
import { getSessionByToken } from "../src/db/sessions";
import { listProofs } from "../src/db/proofs";
import { seedHuman, seedTenant } from "./helpers";

const postLink = (token: string, headers: Record<string, string> = {}, qs = "") =>
  SELF.fetch(`https://pimwell.test/auth/${token}${qs}`, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test", ...headers } });
const sessionCount = async (identity_id: string) =>
  (await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM session WHERE identity_id = ?").bind(identity_id).first<{ n: number }>())!.n;

describe("GET /auth/<token>", () => {
  it("shows the account and a button, and neither GET nor HEAD consumes", async () => {
    const h = await seedHuman("a@example.com");
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    const get = await SELF.fetch(`https://pimwell.test/auth/${token}?next=acme`);
    expect(get.status).toBe(200);
    const html = await get.text();
    expect(html).toContain("a@example.com");
    expect(html).toContain(`action="/auth/${token}?next=acme"`);
    expect((await SELF.fetch(`https://pimwell.test/auth/${token}`, { method: "HEAD" })).status).toBe(200);
    expect((await findAuthLinkByToken(env.HUB_DB, token))!.used_at).toBeNull();
  });

  it("is apex-only", async () => {
    await seedTenant("acme");
    expect((await SELF.fetch("https://acme.pimwell.test/auth/pml_x")).status).toBe(404);
  });

  it("unknown, expired, used, and archived-identity links render the same neutral page", async () => {
    const h = await seedHuman("a@example.com");
    const gone = await seedHuman("gone@example.com");
    const expired = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now() - AUTH_LINK_TTL_MS - 60_000);
    const used = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    expect((await postLink(used.token)).status).toBe(303);
    const archived = await createAuthLink(env.HUB_DB, gone.identity.id, "login", Date.now());
    await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(gone.identity.id).run();
    const tokens = [`pml_${"A".repeat(43)}`, expired.token, used.token, archived.token];
    const gets = await Promise.all(tokens.map(async (t) => { const r = await SELF.fetch(`https://pimwell.test/auth/${t}`); return [r.status, await r.text()]; }));
    const posts = await Promise.all(tokens.map(async (t) => { const r = await postLink(t); return [r.status, await r.text(), r.headers.get("set-cookie")]; }));
    for (const g of gets) expect(g).toEqual(gets[0]);
    for (const p of posts) expect(p).toEqual(posts[0]);
    expect(gets[0]![1]).toContain("not valid");
    expect(posts[0]![2]).toBeNull();
  });
});

describe("POST /auth/<token>", () => {
  it("signs in once, records an email proof, and lands on the switcher", async () => {
    const h = await seedHuman("a@example.com");
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    const res = await postLink(token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://pimwell.test/");
    const sessionToken = res.headers.get("set-cookie")!.match(/pmw_session=(pms_[^;]+)/)![1]!;
    const s = await getSessionByToken(env.HUB_DB, sessionToken, Date.now());
    expect(s?.identity_id).toBe(h.identity.id);
    expect(s?.kind).toBe("browser");
    expect((await listProofs(env.HUB_DB, h.identity.id)).map((p) => [p.kind, p.subject])).toEqual([["email", "a@example.com"]]);
    const ev = await env.HUB_DB.prepare("SELECT session_id FROM event WHERE kind = 'login.verify'").first<{ session_id: string }>();
    expect(ev!.session_id).toBe(s!.id);
    const second = await postLink(token);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("not valid");
  });

  it("two concurrent POSTs create exactly one session", async () => {
    const h = await seedHuman("a@example.com");
    const before = await sessionCount(h.identity.id);
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    const [a, b] = await Promise.all([postLink(token), postLink(token)]);
    expect([a.status, b.status].sort()).toEqual([200, 303]);
    expect(await sessionCount(h.identity.id)).toBe(before + 1);
  });

  it("honors next only for a tenant the identity belongs to", async () => {
    const acme = await seedTenant("acme");
    await seedTenant("blue");
    const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const go = async (qs: string) => {
      const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
      return (await postLink(token, {}, qs)).headers.get("location");
    };
    expect(await go("?next=acme")).toBe("https://acme.pimwell.test/");
    expect(await go("?next=blue")).toBe("https://pimwell.test/");
    expect(await go("?next=nope")).toBe("https://pimwell.test/");
    expect(await go("?next=https%3A%2F%2Fevil.example")).toBe("https://pimwell.test/");
    expect(await go("?next=login")).toBe("https://pimwell.test/");
  });

  it("rejects a POST without a matching Origin and leaves the link usable", async () => {
    const h = await seedHuman("a@example.com");
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    expect((await postLink(token, { origin: "https://evil.example" })).status).toBe(403);
    expect((await postLink(token)).status).toBe(303);
  });

  it("a login link in a browser already signed in as that identity refreshes proof without a new session", async () => {
    const h = await seedHuman("a@example.com");
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = 0 WHERE id = ?").bind(h.session.id).run();
    const before = await sessionCount(h.identity.id);
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    const res = await postLink(token, { cookie: `pmw_session=${h.token}` });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await sessionCount(h.identity.id)).toBe(before);
    expect((await getSessionByToken(env.HUB_DB, h.token, Date.now()))!.last_proof_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a reproof link works only in the asking identity's browser and is not burned elsewhere", async () => {
    const h = await seedHuman("a@example.com");
    const other = await seedHuman("b@example.com");
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = 0 WHERE id = ?").bind(h.session.id).run();
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "reproof", Date.now());
    const anon = await postLink(token);
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain("Open this link where you asked for it");
    const wrong = await postLink(token, { cookie: `pmw_session=${other.token}` });
    expect(await wrong.text()).toContain("Open this link where you asked for it");
    expect((await findAuthLinkByToken(env.HUB_DB, token))!.used_at).toBeNull();
    const right = await postLink(token, { cookie: `pmw_session=${h.token}` });
    expect(right.status).toBe(303);
    expect(right.headers.get("set-cookie")).toBeNull();
    expect((await getSessionByToken(env.HUB_DB, h.token, Date.now()))!.last_proof_at).toBeGreaterThan(Date.now() - 60_000);
    expect(await env.HUB_DB.prepare("SELECT id FROM event WHERE kind = 'login.reproof'").first()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/auth-link.test.ts`
Expected: FAIL; GET `/auth/...` returns 404 because the route does not exist.

- [ ] **Step 3: Append the consume logic to `src/auth/login.ts`**

Add these imports at the top of `src/auth/login.ts` (merge with the existing ones):
```ts
import type { Ctx } from "./context";
import { getIdentityById } from "../db/identities";
import { authLinkIsOpen, claimAuthLink, findAuthLinkByToken } from "../db/authLinks";
import { recordProof } from "../db/proofs";
import { createBrowserSession, setLastProof } from "../db/sessions";
import { getTenantBySlug } from "../db/tenants";
import { getMembership } from "../db/memberships";
import type { AuthLink, Session } from "../db/types";
```
Append:
```ts
export async function landingUrl(env: Env, identity: Identity, next: string | null): Promise<string> {
  const home = `https://${env.HUB_DOMAIN}/`;
  const slug = cleanNext(next);
  if (!slug) return home;
  const tenant = await getTenantBySlug(env.HUB_DB, slug);
  if (!tenant || tenant.state !== "active") return home;
  const there = `https://${slug}.${env.HUB_DOMAIN}/`;
  if (identity.is_root === 1) return there;
  const m = await getMembership(env.HUB_DB, identity.id, tenant.id);
  return m && m.state === "active" ? there : home;
}

export async function openLink(env: Env, token: string, now: number): Promise<{ link: AuthLink; identity: Identity } | null> {
  const link = await findAuthLinkByToken(env.HUB_DB, token);
  if (!link || !authLinkIsOpen(link, now)) return null;
  const identity = await getIdentityById(env.HUB_DB, link.identity_id);
  if (!identity || identity.kind !== "human" || identity.state !== "active") return null;
  return { link, identity };
}

export type ConsumeResult =
  | { kind: "invalid" }
  | { kind: "wrong_browser" }
  | { kind: "ok"; identity: Identity; session: Session; newToken: string | null; purpose: LinkPurpose; location: string };

export async function consumeLink(env: Env, ctx: Ctx, token: string, next: string | null, now: number): Promise<ConsumeResult> {
  const open = await openLink(env, token, now);
  if (!open) return { kind: "invalid" };
  const { link, identity } = open;
  const own = ctx.identity?.id === identity.id && ctx.session?.kind === "browser" ? ctx.session : null;
  // A reproof link refreshes the session that asked; anywhere else, leave it unused.
  if (link.purpose === "reproof" && !own) return { kind: "wrong_browser" };
  if (!(await claimAuthLink(env.HUB_DB, link.id, now))) return { kind: "invalid" };
  await recordProof(env.HUB_DB, { identity_id: identity.id, kind: "email", subject: identity.email }, now);
  let session: Session;
  let newToken: string | null = null;
  if (own) {
    await setLastProof(env.HUB_DB, own.id, now);
    session = { ...own, last_proof_at: now };
  } else {
    const created = await createBrowserSession(env.HUB_DB, identity.id, now);
    session = created.session;
    newToken = created.token;
  }
  await recordEvent(env.HUB_DB, {
    tenant_id: null, identity_id: identity.id, session_id: session.id,
    kind: link.purpose === "reproof" ? "login.reproof" : "login.verify", target_kind: "auth_link", target_id: link.id,
    summary: link.purpose === "reproof" ? "Re-proved control of email" : newToken ? "Signed in with an email link" : "Refreshed proof with an email link",
  }, now);
  return { kind: "ok", identity, session, newToken, purpose: link.purpose, location: await landingUrl(env, identity, next) };
}
```

- [ ] **Step 4: Write the /auth pages**

`src/http/login.ts`:
```ts
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { classifyHost } from "../tenant";
import { buildContext } from "../auth/context";
import { clearSessionCookie, sessionCookie } from "../auth/cookie";
import { cleanNext, consumeLink, openLink } from "../auth/login";
import { notFoundPage } from "./pages";

export function isApex(request: Request, env: Env): boolean {
  return classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN).kind === "apex";
}

export function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  return request.headers.get("origin") === `${url.protocol}//${url.host}`;
}

function authToken(request: Request): string | null {
  const m = new URL(request.url).pathname.match(/^\/auth\/([A-Za-z0-9_-]+)$/);
  return m ? m[1]! : null;
}

export function neutralLinkPage(): string {
  return page("Sign-in link", `<h1>This sign-in link is not valid</h1><p>It may have expired or been used already. <a href="/login">Ask for a new one</a>.</p>`);
}

function wrongBrowserPage(): string {
  return page("Confirm it's you", `<h1>Open this link where you asked for it</h1><p>This confirmation link only works in the browser that is signed in and asked for it. It has not been used.</p>`);
}

export async function authLinkPage(request: Request, env: Env): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  const token = authToken(request);
  const open = token ? await openLink(env, token, Date.now()) : null;
  if (!open) return htmlResponse(neutralLinkPage());
  const next = cleanNext(new URL(request.url).searchParams.get("next"));
  const action = `/auth/${token}` + (next ? `?next=${next}` : "");
  const reproof = open.link.purpose === "reproof";
  const heading = reproof ? "Confirm it's you" : "Sign in to Pimwell";
  const body = `<h1>${esc(heading)}</h1>
<p>Continue as <strong>${esc(open.identity.email)}</strong>.</p>
<form method="post" action="${esc(action)}"><button type="submit">${reproof ? "Confirm" : "Sign in"}</button></form>`;
  return htmlResponse(page(heading, body));
}

export async function consumeLinkPage(request: Request, env: Env): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  if (!sameOrigin(request)) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
  const now = Date.now();
  const ctx = await buildContext(request, env, now);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const token = authToken(request);
  if (!token) return htmlResponse(neutralLinkPage(), 200, extra);
  const r = await consumeLink(env, ctx, token, new URL(request.url).searchParams.get("next"), now);
  if (r.kind === "invalid") return htmlResponse(neutralLinkPage(), 200, extra);
  if (r.kind === "wrong_browser") return htmlResponse(wrongBrowserPage(), 200, extra);
  const headers = new Headers({ location: r.location, "cache-control": "no-store" });
  if (r.newToken) headers.append("set-cookie", sessionCookie(r.newToken, env.HUB_DOMAIN));
  else if (ctx.staleCookie) headers.append("set-cookie", clearSessionCookie(env.HUB_DOMAIN));
  return new Response(null, { status: 303, headers });
}
```

- [ ] **Step 5: Register the routes**

In `src/index.ts` add the import and two routes (next to the `/invite/:token` routes):
```ts
import { authLinkPage, consumeLinkPage } from "./http/login";
```
```ts
app.get("/auth/:token", (c) => authLinkPage(c.req.raw, c.env));
app.post("/auth/:token", (c) => consumeLinkPage(c.req.raw, c.env));
```
Hono serves HEAD from GET routes, so HEAD needs no route of its own.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/auth-link.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/auth/login.ts src/http/login.ts src/index.ts test/auth-link.test.ts
git commit -F - <<'EOF'
feat: consume sign-in and reproof links on POST /auth/<token>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 5: The /login page, Ctx.ip, and the intro's Sign in link

**Files:**
- Modify: `src/auth/context.ts` (add `ip`)
- Modify: `src/http/login.ts` (append `loginPage`, `loginPostPage`)
- Modify: `src/index.ts` (routes)
- Modify: `site/index.html` (closing section)
- Test: `test/login-page.test.ts`

**Interfaces:**
- Consumes: `requestLink`, `cleanNext`, `NEUTRAL_LOGIN_MESSAGE` (Task 3); `isApex`, `sameOrigin` (Task 4); `setTestTransport`, `SentMail` (Task 2); `grantConsent` (Task 1).
- Produces:
  - `Ctx.ip: string` (from `cf-connecting-ip`, else `"unknown"`).
  - `loginPage(request, env): Promise<Response>` for `GET /login`; `loginPostPage(request, env, waitUntil?: (p: Promise<unknown>) => void): Promise<Response>` for `POST /login`. Form fields: `email`, `next`, `reproof` (`"1"`).

- [ ] **Step 1: Write the failing test**

`test/login-page.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginPostPage } from "../src/http/login";
import { buildContext } from "../src/auth/context";
import { setTestTransport, type SentMail } from "../src/mail/send";
import { grantConsent } from "../src/db/consent";
import { seedHuman, seedTenant } from "./helpers";

const sent: SentMail[] = [];
beforeEach(() => setTestTransport(async (m) => { sent.push(m); }));
afterEach(() => {
  sent.length = 0;
  setTestTransport(null);
});

const consent = (email: string) => grantConsent(env.HUB_DB, { email, kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
function loginForm(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request("https://pimwell.test/login", {
    method: "POST",
    headers: { origin: "https://pimwell.test", "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.1", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("Ctx.ip", () => {
  it("comes from cf-connecting-ip", async () => {
    expect((await buildContext(new Request("https://pimwell.test/", { headers: { "cf-connecting-ip": "203.0.113.9" } }), env)).ip).toBe("203.0.113.9");
    expect((await buildContext(new Request("https://pimwell.test/"), env)).ip).toBe("unknown");
  });
});

describe("GET /login", () => {
  it("shows the email form and the inbound address, on the apex only", async () => {
    const res = await SELF.fetch("https://pimwell.test/login?next=acme");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="next" value="acme"');
    expect(html).toContain("login@pimwell.test");
    await seedTenant("acme");
    expect((await SELF.fetch("https://acme.pimwell.test/login")).status).toBe(404);
  });

  it("offers a confirmation link to a signed-in browser when reproof=1", async () => {
    const h = await seedHuman("a@example.com");
    const html = await (await SELF.fetch("https://pimwell.test/login?reproof=1&next=acme", { headers: { cookie: `pmw_session=${h.token}` } })).text();
    expect(html).toContain("Confirm it");
    expect(html).toContain('name="reproof" value="1"');
    expect(html).toContain('name="next" value="acme"');
    expect(html).toContain("a@example.com");
    const anon = await (await SELF.fetch("https://pimwell.test/login?reproof=1")).text();
    expect(anon).toContain('name="email"');
    expect(anon).not.toContain('name="reproof"');
  });

  it("the anonymous apex intro links to /login", async () => {
    const html = await (await SELF.fetch("https://pimwell.test/")).text();
    expect(html).toContain('href="/login"');
    expect(html).toContain("invite link");
  });
});

describe("POST /login", () => {
  it("answers identically for known, unknown, and unconsented addresses", async () => {
    await seedHuman("known@example.com");
    await consent("known@example.com");
    await seedHuman("quiet@example.com");
    const pages: Array<[number, string]> = [];
    for (const email of ["known@example.com", "nobody@example.com", "quiet@example.com"]) {
      const res = await loginPostPage(loginForm({ email }), env);
      pages.push([res.status, await res.text()]);
    }
    expect(pages[0]![0]).toBe(200);
    expect(pages[1]).toEqual(pages[0]);
    expect(pages[2]).toEqual(pages[0]);
    expect(sent.map((m) => m.to)).toEqual(["known@example.com"]);
  });

  it("still answers neutrally past the rate limit", async () => {
    await seedHuman("known@example.com");
    await consent("known@example.com");
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++) bodies.push(await (await loginPostPage(loginForm({ email: "known@example.com" }), env)).text());
    expect(new Set(bodies).size).toBe(1);
    expect(sent).toHaveLength(3);
  });

  it("rejects a POST without a matching Origin", async () => {
    expect((await loginPostPage(loginForm({ email: "a@example.com" }, { origin: "https://evil.example" }), env)).status).toBe(403);
  });

  it("is wired at POST /login", async () => {
    const res = await SELF.fetch(loginForm({ email: "nobody@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("a link is on its way");
  });

  it("reproof sends a confirmation link to the session's own address, ignoring the form email", async () => {
    const h = await seedHuman("a@example.com");
    await consent("a@example.com");
    await seedHuman("b@example.com");
    await consent("b@example.com");
    const res = await loginPostPage(loginForm({ reproof: "1", email: "b@example.com", next: "acme" }, { cookie: `pmw_session=${h.token}` }), env);
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["a@example.com"]);
    expect(sent[0]!.text).toContain("?next=acme");
    const row = await env.HUB_DB.prepare("SELECT purpose, identity_id FROM auth_link").first<{ purpose: string; identity_id: string }>();
    expect(row).toEqual({ purpose: "reproof", identity_id: h.identity.id });
  });

  it("reproof without a session sends nothing and shows the email form", async () => {
    await seedHuman("a@example.com");
    await consent("a@example.com");
    const res = await loginPostPage(loginForm({ reproof: "1", email: "a@example.com" }), env);
    expect(await res.text()).toContain('name="email"');
    expect(sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/login-page.test.ts`
Expected: FAIL with "loginPostPage is not a function" / missing export.

- [ ] **Step 3: Add `ip` to the request context**

In `src/auth/context.ts`, add `ip: string;` to the `Ctx` type after `now: number;`. In `buildContext`, before the `return`, add:
```ts
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
```
and change the return to:
```ts
  return { env, db, now, ip, host, tenant, identity, session, role, authKind, staleCookie };
```

- [ ] **Step 4: Append the /login pages to `src/http/login.ts`**

Merge into the imports at the top of `src/http/login.ts`:
```ts
import { NEUTRAL_LOGIN_MESSAGE, requestLink } from "../auth/login";
import type { LinkPurpose } from "../db/types";
```
Append:
```ts
function nextInput(next: string | null): string {
  return next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";
}

function inboundHint(env: Env): string {
  return `<p>Or send any message to <strong>login@${esc(env.HUB_DOMAIN)}</strong> from your address. The reply carries a link. The hub only writes to addresses that have written to it first.</p>`;
}

function loginBody(env: Env, next: string | null, note: string): string {
  return `<h1>Sign in to Pimwell</h1>${note}
<form method="post" action="/login">
<label>Email <input type="email" name="email" required autocomplete="email" maxlength="254"></label>
${nextInput(next)}
<button type="submit">Email me a link</button>
</form>
${inboundHint(env)}`;
}

function reproofBody(env: Env, email: string, next: string | null): string {
  return `<h1>Confirm it's you</h1>
<p>This action needs a recent proof that you control <strong>${esc(email)}</strong>.</p>
<form method="post" action="/login">
<input type="hidden" name="reproof" value="1">
${nextInput(next)}
<button type="submit">Email me a confirmation link</button>
</form>
<p>If you have never written to the hub, send any message to <strong>login@${esc(env.HUB_DOMAIN)}</strong> from that address and open the link in the reply in this browser.</p>`;
}

export async function loginPage(request: Request, env: Env): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const url = new URL(request.url);
  const next = cleanNext(url.searchParams.get("next"));
  if (url.searchParams.get("reproof") === "1" && ctx.identity && ctx.session?.kind === "browser") {
    return htmlResponse(page("Confirm it's you", reproofBody(env, ctx.identity.email, next)), 200, extra);
  }
  const note = ctx.identity ? `<p>You are signed in as <strong>${esc(ctx.identity.email)}</strong>.</p>` : "";
  return htmlResponse(page("Sign in", loginBody(env, next, note)), 200, extra);
}

export async function loginPostPage(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  if (!isApex(request, env)) return notFoundPage();
  if (!sameOrigin(request)) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
  const now = Date.now();
  const ctx = await buildContext(request, env, now);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const form = await request.formData().catch(() => null);
  const field = (k: string): string => {
    const v = form?.get(k);
    return typeof v === "string" ? v : "";
  };
  const next = cleanNext(field("next"));
  const reproof = field("reproof") === "1";
  let email: string;
  let purpose: LinkPurpose;
  let session_id: string | null = null;
  if (reproof) {
    if (!ctx.identity || !ctx.session || ctx.session.kind !== "browser") return htmlResponse(page("Sign in", loginBody(env, next, "")), 200, extra);
    email = ctx.identity.email;
    purpose = "reproof";
    session_id = ctx.session.id;
  } else {
    email = field("email").slice(0, 254);
    purpose = "login";
  }
  // Off the response path when possible, so timing does not reveal known addresses.
  const work = requestLink(env, { email, purpose, ip: ctx.ip, next, session_id }, now)
    .catch((e) => console.log("login request failed", e instanceof Error ? e.name : "unknown"));
  if (waitUntil) waitUntil(work);
  else await work;
  const body = reproof
    ? `<h1>Check your email</h1><p>If ${esc(email)} has written to the hub before, a confirmation link is on its way. Open it in this browser within 15 minutes.</p><p>Otherwise, send any message to <strong>login@${esc(env.HUB_DOMAIN)}</strong> from that address and open the link in the reply here.</p>`
    : `<h1>Check your email</h1><p>${esc(NEUTRAL_LOGIN_MESSAGE)}</p>${inboundHint(env)}`;
  return htmlResponse(page("Check your email", body), 200, extra);
}
```

- [ ] **Step 5: Register the routes**

In `src/index.ts` extend the `./http/login` import to `import { authLinkPage, consumeLinkPage, loginPage, loginPostPage } from "./http/login";` and add:
```ts
app.get("/login", (c) => loginPage(c.req.raw, c.env));
app.post("/login", (c) => loginPostPage(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
```

- [ ] **Step 6: Add the Sign in link to the intro**

In `site/index.html`, in the `<div class="closing">` block, replace:
```html
      <p>It's invite-only while the street gets built. If someone sent you an invite link, open it to move in.</p>
```
with:
```html
      <p>It's invite-only while the street gets built. If someone sent you an invite link, open it to move in.</p>
      <p><a href="/login">Sign in</a></p>
```
No other change to the intro.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/login-page.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/auth/context.ts src/http/login.ts src/index.ts site/index.html test/login-page.test.ts
git commit -F - <<'EOF'
feat: /login page with neutral responses and reproof variant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 6: login.request and login.verify verbs

**Files:**
- Create: `src/verbs/login.ts`
- Modify: `src/verbs/index.ts`
- Test: `test/login-verbs.test.ts`

**Interfaces:**
- Consumes: `requestLink`, `consumeLink`, `NEUTRAL_LOGIN_MESSAGE` (Tasks 3, 4); `Ctx.ip` (Task 5); `defineVerb`; `reqString`, `optString`, `optBool`; `HubError`, `badRequest`, `notFound`, `unauthorized`; `handleApi`; `registerAllVerbs`.
- Produces:
  - `login.request`: kind `command`, scope `hub`, minRole `public`, fresh proof none. Params `{ email?: string, reproof?: boolean, next?: string }`. Result `{ message: NEUTRAL_LOGIN_MESSAGE }`. With `reproof: true` it needs a browser session (else 401) and uses that identity's address.
  - `login.verify`: kind `command`, scope `hub`, minRole `public`, fresh proof none. Params `{ token: string, next?: string }`. Result `{ identity_id, session_id, session_token: string | null, location }`. Invalid link: 404 `not_found`. Reproof link without the asking session: 403 `session_mismatch`.

- [ ] **Step 1: Write the failing test**

`test/login-verbs.test.ts`:
```ts
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/http/api";
import { registerAllVerbs } from "../src/verbs/index";
import { setTestTransport, type SentMail } from "../src/mail/send";
import { grantConsent } from "../src/db/consent";
import { createAuthLink, findAuthLinkByToken } from "../src/db/authLinks";
import { getSessionByToken } from "../src/db/sessions";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";

beforeAll(() => registerAllVerbs());
const sent: SentMail[] = [];
beforeEach(() => setTestTransport(async (m) => { sent.push(m); }));
afterEach(() => {
  sent.length = 0;
  setTestTransport(null);
});

const consent = (email: string) => grantConsent(env.HUB_DB, { email, kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
function call(host: string, verb: string, body: unknown, headers: Record<string, string> = {}) {
  return handleApi(new Request(`https://${host}/api/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.1", ...headers },
    body: JSON.stringify(body),
  }), env);
}

describe("login.request", () => {
  it("answers identically for known and unknown addresses", async () => {
    await seedHuman("known@example.com");
    await consent("known@example.com");
    const a = await call("pimwell.test", "login.request", { email: "known@example.com" });
    const b = await call("pimwell.test", "login.request", { email: "nobody@example.com" });
    expect(a.status).toBe(200);
    expect(await a.text()).toBe(await b.text());
    expect(sent.map((m) => m.to)).toEqual(["known@example.com"]);
  });

  it("is apex-only and needs an email", async () => {
    await seedTenant("acme");
    expect((await call("acme.pimwell.test", "login.request", { email: "a@example.com" })).status).toBe(404);
    expect((await call("pimwell.test", "login.request", {})).status).toBe(400);
  });

  it("reproof needs a browser session and goes to that session's address", async () => {
    const h = await seedHuman("a@example.com");
    await consent("a@example.com");
    expect((await call("pimwell.test", "login.request", { reproof: true })).status).toBe(401);
    expect((await call("pimwell.test", "login.request", { reproof: true, email: "x@example.com" }, bearer(h.token))).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["a@example.com"]);
    expect(sent[0]!.subject).toBe("Confirm it's you on Pimwell");
  });
});

describe("login.verify", () => {
  it("returns a new browser session token once; then 404 like an unknown token", async () => {
    const h = await seedHuman("a@example.com");
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    const res = await apiPost("pimwell.test", "login.verify", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { session_token: string; location: string; identity_id: string } };
    expect(body.result.session_token).toMatch(/^pms_/);
    expect(body.result.location).toBe("https://pimwell.test/");
    expect((await getSessionByToken(env.HUB_DB, body.result.session_token, Date.now()))!.identity_id).toBe(h.identity.id);
    const again = await apiPost("pimwell.test", "login.verify", { token });
    const unknown = await apiPost("pimwell.test", "login.verify", { token: `pml_${"A".repeat(43)}` });
    expect(again.status).toBe(404);
    expect(await again.text()).toBe(await unknown.text());
  });

  it("a reproof link refreshes the calling browser session and refuses others", async () => {
    const h = await seedHuman("a@example.com");
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = 0 WHERE id = ?").bind(h.session.id).run();
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "reproof", Date.now());
    const anon = await apiPost("pimwell.test", "login.verify", { token });
    expect(anon.status).toBe(403);
    expect(((await anon.json()) as { error: string }).error).toBe("session_mismatch");
    expect((await findAuthLinkByToken(env.HUB_DB, token))!.used_at).toBeNull();
    const ok = await apiPost("pimwell.test", "login.verify", { token }, bearer(h.token));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { session_token: string | null } }).result.session_token).toBeNull();
    expect((await getSessionByToken(env.HUB_DB, h.token, Date.now()))!.last_proof_at).toBeGreaterThan(Date.now() - 60_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/login-verbs.test.ts`
Expected: FAIL; `login.request` returns 404 `unknown_verb`.

- [ ] **Step 3: Write the verbs**

`src/verbs/login.ts`:
```ts
import { defineVerb } from "./table";
import { optBool, optString, reqString } from "./params";
import { badRequest, HubError, notFound, unauthorized } from "../errors";
import { consumeLink, NEUTRAL_LOGIN_MESSAGE, requestLink } from "../auth/login";

export const loginRequest = defineVerb({
  name: "login.request", kind: "command", scope: "hub", minRole: "public", freshProofMinutes: null,
  summary: "Ask for a sign-in link by email, or with reproof a confirmation link to your own address. The answer never says whether the address is known.",
  parse: (i) => ({
    email: optString(i, "email", { max: 254 }),
    reproof: optBool(i, "reproof") ?? false,
    next: optString(i, "next", { max: 63 }),
  }),
  run: async (ctx, p) => {
    if (p.reproof) {
      if (!ctx.identity || !ctx.session || ctx.session.kind !== "browser") throw unauthorized();
      await requestLink(ctx.env, { email: ctx.identity.email, purpose: "reproof", ip: ctx.ip, next: p.next, session_id: ctx.session.id }, ctx.now);
    } else {
      if (!p.email) throw badRequest("email is required");
      await requestLink(ctx.env, { email: p.email, purpose: "login", ip: ctx.ip, next: p.next, session_id: null }, ctx.now);
    }
    return { message: NEUTRAL_LOGIN_MESSAGE };
  },
});

export const loginVerify = defineVerb({
  name: "login.verify", kind: "command", scope: "hub", minRole: "public", freshProofMinutes: null,
  summary: "Consume a sign-in or confirmation link token. A login link returns a new browser session token; a reproof link refreshes the calling session.",
  parse: (i) => ({ token: reqString(i, "token", { max: 128 }), next: optString(i, "next", { max: 63 }) }),
  run: async (ctx, p) => {
    const r = await consumeLink(ctx.env, ctx, p.token, p.next, ctx.now);
    if (r.kind === "invalid") throw notFound("link not valid");
    if (r.kind === "wrong_browser") throw new HubError(403, "session_mismatch", "a confirmation link must be used by the session that asked for it");
    return { identity_id: r.identity.id, session_id: r.session.id, session_token: r.newToken, location: r.location };
  },
});
```

- [ ] **Step 4: Register them**

In `src/verbs/index.ts` add `import { loginRequest, loginVerify } from "./login";` and append `loginRequest, loginVerify,` to the `registerVerbs([...])` list.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/login-verbs.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/login.ts src/verbs/index.ts test/login-verbs.test.ts
git commit -F - <<'EOF'
feat: login.request and login.verify verbs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 7: Inbound email handler for login@ and signup@

**Files:**
- Create: `src/mail/inbound.ts`
- Modify: `src/index.ts` (default export becomes `{ fetch, email }`)
- Test: `test/inbound.test.ts`

**Interfaces:**
- Consumes: `grantConsent`, `listConsent`, `hasActiveConsent` (Task 1); `sendMail`, `safeMessageId` (Task 2); `takeRate` (Task 3); `issueLink`, `linkMail` (Task 3); `getIdentityByEmail`, `normalizeEmail`; `recordEvent`.
- Produces:
  - `INBOUND_LOCALS = ["login", "signup"]`, `REJECT_REASON: string`, `handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void>`.
  - Worker default export `{ fetch: app.fetch, email: handleEmail }`.
  - Events: `consent.grant`, `auth_link.create` (via `issueLink`, summary `Issued login link (inbound)`), `login.inbound_limited`, `login.reply_failed`.

- [ ] **Step 1: Write the failing test**

`test/inbound.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { handleEmail } from "../src/mail/inbound";
import { hasActiveConsent, listConsent } from "../src/db/consent";
import { createIdentity } from "../src/db/identities";
import { seedHuman } from "./helpers";

type Calls = { rejects: string[]; replies: Array<{ from: string; to: string }> };

function fakeMessage(from: string, to: string, opts: { replyThrows?: boolean; messageId?: string | null } = {}) {
  const calls: Calls = { rejects: [], replies: [] };
  const headers = new Headers({ subject: "hello" });
  if (opts.messageId !== null) headers.set("message-id", opts.messageId ?? "<m1@example.com>");
  const message = {
    from, to, headers,
    raw: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    rawSize: 0,
    setReject(reason: string) { calls.rejects.push(reason); },
    async forward() { throw new Error("not used"); },
    async reply(m: EmailMessage) {
      if (opts.replyThrows) throw new Error("reply not permitted");
      calls.replies.push({ from: m.from, to: m.to });
      return { messageId: "<r1@pimwell.test>" };
    },
  };
  return { message: message as unknown as ForwardableEmailMessage, calls };
}

const ctx = {} as ExecutionContext;
const links = async () => (await env.HUB_DB.prepare("SELECT identity_id, purpose FROM auth_link").all<{ identity_id: string; purpose: string }>()).results;
const eventKinds = async () => (await env.HUB_DB.prepare("SELECT kind FROM event ORDER BY created_at, id").all<{ kind: string }>()).results.map((r) => r.kind);

describe("worker entry", () => {
  it("exports email alongside fetch and still serves routes", async () => {
    expect(typeof worker.email).toBe("function");
    expect(typeof worker.fetch).toBe("function");
    expect(await (await SELF.fetch("https://pimwell.test/healthz")).text()).toBe("ok");
  });
});

describe("handleEmail", () => {
  it("records consent and replies from login@ with a login link", async () => {
    const h = await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test");
    await handleEmail(message, env, ctx);
    expect(calls.rejects).toEqual([]);
    expect(calls.replies).toEqual([{ from: "login@pimwell.test", to: "a@example.com" }]);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(true);
    const [c] = await listConsent(env.HUB_DB, "a@example.com");
    expect(c!.kind).toBe("inbound_email");
    expect(c!.source_message_id).toBe("<m1@example.com>");
    expect(await links()).toEqual([{ identity_id: h.identity.id, purpose: "login" }]);
    expect((await eventKinds()).sort()).toEqual(["auth_link.create", "consent.grant"]);
  });

  it("signup@ behaves the same, replies from signup@, and does not duplicate consent", async () => {
    await seedHuman("a@example.com");
    await handleEmail(fakeMessage("a@example.com", "login@pimwell.test").message, env, ctx);
    const { message, calls } = fakeMessage("a@example.com", "Signup@Pimwell.test", { messageId: "<m2@example.com>" });
    await handleEmail(message, env, ctx);
    expect(calls.replies).toEqual([{ from: "signup@pimwell.test", to: "a@example.com" }]);
    expect(await listConsent(env.HUB_DB, "a@example.com")).toHaveLength(1);
    expect(await links()).toHaveLength(2);
  });

  it("matches the sender case-insensitively", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("A@Example.COM", "login@pimwell.test");
    await handleEmail(message, env, ctx);
    expect(calls.rejects).toEqual([]);
    expect(calls.replies).toHaveLength(1);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(true);
  });

  it("rejects unknown, archived, and agent senders without consent or reply", async () => {
    const gone = await seedHuman("gone@example.com");
    await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(gone.identity.id).run();
    const op = await seedHuman("op@example.com");
    await createIdentity(env.HUB_DB, { kind: "agent", email: "bot@acme.pimwell.test", display_name: "Bot", is_root: 0, operator_id: op.identity.id }, Date.now());
    for (const from of ["nobody@example.com", "gone@example.com", "bot@acme.pimwell.test"]) {
      const { message, calls } = fakeMessage(from, "login@pimwell.test");
      await handleEmail(message, env, ctx);
      expect(calls.rejects).toHaveLength(1);
      expect(calls.replies).toHaveLength(0);
      expect(await hasActiveConsent(env.HUB_DB, from)).toBe(false);
    }
    expect(await links()).toHaveLength(0);
  });

  it("rejects mail to any other recipient", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("a@example.com", "other@pimwell.test");
    await handleEmail(message, env, ctx);
    expect(calls.rejects).toHaveLength(1);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(false);
  });

  it("keeps consent and records an event when reply throws (no DMARC pass)", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test", { replyThrows: true });
    await expect(handleEmail(message, env, ctx)).resolves.toBeUndefined();
    expect(calls.rejects).toEqual([]);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(true);
    expect(await eventKinds()).toContain("login.reply_failed");
  });

  it("replies even when the inbound message has no Message-ID", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test", { messageId: null });
    await handleEmail(message, env, ctx);
    expect(calls.replies).toHaveLength(1);
    expect((await listConsent(env.HUB_DB, "a@example.com"))[0]!.source_message_id).toBeNull();
  });

  it("caps replies at 3 per sender per hour", async () => {
    await seedHuman("a@example.com");
    let replies = 0;
    for (let i = 0; i < 4; i++) {
      const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test", { messageId: `<m${i}@example.com>` });
      await handleEmail(message, env, ctx);
      replies += calls.replies.length;
    }
    expect(replies).toBe(3);
    expect(await eventKinds()).toContain("login.inbound_limited");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/inbound.test.ts`
Expected: FAIL with "Failed to load url ../src/mail/inbound".

- [ ] **Step 3: Write the handler**

`src/mail/inbound.ts`:
```ts
import type { Env } from "../env";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { grantConsent } from "../db/consent";
import { recordEvent } from "../db/events";
import { takeRate } from "../rate";
import { issueLink, linkMail } from "../auth/login";
import { sendMail } from "./send";
import { safeMessageId } from "./mime";

export const INBOUND_LOCALS = ["login", "signup"] as const;
export const REJECT_REASON = "This address does not accept mail from you.";

// Spec 6.4. Cloudflare's MX already rejected SPF/DKIM failures; reply() adds
// the DMARC gate. Authentication-Results is deliberately not read.
export async function handleEmail(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
  const now = Date.now();
  const to = message.to.trim().toLowerCase();
  const local = INBOUND_LOCALS.find((l) => to === `${l}@${env.HUB_DOMAIN}`);
  if (!local) {
    message.setReject("Unknown recipient");
    return;
  }
  const from = normalizeEmail(message.from);
  const identity = await getIdentityByEmail(env.HUB_DB, from);
  if (!identity || identity.kind !== "human" || identity.state !== "active") {
    message.setReject(REJECT_REASON);
    return;
  }

  const { consent, created } = await grantConsent(env.HUB_DB, {
    email: from, kind: "inbound_email", source_message_id: safeMessageId(message.headers.get("message-id")),
    evidence: JSON.stringify({ to: local, received_at: now }),
  }, now);
  if (created) {
    await recordEvent(env.HUB_DB, {
      tenant_id: null, identity_id: identity.id, session_id: null, kind: "consent.grant",
      target_kind: "consent", target_id: consent.id, summary: `Consent recorded from mail to ${local}@`,
    }, now);
  }

  if (!(await takeRate(env.RATE, "addr", from, now))) {
    await recordEvent(env.HUB_DB, {
      tenant_id: null, identity_id: identity.id, session_id: null, kind: "login.inbound_limited",
      target_kind: "identity", target_id: identity.id, summary: "Inbound sign-in over the hourly limit; no reply sent",
    }, now);
    return;
  }

  const url = await issueLink(env, { identity, purpose: "login", next: null, via: "inbound", session_id: null }, now);
  const result = await sendMail(env, { to: from, ...linkMail("login", url) }, now, { replyTo: message });
  if (result !== "sent") {
    await recordEvent(env.HUB_DB, {
      tenant_id: null, identity_id: identity.id, session_id: null, kind: "login.reply_failed",
      target_kind: "identity", target_id: identity.id, summary: `No reply sent (${result})`,
    }, now);
  }
}
```

- [ ] **Step 4: Change the Worker's default export**

`src/index.ts` becomes (all phase 1 routes kept, plus Tasks 4 and 5 routes):
```ts
import { Hono } from "hono";
import type { Env } from "./env";
import { handleApi } from "./http/api";
import { registerAllVerbs } from "./verbs/index";
import { acceptInvitePage, archivePage, homePage, invitePage, notFoundPage, sessionsPage } from "./http/pages";
import { authLinkPage, consumeLinkPage, loginPage, loginPostPage } from "./http/login";
import { handleEmail } from "./mail/inbound";

registerAllVerbs();

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));
app.post("/api/*", (c) => handleApi(c.req.raw, c.env));
app.get("/", (c) => homePage(c.req.raw, c.env));
app.get("/archive", (c) => archivePage(c.req.raw, c.env));
app.get("/invite/:token", (c) => invitePage(c.req.raw, c.env));
app.post("/invite/:token", (c) => acceptInvitePage(c.req.raw, c.env));
app.get("/login", (c) => loginPage(c.req.raw, c.env));
app.post("/login", (c) => loginPostPage(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
app.get("/auth/:token", (c) => authLinkPage(c.req.raw, c.env));
app.post("/auth/:token", (c) => consumeLinkPage(c.req.raw, c.env));
app.get("/me/sessions", (c) => sessionsPage(c.req.raw, c.env));
app.notFound(() => notFoundPage());

export default { fetch: app.fetch, email: handleEmail } satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/inbound.test.ts && npm test && npm run typecheck`
Expected: PASS, including `test/index.test.ts` (`/healthz`).

- [ ] **Step 6: Commit**

```bash
git add src/mail/inbound.ts src/index.ts test/inbound.test.ts
git commit -F - <<'EOF'
feat: inbound email handler for login@ and signup@

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 8: Reproof end to end

**Files:**
- Modify: `src/http/api.ts` (form posts needing reproof redirect)
- Modify: `README.md` (replace the phase 1 escape hatch)
- Test: `test/reproof.test.ts`

**Interfaces:**
- Consumes: `loginPostPage` (Task 5); `setTestTransport`, `SentMail` (Task 2); `grantConsent` (Task 1); `consumeLinkPage` route (Task 4); dispatcher `handleApi`.
- Produces: a form (`application/x-www-form-urlencoded` or `multipart/form-data`) POST to `/api/<verb>` that fails with `reproof_required` returns `303` to `https://<HUB_DOMAIN>/login?reproof=1`, plus `&next=<tenant slug>` on a tenant host. JSON callers still get `403 {"error":"reproof_required"}`.

- [ ] **Step 1: Write the failing test**

`test/reproof.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginPostPage } from "../src/http/login";
import { setTestTransport, type SentMail } from "../src/mail/send";
import { grantConsent } from "../src/db/consent";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const sent: SentMail[] = [];
beforeEach(() => setTestTransport(async (m) => { sent.push(m); }));
afterEach(() => {
  sent.length = 0;
  setTestTransport(null);
});

const stale = (session_id: string) =>
  env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, session_id).run();
const formPost = (host: string, verb: string, fields: Record<string, string>, token: string) =>
  SELF.fetch(`https://${host}/api/${verb}`, {
    method: "POST", redirect: "manual",
    headers: { ...cookieHeaders(token, host), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

describe("reproof", () => {
  it("form post past the proof age goes to /login?reproof=1, the emailed link refreshes proof, then the verb runs", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await grantConsent(env.HUB_DB, { email: "a@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
    await stale(admin.session.id);

    const blocked = await formPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role: "member" }, admin.token);
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get("location")).toBe("https://pimwell.test/login?reproof=1&next=acme");

    const prompt = await (await SELF.fetch("https://pimwell.test/login?reproof=1&next=acme", { headers: { cookie: `pmw_session=${admin.token}` } })).text();
    expect(prompt).toContain('name="reproof" value="1"');

    const ask = await loginPostPage(new Request("https://pimwell.test/login", {
      method: "POST",
      headers: { ...cookieHeaders(admin.token, "pimwell.test"), "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.1" },
      body: new URLSearchParams({ reproof: "1", next: "acme" }).toString(),
    }), env);
    expect(ask.status).toBe(200);
    expect(sent).toHaveLength(1);
    const url = sent[0]!.text.match(/https:\/\/pimwell\.test\/auth\/\S+/)![0];

    const done = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: cookieHeaders(admin.token, "pimwell.test") });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("https://acme.pimwell.test/");

    const ok = await apiPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role: "member" }, cookieHeaders(admin.token, "acme.pimwell.test"));
    expect(ok.status).toBe(200);
  });

  it("JSON callers still get 403 reproof_required", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await stale(admin.session.id);
    const res = await apiPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role: "member" }, cookieHeaders(admin.token, "acme.pimwell.test"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("reproof_required");
  });

  it("a hub verb form post redirects without next", async () => {
    const root = await seedHuman("r@example.com", { is_root: true });
    await stale(root.session.id);
    const res = await formPost("pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, root.token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://pimwell.test/login?reproof=1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reproof.test.ts`
Expected: FAIL; the form post returns 403 JSON instead of 303.

- [ ] **Step 3: Redirect form posts that need reproof**

In `src/http/api.ts`, in the `catch (e)` block, replace the line
```ts
    if (e instanceof HubError) return finish(ctx, env, json({ ok: false, error: e.reason, detail: e.detail ?? null }, e.status));
```
with:
```ts
    if (e instanceof HubError) {
      if (isForm && e.reason === "reproof_required") {
        const next = ctx?.tenant ? `&next=${ctx.tenant.slug}` : "";
        return finish(ctx, env, new Response(null, { status: 303, headers: { location: `https://${env.HUB_DOMAIN}/login?reproof=1${next}`, "cache-control": "no-store" } }));
      }
      return finish(ctx, env, json({ ok: false, error: e.reason, detail: e.detail ?? null }, e.status));
    }
```

- [ ] **Step 4: Update the README**

In `README.md`, replace the final paragraph that begins "Phase 1 has no re-proof flow." with:
```markdown
### Signing in and re-proving

- `https://pimwell.com/login` emails a sign-in link, but only to an address that has written to the hub first (the consent rule). To give consent, or to sign in without the form, send any message to `login@pimwell.com` or `signup@pimwell.com` from your address; the reply carries a link. Links last 15 minutes, work once, and are consumed by the button on `/auth/<token>`, not by opening it.
- Admin changes need a proof less than 60 minutes old. A form post past that age lands on `/login?reproof=1`, which emails a confirmation link to your own address; open it in the same browser. Without consent, write to `login@pimwell.com` and open the reply's link in the browser you are signed in with; that refreshes the proof too.
- Limits: 3 links per address per hour, 20 requests per IP per hour. Over the limit the page answers the same way and sends nothing.
```
In the README verb table, add after the `session.list, ...` row:
```markdown
| login.request | apex | public (neutral answer; `reproof: true` needs a browser session) | |
| login.verify | apex | public (link token) | |
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/reproof.test.ts && npm test && npm run typecheck`
Expected: PASS, including the existing `test/api.test.ts` cases ("accepts form bodies and redirects", fresh-proof JSON cases).

- [ ] **Step 6: Commit**

```bash
git add src/http/api.ts README.md test/reproof.test.ts
git commit -F - <<'EOF'
feat: reproof redirect from form posts; README sign-in notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 9: consent.list and consent.revoke verbs

**Files:**
- Create: `src/verbs/consent.ts`
- Modify: `src/verbs/index.ts`, `README.md` (verb table)
- Test: `test/consent-verbs.test.ts`

**Interfaces:**
- Consumes: `listConsent`, `revokeConsent`, `grantConsent`, `hasActiveConsent` (Task 1); `getIdentityByEmail`, `normalizeEmail`; `getMembership`; `recordEvent`; `defineVerb`; `optString`; `notFound`, `unauthorized`.
- Produces:
  - `consent.list`: kind `query`, scope `public`, minRole `public`, fresh proof none. Params `{ email?: string }`. Result `{ email, active: boolean, consents: [{ id, kind, granted_at, revoked_at }] }`.
  - `consent.revoke`: kind `command`, same scope and role, fresh proof none. Params `{ email?: string }`. Result `{ email, revoked: number }`. Records event `consent.revoke` (`target_kind: "email"`, `target_id: <email>`, `tenant_id` set on the admin path).
  - Authorization (both): no `email` or the caller's own address: the caller. A root: any address. An admin on a tenant host: an address whose identity holds an active membership in that tenant. Anything else: 404 `not_found`. Anonymous: 401.

- [ ] **Step 1: Write the failing test**

`test/consent-verbs.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grantConsent, hasActiveConsent } from "../src/db/consent";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";

const consent = (email: string) => grantConsent(env.HUB_DB, { email, kind: "inbound_email", source_message_id: "<m@example.com>", evidence: "{}" }, Date.now());

describe("consent verbs", () => {
  it("lists and revokes the caller's own consent", async () => {
    const h = await seedHuman("a@example.com");
    await consent("a@example.com");
    const list = (await (await apiPost("pimwell.test", "consent.list", {}, bearer(h.token))).json()) as any;
    expect(list.result.email).toBe("a@example.com");
    expect(list.result.active).toBe(true);
    expect(list.result.consents).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("evidence");
    const rev = (await (await apiPost("pimwell.test", "consent.revoke", {}, bearer(h.token))).json()) as any;
    expect(rev.result).toEqual({ email: "a@example.com", revoked: 1 });
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(false);
    const ev = await env.HUB_DB.prepare("SELECT tenant_id, session_id, target_id FROM event WHERE kind = 'consent.revoke'").first<Record<string, string | null>>();
    expect(ev).toEqual({ tenant_id: null, session_id: h.session.id, target_id: "a@example.com" });
  });

  it("requires a signed-in caller", async () => {
    expect((await apiPost("pimwell.test", "consent.list", {})).status).toBe(401);
    expect((await apiPost("pimwell.test", "consent.revoke", {})).status).toBe(401);
  });

  it("lets a tenant admin manage a member's consent on that tenant only", async () => {
    const acme = await seedTenant("acme");
    const blue = await seedTenant("blue");
    const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
    const blueAdmin = await seedHuman("badmin@example.com", { memberships: [{ tenant_id: blue.id, role: "admin" }] });
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    await seedHuman("m2@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    await consent("m2@example.com");
    expect((await apiPost("blue.pimwell.test", "consent.list", { email: "m2@example.com" }, bearer(blueAdmin.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "consent.list", { email: "m2@example.com" }, bearer(member.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "consent.list", { email: "m2@example.com" }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "consent.list", { email: "nobody@example.com" }, bearer(admin.token))).status).toBe(404);
    const res = await apiPost("acme.pimwell.test", "consent.revoke", { email: "M2@example.com" }, bearer(admin.token));
    expect(res.status).toBe(200);
    expect(await hasActiveConsent(env.HUB_DB, "m2@example.com")).toBe(false);
    const ev = await env.HUB_DB.prepare("SELECT tenant_id FROM event WHERE kind = 'consent.revoke'").first<{ tenant_id: string }>();
    expect(ev!.tenant_id).toBe(acme.id);
  });

  it("lets a root manage any address", async () => {
    const root = await seedHuman("r@example.com", { is_root: true });
    await consent("x@example.com");
    const list = (await (await apiPost("pimwell.test", "consent.list", { email: "x@example.com" }, bearer(root.token))).json()) as any;
    expect(list.result.active).toBe(true);
    expect((await apiPost("pimwell.test", "consent.revoke", { email: "x@example.com" }, bearer(root.token))).status).toBe(200);
    expect(await hasActiveConsent(env.HUB_DB, "x@example.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consent-verbs.test.ts`
Expected: FAIL; `consent.list` returns 404 `unknown_verb`.

- [ ] **Step 3: Write the verbs**

`src/verbs/consent.ts`:
```ts
import { defineVerb } from "./table";
import { optString } from "./params";
import { notFound, unauthorized } from "../errors";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { getMembership } from "../db/memberships";
import { listConsent, revokeConsent } from "../db/consent";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";

async function consentTarget(ctx: Ctx, email: string | null): Promise<{ email: string; tenant_id: string | null }> {
  if (!ctx.identity || !ctx.session) throw unauthorized();
  const own = ctx.identity.email;
  if (!email || normalizeEmail(email) === own) return { email: own, tenant_id: null };
  const target = normalizeEmail(email);
  if (ctx.identity.is_root === 1) return { email: target, tenant_id: ctx.tenant?.id ?? null };
  if (ctx.tenant && ctx.role === "admin") {
    const other = await getIdentityByEmail(ctx.db, target);
    const m = other ? await getMembership(ctx.db, other.id, ctx.tenant.id) : null;
    if (m && m.state === "active") return { email: target, tenant_id: ctx.tenant.id };
  }
  throw notFound("no such address");
}

export const consentList = defineVerb({
  name: "consent.list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "List mail consent for your address (tenant admins: a member's address; roots: any address).",
  parse: (i) => ({ email: optString(i, "email", { max: 254 }) }),
  run: async (ctx, p) => {
    const t = await consentTarget(ctx, p.email);
    const rows = await listConsent(ctx.db, t.email);
    return {
      email: t.email,
      active: rows.some((r) => r.revoked_at === null),
      consents: rows.map((r) => ({ id: r.id, kind: r.kind, granted_at: r.granted_at, revoked_at: r.revoked_at })),
    };
  },
});

export const consentRevoke = defineVerb({
  name: "consent.revoke", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "Revoke mail consent: the hub stops emailing that address until it writes to login@ again.",
  parse: (i) => ({ email: optString(i, "email", { max: 254 }) }),
  run: async (ctx, p) => {
    const t = await consentTarget(ctx, p.email);
    const revoked = await revokeConsent(ctx.db, t.email, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: t.tenant_id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "consent.revoke",
      target_kind: "email", target_id: t.email, summary: `Revoked mail consent for ${t.email} (${revoked} row${revoked === 1 ? "" : "s"})`,
    }, ctx.now);
    return { email: t.email, revoked };
  },
});
```

- [ ] **Step 4: Register and document**

In `src/verbs/index.ts` add `import { consentList, consentRevoke } from "./consent";` and append `consentList, consentRevoke,` to the `registerVerbs([...])` list.

In the `README.md` verb table, add:
```markdown
| consent.list, consent.revoke | any | signed in (own address; tenant admin: a member's; root: any) | |
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/consent-verbs.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/consent.ts src/verbs/index.ts README.md test/consent-verbs.test.ts
git commit -F - <<'EOF'
feat: consent.list and consent.revoke verbs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```

---

### Task 10: Email Routing, deployment, and the smoke test

**Files:**
- Create: `scripts/email-routing.sh`
- Modify: `README.md` (Email section)

**Interfaces:**
- Consumes: the deployed Worker `pimwell-hub` with its `email` export (Task 7) and `MAIL` binding (Task 2).
- Produces: Email Routing rules `login@pimwell.com` and `signup@pimwell.com` with action `worker: pimwell-hub`, or a recorded user action in README if no API token is available.

- [ ] **Step 1: Write the routing script**

`scripts/email-routing.sh`:
```bash
#!/usr/bin/env bash
# Point login@ and signup@ at the pimwell-hub Worker via Email Routing. Idempotent.
# Needs CLOUDFLARE_API_TOKEN with Email Routing Rules Write on the zone (spec 9).
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
DOMAIN="${HUB_DOMAIN:-pimwell.com}"
WORKER="${WORKER_NAME:-pimwell-hub}"
API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

zone=$(curl -fsS "${AUTH[@]}" "$API/zones?name=$DOMAIN" | jq -r '.result[0].id // empty')
[ -n "$zone" ] || { echo "zone $DOMAIN is not visible to this token" >&2; exit 1; }

enabled=$(curl -fsS "${AUTH[@]}" "$API/zones/$zone/email/routing" | jq -r '.result.enabled // false')
if [ "$enabled" != "true" ]; then
  echo "Email Routing is not enabled on $DOMAIN. Enable it in the dashboard (Email > Email Routing), then rerun." >&2
  exit 2
fi

rules=$(curl -fsS "${AUTH[@]}" "$API/zones/$zone/email/routing/rules?per_page=50")
for box in login signup; do
  addr="$box@$DOMAIN"
  if echo "$rules" | jq -e --arg a "$addr" '.result[] | select(any((.matchers // [])[]; .field == "to" and .value == $a))' >/dev/null; then
    echo "rule for $addr already exists"
    continue
  fi
  body=$(jq -n --arg a "$addr" --arg w "$WORKER" \
    '{name: ($a + " to " + $w), enabled: true, matchers: [{type: "literal", field: "to", value: $a}], actions: [{type: "worker", value: [$w]}]}')
  curl -fsS -X POST "${AUTH[@]}" -H 'content-type: application/json' "$API/zones/$zone/email/routing/rules" -d "$body" \
    | jq -r '"created rule " + .result.id + " for " + (.result.matchers[0].value)'
done
```
Run: `chmod +x scripts/email-routing.sh && bash -n scripts/email-routing.sh`
Expected: no output (syntax OK).

- [ ] **Step 2: Document email setup in the README**

Append to `README.md`:
```markdown
## Email

Two addresses reach the Worker's `email` handler: `login@pimwell.com` and `signup@pimwell.com` (they behave the same). Writing to either from a known human address records consent and replies with a sign-in link. Outbound mail leaves only through `sendMail` in `src/mail/send.ts`, from `login@pimwell.com`, and only to addresses with consent.

One-time setup (after `npm run deploy`, since the rules point at the deployed Worker):

1. Email Sending is onboarded on the zone (spec 9); the `send_email` binding `MAIL` in `wrangler.jsonc` only allows `login@pimwell.com` as sender.
2. Email Routing must be enabled on `pimwell.com` (dashboard: Email > Email Routing). This adds Cloudflare's MX records.
3. Route the two addresses to the Worker: `CLOUDFLARE_API_TOKEN=... ./scripts/email-routing.sh`. Without an API token, add two custom-address rules in the dashboard (Email > Email Routing > Routing rules): `login@pimwell.com` and `signup@pimwell.com`, action "Send to a Worker", worker `pimwell-hub`.

Smoke test (staging tenant `blue`, a real human identity whose mailbox passes DMARC):

1. From that mailbox, write to `login@pimwell.com`. Expect a reply from `login@pimwell.com` with a link. Open it, press Sign in, land on the switcher.
2. Sign out, open `https://pimwell.com/login`, enter the same address. Expect an email from `login@pimwell.com`.
3. If step 2 sends nothing and `npx wrangler tail` shows `mail delivery failed send`, switch `sendMail` to the builder shape: in `src/mail/send.ts` replace `else await env.MAIL.send(new EmailMessage(from, to, raw));` with `else await env.MAIL.send({ from, to, subject: mail.subject, text: mail.text });`, run `npm test`, redeploy, repeat step 2.
4. Once both directions work, set the `pimwell.com` DMARC record to `p=reject` (spec 9).
```

- [ ] **Step 3: Deploy if credentials are present**

Run: `npx wrangler whoami`
If it reports an authenticated account with access to `pimwell-hub`, run `npm test && npm run typecheck && npm run deploy`. Expected: deploy succeeds and lists the `MAIL` send_email binding. No migration is needed.
If it is not authenticated, do not deploy; record it in Step 5.

- [ ] **Step 4: Create the routing rules if a token is present**

Run: `test -n "${CLOUDFLARE_API_TOKEN:-}" && ./scripts/email-routing.sh || echo "no CLOUDFLARE_API_TOKEN"`
Expected with a token and a deployed Worker: two lines `created rule ... for login@pimwell.com` and `... signup@pimwell.com` (or `already exists`). Exit code 2 means Email Routing is disabled: record it in Step 5.
Expected without a token: `no CLOUDFLARE_API_TOKEN`.

- [ ] **Step 5: Record outstanding user actions**

For each of Steps 3 and 4 that could not run, append under the README `## Email` section a list headed `Pending user actions (as of YYYY-MM-DD):`, where YYYY-MM-DD is the output of `date +%F`, with the matching lines, chosen from:
```markdown
- Deploy phase 2: `npm run deploy` with an account that can deploy `pimwell-hub`.
- Enable Email Routing on pimwell.com in the dashboard.
- Create the login@ and signup@ routing rules: `./scripts/email-routing.sh` with a token, or the dashboard steps above.
- Run the smoke test above, then set DMARC to `p=reject`.
```
If everything ran, append only the smoke-test line.

- [ ] **Step 6: Verify the single-path rule one last time**

Run: `grep -rn "MAIL\.\|\.reply(" src && npm test && npm run typecheck`
Expected: grep matches only `src/mail/send.ts`; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/email-routing.sh README.md
git commit -F - <<'EOF'
docs: email routing script, setup, and smoke test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015biDmvJ5uAAqB2XrJeEtXk
EOF
```
