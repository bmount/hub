import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getControls } from "../src/db/chat";
import { addAgentMember, getChannelBySlug, setAgentMute } from "../src/db/chat";
import { apiPost, bearer, cookieHeaders, seedHuman } from "./helpers";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";

describe("channels", () => {
  it("are created by members, listed for humans, and listed for agents only where added", async () => {
    const w = await chatWorld();
    const reader = await seedHuman("r@example.com", { memberships: [{ tenant_id: w.acme.id, role: "reader" }] });
    expect((await ok(w.dev.token, "channel.create", { slug: "general", topic: "daily" })).channel).toEqual({ slug: "general", display_name: "general", topic: "daily", agent_policy: "open" });
    await ok(w.lead.token, "channel.create", { slug: "ops" });
    expect((await call(reader.token, "channel.create", { slug: "x" })).body.error).toBe("forbidden");
    expect((await call(w.scout.token, "channel.create", { slug: "x" })).status).toBe(403);
    await ok(w.lead.token, "channel.add_agent", { c: "general", agent: "@scout" });
    const forHuman = (await ok(reader.token, "chat.conversations")).conversations.map((c: { channel: string }) => c.channel);
    expect(forHuman).toEqual(["general", "ops"]);
    const forAgent = await ok(w.scout.token, "chat.conversations");
    expect(forAgent.conversations).toEqual([{ channel: "general", display_name: "general", topic: "daily", agent_policy: "open", head: 0, read_seq: 0 }]);
    expect((await ok(w.tidy.token, "chat.conversations")).conversations).toEqual([]);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await ok(w.scout.token, "chat.conversations")).conversations).toEqual([]);
    const ev = await env.HUB_DB.prepare("SELECT kind FROM event WHERE target_kind = 'channel' ORDER BY id").all<{ kind: string }>();
    expect(ev.results.map((e) => e.kind).sort()).toEqual(["channel.add_agent", "channel.create", "channel.create", "channel.remove_agent"]);
  });

  it("are joined by an agent only through its operator or an admin", async () => {
    const w = await chatWorld();
    await ok(w.dev.token, "channel.create", { slug: "general" });
    expect((await call(w.dev.token, "channel.add_agent", { c: "general", agent: "scout" })).status).toBe(403);
    expect((await call(w.dev.token, "channel.add_agent", { c: "general", agent: "nobody" })).status).toBe(404);
    expect((await ok(w.dev.token, "channel.add_agent", { c: "general", agent: "tidy" })).added).toBe(true);
    expect((await ok(w.lead.token, "channel.add_agent", { c: "general", agent: "scout" })).added).toBe(true);
    expect((await ok(w.lead.token, "channel.add_agent", { c: "general", agent: "scout" })).added).toBe(false);
  });

  it("restrict agents without proof (creator or admin) and open only for an admin with fresh proof", async () => {
    const w = await chatWorld();
    await ok(w.dev.token, "channel.create", { slug: "room" });
    expect((await ok(w.dev.token, "channel.set_agent_policy", { c: "room", policy: "muted" })).agent_policy).toBe("muted");
    expect((await call(w.dev.token, "channel.set_agent_policy", { c: "room", policy: "open" })).status).toBe(403);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.lead.session.id).run();
    expect((await ok(w.lead.token, "channel.set_agent_policy", { c: "room", policy: "mention_only" })).agent_policy).toBe("mention_only");
    expect((await call(w.lead.token, "channel.set_agent_policy", { c: "room", policy: "open" })).body.error).toBe("reproof_required");
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now(), w.lead.session.id).run();
    expect((await ok(w.lead.token, "channel.set_agent_policy", { c: "room", policy: "open" })).agent_policy).toBe("open");
    await ok(w.lead.token, "channel.create", { slug: "theirs" });
    expect((await call(w.dev.token, "channel.set_agent_policy", { c: "theirs", policy: "muted" })).status).toBe(403);
  });

  it("archive and unarchive by an admin; archived channels refuse changes", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await call(w.lead.token, "channel.archive", { c: "general" })).status).toBe(409);
    expect((await call(w.dev.token, "channel.set_topic", { c: "general", topic: "x" })).status).toBe(409);
    expect((await ok(w.dev.token, "chat.conversations")).conversations).toEqual([]);
    await ok(w.lead.token, "channel.unarchive", { c: "general" });
    expect((await ok(w.dev.token, "channel.set_topic", { c: "general", topic: "back" })).topic).toBe("back");
  });
});

