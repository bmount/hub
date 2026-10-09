import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { ulid } from "../src/ids";
import { RESPONSE_RECIPIENT_PREFIX } from "../src/mail/responseRecipients";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const host = "setupmail.pimwell.test", address = "setupmail@pimwell.test", path = "/mail/recipients";
const action = 'action="/api/mail.set_response_recipients"';
async function world() {
  const tenant = await seedTenant("setupmail"), other = await seedTenant("other");
  const human = (email: string, role: "admin" | "member" | "reader") => seedHuman(email, { memberships: [{ tenant_id: tenant.id, role }] });
  const admin = await human("admin@example.com", "admin"), member = await human("member@example.com", "member"), reader = await human("reader@example.com", "reader");
  const stranger = await seedHuman("stranger@example.com", { memberships: [{ tenant_id: other.id, role: "admin" }] });
  const bot = await seedAgent(tenant, admin.identity);
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const channel = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "chat", kind: "tracker", display_name: "Chat" }, Date.now());
  await env.HUB_DB.prepare("UPDATE project SET kind = 'channel' WHERE id = ?").bind(channel.id).run();
  const headers = cookieHeaders(admin.token, host);
  const get = (p = path, h = headers) => SELF.fetch(`https://${host}${p}`, { headers: h });
  const form = (recipients: string[], rev = "0", addr = address) => withRecipients(new URLSearchParams({ address: addr, expected_revision: rev, _recipients_present: "1", _back: `${path}?address=${encodeURIComponent(addr)}` }), recipients);
  const post = (body: URLSearchParams | FormData, h = headers) => SELF.fetch(`https://${host}/api/mail.set_response_recipients`, { method: "POST", headers: h, body, redirect: "manual" });
  const set = (ids: string[], rev = 0, addr = address) => apiPost(host, "mail.set_response_recipients", { address: addr, recipients: ids, expected_revision: rev }, headers);
  const read = async (addr = address) => (await (await apiPost(host, "mail.response_recipients", { address: addr }, headers)).json() as { result: Record<string, any> }).result;
  const key = `${RESPONSE_RECIPIENT_PREFIX}${tenant.id}:org`;
  return { tenant, other, admin, member, reader, stranger, bot, project, channel, headers, get, form, post, set, read, key };
}
function withRecipients(form: URLSearchParams, ids: string[]) { ids.forEach(id => form.append("recipients", id)); return form; }
async function changes() { return (await env.HUB_DB.prepare("SELECT COUNT(*) n FROM event WHERE kind = 'mail.set_response_recipients'").first<{ n: number }>())!.n; }

