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
