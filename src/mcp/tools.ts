import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { connectionScopes, type Ctx } from "../auth/context";
import { projectFeatures, type ProjectFeature } from "../projectFeatures";
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
export function toolDefinition(v: VerbDef<unknown, unknown>, ctx?: Ctx): Tool {
  const mcp = v.mcp!;
  const input = structuredClone(mcp.input) as Tool["inputSchema"];
  if (ctx?.mcpProject) {
    delete input.properties?.project;
    if (v.name === "mail.send") delete input.properties?.from_project;
    input.required = input.required?.filter(k => k !== "project");
    if (v.name === "work.propose") {
      const items = (input.properties?.new_items as { items?: { properties?: Record<string, unknown> } } | undefined)?.items;
      if (items?.properties) delete items.properties.project;
    }
  }
  return {
    name: toolName(v.name),
    title: mcp.title,
    description: [v.summary, SCOPE_LINE[mcp.scope], ...(mcp.destructive ? [DESTRUCTIVE_LINE] : []), DATA_NOTE].join("\n"),
    inputSchema: input,
    annotations: { title: mcp.title, readOnlyHint: v.kind === "query", destructiveHint: mcp.destructive, idempotentHint: v.kind === "query", openWorldHint: false },
  };
}

/** The tools this request may see: recomputed from the token's scopes and the human's current role (MCP spec 8.5, 10.4). */
export function toolsFor(ctx: Ctx): VerbDef<unknown, unknown>[] {
  const verbs = exposedVerbs(ctx.role, mcpScopes(ctx));
  if (!ctx.mcpProject) return verbs;
  const features = projectFeatures(ctx.mcpProject.kind);
  const families: Record<string, ProjectFeature> = { work: "docket", repo: "repo", wiki: "wiki", kb: "knowledge", research: "knowledge", file: "files", doc: "files", person: "people", company: "people", connection: "people", graph: "people" };
  // Opt in only families whose resource references obey the endpoint's boundary.
  return verbs.filter(v => {
    const feature = families[v.name.split(".")[0]!];
    if (feature) return features.includes(feature);
    return features.includes("docket") && (["mail.list", "mail.read", "mail.reply"].includes(v.name) || (ctx.identity?.kind === "human" && v.name === "mail.send"));
  });
}

/** The scopes an MCP-style call runs with: the assistant grant's, the Playground's choice, or an agent token's; nothing otherwise. */
export function mcpScopes(ctx: Ctx): string[] {
  return connectionScopes(ctx) ?? [];
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
  ctx: Ctx, kind: "mcp.call" | "mcp.denied" | "playground.call" | "playground.denied", target: string, outcome: string, args: Record<string, unknown>, verb: VerbDef<unknown, unknown> | undefined,
  keysOnly: boolean,
): Promise<void> {
  const label = verb ? target : quotedName(target, 64);
  const summary = `${label} ${outcome} {${argSummary(args, declaredKeys(verb), keysOnly || !verb || verb.mcp?.auditKeysOnly === true)}}`;
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

/** Conservative opt-in: a malformed result or classifier failure keeps the normal audit. Commands never qualify. */
export function isQuietPoll(verb: VerbDef<unknown, unknown>, result: unknown): boolean {
  if (verb.kind !== "query" || !verb.quietPoll) return false;
  try { return verb.quietPoll(result) === true; } catch { return false; }
}

/** Run as the grant's session. All failures/denials and nonempty calls are audited; confirmed-empty polls log debug. */
export async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const verb = toolsFor(ctx).find((v) => toolName(v.name) === name);
  const call = ctx.playground ? "playground.call" : "mcp.call";
  if (!verb) {
    await audit(ctx, ctx.playground ? "playground.denied" : "mcp.denied", name, "denied", args, undefined, true);
    await audit(ctx, call, name, "denied", args, undefined, true);
    if (name === "project_delete") return errorResult("forbidden", "project deletion is human-only; sign in on the web as an admin, archive the project and type its slug to confirm");
    return errorResult("not_found", `no tool named ${quotedName(name, 64)} is available to this connection`);
  }
  try {
    if (ctx.mcpProject) {
      if (args.project !== undefined && args.project !== ctx.mcpProject.slug) throw new HubError(403, "forbidden", "this endpoint is scoped to one project");
      if (verb.name === "mail.send" && args.from_project !== undefined && args.from_project !== ctx.mcpProject.slug) throw new HubError(403, "forbidden", "this endpoint is scoped to one project");
      args = { ...args, project: ctx.mcpProject.slug, ...(verb.name === "mail.send" ? { from_project: ctx.mcpProject.slug } : {}) };
      if (verb.name.startsWith("work.")) {
        // A cross-project dependency/resource must not reveal another project's work
        // or silently change readiness. Use the organization endpoint for such graphs.
        const outside = await ctx.db.prepare(`SELECT 1 FROM work_dep d
          JOIN work_item a ON a.id = d.prereq_id JOIN work_item b ON b.id = d.dependent_id
          WHERE d.tenant_id = ? AND ((a.project_id = ? AND b.project_id != ?) OR (b.project_id = ? AND a.project_id != ?))
          UNION ALL SELECT 1 FROM work_resource a JOIN work_resource b ON a.name = b.name
          JOIN work_item wa ON wa.id = a.item_id JOIN work_item wb ON wb.id = b.item_id
          WHERE wa.tenant_id = ? AND wb.tenant_id = ? AND wa.project_id = ? AND wb.project_id != ? LIMIT 1`)
          .bind(ctx.tenant!.id, ctx.mcpProject.id, ctx.mcpProject.id, ctx.mcpProject.id, ctx.mcpProject.id,
            ctx.tenant!.id, ctx.tenant!.id, ctx.mcpProject.id, ctx.mcpProject.id).first();
        if (outside) throw new HubError(403, "forbidden", "this work graph crosses project boundaries; use the organization MCP endpoint");
      }
    }
    const result = await runVerb(ctx, verb, args);
    // Render before classifying success: a rendering failure must still receive its failure audit.
    const rendered = toolResult(verb, result);
    if (isQuietPoll(verb, result)) {
      // Only fixed metadata, never arguments, results, cursors, mailbox or message content.
      console.debug(JSON.stringify({ msg: "mcp.poll", via: ctx.playground ? "playground" : "mcp", verb: verb.name, outcome: "empty" }));
    } else await audit(ctx, call, verb.name, "ok", args, verb, false);
    return rendered;
  } catch (e) {
    if (!(e instanceof HubError)) console.error("tool failed", verb.name, e instanceof Error ? e.name : "error");
    const reason = e instanceof HubError ? e.reason : "internal";
    await audit(ctx, call, verb.name, reason, args, verb, reason === "bad_request");
    return errorResult(reason, e instanceof HubError ? e.detail ?? e.reason : "internal error");
  }
}
