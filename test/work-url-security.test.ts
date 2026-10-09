import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "../src/security/urls";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const unsafe = [
  "javascript:alert(document.domain)", "JaVaScRiPt:alert(1)", "java\nscript:alert(1)",
  "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd",
  "http://example.com/", "//example.com/x", "/relative", "https:example.com", "https:///",
  "https://user:password@example.com/", "https://user@example.com/", "https://@example.com/", "https://:@example.com/", " https://example.com/",
  "https://example.com/ ", "https://example.com/\u0000", "https://example.com/%0afoo",
  "https://example.com/%0Dfoo", "https://example.com/%7Ffoo", "https://example.com/\t",
  "https:\\\\example.com/", "https://example.com\\@evil.test/", "%6aavascript:alert(1)",
];

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const headers = cookieHeaders(pat.token, HOST);
  const response = await apiPost(HOST, "work.create", { project: "site", kind: "snag", title: "URL security" }, headers);
  const { result: { item } } = await response.json() as { result: { item: { id: string; number: number } } };
  return { pat, headers, item };
}

describe("external work URLs", () => {
  it.each(unsafe)("rejects unsafe URL %j", (url) => expect(safeExternalUrl(url)).toBeNull());
  it("canonicalizes HTTPS and permits escaped query/fragment evidence", () => {
    expect(safeExternalUrl("HTTPS://EXAMPLE.COM:443/a?x=1&y=%22#details")).toBe("https://example.com/a?x=1&y=%22#details");
    expect(safeExternalUrl("https://example.com/search?q=two%20words")).toBeTruthy();
  });
  it("rejects every unsafe create path without inserting or auditing a link", async () => {
    const w = await world();
    for (const target_ref of unsafe) {
      const r = await apiPost(HOST, "work.link", { id: w.item.id, target_kind: "url", target_ref }, w.headers);
      expect(r.status, target_ref).toBe(400);
    }
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_link").first("n")).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'work.link'").first("n")).toBe(0);
  });
  it("round-trips an approved URL and renders a safe escaped anchor", async () => {
    const w = await world();
    const url = "HTTPS://EXAMPLE.COM:443/evidence?a=1&b=%22#report";
    const r = await apiPost(HOST, "work.link", { id: w.item.id, target_kind: "url", target_ref: url }, w.headers);
    expect(r.status).toBe(200);
    const read = await apiPost(HOST, "work.read", { id: w.item.id }, w.headers);
    expect(await read.text()).toContain("https://example.com/evidence?a=1&b=%22#report");
    const html = await (await SELF.fetch(`https://${HOST}/site/w/${w.item.number}`, { headers: w.headers })).text();
    expect(html).toContain('href="https://example.com/evidence?a=1&amp;b=%22#report" rel="noopener noreferrer"');
  });
  it("renders unsafe legacy links inert, even when they contain attribute injection", async () => {
    const w = await world();
    const legacy = [...unsafe, 'javascript:alert(1)" onmouseover="alert(2)'];
    for (const [i, ref] of legacy.entries()) await env.HUB_DB.prepare("INSERT INTO work_link (id, item_id, target_kind, target_ref, created_by, created_at) VALUES (?, ?, 'url', ?, ?, ?)").bind(`legacy-${i}`, w.item.id, ref, w.pat.identity.id, Date.now()).run();
    const html = await (await SELF.fetch(`https://${HOST}/site/w/${w.item.number}`, { headers: w.headers })).text();
    expect(html).toContain("<code>javascript:alert(document.domain)</code>");
    for (const match of html.matchAll(/href="([^"]*)"/g)) expect(match[1]).not.toMatch(/^(?:javascript|data|vbscript|file|http):/i);
    expect(html).not.toContain(' onmouseover="alert(2)"');
  });
});
