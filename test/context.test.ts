import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { createWork } from "../src/db/work";
import { sha256Hex } from "../src/ids";
import { buildContext, rank, roleFor } from "../src/auth/context";
import { createTenant, setTenantState } from "../src/db/tenants";
import { createIdentity } from "../src/db/identities";
import { addMembership } from "../src/db/memberships";
import { createBrowserSession, revokeSession } from "../src/db/sessions";
import { COOKIE_NAME } from "../src/auth/cookie";

const db = () => env.HUB_DB;
const now = 1_700_000_000_000;

async function seed() {
  const tenant = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
  const identity = await createIdentity(db(), { kind: "human", email: "a@example.com", display_name: "A", is_root: 0, operator_id: null }, now);
  await addMembership(db(), { identity_id: identity.id, tenant_id: tenant.id, role: "admin" }, now);
  const { session, token } = await createBrowserSession(db(), identity.id, now);
  return { tenant, identity, session, token };
}

describe("buildContext", () => {
  it("resolves tenant, identity and role from a cookie", async () => {
    const s = await seed();
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.host).toEqual({ kind: "tenant", slug: "acme" });
    expect(ctx.tenant?.id).toBe(s.tenant.id);
    expect(ctx.identity?.id).toBe(s.identity.id);
    expect(ctx.role).toBe("admin");
    expect(ctx.authKind).toBe("cookie");
    expect(ctx.staleCookie).toBe(false);
  });

  it("prefers a bearer session token and reports no role off-tenant", async () => {
    const s = await seed();
    const req = new Request("https://pimwell.test/", { headers: { authorization: `Bearer ${s.token}`, cookie: `${COOKIE_NAME}=pms_stale` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.authKind).toBe("bearer");
    expect(ctx.identity?.id).toBe(s.identity.id);
    expect(ctx.tenant).toBeNull();
    expect(ctx.role).toBeNull();
  });

  it("treats a revoked session cookie as anonymous and flags it stale", async () => {
    const s = await seed();
    await revokeSession(db(), s.session.id, now + 1);
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 2);
    expect(ctx.identity).toBeNull();
    expect(ctx.staleCookie).toBe(true);
  });

  it("archived tenant resolves to no tenant", async () => {
    const s = await seed();
    await setTenantState(db(), s.tenant.id, "archived", now + 1);
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 2);
    expect(ctx.tenant).toBeNull();
    expect(ctx.role).toBeNull();
  });

  it("root gets role root on any tenant without a membership", async () => {
    const tenant = await createTenant(db(), { slug: "blue", display_name: "Blue" }, now);
    const root = await createIdentity(db(), { kind: "human", email: "r@example.com", display_name: "R", is_root: 1, operator_id: null }, now);
    const { token } = await createBrowserSession(db(), root.id, now);
    const req = new Request("https://blue.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.tenant?.id).toBe(tenant.id);
    expect(ctx.role).toBe("root");
  });
});

