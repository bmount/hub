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

  it("a bearer invite cannot create an identity or manufacture an email proof", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const created = (await (await apiPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role: "member" }, bearer(admin.token))).json()) as { result: { invite_url: string } };
    const post = await SELF.fetch(created.result.invite_url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(200);
    expect(await getIdentityByEmail(db(), "new@example.com")).toBeNull();
    expect((await db().prepare("SELECT * FROM proof").all()).results).toEqual([]);
  });

  it("a bearer invite for an existing identity records no proof", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const old = await seedHuman("old@example.com");
    const created = (await (await apiPost("acme.pimwell.test", "invite.create", { email: "old@example.com", role: "member" }, bearer(admin.token))).json()) as { result: { invite_url: string } };
    const post = await SELF.fetch(created.result.invite_url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(200);
    expect(await listProofs(db(), old.identity.id)).toEqual([]);
  });
});
