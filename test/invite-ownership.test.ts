import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createInvite } from "../src/db/invites";
import { recordProof } from "../src/db/proofs";
import { invitePage } from "../src/http/pages";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

async function grants() {
  const tables = ["invite", "identity", "membership", "session", "proof", "event"];
  return Promise.all(tables.map(async t => (await env.HUB_DB.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).results));
}

describe("invite tokens are not independent address-control proof", () => {
  it("fails closed truthfully when no independent onboarding provider is configured", async () => {
    const tenant = await seedTenant("acme");
    const { token } = await createInvite(env.HUB_DB, { tenant_id: tenant.id, email: "new@example.com", role: "member", display_name: null, created_by: null }, Date.now());
    const before = await grants();
    const res = await invitePage(new Request(`https://pimwell.test/invite/${token}`), { ...env, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });
    const html = await res.text();
    expect(html).toContain("Independent address verification is unavailable");
    expect(html).not.toContain('href="/login/google');
    expect(html).not.toContain("<form");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await grants()).toEqual(before);
  });

  it.each(["expired", "revoked", "archived"])("keeps %s invitations neutral and read-only on GET and POST", async state => {
    const tenant = await seedTenant("acme");
    const { invite, token } = await createInvite(env.HUB_DB, { tenant_id: tenant.id, email: "new@example.com", role: "member", display_name: null, created_by: null }, Date.now());
    if (state === "archived") await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(tenant.id).run();
    else await env.HUB_DB.prepare(`UPDATE invite SET ${state === "expired" ? "expires_at" : "revoked_at"} = 1 WHERE id = ?`).bind(invite.id).run();
    const before = await grants();
    for (const method of ["GET", "POST"]) {
      const res = await SELF.fetch(`https://pimwell.test/invite/${token}`, { method, headers: { origin: "https://pimwell.test" } });
      const html = await res.text();
      expect(html).toContain("not valid");
      expect(html).not.toContain("new@example.com");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await grants()).toEqual(before);
    }
  });
  it("anonymous possession and forged body/header email cannot create an identity, grant or proof", async () => {
    const tenant = await seedTenant("acme");
    const { token } = await createInvite(env.HUB_DB, { tenant_id: tenant.id, email: "typo@example.com", role: "admin", display_name: "Typo", created_by: null }, Date.now());
    const before = await grants();
    for (let i = 0; i < 2; i++) {
      const res = await SELF.fetch(`https://pimwell.test/invite/${token}`, { method: "POST", redirect: "manual",
        headers: { origin: "https://pimwell.test", "content-type": "application/x-www-form-urlencoded", "x-verified-email": "typo@example.com" },
        body: "email=typo%40example.com&email_verified=true" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Verify your invited address");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await grants()).toEqual(before);
    }
  });

  it("neither wrong-identity nor legacy invite-derived sessions/proofs can accept or promote a root", async () => {
    const victim = await seedHuman("victim@example.com");
    const wrong = await seedHuman("wrong@example.com");
    // Legacy freshness/proof cannot be promoted into independent address verification.
    await recordProof(env.HUB_DB, { identity_id: victim.identity.id, kind: "email", subject: victim.identity.email }, Date.now());
    const { token } = await createInvite(env.HUB_DB, { tenant_id: null, email: "victim@example.com", role: "root", display_name: null, created_by: null }, Date.now());
    const before = await grants();
    for (const session of [wrong.token, victim.token]) {
      const res = await SELF.fetch(`https://pimwell.test/invite/${token}`, { method: "POST", redirect: "manual", headers: cookieHeaders(session, "pimwell.test") });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Verify your invited address");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await grants()).toEqual(before);
    }
  });
});
