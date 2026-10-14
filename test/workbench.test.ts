// The workbench (2026-10-07): persistent rail with live counts, list and inspector panes that keep their place,
// + File, the jump box, and the planned areas in plain view.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { address, localTime, timeText, naturalName, plural } from "../src/html";
import { WORKBENCH_JS } from "../src/workbenchScript";
import { clientSlow } from "../src/http/clientSlow";
import { clientTiming } from "../src/http/clientTiming";
import { timingPath, TIMING_PATHS } from "../src/clientTiming";
import { createBrowserSession } from "../src/db/sessions";
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
  it("keeps reviewed shell, search, usage and numeric names compact", async () => {
    const w = await world();
    for (const n of [10,2]) await createProject(env.HUB_DB, {tenant_id:w.t.id,namespace_id:null,slug:`team-${n}`,kind:"workspace",display_name:`Team ${n}`},Date.now());
    const people = await (await w.get("/people")).text();
    const crumb = people.match(/aria-label="Breadcrumb"[\s\S]*?<\/nav>/)![0];
    expect(crumb).toContain("People and agents");
    expect(crumb).not.toContain(">Site<");
    expect(people).not.toContain("Your account</h4>");
    expect(people.match(/action="\/api\/session.end"/g)).toHaveLength(1);
    const explorer = people.slice(people.indexOf('id="explorer"'),people.indexOf('aria-label="Other projects"'));
    expect(explorer.indexOf('id="project-filter"')).toBeLessThan(explorer.indexOf('aria-label="Project resources"'));
    const otherProjects = people.slice(people.indexOf('aria-label="Other projects"'));
    expect(otherProjects.indexOf("Team 2")).toBeLessThan(otherProjects.indexOf("Team 10"));
    const home = await (await w.get("/")).text();
    const projects = home.slice(home.indexOf('<table class="wb-table" aria-label="Projects"'));
    expect(projects.indexOf("Team 2")).toBeLessThan(projects.indexOf("Team 10"));
    expect((await (await w.get("/new?project=site")).text()).split("</header>")[0]).not.toContain('+ File');
    const search = await (await w.get("/search?q=Checkout")).text();
    const list = search.slice(search.indexOf('id="list"'),search.indexOf('id="inspector"'));
    expect(list).not.toContain('<form');
    expect(list.match(/<table/g)).toHaveLength(1);
    for (const heading of ["Kind","Reference","Title","Project","When"]) expect(list).toContain(`>${heading}</th>`);
    expect(list).not.toContain('<td></td>');
    expect(list).toContain("Site");
    expect(search).toContain('value="Checkout" placeholder="Search');
    const usage = await (await w.get("/usage?group=work")).text();
    expect(usage.match(/<table/g)).toHaveLength(1);
    expect(usage).toContain('name="group"');
    for (const heading of ["Cost (USD)","Calls","Input","Output"]) expect(usage).toContain(`>${heading}</th>`);
    expect(usage.match(/>ⓘ</g)).toHaveLength(1);
    const board = await (await w.get("/site/board")).text();
    for (const title of ["Open","Under way","Done lately"]) expect(board).toContain(`<h2>${title} `);
    expect(board).not.toContain("Recorded totals · rows sampled");
  });

  it("renders safe, browser-local time hooks, copyable addresses and singular counts", () => {
    expect(localTime(null)).toBe("Not recorded");
    const now = Date.UTC(2026, 9, 13, 19, 22);
    expect(timeText(now, now, "America/Chicago")).toBe("Today 14:22");
    expect(timeText(Date.UTC(2026, 9, 12, 14, 10), now, "America/Chicago")).toBe("Mon 09:10");
    expect(timeText(Date.UTC(2026, 9, 6, 14, 10), now, "America/Chicago")).toBe("6 Oct");
    expect(timeText(now, now, "UTC")).toBe("Today 19:22");
    expect(localTime(0)).toContain('data-local-time="0"');
    expect(localTime(Date.UTC(2026,9,13,17,8))).toContain('data-local-time="1791911280000"');
    expect(WORKBENCH_JS).toContain('d.toLocaleTimeString');
    expect(WORKBENCH_JS).toContain('"Today "');
    expect(address('x<y@example.test')).toContain('x&lt;y@example.test</code>');
    expect(address('x@example.test')).toContain('data-copy="address"');
    expect(naturalName("Team 2","Team 10")).toBeLessThan(0);
    expect(plural(1,"agent")).toBe("1 agent");
    expect(plural(1,"work group")).toBe("1 work group");
    expect(plural(1,"active source")).toBe("1 active source");
  });
  it("keeps navigation on signed-in views without retired components", async () => {
    const w = await world();
    await apiPost(HOST, "project.create", {slug:"notes",kind:"workspace",display_name:"Notes"}, w.h);
    for (const path of ["/", "/site", "/site/docket", "/site/w/1", "/site/board", "/site/status", "/site/graph", "/site/frontier", "/notes", "/notes/wiki", "/notes/documents", "/notes/contacts", "/attention", "/mail", "/c", "/assistant", "/assistant/tools", "/people", "/apps", "/situations", "/usage", "/search?q=Checkout", "/new?project=site", "/archive", "/skills"]) {
      const response = await w.get(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain('aria-label="Breadcrumb"');
      expect(html, path).toContain('id="rail"');
      expect(html, path).toContain('id="org-places"');
      expect(html, path).toContain('id="explorer"');
      // localTime() returns a whole <time> element; nesting it in an attribute leaks markup onto the page.
      expect(html, path).not.toMatch(/="<time|<time[^>]*>[^<]*<time/);
      for (const classes of html.matchAll(/class="([^"]*)"/g)) {
        expect(classes[1]!.split(/\s+/).filter(c => ["card","grid","onramp","intent-card","bars","board","bcol","bcard","progress","closure-counts","diff"].includes(c)), path).toEqual([]);
      }
    }
    const item = await (await w.get("/site/w/1")).text();
    expect(item).not.toContain("Recorded below");
    expect(item).toContain('class="wb-comment"');
    expect(item).toContain('class="wb-add-dependency"');
    const board = await (await w.get("/site/board")).text();
    expect(board).toContain('class="wb-board-columns"');
    expect(board).toContain('<select name="actor">');
    expect(board).not.toContain("Actor identity ID <input");
    expect(await (await w.get("/notes/documents?upload=1")).text()).toContain('<select name="person_id">');
  });

  it("selects attention work in place with filters, actions and explicit acknowledgement preserved", async () => {
    const w = await world();
    const item = await env.HUB_DB.prepare("SELECT id FROM work_item WHERE tenant_id = ? AND number = 1").bind(w.t.id).first<{id:string}>();
    await env.HUB_DB.prepare("INSERT INTO attention (id,tenant_id,identity_id,reason,item_id,summary,created_at) VALUES ('attention-selection',?,?, 'comment',?,'Please check checkout',?)").bind(w.t.id,w.pat.identity.id,item!.id,Date.now()).run();
    const list = await (await w.get("/attention?done=1")).text();
    expect(list).toContain('aria-label="Needs me"');
    expect(list).toContain('data-href="/attention?done=1&amp;work=site%231"');
    const selected = await (await w.get("/attention?done=1&work=site%231")).text();
    expect(selected).toContain('data-project="site"');
    expect(selected).toContain('aria-selected="true"');
    expect(selected).toContain('class="back" href="/attention?done=1"');
    const inspector = selected.slice(selected.indexOf('id="inspector"'));
    expect(inspector).toContain("Checkout fails");
    expect(inspector).toContain('action="/api/work.update"');
    expect(inspector).toContain('name="expected_updated_at"');
    expect(await env.HUB_DB.prepare("SELECT done_at FROM attention WHERE id = 'attention-selection'").first<{done_at:number}>()).toMatchObject({done_at:expect.any(Number)});
    expect((await w.get("/attention?work=unknown%231")).status).toBe(404);
  });

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

  it("validates timing batches, joins IDs and isolates the authenticated tenant", async () => {
    const w = await world();
    const points: Parameters<AnalyticsEngineDataset["writeDataPoint"]>[0][] = [];
    const measured = {...env, WORKER_VERSION:{id:"test-version",tag:"",timestamp:""}, PERF:{writeDataPoint:(p: Parameters<AnalyticsEngineDataset["writeDataPoint"]>[0]) => points.push(p)} as unknown as AnalyticsEngineDataset};
    const request = crypto.randomUUID();
    const at=Date.now()-12.5;
    const payload = [{path:"/:project/docket",previous:"/",name:"docket.select",phase:"paint",request,duration:12.5,at}];
    async function send(body: unknown = payload, headers: Record<string,string> = {}) {
      const pending: Promise<unknown>[] = [];
      const res = await clientTiming(new Request(`https://${HOST}/client/timing`,{method:"POST",headers:{...w.h,origin:`https://${HOST}`,...headers},body:JSON.stringify(body)}),measured,p=>pending.push(p));
      await Promise.all(pending); return res;
    }
    expect((await send()).status).toBe(204);
    expect(points).toHaveLength(1);
    expect(points[0]!.blobs).toEqual(["pimwell.com","pimwell-hub","test-version","",expect.stringMatching(/^[0-9a-f]{32}$/),request,"client","/:project/docket","paint","","cookie","","","docket.select","","","","","/",JSON.stringify({file:"src/clientTimingScript.ts",line:19,fn:"point"})]);
    expect(points[0]!.doubles?.[0]).toBe(12.5);
    expect(points[0]!.doubles?.[15]).toBe(at);
    expect(points[0]!.doubles?.[19]).toBe(2);
    for (const change of [{path:"/secret?q=mail"},{previous:"/private"},{name:"secret"},{phase:"secret"},{request:"secret"},{duration:-1},{duration:3600001},{duration:null},{at:0},{at:"bad"},{at:Date.now()-86_460_000},{at:Date.now()+86_460_000},{text:"private"},{tenant:w.t.id},{version:"spoof"}]) expect((await send([{...payload[0],...change}])).status).toBe(400);
    for (const body of [null,{},[],Array(101).fill(payload[0]),["x"], "x".repeat(33000)]) expect((await send(body)).status).toBe(400);
    for (const headers of [{origin:"https://evil.test"},{cookie:""},{cookie:"",authorization:`Bearer ${w.pat.token}`}] as Record<string,string>[]) expect((await send(payload,headers)).status).toBe(403);
    expect(points).toHaveLength(1);
    for (const path of ["/sample/wiki/private?q=mail","/sample/reviews/42","/c/private/t/2","/people/private@example.test","/admin/models","/me/sessions"]) {
      const template = timingPath(path); expect(TIMING_PATHS).toContain(template); expect(template).not.toContain("private");
    }
    const foreign = await seedTenant("other");
    const outsider = await seedHuman("outsider@example.com",{memberships:[{tenant_id:foreign.id,role:"member"}]});
    const pending: Promise<unknown>[] = [];
    expect((await clientTiming(new Request("https://other.pimwell.test/client/timing",{method:"POST",headers:{...cookieHeaders(outsider.token,"other.pimwell.test"),origin:"https://other.pimwell.test"},body:JSON.stringify(payload)}),measured,p=>pending.push(p))).status).toBe(204);
    await Promise.all(pending);
    expect(points[1]!.blobs?.[4]).not.toBe(points[0]!.blobs?.[4]);
  });

  it("rate limits timing per browser session, not identity, and bounds each batch", async () => {
    const w = await world();
    const clock = vi.spyOn(Date,"now").mockReturnValue(Date.now());
    const body = JSON.stringify([{path:"/",previous:"/other",name:"navigation",phase:"page",request:crypto.randomUUID(),duration:1}]);
    const send = async (token = w.pat.token) => {
      const pending: Promise<unknown>[] = [];
      const res = await clientTiming(new Request(`https://${HOST}/client/timing`,{method:"POST",headers:{...cookieHeaders(token,HOST),origin:`https://${HOST}`},body}),env,p=>pending.push(p));
      await Promise.all(pending); return res;
    };
    try {
      for (let n=0;n<120;n++) expect((await send()).status).toBe(204);
      expect((await send()).status).toBe(429);
      const another = await createBrowserSession(env.HUB_DB,w.pat.identity.id,Date.now());
      expect((await send(another.token)).status).toBe(204);
    } finally { clock.mockRestore(); }
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
    expect(bar).toMatch(/ACME.*Site.*Docket.*Checkout fails/s);
    expect(bar).not.toContain(">#1<");
    const orgBar = (await (await w.get("/people", {cookie})).text()).split("</header>")[0]!;
    expect(orgBar).not.toContain(">Notes<");
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
    expect(repo).toContain('href="/site/code">Code');
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

  it("keeps knowledge selections beside their kit lists and preserves URL filters and revisions", async () => {
    const w = await world();
    const call = async (name: string, input: unknown) => {
      const res = await apiPost(HOST,name,input,w.h);
      expect(res.status,await res.clone().text()).toBe(200);
      return (await res.json() as {result:{entity:{id:string}}}).result;
    };
    await call("project.create",{slug:"notes",kind:"workspace",display_name:"Notes"});
    await call("wiki.write",{project:"notes",slug:"guide",title:"Guide <safe>",body:"Handbook",expected_revision:0,note:"Create"});
    await call("research.save",{project:"notes",slug:"finding",topic:"Topic <safe>",summary:"Evidence",status:"draft",sources:[],expected_revision:0,note:"Save"});
    await call("file.put",{project:"notes",path:"handbook/guide.txt",content_type:"text/plain",expected_revision:0,base64:btoa("Handbook")});
    const a = await call("person.upsert",{project:"notes",name:"Alex <safe>",links:[{kind:"research",ref:"finding"}]});
    const b = await call("company.upsert",{project:"notes",name:"Company"});
    await call("connection.add",{project:"notes",a:a.entity.id,b:b.entity.id,type:"advisor"});
    const html = async (path: string) => {const res=await w.get(path); expect(res.status).toBe(200); return res.text();};
    const list = (body: string) => body.split('<section id="list"')[1]!.split('<div class="wb-resizer"')[0]!;
    const inspector = (body: string) => body.split('<section id="inspector"')[1]!;
    const wiki = await html("/notes/wiki/guide");
    expect(list(wiki)).toContain('aria-label="Page tree"');
    expect(inspector(wiki)).toContain("Guide &lt;safe&gt;");
    expect(inspector(wiki)).toContain('class="wb-inline-edit"');
    expect(inspector(wiki)).toContain('name="expected_revision" value="1"');
    expect(attr(wiki,"list")).toBe(attr(await html("/notes/wiki"),"list"));
    const research = await html("/notes/wiki/finding?view=research&status=draft&topic=Topic");
    expect(list(research)).toContain('aria-label="Research"');
    expect(list(research)).toContain('data-href="/notes/wiki/finding?view=research&amp;status=draft&amp;topic=Topic"');
    expect(inspector(research)).toContain("Topic &lt;safe&gt;");
    expect(inspector(research)).toContain('revision=1');
    expect(inspector(research)).toContain('view=research&amp;status=draft&amp;topic=Topic&amp;revision=1');
    const files = await html("/notes/documents?folder=handbook&path=handbook%2Fguide.txt");
    expect(list(files)).toContain('aria-label="Folders"');
    expect(list(files)).toContain('aria-label="Files"');
    expect(inspector(files)).not.toContain('aria-label="Versions"');
    expect(inspector(files)).not.toContain("SHA-256");
    expect(inspector(files)).toContain("modified ");
    expect(inspector(files)).toContain("data-local-time=");
    expect(inspector(files)).toContain('Mail sharing');
    expect(attr(files,"list")).toBe(attr(await html("/notes/documents?folder=handbook"),"list"));
    const upload = await html("/notes/documents?upload=1");
    expect(inspector(upload)).toContain('data-reload enctype="multipart/form-data"');
    expect(inspector(upload)).toContain('select name="person_id"');
    for (const [n,back,expected] of [[1,"/notes/documents?folder=handbook","/notes/documents?folder=handbook"],[2,"//evil.test/notes/documents","/notes/documents"],[3,"/mail?private=1","/notes/documents"]] as const) {
      const form = new FormData();
      form.set("file",new File(["Native upload"],`native-${n}.txt`,{type:"text/plain"}));
      form.set("expected_revision","0"); form.set("_back",back);
      const response = await SELF.fetch(`https://${HOST}/notes/documents/upload`,{method:"POST",headers:{...w.h,origin:`https://${HOST}`},body:form,redirect:"manual"});
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(expected);
    }
    const contact = await html(`/notes/contacts/${a.entity.id}?q=Alex`);
    expect(list(contact)).toContain('aria-label="Contacts"');
    expect(inspector(contact)).toContain('aria-label="Backlinks"');
    expect(inspector(contact)).toContain('aria-label="Connections"');
    const graph = await html(`/notes/contacts/${a.entity.id}?view=graph&q=Alex`);
    expect(list(graph)).toContain('aria-label="Contact neighborhood"');
    expect(list(graph)).toContain(`/${b.entity.id}?view=graph&amp;q=Alex&amp;kind=company`);
    expect(inspector(graph)).toContain('Alex &lt;safe&gt;');
    expect(inspector(graph)).not.toContain('<svg');
    const reader = await seedHuman("reader@example.com",{memberships:[{tenant_id:w.t.id,role:"reader"}]});
    for (const path of ["/notes/wiki/guide","/notes/documents?upload=1","/notes/contacts?new=1"]) {
      const body = await (await w.get(path,cookieHeaders(reader.token,HOST))).text();
      expect(body).not.toContain('action="/api/wiki.write"');
      expect(body).not.toContain('action="/api/person.upsert"');
      expect(body).not.toContain('enctype="multipart/form-data"');
    }
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE tenant_id = ? AND slug = 'notes'").bind(w.t.id).run();
    expect(await html("/notes/wiki/guide")).not.toContain('action="/api/wiki.write"');
    expect(await html("/notes/documents?upload=1")).not.toContain('enctype="multipart/form-data"');
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
        expect(html).toContain(`<a class="me" href="https://pimwell.test/me"><code id="header-email">${who.identity.email}</code>${role ? ` (${role})` : ""}</a>`);
        expect(html).not.toContain('class="account-details"');
        expect(html.match(/action="\/api\/session.end"/g)).toHaveLength(1);
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
    expect(page).toContain('class="wb-form-row"');
    expect(page).toContain('id="new-title"');
    expect(page).toContain('data-focus="list"');
    expect(page.slice(page.indexOf('<section id="list"'),page.indexOf('<section id="inspector"'))).toContain('action="/api/work.create"');
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

  it("links one cached stylesheet and script, offers Sign out, and signs out to a page that needs no session", async () => {
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
    expect(html).not.toContain('<h4>Your account</h4>');
    expect(html).toContain('class="button quiet file"');
    expect(html).toContain('>Sign out</button>');
    expect(html).toContain('action="/api/session.end" data-reload><input type="hidden" name="_back" value="/signed-out">');
    const out = await SELF.fetch(`https://${HOST}/api/session.end`, { method: "POST", redirect: "manual", headers: { ...w.h, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" }, body: "_back=%2Fsigned-out" });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/signed-out");
    expect(await (await SELF.fetch(`https://${HOST}/signed-out`)).text()).toContain("re signed out");
  });
});
