import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { HOST, channelWith, chatWorld, ok } from "./chat-helpers";

const get = (path: string, token: string | null) =>
  SELF.fetch(`https://${HOST}${path}`, { headers: token ? cookieHeaders(token, HOST) : {}, redirect: "manual" });
const postForm = (path: string, token: string, fields: Record<string, string>, origin = `https://${HOST}`) =>
  SELF.fetch(`https://${HOST}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...cookieHeaders(token, HOST), origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

describe("chat pages", () => {
  it("send visitors without a session to sign in", async () => {
    await chatWorld();
    const res = await get("/c", null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://pimwell.test/login?next=acme");
  });

  it("list channels and show messages with server name tags and escaped text", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.scout.token, "chat.post", { c: "general", body: "<script>alert(1)</script> done", after: 0 });
    const list = await (await get("/c", w.dev.token)).text();
    expect(list).toContain('<a href="/c/general">#general</a>');
    const res = await get("/c/general", w.dev.token);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; done");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("<strong>@scout</strong> scout <small>agent · op @lead · run run-1</small>");
    expect(html).toContain('<input type="hidden" name="after" value="1">');
    expect((await get("/c/nope", w.dev.token)).status).toBe(404);
  });

  it("post from the compose form, refuse a foreign origin, and keep the draft on a stale view", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const posted = await postForm("/c/general", w.dev.token, { body: "from the page", after: "0" });
    expect([posted.status, posted.headers.get("location")]).toEqual([303, "/c/general"]);
    expect((await postForm("/c/general", w.dev.token, { body: "x", after: "1" }, "https://evil.example")).status).toBe(403);
    await ok(w.lead.token, "chat.post", { c: "general", body: "meanwhile" });
    const stale = await postForm("/c/general", w.dev.token, { body: "my careful draft", after: "1" });
    expect(stale.status).toBe(200);
    const html = await stale.text();
    expect(html).toContain("New activity arrived");
    expect(html).toContain("may be partial");
    expect(html).toContain(">my careful draft</textarea>");
    expect(html).toContain("meanwhile");
  });

  it("show a thread with a reply form, a permalink with versions, and the inbox", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@dev root" });
    const reply = await postForm(`/c/general/t/${root.seq}`, w.dev.token, { body: "a reply", after: String(root.head) });
    expect([reply.status, reply.headers.get("location")]).toEqual([303, `/c/general/t/${root.seq}`]);
    const thread = await (await get(`/c/general/t/${root.seq}`, w.dev.token)).text();
    expect(thread).toContain("a reply");
    await ok(w.lead.token, "chat.edit", { c: "general", msg: root.seq, body: "@dev root, edited" });
    const perm = await (await get(`/m/${root.msg_id}`, w.dev.token)).text();
    expect(perm).toContain("r1");
    expect(perm).toContain("r2");
    expect(perm).toContain("@dev root, edited");
    const inbox = await (await get("/inbox", w.dev.token)).text();
    expect(inbox).toContain(`<a href="/m/${root.msg_id}">#general #1</a>`);
    expect(inbox).toContain('action="/api/inbox.ack"');
  });

  it("carry the security headers, clear a stale cookie, and are closed to bearer sessions", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const res = await get("/c/general", w.dev.token);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const stale = await get("/c", "not-a-live-session-token");
    expect(stale.status).toBe(303);
    expect(stale.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    const bearer = await SELF.fetch(`https://${HOST}/c/general`, { headers: { authorization: `Bearer ${w.scout.token}` }, redirect: "manual" });
    expect(bearer.status).toBe(404);
  });

  it("never renders message text as markup, in bodies, refs, or compose", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.dev.token, "chat.post", { c: "general", body: `"><img src=x onerror=alert(1)> <b>bold</b> & more` });
    const html = await (await get("/c/general", w.dev.token)).text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("keeps unread state on GET and marks only this viewer's channel read on explicit same-origin POST", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "new activity" });
    const channel = await (await get("/c/general", w.dev.token)).text();
    expect(channel).toContain('class="chat-workspace"');
    expect(channel).toContain('aria-label="Channels"');
    expect(channel).toContain('aria-current="page">#general');
    expect(channel).toContain('class="pill">Unread');
    expect(channel).toContain('action="/api/chat.mark_read"');
    expect(channel).toContain('Mark channel read through #1');
    const cursor = async (token: string) => (await ok(token, "chat.conversations")).conversations[0].read_seq;
    expect(await cursor(w.dev.token)).toBe(0);
    const fields = { c: "general", seq: "1", _back: "/c/general" };
    expect((await postForm("/api/chat.mark_read", w.dev.token, fields, "https://evil.example")).status).toBe(403);
    expect(await cursor(w.dev.token)).toBe(0);
    const marked = await postForm("/api/chat.mark_read", w.dev.token, fields);
    expect([marked.status, marked.headers.get("location")]).toEqual([303, "/c/general"]);
    expect(await cursor(w.dev.token)).toBe(1);
    expect(await cursor(w.lead.token)).toBe(0);
    expect(await (await get("/c/general", w.dev.token)).text()).not.toContain('class="pill">Unread');
    await ok(w.lead.token, "chat.post", { c: "general", body: "later activity" });
    expect(await (await get("/c/general", w.dev.token)).text()).toContain('class="pill">Unread');
  });

  it("places one unread divider at the viewer's cursor and never changes it on channel or thread GET", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const first = await ok(w.lead.token, "chat.post", { c: "general", body: "already read" });
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: first.seq });
    await ok(w.lead.token, "chat.post", { c: "general", body: "new root" });
    await ok(w.lead.token, "chat.post", { c: "general", reply_to: first.seq, body: "new reply" });
    const html = await (await get("/c/general", w.dev.token)).text();
    expect(html.match(/id="unread"/g)).toHaveLength(1);
    expect(html).toContain('href="#unread">Jump to new messages on this page');
    expect(html.indexOf("already read")).toBeLessThan(html.indexOf('id="unread"'));
    expect(html.indexOf('id="unread"')).toBeLessThan(html.indexOf("new root"));
    expect(html).toContain('href="/c/general/t/1?after=1">New thread activity');
    expect(html).toContain("open threads to read replies");
    const thread = await (await get("/c/general/t/1?after=1", w.dev.token)).text();
    expect(thread).toContain('aria-labelledby="thread-original"');
    expect(thread).toContain('aria-labelledby="thread-replies"');
    expect(thread).toContain('id="m3"');
    expect(thread).toContain("Replies (continued)");
    expect((await ok(w.dev.token, "chat.conversations")).conversations[0].read_seq).toBe(first.seq);
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: 3 });
    const read = await (await get("/c/general", w.dev.token)).text();
    expect(read).not.toContain('id="unread"');
    expect(read).not.toContain('href="#unread"');
    expect(read).not.toContain("New thread activity");
    // Another viewer has its own unchanged read marker.
    const other = await (await get("/c/general", w.lead.token)).text();
    expect(other.indexOf('id="unread"')).toBeLessThan(other.indexOf("already read"));
  });

  it("discloses partial unread views and does not invent new-message markers for edits", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "old body" });
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: root.seq });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: root.seq, body: "updated body" });
    const edited = await (await get("/c/general", w.dev.token)).text();
    expect(edited).toContain('class="pill">Unread');
    expect(edited).not.toContain('id="unread"');
    for (let i = 0; i < 50; i++) await ok(i % 2 ? w.dev.token : w.lead.token, "chat.post", { c: "general", body: `long message ${i} ${"x".repeat(1000)}` });
    const partial = await (await get("/c/general", w.dev.token)).text();
    expect(partial).toContain("This is a partial channel view");
    expect(partial).toContain("including activity not shown here");
    const older = await (await get("/c/general?before=2", w.dev.token)).text();
    expect(older).toContain("updated body");
    expect(older).not.toContain('id="unread"');
    expect((await ok(w.dev.token, "chat.conversations")).conversations[0].read_seq).toBe(root.seq);
  });

  it("filters discovery by name/topic with inert rendering and excludes archived or other-tenant channels", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "channel.create", { slug: "support", display_name: "Customer care", topic: '<img src=x onerror=alert(1)> questions' });
    await ok(w.lead.token, "channel.create", { slug: "retired", topic: "old-secret-topic" });
    await ok(w.lead.token, "channel.archive", { c: "retired" });
    const other = await seedTenant("other");
    const outsider = await seedHuman("other@example.com", { memberships: [{ tenant_id: other.id, role: "admin" }] });
    // Create through the other host; its name/topic must never enter this tenant's discovery or rail.
    const created = await SELF.fetch("https://other.pimwell.test/api/channel.create", {
      method: "POST", headers: { ...cookieHeaders(outsider.token, "other.pimwell.test"), origin: "https://other.pimwell.test", "content-type": "application/json" },
      body: JSON.stringify({ slug: "private-other", topic: "other-tenant-secret" }),
    });
    expect(created.status).toBe(200);
    const html = await (await get("/c?q=questions", w.dev.token)).text();
    const directory = html.split('<ul class="channel-directory grid">')[1]!.split("</ul>")[0]!;
    expect(directory).toContain("Customer care");
    expect(directory).not.toContain("#general");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("old-secret-topic");
    expect(html).not.toContain("other-tenant-secret");
    expect(html).not.toContain("private-other");
    expect((await get("/c/private-other", w.dev.token)).status).toBe(404);
    expect((await get("/c/general", outsider.token)).status).toBe(404);
    const injected = await (await get('/c?q=%22%3E%3Cscript%3Ebad%3C%2Fscript%3E', w.dev.token)).text();
    expect(injected).toContain('value="&quot;&gt;&lt;script&gt;bad&lt;/script&gt;"');
    expect(injected).not.toContain("<script>bad");
  });

  it("pages a large thread forward while preserving the root and channel rail", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", []);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "thread root" });
    // Two human authors stay within the unchanged 30-posts/minute per-identity limit.
    for (let i = 0; i < 50; i++) await ok(i % 2 ? w.dev.token : w.lead.token, "chat.post", { c: "general", reply_to: root.seq, body: `reply-${i} ${"x".repeat(1000)}` });
    const first = await (await get(`/c/general/t/${root.seq}`, w.dev.token)).text();
    const link = first.match(/href="(\/c\/general\/t\/1\?after=\d+)">More replies/);
    expect(link).not.toBeNull();
    expect(first).toContain("reply-0 ");
    expect(first).not.toContain("reply-49 ");
    const next = await (await get(link![1]!, w.dev.token)).text();
    expect(next).toContain("thread root");
    expect(next).toContain("reply-49 ");
    expect(next).not.toContain("reply-0 ");
    expect(next).toContain('aria-current="page">#general');
  });

  it("gives readers navigation and unread controls but no posting or membership-management forms", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.acme.id, role: "reader" }] });
    const list = await (await get("/c", reader.token)).text();
    expect(list).not.toContain('action="/api/channel.create"');
    expect(list).not.toContain('action="/api/channel.add_agent"');
    const channel = await (await get("/c/general", reader.token)).text();
    expect(channel).toContain("read-only access");
    expect(channel).not.toContain('name="body"');
    expect((await postForm("/c/general", reader.token, { body: "not allowed", after: "0" })).status).toBe(403);
  });

  it("offers organization chat on the signed-in hub without listing other tenants", async () => {
    const w = await chatWorld();
    await seedTenant("other");
    const res = await SELF.fetch("https://pimwell.test/", { headers: cookieHeaders(w.dev.token, "pimwell.test") });
    const html = await res.text();
    expect(html).toContain('aria-label="Organization chat"');
    expect(html).toContain('href="https://acme.pimwell.test/c"');
    expect(html).not.toContain('href="https://other.pimwell.test/c"');
  });

  it("answer a bad form body with 400", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const res = await SELF.fetch(`https://${HOST}/c/general`, {
      method: "POST", redirect: "manual",
      headers: { ...cookieHeaders(w.dev.token, HOST), origin: `https://${HOST}`, "content-type": "multipart/form-data; boundary=zzz" },
      body: "garbage",
    });
    expect(res.status).toBe(400);
  });
});
