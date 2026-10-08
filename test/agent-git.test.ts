// Agents and source control: which repositories they can reach, how to connect git without exposing a token, and
// that the git host sees them as no more than their person (and never more than a member).
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { rpcBody } from "./oauth-helpers";

const HOST = "acme.pimwell.test";
let rpcId = 5000;
const agentMcp = (token: string, method: string, params: Record<string, unknown> = {}) => SELF.fetch(`https://${HOST}/agent/mcp`, {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
const introspect = (token: string) => SELF.fetch("https://pimwell.test/internal/introspect", { method: "POST", headers: { "content-type": "application/json", "x-hub-internal": "test-internal-secret" }, body: JSON.stringify({ token, tenant: "acme" }) });

async function connected() {
  const t = await seedTenant("acme");
  const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Website" }, Date.now());
  const made = ((await (await apiPost(HOST, "agent.connect", { display_name: "Builder" }, cookieHeaders(ann.token, HOST))).json()) as { result: { link: string } }).result;
  const claim = (await (await SELF.fetch(made.link, { method: "POST", headers: { accept: "application/json" } })).json()) as { token: string };
  return { t, ann, token: claim.token };
}

describe("agents and git", () => {
  it("lists repositories with clone URLs and push access, and explains git setup without any secret", async () => {
    const { token } = await connected();
    const list = await rpcBody(await agentMcp(token, "tools/call", { name: "repo_list", arguments: {} }));
    const r = list.result.structuredContent as { access: string; repos: Array<{ slug: string; clone_url: string; push: boolean }> };
    expect(r.repos).toEqual([{ slug: "site", name: "Website", clone_url: "https://acme.pimwell.test/site.git", push: true }]);
    const how = await rpcBody(await agentMcp(token, "tools/call", { name: "repo_connect", arguments: {} }));
    const text = (how.result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("https://acme.pimwell.test/git-credential-helper");
    expect(text).toContain("PIMWELL_ACME_TOKEN");
    expect(text).toContain("credential.https://acme.pimwell.test.helper");
    expect(text).not.toMatch(/pm[ws]_[A-Za-z0-9]/);
    const script = await (await SELF.fetch(`https://${HOST}/git-credential-helper`)).text();
    expect(script).toContain("PIMWELL_ACME_TOKEN");
    expect(script).toContain("https://acme.pimwell.test/api/session.start");
    expect((await SELF.fetch("https://pimwell.test/git-credential-helper")).status).toBe(404);
  });

  it("trades the agent's token for an hour-long git session the git host accepts as a member, capped by its person", async () => {
    const { t, ann, token } = await connected();
    // What the helper does.
    const s = await SELF.fetch(`https://${HOST}/api/session.start`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ label: "git", ttl: 3600 }) });
    expect(s.status, await s.clone().text()).toBe(200);
    const run = ((await s.json()) as { result: { session_token: string; expires_at: number } }).result;
    expect(run.expires_at - Date.now()).toBeLessThanOrEqual(3600_000 + 5000);
    // What the git host asks the hub.
    const seen = (await (await introspect(run.session_token)).json()) as { ok: boolean; role: string; identity: { kind: string } };
    expect(seen).toMatchObject({ ok: true, role: "member", identity: { kind: "agent" } });
    // Their person becomes a reader: so does the agent, for git too.
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ? AND tenant_id = ?").bind(ann.identity.id, t.id).run();
    expect(((await (await introspect(run.session_token)).json()) as { role: string }).role).toBe("reader");
    // Their person leaves: the agent's git access ends.
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(ann.identity.id, t.id).run();
    expect(((await (await introspect(run.session_token)).json()) as { ok: boolean }).ok).toBe(false);
  });
});
