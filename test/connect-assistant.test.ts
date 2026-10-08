import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assistantConnectionGuide } from "../src/http/connectAssistant";
import { OAUTH_SCOPES } from "../src/oauth/config";

describe("grounded assistant connection instructions", () => {
  it("gives the organization MCP URL, OAuth, actual scopes and verification without agent secrets", async () => {
    const res = await SELF.fetch(`https://acme.${env.HUB_DOMAIN}/connect-assistant.json`);
    expect(res.status).toBe(200);
    const guide = await res.json() as ReturnType<typeof assistantConnectionGuide>;
    expect(guide.mcp_url).toBe(`https://acme.${env.HUB_DOMAIN}/mcp`);
    expect(guide.authentication).toBe("oauth");
    expect(guide.transport).toBe("streamable-http");
    expect(guide.supported_scopes).toEqual([...OAUTH_SCOPES]);
    expect(guide.organization_required).toBe(false);
    expect(guide.steps.join(" ")).toContain("whoami and capabilities");
    expect(guide.steps.join(" ")).toContain("Do not paste agent tokens");
    expect(JSON.stringify(guide)).not.toContain("/agent/mcp");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not invent an apex MCP URL or promise unsupported write access", async () => {
    const guide = assistantConnectionGuide(env, null);
    expect(guide.mcp_url).toBeNull();
    expect(guide.organization_required).toBe(true);
    expect(guide.steps.join(" ")).toContain("read-only grant cannot perform writes");
    const res = await SELF.fetch(`https://${env.HUB_DOMAIN}/connect-assistant`);
    const html = await res.text();
    expect(html).toContain("&lt;org&gt;");
    expect(html).toContain("OAuth");
    expect(html).toContain("Machine-readable connection guide");
  });

  it("refuses foreign hosts rather than generating credential destinations from them", async () => {
    const res = await SELF.fetch("https://attacker.example/connect-assistant.json");
    expect(res.status).toBe(404);
  });
});
