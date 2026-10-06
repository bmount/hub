import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/db/identities";
import {
  SESSION_MAX_MS, SESSION_ROLLING_MS, createBrowserSession, getSessionByToken, listSessions, revokeSession, touchSession,
} from "../src/db/sessions";
import { COOKIE_NAME, clearSessionCookie, readSessionToken, sessionCookie } from "../src/auth/cookie";

const db = () => env.HUB_DB;
const now = 1_700_000_000_000;
const HOUR = 3600 * 1000;

async function ident() {
  return createIdentity(db(), { kind: "human", email: "a@example.com", display_name: "A", is_root: 0, operator_id: null }, now);
}

describe("sessions", () => {
  it("creates and finds by token; token is not stored", async () => {
    const id = await ident();
    const { session, token } = await createBrowserSession(db(), id.id, now);
    expect(token).toMatch(/^pms_/);
    expect(session.kind).toBe("browser");
    expect(session.last_proof_at).toBe(now);
    expect(session.expires_at).toBe(now + SESSION_ROLLING_MS);
    expect((await getSessionByToken(db(), token, now + 1))?.id).toBe(session.id);
    expect(await getSessionByToken(db(), "pms_bogus", now)).toBeNull();
  });

  it("is invisible after expiry or revocation", async () => {
    const id = await ident();
    const { session, token } = await createBrowserSession(db(), id.id, now);
    expect(await getSessionByToken(db(), token, now + SESSION_ROLLING_MS)).toBeNull();
    expect(await revokeSession(db(), session.id, now + 1)).toBe(true);
    expect(await revokeSession(db(), session.id, now + 2)).toBe(false);
    expect(await getSessionByToken(db(), token, now + 3)).toBeNull();
    expect(await listSessions(db(), id.id, now + 4)).toEqual([]);
  });

  it("touch refreshes at most hourly and respects the absolute cap", async () => {
    const id = await ident();
    const { session } = await createBrowserSession(db(), id.id, now);
    const same = await touchSession(db(), session, now + HOUR - 1);
    expect(same.last_seen_at).toBe(now);
    const moved = await touchSession(db(), session, now + HOUR);
    expect(moved.last_seen_at).toBe(now + HOUR);
    expect(moved.expires_at).toBe(now + HOUR + SESSION_ROLLING_MS);
    const late = await touchSession(db(), moved, now + SESSION_MAX_MS - HOUR);
    expect(late.expires_at).toBe(now + SESSION_MAX_MS);
  });
});

describe("cookie", () => {
  it("sets a hub-wide secure cookie and clears it", () => {
    const v = sessionCookie("pms_abc", "pimwell.test");
    expect(v).toContain(`${COOKIE_NAME}=pms_abc`);
    expect(v).toContain("Domain=.pimwell.test");
    expect(v).toContain("Secure");
    expect(v).toContain("HttpOnly");
    expect(v).toContain("SameSite=Lax");
    expect(v).toContain("Path=/");
    expect(clearSessionCookie("pimwell.test")).toContain("Max-Age=0");
  });
  it("omits Domain for localhost", () => {
    expect(sessionCookie("pms_abc", "localhost")).not.toContain("Domain=");
  });
  it("reads the token from the request", () => {
    const req = new Request("https://pimwell.test/", { headers: { cookie: `other=1; ${COOKIE_NAME}=pms_xyz; z=2` } });
    expect(readSessionToken(req)).toBe("pms_xyz");
    expect(readSessionToken(new Request("https://pimwell.test/"))).toBeNull();
  });
});
