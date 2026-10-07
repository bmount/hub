// Forms as real browsers send them. On 2026-10-07 every signed-in form was refused in browsers: pages sent
// Referrer-Policy: no-referrer, so browsers sent `Origin: null`, and the check wanted our exact origin. The tests had
// always set Origin by hand. These posts carry what browsers actually send.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedHuman, seedTenant } from "./helpers";

let token: string | null = null;
async function post(origin: string | null, site: string | null) {
  if (!token) {
    const t = await seedTenant("acme");
    token = (await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] })).token;
  }
  const headers: Record<string, string> = { cookie: `pmw_session=${token}`, "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  if (site !== null) headers["sec-fetch-site"] = site;
  return SELF.fetch("https://acme.pimwell.test/api/whoami", { method: "POST", redirect: "manual", headers, body: new URLSearchParams({ _back: "/" }).toString() });
}

describe("same-origin check for forms", () => {
  beforeEach(() => { token = null; }); // storage resets between tests
  it("pages ask browsers to send our origin on our own forms", async () => {
    const res = await SELF.fetch("https://pimwell.test/login");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("accepts our exact origin", async () => {
    expect((await post("https://acme.pimwell.test", "same-origin")).status).toBe(303);
  });

  it("accepts Origin: null when the browser says the request came from this origin", async () => {
    expect((await post("null", "same-origin")).status).toBe(303);
    expect((await post(null, "same-origin")).status).toBe(303);
  });

  it("refuses other sites, other organizations' hosts, and a null origin with no browser signal", async () => {
    for (const [origin, site] of [["https://evil.example", "cross-site"], ["https://other.pimwell.test", "same-site"], ["null", "cross-site"], ["null", "same-site"], ["null", null], [null, null]] as const) {
      expect((await post(origin, site)).status, `${origin} ${site}`).toBe(403);
    }
  });
});
