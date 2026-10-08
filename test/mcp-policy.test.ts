import { PLANNED } from "../src/verbs/planned";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildContext, credentialUsable, oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { sha256Hex } from "../src/ids";
import { exposedVerbs, mcpViolations, toolName } from "../src/mcp/policy";
import { runVerb } from "../src/verbs/dispatch";
import { registerAllVerbs } from "../src/verbs/index";
import { defineVerb, getVerb, listVerbs, type VerbDef } from "../src/verbs/table";
import { HubError } from "../src/errors";
import { apiPost, bearer, seedGrant, seedHuman, seedTenant } from "./helpers";

beforeAll(() => registerAllVerbs());

// Live verbs only; the planned stubs are pinned in test/planned.test.ts.
const names = (vs: VerbDef<unknown, unknown>[]) => vs.map((v) => v.name).filter((n) => !PLANNED.has(n));
const noop = { parse: () => ({}), run: async () => ({}) };
const input = { type: "object" as const, properties: {}, additionalProperties: false as const };

describe("MCP exposure rules", () => {
  it("exposes exactly these tools", () => {
    expect(names(listVerbs().filter((v) => v.mcp))).toEqual(["app.list", "app.register", "attention.done", "attention.list", "capabilities", "chat.catchup", "chat.inbox", "chat.read", "chat.thread", "deploy.list", "deploy.record", "event.list", "mail.list", "mail.propose_work", "mail.read", "mail.reply", "mail.send", "message.search", "project.history", "project.list", "project.status", "ref.backlinks", "repo.branches", "repo.commit", "repo.connect", "repo.diff", "repo.file", "repo.list", "repo.log", "review.ai", "review.comment", "review.list", "review.read", "review.request", "review.verdict", "search.query", "situation.list", "situation.resolve", "skill.list", "skill.read", "trace.list", "trace.read", "usage.report", "usage.summary", "whoami", "work.board", "work.bulk_update", "work.claim", "work.comment", "work.create", "work.link", "work.list", "work.read", "work.search", "work.subscribe", "work.update"]);
    expect(toolName("project.list")).toBe("project_list");
  });

  it("names every MCP spec 8.3 breach", () => {
    const bad = defineVerb({
      name: "token.mint", kind: "command", scope: "hub", minRole: "admin", freshProofMinutes: 60, summary: "x", ...noop,
      mcp: { scope: "read", destructive: false, title: "x", input },
    });
    expect(mcpViolations(bad as VerbDef<unknown, unknown>)).toEqual([
      "role above member", "hub scope", "fresh proof", "credential or access verb", "scope does not match kind",
    ]);
    const destructiveQuery = defineVerb({ name: "x.y", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null, summary: "x", ...noop, mcp: { scope: "read", destructive: true, title: "x", input } });
    expect(mcpViolations(destructiveQuery as VerbDef<unknown, unknown>)).toEqual(["destructive query"]);
  });

  it("caps tools by scope and by the human's current role", () => {
    expect(names(exposedVerbs("reader", ["read"]))).toEqual(["app.list", "attention.list", "capabilities", "chat.catchup", "chat.inbox", "chat.read", "chat.thread", "deploy.list", "mail.list", "mail.read", "message.search", "project.history", "project.list", "project.status", "ref.backlinks", "repo.branches", "repo.commit", "repo.connect", "repo.diff", "repo.file", "repo.list", "repo.log", "review.list", "review.read", "search.query", "situation.list", "skill.list", "skill.read", "trace.list", "trace.read", "usage.summary", "whoami", "work.board", "work.list", "work.read", "work.search"]);
    expect(names(exposedVerbs("member", ["read"]))).toEqual(["app.list", "attention.list", "capabilities", "chat.catchup", "chat.inbox", "chat.read", "chat.thread", "deploy.list", "event.list", "mail.list", "mail.propose_work", "mail.read", "message.search", "project.history", "project.list", "project.status", "ref.backlinks", "repo.branches", "repo.commit", "repo.connect", "repo.diff", "repo.file", "repo.list", "repo.log", "review.list", "review.read", "search.query", "situation.list", "skill.list", "skill.read", "trace.list", "trace.read", "usage.summary", "whoami", "work.board", "work.list", "work.read", "work.search"]);
    expect(names(exposedVerbs("admin", ["read"]))).toEqual(["app.list", "attention.list", "capabilities", "chat.catchup", "chat.inbox", "chat.read", "chat.thread", "deploy.list", "event.list", "mail.list", "mail.propose_work", "mail.read", "message.search", "project.history", "project.list", "project.status", "ref.backlinks", "repo.branches", "repo.commit", "repo.connect", "repo.diff", "repo.file", "repo.list", "repo.log", "review.list", "review.read", "search.query", "situation.list", "skill.list", "skill.read", "trace.list", "trace.read", "usage.summary", "whoami", "work.board", "work.list", "work.read", "work.search"]);
    expect(names(exposedVerbs("member", []))).toEqual([]);
    expect(names(exposedVerbs(null, ["read"]))).toEqual(["capabilities", "skill.list", "skill.read", "whoami"]);
  });
});

