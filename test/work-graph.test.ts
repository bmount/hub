// The work graph (docs/ops/work-graph.md): pure graph rules, then the acceptance scenarios end to end through /api.
import { env, SELF } from "cloudflare:test";
// @ts-expect-error The no-build Node CLI is shared with this transport test.
import { runCli, parseArgs } from "../bin/cli.mjs";
import { listVerbs } from "../src/verbs/table";
import { rpcBody } from "./oauth-helpers";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { claimWork, getWork, LEASE_MS } from "../src/db/work";
import { changeDeps, graphFrom, itemGraphStatements, loadGraph } from "../src/work/graphEdit";
import { viewGraph } from "../src/work/graphView";
import { closure, criticalPath, findCycle, rankReady, readiness, topoOrder, type Edge, type GraphNode } from "../src/work/graph";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const e = (prereq_id: string, dependent_id: string): Edge => ({ prereq_id, dependent_id });
const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, state: "open", owner_id: null, lease_until: null, priority: 2, estimate: null, created_at: 0, ...extra });

describe("graph rules", () => {
  it("computes closures both ways, nearest first", () => {
    const edges = [e("a", "b"), e("b", "c"), e("a", "d"), e("x", "c")];
    expect(closure(edges, "a", "down")).toEqual(["b", "d", "c"]);
    expect(closure(edges, "c", "up")).toEqual(["b", "x", "a"]);
  });

  it("finds cycles and orders acyclic graphs with prerequisites first, then by urgency", () => {
    expect(findCycle([e("a", "b"), e("b", "c")])).toBeNull();
    expect(findCycle([e("a", "b"), e("b", "c"), e("c", "a")])).toEqual(["a", "b", "c", "a"]);
    const nodes = [node("a", { priority: 3 }), node("b"), node("c", { priority: 0 })];
    expect(topoOrder(nodes, [e("a", "b")])).toEqual(["c", "a", "b"]);
    expect(() => topoOrder(nodes, [e("a", "b"), e("b", "a")])).toThrow(/cycle/);
  });

  it("measures the longest chain of open work, counting done items as zero", () => {
    const nodes = [node("a", { estimate: 3 }), node("b", { estimate: 5 }), node("c"), node("d", { state: "done", estimate: 9 })];
    const cp = criticalPath(nodes, [e("a", "b"), e("b", "c"), e("d", "c")]);
    expect([cp.get("a"), cp.get("b"), cp.get("c"), cp.get("d")]).toEqual([9, 6, 1, 1]);
  });

  it("keeps lifecycle and readiness apart: only done prerequisites count, live claims hold, resources conflict", () => {
    const now = 1000;
    const nodes = [node("p", { state: "dropped" }), node("q", { state: "done" }), node("a"), node("b"), node("c", { state: "doing", owner_id: "u", lease_until: now + 1 }),
      node("d"), node("e", { state: "doing", owner_id: "u", lease_until: now - 1 })];
    const r = readiness(nodes, [e("p", "a"), e("q", "b")], [{ item_id: "c", name: "db", mode: "exclusive" }, { item_id: "d", name: "db", mode: "shared" }], now);
    expect(r.get("p")).toEqual({ status: "closed" });
    expect(r.get("a")).toEqual({ status: "blocked", waiting_on: ["p"], claimed: false });
    expect(r.get("b")).toEqual({ status: "ready" });
    expect(r.get("c")).toEqual({ status: "claimed", owner_id: "u", until: now + 1 });
    expect(r.get("d")).toEqual({ status: "conflict", with: ["c"] });
    expect(r.get("e")).toEqual({ status: "ready" });
  });

  it("ranks ready work by priority, then critical path, then downstream impact, then shortest", () => {
    const nodes = [node("short", { estimate: 1 }), node("long", { estimate: 8 }), node("unblocks"), node("after"), node("urgent", { priority: 0 })];
    const edges = [e("unblocks", "after")];
    const ranked = rankReady(nodes, edges, readiness(nodes, edges, [], 0)).map((x) => x.id);
    expect(ranked).toEqual(["urgent", "long", "unblocks", "short"]);
  });
});

