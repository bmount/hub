// Mail in the workbench: the inbox as the list, a message with the work filed from it in the inspector.
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createProject } from "../src/db/projects";
import { createChannel } from "../src/db/chat";
import { ulid } from "../src/ids";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { handleApi } from "../src/http/api";
import { registerAllVerbs } from "../src/verbs/index";
import { grantConsent, revokeConsent } from "../src/db/consent";
import { setTestTransport } from "../src/mail/send";
import * as events from "../src/db/events";
import { esc } from "../src/html";
import { apiPost, cookieHeaders, seedAgent, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
beforeAll(() => registerAllVerbs());
afterEach(() => { setTestTransport(null); vi.restoreAllMocks(); });

async function world() {
  const t = await seedTenant("acme");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const insert = (id: string, verdict: string, subject: string) => env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, project_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded)
    VALUES (?, ?, ?, ?, 'pat@example.com', 'acme.site@pimwell.test', ?, ?, 100, ?, 'Prices look wrong for metformin.', '[]', 1)`).bind(id, t.id, p.id, pat.identity.id, subject, Date.now(), verdict).run();
  await insert("M1", "admitted", "Prices look wrong");
  await insert("M2", "quarantined", "Held one");
  const get = (path: string, token: string) => SELF.fetch(`https://${HOST}${path}`, { headers: cookieHeaders(token, HOST) });
  const form = (id: string, token = pat.token, origin = `https://${HOST}`) => handleApi(new Request(`https://${HOST}/api/mail.reply`, {
    method: "POST", headers: { ...cookieHeaders(token, HOST), origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id, body: "Thanks", _back: `/mail/${id}` }),
  }), env);
  return { t, p, pat, ada, get, form, insert };
}

