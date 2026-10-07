// What Pimwell calls work, in one place (overnight plan, "Names"). Every display shows the plain word beside the
// Pimwell name the first time it appears; MCP and the API accept either. Rename here and nowhere else.

export type WorkKind = "wish" | "snag" | "errand" | "quest" | "call" | "spark";
export type WorkState = "open" | "doing" | "done" | "dropped";

export const KINDS: Record<WorkKind, { name: string; plural: string; plain: string; meaning: string }> = {
  wish: { name: "Wish", plural: "Wishes", plain: "feature request", meaning: "Something someone wants to exist." },
  snag: { name: "Snag", plural: "Snags", plain: "bug", meaning: "Something that does not work as it should." },
  errand: { name: "Errand", plural: "Errands", plain: "task", meaning: "A concrete piece of work with an owner." },
  quest: { name: "Quest", plural: "Quests", plain: "epic", meaning: "A larger goal made of errands, snags and wishes." },
  call: { name: "Call", plural: "Calls", plain: "decision", meaning: "Something decided, with who decided it and why." },
  spark: { name: "Spark", plural: "Sparks", plain: "idea", meaning: "Unshaped and worth keeping; can grow into a wish or a quest." },
};

export const DOCKET = { name: "The Docket", plain: "backlog" };

export const STATES: Record<WorkState, string> = { open: "Open", doing: "Under way", done: "Done", dropped: "Let go" };

const ALIASES: Record<string, WorkKind> = {
  wish: "wish", wishes: "wish", feature: "wish", "feature request": "wish", "feature-request": "wish", request: "wish",
  snag: "snag", snags: "snag", bug: "snag", bugs: "snag", defect: "snag", issue: "snag",
  errand: "errand", errands: "errand", task: "errand", tasks: "errand", todo: "errand", chore: "errand",
  quest: "quest", quests: "quest", epic: "quest", epics: "quest", project: "quest", goal: "quest",
  call: "call", calls: "call", decision: "call", decisions: "call",
  spark: "spark", sparks: "spark", idea: "spark", ideas: "spark",
};

/** A Pimwell name or a plain word ("bug", "feature request") to a kind; null when it is neither. */
export function kindOf(s: string): WorkKind | null {
  return ALIASES[s.trim().toLowerCase()] ?? null;
}

/** "Snag (bug)": the name with its plain word, for the first mention on a page or in a tool result. */
export function labelled(kind: WorkKind): string {
  return `${KINDS[kind].name} (${KINDS[kind].plain})`;
}
