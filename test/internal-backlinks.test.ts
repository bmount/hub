import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { internalBacklinks } from "../src/http/internalBacklinks";
import { channelWith, chatWorld, ok } from "./chat-helpers";

const SECRET = "test-internal-secret";
const req = (body: unknown, headers: Record<string, string> = { "x-hub-internal": SECRET }) =>
  new Request("https://hub.internal/internal/backlinks", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("/internal/backlinks", () => {
  it("answers Ardi with ids and links, filtered to what the asserted principal can read", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await ok(w.lead.token, "channel.create", { slug: "ops" });
    await ok(w.lead.token, "chat.post", { c: "general", body: "see site#k7q2" });
    await ok(w.lead.token, "chat.post", { c: "ops", body: "and site#k7q2" });
    const asLead = await (await internalBacklinks(req({ tenant: "acme", principal: w.lead.identity.id, kind: "ticket", key: "site#k7q2" }), env)).json() as { ok: boolean; count: number; items: Array<{ channel: string; url: string }> };
    expect([asLead.ok, asLead.count]).toEqual([true, 2]);
    expect(asLead.items.map((i) => i.url.replace(/[0-9A-Z]{26}$/, "<id>")).sort()).toEqual(["https://acme.pimwell.test/m/<id>", "https://acme.pimwell.test/m/<id>"]);
    const asScout = await (await internalBacklinks(req({ tenant: "acme", principal: w.scout.agent.identity.id, kind: "ticket", key: "site#k7q2" }), env)).json() as { items: Array<{ channel: string }> };
    expect(asScout.items.map((i) => i.channel)).toEqual(["general"]);
    expect(JSON.stringify(asLead)).not.toContain("see site");
  });

  it("refuses without the secret, for strangers, and for kinds other than commit and ticket", async () => {
    const w = await chatWorld();
    expect((await internalBacklinks(req({ tenant: "acme", principal: w.lead.identity.id, kind: "ticket", key: "site#k7q2" }, {}), env)).status).toBe(404);
    expect(await (await internalBacklinks(req({ tenant: "acme", principal: "01NOBODY000000000000000000", kind: "ticket", key: "site#k7q2" }), env)).json()).toEqual({ ok: false });
    expect(await (await internalBacklinks(req({ tenant: "acme", principal: w.lead.identity.id, kind: "msg", key: "general/1" }), env)).json()).toEqual({ ok: false });
    const routed = await worker.fetch(req({ tenant: "acme", principal: w.lead.identity.id, kind: "ticket", key: "site#k7q2" }), env, createExecutionContext());
    expect(await routed.json()).toEqual({ ok: true, count: 0, items: [] });
  });
});