type Item = { id: string; number: number; state: string; owner_id: string | null; updated_at: number };
type Ready = { status: string; waiting_on?: string[]; with?: string[] };

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const as = (h: { token: string }) => (verb: string, body: unknown) => apiPost(HOST, verb, body, cookieHeaders(h.token, HOST));
  const call = { pat: as(pat), sam: as(sam) };
  const ok = async <T>(r: Response) => { expect(r.status, await r.clone().text()).toBe(200); return ((await r.json()) as { result: T }).result; };
  const file = async (title: string, extra: Record<string, unknown> = {}) => (await ok<{ item: Item; ref: string }>(await call.pat("work.create", { project: "site", kind: "errand", title, ...extra })));
  const readiness = async (ref: string) => (await ok<{ readiness: Ready }>(await call.pat("work.read", { id: ref }))).readiness;
  const deps = async () => (await env.HUB_DB.prepare("SELECT prereq_id, dependent_id FROM work_dep ORDER BY prereq_id, dependent_id").all<Edge>()).results;
  return { t, pat, sam, call, ok, file, readiness, deps };
}

describe("CLI arguments", () => {
  const schemas = () => listVerbs().map(v => ({ name: v.name, inputSchema: v.mcp?.input ?? null }));
  it("types flags, positional references and nested JSON without changing string values", () => {
    const verbs = schemas();
    expect(parseArgs(["work", "frontier", "--limit", "3", "--json"], verbs)).toEqual({
      name: "work.frontier", input: { limit: 3 }, json: true,
    });
    expect(parseArgs(["work", "depend", "site#3", "--on", '["site#1","site#2"]'], verbs).input)
      .toEqual({ id: "site#3", on: ["site#1", "site#2"] });
    expect(parseArgs(["work", "update", "site#3", "--priority", "0", "--estimate", "2"], verbs).input)
      .toEqual({ id: "site#3", priority: 0, estimate: 2 });
    expect(parseArgs(["work", "subscribe", "--follow", "false"], verbs).input).toEqual({ follow: false });
    expect(parseArgs(["work", "subscribe", "--follow"], verbs).input).toEqual({ follow: true });
    expect(parseArgs(["session", "start", "--input", '{"label":"cli","ttl":3600}'], verbs).input)
      .toEqual({ label: "cli", ttl: 3600 });
    expect(parseArgs(["work", "create", "--title", "123"], verbs).input.title).toBe("123");
    expect(parseArgs(["work", "create", "--title", "[not JSON]"], verbs).input.title).toBe("[not JSON]");
    for (const args of [
      ["work", "frontier", "--limit", "oops"],
      ["work", "frontier", "--limit", "1.2"],
      ["work", "frontier", "--limit"],
      ["work", "frontier", "--unknown", "x"],
      ["work", "subscribe", "--follow", "maybe"],
      ["work", "depend", "site#3", "site#4"],
      ["work", "propose", "--input", "[]"],
    ]) expect(() => parseArgs(args, verbs)).toThrow();
  });

  it("refuses insecure origins, redirects and API errors, and renders human output", async () => {
    const verbs = schemas();
    const requests: string[] = [];
    const options = { url: "https://acme.pimwell.test", token: "pms_test",
      fetch: async (url: URL) => { requests.push(url.pathname); return Response.json({
        ok: true, result: url.pathname === "/api/schema" ? { verbs } : { ready: [], counts: { ready: 0 } },
      }); }, write: (text: string) => { output = text; } };
    let output = "";
    await runCli(["work", "frontier"], options);
    expect(output).toContain("counts:");
    expect(output).toContain("ready: 0");
    expect(requests).toEqual(["/api/schema", "/api/work.frontier"]);
    for (const url of ["http://evil.example", "https://user:secret@evil.example", "https://acme.pimwell.test/path"]) {
      await expect(runCli(["work", "frontier"], { ...options, url })).rejects.toThrow("HTTPS origin");
    }
    await expect(runCli(["work", "frontier"], { ...options,
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    })).rejects.toThrow("redirect refused");
    await expect(runCli(["work", "frontier"], { ...options,
      fetch: async (url: URL) => url.pathname === "/api/schema" ? Response.json({ ok: true, result: { verbs } }) :
        Response.json({ ok: false, error: "forbidden", detail: "reader" }, { status: 403 }),
    })).rejects.toThrow("forbidden: reader");
  });
});

