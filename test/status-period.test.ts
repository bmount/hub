import { env, SELF } from "cloudflare:test";
import { projectVelocity, workedIntervals, percentile } from "../src/verbs/velocity";
import { recordEvent } from "../src/db/events";
import { usageStatement } from "../src/models/usage";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/auth/context";
import { createProject } from "../src/db/projects";
import { createNamespace } from "../src/db/namespaces";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { projectStatus, projectStatusVerb, statusText, type Status } from "../src/verbs/status";
import { apiPost, cookieHeaders, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const DAY = 86_400_000;
async function world() {
  const t = await seedTenant("acme");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const h = await seedHuman("reader@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });
  const now = Date.now(), since = now - 7 * DAY;
  const headers = cookieHeaders(h.token, HOST);
  const ctx = await buildContext(new Request(`https://${HOST}/`, { headers }), env, now);
  return { t, p, h, now, since, ctx, headers };
}
async function work(w: Awaited<ReturnType<typeof world>>, n: number, state: string, at: number) {
  await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, 'snag', ?, '', ?, ?, ?, ?, ?)")
    .bind(`w${n}`, w.t.id, w.p.id, n, `Work ${n}`, state, w.h.identity.id, at, at, state === "done" ? at : null).run();
}
async function group(w: Awaited<ReturnType<typeof world>>, id: string, first: number, last: number, count = 900) {
  await env.HUB_DB.prepare("INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, title, last_message, count, first_seen, last_seen) VALUES (?, ?, ?, 'app', ?, 'error', ?, 'detail', ?, ?, ?)")
    .bind(id, w.t.id, w.p.id, id, id, count, first, last).run();
}

describe("velocity evidence", () => {
  it("sums doing intervals without overlapping renewals, counts claims, and keeps workers", () => {
    const claim = (at: number, who = 'a') => ({ kind: 'work.claim', summary: '', created_at: at, identity_id: who });
    const update = (at: number, summary: string) => ({ kind: 'work.update', summary, created_at: at, identity_id: 'a' });
    const result = workedIntervals([
      claim(100), claim(200), update(250,'Updated p#1 (details): renamed'),
      update(300,'Updated p#1 (Under way to Open): renamed'), claim(500,'b'),
      {kind:'work.release',summary:'',created_at:700,identity_id:'b'}, claim(800),
      claim(900,'b'), update(1000,'Updated p#1 (Under way to Done): finished'), claim(2000),
    ], 1000);
    expect(result.worked_ms).toBe(600);
    expect(result.first_claimed_at).toBe(100);
    expect(result.attempts).toBe(5);
    expect(result.workers).toEqual(['a','b']);
    expect(result.intervals).toEqual([{start:100,end:300,who:'a'},{start:500,end:700,who:'b'},{start:800,end:900,who:'a'},{start:900,end:1000,who:'b'}]);
    expect(workedIntervals([],100).first_claimed_at).toBeNull();
    expect(workedIntervals([claim(10)],100).worked_ms).toBe(90);
    expect(percentile([10,20,30,40],.5)).toBe(25);
    expect(percentile([10,20,30,40],.9)).toBe(37);
    expect(percentile([],.5)).toBeNull();
  });
  it("applies the cutoff to items, commits and attributed usage in API, MCP and the view", async () => {
    const w=await world(), cutoff=w.now-3*DAY;
    await env.HUB_DB.prepare('UPDATE project SET velocity_since = ? WHERE id = ?').bind(cutoff,w.p.id).run();
    await work(w,1,'done',cutoff-1); await work(w,2,'done',cutoff); await work(w,3,'done',cutoff+1000);
    await env.HUB_DB.prepare('UPDATE work_item SET closed_at = ? WHERE id IN (?,?)').bind(cutoff+3_600_000,'w2','w3').run();
    for(const [at,kind,summary] of [[cutoff+60_000,'work.claim',''],[cutoff+120_000,'work.claim',''],[cutoff+180_000,'work.update','Updated site#2 (Under way to Done): Work 2']] as const)await recordEvent(env.HUB_DB,{tenant_id:w.t.id,identity_id:w.h.identity.id,session_id:null,kind,target_kind:'work_item',target_id:'w2',summary},at);
    for(const [id,item,project,tenant,at] of [['old','w1',w.p.id,w.t.id,cutoff+100],['good','w2',w.p.id,w.t.id,cutoff+100],['unmatched',null,w.p.id,w.t.id,cutoff+100],['pre','w2',w.p.id,w.t.id,cutoff-1],['foreign','w2',w.p.id,'foreign',cutoff+100]] as const) {
      if(tenant==='foreign')continue;
      await usageStatement(env.HUB_DB,{id,source:'reported',purpose:'coding',provider:'p',model:'m',tenant_id:tenant,identity_id:w.h.identity.id,project_id:project,work_item_id:item,ok:true,ms:0,input_tokens:100,output_tokens:10,cached_tokens:80,reported_cost_micros:1000,created_at:at}).run();
    }
    const oid='a'.repeat(40),oldOid='b'.repeat(40);
    for(const [n,sha,at] of [[1,oid,cutoff+1000],[2,oid,cutoff+1000],[2,oldOid,cutoff-1]] as const){
      await env.HUB_DB.prepare("INSERT OR IGNORE INTO code_event(tenant_id,project_id,ardi_id,kind,target,summary,at) VALUES(?,?,?,'commit',?,'Commit',?)").bind(w.t.id,w.p.id,n+(sha===oldOid?10:0),sha,at).run();
      await env.HUB_DB.prepare("INSERT INTO work_link(id,item_id,target_kind,target_ref,created_by,created_at) VALUES(?,?,'commit',?,?,?)").bind(`link${n}${sha[0]}`,`w${n}`,sha,w.h.identity.id,w.now).run();
    }
    const source=await createProject(env.HUB_DB,{tenant_id:w.t.id,namespace_id:null,slug:'source',kind:'repo',display_name:'Source'},w.now);
    const crossOid='c'.repeat(40);
    await env.HUB_DB.prepare("INSERT INTO code_event(tenant_id,project_id,ardi_id,kind,target,summary,at) VALUES(?,?,1,'commit',?,'Linked from another project',?)").bind(w.t.id,source.id,crossOid,cutoff+2000).run();
    await env.HUB_DB.prepare("INSERT INTO work_link(id,item_id,target_kind,target_ref,created_by,created_at) VALUES('cross-link','w2','commit',?,?,?)").bind(`source@${crossOid}`,w.h.identity.id,w.now).run();
    const foreignUsage=await seedTenant('usage-other');
    await usageStatement(env.HUB_DB,{id:'foreign-usage',source:'reported',purpose:'coding',provider:'p',model:'m',tenant_id:foreignUsage.id,identity_id:w.h.identity.id,project_id:w.p.id,work_item_id:'w2',ok:true,ms:0,input_tokens:99999,output_tokens:null,created_at:cutoff+100}).run();
    const v=await projectVelocity(w.ctx,'site');
    expect(v.items.map(x=>x.number)).toEqual([2,3]);
    expect(v.items[0]).toMatchObject({worked_ms:120_000,attempts:2,input_tokens:100,cached_tokens:80,output_tokens:10,cost_usd:.001});
    expect(v.items[0]!.commits).toHaveLength(2);
    expect(v.items[0]!.commits.map(c=>c.oid).sort()).toEqual([oid,crossOid]);
    expect(v.items[0]!.commits.find(c=>c.oid===crossOid)!.source_project).toBe('source');
    expect(v.total.closed).toBe(2);
    expect(v.total.cycle_ms.known).toBe(1);
    expect(v.by_day.reduce((n,d)=>n+d.worked_ms,0)).toBe(v.total.worked_ms);
    expect(v.by_week.reduce((n,d)=>n+d.input_tokens,0)).toBe(100);
    expect((await projectVelocity(w.ctx,'site',null,'2000-01-01')).since).toBe(cutoff);
    const response=await apiPost(HOST,'velocity.read',{project:'site'},w.headers);
    expect(response.status).toBe(200);
    expect((await response.json() as {result:typeof v}).result.items).toHaveLength(2);
    const page=await (await SELF.fetch(`https://${HOST}/site/velocity?work=site%232`,{headers:w.headers})).text();
    expect(page).toContain('Velocity items');expect(page).toContain('Of which cached');expect(page).not.toContain('site#1 ');
    const other=await seedTenant('other');
    const stranger=await seedHuman('stranger@example.test',{memberships:[{tenant_id:other.id,role:'reader'}]});
    expect((await apiPost('other.pimwell.test','velocity.read',{project:'site'},cookieHeaders(stranger.token,'other.pimwell.test'))).status).toBe(404);
  });
});

describe('velocity quest and calendar rollups',()=>{
  it('rolls up descendants once, excludes old children, and splits midnight intervals',async()=>{
    const w=await world(),cutoff=Math.floor((w.now-4*DAY)/DAY)*DAY;
    await env.HUB_DB.prepare('UPDATE project SET velocity_since = ? WHERE id = ?').bind(cutoff,w.p.id).run();
    for(const [n,at] of [[1,cutoff],[2,cutoff+1],[3,cutoff+2],[4,cutoff-1]] as const)await work(w,n,n===1||n===3?'open':'done',at);
    await env.HUB_DB.prepare("UPDATE work_item SET kind = 'quest' WHERE id IN ('w1','w3')").run();
    await env.HUB_DB.prepare("UPDATE work_item SET parent_id = 'w1' WHERE id IN ('w3','w4')").run();
    await env.HUB_DB.prepare("UPDATE work_item SET parent_id = 'w3', closed_at = ? WHERE id = 'w2'").bind(cutoff+DAY+60_000).run();
    await recordEvent(env.HUB_DB,{tenant_id:w.t.id,identity_id:w.h.identity.id,session_id:null,kind:'work.claim',target_kind:'work_item',target_id:'w2',summary:''},cutoff+DAY-60_000);
    const v=await projectVelocity(w.ctx,'site','site#1');
    expect(v.items.map(i=>i.number)).toEqual([2,3]);
    expect(v.total.worked_ms).toBe(120_000);
    expect(v.by_quest.find(q=>q.ref==='site#1')).toMatchObject({items:2,closed:1,worked_ms:120_000});
    expect(v.by_quest.find(q=>q.ref==='site#3')).toMatchObject({items:1,closed:1,worked_ms:120_000});
    expect(v.by_day.filter(d=>d.worked_ms).map(d=>d.worked_ms)).toEqual([60_000,60_000]);
    expect(v.by_day.reduce((n,d)=>n+d.closed,0)).toBe(1);
    await expect(projectVelocity(w.ctx,'site','site#2')).rejects.toThrow('no such eligible quest');
  });
});

describe("project status evidence navigation", () => {
  it("keeps record IDs and normalized full commit targets in API/MCP and opens safe inspector links", async () => {
    const w = await world();
    const sha = "A".repeat(40);
    await env.HUB_DB.prepare("INSERT INTO code_event (tenant_id, project_id, ardi_id, kind, target, summary, at) VALUES (?, ?, 1, 'commit', ?, '<img src=x onerror=evil()>Commit', ?)").bind(w.t.id, w.p.id, sha, w.now - 1000).run();
    await env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, seen_at) VALUES ('deploy-A', ?, ?, 'app', 'runtime', '<script>deploy</script>', ?)").bind(w.t.id, w.p.id, w.now - 1000).run();
    const gid = 'group?<x>"';
    await group(w, gid, w.now - 1000, w.now - 1000);
    const s = await projectStatus(w.ctx, "site", w.since);
    expect(s.commits.recent).toEqual([{ summary: "<img src=x onerror=evil()>Commit", at: w.now - 1000, oid: sha.toLowerCase(), href: `/site/code?c=${sha.toLowerCase()}` }]);
    expect(s.deploys[0]!.id).toBe("deploy-A");
    expect(s.errors[0]!.id).toBe(gid);
    const api = await apiPost(HOST, "project.status", { project: "site", since: new Date(w.since).toISOString() }, w.headers);
    expect((await api.json() as { result: Status }).result.commits.recent).toEqual(s.commits.recent);
    const { grant } = await seedGrant(w.t, w.h);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, w.now))!, ["read"], { now: w.now, ip: "203.0.113.1" });
    const mcp = await callTool(ctx, "project_status", { project: "site", since: new Date(w.since).toISOString() });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.structuredContent).toMatchObject({ deploys: s.deploys, errors: s.errors, commits: s.commits });
    expect(JSON.stringify(mcp.content)).toContain(`site@${sha.toLowerCase()}`);
    expect(JSON.stringify(mcp.content)).toContain("deploy-A");
    const get = async () => (await SELF.fetch(`https://${HOST}/site/status`, { headers: w.headers })).text();
    const page = await get();
    expect(page).toContain(`href="/site/code?c=${sha.toLowerCase()}"`);
    expect(page).toContain('href="/apps?d=deploy-A"');
    expect(page).toContain(`href="/apps?g=${encodeURIComponent(gid)}"`);
    expect(page).toContain("&lt;img src=x onerror=evil()&gt;Commit");
    expect(page).toContain("&lt;script&gt;deploy&lt;/script&gt;");
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain("<script>deploy");
    expect(page).toContain("zero records does not prove zero activity");
    await env.HUB_DB.prepare("UPDATE app_error_group SET title = 'Changed recorded title' WHERE id = ?").bind(gid).run();
    const refreshed = await get();
    expect(refreshed).toContain("Changed recorded title");
    expect(refreshed.match(/data-key="(status:[^"]*)"/)![1]).not.toBe(page.match(/data-key="(status:[^"]*)"/)![1]);
  });

  it("leaves missing, short and malformed targets inert and avoids code links for tracker/ambiguous histories", async () => {
    const w = await world();
    for (const [n, target] of [[1, null], [2, "a".repeat(7)], [3, "g".repeat(40)], [4, "a".repeat(40) + "\n"], [5, "b".repeat(40)]] as const) await env.HUB_DB.prepare("INSERT INTO code_event (tenant_id, project_id, ardi_id, kind, target, summary, at) VALUES (?, ?, ?, 'commit', ?, ?, ?)").bind(w.t.id, w.p.id, n, target, `Recorded ${n}`, w.now - 1000).run();
    const read = () => projectStatus(w.ctx, "site", w.since);
    const s = await read();
    expect(s.commits.recent.map(c => c.oid)).toEqual(["b".repeat(40), null, null, null, null]);
    expect(s.commits.recent.filter(c => c.href)).toHaveLength(1);
    const page = await (await SELF.fetch(`https://${HOST}/site/status`, { headers: w.headers })).text();
    expect(page).toContain(`href="/site/code?c=${"b".repeat(40)}"`);
    expect(page).not.toContain(`href="/site/code?c=${"a".repeat(7)}"`);
    await env.HUB_DB.prepare("UPDATE project SET kind = 'tracker' WHERE id = ?").bind(w.p.id).run();
    expect((await read()).commits.recent.every(c => c.href === null)).toBe(true);
    expect(statusText(await read())).toContain("no supported code link");
    await env.HUB_DB.prepare("UPDATE project SET kind = 'repo', state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect((await read()).commits.recent[0]!.href).not.toBeNull();
    const ns = await createNamespace(env.HUB_DB, { tenant_id: w.t.id, slug: "team", display_name: "Team" }, w.now);
    const other = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: ns.id, slug: "site", kind: "repo", display_name: "Other" }, w.now);
    for (const state of ["active", "archived"]) {
      await env.HUB_DB.prepare("UPDATE project SET state = ? WHERE id = ?").bind(state, other.id).run();
      expect((await read()).commits.recent.every(c => c.href === null)).toBe(true);
    }
  });
});

