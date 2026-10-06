import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildContext } from "../src/auth/context";
import { viewerOf } from "../src/chat/access";
import { parseBody } from "../src/chat/grammar";
import { backlinkTarget, refsForViewer, resolveRefs } from "../src/chat/refs";
import { runVerb } from "../src/verbs/dispatch";
import { registerAllVerbs } from "../src/verbs/index";
import { getVerb } from "../src/verbs/table";
import { HOST, channelWith, chatWorld, ok } from "./chat-helpers";

beforeAll(() => registerAllVerbs());

const OID = "3f9a2c1" + "0".repeat(33);
type Seen = { body: { tenant: string; principal: string; session: string; refs: unknown[] }; secret: string | null };

function fakeArdi(answer: (refs: Array<{ kind: string; repo: string; id: string }>) => unknown, seen: Seen[] = []): Fetcher {
  return {
    fetch: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      seen.push({ body, secret: new Headers(init.headers).get("x-hub-internal") });
      return Response.json(answer(body.refs));
    },
  } as unknown as Fetcher;
}

function ctxFor(token: string, ardi: Fetcher | undefined) {
  return buildContext(new Request(`https://${HOST}/api/chat.post`, { method: "POST", headers: { authorization: `Bearer ${token}` } }), { ...env, ARDI: ardi });
}

describe("ref resolution", () => {
  it("asks Ardi as the poster and keeps what it found", async () => {
    const w = await chatWorld();
    const seen: Seen[] = [];
    const ardi = fakeArdi((refs) => ({
      ok: true,
      results: refs.map((r) => (r.kind === "commit" ? { found: true, key: OID, title: "Pin parser" } : r.id === "k7q2" ? { found: true, key: "k7q2", title: "Parser breaks" } : r.id === "dupe" ? { found: false, ambiguous: true } : { found: false })),
    }), seen);
    const r = await resolveRefs(await ctxFor(w.scout.token, ardi), parseBody("site@3f9a2c1 site#k7q2 site#zzzz site#dupe").refs);
    expect(r.resolved).toEqual([{ kind: "commit", key: `site@${OID}`, title: "Pin parser" }, { kind: "ticket", key: "site#k7q2", title: "Parser breaks" }]);
    expect(r.unresolved).toEqual([{ kind: "ticket", text: "site#zzzz", reason: "not_found" }, { kind: "ticket", text: "site#dupe", reason: "ambiguous" }]);
    expect(seen).toEqual([{
      secret: "test-internal-secret",
      body: {
        tenant: "acme", principal: w.scout.agent.identity.id, session: w.scout.session.id,
        refs: [{ kind: "commit", repo: "site", id: "3f9a2c1" }, { kind: "ticket", repo: "site", id: "k7q2" }, { kind: "ticket", repo: "site", id: "zzzz" }, { kind: "ticket", repo: "site", id: "dupe" }],
      },
    }]);
  });

  it("keeps tickets and full commits unverified when Ardi cannot answer, and refuses short prefixes", async () => {
    const w = await chatWorld();
    const expected = {
      resolved: [{ kind: "ticket", key: "site#k7q2", title: null }, { kind: "commit", key: `site@${OID}`, title: null }],
      unresolved: [{ kind: "commit", text: "site@3f9a2c1", reason: "ardi_unavailable" }],
    };
    const body = `site#k7q2 site@${OID} site@3f9a2c1`;
    expect(await resolveRefs(await ctxFor(w.lead.token, undefined), parseBody(body).refs)).toEqual(expected);
    // The test pool's ARDI binding is an echo stub: an answer that is not the contract counts as unavailable.
    expect(await resolveRefs(await ctxFor(w.lead.token, env.ARDI), parseBody(body).refs)).toEqual(expected);
  });

  it("resolves sessions and messages with the poster's permissions, and re-checks them per viewer", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await ok(w.dev.token, "chat.post", { c: "general", body: "first line\nsecond" });
    const body = `session:${w.scout.session.id} session:${w.dev.session.id} msg:general/1`;
    const dev = await ctxFor(w.dev.token, undefined);
    const asDev = await resolveRefs(dev, parseBody(body).refs);
    expect(asDev.resolved.map((r) => [r.kind, r.title])).toEqual([["session", "browser"], ["msg", "first line"]]);
    expect(asDev.unresolved).toEqual([{ kind: "session", text: `session:${w.scout.session.id}`, reason: "not_found" }]);
    const asLead = await resolveRefs(await ctxFor(w.lead.token, undefined), parseBody(body).refs);
    expect(asLead.resolved.map((r) => [r.kind, r.title])).toEqual([["session", "agent_run run-1"], ["session", "browser"], ["msg", "first line"]]);
    const tidy = await ctxFor(w.tidy.token, undefined);
    expect((await resolveRefs(tidy, parseBody("msg:general/1").refs)).unresolved).toEqual([{ kind: "msg", text: "msg:general/1", reason: "not_found" }]);
    const forDev = await refsForViewer(env.HUB_DB, viewerOf(dev), asLead.resolved);
    expect(forDev.map((r) => [r.kind, r.no_access, r.title === null])).toEqual([["session", true, true], ["session", false, false], ["msg", false, false]]);
    const forTidy = await refsForViewer(env.HUB_DB, viewerOf(tidy), asLead.resolved);
    expect(forTidy.map((r) => r.no_access)).toEqual([true, true, true]);
  });

  it("names the backlink target of a commit prefix, a ticket, and a session", () => {
    expect(backlinkTarget("commit", "site@3f9a2c1")).toEqual({ kind: "commit", key: "site@3f9a2c1", prefix: true });
    expect(backlinkTarget("commit", `site@${OID}`)).toEqual({ kind: "commit", key: `site@${OID}`, prefix: false });
    expect(backlinkTarget("ticket", "site#k7q2")).toEqual({ kind: "ticket", key: "site#k7q2", prefix: false });
    expect(backlinkTarget("ticket", "bad key")).toBeNull();
  });

  it("stores resolved refs with the message and indexes them for backlinks", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ardi = fakeArdi((refs) => ({ ok: true, results: refs.map(() => ({ found: true, key: "k7q2", title: "Parser breaks" })) }));
    await runVerb(await ctxFor(w.lead.token, ardi), getVerb("chat.post")!, { c: "general", body: "see site#k7q2", refs: [{ kind: "ticket", key: "site#k7q2" }] });
    const rows = await env.HUB_DB.prepare("SELECT target_kind, target_key FROM msg_ref WHERE tenant_id = ?").bind(w.acme.id).all();
    expect(rows.results).toEqual([{ target_kind: "ticket", target_key: "site#k7q2" }]);
  });
});
