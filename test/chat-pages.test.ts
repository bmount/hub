import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cookieHeaders } from "./helpers";
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
    expect(html).toContain("New messages arrived");
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
