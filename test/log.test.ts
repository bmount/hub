// Request logging (docs/ops/logging.md): one structured line per request, with who acted, and no secrets.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactUrl } from "../src/log";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

const lines = () => {
  const out: Array<Record<string, unknown>> = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      try { const j = JSON.parse(String(a[0])); if (j && typeof j === "object") out.push(j); } catch { /* not ours */ }
    });
  }
  return out;
};
afterEach(() => vi.restoreAllMocks());

describe("redaction", () => {
  it("drops tokens from paths and every query value", () => {
    expect(redactUrl(new URL("https://pimwell.test/invite/pmi_secret123"))).toBe("/invite/:token");
    expect(redactUrl(new URL("https://pimwell.test/auth/pml_secret?next=acme"))).toBe("/auth/:token?next=…");
    expect(redactUrl(new URL("https://acme.pimwell.test/docket?owner=pat%40example.com&kind=snag"))).toBe("/docket?owner=…&kind=…");
    expect(redactUrl(new URL("https://acme.pimwell.test/site/w/3"))).toBe("/site/w/3");
  });
});

describe("request lines", () => {
  it("name who acted, in which organization, and the verb", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const out = lines();
    const res = await SELF.fetch("https://acme.pimwell.test/api/whoami", { method: "POST", headers: { ...cookieHeaders(pat.token, "acme.pimwell.test"), origin: "https://acme.pimwell.test", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const line = out.find((l) => l.msg === "request" && l.path === "/api/whoami");
    expect(line).toMatchObject({ method: "POST", status: 200, tenant: "acme", auth: "cookie", verb: "whoami", via: "api", actor: { id: pat.identity.id, kind: "human", email: "pat@example.com" } });
    expect(JSON.stringify(out)).not.toContain(pat.token);
  });

  it("log a refusal's reason, show the form a readable page, and audit refused sensitive actions", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const out = lines();
    const res = await SELF.fetch("https://pimwell.test/api/tenant.delete", {
      method: "POST", redirect: "manual",
      headers: { cookie: `pmw_session=${pat.token}`, origin: "https://pimwell.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ slug: "acme", confirm: "acme", _back: "/admin/orgs" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("have permission to do that here.");
    expect(out.find((l) => l.msg === "request" && l.path === "/api/tenant.delete")).toMatchObject({ status: 403, verb: "tenant.delete", error: { reason: "forbidden" }, actor: { email: "pat@example.com" } });
    const ev = await env.HUB_DB.prepare("SELECT identity_id, target_id, summary FROM event WHERE kind = 'verb.refused'").first<{ identity_id: string; target_id: string; summary: string }>();
    expect(ev).toMatchObject({ identity_id: pat.identity.id, target_id: "tenant.delete" });
  });
});
