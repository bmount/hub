// Request logging (docs/ops/logging.md): one structured line per request, with who acted, and no secrets.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactUrl, emit } from "../src/log";
import { handleApi } from "../src/http/api";
import { createProject } from "../src/db/projects";
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
  it("drops content placed in arbitrary log fields", () => {
    const out = lines();
    emit({ msg: "request", status: 500, path: "/private-mail-body", ua: "private interview", error: { detail: "private post" } });
    expect(out).toEqual([{ msg: "request", status: 500 }]);
  });

  it("only induces the fixed exception after an authorized status read", async () => {
    const t = await seedTenant("acme");
    await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const errors: string[] = [];
    const pending: Promise<unknown>[] = [];
    const wait = (p: Promise<unknown>) => { pending.push(p.catch(e => { errors.push(e.message); })); };
    const call = (authenticated: boolean, project = "site") => handleApi(new Request("https://acme.pimwell.test/api/project.status", {
      method: "POST", headers: { ...(authenticated ? cookieHeaders(pat.token, "acme.pimwell.test") : {}), origin: "https://acme.pimwell.test",
        "content-type": "application/json", "x-pimwell-telemetry-probe": "exception" }, body: JSON.stringify({ project }),
    }), env, wait);
    expect((await call(false)).status).not.toBe(200);
    expect((await call(true, "missing")).status).not.toBe(200);
    await Promise.all(pending);
    expect(errors).toEqual([]);
    expect((await call(true)).status).toBe(200);
    await Promise.all(pending);
    expect(errors).toEqual(["Pimwell telemetry test exception"]);
  });
  it("logs status and timing without identifying or arbitrary request content", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const out = lines();
    const res = await SELF.fetch("https://acme.pimwell.test/api/whoami", { method: "POST", headers: { ...cookieHeaders(pat.token, "acme.pimwell.test"), origin: "https://acme.pimwell.test", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const line = out.find((l) => l.msg === "request");
    expect(line).toMatchObject({ status: 200 });
    expect(line).not.toHaveProperty("path");
    expect(line).not.toHaveProperty("actor");
    expect(line).not.toHaveProperty("error");
    expect(JSON.stringify(out)).not.toContain(pat.token);
  });

  it("log a refusal's reason, show the form a readable page, and audit refused sensitive actions", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const out = lines();
    const res = await SELF.fetch("https://pimwell.test/api/tenant.delete", {
      method: "POST", redirect: "manual",
      headers: { cookie: `pmw_session=${pat.token}`, origin: "https://pimwell.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ slug: "acme", confirm: "acme", _back: "/admin/orgs" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("have permission to do that here.");
    expect(out.find((l) => l.msg === "request")).toMatchObject({ status: 403 });
    expect(JSON.stringify(out)).not.toContain("pat@example.com");
    const ev = await env.HUB_DB.prepare("SELECT identity_id, target_id, summary FROM event WHERE kind = 'verb.refused'").first<{ identity_id: string; target_id: string; summary: string }>();
    expect(ev).toMatchObject({ identity_id: pat.identity.id, target_id: "tenant.delete" });
  });
});
