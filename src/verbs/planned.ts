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
  { name: "work.board", area: "work", kind: "query", minRole: "reader", title: "Work board",
    summary: "Quests with their progress, and items grouped by state, for one project or the organization.",
    spec: "Columns open, doing, done; quest progress bars; who is on what; stalled items (no activity in 7 days) flagged.",
    input: { project: S("Project slug; omit for the organization") } },
  { name: "work.search", area: "work", kind: "query", minRole: "reader", title: "Search work",
    summary: "Full-text search over titles, details, comments and source quotes.",
    spec: "Ranked results with snippets; filters for kind, state, owner, quest; refs like site#3 jump directly.",
    input: { q: S("Words to find"), project: S("Limit to a project") }, required: ["q"] },
  { name: "work.bulk_update", area: "work", kind: "command", minRole: "member", title: "Change many items",
    summary: "Change state, owner, kind or quest on many items at once.",
    spec: "One audited change per item; preview before applying; undo within ten minutes.",
    input: { ids: { type: "array", items: { type: "string" }, description: "Items to change" }, state: S("open, doing, done or dropped"), owner: S("me, an email, or none"), parent: I("Quest number") }, required: ["ids"] },
  // Code (through the git host)
  { name: "repo.branches", area: "code", kind: "query", minRole: "reader", title: "Branches",
    summary: "Every branch of a repository, with how far ahead or behind main it is and its last commit.",
    spec: "Branch-aware by default: nothing is hidden on a branch; stale branches flagged; linked work items shown.",
    input: { project: S("Repository project slug") }, required: ["project"] },
  { name: "repo.log", area: "code", kind: "query", minRole: "reader", title: "Commits",
    summary: "Commits on a branch or path, newest first, with the work items they deliver.",
    spec: "Paged; follows renames; each commit links to the items and reviews that mention it.",
    input: { project: S("Repository"), ref: S("Branch, tag or commit"), path: S("Limit to a path") }, required: ["project"] },
  { name: "repo.file", area: "code", kind: "query", minRole: "reader", title: "Read a file",
    summary: "A file's contents at a branch, tag or commit.",
    spec: "Text up to 1 MB, binary as metadata; blame on request; links to the commits that last touched each line.",
    input: { project: S("Repository"), path: S("File path"), ref: S("Branch, tag or commit; default main") }, required: ["project", "path"] },
  { name: "repo.diff", area: "code", kind: "query", minRole: "reader", title: "Compare",
    summary: "The changes between two refs, file by file.",
    spec: "Unified diff with stats; large files summarized; the base defaults to the merge base with main.",
    input: { project: S("Repository"), from: S("Base ref"), to: S("Head ref") }, required: ["project", "to"] },
  { name: "repo.search", area: "code", kind: "query", minRole: "reader", title: "Search code",
    summary: "Search the code of a repository at a ref.",
    spec: "Literal and regular-expression search with file and line results, across all branches on request.",
    input: { project: S("Repository"), q: S("What to find"), ref: S("Default main") }, required: ["project", "q"] },
  // Reviews
  { name: "review.request", area: "review", kind: "command", minRole: "member", title: "Ask for review",
    summary: "Ask people or agents to review a branch or a range of commits.",
    spec: "A review has a head and base, reviewers (people or agents), linked work items, and a status; reviewer agents say what should change, not just whether.",
    input: { project: S("Repository"), branch: S("Branch to review"), reviewers: { type: "array", items: { type: "string" }, description: "Emails of people or agents" }, summary: S("What changed and why") }, required: ["project", "branch"] },
  { name: "review.list", area: "review", kind: "query", minRole: "reader", title: "Reviews",
    summary: "Open reviews, with the ones waiting on you first.",
    spec: "Filters: mine to do, mine waiting, project, status; each row shows size, age, and verdicts so far.",
    input: { project: S("Limit to a repository"), mine: { type: "boolean" } } },
  { name: "review.read", area: "review", kind: "query", minRole: "reader", title: "Read a review",
    summary: "One review: its diff, comments by file and line, and verdicts.",
    spec: "Diff grouped by file; comments anchored to lines survive new pushes; outdated comments marked.",
    input: { id: S("Review id or project!number") }, required: ["id"] },
  { name: "review.comment", area: "review", kind: "command", minRole: "member", title: "Comment on a review",
    summary: "Comment on a review overall, or on a file and line.",
    spec: "Suggested changes can be applied with one click; threads resolve; agents' comments are marked as such.",
    input: { id: S("Review"), body: S("The comment"), path: S("File"), line: I("Line in the new version") }, required: ["id", "body"] },
  { name: "review.verdict", area: "review", kind: "command", minRole: "member", title: "Give a verdict",
    summary: "Approve a review, or ask for changes, with your reasons.",
    spec: "Verdicts are per reviewer and reset when new commits change reviewed lines.",
    input: { id: S("Review"), verdict: { type: "string", enum: ["approve", "changes"] }, reason: S("Why") }, required: ["id", "verdict"] },
  { name: "review.integrate", area: "review", kind: "command", minRole: "member", title: "Integrate",
    summary: "Merge an approved review into its base branch.",
    spec: "Integrates by default once approved and checks pass; refuses when the base moved and conflicts; records the merge commit on linked work.",
    input: { id: S("Review") }, required: ["id"] },
  // Messaging
  { name: "mail.reply", area: "messaging", kind: "command", minRole: "member", title: "Reply by mail",
    summary: "Reply to mail received at a project address, from that address.",
    spec: "Golden rule: only to an address that wrote to us first, within limits and kill switches; the reply joins the thread and the work it produced.",
    input: { id: S("Mail id"), body: S("The reply") }, required: ["id", "body"] },
  { name: "message.search", area: "messaging", kind: "query", minRole: "reader", title: "Search conversations",
    summary: "Search messages in the conversations you can read.",
    spec: "Ranked results with the thread around each hit; filters for channel, person and date.",
    input: { q: S("Words to find"), c: S("Limit to a channel") }, required: ["q"] },
  // Traces and deploys
  { name: "trace.list", area: "traces", kind: "query", minRole: "reader", title: "Traces and errors",
    summary: "Recent errors and slow requests, each mapped to the code and commit that caused it.",
    spec: "Grouped by cause; each group links to the file and line, the deploy and commit that introduced it, and work filed about it.",
    input: { project: S("Limit to a project"), since: S("ISO 8601 time") } },
  { name: "trace.read", area: "traces", kind: "query", minRole: "reader", title: "Read a trace",
    summary: "One trace or error group: spans, stack, the request, and the code behind it.",
    spec: "Stack frames link to repo.file at the deployed commit; file a snag from it with one call.",
    input: { id: S("Trace or group id") }, required: ["id"] },
  { name: "deploy.record", area: "traces", kind: "command", minRole: "member", title: "Record a deploy",
    summary: "Record that a commit was deployed to an environment.",
    spec: "Deploys tie traces to commits; the Docket shows which work is live; a deploy can be marked rolled back.",
    input: { project: S("Project"), commit: S("Commit id"), environment: S("production, staging, …") }, required: ["project", "commit"] },
  { name: "deploy.list", area: "traces", kind: "query", minRole: "reader", title: "Deploys",
    summary: "Deploys by environment, with the work and commits each one shipped.",
    spec: "Newest first; the difference between two deploys as commits and work items.",
    input: { project: S("Project"), environment: S("Environment") } },
  // Search
  { name: "search.query", area: "search", kind: "query", minRole: "reader", title: "Search everything",
    summary: "One search over work, mail, conversations, code and people.",
    spec: "Grouped results; refs and names jump directly; respects every access rule of the underlying records.",
    input: { q: S("What to find") }, required: ["q"] },
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
