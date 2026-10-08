import { connectionScopes, rank, type Ctx } from "../auth/context";
import { HubError } from "../errors";
import { verbAllowed } from "../mcp/policy";
import type { VerbDef } from "./table";

/** Tenant verbs need a tenant host, hub verbs the apex; anything else is a 404 like an unknown tenant. */
export function checkScope(ctx: Ctx, verb: VerbDef<unknown, unknown>): void {
  if (verb.scope === "tenant" && !ctx.tenant) throw new HubError(404, "not_found");
  if (verb.scope === "hub" && ctx.host.kind !== "apex") throw new HubError(404, "not_found");
}

/** The table's rules for who may call a verb: one place for /api, the consent page, and /mcp. */
export function checkAccess(ctx: Ctx, verb: VerbDef<unknown, unknown>): void {
  // A long-lived pmw_ token may only start a run or ask whoami (spec 6.5).
  if (ctx.authKind === "token" && verb.longLivedToken !== true) {
    throw new HubError(403, "forbidden", "a long-lived token may only call session.start and whoami");
  }
  // An assistant connection runs exposed verbs only, within its scopes and the human's role (MCP spec 8.1, 8.3).
  // The Playground runs under the same rules, with the scopes the person chose (never wider than their role).
  const scopes = connectionScopes(ctx);
  if (scopes) {
    if (!verb.mcp) throw new HubError(403, "forbidden", "not available to assistant connections");
    if (!scopes || !scopes.includes(verb.mcp.scope)) throw new HubError(403, "insufficient_scope", `needs scope ${verb.mcp.scope}`);
    if (!verbAllowed(verb, ctx.role, scopes)) throw new HubError(403, "forbidden");
  }
  if (verb.minRole !== "public") {
    if (verb.scope === "tenant" && ctx.role === null) throw new HubError(404, "not_found");
    if (!ctx.identity) throw new HubError(401, "unauthorized");
    const effective = verb.scope === "hub" ? (ctx.identity.is_root === 1 ? "root" : null) : ctx.role;
    if (rank(effective) < rank(verb.minRole)) throw new HubError(403, "forbidden");
  }
  if (verb.humanOnly === true && ctx.identity && ctx.identity.kind !== "human") throw new HubError(403, "forbidden", "agents may not call this verb");
  // Fresh proof is a property of browser sessions, by cookie or bearer; agent runs, tokens, and oauth sessions are exempt (spec 6.7).
  if (verb.freshProofMinutes !== null && ctx.session && ctx.session.kind === "browser") {
    if (ctx.now - ctx.session.last_proof_at > verb.freshProofMinutes * 60_000) throw new HubError(403, "reproof_required");
  }
}

/** Scope, access, parse, run: the dispatcher for callers that are not /api (consent page, MCP tools). */
export async function runVerb(ctx: Ctx, verb: VerbDef<unknown, unknown>, input: Record<string, unknown>): Promise<unknown> {
  checkScope(ctx, verb);
  checkAccess(ctx, verb);
  return verb.run(ctx, verb.parse(input));
}
