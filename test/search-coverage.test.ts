import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { oauthContext } from "../src/auth/context";
import { agentMcpAuth } from "../src/mcp/agentAuth";
import { createChannel, setChannelState } from "../src/db/chat";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { type SearchResult } from "../src/verbs/search";
import { apiPost, bearer, cookieHeaders, seedGrant, seedTenant } from "./helpers";
import { channelWith, chatWorld, HOST, ok } from "./chat-helpers";

async function result(token: string, q = "needle"): Promise<SearchResult> {
  const response = await apiPost(HOST, "search.query", { q }, bearer(token));
  expect(response.status).toBe(200);
  return (await response.json() as { result: SearchResult }).result;
}

describe("search coverage", () => {
  it("keeps hit arrays, declares unsearched sources and unknown totals/freshness even with zero hits", async () => {
    const w = await chatWorld();
    const r = await result(w.dev.token);
    for (const key of ["work", "mail", "messages", "people", "projects", "errors", "reviews", "situations", "assistant", "outgoing"] as const) {
      expect(r[key]).toEqual([]);
      expect(r.coverage.sources[key]).toEqual({ returned: 0, limit: key === "work" ? 20 : ["mail", "messages", "reviews", "situations", "assistant", "outgoing"].includes(key) ? 15 : 10, total_matches: null, may_have_more: false });
    }
    expect(r.coverage.scope).toBe("caller_readable_records");
    expect(r.coverage.freshness).toBe("unknown");
    expect(r.coverage.not_searched).toEqual(["repository file contents", "binary or unextracted mail attachments", "raw telemetry logs"]);
    expect(r.coverage.conversations).toEqual({ readable_active_channels: 0, readable_archived_channels: 0, searched_channels: 0, channel_limit: 40, per_channel_limit: 10, channels_at_hit_limit: 0 });
  });

  it("discloses effective terms without changing the existing six-term/short-term matching contract", async () => {
    const w = await chatWorld();
    const r = await result(w.dev.token, "A One TWO Three four five six seven");
    expect(r.coverage.matching).toBe("all_terms_substring");
    expect(r.coverage.terms_used).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect((await apiPost(HOST, "search.query", { q: "a" }, bearer(w.dev.token))).status).toBe(400);
  });

  it("flags caps conservatively without inventing total matches", async () => {
    const w = await chatWorld();
    await ok(w.lead.token, "project.create", { slug: "site", kind: "repo", display_name: "Site" });
    // Direct bounded fixtures avoid notification side effects; work reads retain their normal predicate.
    for (let n = 0; n < 21; n++) {
      await env.HUB_DB.prepare(`INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at)
        SELECT ?, ?, id, ?, 'wish', 'needle', '', 'open', ?, ?, ? FROM project WHERE tenant_id = ? AND slug = 'site'`)
        .bind(`W${n}`, w.acme.id, n + 1, w.lead.identity.id, n, n, w.acme.id).run();
    }
    const r = await result(w.dev.token);
    expect(r.work).toHaveLength(20);
    expect(r.coverage.sources.work).toEqual({ returned: 20, limit: 20, total_matches: null, may_have_more: true });
    // Exactly the cap is also 'may', not a claimed extra result.
    await env.HUB_DB.prepare("DELETE FROM work_item WHERE id = 'W20'").run();
    expect((await result(w.dev.token)).coverage.sources.work.may_have_more).toBe(true);
    await env.HUB_DB.prepare("DELETE FROM work_item WHERE id = 'W19'").run();
    expect((await result(w.dev.token)).coverage.sources.work.may_have_more).toBe(false);
  });

  it("counts only caller-readable active channels and reports omissions without exposing hidden channels or other tenants", async () => {
    const w = await chatWorld();
    await channelWith(w, "a-visible", ["scout"]);
    await ok(w.lead.token, "chat.post", { c: "a-visible", body: "needle visible" });
    for (let n = 0; n < 40; n++) {
      await createChannel(env.HUB_DB, { tenant_id: w.acme.id, slug: `hidden-${String(n).padStart(2, "0")}`, display_name: "private channel name", topic: "", created_by: w.lead.identity.id }, Date.now());
    }
    await ok(w.lead.token, "chat.post", { c: "hidden-39", body: "needle omitted secret" });
    const archived = await createChannel(env.HUB_DB, { tenant_id: w.acme.id, slug: "archived-secret", display_name: "Archive", topic: "", created_by: w.lead.identity.id }, Date.now());
    await setChannelState(env.HUB_DB, w.acme.id, archived.project_id, "archived");
    const other = await seedTenant("other");
    await createChannel(env.HUB_DB, { tenant_id: other.id, slug: "foreign-secret", display_name: "Foreign", topic: "", created_by: w.lead.identity.id }, Date.now());
    const human = await result(w.dev.token);
    expect(human.coverage.conversations.readable_active_channels).toBe(41);
    expect(human.coverage.conversations.searched_channels).toBe(40);
    expect(human.messages).toHaveLength(1);
    expect(human.coverage.sources.messages.may_have_more).toBe(true);
    const agent = await result(w.scout.token);
    expect(agent.coverage.conversations.readable_active_channels).toBe(1);
    expect(agent.coverage.conversations.searched_channels).toBe(1);
    expect(agent.coverage.sources.messages.may_have_more).toBe(false);
    expect(agent.messages).toHaveLength(1);
    expect(JSON.stringify(agent)).not.toMatch(/hidden-|private channel name|foreign-secret|archived-secret|omitted secret/);
    const outsider = await result(w.tidy.token);
    expect(outsider.messages).toEqual([]);
    expect(outsider.coverage.conversations.readable_active_channels).toBe(0);
    expect(outsider.coverage.sources.messages.may_have_more).toBe(false);
  }, 30_000);

  it("finds archived conversation text and links directly to the matching message without expanding agent access", async () => {
    const w = await chatWorld();
    await channelWith(w, "archive", ["scout"]);
    const posted = await ok(w.lead.token, "chat.post", { c: "archive", body: "needle in an archived conversation" });
    const row = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'archive'").bind(w.acme.id).first<{id: string}>();
    await setChannelState(env.HUB_DB, w.acme.id, row!.id, "archived");
    const r = await result(w.scout.token);
    expect(r.coverage.conversations.readable_active_channels).toBe(0);
    expect(r.coverage.conversations.readable_archived_channels).toBe(1);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.href).toBe(`/m/${posted.msg_id}`);
    expect((await result(w.tidy.token)).messages).toEqual([]);
  });

  it("reports per-channel truncation even when the global message result cap was not reached", async () => {
    const w = await chatWorld();
    await channelWith(w);
    for (let n = 0; n < 11; n++) await ok(w.lead.token, "chat.post", { c: "general", body: `needle ${n}` });
    const r = await result(w.scout.token);
    expect(r.messages).toHaveLength(10);
    expect(r.coverage.sources.messages).toEqual({ returned: 10, limit: 15, total_matches: null, may_have_more: true });
    expect(r.coverage.conversations.channels_at_hit_limit).toBe(1);
    // Existing dedicated message.search contract remains just hits.
    expect(Object.keys(await ok(w.scout.token, "message.search", { q: "needle" }))).toEqual(["hits"]);
  });

  it("renders coverage for hits and zero hits on browser and headless/OAuth MCP without treating metadata as hit arrays", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await ok(w.lead.token, "chat.post", { c: "general", body: 'needle <script>danger()</script>\u202E' });
    const h = cookieHeaders(w.dev.token, HOST);
    const auth = await agentMcpAuth(new Request(`https://${HOST}/agent/mcp`, { headers: bearer(w.scout.longLived) }), env, "acme", Date.now());
    if (auth.kind !== "ok") throw new Error("agent fixture auth denied");
    const { grant } = await seedGrant(w.acme, w.dev);
    const assistant = await oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    for (const q of ["needle", "missing"]) {
      for (const ctx of [auth.ctx, assistant]) {
        const response = await callTool(ctx, "search_query", { q });
        expect(response.isError, JSON.stringify(response)).toBeUndefined();
        const text = (response.content[0] as { text: string }).text;
        expect(text).toContain("Coverage: caller-readable records");
        expect(text).toContain("Not searched: repository file contents, binary or unextracted mail attachments, raw telemetry logs");
        expect(text).toContain("Total matches and source freshness unknown");
        expect((response.structuredContent as SearchResult).coverage.conversations.searched_channels).toBe(1);
        expect(text).not.toContain("**coverage**");
        expect(text).not.toContain("\u202E");
        if (q === "missing") expect(text).toContain("No matches within this coverage.");
      }
      const html = await (await SELF.fetch(`https://${HOST}/search?q=${q}`, { headers: h })).text();
      expect(html).toContain("data-search-coverage");
      expect(html).toContain("Zero results are not proof of absence");
      expect(html).not.toContain("<script>danger()");
      if (q === "missing") expect(html).toContain("No matches within this coverage");
    }
    const initial = await (await SELF.fetch(`https://${HOST}/search`, { headers: h })).text();
    expect(initial).toContain("Repository files, binary attachments and raw telemetry logs are not included");
    expect(initial).not.toContain("data-search-coverage");
    const invalid = await (await SELF.fetch(`https://${HOST}/search?q=a`, { headers: h })).text();
    expect(invalid).not.toContain("data-search-coverage");
    expect(invalid).toContain("search for at least one word");
    expect((await SELF.fetch(`https://${HOST}/search?q=needle`)).status).toBe(404);
    expect((await apiPost(HOST, "search.query", { q: "needle" })).status).not.toBe(200);
  });
});
