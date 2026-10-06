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