describe("browser shared-mailbox response preference setup", () => {
  it("is discoverable for human admins and shows current eligible choices, bounded truth and no default", async () => {
    const w = await world();
    expect(await (await w.get("/mail")).text()).toContain('href="/mail/recipients"');
    expect(await (await w.get("/mail", cookieHeaders(w.member.token, host))).text()).not.toContain('href="/mail/recipients"');
    const res = await w.get(), html = await res.text();
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Not set — no recipients configured"); expect(html).toContain('name="expected_revision" value="0"');
    expect(html).toContain("automatic response scheduling is not implemented"); expect(html).toContain("or guarantee a reply");
    expect(html).toContain("One-time guidance is unchanged"); expect(html).toContain("no routine Received receipt");
    expect(html).toContain(`name="recipients" value="${w.admin.identity.id}"`); expect(html).toContain(`name="recipients" value="${w.member.identity.id}"`);
    for (const id of [w.reader.identity.id, w.stranger.identity.id, w.bot.agent.identity.id]) expect(html).not.toContain(`name="recipients" value="${id}"`);
    expect(html).not.toMatch(/name="recipients" value="[^"]+" checked/); expect(html).toContain("setupmail.site%40pimwell.test"); expect(html).not.toContain("setupmail.chat%40pimwell.test");
    expect(await changes()).toBe(0); expect(await w.read()).toMatchObject({ state: "unset" });
  });
  it("posts multiple checkboxes as one atomic revision-checked preference update, then explicitly clears", async () => {
    const w = await world();
    const res = await w.post(withRecipients(w.form([], "0"), [w.member.identity.id, w.admin.identity.id]));
    expect(res.status, await res.clone().text()).toBe(303); expect(res.headers.get("location")).toBe(`${path}?address=setupmail%40pimwell.test`);
    expect(await w.read()).toMatchObject({ revision: 1, state: "configured", recipients: [w.member.identity.id, w.admin.identity.id], response_guaranteed: false });
    const html = await (await w.get()).text();
    expect(html).toContain(`value="${w.member.identity.id}" checked`); expect(html).toContain('name="expected_revision" value="1"');
    expect(html).toContain("not a scheduled response");
    expect((await w.post(w.form([], "1"))).status).toBe(303);
    expect(await w.read()).toMatchObject({ revision: 2, state: "empty", recipients: [] });
    expect(await (await w.get()).text()).toContain("Explicitly empty — no recipients configured");
    expect(await changes()).toBe(2);
    for (const table of ["inbound_mail", "outbound_mail", "attention", "consent"]) expect((await env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n).toBe(0);
    expect((await env.HUB_DB.prepare("SELECT mail_out FROM tenant WHERE id = ?").bind(w.tenant.id).first<{ mail_out: number }>())!.mail_out).toBe(0);
  });
  it("keeps project and organization preferences independent with a safe canonical return path", async () => {
    const w = await world(), addr = "setupmail.site@pimwell.test";
    expect((await w.post(withRecipients(w.form([], "0", addr), [w.member.identity.id]))).status).toBe(303);
    const html = await (await w.get(`${path}?address=${encodeURIComponent(" SETUPMAIL.SITE@PIMWELL.TEST ")}`)).text();
    expect(html).toContain('name="address" value="setupmail.site@pimwell.test"'); expect(html).toContain('value="1"');
    expect(html).toContain(`value="${w.member.identity.id}" checked`); expect(await w.read()).toMatchObject({ state: "unset", revision: 0 });
  });
  it("shows stale state without unavailable ids; saving is an explicit replacement", async () => {
    const w = await world(); await w.set([w.member.identity.id, w.admin.identity.id]);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ? AND tenant_id = ?").bind(w.member.identity.id, w.tenant.id).run();
    const html = await (await w.get()).text();
    expect(html).toContain("Stale preferences"); expect(html).toContain("removes 1 unavailable recipient(s)"); expect(html).not.toContain(w.member.identity.id); expect(html).not.toContain(w.member.identity.email);
    expect((await w.post(withRecipients(w.form([], "1"), [w.admin.identity.id]))).status).toBe(303);
    expect(await w.read()).toMatchObject({ state: "configured", revision: 2, recipients: [w.admin.identity.id] });
  });
  it("shows corrupt state without offering a silent reset or leaking corrupt ids", async () => {
    const w = await world(); await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind(w.key, '{"recipients":["private-foreign-id"]}').run();
    const html = await (await w.get()).text(); expect(html).toContain("Invalid stored preferences"); expect(html).not.toContain(action); expect(html).not.toContain("private-foreign-id");
    expect((await w.post(w.form([]))).status).toBe(409); expect(await changes()).toBe(0);
  });
  it("prompts for recent proof before editing and returns to the same selected mailbox", async () => {
    const w = await world(); await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.admin.session.id).run();
    const html = await (await w.get(`${path}?address=setupmail.site%40pimwell.test&check=sent`)).text();
    expect(html).toContain("One extra check"); expect(html).toContain("A link is on its way"); expect(html).toContain("setupmail/mail/recipients?address=setupmail.site%40pimwell.test"); expect(html).not.toContain(action);
    const res = await w.post(w.form([])); expect(res.status).toBe(303); expect(res.headers.get("location")).toContain("/login?reproof=1"); expect(await changes()).toBe(0);
  });
  it.each(["anonymous", "member", "reader", "foreign", "agent", "bearer-browser", "apex", "unknown"])("denies %s setup-page access", async kind => {
    const w = await world();
    const h = kind === "anonymous" ? {} : kind === "member" ? cookieHeaders(w.member.token, host) : kind === "reader" ? cookieHeaders(w.reader.token, host)
      : kind === "foreign" ? cookieHeaders(w.stranger.token, host) : kind === "agent" ? bearer(w.bot.token) : kind === "bearer-browser" ? bearer(w.admin.token) : w.headers;
    const res = await SELF.fetch(`https://${kind === "apex" ? "pimwell.test" : kind === "unknown" ? "missing.pimwell.test" : host}${path}`, { headers: h });
    expect(res.status).toBe(404); expect(await res.text()).not.toContain(action); expect(await changes()).toBe(0);
  });
  it.each(["other@pimwell.test", "setupmail.bot@pimwell.test", "setupmail.missing@pimwell.test", "setupmail.chat@pimwell.test", "setupmail@evil.test", 'x\"><script>alert(1)</script>', ""])("refuses invalid/private/foreign address %s without echoing it", async addr => {
    const w = await world(); const res = await w.get(`${path}?address=${encodeURIComponent(addr)}`); expect(res.status).toBe(404); expect(await res.text()).not.toContain(action);
  });
  it("excludes archived projects and inactive identities and clears stale cookies on denial", async () => {
    const w = await world(); await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.project.id).run();
    await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(w.member.identity.id).run();
    const html = await (await w.get()).text(); expect(html).not.toContain("setupmail.site%40pimwell.test"); expect(html).not.toContain(`name="recipients" value="${w.member.identity.id}"`);
    expect((await w.get(`${path}?address=setupmail.site%40pimwell.test`)).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE session SET revoked_at = ? WHERE id = ?").bind(Date.now(), w.admin.session.id).run();
    const res = await w.get(); expect(res.status).toBe(404); expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("escapes display labels and handles no eligible choices with explicit clear", async () => {
    const w = await world(); await env.HUB_DB.prepare("UPDATE identity SET display_name = ? WHERE id = ?").bind('<img src=x onerror="alert(1)">', w.member.identity.id).run();
    const html = await (await w.get()).text(); expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"); expect(html).not.toContain('<img src=x');
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE tenant_id = ?").bind(w.tenant.id).run();
    // Root can still inspect without itself being an implicitly eligible recipient.
    await env.HUB_DB.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(w.admin.identity.id).run();
    const empty = await (await w.get()).text(); expect(empty).toContain("No eligible people"); expect(empty).toContain(action); expect(empty).not.toContain('type="checkbox" name="recipients"');
  });
  it("never offers a partial selection if more than 200 people are eligible", async () => {
    const w = await world(), now = Date.now(); const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 199; i++) {
      const id = ulid(now + i);
      stmts.push(env.HUB_DB.prepare("INSERT INTO identity (id, kind, display_name, email, created_at) VALUES (?, 'human', ?, ?, ?)").bind(id, `person${i}`, `person${i}@example.com`, now));
      stmts.push(env.HUB_DB.prepare("INSERT INTO membership (id, identity_id, tenant_id, role, created_at) VALUES (?, ?, ?, 'member', ?)").bind(ulid(now + i), id, w.tenant.id, now));
    }
    await env.HUB_DB.batch(stmts);
    const html = await (await w.get()).text(); expect(html).toContain("supports up to 200 eligible people"); expect(html).not.toContain(action); expect(await changes()).toBe(0);
  });
  it("replaces the pane key on revision, selection and proof changes so obsolete forms are not retained", async () => {
    const w = await world(); const key = (html: string) => html.match(/id="inspector" class="pane" data-key="([^"]*)"/)![1];
    const before = key(await (await w.get()).text()); await w.set([w.member.identity.id]);
    const after = key(await (await w.get()).text()); expect(after).not.toBe(before);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.admin.session.id).run();
    expect(key(await (await w.get()).text())).not.toBe(after);
  });
});

