import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/http/api";
import { registerAllVerbs } from "../src/verbs/index";
import { setTestTransport, type SentMail } from "../src/mail/send";
import { grantConsent } from "../src/db/consent";
import { createAuthLink, findAuthLinkByToken } from "../src/db/authLinks";
import { getSessionByToken } from "../src/db/sessions";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";

beforeAll(() => registerAllVerbs());
const sent: SentMail[] = [];
beforeEach(() => setTestTransport(async (m) => { sent.push(m); }));
afterEach(() => {
  sent.length = 0;
  setTestTransport(null);
});

const consent = (email: string) => grantConsent(env.HUB_DB, { email, kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
function call(host: string, verb: string, body: unknown, headers: Record<string, string> = {}, waitUntil?: (p: Promise<unknown>) => void) {
  return handleApi(new Request(`https://${host}/api/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.1", ...headers },
    body: JSON.stringify(body),
  }), env, waitUntil);
}

describe("login.request", () => {
  it("answers identically for known and unknown addresses", async () => {
    await seedHuman("known@example.com");
    await consent("known@example.com");
    const a = await call("pimwell.test", "login.request", { email: "known@example.com" });
    const b = await call("pimwell.test", "login.request", { email: "nobody@example.com" });
    expect(a.status).toBe(200);
    expect(await a.text()).toBe(await b.text());
    expect(sent.map((m) => m.to)).toEqual(["known@example.com"]);
  });

  it("schedules the send with waitUntil instead of awaiting it", async () => {
    await seedHuman("known@example.com");
    await consent("known@example.com");
    const pending: Promise<unknown>[] = [];
    const res = await call("pimwell.test", "login.request", { email: "known@example.com" }, {}, (p) => { pending.push(p); });
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(sent.map((m) => m.to)).toEqual(["known@example.com"]);
  });

  it("is apex-only and needs an email", async () => {
    await seedTenant("acme");
    expect((await call("acme.pimwell.test", "login.request", { email: "a@example.com" })).status).toBe(404);
    expect((await call("pimwell.test", "login.request", {})).status).toBe(400);
  });

  it("reproof needs a browser session and goes to that session's address", async () => {
    const h = await seedHuman("a@example.com");
    await consent("a@example.com");
    expect((await call("pimwell.test", "login.request", { reproof: true })).status).toBe(401);
    expect((await call("pimwell.test", "login.request", { reproof: true, email: "x@example.com" }, bearer(h.token))).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["a@example.com"]);
    expect(sent[0]!.subject).toBe("Confirm it's you on Pimwell");
  });
});

describe("login.verify", () => {
  it("returns a new browser session token once; then 404 like an unknown token", async () => {
    const h = await seedHuman("a@example.com");
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    const res = await apiPost("pimwell.test", "login.verify", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { session_token: string; location: string; identity_id: string } };
    expect(body.result.session_token).toMatch(/^pms_/);
    expect(body.result.location).toBe("https://pimwell.test/");
    expect((await getSessionByToken(env.HUB_DB, body.result.session_token, Date.now()))!.identity_id).toBe(h.identity.id);
    const again = await apiPost("pimwell.test", "login.verify", { token });
    const unknown = await apiPost("pimwell.test", "login.verify", { token: `pml_${"A".repeat(43)}` });
    expect(again.status).toBe(404);
    expect(await again.text()).toBe(await unknown.text());
  });

  it("a reproof link refreshes the calling browser session and refuses others", async () => {
    const h = await seedHuman("a@example.com");
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = 0 WHERE id = ?").bind(h.session.id).run();
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "reproof", Date.now());
    const anon = await apiPost("pimwell.test", "login.verify", { token });
    expect(anon.status).toBe(403);
    expect(((await anon.json()) as { error: string }).error).toBe("session_mismatch");
    expect((await findAuthLinkByToken(env.HUB_DB, token))!.used_at).toBeNull();
    const ok = await apiPost("pimwell.test", "login.verify", { token }, bearer(h.token));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { session_token: string | null } }).result.session_token).toBeNull();
    expect((await getSessionByToken(env.HUB_DB, h.token, Date.now()))!.last_proof_at).toBeGreaterThan(Date.now() - 60_000);
  });
});
