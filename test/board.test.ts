// The board and bulk changes.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const h = cookieHeaders(pat.token, HOST);
  const call = async (verb: string, body: unknown) => ((await (await apiPost(HOST, verb, body, h)).json()) as { result: Record<string, unknown> }).result;
  await call("work.create", { project: "site", kind: "quest", title: "Launch" });
  await call("work.create", { project: "site", kind: "snag", title: "One", parent: 1 });
  await call("work.create", { project: "site", kind: "snag", title: "Two", parent: 1 });
  await call("work.create", { project: "site", kind: "errand", title: "Three" });
  return { pat, sam, h, call };
}

describe("board and bulk changes", () => {
  it("groups work by state, shows quest progress, and flags stalled items", async () => {
    const w = await world();
    await w.call("work.update", { id: "site#2", state: "done" });
    await w.call("work.update", { id: "site#3", state: "doing" });
    await env.HUB_DB.prepare("UPDATE work_item SET updated_at = ? WHERE number = 3").bind(Date.now() - 8 * 86_400_000).run();
    const b = await w.call("work.board", { project: "site" }) as { columns: Record<string, Array<{ ref: string; stalled: boolean }>>; quests: Array<{ ref: string; done: number; total: number }>; stalled: number };
    expect(b.columns.done!.map((i) => i.ref)).toEqual(["site#2"]);
    expect(b.columns.doing!.map((i) => [i.ref, i.stalled])).toEqual([["site#3", true]]);
    expect(b.quests).toMatchObject([{ ref: "site#1", done: 1, total: 2 }]);
    expect(b.stalled).toBe(1);
    const page = await (await SELF.fetch(`https://${HOST}/site/board`, { headers: w.h })).text();
    expect(page).toContain("1 of 2 done");
    expect(page).toContain('<span class="pill">stalled</span>');
  });

  it("changes many items at once, each recorded, and reports what it couldn't change", async () => {
    const w = await world();
    const r = await w.call("work.bulk_update", { ids: ["site#2", "site#3", "site#99"], owner: "sam@example.com", state: "doing" }) as { changed: string[]; failed: Array<{ id: string }> };
    expect(r.changed).toEqual(["site#2", "site#3"]);
    expect(r.failed.map((f) => f.id)).toEqual(["site#99"]);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'work.update'").first<{ n: number }>())!.n).toBe(2);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM attention WHERE reason = 'assigned'").first<{ n: number }>())!.n).toBe(2);
    const docket = await (await SELF.fetch(`https://${HOST}/site/docket`, { headers: w.h })).text();
    expect(docket).toContain('form="bulk"');
    expect(docket).toContain('action="/api/work.bulk_update"');
    const res = await SELF.fetch(`https://${HOST}/api/work.bulk_update`, {
      method: "POST", redirect: "manual", headers: { ...w.h, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" },
      body: "ids=site%234&state=done&owner=&_back=%2Fsite%2Fdocket",
    });
    expect(res.status).toBe(303);
    expect((await env.HUB_DB.prepare("SELECT state FROM work_item WHERE number = 4").first<{ state: string }>())!.state).toBe("done");
  });
});
