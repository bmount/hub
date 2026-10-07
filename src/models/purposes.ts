// What Pimwell uses models for, and the default model for each (admin spec 10.1). Admin can change any of these;
// a model_route row overrides the default for the hub or for one organization. Defaults checked against the live
// OpenAI model list on 2026-10-07; the Models and keys page flags newer families as they appear.

/** The family and version of a GPT model id, for spotting newer releases: gpt-6.1-sol -> [6, 1]. Null if not GPT. */
export function gptVersion(id: string): [number, number] | null {
  const m = id.match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** Model ids from `available` in a newer GPT version than `current`, newest first. */
export function newerModels(current: string, available: string[]): string[] {
  const cur = gptVersion(current);
  if (!cur) return [];
  return available
    .filter((id) => { const v = gptVersion(id); return v !== null && (v[0] > cur[0] || (v[0] === cur[0] && v[1] > cur[1])) && !/\d{4}-\d{2}-\d{2}$/.test(id); })
    .sort((a, b) => { const x = gptVersion(a)!, y = gptVersion(b)!; return y[0] - x[0] || y[1] - x[1] || a.localeCompare(b); });
}

export type Purpose = { id: string; title: string; why: string; provider: string; model: string };

export const PURPOSES: Purpose[] = [
  { id: "deep", title: "Deep reasoning", why: "Diagnosis from logs and code, first-principles cost estimates, the situation workflow.", provider: "openai", model: "gpt-6-astra" },
  { id: "reasoning", title: "Reasoning", why: "Summaries, plans, status reports, assignment proposals.", provider: "openai", model: "gpt-6.1-sol" },
  { id: "assistant", title: "Assistant", why: "The in-app Assistant: conversations that call Pimwell's tools for people who don't use an MCP client.", provider: "openai", model: "gpt-6.1-sol" },
  { id: "fast", title: "Fast", why: "Titles, short classifications, quick checks.", provider: "openai", model: "gpt-6-luna" },
  { id: "code", title: "Code", why: "Agents that read and change code, run through the Pi coding agent.", provider: "openai", model: "gpt-6.1-sol" },
];

export function purpose(id: string): Purpose | null {
  return PURPOSES.find((p) => p.id === id) ?? null;
}
