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
