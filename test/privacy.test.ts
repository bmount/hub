import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("privacy policy", () => {
  it("is public at /privacy on the apex", async () => {
    const res = await SELF.fetch("https://pimwell.test/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>Privacy policy</h1>");
    expect(html).toContain("privacy@pimwell.com");
  });

  it("has terms of service beside it", async () => {
    const res = await SELF.fetch("https://pimwell.test/terms");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Terms of service</h1>");
    expect(html).toContain('href="/privacy"');
  });
});