describe("request-local rail aggregation", () => {
  const request = (token: string, host = "acme") => new Request(`https://${host}.pimwell.test/`, { headers: { cookie: `${COOKIE_NAME}=${token}` } });
  const project = (tenant: string, slug: string, name = slug) => createProject(db(), { tenant_id: tenant, namespace_id: null, slug, kind: "repo", display_name: name }, now);
  async function world() {
    const s = await seed(), p = await project(s.tenant.id, "site");
    const read = () => buildContext(request(s.token), env, now + 1);
    const work = (project_id = p.id, tenant_id = s.tenant.id, owner_id: string | null = s.identity.id) => createWork(db(), { tenant_id, project_id, kind: "snag", title: "Work", body: "", created_by: s.identity.id, owner_id }, now);
    return { ...s, p, read, work };
  }

  it("returns exact empty counts and keeps totals independent of the project cap", async () => {
    const w = await world();
    expect((await w.read()).rail).toEqual({ projects: [{ slug: "site", display_name: "site", open: 0 }], open: 0, mine: 0, held: 0, needs: 0 });
    for (let i = 0; i < 65; i++) {
      const p = await project(w.tenant.id, `p${String(i).padStart(2, "0")}`);
      await w.work(p.id);
    }
    const rail = (await w.read()).rail!;
    expect(rail.projects).toHaveLength(60);
    expect(rail.projects.map(p => p.slug)).toEqual(Array.from({ length: 60 }, (_, i) => `p${String(i).padStart(2, "0")}`));
    expect(rail.projects.every(p => p.open === 1)).toBe(true);
    expect(rail.open).toBe(65); expect(rail.mine).toBe(65);
  });

  it("isolates project/work tenants and own counts while retaining channel/archived work in organization totals", async () => {
    const w = await world(), other = await createTenant(db(), { slug: "other", display_name: "SECRET" }, now);
    const foreign = await project(other.id, "secret", "SECRET");
    const second = await createIdentity(db(), { kind: "human", email: "b@example.com", display_name: "B", is_root: 0, operator_id: null }, now);
    await addMembership(db(), { identity_id: second.id, tenant_id: w.tenant.id, role: "reader" }, now);
    const { token } = await createBrowserSession(db(), second.id, now);
    await w.work(); await w.work(w.p.id, w.tenant.id, second.id);
    await w.work(foreign.id, other.id);
    await w.work(w.p.id, other.id); // malformed: foreign work on our project
    await w.work(foreign.id); // malformed: our work on a foreign project
    const archived = await project(w.tenant.id, "old");
    await db().prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(archived.id).run();
    await w.work(archived.id);
    await db().prepare("INSERT INTO project (id, tenant_id, slug, kind, display_name, state, created_at) VALUES ('room', ?, 'general', 'channel', 'General', 'active', ?)").bind(w.tenant.id, now).run();
    await w.work("room");
    for (const [id, tenant, who, done] of [["own", w.tenant.id, w.identity.id, null], ["seen", w.tenant.id, w.identity.id, now], ["second", w.tenant.id, second.id, null], ["foreign", other.id, w.identity.id, null]] as const) {
      await db().prepare("INSERT INTO attention (id, tenant_id, identity_id, reason, summary, created_at, done_at) VALUES (?, ?, ?, 'assigned', '', ?, ?)").bind(id, tenant, who, now, done).run();
    }
    for (const [id, tenant, verdict, released] of [["held", w.tenant.id, "quarantined", null], ["released", w.tenant.id, "quarantined", now], ["admitted", w.tenant.id, "admitted", null], ["foreign-held", other.id, "quarantined", null]] as const) {
      await db().prepare(`INSERT INTO inbound_mail (id, tenant_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded, released_at)
        VALUES (?, ?, ?, 'a@example.com', 'acme@pimwell.test', '', ?, 1, ?, '', '[]', 0, ?)`).bind(id, tenant, w.identity.id, now, verdict, released).run();
    }
    expect((await w.read()).rail).toEqual({ projects: [{ slug: "site", display_name: "site", open: 2 }], open: 4, mine: 3, held: 1, needs: 1 });
    expect((await buildContext(request(token), env, now + 1)).rail).toEqual({ projects: [{ slug: "site", display_name: "site", open: 2 }], open: 4, mine: 1, held: 1, needs: 1 });
  });

  it("reflects state, owner, project, mail and attention changes on the next read", async () => {
    const w = await world(), item = await w.work();
    const counts = async () => { const r = (await w.read()).rail!; return [r.open, r.mine, r.projects.map(p => [p.slug, p.open])]; };
    expect(await counts()).toEqual([1, 1, [["site", 1]]]);
    for (const state of ["doing", "done", "open", "dropped"]) {
      await db().prepare("UPDATE work_item SET state = ? WHERE id = ?").bind(state, item.id).run();
      const n = state === "doing" || state === "open" ? 1 : 0;
      expect(await counts()).toEqual([n, n, [["site", n]]]);
    }
    await db().prepare("UPDATE work_item SET state = 'open', owner_id = NULL WHERE id = ?").bind(item.id).run();
    expect(await counts()).toEqual([1, 0, [["site", 1]]]);
    const next = await project(w.tenant.id, "next");
    await db().prepare("UPDATE work_item SET project_id = ? WHERE id = ?").bind(next.id, item.id).run();
    await db().prepare("UPDATE project SET slug = 'renamed', display_name = 'Renamed', state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect(await counts()).toEqual([1, 0, [["next", 1]]]);
    await db().prepare("UPDATE project SET state = 'active' WHERE id = ?").bind(w.p.id).run();
    expect(await counts()).toEqual([1, 0, [["renamed", 0], ["next", 1]]]);
    await db().prepare("INSERT INTO attention (id, tenant_id, identity_id, reason, summary, created_at) VALUES ('new', ?, ?, 'assigned', '', ?)").bind(w.tenant.id, w.identity.id, now).run();
    expect((await w.read()).rail!.needs).toBe(1);
    await db().prepare("UPDATE attention SET done_at = ? WHERE id = 'new'").bind(now).run();
    expect((await w.read()).rail!.needs).toBe(0);
    await db().prepare(`INSERT INTO inbound_mail (id, tenant_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded)
      VALUES ('new', ?, ?, 'a@example.com', 'acme@pimwell.test', '', ?, 1, 'quarantined', '', '[]', 0)`).bind(w.tenant.id, w.identity.id, now).run();
    expect((await w.read()).rail!.held).toBe(1);
    await db().prepare("UPDATE inbound_mail SET released_at = ? WHERE id = 'new'").bind(now).run();
    expect((await w.read()).rail!.held).toBe(0);
  });

  it.each(["revoked", "expired", "identity", "membership", "tenant", "nonmember", "bearer", "post", "anonymous"])("never attaches rail data after %s authentication/access changes", async (change) => {
    const w = await world(); await w.work();
    expect((await w.read()).rail?.open).toBe(1);
    let req = request(w.token);
    if (change === "revoked") await revokeSession(db(), w.session.id, now);
    if (change === "expired") await db().prepare("UPDATE session SET expires_at = ? WHERE id = ?").bind(now, w.session.id).run();
    if (change === "identity") await db().prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(w.identity.id).run();
    if (change === "membership") await db().prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(w.identity.id, w.tenant.id).run();
    if (change === "tenant") await setTenantState(db(), w.tenant.id, "archived", now);
    if (change === "nonmember") { await createTenant(db(), { slug: "other", display_name: "Other" }, now); req = request(w.token, "other"); }
    if (change === "bearer") req = new Request(req, { headers: { authorization: `Bearer ${w.token}` } });
    if (change === "post") req = new Request(req, { method: "POST" });
    if (change === "anonymous") req = new Request(req.url);
    expect((await buildContext(req, env, now + 1)).rail).toBeUndefined();
  });

  it.each([1, 80])("materializes one aggregate for a large tenant with %s projects and reduces actual D1 read work", async (projects) => {
    const w = await world();
    for (let i = 1; i < projects; i++) await project(w.tenant.id, `p${i}`);
    const rows = await db().prepare("SELECT id FROM project WHERE tenant_id = ? ORDER BY id").bind(w.tenant.id).all<{ id: string }>();
    for (const [i, p] of rows.results.entries()) {
      await db().prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, owner_id, created_by, created_at, updated_at)
        SELECT ? || x, ?, ?, x, 'snag', '', '', CASE WHEN x%2 = 0 THEN 'doing' ELSE 'open' END,
          CASE WHEN x%2 = 0 THEN ? ELSE NULL END, ?, ?, ? FROM n`)
        .bind(8000 / projects, `w${i}-`, w.tenant.id, p.id, w.identity.id, w.identity.id, now, now).run();
    }
    let sql = "", args: unknown[] = [], meta: D1Meta | undefined, statements = 0;
    const measuredDb = new Proxy(db(), { get(target, key) {
      if (key === "prepare") return (query: string) => {
        const s = target.prepare(query);
        if (!query.includes("work_counts")) return s;
        sql = query;
        return new Proxy(s, { get(bound, name) {
          if (name === "bind") return (...values: unknown[]) => { args = values; return bound.bind(...values); };
          const v = Reflect.get(bound, name); return typeof v === "function" ? v.bind(bound) : v;
        } });
      };
      if (key === "batch") return async (batch: D1PreparedStatement[]) => { statements = batch.length; const r = await target.batch(batch); meta = r[4]!.meta; return r; };
      const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
    } });
    const rail = (await buildContext(request(w.token), { ...env, HUB_DB: measuredDb }, now + 1)).rail!;
    expect(statements).toBe(5); expect(rail.open).toBe(8000); expect(rail.mine).toBe(4000);
    const plan = await db().prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>();
    expect(plan.results.some(r => r.detail.includes("MATERIALIZE work_counts"))).toBe(true);
    expect(plan.results.some(r => r.detail.includes("CORRELATED"))).toBe(false);
    const beforeProjects = await db().prepare(`SELECT p.slug, p.display_name, (SELECT COUNT(*) FROM work_item w WHERE w.project_id = p.id AND w.state IN ('open', 'doing')) AS open
      FROM project p WHERE p.tenant_id = ? AND p.kind <> 'channel' AND p.state = 'active' ORDER BY p.display_name LIMIT 60`).bind(w.tenant.id).all();
    const beforeTotals = await db().prepare(`SELECT (SELECT COUNT(*) FROM work_item WHERE tenant_id = ? AND state IN ('open', 'doing')) AS open,
      (SELECT COUNT(*) FROM work_item WHERE tenant_id = ? AND state IN ('open', 'doing') AND owner_id = (SELECT identity_id FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?)) AS mine,
      (SELECT COUNT(*) FROM inbound_mail WHERE tenant_id = ? AND verdict = 'quarantined' AND released_at IS NULL) AS held,
      (SELECT COUNT(*) FROM attention WHERE tenant_id = ? AND identity_id = (SELECT identity_id FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?) AND done_at IS NULL) AS needs`)
      .bind(w.tenant.id, w.tenant.id, await sha256Hex(w.token), now + 1, w.tenant.id, w.tenant.id, await sha256Hex(w.token), now + 1).all();
    expect(rail.projects).toEqual(beforeProjects.results);
    const { projects: _, ...counts } = rail; expect(counts).toEqual(beforeTotals.results[0]);
    const beforeReads = beforeProjects.meta.rows_read + beforeTotals.meta.rows_read;
    expect(meta!.rows_read).toBeLessThan(beforeReads);
    console.log(`rail projects=${projects}: rows_read=${meta!.rows_read}, previous=${beforeReads}`);
  });
});

describe("roleFor and rank", () => {
  it("orders roles", () => {
    expect(rank("root") > rank("admin") && rank("admin") > rank("member") && rank("member") > rank("reader") && rank("reader") > rank(null)).toBe(true);
    expect(roleFor(null, null)).toBeNull();
  });
});

describe("signed-out and stale cookie rules", () => {
  async function archive(id: string) {
    await db().prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(id).run();
  }

  it("archived root is signed out on the apex", async () => {
    const root = await createIdentity(db(), { kind: "human", email: "r@example.com", display_name: "R", is_root: 1, operator_id: null }, now);
    const { token } = await createBrowserSession(db(), root.id, now);
    await archive(root.id);
    const req = new Request("https://pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.identity).toBeNull();
    expect(ctx.session).toBeNull();
    expect(ctx.role).toBeNull();
    expect(ctx.staleCookie).toBe(true);
  });

  it("archived member is signed out on a tenant host", async () => {
    const s = await seed();
    await archive(s.identity.id);
    const req = new Request("https://acme.pimwell.test/", { headers: { cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.identity).toBeNull();
    expect(ctx.role).toBeNull();
  });

  it("bad bearer with valid cookie: bearer wins, cookie not consulted, not stale", async () => {
    const s = await seed();
    const req = new Request("https://pimwell.test/", { headers: { authorization: "Bearer pms_nope", cookie: `${COOKIE_NAME}=${s.token}` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.staleCookie).toBe(false);
    expect(ctx.identity).toBeNull();
  });

  it("valid bearer with stale cookie: not stale, identity from bearer", async () => {
    const s = await seed();
    const req = new Request("https://pimwell.test/", { headers: { authorization: `Bearer ${s.token}`, cookie: `${COOKIE_NAME}=pms_stale` } });
    const ctx = await buildContext(req, env, now + 1);
    expect(ctx.staleCookie).toBe(false);
    expect(ctx.identity?.id).toBe(s.identity.id);
  });
});
