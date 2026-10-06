import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedHuman } from "./helpers";
import { createBrowserSession, getSessionByToken } from "../src/db/sessions";

describe("session verbs", () => {
  it("lists own sessions and marks the current one", async () => {
    const h = await seedHuman("a@example.com");
    const other = await createBrowserSession(env.HUB_DB, h.identity.id, Date.now());
    const res = (await (await apiPost("pimwell.test", "session.list", {}, bearer(h.token))).json()) as any;
    expect(res.result.sessions).toHaveLength(2);
    expect(res.result.sessions.find((s: any) => s.id === h.session.id).current).toBe(true);
    expect(res.result.sessions.find((s: any) => s.id === other.session.id).current).toBe(false);
    expect((await apiPost("pimwell.test", "session.list", {})).status).toBe(401);
  });

  it("revokes own session, not another identity's", async () => {
    const a = await seedHuman("a@example.com");
    const b = await seedHuman("b@example.com");
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: b.session.id }, bearer(a.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: a.session.id }, bearer(a.token))).status).toBe(200);
    expect(await getSessionByToken(env.HUB_DB, a.token, Date.now())).toBeNull();
    const root = await seedHuman("r@example.com", { is_root: true });
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: b.session.id }, bearer(root.token))).status).toBe(200);
  });

  it("ends the current session and clears the cookie", async () => {
    const h = await seedHuman("a@example.com");
    const res = await apiPost("pimwell.test", "session.end", {}, cookieHeaders(h.token, "pimwell.test"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await getSessionByToken(env.HUB_DB, h.token, Date.now())).toBeNull();
  });

  it("serves the sessions page to a signed-in human", async () => {
    const h = await seedHuman("a@example.com");
    const res = await SELF.fetch("https://pimwell.test/me/sessions", { headers: { cookie: `pmw_session=${h.token}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(h.session.id);
    expect(html).toContain('action="/api/session.revoke"');
    expect(html).toContain('action="/api/session.end"');
    expect((await SELF.fetch("https://pimwell.test/me/sessions")).status).toBe(401);
  });
});
