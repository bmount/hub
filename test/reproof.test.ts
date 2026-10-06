import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginPostPage } from "../src/http/login";
import { setTestTransport, type SentMail } from "../src/mail/send";
import { grantConsent } from "../src/db/consent";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const sent: SentMail[] = [];
beforeEach(() => setTestTransport(async (m) => { sent.push(m); }));
afterEach(() => {
  sent.length = 0;
  setTestTransport(null);
});

const stale = (session_id: string) =>
  env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, session_id).run();
const formPost = (host: string, verb: string, fields: Record<string, string>, token: string) =>
  SELF.fetch(`https://${host}/api/${verb}`, {
    method: "POST", redirect: "manual",
    headers: { ...cookieHeaders(token, host), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

describe("reproof", () => {
  it("form post past the proof age goes to /login?reproof=1, the emailed link refreshes proof, then the verb runs", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await grantConsent(env.HUB_DB, { email: "a@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
    await stale(admin.session.id);

    const blocked = await formPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role: "member" }, admin.token);
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get("location")).toBe("https://pimwell.test/login?reproof=1&next=acme");

    const prompt = await (await SELF.fetch("https://pimwell.test/login?reproof=1&next=acme", { headers: { cookie: `pmw_session=${admin.token}` } })).text();
    expect(prompt).toContain('name="reproof" value="1"');

    const ask = await loginPostPage(new Request("https://pimwell.test/login", {
      method: "POST",
      headers: { ...cookieHeaders(admin.token, "pimwell.test"), "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.1" },
      body: new URLSearchParams({ reproof: "1", next: "acme" }).toString(),
    }), env);
    expect(ask.status).toBe(200);
    expect(sent).toHaveLength(1);
    const url = sent[0]!.text.match(/https:\/\/pimwell\.test\/auth\/\S+/)![0];

    const done = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: cookieHeaders(admin.token, "pimwell.test") });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("https://acme.pimwell.test/");

    const ok = await apiPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role: "member" }, cookieHeaders(admin.token, "acme.pimwell.test"));
    expect(ok.status).toBe(200);
  });

  it("JSON callers still get 403 reproof_required", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await stale(admin.session.id);
    const res = await apiPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role: "member" }, cookieHeaders(admin.token, "acme.pimwell.test"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("reproof_required");
  });

  it("a hub verb form post redirects without next", async () => {
    const root = await seedHuman("r@example.com", { is_root: true });
    await stale(root.session.id);
    const res = await formPost("pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, root.token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://pimwell.test/login?reproof=1");
  });
});
