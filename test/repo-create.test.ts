import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setArdiForTest } from "../src/code/ardi";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
afterEach(() => setArdiForTest(null));

const introspect = async (token: string, tenant = "acme") => (await (await SELF.fetch("https://pimwell.test/internal/introspect", {
  method: "POST", headers: { "content-type": "application/json", "x-hub-internal": "test-internal-secret" }, body: JSON.stringify({ token, tenant }),
})).json()) as { ok: boolean; role?: string; identity?: { id: string }; session?: { kind: string } };

type Seen = { path: string; name: unknown; token: string; during: Awaited<ReturnType<typeof introspect>> };

/** A git host that records each repo.create, and what the hub said about its credential at that moment. */
function fakeArdi(seen: Seen[], answer: () => Response = () => Response.json({ ok: true, result: { name: "x" } })) {
  setArdiForTest({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const token = atob(new Headers(init?.headers).get("authorization")!.slice(6)).split(":")[1]!;
      seen.push({ path: url.pathname, name: JSON.parse(String(init?.body)).name, token, during: await introspect(token) });
      return answer();
    },
  } as unknown as Fetcher);
}

const projects = async () => (await env.HUB_DB.prepare("SELECT slug FROM project WHERE kind != 'channel' ORDER BY slug").all<{ slug: string }>()).results.map((r) => r.slug);

describe("making a repo project creates its repository", () => {
  it("as a member, with a one-shot admin credential that is revoked right after", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const seen: Seen[] = [];
    fakeArdi(seen);
    const res = await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/t/acme/api/repo.create");
    expect(seen[0]!.name).toBe("site");
    expect(seen[0]!.during).toMatchObject({ ok: true, role: "admin", identity: { id: h.identity.id }, session: { kind: "repo_create" } });
    expect((await introspect(seen[0]!.token)).ok).toBe(false);
    expect(await projects()).toEqual(["site"]);
  });

  it("as an agent, recorded as the agent", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const a = await seedAgent(t, h.identity);
    const seen: Seen[] = [];
    fakeArdi(seen);
    expect((await apiPost(HOST, "project.create", { slug: "tools", kind: "repo", display_name: "Tools" }, bearer(a.token))).status).toBe(200);
    expect(seen[0]!.during).toMatchObject({ ok: true, role: "admin", identity: { id: a.agent.identity.id } });
  });

  it("the one-shot credential works nowhere else", async () => {
    const t = await seedTenant("acme");
    await seedTenant("blue");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    let other: Awaited<ReturnType<typeof introspect>> | null = null;
    let api = 0;
    setArdiForTest({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const token = atob(new Headers(init?.headers).get("authorization")!.slice(6)).split(":")[1]!;
        other = await introspect(token, "blue");
        api = (await apiPost(HOST, "project.list", {}, bearer(token))).status;
        return Response.json({ ok: true, result: { name: "site" } });
      },
    } as unknown as Fetcher);
    await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token));
    expect(other).toEqual({ ok: false });
    // Treated as no credential at all.
    expect(api).toBe((await apiPost(HOST, "project.list", {})).status);
    expect(api).not.toBe(200);
  });

  it("no repository, no project: a refusal or an unreachable git host leaves nothing behind", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    fakeArdi([], () => Response.json({ ok: false, error: { message: "invalid repository name" } }, { status: 400 }));
    expect((await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token))).status).toBe(502);
    setArdiForTest({ fetch: async () => { throw new Error("down"); } } as unknown as Fetcher);
    expect((await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token))).status).toBe(503);
    expect(await projects()).toEqual([]);
    const live = await env.HUB_DB.prepare("SELECT count(*) AS n FROM session WHERE kind = 'repo_create' AND revoked_at IS NULL").first<{ n: number }>();
    expect(live!.n).toBe(0);
  });

  it("a repository that already exists becomes the project's", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    fakeArdi([], () => Response.json({ ok: false, error: { class: "conflict", message: "repository site already exists" } }, { status: 409 }));
    expect((await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token))).status).toBe(200);
    expect(await projects()).toEqual(["site"]);
  });

  it("trackers have no repository", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const seen: Seen[] = [];
    fakeArdi(seen);
    expect((await apiPost(HOST, "project.create", { slug: "plans", kind: "tracker", display_name: "Plans" }, bearer(h.token))).status).toBe(200);
    expect(seen).toHaveLength(0);
  });
});
