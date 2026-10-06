import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";
import {
  APEX, INIT, LOOPBACK, authorize, decide, formTokenOf, mcpPost, pendingIdOf, pkce, refresh, registerClient, resourceFor, rpcBody,
  tokenRequest, viewConsent, type Tokens,
} from "./oauth-helpers";

// One assistant connection end to end, in the order Claude Code performs it (MCP spec 7, 12).
describe("the full dance", () => {
  it("discovers, registers, authorizes with PKCE, consents, exchanges, calls tools, refreshes, and is revoked", async () => {
    const acme = await seedTenant("acme");
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(ann.token));

    // 1. Anonymous call: 401 pointing at the resource metadata, which points at the apex.
    const first = await mcpPost("acme", null, "initialize", INIT);
    expect(first.status).toBe(401);
    const prmUrl = /resource_metadata="([^"]+)"/.exec(first.headers.get("www-authenticate")!)![1]!;
    const prm = (await (await SELF.fetch(prmUrl)).json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    expect(prm.resource).toBe(resourceFor("acme"));
    const as = (await (await SELF.fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);

    // 2. Register, then authorize with a fresh S256 pair.
    const client_id = await registerClient(LOOPBACK);
    const { verifier, challenge } = await pkce();
    const id = pendingIdOf(await authorize({ client_id, challenge, resource: prm.resource, scope: prm.scopes_supported.join(" ") }));

    // 3. Not signed in: login first, then the consent page, then approve.
    expect((await viewConsent(id, null)).headers.get("location")).toContain("/login?next=");
    const page = await viewConsent(id, ann.token);
    expect(page.status).toBe(200);
    const approved = await decide(id, ann.token, formTokenOf(await page.text()), "approve");
    const callback = new URL(approved.headers.get("location")!);
    expect(`${callback.origin}${callback.pathname}`).toBe(LOOPBACK);
    expect(callback.searchParams.get("iss")).toBe(APEX);

    // 4. Code for tokens, with the verifier and the resource.
    const exchanged = await tokenRequest({
      grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: LOOPBACK, client_id, code_verifier: verifier, resource: prm.resource,
    });
    expect(exchanged.status).toBe(200);
    const t1 = (await exchanged.json()) as Tokens;

    // 5. MCP: initialize, list, call.
    expect((await rpcBody(await mcpPost("acme", t1.access_token, "initialize", INIT))).result.serverInfo.name).toBe("pimwell");
    expect((await rpcBody(await mcpPost("acme", t1.access_token, "tools/list"))).result.tools.map((t: { name: string }) => t.name)).toEqual(["chat_inbox", "chat_read", "chat_thread", "event_list", "project_list", "ref_backlinks", "whoami"]);
    const listed = await rpcBody(await mcpPost("acme", t1.access_token, "tools/call", { name: "project_list", arguments: {} }));
    expect(listed.result.structuredContent.projects.map((p: { path: string }) => p.path)).toEqual(["site"]);

    // 6. Refresh rotates; the new access token works.
    const r = await refresh(client_id, t1.refresh_token, prm.resource);
    expect(r.status).toBe(200);
    const t2 = (await r.json()) as Tokens;
    expect((await mcpPost("acme", t2.access_token, "tools/list")).status).toBe(200);

    // 7. The human revokes on /me; the next call and the next refresh fail, and the assistant must start over.
    const grant = (await env.HUB_DB.prepare("SELECT session_id FROM oauth_grant").first<{ session_id: string }>())!;
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: grant.session_id }, bearer(ann.token))).status).toBe(200);
    const after = await mcpPost("acme", t2.access_token, "tools/list");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(((await (await refresh(client_id, t2.refresh_token)).json()) as any).error).toBe("invalid_grant");

    // The audit trail answers "what did my assistant do".
    const trail = await env.HUB_DB.prepare("SELECT kind FROM event WHERE session_id = ? ORDER BY id").bind(grant.session_id).all<{ kind: string }>();
    expect(trail.results.map((e) => e.kind)).toEqual(["mcp.call"]);
  });
});