describe("recipient setup form boundaries", () => {
  it.each(["missing", "wrong", "duplicate"])("rejects %s complete-selection marker without clearing", async kind => {
    const w = await world(); await w.set([w.member.identity.id]); const f = w.form([], "1");
    if (kind === "missing") f.delete("_recipients_present"); if (kind === "wrong") f.set("_recipients_present", "0"); if (kind === "duplicate") f.append("_recipients_present", "1");
    expect((await w.post(f)).status).toBe(400); expect(await w.read()).toMatchObject({ revision: 1, recipients: [w.member.identity.id] }); expect(await changes()).toBe(1);
  });
  it.each(["duplicate", "foreign", "reader", "agent", "malformed", "file", "too-many"])("rejects %s recipient selection atomically", async kind => {
    const w = await world(); const ids = kind === "duplicate" ? [w.member.identity.id, w.member.identity.id] : kind === "foreign" ? [w.stranger.identity.id] : kind === "reader" ? [w.reader.identity.id] : kind === "agent" ? [w.bot.agent.identity.id] : kind === "malformed" ? ["[not-an-array]"] : [];
    let form: URLSearchParams | FormData = withRecipients(w.form([]), ids);
    if (kind === "too-many") for (let i = 0; i < 11; i++) form.append("recipients", ulid(Date.now() + i));
    if (kind === "file") { const fd = new FormData(); form.forEach((v, k) => fd.append(k, v)); fd.append("recipients", new File([w.member.identity.id], "id.txt")); form = fd; }
    expect((await w.post(form)).status).toBeGreaterThanOrEqual(400); expect(await w.read()).toMatchObject({ state: "unset", revision: 0 }); expect(await changes()).toBe(0);
  });
  it("refuses stale/replayed form saves and membership removal between display and save", async () => {
    const w = await world(); const f = withRecipients(w.form([]), [w.member.identity.id]);
    expect((await w.post(f)).status).toBe(303); expect((await w.post(f)).status).toBe(409);
    expect((await w.post(w.form([]))).status).toBe(409); expect(await changes()).toBe(1);
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ?").bind(w.member.identity.id).run();
    expect((await w.post(withRecipients(w.form([], "1"), [w.member.identity.id]))).status).toBe(409); expect(await changes()).toBe(1);
  });
  it("denies cross-origin form edits and human non-admin/agent callers before any effect", async () => {
    const w = await world();
    for (const h of [{ ...w.headers, origin: "https://evil.test" }, cookieHeaders(w.member.token, host), cookieHeaders(w.reader.token, host), bearer(w.bot.token), {}]) {
      expect((await w.post(w.form([]), h)).status).toBeGreaterThanOrEqual(400);
    }
    expect(await changes()).toBe(0); expect(await w.read()).toMatchObject({ state: "unset" });
  });
});
