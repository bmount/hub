import { rank } from "../auth/context";
import { listVerbs, type VerbDef } from "../verbs/table";
import type { Role } from "../db/types";

/** MCP spec 8.3: credential and access management never reaches an assistant. */
export const MCP_BANNED_PREFIXES = ["token.", "agent.", "session.", "invite.", "consent.", "membership.", "oauth.", "login.", "bootstrap"];

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** MCP spec 8.5: verb name with `.` replaced by `_`. */
export function toolName(verb: string): string {
  return verb.replace(/\./g, "_");
}

/** Every way a verb's MCP declaration breaks MCP spec 8.3 (empty when exposable, or when not exposed at all). */
export function mcpViolations(v: VerbDef<unknown, unknown>): string[] {
  if (!v.mcp) return [];
  const out: string[] = [];
  if (v.minRole === "admin" || v.minRole === "root") out.push("role above member");
  if (v.scope === "hub") out.push("hub scope");
  if (v.freshProofMinutes !== null) out.push("fresh proof");
  if (MCP_BANNED_PREFIXES.some((p) => v.name === p || v.name.startsWith(p))) out.push("credential or access verb");
  if ((v.kind === "query") !== (v.mcp.scope === "read")) out.push("scope does not match kind");
  if (v.kind === "query" && v.mcp.destructive) out.push("destructive query");
  if (!TOOL_NAME.test(toolName(v.name))) out.push("tool name");
  if (v.mcp.input.type !== "object" || v.mcp.input.additionalProperties !== false) out.push("input schema");
  return out;
}

/** MCP spec 8.1: exposed, scope granted, within the human's current role, and never above member. */
export function verbAllowed(v: VerbDef<unknown, unknown>, role: Role | null, scopes: readonly string[]): boolean {
  if (!v.mcp || mcpViolations(v).length > 0 || !scopes.includes(v.mcp.scope)) return false;
  if (v.minRole === "public") return true;
  return rank(role) >= rank(v.minRole) && rank(v.minRole) <= rank("member");
}

export function exposedVerbs(role: Role | null, scopes: readonly string[]): VerbDef<unknown, unknown>[] {
  return listVerbs().filter((v) => verbAllowed(v, role, scopes));
}
