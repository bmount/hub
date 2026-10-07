// Performance budget (overnight plan 2, N4): every signed-in page stays within a fixed number of D1 round trips.
// A batch is one round trip. If a page needs more, read in one batch, or record a ruling and raise its budget here.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
export const TRIP_BUDGET = 5;

function trips(header: string | null): { trips: number; statements: number } {
  const m = /db;desc="(\d+) round trips, (\d+) statements"/.exec(header ?? "");
  if (!m) throw new Error(`no db timing in ${header}`);
  return { trips: Number(m[1]), statements: Number(m[2]) };
}

describe("performance budget", () => {
  it("every signed-in page stays within the round-trip budget", async () => {
    const t = await seedTenant("acme");
    await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await seedAgent(t, pat.identity, "scout");
    const h = cookieHeaders(pat.token, HOST);
    for (let i = 0; i < 5; i++) await apiPost(HOST, "work.create", { project: "site", kind: "bug", title: `Snag ${i}` }, h);
    const report: string[] = [];
    for (const path of ["/", "/docket", "/site", "/site/docket", "/site/w/1", "/people", "/mail", "/c", "/playground", "/archive", "/skills"]) {
      const res = await SELF.fetch(`https://${HOST}${path}`, { headers: h });
      expect(res.status, path).toBe(200);
      const t2 = trips(res.headers.get("server-timing"));
      report.push(`${path}: ${t2.trips} trips, ${t2.statements} statements`);
      expect(t2.trips, `${path} uses ${t2.trips} D1 round trips`).toBeLessThanOrEqual(TRIP_BUDGET);
    }
    console.log(report.join("\n"));
  });
});
