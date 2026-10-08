// Planned capabilities: real verbs with a real shape that answer "not implemented yet" (owner, 2026-10-07: stub
// everything key over MCP, then churn through). Each one is listed on the workbench, in `capabilities`, and as an
// MCP tool, with the spec of what it will do, so whoever builds it (a person or an agent) knows the target, and
// every call to one is a logged vote for building it next. Building one: replace its entry here with the real verb.
import { defineVerb, type McpInputSchema, type VerbDef } from "./table";
import { HubError } from "../errors";

export type Area = "work" | "review" | "code" | "messaging" | "traces" | "search";

export const AREAS: Record<Area, { label: string; blurb: string }> = {
  work: { label: "Project work", blurb: "Comments, subscriptions, boards, search and bulk changes on the Docket." },
  review: { label: "Reviews", blurb: "Ask people or agents to review a branch; comments on lines; verdicts; integrate." },
  code: { label: "Code", blurb: "Every branch, its commits, files and diffs, from the git host, tied to work." },
  messaging: { label: "Messaging", blurb: "Replies from project addresses under the golden rule; one list of what needs you." },
  traces: { label: "Traces and deploys", blurb: "Errors and traces mapped to the code and commit that caused them; deploy records." },
  search: { label: "Search", blurb: "One box over work, mail, conversations, code and people." },
};

export type Plan = {
  name: string; area: Area; kind: "query" | "command"; minRole: "reader" | "member";
  title: string; summary: string; spec: string; input: McpInputSchema["properties"]; required?: string[];
};

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", minimum: 1, description });

const PLANS: Plan[] = [
  // Project work
  { name: "repo.search", area: "code", kind: "query", minRole: "reader", title: "Search code",
    summary: "Search the code of a repository at a ref.",
    spec: "Literal and regular-expression search with file and line results, across all branches on request.",
    input: { project: S("Repository"), q: S("What to find"), ref: S("Default main") }, required: ["project", "q"] },
  // Reviews
  { name: "review.integrate", area: "review", kind: "command", minRole: "member", title: "Integrate",
    summary: "Merge an approved review into its base branch.",
    spec: "Integrates by default once approved and checks pass; refuses when the base moved and conflicts; records the merge commit on linked work.",
    input: { id: S("Review") }, required: ["id"] },
  // Messaging
];

/** Verbs that are planned, by name, with their area and spec. */
export const PLANNED = new Map(PLANS.map((p) => [p.name, p]));

export function plannedIn(area: Area): Plan[] {
  return PLANS.filter((p) => p.area === area);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const plannedVerbs: Array<VerbDef<any, any>> = PLANS.map((p) => defineVerb<Record<string, unknown>, unknown>({
  name: p.name, kind: p.kind, scope: "tenant", minRole: p.minRole, freshProofMinutes: null,
  summary: `Planned, not built yet. ${p.summary}`,
  mcp: {
    scope: p.kind === "query" ? "read" : "write", destructive: false, title: `${p.title} (planned)`,
    input: { type: "object", properties: p.input, ...(p.required ? { required: p.required } : {}), additionalProperties: false },
  },
  parse: (i: Record<string, unknown>) => i,
  run: async () => { throw new HubError(501, "not_implemented", `${p.name} is planned: ${p.spec}`, { planned: true, area: p.area }); },
}));
