import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";
import { createProject } from "../src/db/projects";

const cookie = (token: string) => ({ cookie: `pmw_session=${token}` });

describe("pages", () => {
  it("apex anonymous and signed-in", async () => {
    const anon = await SELF.fetch("https://pimwell.test/");
    expect(anon.status).toBe(200);
    const landing = await anon.text();
    expect(landing).toContain("invite link");
    const signIn = '<nav class="landing-auth" aria-label="Account"><a class="landing-sign-in" href="/login">Sign in</a></nav>';
    expect(landing).toContain(signIn);
    expect(landing.indexOf(signIn)).toBeLessThan(landing.indexOf('<section class="street"'));
    expect(landing).toContain(".landing-auth{position:fixed;");
    expect(landing).toContain("min-height:44px");
    expect(landing).toContain(".landing-sign-in:focus-visible");
    // The note for AI agents sits beside the Sign in button, in the opposite corner.
    expect(landing).toContain('<a href="/setup">AI agent? Start at pimwell.com/setup</a>');
    expect(landing.indexOf('id="for-agents"')).toBeLessThan(landing.indexOf('<section class="street"'));
    expect(landing).toContain(".agentnote{position:fixed;left:12px;bottom:12px;");
    expect((await SELF.fetch("https://pimwell.test/login")).status).toBe(200);
    const t = await seedTenant("acme");
    await seedTenant("blue");
    const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const html = await (await SELF.fetch("https://pimwell.test/", { headers: cookie(h.token) })).text();
    expect(html).toContain("https://acme.pimwell.test/");
    expect(html).not.toContain("https://blue.pimwell.test/");
    expect(html).toContain("/me/sessions");
    const root = await seedHuman("r@example.com", { is_root: true });
    const rootHtml = await (await SELF.fetch("https://pimwell.test/", { headers: cookie(root.token) })).text();
    expect(rootHtml).toContain("https://blue.pimwell.test/");
  });

  it("tenant home requires membership and shows projects", async () => {
    const t = await seedTenant("acme");
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const stranger = await seedHuman("s@example.com");
    await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(member.token));
    expect((await SELF.fetch("https://acme.pimwell.test/")).status).toBe(404);
    expect((await SELF.fetch("https://acme.pimwell.test/", { headers: cookie(stranger.token) })).status).toBe(404);
    const html = await (await SELF.fetch("https://acme.pimwell.test/", { headers: cookie(member.token) })).text();
    expect(html).toContain("ACME");
    expect(html).toContain("member");
    expect(html).toContain("site");
    expect(html).toContain('href="/archive"');
  });

  it("renders compact, kind-specific contents and URL-selected actions without bypassing roles", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", {memberships:[{tenant_id:t.id,role:"admin"}]});
    const reader = await seedHuman("r@example.com", {memberships:[{tenant_id:t.id,role:"reader"}]});
    const headers = cookieHeaders(admin.token,"acme.pimwell.test");
    const call = async (verb: string, input: unknown) => {
      const response = await apiPost("acme.pimwell.test",verb,input,headers);
      expect(response.status,await response.clone().text()).toBe(200);
      return (await response.json() as {result: Record<string, unknown>}).result;
    };
    await call("project.create",{slug:"docs",kind:"workspace",display_name:"Docs <unsafe>"});
    await call("wiki.write",{project:"docs",slug:"guide",title:"Guide",body:"One",expected_revision:0,note:"First"});
    await call("wiki.write",{project:"docs",slug:"guide",title:"Guide",body:"Two",expected_revision:1,note:"Second"});
    await call("wiki.write",{project:"docs",slug:"deleted",title:"Gone",body:"",expected_revision:0,note:"First"});
    await call("wiki.delete",{project:"docs",slug:"deleted",expected_revision:1,note:"Remove"});
    await call("research.save",{project:"docs",slug:"finding",topic:"Research finding",summary:"Evidence",sources:[],status:"draft",expected_revision:0,note:"First"});
    await call("file.put",{project:"docs",path:"note.txt",content_type:"text/plain",base64:"bm90ZQ==",expected_revision:0});
    await call("file.put",{project:"docs",path:"note.txt",content_type:"text/plain",base64:"bm90ZQ==",expected_revision:1});
    await call("person.upsert",{project:"docs",name:"Contact <unsafe>"});
    await call("work.create",{project:"docs",kind:"wish",title:"Open wish"});
    const fetchPage = (path: string, token = admin.token) => SELF.fetch(`https://acme.pimwell.test${path}`,{headers:cookie(token)});
    const response = await fetchPage("/docs");
    expect(response.status).toBe(200);
    const html = await response.text();
    const list = html.split('<section id="list"')[1]!.split('<div class="wb-resizer"')[0]!;
    expect(list).not.toMatch(/class="(?:card|grid|onramp)"/);
    const row = (key: string) => list.match(new RegExp('data-href="/docs\\?resource='+key+'"[^>]*>([\\s\\S]*?)</tr>'))![1]!;
    for (const key of ["wish","wiki","research","files","contacts"]) expect(row(key)).toContain("<td>1</td>");
    expect(row("channels")).toContain("<td>2</td>");
    expect(list).toContain("Docs &lt;unsafe&gt;");
    for (const [key, verb] of [["new-page","wiki.write"],["add-contact","person.upsert"]]) {
      const action = await fetchPage("/docs?resource="+key);
      expect(action.status).toBe(200);
      expect(await action.text()).toContain('action="/api/'+verb+'"');
      expect((await fetchPage("/docs?resource="+key,reader.token)).status).toBe(404);
    }
    const upload = await (await fetchPage("/docs?resource=upload")).text();
    expect(upload).toContain('data-reload enctype="multipart/form-data"');
    const research = await (await fetchPage("/docs?resource=research")).text();
    expect(research).toContain("Research finding");
    expect(research).toContain('data-key="overview:docs"');
    const contacts = await (await fetchPage("/docs?resource=contacts")).text();
    expect(contacts).toContain("Contact &lt;unsafe&gt;");
    expect((await fetchPage("/docs?resource=reviews")).status).toBe(404);
    expect((await fetchPage("/docs?resource=unknown")).status).toBe(404);
    const readerHtml = await (await fetchPage("/docs",reader.token)).text();
    expect(readerHtml).not.toContain('action="/api/project.archive"');
    expect(readerHtml).not.toContain('href="/docs?resource=new-page"');
    const agent = await seedAgent(t,admin.identity);
    const agentHtml = await (await SELF.fetch("https://acme.pimwell.test/docs",{headers:bearer(agent.token)})).text();
    // Agent channel discovery remains membership-only, even on an overview.
    expect(agentHtml).not.toContain('href="/c/docs-team"');
    await call("project.archive",{slug:"docs"});
    expect((await fetchPage("/docs?resource=upload")).status).toBe(404);
    expect(await (await fetchPage("/docs")).text()).toContain("Archived");
  });

  it("keeps Home needs counts personal and namespace-aware, and opens projects and work in place", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("m@example.com",{memberships:[{tenant_id:t.id,role:"admin"}]});
    const other = await seedHuman("o@example.com",{memberships:[{tenant_id:t.id,role:"member"}]});
    await env.HUB_DB.prepare("INSERT INTO namespace (id,tenant_id,slug,display_name,state,created_at) VALUES ('N',?,'team','Team','active',0)").bind(t.id).run();
    await createProject(env.HUB_DB,{tenant_id:t.id,namespace_id:"N",slug:"docs",display_name:"Namespaced docs",kind:"workspace"},Date.now());
    await createProject(env.HUB_DB,{tenant_id:t.id,namespace_id:null,slug:"docs",display_name:"Plain docs",kind:"wiki"},Date.now());
    const foreign = await seedTenant("foreign");
    await createProject(env.HUB_DB,{tenant_id:foreign.id,namespace_id:null,slug:"secret",display_name:"Foreign secret",kind:"tracker"},Date.now());
    const headers = cookieHeaders(h.token,"acme.pimwell.test");
    const created = await apiPost("acme.pimwell.test","work.create",{project:"team/docs",kind:"errand",title:"Home work"},headers);
    expect(created.status).toBe(200);
    const w = (await created.json() as {result:{item:{id:string;number:number}}}).result.item;
    for (const [id,who,done] of [["mine",h.identity.id,null],["other",other.identity.id,null],["done",h.identity.id,1]] as const)
      await env.HUB_DB.prepare("INSERT INTO attention (id,tenant_id,identity_id,reason,item_id,summary,created_at,done_at) VALUES (?,?,?,'comment',?,?,?,?)").bind(id,t.id,who,w.id,id,Date.now(),done).run();
    await env.HUB_DB.prepare("INSERT INTO attention (id,tenant_id,identity_id,reason,href,summary,created_at) VALUES ('review',?,?,'assigned','/team/docs/reviews/1','Review yours',?)").bind(t.id,h.identity.id,Date.now()).run();
    const home = await (await SELF.fetch("https://acme.pimwell.test/",{headers})).text();
    expect(home).not.toContain("Foreign secret");
    expect(home).toContain('href="/?project=team%2Fdocs"');
    expect(home).toContain('href="/?work=team%2Fdocs%23'+w.number+'"');
    const projectRow = home.match(/data-href="\/\?project=team%2Fdocs"[^>]*>([\s\S]*?)<\/tr>/)![1]!;
    expect(projectRow).toContain("<td>1</td><td>2</td>");
    expect(home).not.toMatch(/class="(?:card|grid|onramp)"/);
    const selected = await (await SELF.fetch("https://acme.pimwell.test/?project=team%2Fdocs",{headers})).text();
    expect(selected).toMatch(/data-key="home:[^"]*docs:/);
    expect(selected).toContain('data-key="home:team/docs"');
    expect(selected).toContain("acme.team.docs@pimwell.test");
    expect(selected).toContain("/p/team/docs/mcp");
    expect(selected).toContain('name="namespace" value="team"');
    expect(selected).toContain('name="slug" value="docs"');
    const work = await SELF.fetch("https://acme.pimwell.test/?work=team%2Fdocs%23"+w.number,{headers});
    expect(work.status).toBe(200);
    expect(await work.text()).toContain("Home work");
    expect(await env.HUB_DB.prepare("SELECT done_at FROM attention WHERE id = 'mine'").first("done_at")).not.toBeNull();
    expect(await env.HUB_DB.prepare("SELECT done_at FROM attention WHERE id = 'other'").first("done_at")).toBeNull();
    expect((await SELF.fetch("https://acme.pimwell.test/?project=secret",{headers})).status).toBe(404);
    expect((await SELF.fetch("https://acme.pimwell.test/?work=secret%231",{headers})).status).toBe(404);
  });

  it("archive page lists archived projects only", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await apiPost("acme.pimwell.test", "project.create", { slug: "old", kind: "repo", display_name: "Old" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "new", kind: "repo", display_name: "New" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.archive", { slug: "old" }, bearer(admin.token));
    const html = await (await SELF.fetch("https://acme.pimwell.test/archive", { headers: cookie(admin.token) })).text();
    expect(html).toContain("old");
    expect(html).not.toContain(">new<");
  });

  it("unknown hosts and paths are 404", async () => {
    expect((await SELF.fetch("https://zzz.pimwell.test/")).status).toBe(404);
    expect((await SELF.fetch("https://evil.example/")).status).toBe(404);
    expect((await SELF.fetch("https://pimwell.test/nope")).status).toBe(404);
  });

  it("clears a stale cookie on page responses and not otherwise", async () => {
    const stale = { cookie: "pmw_session=pms_stale" };
    const r1 = await SELF.fetch("https://pimwell.test/me/sessions", { headers: stale });
    expect(r1.status).toBe(401);
    expect(r1.headers.get("set-cookie")).toContain("Max-Age=0");
    const t = await seedTenant("acme");
    const r2 = await SELF.fetch("https://acme.pimwell.test/", { headers: stale });
    expect(r2.status).toBe(404);
    expect(r2.headers.get("set-cookie")).toContain("Max-Age=0");
    const m = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const r3 = await SELF.fetch("https://acme.pimwell.test/archive", { headers: cookie(m.token) });
    expect(r3.status).toBe(200);
    expect(r3.headers.get("set-cookie")).toBeNull();
  });
});
