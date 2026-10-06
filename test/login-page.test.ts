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

  it("answers neutrally for an over-long /auth token", async () => {
    const res = await SELF.fetch(`https://pimwell.test/auth/${"A".repeat(129)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not valid");
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