describe("mail and work evidence navigation", () => {
  it("opens canonical mail sources and links, and returns deduplicated filed/linked work through UI and MCP", async () => {
    const w = await world();
    const id = ulid(Date.now());
    await w.insert(id, "admitted", "Original evidence");
    const headers = cookieHeaders(w.pat.token, HOST);
    const create = async (fields: Record<string, unknown>) => {
      const r = await apiPost(HOST, "work.create", { project: "site", kind: "errand", ...fields }, headers);
      expect(r.status).toBe(200);
      return (await r.json() as { result: { item: { id: string; number: number } } }).result.item;
    };
    const filed = await create({ title: "Filed task", source_kind: "mail", source_ref: id, source_quote: "Prices look wrong" });
    const linked = await create({ title: '<img src=x onerror="alert(1)">Linked evidence' });
    const unrelated = await create({ title: "Unrelated task" });
    for (const [item, target] of [[filed, id], [linked, id], [unrelated, "M1"]] as const) {
      expect((await apiPost(HOST, "work.link", { id: item.id, target_kind: "mail", target_ref: target }, headers)).status).toBe(200);
    }
    expect((await apiPost(HOST, "work.link", { id: unrelated.id, target_kind: "event", target_ref: id }, headers)).status).toBe(200);
    const workPage = await (await w.get(`/site/w/${filed.number}`, w.pat.token)).text();
    expect(workPage).toContain(`<a href="/mail/${id}">Recorded mail</a>`);
    expect(workPage).toContain(`<a href="/mail/${id}">${id}</a>`);
    const page = await (await w.get(`/mail/${id}`, w.pat.token)).text();
    expect(page).toContain("<h2>Filed from this</h2>");
    expect(page).toContain("<h2>Linked to this</h2>");
    expect(page).toContain(`href="/site/w/${filed.number}">Filed task</a>`);
    expect(page).toContain(`href="/site/w/${linked.number}">`);
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Linked evidence");
    expect(page).not.toContain('<img src=x');
    const inspector = page.slice(page.indexOf('id="inspector"'));
    expect(inspector).not.toContain("Unrelated task");
    expect(inspector.match(/>Filed task<\/a>/g)).toHaveLength(1);
    expect(page).toContain("not proof that this mail authorized the work");
    const { grant } = await seedGrant(w.t, w.pat);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const result = await callTool(ctx, "mail_read", { id });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ relatedWork: [
      { id: linked.id, ref: `site#${linked.number}`, relationship: "linked" },
      { id: filed.id, ref: `site#${filed.number}`, relationship: "filed" },
    ], relatedWorkCoverage: { limit: 50, shown: 2, truncated: false } });
    expect(JSON.stringify(result.content)).toContain("Related work (2 shown; complete for recorded associations)");
    expect(JSON.stringify(result.content)).not.toContain("Unrelated task");
  });

  it("does not let a navigable work reference grant access to another agent's original mail", async () => {
    const w = await world();
    const agent = await seedAgent(w.t, w.ada.identity, "private-agent");
    const id = ulid(Date.now());
    await w.insert(id, "admitted", "Private original subject");
    await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ?, text = 'Private original body' WHERE id = ?").bind(agent.agent.identity.id, id).run();
    const r = await apiPost(HOST, "work.create", { project: "site", kind: "errand", title: "Recorded association", source_kind: "mail", source_ref: id }, cookieHeaders(w.pat.token, HOST));
    expect(r.status).toBe(200);
    const work = (await r.json() as { result: { item: { number: number } } }).result.item;
    const workPage = await (await w.get(`/site/w/${work.number}`, w.pat.token)).text();
    expect(workPage).toContain(`<a href="/mail/${id}">Recorded mail</a>`);
    expect(workPage).not.toContain("Private original subject");
    expect(workPage).not.toContain("Private original body");
    const denied = await w.get(`/mail/${id}`, w.pat.token);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("Private original");
    expect((await apiPost(HOST, "mail.read", { id }, cookieHeaders(w.pat.token, HOST))).status).toBe(404);
    expect((await SELF.fetch(`https://${HOST}/mail/${id}`)).status).toBe(404);
    const allowed = await w.get(`/mail/${id}`, w.ada.token);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("Private original body");
  });

  it("distinguishes exactly 50 from omitted work and filters inconsistent rows before the cap", async () => {
    const w = await world();
    const id = ulid(Date.now());
    await w.insert(id, "admitted", "Many associations");
    const add = async (n: number) => {
      await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, source_kind, source_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'errand', ?, '', 'open', 'mail', ?, ?, ?, ?)")
        .bind(`work-${String(n).padStart(2, "0")}`, w.t.id, w.p.id, n + 1, `Task ${n}`, id, w.pat.identity.id, n, n).run();
    };
    const read = async () => {
      const r = await apiPost(HOST, "mail.read", { id }, cookieHeaders(w.pat.token, HOST));
      expect(r.status).toBe(200);
      return (await r.json() as { result: { relatedWork: Array<{ id: string }>; relatedWorkCoverage: unknown } }).result;
    };
    expect((await read()).relatedWorkCoverage).toEqual({ limit: 50, shown: 0, truncated: false });
    for (let n = 0; n < 50; n++) await add(n);
    expect((await read()).relatedWorkCoverage).toEqual({ limit: 50, shown: 50, truncated: false });
    const foreign = await seedTenant("bravo");
    const foreignProject = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "foreign-secret", kind: "repo", display_name: "Foreign" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "channel-secret", display_name: "Channel", topic: "", created_by: w.pat.identity.id }, Date.now());
    for (let n = 0; n < 55; n++) {
      const tenant = n % 3 === 0 ? foreign.id : w.t.id;
      const project = n % 3 === 0 ? w.p.id : n % 3 === 1 ? foreignProject.id : channel.project_id;
      await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, source_kind, source_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'errand', 'Boundary secret', '', 'open', 'mail', ?, ?, 1000, 1000)")
        .bind(`bad-${n}`, tenant, project, n + 100, id, w.pat.identity.id).run();
    }
    expect((await read()).relatedWorkCoverage).toEqual({ limit: 50, shown: 50, truncated: false });
    await add(50);
    const capped = await read();
    expect(capped.relatedWorkCoverage).toEqual({ limit: 50, shown: 50, truncated: true });
    expect(capped.relatedWork.map(r => r.id)).toEqual(Array.from({ length: 50 }, (_, n) => `work-${String(50 - n).padStart(2, "0")}`));
    const page = await (await w.get(`/mail/${id}`, w.pat.token)).text();
    expect(page).toContain("capped at 50, more omitted");
    expect(page).not.toContain("Boundary secret");
    expect(page).not.toContain("foreign-secret");
    expect(page).not.toContain("channel-secret");
  });
});

