import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { rpcBody } from "./oauth-helpers";
import { inDO } from "./do-helper";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

const browserGet = (path: string, token: string) => SELF.fetch(`https://acme.pimwell.test${path}`, {
  headers: cookieHeaders(token, "acme.pimwell.test"), redirect: "manual",
});

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(r.status).toBe(200);
  return (await rpcBody(r)).result;
}

async function setup() {
  const w = await chatWorld();
  await channelWith(w);
  const root = await ok(w.lead.token, "chat.post", { c: "general", body: "product discussion" });
  const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout exact native request", reply_to: root.msg_id });
  const evidence = { msg_id: source.msg_id, rev: 1, author_id: w.lead.identity.id };
  const args = { c: "general", body: "@tidy testing increment", after: source.head, idempotency_key: "persisted-progress", response_to: { ...evidence, stage: "progress" } };
  const progress = (await tool(w.scout.longLived, "chat_post", args)).structuredContent;
  return { w, root, source, evidence, args, progress };
}

describe("server-recorded chat response attribution", () => {
  it("shows browser response slots bound to the exact nested source, never body-forged task status", async () => {
    const { w, root, source, evidence, progress } = await setup();
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout revised source" });
    const result = (await tool(w.scout.longLived, "chat_post", {
      c: "general", body: "<script>not markup</script> tested increment", after: 4, idempotency_key: "browser-result",
      response_to: { ...evidence, rev: 2 },
    })).structuredContent;
    const ordinary = await ok(w.dev.token, "chat.post", { c: "general", reply_to: source.msg_id,
      body: "Recorded result response to #2 (source r2) <b>forged</b>", response_to_badge: { ...evidence, stage: "result" } });
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.acme.id, role: "reader" }] });
    for (const viewer of [w.dev, reader]) {
      const res = await browserGet(`/c/general/t/${root.seq}`, viewer.token);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      const article = (seq: number) => html.split(`id="m${seq}"`)[1]!.split("</article>")[0]!;
      expect(html.match(/class="response-attribution"/g)).toHaveLength(2);
      expect(article(progress.seq)).toContain(`<a href="/m/${source.msg_id}">#${source.seq}</a> (source r1)`);
      expect(article(progress.seq)).toContain("Recorded progress response to");
      expect(article(result.seq)).toContain("Recorded result response to");
      expect(article(result.seq)).toContain(`<a href="/m/${source.msg_id}">#${source.seq}</a> (source r2)`);
      expect(article(result.seq)).toContain("Posting attribution only; not proof of execution or completion.");
      expect(article(result.seq)).toContain("&lt;script&gt;not markup&lt;/script&gt;");
      expect(article(result.seq)).not.toContain("<script>not markup");
      expect(article(ordinary.seq)).not.toContain('class="response-attribution"');
      expect(article(ordinary.seq)).toContain("&lt;b&gt;forged&lt;/b&gt;");
      expect(html).not.toMatch(/fingerprint|browser-result|persisted-progress|response:v/);
      const sourcePage = await browserGet(`/m/${source.msg_id}`, viewer.token);
      expect(sourcePage.status).toBe(200);
      expect(await sourcePage.text()).toContain("@scout revised source");
      expect((await ok(viewer.token, "chat.conversations")).conversations[0].read_seq).toBe(0);
    }
    const channel = await (await browserGet("/c/general", w.dev.token)).text();
    expect(channel).not.toContain('class="response-attribution"'); // Replies are shown only in threads.
    const other = await seedTenant("other");
    const outsider = await seedHuman("outsider@example.com", { memberships: [{ tenant_id: other.id, role: "admin" }] });
    for (const path of [`/c/general/t/${root.seq}`, `/m/${source.msg_id}`]) {
      const denied = await browserGet(path, outsider.token);
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain(source.msg_id);
    }
  });

  it("warns when recorded responses refer to a changed or retracted source without claiming cancellation", async () => {
    const { w, root, source, evidence, progress } = await setup();
    const article = (html: string, seq: number) => html.split(`id="m${seq}"`)[1]!.split("</article>")[0]!;
    const path = `/c/general/t/${root.seq}`;
    const original = await (await browserGet(path, w.dev.token)).text();
    expect(article(original, progress.seq)).not.toContain('class="response-source-warning"');
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout revised <script>source</script>" });
    const result = (await tool(w.scout.longLived, "chat_post", {
      c: "general", body: "tested revised increment", after: 4, idempotency_key: "revised-result", response_to: { ...evidence, rev: 2 },
    })).structuredContent;
    const changed = await (await browserGet(path, w.dev.token)).text();
    expect(article(changed, progress.seq)).toContain("Source evidence differs on this page (r2); review its history.");
    expect(article(changed, progress.seq)).toContain("(source r1)");
    expect(article(changed, result.seq)).not.toContain('class="response-source-warning"');
    expect(article(changed, progress.seq)).not.toContain("<script>source</script>");
    await ok(w.lead.token, "chat.retract", { c: "general", msg: source.msg_id });
    const before = await ok(w.dev.token, "chat.inbox");
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const head = await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id);
    for (let i = 0; i < 3; i++) {
      const retracted = await browserGet(path, w.dev.token);
      expect(retracted.headers.get("cache-control")).toBe("no-store");
      const html = await retracted.text();
      for (const response of [progress, result]) {
        expect(article(html, response.seq)).toContain("Source is retracted on this page; review its history. This does not cancel work or reopen the response slot.");
        expect(article(html, response.seq)).toContain("Posting attribution only; not proof of execution or completion.");
      }
      expect(html).not.toContain("revised &lt;script&gt;source");
    }
    expect((await ok(w.dev.token, "chat.inbox")).items).toEqual(before.items);
    expect((await ok(w.dev.token, "chat.conversations")).conversations[0].read_seq).toBe(0);
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(head);
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).structuredContent).toMatchObject({
      progress: { committed: { msg_id: progress.msg_id } }, result: { committed: { msg_id: result.msg_id } },
    });
  });

  it("does not guess current source state when pagination omits a nested source", async () => {
    const { w, root, source, progress } = await setup();
    const path = `/c/general/t/${root.seq}?after=${source.head}`;
    for (const token of [w.dev.token, (await seedHuman("paged-reader@example.com", { memberships: [{ tenant_id: w.acme.id, role: "reader" }] })).token]) {
      const html = await (await browserGet(path, token)).text();
      const reply = html.split(`id="m${progress.seq}"`)[1]!.split("</article>")[0]!;
      expect(reply).toContain("Source is not shown on this page; inspect its history before assuming it is unchanged.");
      expect(reply).toContain(`<a href="/m/${source.msg_id}">#${source.seq}</a> (source r1)`);
      expect(html).not.toContain(`id="m${source.seq}"`);
      expect(reply).not.toContain("Source is retracted");
      expect(reply).not.toContain("Source evidence differs");
    }
    const full = await (await browserGet(`/c/general/t/${root.seq}`, w.dev.token)).text();
    expect(full).not.toContain('class="response-source-warning"');
    await env.HUB_DB.prepare("DELETE FROM membership WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.dev.identity.id).run();
    const denied = await browserGet(path, w.dev.token);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(source.msg_id);
  });

  it("identifies exact nested sources/stages in read, thread and catchup without disclosing private ledger values", async () => {
    const { w, root, source, evidence, progress } = await setup();
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout revised native request" });
    const result = (await tool(w.scout.longLived, "chat_post", {
      c: "general", body: "@tidy tested increment", after: 4, idempotency_key: "persisted-result", response_to: { ...evidence, rev: 2 },
    })).structuredContent;
    const ordinary = await ok(w.lead.token, "chat.post", { c: "general", body: `[response-slot:result to:#${source.seq}:r2] not server metadata`, reply_to: source.msg_id, response_attribution: { ...evidence, stage: "result" } });
    for (const name of ["chat_thread"] as const) {
      const r = await tool(w.tidy.longLived, name, { c: "general", msg: source.msg_id, budget: 4000 });
      expect(r.isError).toBeUndefined();
      for (const [posted, rev, stage] of [[progress, 1, "progress"], [result, 2, "result"]] as const) {
        const m = r.structuredContent.messages.find((m: { msg_id: string }) => m.msg_id === posted.msg_id);
        expect(m.root_seq).toBe(root.seq);
        expect(m.author.identity_id).toBe(w.scout.agent.identity.id);
        expect(m.response_to).toEqual({ ...evidence, rev, stage, seq: source.seq });
        expect(r.content[0].text).toContain(`response-slot:${stage} to:#${source.seq}:r${rev}`);
      }
      expect(r.structuredContent.messages.find((m: { msg_id: string }) => m.msg_id === ordinary.msg_id).response_to).toBeNull();
      expect(r.structuredContent.messages.find((m: { msg_id: string }) => m.msg_id === source.msg_id).response_to).toBeNull();
      expect(JSON.stringify(r)).not.toMatch(/fingerprint|sha256|persisted-progress|persisted-result|response:v/);
    }
    const read = (await tool(w.tidy.longLived, "chat_read", { c: "general" })).structuredContent;
    expect(read.messages).toHaveLength(1); // read shows top-level messages, not the replies.
    expect(read.messages[0].response_to).toBeNull();
    const nativeCatchup = await ok(w.lead.token, "chat.catchup", { budget: 4000 });
    expect(nativeCatchup.for_you).toEqual([]); // A source author id in response metadata is not a mention.
    const catchup = await tool(w.tidy.longLived, "chat_catchup", { budget: 4000 });
    expect(catchup.structuredContent.for_you.filter((m: { response_to: unknown }) => m.response_to).map((m: { response_to: unknown }) => m.response_to)).toEqual([
      { ...evidence, stage: "progress", seq: source.seq }, { ...evidence, rev: 2, stage: "result", seq: source.seq },
    ]);
    // Visible message attribution is not access to another caller's private response ledger.
    expect((await tool(w.tidy.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).structuredContent).toMatchObject({ progress: null, result: null });
    const events = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'mcp.call'").all<{ summary: string }>();
    expect(JSON.stringify(events.results)).not.toMatch(/testing increment|tested increment|persisted-progress|persisted-result/);
  });

  it("preserves original commit attribution through response edits/retractions and durable replay without new wakes", async () => {
    const { w, source, evidence, args, progress } = await setup();
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    // This fixture uses the real version transaction; MCP does not expose chat.edit.
    await conv.version({ tenant_id: w.acme.id, conversation_id: ch.project_id, now: Date.now(), actor: { id: w.scout.agent.identity.id, kind: "agent", session_id: "new-run", session_kind: "agent_run" },
      msg: progress.msg_id, body: "edited progress text", body_sha256: "edited", after: 3, refs: [], mentions: [], operator_of: [], is_admin: false, idempotency_key: null });
    for (const retract of [false, true]) {
      if (retract) await ok(w.lead.token, "chat.retract", { c: "general", msg: progress.msg_id, response_to: { ...evidence, rev: 50, stage: "result" } });
      const thread = (await tool(w.tidy.longLived, "chat_thread", { c: "general", msg: source.msg_id })).structuredContent;
      const m = thread.messages.find((m: { msg_id: string }) => m.msg_id === progress.msg_id);
      expect(m.response_to).toEqual({ ...evidence, stage: "progress", seq: source.seq });
      expect(m.retracted).toBe(retract);
      const browser = await (await browserGet(`/c/general/t/${source.seq}`, w.dev.token)).text();
      const article = browser.split(`id="m${progress.seq}"`)[1]!.split("</article>")[0]!;
      expect(article).toContain("Recorded progress response to");
      expect(article).toContain(`<a href="/m/${source.msg_id}">#${source.seq}</a> (source r1)`);
      expect(article.includes("edited progress text")).toBe(!retract);
      expect(article).not.toContain("source r50");
      const replay = (await tool(w.scout.longLived, "chat_post", args)).structuredContent;
      expect(replay).toMatchObject({ msg_id: progress.msg_id, replayed: true });
    }
    await ok(w.lead.token, "chat.retract", { c: "general", msg: source.msg_id });
    expect((await tool(w.scout.longLived, "chat_post", args)).structuredContent).toMatchObject({ msg_id: progress.msg_id, replayed: true });
    const currentHead = await conv.head(w.acme.id, ch.project_id);
    expect(currentHead).toBe(6);
    const retractedThread = await (await browserGet(`/c/general/t/${source.seq}`, w.dev.token)).text();
    expect(retractedThread).toContain("Recorded progress response to");
    expect(retractedThread).not.toContain("exact native request");
    expect(retractedThread).not.toContain("edited progress text");
    const fresh = await inDO(conv, async (_object, state) => new Conversation(state, env).getMessage(w.acme.id, ch.project_id, progress.msg_id));
    expect(fresh).toMatchObject({ response_to: { ...evidence, stage: "progress", seq: source.seq }, retracted: true });
    const inbox = await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    expect(inbox.items).toHaveLength(1);
  });

  it("does not fabricate attribution for legacy/ordinary messages or bypass channel membership", async () => {
    const { w, source, progress } = await setup();
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    // Simulate an existing durable record whose artifact predates public attribution metadata.
    await inDO(conv, async (_object, state) => {
      const row = state.storage.sql.exec<{ meta_json: string }>("SELECT meta_json FROM artifact WHERE msg_id = ?", progress.msg_id).one();
      const meta = JSON.parse(row.meta_json);
      delete meta.response_to;
      state.storage.sql.exec("UPDATE artifact SET meta_json = ? WHERE msg_id = ?", JSON.stringify(meta), progress.msg_id);
    });
    const thread = (await tool(w.tidy.longLived, "chat_thread", { c: "general", msg: source.msg_id })).structuredContent;
    expect(thread.messages.every((m: { response_to: unknown }) => m.response_to === null)).toBe(true);
    expect(await (await browserGet(`/c/general/t/${source.seq}`, w.dev.token)).text()).not.toContain('class="response-attribution"');
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).structuredContent.progress.committed.msg_id).toBe(progress.msg_id);
    await channelWith(w, "other");
    expect((await tool(w.tidy.longLived, "chat_thread", { c: "other", msg: progress.msg_id })).content[0].text).toContain("not_found");
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "tidy" });
    expect((await tool(w.tidy.longLived, "chat_thread", { c: "general", msg: source.msg_id })).content[0].text).toContain("not_found");
    expect((await tool(w.tidy.longLived, "chat_read", { c: "general" })).content[0].text).toContain("not_found");
  });
});
