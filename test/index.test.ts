import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("answers healthz", async () => {
    const res = await SELF.fetch("https://pimwell.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("test bindings override wrangler vars", () => {
    expect(env.HUB_DOMAIN).toBe("pimwell.test");
    expect(env.HUB_BOOTSTRAP_TOKEN).toBe("test-bootstrap-token");
  });
});
