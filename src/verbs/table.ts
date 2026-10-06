import type { Ctx } from "../auth/context";
import type { Role } from "../db/types";

export type VerbScope = "public" | "hub" | "tenant";

export type VerbDef<P, R> = {
  name: string;
  kind: "query" | "command";
  scope: VerbScope;
  minRole: Role | "public";
  freshProofMinutes: number | null;
  summary: string;
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