describe("agent controls", () => {
  it("mute: the agent itself, its operator, or an admin; unmute: operator or admin", async () => {
    const w = await chatWorld();
    expect((await ok(w.scout.token, "chat.agent_mute", { agent: "scout", minutes: 5 })).agent).toBe("scout");
    expect((await call(w.dev.token, "chat.agent_mute", { agent: "scout" })).status).toBe(403);
    expect((await call(w.tidy.token, "chat.agent_mute", { agent: "scout" })).status).toBe(403);
    expect((await getControls(env.HUB_DB, w.acme.id, Date.now())).muted).toEqual([w.scout.agent.identity.id]);
    expect((await call(w.dev.token, "chat.agent_unmute", { agent: "scout" })).status).toBe(403);
    await ok(w.lead.token, "chat.agent_unmute", { agent: "scout" });
    await ok(w.dev.token, "chat.agent_mute", { agent: "tidy" });
    expect((await getControls(env.HUB_DB, w.acme.id, Date.now())).muted).toEqual([w.tidy.agent.identity.id]);
    await ok(w.dev.token, "chat.agent_unmute", { agent: "tidy" });
    expect((await getControls(env.HUB_DB, w.acme.id, Date.now())).muted).toEqual([]);
  });

  it("the tenant kill switch: admins only, enabling needs fresh proof", async () => {
    const w = await chatWorld();
    expect((await call(w.dev.token, "chat.agents_disable", {})).status).toBe(403);
    await ok(w.lead.token, "chat.agents_disable", { reason: "drill" });
    expect((await getControls(env.HUB_DB, w.acme.id, Date.now())).agents_enabled).toBe(false);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.lead.session.id).run();
    expect((await call(w.lead.token, "chat.agents_enable", {})).body.error).toBe("reproof_required");
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now(), w.lead.session.id).run();
    await ok(w.lead.token, "chat.agents_enable", {});
    expect((await getControls(env.HUB_DB, w.acme.id, Date.now())).agents_enabled).toBe(true);
  });
});

describe("channel and project separation (ruling C-2)", () => {
  it("channels stay out of project.list and the home and archive pages, and project.archive answers 404", async () => {
    const w = await chatWorld();
    await ok(w.lead.token, "project.create", { slug: "site", kind: "repo", display_name: "Site" });
    await ok(w.lead.token, "channel.create", { slug: "general" });
    const paths = (await ok(w.lead.token, "project.list", {})).projects.map((p: { path: string }) => p.path);
    expect(paths).toEqual(["site"]);
    const home = await (await SELF.fetch("https://acme.pimwell.test/", { headers: cookieHeaders(w.lead.token, "acme.pimwell.test") })).text();
    // Ruling C-2: channels never appear as projects. (Recent activity may still mention that a channel was created.)
    const projects = home.slice(home.indexOf("<h2>Projects</h2>"), home.indexOf("<h2>Open work</h2>"));
    expect(projects).toContain("site");
    expect(projects).not.toContain("general");
    expect((await call(w.lead.token, "project.archive", { slug: "general" })).status).toBe(404);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await ok(w.lead.token, "project.list", { state: "archived" })).projects).toEqual([]);
    const archive = await (await SELF.fetch("https://acme.pimwell.test/archive", { headers: cookieHeaders(w.lead.token, "acme.pimwell.test") })).text();
    expect(archive).not.toContain("general");
    expect((await call(w.lead.token, "project.unarchive", { slug: "general" })).status).toBe(404);
  });
});

describe("channel verb minors", () => {
  it("channel.archive and unarchive are human-only", async () => {
    const w = await chatWorld();
    await channelWith(w);
    expect((await call(w.scout.token, "channel.archive", { c: "general" })).status).toBe(403);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await call(w.scout.token, "channel.unarchive", { c: "general" })).status).toBe(403);
  });

  it("remove_agent works on an archived channel and for an archived agent; add_agent still needs both active", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" })).removed).toBe(true);
    expect((await call(w.lead.token, "channel.add_agent", { c: "general", agent: "scout" })).status).toBe(409);
    await ok(w.lead.token, "channel.unarchive", { c: "general" });
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: w.tidy.agent.identity.id }, bearer(w.dev.token))).status).toBe(200);
    expect((await ok(w.dev.token, "channel.remove_agent", { c: "general", agent: "tidy" })).removed).toBe(true);
    expect((await call(w.dev.token, "channel.add_agent", { c: "general", agent: "tidy" })).status).toBe(404);
  });

  it("concurrent adds of one agent add it once", async () => {
    const w = await chatWorld();
    await ok(w.lead.token, "channel.create", { slug: "general" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const input = { conversation_id: ch.project_id, tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, added_by: w.lead.identity.id };
    const results = await Promise.all([addAgentMember(env.HUB_DB, input, Date.now()), addAgentMember(env.HUB_DB, input, Date.now())]);
    expect(results.filter(Boolean).length).toBe(1);
  });
});

describe("mute never shortens (B-I1)", () => {
  it("an agent muting itself for a minute does not undo its operator's indefinite mute", async () => {
    const w = await chatWorld();
    await ok(w.lead.token, "chat.agent_mute", { agent: "scout" });
    await ok(w.scout.token, "chat.agent_mute", { agent: "scout", minutes: 1 });
    expect((await getControls(env.HUB_DB, w.acme.id, Date.now())).muted).toEqual([w.scout.agent.identity.id]);
    const left = await env.HUB_DB.prepare("SELECT muted_until, muted_by FROM agent_chat_state WHERE identity_id = ?").bind(w.scout.agent.identity.id).first<{ muted_until: number; muted_by: string }>();
    expect(left!.muted_until).toBeGreaterThan(Date.now() + 365 * 86_400_000);
    expect(left!.muted_by).toBe(w.lead.identity.id);
    await setAgentMute(env.HUB_DB, w.acme.id, w.scout.agent.identity.id, Date.now() + 1000, null, "x");
    await ok(w.lead.token, "chat.agent_unmute", { agent: "scout" });
    expect((await getControls(env.HUB_DB, w.acme.id, Date.now())).muted).toEqual([]);
  });
});
