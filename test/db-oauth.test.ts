import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  GRANT_TTL_MS, getGrantById, getGrantBySessionId, listLiveGrantsForIdentity, liveGrant, replaceEarlierGrants, revokeGrantRows, revokeGrantsFor, rotateRefreshHash,
} from "../src/db/oauthGrants";
import { getSessionById } from "../src/db/sessions";
import { seedGrant, seedHuman, seedTenant } from "./helpers";

const db = () => env.HUB_DB;

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "reader" }] });
  return { acme, blue, h };
}

describe("oauth grants", () => {
  it("writes a grant and its oauth session together", async () => {
    const { acme, h } = await setup();
    const { grant, session } = await seedGrant(acme, h);
    expect(grant).toMatchObject({ identity_id: h.identity.id, tenant_id: acme.id, session_id: session.id, scopes: "read", resource: "https://acme.pimwell.test/mcp", library_grant_id: null });
    expect(grant.expires_at - grant.created_at).toBe(GRANT_TTL_MS);
    const row = await getSessionById(db(), session.id);
    expect(row).toMatchObject({ kind: "oauth", tenant_id: acme.id, label: "Test App", last_proof_at: h.session.last_proof_at, expires_at: grant.expires_at, parent_token_id: null });
    expect((await getGrantBySessionId(db(), session.id))!.id).toBe(grant.id);
  });

  it("replaces a live grant for the same client and resource only", async () => {
    const { acme, blue, h } = await setup();
    const first = await seedGrant(acme, h);
    const other = await seedGrant(blue, h);
    const second = await seedGrant(acme, h);
    expect((await getGrantById(db(), first.grant.id))!.revoked_at).toBeNull();
    // Only earlier grants are replaced, so two concurrent approvals cannot revoke each other.
    expect(await replaceEarlierGrants(db(), first.grant, Date.now())).toEqual([]);
    expect((await replaceEarlierGrants(db(), second.grant, Date.now())).map((g) => g.id)).toEqual([first.grant.id]);
    expect(await getGrantById(db(), first.grant.id)).toMatchObject({ revoke_reason: "replaced", revoked_by: h.identity.id });
    expect((await getSessionById(db(), first.session.id))!.revoked_at).not.toBeNull();
    expect((await getGrantById(db(), other.grant.id))!.revoked_at).toBeNull();
    expect((await getGrantById(db(), second.grant.id))!.revoked_at).toBeNull();
  });

  it("is live only while grant, session, identity, membership, and tenant are", async () => {
    const { acme, h } = await setup();
    const now = Date.now();
    const { grant, session } = await seedGrant(acme, h);
    const live = await liveGrant(db(), grant.id, now);
    expect(live).toMatchObject({ grant: { id: grant.id }, session: { id: session.id, kind: "oauth" }, identity: { id: h.identity.id }, tenant: { slug: "acme" }, membership: { role: "member" } });
    expect(await liveGrant(db(), grant.id, grant.expires_at)).toBeNull();
    const cases: Array<[string, string]> = [
      ["UPDATE membership SET state = 'archived' WHERE identity_id = ?1", "UPDATE membership SET state = 'active' WHERE identity_id = ?1"],
      ["UPDATE identity SET state = 'archived' WHERE id = ?1", "UPDATE identity SET state = 'active' WHERE id = ?1"],
      ["UPDATE tenant SET state = 'archived' WHERE slug = 'acme' AND ?1 IS NOT NULL", "UPDATE tenant SET state = 'active' WHERE slug = 'acme' AND ?1 IS NOT NULL"],
      ["UPDATE session SET revoked_at = 1 WHERE identity_id = ?1 AND kind = 'oauth'", "UPDATE session SET revoked_at = NULL WHERE identity_id = ?1 AND kind = 'oauth'"],
    ];
    for (const [off, on] of cases) {
      await db().prepare(off).bind(h.identity.id).run();
      expect(await liveGrant(db(), grant.id, now)).toBeNull();
      await db().prepare(on).bind(h.identity.id).run();
      expect(await liveGrant(db(), grant.id, now)).not.toBeNull();
    }
    expect(await revokeGrantRows(db(), grant.id, h.identity.id, "user", now)).toBe(true);
    expect(await revokeGrantRows(db(), grant.id, h.identity.id, "user", now)).toBe(false);
    expect(await liveGrant(db(), grant.id, now)).toBeNull();
    expect((await getSessionById(db(), session.id))!.revoked_at).toBe(now);
  });

  it("keeps a root's grant live without a membership", async () => {
    const acme = await seedTenant("acme");
    const root = await seedHuman("root@example.com", { is_root: true });
    const { grant } = await seedGrant(acme, root);
    expect((await liveGrant(db(), grant.id, Date.now()))!.membership).toBeNull();
  });

  it("rotates the refresh hash only from the expected value", async () => {
    const { acme, h } = await setup();
    const { grant } = await seedGrant(acme, h);
    expect(await rotateRefreshHash(db(), grant.id, "x", "a", 1)).toBe(false);
    expect(await rotateRefreshHash(db(), grant.id, null, "a", 1)).toBe(true);
    expect(await rotateRefreshHash(db(), grant.id, null, "b", 2)).toBe(false);
    expect(await rotateRefreshHash(db(), grant.id, "a", "b", 2)).toBe(true);
    expect(await getGrantById(db(), grant.id)).toMatchObject({ refresh_hash: "b", prev_refresh_hash: "a", refreshed_at: 2 });
  });

  it("cascades by tenant, by identity, and by membership", async () => {
    const { acme, blue, h } = await setup();
    const h2 = await seedHuman("b@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const a1 = await seedGrant(acme, h);
    const b1 = await seedGrant(blue, h);
    const a2 = await seedGrant(acme, h2);
    const byMembership = await revokeGrantsFor(db(), { identity_id: h.identity.id, tenant_id: blue.id }, null, "membership", 5);
    expect(byMembership.map((g) => g.id)).toEqual([b1.grant.id]);
    const byTenant = await revokeGrantsFor(db(), { tenant_id: acme.id }, null, "tenant", 6);
    expect(byTenant.map((g) => g.id).sort()).toEqual([a1.grant.id, a2.grant.id].sort());
    expect((await getSessionById(db(), a2.session.id))!.revoked_at).toBe(6);
    expect(await revokeGrantsFor(db(), { identity_id: h.identity.id }, null, "identity", 7)).toEqual([]);
    await expect(revokeGrantsFor(db(), {}, null, "x", 8)).rejects.toThrow();
  });

  it("lists an identity's live grants with tenant and last use", async () => {
    const { acme, blue, h } = await setup();
    const a = await seedGrant(acme, h);
    const b = await seedGrant(blue, h, "client-2");
    await revokeGrantRows(db(), b.grant.id, h.identity.id, "user", Date.now());
    const rows = await listLiveGrantsForIdentity(db(), h.identity.id, Date.now());
    expect(rows).toEqual([{ grant: a.grant, tenant_slug: "acme", last_seen_at: a.session.last_seen_at }]);
  });
});
