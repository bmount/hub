import type { Ctx } from "../auth/context";
import type { Role } from "../db/types";

export type VerbScope = "public" | "hub" | "tenant";

/** JSON Schema (draft 2020-12) for an MCP tool's arguments; `verb.parse` stays the validator of record. */
export type McpInputSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

/**
 * MCP exposure (MCP spec 8.2). Opt-in per verb; the table test enforces MCP spec 8.3 on every verb that sets it.
 * `render`: verbs whose results carry member-written text (messages) write their own text with the chat renderer
 * (messaging spec 11.3); the tool result then starts with DATA_NOTE and its structuredContent is cleaned.
 */
export type McpDecl = { scope: "read" | "write"; destructive: boolean; title: string; input: McpInputSchema; render?: (result: unknown) => string };

export type VerbDef<P, R> = {
  name: string;
  kind: "query" | "command";
  scope: VerbScope;
  minRole: Role | "public";
  freshProofMinutes: number | null;
  summary: string;
  /** Callable with a long-lived pmw_ token. Spec 6.5: only session.start and whoami. */
  longLivedToken?: boolean;
  /** Refused for agent identities: agents never create agents or manage credentials (spec 2). */
  humanOnly?: boolean;
  /** For form posts: render this HTML body instead of redirecting (used to show a new token once). */
  renderForm?: (result: R) => string;
  /** For form posts with `_back=@result`: where the result lives (a new work item opens in the workbench). */
  formBack?: (result: R) => string;
  /** Exposed as an MCP tool to assistant connections holding this scope. */
  mcp?: McpDecl;
  parse: (input: Record<string, unknown>) => P;
  run: (ctx: Ctx, params: P) => Promise<R>;
};

const REGISTRY = new Map<string, VerbDef<unknown, unknown>>();

export function defineVerb<P, R>(def: VerbDef<P, R>): VerbDef<P, R> {
  return def;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerVerbs(defs: Array<VerbDef<any, any>>): void {
  for (const d of defs) REGISTRY.set(d.name, d as VerbDef<unknown, unknown>);
}

export function getVerb(name: string): VerbDef<unknown, unknown> | undefined {
  return REGISTRY.get(name);
}

export function listVerbs(): VerbDef<unknown, unknown>[] {
  return [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}
