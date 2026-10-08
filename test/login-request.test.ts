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
    await createIdentity(env.HUB_DB, { kind: "agent", email: "acme.bot@pimwell.test", display_name: "Bot", is_root: 0, operator_id: gone.identity.id }, Date.now());
    await consent("acme.bot@pimwell.test");
    for (const email of ["nobody@example.com", "quiet@example.com", "gone@example.com", "acme.bot@pimwell.test", "not-an-email", ""]) await ask(email);
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

describe("agents", () => {
  it("cleanNext accepts only tenant slugs", () => {
    expect(cleanNext("acme")).toBe("acme");
    expect(cleanNext(" ACME ")).toBe("acme");
    expect(cleanNext("https://evil.example")).toBeNull();
    expect(cleanNext("login")).toBeNull();
    expect(cleanNext("")).toBeNull();
    expect(cleanNext(null)).toBeNull();
    // A page on the organization's own host, so a confirmation returns where it started.
    expect(cleanNext("acme/people?connect=1")).toBe("acme/people?connect=1");
    expect(cleanNext("acme//evil.example")).toBeNull();
    expect(cleanNext("acme/x@evil.example")).toBeNull();
    expect(cleanNext("acme/\\evil")).toBeNull();
  });

  it("authUrl and linkMail", () => {
    expect(authUrl(env, "pml_x", null)).toBe("https://pimwell.test/auth/pml_x");
    expect(authUrl(env, "pml_x", "acme")).toBe("https://pimwell.test/auth/pml_x?next=acme");
    expect(linkMail("login", "https://pimwell.test/auth/pml_x").text).toContain("https://pimwell.test/auth/pml_x");
  });
});

describe("requestLink fails closed", () => {
  const stub = (over: Partial<KVNamespace>) => ({ ...env, RATE: { get: async () => null, put: async () => undefined, ...over } as unknown as KVNamespace });
  const attempt = (e: typeof env) => requestLink(e, { email: "a@example.com", purpose: "login", ip: "198.51.100.1", next: null, session_id: null }, Date.now());

  it("resolves and sends nothing when KV put throws", async () => {
    await seedHuman("a@example.com");
    await consent("a@example.com");
    await expect(attempt(stub({ put: async () => { throw new Error("429") as never; } }))).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(await linkCount()).toBe(0);
  });

  it("resolves and sends nothing when KV get throws", async () => {
    await seedHuman("a@example.com");
    await consent("a@example.com");
    await expect(attempt(stub({ get: async () => { throw new Error("down") as never; } }))).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
