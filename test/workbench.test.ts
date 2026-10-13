// The workbench (2026-10-07): persistent rail with live counts, list and inspector panes that keep their place,
// + File, the jump box, and the planned areas in plain view.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { WORKBENCH_JS } from "../src/workbenchScript";
import { clientSlow } from "../src/http/clientSlow";
import { createProject } from "../src/db/projects";
import { addAgentMember, createChannel } from "../src/db/chat";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const h = cookieHeaders(pat.token, HOST);
  for (const [kind, title, owner] of [["snag", "Checkout fails", "me"], ["wish", "Dark mode", ""], ["quest", "Launch", ""]] as const) {
    await apiPost(HOST, "work.create", { project: "site", kind, title, ...(owner ? { owner } : {}) }, h);
  }
  const get = async (path: string, headers: Record<string, string> = {}) => SELF.fetch(`https://${HOST}${path}`, { headers: { ...h, ...headers } });
  return { t, pat, h, get };
}
const attr = (html: string, id: string) => /data-key="([^"]*)"/.exec(html.slice(html.indexOf(`id="${id}"`)))?.[1];

describe("the workbench", () => {
  it("groups bounded, content-free browser reports as slow and isolates tenant sources", async () => {
    const w = await world();
    const project = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'site'").bind(w.t.id).first<{ id: string }>();
    await env.HUB_DB.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at) VALUES ('client-source', ?, ?, 'pimwell-hub', 'active', ?)").bind(w.t.id, project!.id, Date.now()).run();
    const payload = { path: "/:project/w/:number", duration: 15001, phase: "body", result: "timeout", status: 200 };
    const send = (body: unknown = payload, headers: Record<string, string> = {}) => SELF.fetch(`https://${HOST}/client/slow`, { method: "POST", headers: { ...w.h, origin: `https://${HOST}`, "content-type": "application/json", "x-pimwell-client": "1", ...headers }, body: JSON.stringify(body) });
    expect((await send()).status).toBe(204);
    expect((await send({ ...payload, duration: 16000 })).status).toBe(204);
    const listed = await apiPost(HOST, "trace.list", {}, w.h);
    const groups = ((await listed.json()) as { result: { groups: Array<{ id: string; kind: string; count: number }> } }).result.groups;
    expect(groups).toHaveLength(1); expect(groups[0]).toMatchObject({ kind: "slow", count: 2 });
    const read = await apiPost(HOST, "trace.read", { id: groups[0]!.id }, w.h);
    expect(((await read.json()) as { result: { group: { kind: string } } }).result.group.kind).toBe("slow");
    expect(await (await w.get(`/apps?g=${groups[0]!.id}`)).text()).toContain("duration=16000ms phase=body status=200");
    for (const body of [{ ...payload, path: "/private-secret?q=mail" }, { ...payload, content: "secret" }, { ...payload, duration: -1 }, { ...payload, duration: 1.5 }, { ...payload, status: 999 }, { ...payload, phase: "secret" }, { ...payload, result: "secret" }, "x".repeat(1100), null]) expect((await send(body)).status).toBe(400);
    expect((await send(payload, { origin: "https://evil.test" })).status).toBe(403);
    expect((await send(payload, { "x-pimwell-client": "" })).status).toBe(403);
    expect((await send(payload, { cookie: "" })).status).toBe(403);
    const foreign = await seedTenant("other");
    const outsider = await seedHuman("outsider@example.com", { memberships: [{ tenant_id: foreign.id, role: "member" }] });
    const response = await SELF.fetch("https://other.pimwell.test/client/slow", { method: "POST", headers: { ...cookieHeaders(outsider.token, "other.pimwell.test"), origin: "https://other.pimwell.test", "x-pimwell-client": "1" }, body: JSON.stringify(payload) });
    expect(response.status).toBe(204);
    expect(await env.HUB_DB.prepare("SELECT count(*) AS n FROM app_event").first()).toEqual({ n: 2 });
  });

  it("caps browser-report examples and rate-limits each signed-in identity", async () => {
    const w = await world();
    await env.HUB_DB.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at) SELECT 'bounded-source', ?, id, 'pimwell-hub', 'active', ? FROM project WHERE tenant_id = ? AND slug = 'site'").bind(w.t.id, Date.now(), w.t.id).run();
    // Keep every request in one rate window, even when the suite crosses a minute boundary.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const send = async () => {
      const pending: Promise<unknown>[] = [];
      const res = await clientSlow(new Request(`https://${HOST}/client/slow`, { method: "POST", headers: { ...w.h, origin: `https://${HOST}`, "x-pimwell-client": "1" }, body: JSON.stringify({ path: "/people", duration: 15000, phase: "headers", result: "timeout", status: null }) }), env, p => { pending.push(p); });
      await Promise.all(pending);
      return res;
    };
    try {
      for (let i = 0; i < 60; i++) expect((await send()).status).toBe(204);
      expect((await send()).status).toBe(429);
      expect(await env.HUB_DB.prepare("SELECT count(*) AS n FROM app_event").first()).toEqual({ n: 50 });
      expect(await env.HUB_DB.prepare("SELECT count FROM app_error_group").first()).toEqual({ count: 60 });
    } finally {
      clock.mockRestore();
    }
  });

  it("shows the rail with live counts on every page, read in the sign-in batch", async () => {
    const w = await world();
    const res = await w.get("/docket");
    const html = await res.text();
    expect(html).toContain('<body class="wb"');
    expect(html).toMatch(/aria-current="page">Docket<span class="wb-count">3<\/span><\/a>/);
    expect(html).toMatch(/>Mine<span class="wb-count">1<\/span><\/a>/);
    expect(html).toContain('id="explorer"');
    expect(html).toContain('<a href="/site/docket">Docket<span class="wb-count">3</span></a></summary>');
    expect(html).toContain('aria-label="Project switcher"');
    expect(html).toContain('class="bar"');
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('<span class="pill">planned</span>');
    expect(html).toContain('<nav class="tabs" aria-label="Sections">');
    expect(res.headers.get("server-timing")).toMatch(/db;desc="2 round trips/);
  });

  it("frames bearer-session page requests without exposing channels to non-participant agents", async () => {
    const w = await world(), agent = await seedAgent(w.t, w.pat.identity);
    const project = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'site'").bind(w.t.id).first<{id: string}>();
    const ch = await createChannel(env.HUB_DB, {tenant_id: w.t.id, slug: "restricted-room", display_name: "Restricted room", topic: "", created_by: w.pat.identity.id, owner_project_id: project!.id}, Date.now());
    const read = async (token: string) => (await SELF.fetch(`https://${HOST}/site/docket`, {headers: {authorization: `Bearer ${token}`}})).text();
    expect(await read(w.pat.token)).toContain('href="/c/restricted-room"');
    const before = await read(agent.token);
    expect(before).toContain('data-project="site" data-in-project="1"');
    expect(before).toContain('Docket<span class="wb-count">3</span>');
    expect(before).not.toContain("Restricted room");
    await addAgentMember(env.HUB_DB, {conversation_id: ch.project_id, tenant_id: w.t.id, identity_id: agent.agent.identity.id, added_by: w.pat.identity.id}, Date.now());
    expect(await read(agent.token)).toContain('href="/c/restricted-room"');
  });

  it("chooses the project from the URL before an identity-bound preference and retains it on organization places", async () => {
    const w = await world();
    await createProject(env.HUB_DB, {tenant_id: w.t.id, namespace_id: null, slug: "notes", kind: "workspace", display_name: "Notes"}, Date.now());
    const cookie = `${w.h.cookie}; pmw_project=${encodeURIComponent(`${w.pat.identity.id}:notes`)}`;
    for (const path of ["/mail", "/attention", "/c", "/people", "/apps", "/search?q=hello"]) {
      const res = await w.get(path, {cookie});
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-project="notes" data-in-project="0"');
      expect(html).toContain('aria-label="Project resources"');
      expect(html).toContain('acme.notes@pimwell.test');
      expect(html).toContain('https://acme.pimwell.test/p/notes/mcp');
    }
    const html = await (await w.get("/site/w/1", {cookie})).text();
    expect(html).toContain('data-project="site" data-in-project="1"');
    const bar = html.slice(html.indexOf('<header class="bar">'), html.indexOf('</header>'));
    expect(bar).toMatch(/ACME.*Site.*Docket.*#1/s);
    const foreign = await seedTenant("other");
    await createProject(env.HUB_DB, {tenant_id: foreign.id, namespace_id: null, slug: "secret", kind: "wiki", display_name: "Secret project"}, Date.now());
    for (const preference of [`${w.pat.identity.id}:secret`, "other-person:site", `${w.pat.identity.id}:missing`, "%invalid"]) {
      const page = await (await w.get("/mail", {cookie: `${w.h.cookie}; pmw_project=${encodeURIComponent(preference)}`})).text();
      expect(page).toContain('data-project="notes"');
      expect(page).not.toContain("Secret project");
    }
  });

  it("renders kind-specific resources and current counts rather than revisions or private mail", async () => {
    const w = await world();
    await apiPost(HOST, "project.create", {slug: "notes", kind: "workspace", display_name: "Notes"}, w.h);
    await apiPost(HOST, "wiki.write", {project: "notes", slug: "guide", title: "Guide", body: "First", note: "Create", expected_revision: 0}, w.h);
    await apiPost(HOST, "wiki.write", {project: "notes", slug: "guide", title: "Guide", body: "Second", note: "Revise", expected_revision: 1}, w.h);
    await apiPost(HOST, "research.save", {project: "notes", slug: "findings", topic: "Findings", summary: "Evidence", status: "draft", sources: [], note: "Save", expected_revision: 0}, w.h);
    await apiPost(HOST, "person.upsert", {project: "notes", name: "Alex"}, w.h);
    await apiPost(HOST, "channel.create", {slug: "notes-chat", project: "notes"}, w.h);
    for (const revision of [0, 1]) {
      const uploaded = await apiPost(HOST, "file.put", {project: "notes", path: "guide.txt", content_type: "text/plain", expected_revision: revision, base64: btoa(`Version ${revision + 1}`)}, w.h);
      expect(uploaded.status).toBe(200);
    }
    const notes = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'notes'").bind(w.t.id).first<{id: string}>();
    for (const [id, recipient, verdict] of [["shared", null, "admitted"], ["private", w.pat.identity.id, "admitted"], ["held", null, "quarantined"]] as const) {
      await env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, project_id, recipient_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded)
        VALUES (?, ?, ?, ?, ?, 'sender@example.com', 'acme.notes@pimwell.test', ?, ?, 1, ?, '', '[]', 0)`).bind(id, w.t.id, notes!.id, recipient, w.pat.identity.id, id, Date.now(), verdict).run();
    }
    const html = await (await w.get("/notes/wiki/guide")).text();
    const explorer = html.slice(html.indexOf('id="explorer"'), html.indexOf('<a class="scrim"'));
    expect(explorer).toContain('Wiki<span class="wb-count">2</span>');
    expect(explorer).toContain('Research<span class="wb-count">1</span>');
    expect(explorer).toContain('Contacts and graph<span class="wb-count">1</span>');
    expect(explorer).toContain('Files<span class="wb-count">1</span>');
    expect(explorer).toContain('Mail<span class="wb-count">1</span>');
    expect(explorer).toContain('Channels<span class="wb-count">2</span>');
    expect(explorer).toContain('href="/c/notes-team"');
    expect(explorer).not.toContain('href="/c/notes-chat"');
    expect(explorer).not.toContain("Repository and code");
    const repo = await (await w.get("/site/docket")).text();
    expect(repo).toContain("Repository and code");
    expect(repo.slice(repo.indexOf('id="explorer"'), repo.indexOf('<a class="scrim"'))).not.toContain("Wiki");
    await env.HUB_DB.prepare("UPDATE wiki_revision SET deleted = 1 WHERE project_id = ? AND slug = 'guide' AND revision = 2").bind(notes!.id).run();
    await env.HUB_DB.prepare("UPDATE file_revision SET deleted = 1 WHERE project_id = ? AND revision = 2").bind(notes!.id).run();
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(notes!.id).run();
    const changed = await (await w.get("/notes/wiki")).text();
    expect(changed).toContain('data-project="notes" data-in-project="1"');
    expect(changed).toContain('Wiki<span class="wb-count">1</span>');
    expect(changed).toContain('Files</a>');
    expect(changed).not.toContain('wb-count">0</span>');
    const mail = await (await w.get("/mail?project=notes")).text();
    expect(mail).toContain('Mail · notes');
  });

  it("reloads instead of retaining panes when enhanced navigation sees a different account or role", () => {
    const swap = WORKBENCH_JS.slice(WORKBENCH_JS.indexOf("  function swap("), WORKBENCH_JS.indexOf("  var busy ="));
    const run = new Function("$", "doc", "location", `${swap}\nswap(doc, '/docket', true);`);
    for (const nextLabel of ["work@example.com (member)", "owner@example.com (member)", null]) {
      const current = vi.fn((selector: string) => selector === ".bar .me" ? { textContent: "owner@example.com (root)" } : {});
      const doc = { querySelector: vi.fn((selector: string) => selector === ".bar .me" ? nextLabel === null ? null : { textContent: nextLabel } : {}) };
      const location = { href: "/" };
      run(current, doc, location);
      expect(location.href).toBe("/docket");
      expect(current.mock.calls.map(([selector]) => selector)).toEqual(["main.panes", ".bar .me"]);
      expect(doc.querySelector.mock.calls.map(([selector]) => selector)).toEqual(["main.panes", ".bar .me"]);
    }
  });

  it("distinguishes identical display names by the active address and role on hub and tenant pages", async () => {
    const t = await seedTenant("acme");
    const root = await seedHuman("owner@example.com", { is_root: true });
    const member = await seedHuman("work@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await env.HUB_DB.prepare("UPDATE identity SET display_name = 'Brian' WHERE id IN (?, ?)").bind(root.identity.id, member.identity.id).run();
    for (const who of [root, member]) {
      for (const host of ["pimwell.test", HOST]) {
        const res = await SELF.fetch(`https://${host}/`, { headers: cookieHeaders(who.token, host) });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        const role = who === root ? "root" : host === HOST ? "member" : null;
        expect(html).toContain(`<a class="me" href="https://pimwell.test/me">${who.identity.email}${role ? ` (${role})` : ""}</a>`);
        expect(html).toContain(`<li class="account-details">${who.identity.email}${role ? `<span>Role: ${role}</span>` : ""}</li>`);
        expect(html).not.toContain(who === root ? member.identity.email : root.identity.email);
      }
    }
    const anonymous = await (await SELF.fetch(`https://${HOST}/`)).text();
    expect(anonymous).not.toContain("account-details");
    expect(anonymous).not.toContain(root.identity.email);
    expect(anonymous).not.toContain(member.identity.email);
  });

  it("opens an item beside the same list, keeping the list's filters and key", async () => {
    const w = await world();
    const list = await (await w.get("/site/docket?kind=snag")).text();
    expect(list).toContain('data-href="/site/w/1?kind=snag"');
    const item = await (await w.get("/site/w/1?kind=snag")).text();
    expect(attr(item, "list")).toBe(attr(list, "list"));
    expect(attr(item, "inspector")).toMatch(/^w:/);
    expect(item).toContain('data-focus="inspector"');
    expect(item).toContain('<summary aria-label="Change Title">Checkout fails');
    expect(item).toContain('<a class="back" href="/site/docket?kind=snag">');
    expect(item).toContain('name="_back" value="/site/w/1?kind=snag"');
    expect(item).toContain("<h2>Comments</h2>");
    const org = await (await w.get("/docket?owner=me")).text();
    expect(org).toContain('data-href="/site/w/1?in=org&amp;owner=me"');
    const orgItem = await (await w.get("/site/w/1?in=org&owner=me")).text();
    expect(attr(orgItem, "list")).toBe(attr(org, "list"));
  });

  it("files new work from + File and lands on it", async () => {
    const w = await world();
    const page = await (await w.get("/new?project=site&kind=errand&title=Build%20it")).text();
    expect(page).toContain('value="@result"');
    expect(page).toContain('<option value="errand" selected>');
    const res = await SELF.fetch(`https://${HOST}/api/work.create`, {
      method: "POST", redirect: "manual",
      headers: { cookie: `pmw_session=${w.pat.token}`, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: "site", kind: "errand", title: "Build it", _back: "@result" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/site/w/4");
  });

  it("jumps to refs, projects, titles and people", async () => {
    const w = await world();
    const j = async (q: string) => ((await (await w.get(`/jump?q=${encodeURIComponent(q)}`, { accept: "application/json" })).json()) as { results: Array<{ label: string; href: string }> }).results;
    expect((await j("site#2"))[0]).toMatchObject({ href: "/site/w/2", label: "site#2 Dark mode" });
    expect((await j("sit")).map((r) => r.href)).toContain("/site/docket");
    expect((await j("checkout")).map((r) => r.href)).toContain("/site/w/1");
    expect((await j("pat@")).map((r) => r.href)).toContain("/docket?owner=pat%40example.com");
    expect((await j("100%_")).map((r) => r.href)).toEqual(["/search?q=100%25_"]);
    expect(await (await w.get("/jump?q=dark")).text()).toContain("Dark mode");
    // Nothing typed: likely places, grouped, so most jumps are one tap.
    const sug = ((await (await w.get("/jump?suggest=1", { accept: "application/json" })).json()) as { results: Array<{ label: string; href: string; group: string }> }).results;
    expect(sug.filter((r) => r.group === "Go to").map((r) => r.href)).toEqual(["/attention", "/docket", "/assistant", "/mail"]);
    expect(sug.filter((r) => r.group === "Projects").map((r) => r.href)).toContain("/site/docket");
  });

  it("lists what is coming, with each planned verb's spec", async () => {
    const w = await world();
    const all = await (await w.get("/planned")).text();
    expect(all).toContain("<code>review.integrate</code>");
    const one = await (await w.get("/planned/review?v=review.integrate")).text();
    expect(one).toContain("<code>review_integrate</code>");
    expect(one).toContain("POST /api/review.integrate");
    expect(one).toContain("501 not_implemented");
    expect((await w.get("/planned/nosuch")).status).toBe(404);
  });

  it("links one cached stylesheet and script, offers Log out, and signs out to a page that needs no session", async () => {
    const w = await world();
    const html = await (await w.get("/docket")).text();
    const css = /href="(\/assets\/app\.[a-z0-9]+\.css)"/.exec(html)![1]!;
    const js = /src="(\/assets\/wb\.[a-z0-9]+\.js)"/.exec(html)![1]!;
    for (const path of [css, js]) {
      const res = await SELF.fetch(`https://${HOST}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control")).toContain("immutable");
    }
    expect(await (await SELF.fetch(`https://${HOST}${css}`)).text()).toContain("--accent:");
    expect((await SELF.fetch(`https://${HOST}/assets/app.old.css`)).status).toBe(404);
    expect(html).not.toContain("<style>");
    expect(html).toContain('<h4>Your account</h4>');
    expect(html).toContain('action="/api/session.end" data-reload><input type="hidden" name="_back" value="/signed-out">');
    const out = await SELF.fetch(`https://${HOST}/api/session.end`, { method: "POST", redirect: "manual", headers: { ...w.h, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" }, body: "_back=%2Fsigned-out" });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/signed-out");
    expect(await (await SELF.fetch(`https://${HOST}/signed-out`)).text()).toContain("re signed out");
  });
});
