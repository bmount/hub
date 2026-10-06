import { describe, expect, it } from "vitest";
import { esc, htmlResponse, page } from "../src/html";

describe("html", () => {
  it("escapes the five characters", () => {
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  it("wraps a body in a document with the escaped title", () => {
    const doc = page("Acme <1>", "<p>hi</p>");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>Acme &lt;1&gt;</title>");
    expect(doc).toContain("<p>hi</p>");
  });

  it("returns an html response with no-store", () => {
    const res = htmlResponse("<p>x</p>", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
