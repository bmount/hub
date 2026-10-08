// Planned capabilities (src/verbs/planned.ts): listed everywhere, callable over MCP and the API, and every call
// answers not_implemented with the spec of what it will do. Building one removes it from this list.
import { beforeAll, describe, expect, it } from "vitest";
import { PLANNED } from "../src/verbs/planned";
import { listVerbs } from "../src/verbs/table";
import { mcpViolations } from "../src/mcp/policy";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { registerAllVerbs } from "../src/verbs/index";

beforeAll(() => registerAllVerbs());

describe("planned capabilities", () => {
  it("are exactly these, each a tenant verb inside the MCP rules", () => {
    expect([...PLANNED.keys()].sort()).toEqual([
            "repo.search",
      "review.comment", "review.integrate", "review.list", "review.read", "review.request", "review.verdict",
      
      "work.board", "work.bulk_update",
    ]);
    for (const v of listVerbs().filter((x) => PLANNED.has(x.name))) {
      expect(mcpViolations(v), v.name).toEqual([]);
      expect(v.scope, v.name).toBe("tenant");
      expect(v.summary.startsWith("Planned, not built yet."), v.name).toBe(true);
    }
  });

  it("answer 501 not_implemented with the spec, naming its area", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const res = await apiPost("acme.pimwell.test", "review.request", { project: "site", branch: "topic" }, cookieHeaders(pat.token, "acme.pimwell.test"));
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; detail: string; data: { planned: boolean; area: string } };
    expect(body).toMatchObject({ error: "not_implemented", data: { planned: true, area: "review" } });
    expect(body.detail).toContain("review.request is planned:");
  });
});
