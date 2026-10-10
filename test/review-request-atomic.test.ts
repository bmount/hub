// Request effects must commit together. Faults are injected only into isolated test D1.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { setArdiForTest } from "../src/code/ardi";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
afterEach(async () => {
  setArdiForTest(null);
  await env.HUB_DB.exec("DROP TRIGGER IF EXISTS fail_review_attention; DROP TRIGGER IF EXISTS fail_review_event; DROP TRIGGER IF EXISTS fail_review_review_reviewer;");
});

async function world() {
  const t = await seedTenant("acme");
  const project = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  setArdiForTest({ fetch: async () => Response.json({ ok: true, result: { commits: [{ oid: "b".repeat(40), summary: "Faster prices" }] }, next: null }) } as unknown as Fetcher);
  const request = (body: Record<string, unknown> = {}) => apiPost(HOST, "review.request", { project: "site", branch: "faster", ...body }, cookieHeaders(sam.token, HOST));
  const count = async (table: "review" | "review_reviewer" | "attention" | "event") => {
    const where = table === "event" ? " WHERE kind = 'review.request'" : "";
    return (await env.HUB_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).first<{ n: number }>())!.n;
  };
  return { t, project, sam, pat, request, count };
}

async function failAt(stage: "review_reviewer" | "attention" | "event") {
  // D1 batch must roll back earlier statements when this later statement aborts.
  const condition = stage === "event" ? "WHEN NEW.kind = 'review.request'" : stage === "attention" ? "WHEN NEW.reason = 'assigned'" : "";
  await env.HUB_DB.prepare(`CREATE TRIGGER fail_review_${stage} BEFORE INSERT ON ${stage} ${condition} BEGIN SELECT RAISE(ABORT, 'injected review effect failure'); END`).run();
}

describe("atomic review request", () => {
  for (const stage of ["review_reviewer", "attention", "event"] as const) {
    it(`rolls back review, reviewers, attention and event on ${stage} failure; explicit subsequent creation uses number one`, async () => {
      const w = await world();
      await failAt(stage);
      const failed = await w.request({ reviewers: ["pat@example.com"] });
      expect(failed.status).toBe(500);
      for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(0);
      await env.HUB_DB.exec(`DROP TRIGGER fail_review_${stage}`);
      const successful = await w.request({ reviewers: ["pat@example.com"] });
      expect(successful.status).toBe(200);
      expect((await successful.json() as { result: { ref: string } }).result.ref).toBe("site!1");
      for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(1);
    });
  }

  for (const reviewers of [[], ["sam@example.com"]]) {
    it(`opens with no external attention recipients: ${JSON.stringify(reviewers)}`, async () => {
      const w = await world();
      const response = await w.request({ reviewers });
      expect(response.status).toBe(200);
      const { result } = await response.json() as { result: { ref: string; review: { id: string; slug: string; author: string; number: number } } };
      expect(result).toMatchObject({ ref: "site!1", review: { slug: "site", number: 1 } });
      expect(await w.count("review")).toBe(1);
      expect(await w.count("review_reviewer")).toBe(reviewers.length);
      expect(await w.count("attention")).toBe(0);
      expect(await w.count("event")).toBe(1);
      const event = await env.HUB_DB.prepare("SELECT target_id, summary FROM event WHERE kind = 'review.request'").first();
      expect(event).toMatchObject({ target_id: result.review.id, summary: "Opened review site!1 (faster into main): Faster prices" });
    });
  }

  it("deduplicates reviewers, derives scoped actual numbers/links and caps inert attention summaries", async () => {
    const w = await world();
    for (let n = 1; n <= 2; n++) {
      const response = await w.request({ reviewers: ["pat@example.com", "PAT@example.com", "sam@example.com"], title: "<script>" + "x".repeat(192) });
      expect(response.status).toBe(200);
      const { result } = await response.json() as { result: { ref: string; review: { id: string } } };
      expect(result.ref).toBe(`site!${n}`);
      const attention = await env.HUB_DB.prepare("SELECT tenant_id, identity_id, actor_id, href, summary FROM attention WHERE href = ?").bind(`/site/reviews/${n}`).first<{ summary: string }>();
      expect(attention).toMatchObject({ tenant_id: w.t.id, identity_id: w.pat.identity.id, actor_id: w.sam.identity.id, href: `/site/reviews/${n}` });
      expect(attention!.summary).toContain(`asked you to review site!${n}: <script>`);
      expect(attention!.summary.length).toBeLessThanOrEqual(300);
      const event = await env.HUB_DB.prepare("SELECT tenant_id, identity_id, target_kind, target_id, summary FROM event WHERE kind = 'review.request' AND target_id = ?").bind(result.review.id).first<{ summary: string }>();
      expect(event).toMatchObject({ tenant_id: w.t.id, identity_id: w.sam.identity.id, target_kind: "review", target_id: result.review.id });
      expect(event!.summary).toContain(`Opened review site!${n} (faster into main)`);
    }
    expect(await w.count("review")).toBe(2);
    expect(await w.count("review_reviewer")).toBe(4);
    expect(await w.count("attention")).toBe(2);
    expect(await w.count("event")).toBe(2);
  });

  it("allocates actual distinct numbers and one event each for concurrent creations", async () => {
    const w = await world();
    const responses = await Promise.all(Array.from({ length: 4 }, () => w.request()));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const results = await Promise.all(responses.map(async (r) => (await r.json() as { result: { ref: string } }).result));
    expect(results.map((r) => r.ref).sort()).toEqual(["site!1", "site!2", "site!3", "site!4"]);
    expect(await w.count("review")).toBe(4);
    expect(await w.count("event")).toBe(4);
    expect(await w.count("review_reviewer")).toBe(0);
    expect(await w.count("attention")).toBe(0);
  });

  it("rejects missing branches before creating any effects", async () => {
    const w = await world();
    setArdiForTest({ fetch: async () => Response.json({ ok: true, result: { commits: [] }, next: null }) } as unknown as Fetcher);
    const response = await w.request({ reviewers: ["pat@example.com"] });
    expect(response.status).toBe(404);
    for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(0);
  });

  it("rejects a different-tenant reviewer before creating any effects", async () => {
    const w = await world();
    const other = await seedTenant("other");
    await seedHuman("outside@example.com", { memberships: [{ tenant_id: other.id, role: "member" }] });
    const response = await w.request({ reviewers: ["pat@example.com", "outside@example.com"] });
    expect(response.status).toBe(400);
    for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(0);
  });
});
