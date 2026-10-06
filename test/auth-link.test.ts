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
