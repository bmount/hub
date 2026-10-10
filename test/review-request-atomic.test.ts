// Request effects must commit together. Faults are injected only into isolated test D1.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { sha256Hex } from "../src/ids";
import { createBrowserSession } from "../src/db/sessions";
import { addMembership } from "../src/db/memberships";
import { setArdiForTest } from "../src/code/ardi";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
afterEach(async () => {
  setArdiForTest(null);
  await env.HUB_DB.exec("DROP TRIGGER IF EXISTS fail_review_attention; DROP TRIGGER IF EXISTS fail_review_event; DROP TRIGGER IF EXISTS fail_review_review_reviewer; DROP TRIGGER IF EXISTS fail_review_meta;");
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
      const failed = await w.request({ reviewers: ["pat@example.com"], idempotency_key: "rollback" });
      expect(failed.status).toBe(500);
      for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(0);
      expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key LIKE 'review_request:%'").first()).toBeNull();
      await env.HUB_DB.exec(`DROP TRIGGER fail_review_${stage}`);
      const successful = await w.request({ reviewers: ["pat@example.com"], idempotency_key: "rollback" });
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

  it("replays the original snapshot after a lost response, branch deletion and later review edits without new effects", async () => {
    const w = await world();
    const body = { reviewers: ["pat@example.com"], idempotency_key: "lost-response" };
    // The caller loses the first response, but the server's committed state survives.
    await w.request(body);
    const original = await env.HUB_DB.prepare("SELECT * FROM review").first();
    await env.HUB_DB.prepare("UPDATE review SET status = 'closed', title = 'Later title'").run();
    setArdiForTest({ fetch: async () => { throw new Error("branch is gone"); } } as unknown as Fetcher);
    const response = await w.request(body);
    expect(response.status).toBe(200);
    const result = (await response.json() as { result: Record<string, unknown> }).result;
    expect(result).toMatchObject({ ref: "site!1", replayed: true, review: original });
    for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(1);
  });

  it("returns one winner and identical review snapshots for concurrent exact-key retries", async () => {
    const w = await world();
    const body = { reviewers: ["pat@example.com"], idempotency_key: "concurrent" };
    const responses = await Promise.all(Array.from({ length: 4 }, () => w.request(body)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const results = await Promise.all(responses.map(async (r) => (await r.json() as { result: { review: unknown; replayed: boolean } }).result));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    for (const result of results) expect(result.review).toEqual(results[0]!.review);
    for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(1);
  });

  for (const change of [{ branch: "different" }, { base: "other" }, { title: "changed" }, { summary: "changed" }, { reviewers: [] }, { project: "other" }]) {
    it(`conflicts on changed intent ${JSON.stringify(change)}`, async () => {
      const w = await world();
      await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "other", kind: "repo", display_name: "Other" }, Date.now());
      const body = { reviewers: ["pat@example.com"], idempotency_key: "bound" };
      expect((await w.request(body)).status).toBe(200);
      expect((await w.request({ ...body, ...change })).status).toBe(409);
      for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(1);
    });
  }

  it("conflicts on racing changed payload without altering the winner's assignments or attention", async () => {
    const w = await world();
    const responses = await Promise.all([
      w.request({ title: "First", reviewers: ["pat@example.com"], idempotency_key: "race" }),
      w.request({ title: "Second", reviewers: ["sam@example.com"], idempotency_key: "race" }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const r = await env.HUB_DB.prepare("SELECT title FROM review").first<{ title: string }>();
    expect(await w.count("review")).toBe(1);
    expect(await w.count("event")).toBe(1);
    expect(await w.count("review_reviewer")).toBe(1);
    expect(await w.count("attention")).toBe(r!.title === "First" ? 1 : 0);
  });

  it("scopes keys by caller and tenant, not by session", async () => {
    const w = await world();
    const body = { project: "site", branch: "faster", idempotency_key: "shared" };
    expect((await w.request(body)).status).toBe(200);
    const newSam = await createBrowserSession(env.HUB_DB, w.sam.identity.id, Date.now());
    const same = await apiPost(HOST, "review.request", body, cookieHeaders(newSam.token, HOST));
    expect(same.status).toBe(200);
    expect((await same.json() as { result: { replayed: boolean } }).result.replayed).toBe(true);
    const pat = await apiPost(HOST, "review.request", body, cookieHeaders(w.pat.token, HOST));
    expect(pat.status).toBe(200);
    expect((await pat.json() as { result: { ref: string; replayed: boolean } }).result).toMatchObject({ ref: "site!2", replayed: false });
    const other = await seedTenant("other");
    await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Other site" }, Date.now());
    await addMembership(env.HUB_DB, { identity_id: w.sam.identity.id, tenant_id: other.id, role: "member" }, Date.now());
    const elsewhere = await apiPost("other.pimwell.test", "review.request", body, cookieHeaders(w.sam.token, "other.pimwell.test"));
    expect(elsewhere.status).toBe(200);
    expect((await elsewhere.json() as { result: { ref: string; replayed: boolean } }).result).toMatchObject({ ref: "site!1", replayed: false });
    expect(await w.count("review")).toBe(3);
  });

  it("checks current caller membership before exposing a stored snapshot", async () => {
    const w = await world();
    await w.request({ idempotency_key: "revoked" });
    await env.HUB_DB.prepare("UPDATE membership SET state = 'revoked' WHERE tenant_id = ? AND identity_id = ?").bind(w.t.id, w.sam.identity.id).run();
    const response = await w.request({ idempotency_key: "revoked" });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Faster prices");
    expect(await w.count("review")).toBe(1);
  });

  it("rolls back all effects if durable snapshot storage fails", async () => {
    const w = await world();
    await env.HUB_DB.prepare("CREATE TRIGGER fail_review_meta BEFORE INSERT ON meta WHEN NEW.key LIKE 'review_request:%' BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END").run();
    expect((await w.request({ reviewers: ["pat@example.com"], idempotency_key: "snapshot" })).status).toBe(500);
    for (const table of ["review", "review_reviewer", "attention", "event"] as const) expect(await w.count(table), table).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key LIKE 'review_request:%'").first()).toBeNull();
  });

  it("fails closed on corrupt durable state and never reuses its key", async () => {
    const w = await world();
    const key = `review_request:v1:${w.t.id}:${w.sam.identity.id}:${await sha256Hex("corrupt")}`;
    for (const value of ["not json", "null", "{}", JSON.stringify({ fingerprint: "bad", result: {} })]) {
      await env.HUB_DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, value).run();
      expect((await w.request({ idempotency_key: "corrupt" })).status).toBe(409);
      expect(await w.count("review")).toBe(0);
    }
  });

  it("rejects invalid or oversized reviewer lists instead of binding a silently truncated intent", async () => {
    const w = await world();
    for (const reviewers of [null, 1, ["pat@example.com", 1], [""], ["x".repeat(255)], Array(11).fill("pat@example.com")]) {
      expect((await w.request({ reviewers, idempotency_key: "invalid" })).status).toBe(400);
    }
    expect(await w.count("review")).toBe(0);
  });

  it("rejects invalid request keys instead of silently making an unkeyed review", async () => {
    const w = await world();
    for (const idempotency_key of ["", null, 1, "x".repeat(65)]) expect((await w.request({ idempotency_key })).status).toBe(400);
    expect(await w.count("review")).toBe(0);
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
