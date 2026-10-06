import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HUB_TAG, candidateHandle, ensureHandles, isValidHandle, nameTags, people, safeLabel, skeleton } from "../src/chat/handles";
import { seedAgent, seedGrant, seedHuman, seedTenant } from "./helpers";

// Memberships are ordered by created_at; a few milliseconds apart makes the order certain.
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("handles", () => {
  it("validates the grammar and the reserved list", () => {
    expect(isValidHandle("scout")).toBe(true);
    expect(isValidHandle("s")).toBe(false);
    expect(isValidHandle("Scout")).toBe(false);
    expect(isValidHandle("here")).toBe(false);
    expect(isValidHandle("a".repeat(25))).toBe(false);
  });

  it("maps confusable spellings to one skeleton", () => {
    expect(skeleton("sc0ut")).toBe(skeleton("scout"));
    expect(skeleton("rnay")).toBe(skeleton("may"));
    expect(skeleton("ti-dy")).toBe(skeleton("tidy"));
    expect(skeleton("lead")).not.toBe(skeleton("dev"));
  });

  it("derives a candidate from an address", () => {
    expect(candidateHandle("Dev.Ops+x@example.com")).toBe("dev-ops-x");
    expect(candidateHandle("1st@example.com")).toBe("u1st");
    expect(candidateHandle("a@example.com")).toBe("ax");
    expect(candidateHandle(`${"b".repeat(40)}@example.com`)).toBe("b".repeat(24));
  });

  it("assigns handles once, in membership order, unique by skeleton and never reserved", async () => {
    const acme = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    await tick();
    const scoutHuman = await seedHuman("scout@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    await tick();
    const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
    await tick();
    const agent = await seedAgent(acme, op.identity, "sc0ut");
    await ensureHandles(env.HUB_DB, acme.id);
    await ensureHandles(env.HUB_DB, acme.id);
    const dir = await people(env.HUB_DB, acme.id);
    expect(dir.get(op.identity.id)!.handle).toBe("op");
    expect(dir.get(scoutHuman.identity.id)!.handle).toBe("scout");
    expect(dir.get(admin.identity.id)!.handle).toBe("admin-2");
    expect(dir.get(agent.agent.identity.id)).toMatchObject({ handle: "sc0ut-2", kind: "agent", operator_id: op.identity.id, active: true });
  });
});

describe("name tags", () => {
  it("are computed from author and session: agent badge, operator, run label, via assistant", async () => {
    const acme = await seedTenant("acme");
    const lead = await seedHuman("lead@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const scout = await seedAgent(acme, lead.identity, "scout");
    const { session: oauthSession } = await seedGrant(acme, lead);
    const tagOf = await nameTags(env.HUB_DB, acme.id, [
      { author_id: scout.agent.identity.id, session_id: scout.session.id }, { author_id: lead.identity.id, session_id: oauthSession.id },
    ]);
    expect(tagOf(scout.agent.identity.id, scout.session.id)).toEqual({
      identity_id: scout.agent.identity.id, handle: "scout", display_name: "scout", kind: "agent", operator_handle: "lead",
      session_id: scout.session.id, session_label: "run-1", via_assistant: false,
    });
    expect(tagOf(lead.identity.id, oauthSession.id)).toMatchObject({ handle: "lead", kind: "human", via_assistant: true, session_label: null });
    expect(tagOf("hub", null)).toEqual(HUB_TAG);
    expect(tagOf("01UNKNOWN0000000000000000", null)).toMatchObject({ handle: "unknown" });
  });

  it("keeps only safe characters of a run label", () => {
    expect(safeLabel("nightly-2] [#1 @lead")).toBe("nightly-21lead");
    expect(safeLabel("")).toBeNull();
    expect(safeLabel(null)).toBeNull();
  });
});
