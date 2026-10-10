import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { ASSETS } from "../src/assets";
import { esc, HTML_CSP, htmlResponse, page } from "../src/html";

describe("html", () => {
  it.each(["/", "/login", "/signed-out", "/privacy", "/terms", "/invite/invalid", "/auth/invalid", "/unknown"])('protects the HTML route %s without inline scripts', async path => {
    const res = await SELF.fetch(`https://pimwell.test${path}`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(HTML_CSP);
    expect(await res.text()).not.toMatch(/<script(?![^>]*\bsrc=)|\son(?:click|submit|change)=|javascript:/i);
  });

  it("serves every script as a current, immutable, nosniff static asset", async () => {
    for (const asset of Object.values(ASSETS)) {
      const res = await SELF.fetch(`https://pimwell.test${asset.path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(asset.type);
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe(asset.body);
      if (asset.type.startsWith("text/javascript")) expect(() => new Function(asset.body)).not.toThrow();
    }
    expect((await SELF.fetch("https://pimwell.test/assets/assistant.old.js")).status).toBe(404);
  });

  it("escapes the five characters", () => {
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  it("wraps a body in a document with the escaped title", () => {
    const doc = page("Acme <1>", "<p>hi</p>");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>Acme &lt;1&gt;</title>");
    expect(doc).toContain("<p>hi</p>");
  });

  it("escapes account names, addresses and roles in both account displays", () => {
    const doc = page("Account", "", {
      brandHref: "/", org: null, nav: [], tip: "",
      me: { name: "<Name>", email: 'a"<b>@example.com', role: "<role>", href: "/me" },
    });
    expect(doc).toContain('>a&quot;&lt;b&gt;@example.com (&lt;role&gt;)</a>');
    expect(doc).toContain('<li class="account-details">a&quot;&lt;b&gt;@example.com<span>Role: &lt;role&gt;</span></li>');
    expect(doc).toContain(">&lt;Name&gt;</a>");
    expect(doc).not.toContain("<role>");
  });

  it("returns an html response with no-store", () => {
    const res = htmlResponse("<p>x</p>", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(HTML_CSP);
    for (const rule of ["default-src 'self'", "script-src 'self'", "script-src-attr 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      expect(HTML_CSP.split("; ")).toContain(rule);
    }
    expect(HTML_CSP).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|https:|data:|blob:)/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