describe("truthful project period status", () => {
  it("counts independently of 50/20/10 caps, discloses smaller MCP caps and renders totals in browser", async () => {
    const w = await world();
    for (let n = 1; n <= 55; n++) { await work(w, n, "done", w.now - 1000); await work(w, n + 55, "doing", w.now - 1000); }
    const stmts = [];
    for (let n = 1; n <= 23; n++) {
      stmts.push(env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, seen_at) VALUES (?, ?, ?, 'app', ?, ?, ?)").bind(`d${n}`, w.t.id, w.p.id, `v${n}`, `tag${n}`, w.now - 1000));
      stmts.push(env.HUB_DB.prepare("INSERT INTO review (id, tenant_id, project_id, number, branch, base, title, status, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'feature', 'main', ?, 'open', ?, ?, ?)").bind(`r${n}`, w.t.id, w.p.id, n, `Review ${n}`, w.h.identity.id, w.since - DAY, w.now - 1000));
      stmts.push(env.HUB_DB.prepare("INSERT INTO code_event (tenant_id, project_id, ardi_id, kind, identity_id, summary, at) VALUES (?, ?, ?, 'commit', ?, ?, ?)").bind(w.t.id, w.p.id, n, w.h.identity.id, `Commit ${n}`, w.now - 1000));
    }
    await env.HUB_DB.batch(stmts);
    for (let n = 1; n <= 23; n++) await group(w, `g${n}`, w.since - DAY, w.now - 1000);
    const s = await projectStatus(w.ctx, "site", w.since);
    expect(s.totals).toEqual({ filed: 110, finished: 55, doing: 55, deploys: 23, errors: 23, reviews: 23, error_occurrences: null });
    expect(s.examples).toEqual({
      filed: { shown: 50, limit: 50, truncated: true }, finished: { shown: 50, limit: 50, truncated: true }, doing: { shown: 50, limit: 50, truncated: true },
      deploys: { shown: 20, limit: 20, truncated: true }, errors: { shown: 20, limit: 20, truncated: true }, reviews: { shown: 20, limit: 20, truncated: true }, commits: { shown: 10, limit: 10, truncated: true },
    });
    expect(s.commits).toMatchObject({ count: 23, by: [{ who: "reader", n: 23 }] });
    expect(s.errors.every((g) => g.period_count === null && g.period_samples === 0 && g.lifetime_count === 900)).toBe(true);
    const text = statusText(s);
    expect(text).toContain("Filed: 110. Showing 8 of 110 recorded examples; truncated.");
    expect(text).toContain("Deploys: 23. Showing 5 of 23 recorded examples; truncated.");
    expect(text).toContain("including recurring): 23. Showing 5 of 23");
    expect(text).not.toContain("New error groups");
    const rendered = projectStatusVerb.mcp!.render!(s);
    expect(rendered).toContain("period are unavailable");
    const api = await apiPost(HOST, "project.status", { project: "site", since: new Date(w.since).toISOString() }, w.headers);
    expect(api.status).toBe(200);
    expect((await api.json() as { result: Status }).result.totals).toEqual(s.totals);
    const html = await (await SELF.fetch(`https://${HOST}/site/status`, { headers: w.headers })).text();
    expect(html).toContain('Filed <span class="wb-count">110</span>');
    expect(html).toContain("Showing 50 of 110 recorded examples; truncated.");
    expect(html).toContain("Showing 20 of 23 recorded examples; truncated.");
    expect(html).toContain("900 lifetime occurrences");
    expect(html).not.toContain("×900");
  });

  it("includes recurring groups, separates retained period samples from unknown occurrences and lifetime counts", async () => {
    const w = await world();
    await group(w, "old-recurring", w.since - DAY, w.now - 1, 10000);
    await group(w, "old-quiet", w.since - DAY, w.since - 1);
    await group(w, "new", w.since, w.now, 2);
    await group(w, "future", w.now + 1, w.now + 1);
    for (const [id, gid, at] of [["e1", "old-recurring", w.since], ["e2", "old-recurring", w.now], ["e3", "old-recurring", w.since - 1], ["e4", "old-recurring", w.now + 1]] as const) {
      await env.HUB_DB.prepare("INSERT INTO app_event (id, tenant_id, group_id, at, detail) VALUES (?, ?, ?, ?, 'sample')").bind(id, w.t.id, gid, at).run();
    }
    const s = await projectStatus(w.ctx, "site", w.since);
    expect(s.totals.errors).toBe(2);
    expect(s.errors).toEqual([
      { id: "new", script: "app", first_version: null, first_deploy: null, first_commit: null, title: "new", lifetime_count: 2, period_count: null, period_samples: 0, first_seen: w.since, last_seen: w.now },
      { id: "old-recurring", script: "app", first_version: null, first_deploy: null, first_commit: null, title: "old-recurring", lifetime_count: 10000, period_count: null, period_samples: 2, first_seen: w.since - DAY, last_seen: w.now - 1 },
    ]);
    expect(statusText(s)).toContain("2 retained period samples; 10000 lifetime occurrences");
    expect(s.examples.errors.truncated).toBe(false);
  });

  it("uses inclusive period boundaries, excludes future/old records and counts only admitted mail", async () => {
    const w = await world();
    for (const [n, at] of [[1, w.since], [2, w.now], [3, w.since - 1], [4, w.now + 1]] as const) await work(w, n, "done", at);
    for (const [id, at, verdict] of [["m1", w.since, "admitted"], ["m2", w.now, "admitted"], ["m3", w.now, "quarantined"], ["m4", w.since - 1, "admitted"], ["m5", w.now + 1, "admitted"]] as const) {
      await env.HUB_DB.prepare("INSERT INTO inbound_mail (id, tenant_id, project_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded) VALUES (?, ?, ?, ?, 'reader@example.com', 'acme.site@pimwell.test', '', ?, 1, ?, '', '[]', 0)").bind(id, w.t.id, w.p.id, w.h.identity.id, at, verdict).run();
    }
    for (const [id, at] of [["c1", w.since], ["c2", w.now], ["c3", w.since - 1], ["c4", w.now + 1]] as const) await env.HUB_DB.prepare("INSERT INTO work_comment (id, tenant_id, item_id, author_id, body, created_at) VALUES (?, ?, 'w1', ?, '', ?)").bind(id, w.t.id, w.h.identity.id, at).run();
    const s = await projectStatus(w.ctx, "site", w.since);
    expect(s.totals).toMatchObject({ filed: 2, finished: 2 });
    expect(s.filed.map((x) => x.ref)).toEqual(["site#2", "site#1"]);
    expect(s.mail).toBe(2); expect(s.comments).toBe(2);
    expect(s.as_of).toBe(w.now);
    expect(s.examples.filed).toEqual({ shown: 2, limit: 50, truncated: false });
  });

  it("discloses no observations, stale/unseen/disabled sources and latest recorded commit without health claims", async () => {
    const w = await world();
    const empty = await projectStatus(w.ctx, "site", w.since);
    expect(empty.coverage.telemetry).toEqual({ registered_sources: 0, active_sources: 0, active_never_received: 0, active_received_in_period: 0, oldest_active_last_received_at: null, latest_active_last_received_at: null });
    expect(empty.coverage.latest_recorded_commit_at).toBeNull();
    expect(empty.coverage.git_sync).toMatchObject({ phase: "unknown", lag_ms: null, observed_at: null });
    expect(statusText(empty)).toContain("zero records does not prove zero activity or healthy operation");
    for (const [name, state, at] of [["stale", "active", w.since - DAY], ["fresh", "active", w.now], ["unseen", "active", null], ["disabled", "disabled", w.now], ["pending", "pending", null]] as const) {
      await env.HUB_DB.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(name, w.t.id, w.p.id, name, state, w.since - 2 * DAY, at).run();
    }
    await env.HUB_DB.prepare("INSERT INTO code_event (tenant_id, project_id, ardi_id, kind, summary, at) VALUES (?, ?, 1, 'commit', 'old commit', ?)").bind(w.t.id, w.p.id, w.since - DAY).run();
    await env.HUB_DB.prepare("INSERT INTO code_sync (tenant_id, project_id, cursor, last_run_at) VALUES (?, ?, ?, ?)").bind(w.t.id, w.p.id, JSON.stringify({ version: 1, after: 100, cutoff: 250, phase: "backfill", head: 250, head_at: w.now, imported_at: w.now - 5000, observed_at: w.now, caught_up_at: null }), w.now).run();
    const s = await projectStatus(w.ctx, "site", w.since);
    expect(s.coverage.git_sync).toMatchObject({ phase: "backfill", lag_ms: 5000, pending_id_span: 150 });
    expect(statusText(s)).toContain("observed event-time lag 5000ms");
    expect(s.commits.count).toBe(0);
    expect(s.coverage).toMatchObject({ telemetry: { registered_sources: 5, active_sources: 3, active_never_received: 1, active_received_in_period: 1, oldest_active_last_received_at: w.since - DAY, latest_active_last_received_at: w.now }, latest_recorded_commit_at: w.since - DAY });
    const html = await (await SELF.fetch(`https://${HOST}/site/status`, { headers: w.headers })).text();
    expect(html).toContain("Filed: none");
    expect(html).toContain("Telemetry last-received times do not prove continuous coverage");
    expect(html).toContain("1 active never received");
    expect(html).toContain("Git sync: backfill");
    expect(html).toContain("not an event count or continuous freshness guarantee");
  });

  it("keeps same-slug projects and malformed cross-tenant rows out of counts, samples and freshness", async () => {
    const w = await world();
    const other = await seedTenant("other");
    const p2 = await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Other" }, w.now);
    // Malformed tenant/project combinations must not become a side channel through aggregates.
    await env.HUB_DB.prepare("INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, title, last_message, count, first_seen, last_seen) VALUES ('foreign', ?, ?, 'foreign', 'foreign', 'error', 'FOREIGN SECRET', '', 9, ?, ?)").bind(other.id, w.p.id, w.now, w.now).run();
    await env.HUB_DB.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at, last_event_at) VALUES ('foreign', ?, ?, 'foreign', 'active', ?, ?)").bind(other.id, w.p.id, w.now, w.now).run();
    await group(w, "mine", w.now, w.now, 1);
    await env.HUB_DB.prepare("INSERT INTO app_event (id, tenant_id, group_id, at, detail) VALUES ('foreign', ?, 'mine', ?, 'FOREIGN SECRET')").bind(other.id, w.now).run();
    await env.HUB_DB.prepare("INSERT INTO code_event (tenant_id, project_id, ardi_id, kind, summary, at) VALUES (?, ?, 1, 'commit', 'FOREIGN SECRET', ?)").bind(other.id, p2.id, w.now).run();
    await work(w, 1, "done", w.now);
    await env.HUB_DB.prepare("INSERT INTO work_comment (id, tenant_id, item_id, author_id, body, created_at) VALUES ('foreign', ?, 'w1', ?, 'FOREIGN SECRET', ?)").bind(other.id, w.h.identity.id, w.now).run();
    await env.HUB_DB.prepare("INSERT INTO code_sync (tenant_id, project_id, cursor, last_error) VALUES (?, ?, '100', 'FOREIGN SECRET')").bind(other.id, w.p.id).run();
    const s = await projectStatus(w.ctx, "site", w.since);
    expect(s.coverage.git_sync).toMatchObject({ phase: "unknown", last_error: null });
    expect(s.totals.errors).toBe(1); expect(s.errors[0]!.period_samples).toBe(0);
    expect(s.comments).toBe(0); expect(s.commits.count).toBe(0);
    expect(s.coverage.telemetry.registered_sources).toBe(0);
    expect(JSON.stringify(s)).not.toContain("FOREIGN SECRET");
    const noMember = await seedHuman("outsider@example.com");
    expect((await apiPost(HOST, "project.status", { project: "site" }, cookieHeaders(noMember.token, HOST))).status).not.toBe(200);
    expect((await SELF.fetch(`https://${HOST}/site/status`)).status).toBe(404);
  });
});
