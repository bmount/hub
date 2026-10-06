import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { Ctx } from "../auth/context";
import { HubError } from "../errors";
import { recordEvent } from "../db/events";
import { runVerb } from "../verbs/dispatch";
import type { VerbDef } from "../verbs/table";
import { exposedVerbs, toolName } from "./policy";
import { DATA_NOTE, MCP_TEXT_LIMIT, cleanDeep, cleanText, cutText, renderMarkdown } from "./render";

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
    description: [v.summary, SCOPE_LINE[mcp.scope], ...(mcp.destructive ? [DESTRUCTIVE_LINE] : []), DATA_NOTE].join("\n"),
    inputSchema: mcp.input as Tool["inputSchema"],
    annotations: { title: mcp.title, readOnlyHint: v.kind === "query", destructiveHint: mcp.destructive, idempotentHint: v.kind === "query", openWorldHint: false },
  };
}

/** The tools this request may see: recomputed from the token's scopes and the human's current role (MCP spec 8.5, 10.4). */
export function toolsFor(ctx: Ctx): VerbDef<unknown, unknown>[] {
  return exposedVerbs(ctx.role, ctx.oauth?.scopes ?? []);
}

const ARG_VALUE_MAX = 64;
const SUMMARY_MAX = 500;

const CUT_MARK = " … (cut)";

/** A bounded copy of `v` for logging: at most a few items per level and three levels deep, strings cut short. */
function shrink(v: unknown, depth: number): unknown {
  if (typeof v === "string") return cutText(v, ARG_VALUE_MAX * 2).text;
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v !== "object") return String(v);
  if (depth >= 3) return "…";
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => shrink(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).slice(0, 8)) out[cutText(k, 32).text] = shrink((v as Record<string, unknown>)[k], depth + 1);
  return out;
}

/** One argument value as JSON, bounded before it is stringified and cut at 64 characters without splitting a pair. */
function argValue(v: unknown): string {
  const bounded = shrink(v, 0);
  if (typeof bounded === "string") {
    const { text, cut } = cutText(cleanText(bounded), ARG_VALUE_MAX);
    return JSON.stringify(text) + (cut || (v as string).length > bounded.length ? CUT_MARK : "");
  }
  const { text, cut } = cutText(cleanText(JSON.stringify(bounded) ?? "null"), ARG_VALUE_MAX);
  return text + (cut ? CUT_MARK : "");
}

/**
 * Only the argument keys the verb's MCP input schema declares are recorded, values JSON-quoted and cut to 64
 * characters; any other keys are only counted. With `keysOnly` (the arguments did not parse) no value is recorded.
 * Never results (MCP spec 3, 9).
 */
export function argSummary(args: Record<string, unknown>, declared: readonly string[] = [], keysOnly = false): string {
  const keys = Object.keys(args);
  const known = keys.filter((k) => declared.includes(k)).sort();
  const parts = known.map((k) => (keysOnly ? k : `${k}=${argValue(args[k])}`));
  if (keys.length > known.length) parts.push(`+${keys.length - known.length} other`);
  return parts.join(", ");
}

const declaredKeys = (v: VerbDef<unknown, unknown> | undefined): string[] =>
  Object.keys((v?.mcp?.input as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});

/** `text` cleaned and cut to `max` units, as a JSON string literal: names the client chose are quoted, never bare. */
const quotedName = (text: string, max: number) => JSON.stringify(cutText(cleanText(text), max).text);

async function audit(
  ctx: Ctx, kind: "mcp.call" | "mcp.denied", target: string, outcome: string, args: Record<string, unknown>, verb: VerbDef<unknown, unknown> | undefined,
  keysOnly: boolean,
): Promise<void> {
  const label = verb ? target : quotedName(target, 64);
  const summary = `${label} ${outcome} {${argSummary(args, declaredKeys(verb), keysOnly || !verb)}}`;
  await recordEvent(ctx.db, {
    tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind, target_kind: "verb",
    target_id: cutText(cleanText(target), 64).text, summary: cutText(summary, SUMMARY_MAX).text,
  }, ctx.now);
}

function errorResult(error: string, reason: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, reason }) }] };
}

/** MCP spec 8.6: Markdown text plus structuredContent; verbs with a chat renderer write their own text (messaging spec 11.3). */
export function toolResult(verb: VerbDef<unknown, unknown>, result: unknown): CallToolResult {
  const render = verb.mcp?.render;
  if (!render) return { content: [{ type: "text", text: renderMarkdown(verb.name, result) }], structuredContent: result as Record<string, unknown> };
  let text = render(result);
  if (!text.startsWith(DATA_NOTE)) text = `${DATA_NOTE}\n\n${text}`;
  return { content: [{ type: "text", text: cutText(text, MCP_TEXT_LIMIT).text }], structuredContent: cleanDeep(result) as Record<string, unknown> };
}

/** One tools/call: run the verb through the dispatcher as the grant's session, and record it either way (MCP spec 8.5, 9). */
export async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const verb = toolsFor(ctx).find((v) => toolName(v.name) === name);
  if (!verb) {
    await audit(ctx, "mcp.denied", name, "denied", args, undefined, true);
    await audit(ctx, "mcp.call", name, "denied", args, undefined, true);
    return errorResult("not_found", `no tool named ${quotedName(name, 64)} is available to this connection`);
  }
  try {
    const result = await runVerb(ctx, verb, args);
    await audit(ctx, "mcp.call", verb.name, "ok", args, verb, false);
    return toolResult(verb, result);
  } catch (e) {
    if (!(e instanceof HubError)) console.error("tool failed", verb.name, e instanceof Error ? e.name : "error");
    const reason = e instanceof HubError ? e.reason : "internal";
    await audit(ctx, "mcp.call", verb.name, reason, args, verb, reason === "bad_request");
    return errorResult(reason, e instanceof HubError ? e.detail ?? e.reason : "internal error");
  }
}
