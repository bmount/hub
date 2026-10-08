// Hub readiness (2026-10-07): agents stay connected and executives work over MCP all day, so a /mcp call has a
// round-trip budget like pages do. Measured from the Server-Timing header the hub writes on every response.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { seedHuman, seedTenant } from "./helpers";
import { connectWithTokens, mcpPost } from "./oauth-helpers";

const trips = (h: string | null) => Number(/(\d+) round trips/.exec(h ?? "")?.[1] ?? NaN);
export const MCP_TRIP_BUDGET = 3;

describe("MCP budget", () => {
  it("keeps each MCP call within a small number of D1 round trips", async () => {
    const acme = await seedTenant("acme");
    await createProject(env.HUB_DB, { tenant_id: acme.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const access = (await connectWithTokens(ann.token, {})).tokens.access_token;
    const calls: Array<[string, Record<string, unknown> | undefined]> = [
      ["tools/list", undefined], ["tools/list", undefined],
      ["tools/call", { name: "whoami", arguments: {} }], ["tools/call", { name: "work_list", arguments: {} }], ["tools/call", { name: "attention_list", arguments: {} }],
    ];
    const report: string[] = [];
    for (const [method, params] of calls) {
      const res = await mcpPost("acme", access, method, params as never);
      report.push(`${method}${params ? ` ${String(params.name)}` : ""}: ${trips(res.headers.get("server-timing"))}`);
    }
    for (const line of report) expect(Number(line.split(": ")[1]), report.join("; ")).toBeLessThanOrEqual(MCP_TRIP_BUDGET);
  });
});
