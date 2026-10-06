import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { Ctx } from "../auth/context";
import { HubError } from "../errors";
import { recordEvent } from "../db/events";
import { runVerb } from "../verbs/dispatch";
import type { VerbDef } from "../verbs/table";
import { exposedVerbs, toolName } from "./policy";
import { renderMarkdown } from "./render";

const SCOPE_LINE: Record<string, string> = {
  read: "Scope: read. Looks things up; changes nothing.",
  write: "Scope: write. Changes things in the workspace as the user.",
};
const DESTRUCTIVE_LINE = "Destructive. Only call after the user has explicitly confirmed this exact action in the conversation; pass confirm: true.";

/** MCP spec 8.5: one tool per exposed verb. */
export function toolDefinition(v: VerbDef<unknown, unknown>): Tool {
  const mcp = v.mcp!;
  return {
    name: toolName(v.name),
    title: mcp.title,
    description: [v.summary, SCOPE_LINE[mcp.scope], ...(mcp.destructive ? [DESTRUCTIVE_LINE] : [])].join("\n"),
    inputSchema: mcp.input as Tool["inputSchema"],
    annotations: { title: mcp.title, readOnlyHint: v.kind === "query", destructiveHint: mcp.destructive, idempotentHint: v.kind === "query", openWorldHint: false },
  };
}

/** The tools this request may see: recomputed from the token's scopes and the human's current role (MCP spec 8.5, 10.4). */
export function toolsFor(ctx: Ctx): VerbDef<unknown, unknown>[] {
  return exposedVerbs(ctx.role, ctx.oauth?.scopes ?? []);
}

/** Argument keys with values cut to 64 characters; never results (MCP spec 3, 9). */
export function argSummary(args: Record<string, unknown>): string {
  return Object.keys(args).sort().map((k) => {
    const v = args[k];
    return `${k}=${(typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, 64)}`;
  }).join(", ");
}

async function audit(ctx: Ctx, kind: "mcp.call" | "mcp.denied", target: string, outcome: string, args: Record<string, unknown>): Promise<void> {
  await recordEvent(ctx.db, {
    tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind, target_kind: "verb", target_id: target.slice(0, 64),
    summary: `${target.slice(0, 64)} ${outcome} {${argSummary(args)}}`.slice(0, 500),
  }, ctx.now);
}

function errorResult(error: string, reason: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, reason }) }] };
}

/** One tools/call: run the verb through the dispatcher as the grant's session, and record it either way (MCP spec 8.5, 9). */
export async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const verb = toolsFor(ctx).find((v) => toolName(v.name) === name);
  if (!verb) {
    await audit(ctx, "mcp.denied", name, "denied", args);
    await audit(ctx, "mcp.call", name, "denied", args);
    return errorResult("not_found", `no tool named ${name.slice(0, 64)} is available to this connection`);
  }
  try {
    const result = await runVerb(ctx, verb, args);
    await audit(ctx, "mcp.call", verb.name, "ok", args);
    return { content: [{ type: "text", text: renderMarkdown(verb.name, result) }], structuredContent: result as Record<string, unknown> };
  } catch (e) {
    if (!(e instanceof HubError)) console.error("tool failed", verb.name, e instanceof Error ? e.name : "error");
    const reason = e instanceof HubError ? e.reason : "internal";
    await audit(ctx, "mcp.call", verb.name, reason, args);
    return errorResult(reason, e instanceof HubError ? e.detail ?? e.reason : "internal error");
  }
}