describe("oauth sessions as credentials", () => {
  it("count only on /mcp, only on their own tenant", async () => {
    const acme = await seedTenant("acme");
    const blue = await seedTenant("blue");
    const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
    const { session } = await seedGrant(acme, h);
    expect(await credentialUsable(env.HUB_DB, h.identity, session, null, acme, "mcp")).toBe(true);
    expect(await credentialUsable(env.HUB_DB, h.identity, session, null, acme)).toBe(false);
    expect(await credentialUsable(env.HUB_DB, h.identity, session, null, blue, "mcp")).toBe(false);
    expect(await credentialUsable(env.HUB_DB, h.identity, h.session, null, acme, "mcp")).toBe(false);
    // oauth sessions never introspect (ruling A-1).
    expect(await credentialUsable(env.HUB_DB, h.identity, session, null, acme, "introspect")).toBe(false);
  });

  it("never authenticate /api or pages, by cookie or bearer", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const { session } = await seedGrant(acme, h);
    // Give the oauth session a known token, as if one had leaked.
    await env.HUB_DB.prepare("UPDATE session SET token_hash = ? WHERE id = ?").bind(await sha256Hex("pms_leaked"), session.id).run();
    const viaBearer = await buildContext(new Request("https://acme.pimwell.test/", { headers: { authorization: "Bearer pms_leaked" } }), env);
    expect(viaBearer.identity).toBeNull();
    const viaCookie = await buildContext(new Request("https://acme.pimwell.test/", { headers: { cookie: "pmw_session=pms_leaked" } }), env);
    expect(viaCookie.identity).toBeNull();
    expect(viaCookie.staleCookie).toBe(true);
  });
});

describe("dispatcher under an oauth context", () => {
  it("runs exposed verbs within scope and role, and nothing else", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
    const { grant } = await seedGrant(acme, h);
    const live = (await liveGrant(env.HUB_DB, grant.id, Date.now()))!;
    const ctx = oauthContext(env, live, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    expect(ctx).toMatchObject({ authKind: "oauth", role: "reader", tenant: { slug: "acme" }, session: { kind: "oauth" }, oauth: { grant_id: grant.id, scopes: ["read"] } });
    const who = (await runVerb(ctx, getVerb("whoami")!, {})) as any;
    expect(who.connection).toEqual({ client: "Test App", scopes: ["read"] });
    expect(who.memberships).toEqual([{ slug: "acme", display_name: "ACME", role: "reader" }]);
    const reject = async (verb: string, c = ctx) => {
      try {
        await runVerb(c, getVerb(verb)!, {});
        return null;
      } catch (e) {
        return e instanceof HubError ? `${e.status} ${e.reason}` : "other";
      }
    };
    expect(await reject("project.list")).toBeNull();
    expect(await reject("event.list")).toBe("403 forbidden");
    expect(await reject("session.list")).toBe("403 forbidden");
    expect(await reject("project.create")).toBe("403 forbidden");
    expect(await reject("project.list", { ...ctx, oauth: { ...ctx.oauth!, scopes: [] } })).toBe("403 insufficient_scope");
  });
});

describe("event.list", () => {
  it("pages a tenant's events newest first, filters by session, and needs a member", async () => {
    const acme = await seedTenant("acme");
    await seedTenant("blue");
    const m = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const r = await seedHuman("r@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
    for (const slug of ["p1", "p2", "p3"]) {
      expect((await apiPost("acme.pimwell.test", "project.create", { slug, kind: "repo", display_name: slug }, bearer(m.token))).status).toBe(200);
      // Event ids are ULIDs: within one millisecond their order is random, so give each event its own.
      await new Promise((r) => setTimeout(r, 3));
    }
    const page1 = ((await (await apiPost("acme.pimwell.test", "event.list", { limit: 2 }, bearer(m.token))).json()) as any).result;
    expect(page1.events.map((e: any) => e.summary)).toEqual(["Created project p3", "Created project p2"]);
    expect(page1.next_cursor).toBe(page1.events[1].id);
    const page2 = ((await (await apiPost("acme.pimwell.test", "event.list", { limit: 2, cursor: page1.next_cursor }, bearer(m.token))).json()) as any).result;
    expect(page2.events.map((e: any) => e.summary)).toEqual(["Created project p1"]);
    expect(page2.next_cursor).toBeNull();
    const mine = ((await (await apiPost("acme.pimwell.test", "event.list", { session_id: m.session.id }, bearer(m.token))).json()) as any).result;
    expect(mine.events).toHaveLength(3);
    const none = ((await (await apiPost("acme.pimwell.test", "event.list", { session_id: r.session.id }, bearer(m.token))).json()) as any).result;
    expect(none.events).toEqual([]);
    expect((await apiPost("acme.pimwell.test", "event.list", {}, bearer(r.token))).status).toBe(403);
    expect((await apiPost("blue.pimwell.test", "event.list", {}, bearer(m.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "event.list", { limit: 101 }, bearer(m.token))).status).toBe(400);
  });
});
