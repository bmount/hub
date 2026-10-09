import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createInvite } from "../src/db/invites";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

const invalid = [
  "", "plain", "@example.com", "a@", "a@@example.com", "a@b@example.com",
  "a b@example.com", "a@example .com", "Name <a@example.com>", "a@example.com,b@example.com",
  '"quoted"@example.com', "a(comment)@example.com", ".a@example.com", "a.@example.com", "a..b@example.com",
  "a@localhost", "a@.example.com", "a@example..com", "a@example.com.", "a@-example.com", "a@example-.com",
  "a@exa_mple.com", "a@[127.0.0.1]", "a@" + "b".repeat(64) + ".com",
  "a".repeat(65) + "@example.com", "a".repeat(64) + "@" + [63, 63, 62].map(n => "b".repeat(n)).join("."),
  "é@example.com", "a@exämple.com", "\u00a0a@example.com", "a@example.com\u200b",
  ...["\0", "\t", "\r", "\n", "\x1f", "\x7f"].flatMap(c => [c + "a@example.com", "a@example.com" + c, "a" + c + "@example.com"]),
];

async function counts() {
  const tables = ["invite", "identity", "membership", "session", "proof", "event"];
  // Rejected HTTP commands may retain command.error audit events; those are not invite grants.
  return Promise.all(tables.map(t => env.HUB_DB.prepare(`SELECT COUNT(*) AS n FROM ${t}${t === "event" ? " WHERE kind IN ('invite.create', 'invite.accept', 'bootstrap')" : ""}`).first<{ n: number }>()));
}

async function world() {
  const t = await seedTenant("acme");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  return { t, admin };
}

describe("bounded conservative invite address validation", () => {
  it.each(invalid)("rejects unsupported address %j in direct DB creation without effects", async email => {
    const { t, admin } = await world();
    const before = await counts();
    await expect(createInvite(env.HUB_DB, { tenant_id: t.id, email, role: "member", display_name: null, created_by: admin.identity.id }, Date.now()))
      .rejects.toMatchObject({ status: 400 });
    expect(await counts()).toEqual(before);
  });

  it("accepts dot-atom, subdomain, plus-tag and punycode syntax, normalizes ASCII case/outer spaces", async () => {
    const { t, admin } = await world();
    const valid = [" New.Person+Tag@Example.COM ", "a!#$%&'*+-/=?^_`{|}~b@sub.example.com", "a@xn--bcher-kva.example",
      "a".repeat(64) + "@" + [63, 63, 61].map(n => "b".repeat(n)).join(".")];
    expect(valid[3]!.length).toBe(254);
    for (const email of valid) {
      const { invite } = await createInvite(env.HUB_DB, { tenant_id: t.id, email, role: "member", display_name: null, created_by: admin.identity.id }, Date.now());
      expect(invite.email).toBe(email.trim().toLowerCase());
      expect(invite.accepted_at).toBeNull();
    }
  });

  it("rejects malformed JSON/API and browser-form addresses before invite/audit/proof writes", async () => {
    const { admin } = await world();
    const before = await counts();
    for (const email of invalid) {
      expect((await apiPost("acme.pimwell.test", "invite.create", { email, role: "member" }, bearer(admin.token))).status).toBe(400);
      const res = await SELF.fetch("https://acme.pimwell.test/api/invite.create", {
        method: "POST", headers: { ...cookieHeaders(admin.token, "acme.pimwell.test"), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email, role: "member" }).toString(),
      });
      expect(res.status).toBe(400);
    }
    expect(await counts()).toEqual(before);
  });

  it("keeps invite creation unavailable to MCP connections even with write consent", async () => {
    const { admin } = await world();
    const { tokens } = await connectWithTokens(admin.token, { scope: "read write" });
    const before = await counts();
    for (const email of ["a@@example.com", "a@example.com\n", "Name <a@example.com>", "é@example.com"]) {
      const call = await rpcBody(await mcpPost("acme", tokens.access_token, "tools/call", { name: "invite_create", arguments: { email, role: "member" } }));
      expect(call.result.isError).toBe(true);
      expect(call.result.content[0].text).toContain('no tool named \\"invite_create\\"');
    }
    expect(await counts()).toEqual(before);
  });

  it("does not let malformed addresses bypass tenant authorization", async () => {
    const { t } = await world();
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
    const before = await counts();
    expect((await apiPost("acme.pimwell.test", "invite.create", { email: "a@@example.com", role: "member" })).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "invite.create", { email: "a@@example.com", role: "member" }, bearer(reader.token))).status).toBe(403);
    expect(await counts()).toEqual(before);
  });

  it("returns the normalized address over API but does not create ownership proof", async () => {
    const { admin } = await world();
    const res = await apiPost("acme.pimwell.test", "invite.create", { email: " New.Person+Tag@Example.COM ", role: "member" }, bearer(admin.token));
    expect(res.status).toBe(200);
    expect((await res.json() as { result: { email: string } }).result.email).toBe("new.person+tag@example.com");
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM proof").first()).toEqual({ n: 0 });
    expect(await env.HUB_DB.prepare("SELECT 1 FROM identity WHERE email = 'new.person+tag@example.com'").first()).toBeNull();
  });

  it("bootstrap cannot create a malformed root invite", async () => {
    const before = await counts();
    for (const email of ["a@@example.com", "a@example.com\n", "a".repeat(65) + "@example.com", "a@localhost"]) {
      const res = await apiPost("pimwell.test", "bootstrap", { token: "test-bootstrap-token", email, display_name: "Root" });
      expect(res.status).toBe(400);
    }
    expect(await counts()).toEqual(before);
  });

  it("shows the normalized address and truthful spelling/ownership warning in the form result", async () => {
    const { admin } = await world();
    const form = await SELF.fetch("https://acme.pimwell.test/people?invite=1", { headers: cookieHeaders(admin.token, "acme.pimwell.test") });
    expect(await form.text()).toContain("Format checks do not verify mailbox ownership");
    const result = await SELF.fetch("https://acme.pimwell.test/api/invite.create", {
      method: "POST", headers: { ...cookieHeaders(admin.token, "acme.pimwell.test"), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: " New.Person+Tag@Example.COM ", role: "member" }).toString(),
    });
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toContain("new.person+tag@example.com");
    expect(text).toContain("Format checks do not verify mailbox ownership");
    expect(text).not.toContain(" New.Person+Tag@Example.COM ");
  });

  it("rejects before reflecting markup in an invite-ready result", async () => {
    const { admin } = await world();
    const before = await counts();
    const res = await SELF.fetch("https://acme.pimwell.test/api/invite.create", {
      method: "POST", headers: { ...cookieHeaders(admin.token, "acme.pimwell.test"), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: '<img src=x onerror=alert(1)>@example.com', role: "member" }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("<img src=x");
    expect(await counts()).toEqual(before);
  });
});