describe("work graph acceptance", () => {
  it("reads only incident neighbors and live resource holders, matching whole-graph readiness", async () => {
    const w = await world();
    await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "other", kind: "tracker", display_name: "Other" }, Date.now());
    const a = await w.file("Inspect", { body: "Full description" });
    const prereq = await w.ok<{ item: Item; ref: string }>(await w.call.pat("work.create", { project: "other", kind: "errand", title: "Prerequisite", state: "dropped" }));
    const dependent = await w.file("Dependent", { after: a.ref });
    const holder = await w.ok<{ item: Item; ref: string }>(await w.call.pat("work.create", { project: "other", kind: "errand", title: "Holder" }));
    const unrelated = await w.file("Unrelated");
    const expired = await w.file("Expired");
    const child = await w.file("Child", { parent: a.item.number });
    await w.ok(await w.call.pat("work.comment", { id: a.ref, body: "Retain this comment" }));
    await w.ok(await w.call.pat("work.link", { id: a.ref, target_kind: "url", target_ref: "https://example.com", note: "Evidence" }));
    for (const id of [a.ref, holder.ref, expired.ref]) await w.ok(await w.call.pat("work.resources", { id, resources: ["database"] }));
    await w.ok(await w.call.pat("work.claim", { id: holder.ref }));
    await env.HUB_DB.prepare("UPDATE work_item SET state = 'doing', owner_id = ?, lease_until = 1 WHERE id = ?").bind(w.pat.identity.id, expired.item.id).run();
    const compare = async () => {
      const now = Date.now();
      const focused = graphFrom(await env.HUB_DB.batch(itemGraphStatements(env.HUB_DB, w.t.id, a.item.id, now)));
      const full = await loadGraph(env.HUB_DB, w.t.id);
      expect(viewGraph(focused, now).readinessOf(a.item.id)).toEqual(viewGraph(full, now).readinessOf(a.item.id));
      expect(focused.nodes.map(n => n.id)).not.toContain(unrelated.item.id);
      expect(focused.nodes.map(n => n.id)).not.toContain(expired.item.id);
      expect(focused.nodes.map(n => n.id)).not.toContain(child.item.id);
      return w.ok<any>(await w.call.pat("work.read", { id: a.ref }));
    };
    expect(await compare()).toMatchObject({ readiness: { status: "conflict", with: [holder.ref] }, dependents: [dependent.ref],
      item: { body: "Full description" }, children: [{ id: child.item.id }], comments: [{ body: "Retain this comment", author: "pat" }], links: [{ note: "Evidence" }] });
    await w.ok(await w.call.pat("work.depend", { id: a.ref, on: [prereq.ref] }));
    expect(await compare()).toMatchObject({ readiness: { status: "blocked", waiting_on: [prereq.ref] }, prerequisites: [prereq.ref] });
    await w.ok(await w.call.pat("work.update", { id: prereq.ref, state: "done" }));
    expect((await compare()).readiness.status).toBe("conflict");
    await w.ok(await w.call.pat("work.release", { id: holder.ref }));
    expect((await compare()).readiness.status).toBe("ready");
    await w.ok(await w.call.pat("work.claim", { id: a.ref }));
    expect((await compare()).readiness.status).toBe("claimed");
    await w.ok(await w.call.pat("work.update", { id: a.ref, state: "done" }));
    expect((await compare()).readiness.status).toBe("closed");
  });
  it("keeps canonical namespaced references in readiness, graph and frontier", async () => {
    const w = await world();
    const ns = "research-" + "n".repeat(26), slug = "project-" + "p".repeat(26), path = `${ns}/${slug}`;
    await env.HUB_DB.prepare("INSERT INTO namespace (id,tenant_id,slug,display_name,state,created_at) VALUES ('N',?,?,'Research','active',0)").bind(w.t.id, ns).run();
    await createProject(env.HUB_DB, {tenant_id:w.t.id,namespace_id:"N",slug,kind:"tracker",display_name:"Research work"}, Date.now());
    const a = await w.ok<{ref:string}>(await w.call.pat("work.create", {project:path,kind:"errand",title:"Prepare"}));
    const b = await w.ok<{ref:string}>(await w.call.pat("work.create", {project:path,kind:"wish",title:"Ship",after:a.ref}));
    expect(await w.readiness(b.ref)).toMatchObject({status:"blocked",waiting_on:[a.ref]});
    expect(await w.ok(await w.call.pat("work.graph", {project:path}))).toMatchObject({items:[{ref:a.ref},{ref:b.ref}],edges:[{prerequisite:a.ref,dependent:b.ref}]});
    expect(await w.ok(await w.call.pat("work.frontier", {project:path}))).toMatchObject({ready:[{ref:a.ref}],counts:{ready:1,blocked:1}});
  });
  it("runs file, depend, frontier, claim, done, frontier equally through REST, MCP and CLI", async () => {
    const w = await world();
    const agent = await seedAgent(w.t, w.pat.identity);
    const schemaResponse = await SELF.fetch("https://" + HOST + "/api/schema");
    expect(schemaResponse.status).toBe(200);
    const schemas = ((await schemaResponse.json()) as any).result.verbs;
    expect(schemas.map((v: any) => v.name)).toEqual(listVerbs().map(v => v.name));
    expect(schemas.every((v: any) => v.inputSchema.type === "object")).toBe(true);
    for (const v of listVerbs().filter(v => v.mcp)) {
      expect(schemas.find((s: any) => s.name === v.name)).toEqual({
        name: v.name, summary: v.summary, minRole: v.minRole, inputSchema: v.mcp!.input,
      });
      expect(parseArgs([v.name, "--input", "{}"], schemas).name).toBe(v.name);
    }
    const transcripts = [];
    for (const transport of ["rest", "mcp", "cli"]) {
      const project = "via-" + transport;
      await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: project, kind: "tracker", display_name: project }, Date.now());
      const call = async (verb: string, input: Record<string, unknown>) => {
        if (transport === "rest") return w.ok<any>(await apiPost(HOST, verb, input, bearer(agent.token)));
        if (transport === "mcp") {
          const response = await SELF.fetch("https://" + HOST + "/agent/mcp", {
            method: "POST", headers: { ...bearer(agent.longLived), "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: verb.replaceAll(".", "_"), arguments: input } }),
          });
          const body = await rpcBody(response);
          expect(body.result.isError).not.toBe(true);
          return body.result.structuredContent;
        }
        const argv = [...verb.split("."), ...Object.entries(input).flatMap(([key, value]) =>
          key === "id" ? [String(value)] : ["--" + key.replaceAll("_", "-"), typeof value === "string" ? value : JSON.stringify(value)]), "--json"];
        let output = "";
        const result = await runCli(argv, { url: "https://" + HOST, token: agent.longLived,
          fetch: (url: URL, init: RequestInit) => SELF.fetch(url.toString(), init),
          write: (text: string) => { output = text; } });
        expect(JSON.parse(output)).toEqual(result);
        return result;
      };
      // Generated ids and clock values differ between worlds; normalize only those
      // and the project name, leaving all business fields in the comparison.
      const ids = new Map<string, string>([[w.t.id, "tenant"], [agent.agent.identity.id, "agent"]]);
      const normalize = (value: any, key = ""): any => {
        if (typeof value === "number" && /(_at|_until|until)$/.test(key)) return "<clock>";
        if (typeof value === "string") {
          if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
            if (!ids.has(value)) ids.set(value, "id" + ids.size);
            return ids.get(value);
          }
          return value.replaceAll(project, "site");
        }
        if (Array.isArray(value)) return value.map(v => normalize(v));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
        return value;
      };
      const results = [];
      const a = await call("work.create", { project, kind: "errand", title: "Schema" }); results.push(a);
      const b = await call("work.create", { project, kind: "wish", title: "Feature" }); results.push(b);
      results.push(await call("work.depend", { id: b.ref, on: a.ref }));
      results.push(await call("work.frontier", { project }));
      results.push(await call("work.claim", { id: a.ref }));
      results.push(await call("work.update", { id: a.ref, state: "done" }));
      results.push(await call("work.frontier", { project }));
      expect(results[3].ready.map((v: any) => v.ref)).toEqual([a.ref]);
      expect(results[6].ready.map((v: any) => v.ref)).toEqual([b.ref]);
      transcripts.push(normalize(results));
    }
    expect(transcripts[1]).toEqual(transcripts[0]);
    expect(transcripts[2]).toEqual(transcripts[0]);
  });

  it("refuses a cyclic hard dependency and changes nothing", async () => {
    const w = await world();
    const [a, b, c] = [await w.file("A"), await w.file("B"), await w.file("C")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    await w.ok(await w.call.pat("work.depend", { id: c.ref, on: [b.ref] }));
    const before = await w.deps();
    const refused = await w.call.pat("work.depend", { id: a.ref, on: c.ref });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain("dependency cycle");
    for (const r of [a.ref, b.ref, c.ref]) expect(text).toContain(r);
    expect(await w.call.pat("work.depend", { id: a.ref, on: a.ref }).then((r) => r.status)).toBe(400);
    expect(await w.deps()).toEqual(before);
  });

  it("unlocks dependent work when its prerequisite is done, and only done counts", async () => {
    const w = await world();
    const [a, b] = [await w.file("Schema"), await w.file("Feature")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    expect(await w.readiness(b.ref)).toEqual({ status: "blocked", waiting_on: ["site#1"], claimed: false });
    const refused = await w.call.sam("work.claim", { id: b.ref });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("waits on site#1");
    await w.ok(await w.call.pat("work.update", { id: a.ref, state: "dropped" }));
    expect((await w.readiness(b.ref)).status).toBe("blocked");
    await w.ok(await w.call.pat("work.update", { id: a.ref, state: "done" }));
    expect(await w.readiness(b.ref)).toEqual({ status: "ready" });
    await w.ok(await w.call.sam("work.claim", { id: b.ref }));
  });

  it("does not block on parents, children or links", async () => {
    const w = await world();
    const quest = await w.ok<{ item: Item; ref: string }>(await w.call.pat("work.create", { project: "site", kind: "quest", title: "Big goal" }));
    const child = await w.file("Part of it", { parent: quest.item.number });
    const other = await w.file("Related");
    await w.ok(await w.call.pat("work.link", { id: child.ref, target_kind: "item", target_ref: other.ref }));
    expect(await w.readiness(child.ref)).toEqual({ status: "ready" });
    expect(await w.readiness(quest.ref)).toEqual({ status: "ready" });
    await w.ok(await w.call.sam("work.claim", { id: child.ref }));
  });

  it("lets exactly one of two simultaneous claimers win", async () => {
    const w = await world();
    const a = await w.file("Contested");
    const [r1, r2] = await Promise.all([w.call.pat("work.claim", { id: a.ref }), w.call.sam("work.claim", { id: a.ref })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });

  it("recovers an expired claim", async () => {
    const w = await world();
    const a = await w.file("Abandoned");
    const now = Date.now();
    const held = await claimWork(env.HUB_DB, (await getWork(env.HUB_DB, w.t.id, a.item.id))!, w.pat.identity.id, now);
    await expect(claimWork(env.HUB_DB, held, w.sam.identity.id, now + 1000)).rejects.toMatchObject({ status: 409 });
    const taken = await claimWork(env.HUB_DB, held, w.sam.identity.id, now + LEASE_MS + 1);
    expect(taken.owner_id).toBe(w.sam.identity.id);
  });

  it("treats a new dependency as invalidating readiness: a claim prepared before it is refused", async () => {
    const w = await world();
    const [a, b] = [await w.file("Found later"), await w.file("Was ready")];
    expect(await w.readiness(b.ref)).toEqual({ status: "ready" });
    const stale = (await getWork(env.HUB_DB, w.t.id, b.item.id))!;
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    await expect(claimWork(env.HUB_DB, stale, w.sam.identity.id, Date.now())).rejects.toMatchObject({ status: 409 });
    const fresh = (await getWork(env.HUB_DB, w.t.id, b.item.id))!;
    await expect(claimWork(env.HUB_DB, fresh, w.sam.identity.id, Date.now())).rejects.toThrow(/waits on site#1/);
    expect((await w.readiness(b.ref)).status).toBe("blocked");
  });

  it("applies a multi-edge change all or nothing, and serializes concurrent edits so no cycle slips through", async () => {
    const w = await world();
    const [a, b, c] = [await w.file("A"), await w.file("B"), await w.file("C")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    // a waiting on c is fine, but a waiting on b closes a cycle; in one call, the bad edge refuses both.
    expect((await w.call.pat("work.depend", { id: a.ref, on: [c.ref, b.ref] })).status).toBe(400);
    expect(await w.deps()).toEqual([{ prereq_id: a.item.id, dependent_id: b.item.id }]);
    // Two edits that are each fine alone but form a cycle together: exactly one commits.
    const actor = (id: string) => ({ tenant_id: w.t.id, identity_id: id, session_id: null });
    const results = await Promise.allSettled([
      changeDeps(env.HUB_DB, actor(w.pat.identity.id), { add: [{ prereq_id: b.item.id, dependent_id: c.item.id }], remove: [] }, Date.now()),
      changeDeps(env.HUB_DB, actor(w.sam.identity.id), { add: [{ prereq_id: c.item.id, dependent_id: a.item.id }], remove: [] }, Date.now()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(findCycle(await w.deps())).toBeNull();
  });

  it("keeps conflicting work from running at once, unless both sides are shared", async () => {
    const w = await world();
    const [a, b, c, d] = [await w.file("Migrate"), await w.file("Backfill"), await w.file("Read report"), await w.file("Read stats")];
    await w.ok(await w.call.pat("work.resources", { id: a.ref, resources: "prod-db" }));
    await w.ok(await w.call.pat("work.resources", { id: b.ref, resources: ["prod-db"] }));
    await w.ok(await w.call.pat("work.resources", { id: c.ref, resources: "replica:shared" }));
    await w.ok(await w.call.pat("work.resources", { id: d.ref, resources: "replica:shared" }));
    await w.ok(await w.call.pat("work.claim", { id: a.ref }));
    const refused = await w.call.sam("work.claim", { id: b.ref });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("held by site#1");
    expect(await w.readiness(b.ref)).toEqual({ status: "conflict", with: ["site#1"] });
    await w.ok(await w.call.pat("work.claim", { id: c.ref }));
    await w.ok(await w.call.sam("work.claim", { id: d.ref }));
    await w.ok(await w.call.pat("work.release", { id: a.ref }));
    await w.ok(await w.call.sam("work.claim", { id: b.ref }));
  });

  it("lists the frontier best first and points out work stuck behind dropped items", async () => {
    const w = await world();
    const low = await w.file("Low", { priority: 3 });
    const base = await w.file("Base", { estimate: 4 });
    await w.file("Top", { estimate: 2, after: [base.ref] });
    await w.ok(await w.call.pat("work.create", { project: "site", kind: "quest", title: "A goal, not work" }));
    const gone = await w.file("Abandoned idea");
    await w.file("Needs the idea", { after: gone.ref });
    await w.ok(await w.call.pat("work.update", { id: gone.ref, state: "dropped" }));
    const f = await w.ok<{ ready: Array<{ ref: string; critical: number; downstream: number }>; counts: Record<string, number>; stuck: Array<{ ref: string }> }>(await w.call.pat("work.frontier", {}));
    expect(f.ready.map((x) => x.ref)).toEqual([base.ref, low.ref]);
    expect(f.ready[0]).toMatchObject({ critical: 6, downstream: 1 });
    expect(f.counts).toEqual({ ready: 2, blocked: 2, claimed: 0, conflict: 0 });
    expect(f.stuck.map((x) => x.ref)).toEqual(["site#6"]);
    const order = await w.ok<{ items: Array<{ ref: string }> }>(await w.call.pat("work.graph", { project: "site" }));
    expect(order.items.map((x) => x.ref).indexOf(base.ref)).toBeLessThan(order.items.map((x) => x.ref).indexOf("site#3"));
  });

  it("deletes an item with its edges, comments and links, frees what waited on it, and keeps an audit record", async () => {
    const w = await world();
    const [a, b] = [await w.file("Noise"), await w.file("Real work")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    await w.ok(await w.call.pat("work.comment", { id: a.ref, body: "hm" }));
    await w.ok(await w.call.pat("work.link", { id: a.ref, target_kind: "url", target_ref: "https://example.com/x" }));
    expect((await w.call.pat("work.delete", { id: a.ref, confirm: "site#2" })).status).toBe(400);
    const done = await w.ok<{ ref: string; released: string[] }>(await w.call.pat("work.delete", { id: a.ref, confirm: a.ref }));
    expect(done.released).toEqual([b.ref]);
    expect(await getWork(env.HUB_DB, w.t.id, a.item.id)).toBeNull();
    expect(await w.deps()).toEqual([]);
    expect(await w.readiness(b.ref)).toEqual({ status: "ready" });
    const left = await env.HUB_DB.prepare("SELECT (SELECT COUNT(*) FROM work_comment) AS comments, (SELECT COUNT(*) FROM work_link) AS links").first<{ comments: number; links: number }>();
    expect(left).toEqual({ comments: 0, links: 0 });
    const event = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'work.delete' AND target_id = ?").bind(a.item.id).first<{ summary: string }>();
    expect(event?.summary).toBe("Deleted site#1: Noise");
    expect((await w.call.pat("work.read", { id: a.ref })).status).toBe(404);
  });

  it("records every graph change in the activity log", async () => {
    const w = await world();
    const [a, b] = [await w.file("A"), await w.file("B")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    await w.ok(await w.call.pat("work.depend", { id: b.ref, remove: a.ref }));
    await w.ok(await w.call.pat("work.resources", { id: b.ref, resources: "x" }));
    await w.ok(await w.call.pat("work.claim", { id: b.ref }));
    await w.ok(await w.call.pat("work.release", { id: b.ref }));
    const kinds = (await env.HUB_DB.prepare("SELECT kind FROM event WHERE target_id = ? ORDER BY id").bind(b.item.id).all<{ kind: string }>()).results.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["work.depend", "work.undepend", "work.resources", "work.claim", "work.release"]));
  });
});

describe("proposed graph changes", () => {
  type Shown = { id: string; state: string; changes: string[]; created: string[] };
  const proposeNewPrereq = (w: Awaited<ReturnType<typeof world>>, target: string) => w.call.pat("work.propose", {
    for: target, reason: "Found while on it: the schema has to change first",
    new_items: [{ key: "schema", kind: "errand", title: "Change the schema", body: "Done when: migrated.", priority: 1, estimate: 2 }],
    add: [{ prerequisite: "new:schema", dependent: target }],
  });

  it("leaves the live graph and a running claim alone until another member approves, then applies it all at once", async () => {
    const w = await world();
    const target = await w.file("Feature under way");
    await w.ok(await w.call.sam("work.claim", { id: target.ref }));
    const before = { deps: await w.deps(), items: (await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_item").first<{ n: number }>())!.n };
    const proposed = await w.ok<Shown>(await proposeNewPrereq(w, target.ref));
    expect(proposed.state).toBe("pending");
    expect(proposed.changes).toEqual(["new:schema — new errand in site: Change the schema", `${target.ref} waits on new:schema`]);
    expect(await w.deps()).toEqual(before.deps);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_item").first<{ n: number }>())!.n).toBe(before.items);
    expect((await w.readiness(target.ref)).status).toBe("claimed");
    const frontier = await w.ok<{ proposals_pending: number }>(await w.call.pat("work.frontier", {}));
    expect(frontier.proposals_pending).toBe(1);

    expect((await w.call.pat("work.review", { id: proposed.id, decision: "approve" })).status).toBe(403);
    const approved = await w.ok<Shown>(await w.call.sam("work.review", { id: proposed.id, decision: "approve", note: "yes" }));
    expect(approved.state).toBe("approved");
    expect(approved.created).toEqual(["new:schema = site#2"]);
    const made = await env.HUB_DB.prepare("SELECT * FROM work_item WHERE number = 2").first<{ created_by: string; priority: number; estimate: number; source_quote: string }>();
    expect(made).toMatchObject({ created_by: w.sam.identity.id, priority: 1, estimate: 2 });
    expect(made!.source_quote).toContain("Proposed by pat@example.com");
    expect(await w.readiness(target.ref)).toEqual({ status: "blocked", waiting_on: ["site#2"], claimed: true });
    expect((await w.call.sam("work.review", { id: proposed.id, decision: "reject" })).status).toBe(409);
    const pending = await w.ok<{ proposals: Shown[] }>(await w.call.pat("work.proposals", {}));
    expect(pending.proposals).toEqual([]);
  });

  it("refuses an approval that would now form a cycle, changing nothing; the proposal stays pending", async () => {
    const w = await world();
    const [a, b] = [await w.file("A"), await w.file("B")];
    const proposed = await w.ok<Shown>(await w.call.pat("work.propose", { reason: "b first", add: [{ prerequisite: b.ref, dependent: a.ref }] }));
    await w.ok(await w.call.sam("work.depend", { id: b.ref, on: a.ref }));
    const before = await w.deps();
    const refused = await w.call.sam("work.review", { id: proposed.id, decision: "approve" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("dependency cycle");
    expect(await w.deps()).toEqual(before);
    expect((await w.ok<{ proposals: Shown[] }>(await w.call.pat("work.proposals", {}))).proposals.map((p) => p.id)).toEqual([proposed.id]);
    await w.ok(await w.call.sam("work.review", { id: proposed.id, decision: "reject", note: "superseded" }));
  });

  it("checks a proposal when it is filed, and again against deleted items when it is approved", async () => {
    const w = await world();
    const [a, b] = [await w.file("A"), await w.file("B")];
    await w.ok(await w.call.pat("work.depend", { id: b.ref, on: a.ref }));
    expect((await w.call.pat("work.propose", { reason: "loop", add: [{ prerequisite: b.ref, dependent: a.ref }] })).status).toBe(400);
    expect((await w.call.pat("work.propose", { reason: "typo", add: [{ prerequisite: "new:nope", dependent: a.ref }] })).status).toBe(400);
    expect((await w.call.pat("work.propose", { reason: "empty" })).status).toBe(400);
    const c = await w.file("C");
    const proposed = await w.ok<Shown>(await w.call.pat("work.propose", { reason: "c before a", add: [{ prerequisite: c.ref, dependent: a.ref }] }));
    await w.ok(await w.call.sam("work.delete", { id: c.ref, confirm: c.ref }));
    expect((await w.call.sam("work.review", { id: proposed.id, decision: "approve" })).status).toBe(400);
    expect(await w.deps()).toEqual([{ prereq_id: a.item.id, dependent_id: b.item.id }]);
  });
});
