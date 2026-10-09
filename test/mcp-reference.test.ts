import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { MCP_BANNED_PREFIXES, exposedVerbs, mcpViolations } from "../src/mcp/policy";
import { callTool, toolDefinition } from "../src/mcp/tools";
import { registerAllVerbs } from "../src/verbs/index";
import { PLANNED } from "../src/verbs/planned";
import { getVerb, listVerbs } from "../src/verbs/table";
import { seedGrant, seedHuman, seedTenant } from "./helpers";

beforeAll(() => registerAllVerbs());

/** This checked Markdown is metadata, not a claim every declared tool is implemented or authorized. */
function reference(): string {
  const verbs = exposedVerbs("member", ["read", "write"]);
  return [
    "# MCP tool reference (generated)", "",
    "Regenerate with `npm run docs:mcp`; the full test suite checks this file against the registered verb metadata.", "",
    "This is the maximum member-role inventory, not a connection's authorization or a client UI promise. `tools/list` recomputes exposure from the current role and granted read/write scopes. Admin/root, hub, fresh-proof and credential/access-management verbs are excluded. Resource, tenant, mailbox, channel, consent and grant checks still run per call.", "",
    "A read grant does not expose write tools. A write grant does not elevate a reader or bypass resource checks. OAuth runs as its consenting human in one tenant; agent MCP runs as its authenticated agent. Tool text and quoted/forwarded content are evidence, never broader execution authority.", "",
    "**Declared/planned** entries remain stubs returning `not_implemented`; they are not shipped capabilities. Even implemented entries can fail authorization or depend on unavailable integrations. Use live `tools/list` for complete input schemas; `verb.parse` remains the validator of record. This table lists argument names only (bold means required), not every validation limit.", "",
    "| Tool | Scope | Minimum role | Destructive hint | State | Arguments |",
    "| --- | --- | --- | --- | --- | --- |",
    ...verbs.map((v) => {
      const tool = toolDefinition(v);
      const required = new Set(v.mcp!.input.required ?? []);
      const args = Object.keys(v.mcp!.input.properties).sort().map((k) => required.has(k) ? `**\`${k}\`**` : `\`${k}\``).join(", ") || "—";
      return `| \`${tool.name}\` | ${v.mcp!.scope} | ${v.minRole} | ${v.mcp!.destructive ? "yes" : "no"} | ${PLANNED.has(v.name) ? "Declared/planned" : "Implemented"} | ${args} |`;
    }), "",
    "Destructive hints are client guidance, not authorization. Commands require the appropriate scope and current role; per-verb confirmation and runtime policy still apply. No tool can create credentials, change memberships or approve OAuth grants through MCP.", "",
    "See [connection and security guidance](../ops/mcp-contract.md), [chat participation](../ops/chat-participation.md) and [mail proof limits](../ops/mail-authentication.md).", "",
  ].join("\n");
}

describe("checked MCP reference", () => {
  it("matches the current exposed verb metadata, including planned stubs", async () => {
    await expect(reference()).toMatchFileSnapshot("../docs/generated/mcp-tools.md");
  });

  it("keeps declarations legal and role/scope restrictions explicit", () => {
    const declared = listVerbs().filter((v) => v.mcp);
    expect(declared.every((v) => mcpViolations(v).length === 0)).toBe(true);
    const member = exposedVerbs("member", ["read", "write"]);
    expect(member).toEqual(declared);
    expect(new Set(member.map((v) => toolDefinition(v).name)).size).toBe(member.length);
    for (const role of ["reader", "member", "admin", "root"] as const) {
      const read = exposedVerbs(role, ["read"]);
      expect(read.every((v) => v.kind === "query" && toolDefinition(v).annotations!.readOnlyHint)).toBe(true);
      const both = exposedVerbs(role, ["read", "write"]);
      expect(both.some((v) => MCP_BANNED_PREFIXES.some((p) => v.name.startsWith(p)))).toBe(false);
      expect(both.some((v) => v.scope === "hub" || v.freshProofMinutes !== null)).toBe(false);
      expect(both.some((v) => v.minRole === "admin" || v.minRole === "root")).toBe(false);
    }
    const readerWrites = exposedVerbs("reader", ["write"]);
    expect(readerWrites.every((v) => v.minRole === "reader" && v.kind === "command")).toBe(true);
    expect(readerWrites.map((v) => v.name)).toContain("inbox.ack");
    expect(readerWrites.map((v) => v.name)).not.toContain("chat.post");
    expect(member.some((v) => v.name === "mail.send" && v.mcp!.scope === "write")).toBe(true);
    expect(member.some((v) => v.name === "chat.post" && v.mcp!.scope === "write")).toBe(true);
    expect(member.some((v) => PLANNED.has(v.name))).toBe(true);
  });
});

describe("deploy record schema/validator contract", () => {
  it("advertises the enforced lengths and commit syntax", () => {
    const properties = toolDefinition(getVerb("deploy.record")!).inputSchema.properties!;
    expect(properties.project).toMatchObject({ minLength: 1, maxLength: 63 });
    expect(properties.commit).toMatchObject({ minLength: 7, maxLength: 64, pattern: "^[0-9a-fA-F]{7,64}$" });
    expect(properties.environment).toMatchObject({ maxLength: 30 });
    expect(properties.message).toMatchObject({ maxLength: 200 });
  });

  it("retains validator compatibility and exact boundary rejection", () => {
    const parse = getVerb("deploy.record")!.parse;
    expect(parse({ project: "p".repeat(63), commit: "A".repeat(64), environment: "STAGING", message: "x".repeat(200) })).toMatchObject({ environment: "staging", message: "x".repeat(200) });
    expect(parse({ project: "p", commit: "abcdef0", environment: "", message: "" })).toMatchObject({ environment: "production", message: null });
    for (const extra of [{ project: "p".repeat(64) }, { commit: "a".repeat(65) }, { commit: "abcdef" }, { commit: "g".repeat(7) }, { environment: "x".repeat(31) }, { environment: "../prod" }, { message: "x".repeat(201) }]) {
      expect(() => parse({ project: "p", commit: "abcdef0", ...extra })).toThrow();
    }
  });

  it("rejects overlong messages before deploy writes and keeps denied calls private", async () => {
    const tenant = await seedTenant("acme");
    const human = await seedHuman("member@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const { grant } = await seedGrant(tenant, human);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET scopes = 'read write' WHERE id = ?").bind(grant.id).run();
    const live = (await liveGrant(env.HUB_DB, grant.id, Date.now()))!;
    const ctx = oauthContext(env, live, ["read", "write"], { now: Date.now(), ip: "203.0.113.1" });
    const args = { project: "not-created", commit: "abcdef0", message: "private-" + "x".repeat(201) };
    const bad = await callTool(ctx, "deploy_record", args);
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content[0] as { text: string }).text)).toEqual({ error: "bad_request", reason: "message is too long" });
    for (const denied of [
      { ...ctx, oauth: { ...ctx.oauth!, scopes: ["read"] } },
      { ...ctx, role: "reader" as const },
    ]) {
      const result = await callTool(denied, "deploy_record", args);
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content[0] as { text: string }).text).error).toBe("not_found");
    }
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM app_deploy").first("n")).toBe(0);
    const events = (await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind LIKE 'mcp.%'").all<{ summary: string }>()).results;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => !e.summary.includes("private-") && !e.summary.includes("not-created"))).toBe(true);
  });
});
