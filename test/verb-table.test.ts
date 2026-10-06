import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getVerb, listVerbs } from "../src/verbs/table";
import { registerAllVerbs } from "../src/verbs/index";
import { rank } from "../src/auth/context";
import { mcpViolations } from "../src/mcp/policy";
import type { Role } from "../src/db/types";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

beforeAll(() => registerAllVerbs());

type Decl = { scope: string; minRole: string; fresh: number | null; longLived?: true; humanOnly?: true; mcp?: "read" | "write" };
const T = (scope: string, minRole: string, fresh: number | null, flags: Partial<Decl> = {}): Decl => ({ scope, minRole, fresh, ...flags });

const TABLE: Record<string, Decl> = {
  bootstrap: T("hub", "public", null),
  whoami: T("public", "public", null, { longLived: true, mcp: "read" }),
  "tenant.create": T("hub", "root", 60), "tenant.archive": T("hub", "root", 60), "tenant.unarchive": T("hub", "root", 60), "tenant.list": T("hub", "root", null),
  "namespace.create": T("tenant", "admin", 60), "namespace.archive": T("tenant", "admin", 60), "namespace.unarchive": T("tenant", "admin", 60),
  "project.create": T("tenant", "member", null), "project.archive": T("tenant", "admin", 60), "project.unarchive": T("tenant", "admin", 60), "project.list": T("tenant", "reader", null, { mcp: "read" }),
  "invite.create": T("tenant", "admin", 60), "invite.revoke": T("tenant", "admin", 60), "invite.list": T("tenant", "admin", null),
  "session.list": T("public", "public", null), "session.revoke": T("public", "public", null), "session.end": T("public", "public", null),
  "session.start": T("tenant", "reader", null, { longLived: true }),
  "session.git": T("public", "public", 60, { humanOnly: true }),
  "login.request": T("hub", "public", null), "login.verify": T("hub", "public", null),
  "consent.list": T("public", "public", null), "consent.revoke": T("public", "public", null),
  "agent.create": T("public", "public", 60, { humanOnly: true }), "agent.archive": T("public", "public", 60, { humanOnly: true }),
  "token.create": T("public", "public", 60, { humanOnly: true }), "token.revoke": T("public", "public", 60, { humanOnly: true }),
  "token.list": T("public", "public", null, { humanOnly: true }),
  "event.list": T("tenant", "member", null, { mcp: "read" }),
  "channel.create": T("tenant", "member", null, { humanOnly: true }), "channel.set_topic": T("tenant", "member", null, { humanOnly: true }),
  "channel.add_agent": T("tenant", "member", null, { humanOnly: true }), "channel.remove_agent": T("tenant", "member", null, { humanOnly: true }),
  "channel.set_agent_policy": T("tenant", "member", null, { humanOnly: true }),
  "channel.archive": T("tenant", "admin", 60), "channel.unarchive": T("tenant", "admin", 60),
  "chat.post": T("tenant", "member", null), "chat.edit": T("tenant", "member", null), "chat.retract": T("tenant", "member", null),
  "chat.conversations": T("tenant", "reader", null),
  "chat.agent_mute": T("tenant", "reader", null), "chat.agent_unmute": T("tenant", "member", 60, { humanOnly: true }),
  "chat.agents_disable": T("tenant", "admin", null), "chat.agents_enable": T("tenant", "admin", 60),
  "oauth.grant.approve": T("hub", "public", 600, { humanOnly: true }),
};

const verbs = () => listVerbs().filter((v) => !v.name.startsWith("test."));
const hostFor = (scope: string) => (scope === "tenant" ? "acme.pimwell.test" : "pimwell.test");

describe("verb table", () => {
  it("declares every verb exactly as the table says", () => {
    expect(verbs().map((v) => v.name).sort()).toEqual(Object.keys(TABLE).sort());
    for (const v of verbs()) {
      const d = TABLE[v.name]!;
      const got: Decl = { scope: v.scope, minRole: v.minRole, fresh: v.freshProofMinutes };
      if (v.longLivedToken) got.longLived = true;
      if (v.humanOnly) got.humanOnly = true;
      if (v.mcp) got.mcp = v.mcp.scope;
      expect({ name: v.name, ...got }).toEqual({ name: v.name, ...d });
      if (v.kind === "query") expect(v.freshProofMinutes).toBeNull();
    }
  });
  it("keeps every MCP-exposed verb inside MCP spec 8.3", () => {
    for (const v of verbs()) expect({ verb: v.name, violations: mcpViolations(v) }).toEqual({ verb: v.name, violations: [] });
  });


  it("demands fresh proof from a stale browser session on every verb that declares it", async () => {
    await seedTenant("acme");
    const root = await seedHuman("root@example.com", { is_root: true });
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 601 * 60_000, root.session.id).run();
    for (const v of verbs().filter((x) => x.freshProofMinutes !== null)) {
      const res = await apiPost(hostFor(v.scope), v.name, {}, bearer(root.token));
      expect({ verb: v.name, status: res.status, error: ((await res.json()) as any).error }).toEqual({ verb: v.name, status: 403, error: "reproof_required" });
    }
  });

  it("enforces the minimum role on every role-gated verb", async () => {
    const acme = await seedTenant("acme");
    const reader = await seedHuman("r@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
    // A reader on acme (tenant verbs) or a non-root on the apex (hub verbs) is below every gate except reader-level ones.
    for (const v of verbs().filter((x) => x.minRole !== "public" && rank(x.minRole as Role) > rank("reader"))) {
      const res = await apiPost(hostFor(v.scope), v.name, {}, bearer(reader.token));
      expect({ verb: v.name, status: res.status, error: ((await res.json()) as any).error }).toEqual({ verb: v.name, status: 403, error: "forbidden" });
    }
  });

  it("refuses a long-lived token on every verb but session.start and whoami", async () => {
    const acme = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, op.identity);
    for (const v of verbs()) {
      const body = v.name === "session.start" ? { label: "x" } : {};
      const res = await apiPost("acme.pimwell.test", v.name, body, bearer(s.longLived));
      const expected = v.longLivedToken ? 200 : v.scope === "hub" ? 404 : 403;
      expect({ verb: v.name, status: res.status }).toEqual({ verb: v.name, status: expected });
    }
  });

  it("refuses agent runs on every human-only verb", async () => {
    const acme = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, op.identity);
    for (const v of verbs().filter((x) => x.humanOnly)) {
      const res = await apiPost("acme.pimwell.test", v.name, {}, bearer(s.token));
      // Hub verbs do not exist on a tenant host, and an agent credential is anonymous on the apex.
      expect({ verb: v.name, status: res.status }).toEqual({ verb: v.name, status: v.scope === "hub" ? 404 : 403 });
    }
  });

  it("lets no chat verb take an author, display name, or avatar (messaging spec 4.6)", () => {
    const AUTHORISH = /^(author|author_id|by|from|as|on_behalf_of|identity|identity_id|display_name|name_tag|avatar|handle|session_id)$/;
    for (const v of verbs().filter((x) => /^(chat|channel|inbox|ref)\./.test(x.name))) {
      expect({ verb: v.name, keys: Object.keys(v.mcp?.input.properties ?? {}).filter((k) => AUTHORISH.test(k)) }).toEqual({ verb: v.name, keys: [] });
    }
    const p = getVerb("chat.post")!.parse({ c: "general", body: "hi", author_id: "x", display_name: "x", avatar: "x", handle: "x", session_id: "x" }) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["after", "body", "c", "idempotency_key", "refs", "reply_to"]);
  });
});
