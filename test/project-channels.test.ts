// Every new project gets #<project>-team and #<project>-ops; a name already taken is skipped, never an error.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createChannel } from "../src/db/chat";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

describe("default project channels", () => {
  it("creates the team and ops channels with the project, skipping a taken name", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await createChannel(env.HUB_DB, { tenant_id: t.id, slug: "site-ops", display_name: "taken", topic: "", created_by: pat.identity.id }, Date.now());
    const res = await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, cookieHeaders(pat.token, HOST));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { result: { channels: string[] } }).result.channels).toEqual(["site-team"]);
    const rows = await env.HUB_DB.prepare("SELECT p.slug, c.topic FROM channel c JOIN project p ON p.id = c.project_id WHERE p.tenant_id = ? ORDER BY p.slug").bind(t.id).all<{ slug: string; topic: string }>();
    expect(rows.results.map((r) => r.slug)).toEqual(["site-ops", "site-team"]);
    expect(rows.results[1]!.topic).toContain("Talk about Site");
    const docket = await (await SELF.fetch(`https://${HOST}/docket`, { headers: cookieHeaders(pat.token, HOST) })).text();
    expect(docket).not.toContain('href="/site-team/docket"');
  });
});