describe("mail in the workbench", () => {
  it("lists admitted mail for members and held mail for admins too, with the addresses beside it", async () => {
    const w = await world();
    const member = await (await w.get("/mail", w.pat.token)).text();
    expect(member).toContain('data-href="/mail/M1"');
    expect(member).not.toContain("/mail/M2");
    expect(member).toContain("<code>acme.site@pimwell.test</code>");
    expect(await (await w.get("/mail", w.ada.token)).text()).toContain('<span class="pill">held</span>');
    expect((await w.get("/mail/M2", w.pat.token)).status).toBe(404);
  });

  it("shows a message beside the list, with Propose work and the work already filed from it", async () => {
    const w = await world();
    await apiPost(HOST, "work.create", { project: "site", kind: "snag", title: "Metformin price wrong", source_kind: "mail", source_ref: "M1", source_quote: "Prices look wrong" }, cookieHeaders(w.pat.token, HOST));
    const page = await (await w.get("/mail/M1", w.pat.token)).text();
    expect(page).toContain("<h1>Prices look wrong</h1>");
    expect(page).toContain('action="/api/mail.propose_work"');
    expect(page).toContain("<h2>Filed from this</h2>");
    expect(page).toContain('href="/site/w/1">Metformin price wrong</a>');
    expect(page).toMatch(/data-key="mail:M1:admitted:1:0:false"/);
  });

  it("records a policy block and shows recipients, reason and role-appropriate configuration links", async () => {
    const w = await world();
    let calls = 0;
    setTestTransport(async () => { calls++; });
    const res = await w.form("M1");
    expect(res.status).toBe(403);
    const notice = await res.text();
    expect(notice).toContain("Mail blocked — not sent");
    expect(notice).toContain("Sending is off in this organization.");
    expect(notice).toContain("Affected recipients: <code>pat@example.com</code>");
    expect(notice).toContain('href="/mail/M1#reply"');
    expect(notice).not.toContain('href="/mail#sending"');
    expect(await env.HUB_DB.prepare("SELECT status, error FROM outbound_mail").first()).toEqual({ status: "refused", error: "sending_off" });
    const page = await (await w.get("/mail", w.ada.token)).text();
    expect(page).toContain("Recent outgoing problems");
    expect(page).toContain('href="/mail#sending"');
    expect(page).toContain('id="sending"');
    expect(await (await w.get("/mail/M1", w.pat.token)).text()).toContain("Mail blocked — not sent");
    expect(calls).toBe(0);
  });

  it("shows consent withdrawal as a block, never invites an immediate retry", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE tenant SET mail_out = 1 WHERE id = ?").bind(w.t.id).run();
    await revokeConsent(env.HUB_DB, "pat@example.com", Date.now());
    let calls = 0;
    setTestTransport(async () => { calls++; });
    const res = await w.form("M1");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Do not retry unless the recipient independently renews consent.");
    expect(await env.HUB_DB.prepare("SELECT status, error FROM outbound_mail").first()).toEqual({ status: "refused", error: "no_consent" });
    expect(calls).toBe(0);
  });

  it.each(["before", "transport"] as const)("distinguishes %s failure and never replays delivery on page refresh", async failure => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE tenant SET mail_out = 1 WHERE id = ?").bind(w.t.id).run();
    await grantConsent(env.HUB_DB, { email: "pat@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
    if (failure === "before") await env.HUB_DB.prepare("UPDATE inbound_mail SET subject = ? WHERE id = 'M1'").bind("bad\r\nheader").run();
    let calls = 0;
    setTestTransport(async () => { calls++; throw new Error("secret-token=never-render-this"); });
    const res = await w.form("M1");
    expect(res.status).toBe(502);
    const notice = await res.text();
    expect(notice).toContain(failure === "before" ? "Delivery failed — not sent" : "Delivery uncertain");
    expect(notice).toContain(failure === "before" ? "No mail was sent." : "a retry could duplicate delivery");
    expect(notice).not.toContain("secret-token");
    const record = await env.HUB_DB.prepare("SELECT status, error FROM outbound_mail").first();
    expect(record).toEqual({ status: "failed", error: failure === "before" ? "pre_transport_failure" : "unknown" });
    for (const path of ["/mail", "/mail/M1", "/mail/M1"]) {
      const page = await (await w.get(path, w.pat.token)).text();
      expect(page).toContain(failure === "before" ? 'data-delivery="failed"' : 'data-delivery="uncertain"');
      expect(page).not.toContain("secret-token");
    }
    expect(calls).toBe(failure === "before" ? 0 : 1);
  });

  it("treats legacy failed records as uncertain and escapes recipients without rendering diagnostics", async () => {
    const w = await world();
    await env.HUB_DB.prepare(`INSERT INTO outbound_mail (id, tenant_id, from_address, to_address, subject, text, sent_by, in_reply_to, status, error, created_at)
      VALUES ('OLD', ?, 'acme.site@pimwell.test', ?, '<script>subject</script>', 'body', ?, 'M1', 'failed', 'secret-diagnostic', ?)`).bind(w.t.id, '<img src=x onerror=alert(1)>', w.pat.identity.id, Date.now()).run();
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const page = await (await w.get("/mail/M1", reader.token)).text();
    expect(page).toContain('data-delivery="uncertain"');
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page).not.toContain("<script>subject</script>");
    expect(page).not.toContain("secret-diagnostic");
    expect(page).not.toContain("Review before another attempt");
    expect(page).not.toContain('href="/mail#sending"');
    expect(page).not.toContain('action="/api/mail.reply"');
  });

  it.each([
    ["sender_limit", "The sender's daily limit was reached."],
    ["tenant_limit", "The organization's daily limit was reached."],
    ["reply_window", "30-day reply window"],
    ["recipient_policy", "membership/contact policy"],
    ["untrusted-secret-diagnostic", "Sending was blocked by mail policy."],
  ])("renders a safe reason for policy code %s", async (error, reason) => {
    const w = await world();
    await env.HUB_DB.prepare(`INSERT INTO outbound_mail (id, tenant_id, from_address, to_address, subject, text, sent_by, status, error, created_at)
      VALUES ('POLICY', ?, 'acme.site@pimwell.test', 'pat@example.com', 'Attempt', 'body', ?, 'refused', ?, ?)`).bind(w.t.id, w.pat.identity.id, error, Date.now()).run();
    const page = await (await w.get("/mail", w.pat.token)).text();
    expect(page).toContain(esc(reason));
    expect(page).toContain('data-delivery="blocked"');
    expect(page).not.toContain("untrusted-secret-diagnostic");
  });

  it("does not claim nothing changed when recording fails after transport acceptance", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE tenant SET mail_out = 1 WHERE id = ?").bind(w.t.id).run();
    await grantConsent(env.HUB_DB, { email: "pat@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
    let calls = 0;
    setTestTransport(async () => { calls++; });
    vi.spyOn(events, "recordEvent").mockRejectedValue(new Error("recording unavailable"));
    const res = await w.form("M1");
    expect(res.status).toBe(500);
    const notice = await res.text();
    expect(notice).toContain("Mail delivery is uncertain");
    expect(notice).toContain("a retry could duplicate delivery");
    expect(notice).not.toContain("Nothing was changed");
    expect(calls).toBe(1);
  });

  it("refuses inaccessible, held, cross-origin and anonymous attempts before recording recipients", async () => {
    const w = await world();
    for (const res of [await w.form("M2"), await w.form("missing"), await w.form("M1", w.pat.token, "https://evil.example"), await w.form("M1", "invalid")]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain("Affected recipients");
    }
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM outbound_mail").first()).toEqual({ n: 0 });
  });
});
