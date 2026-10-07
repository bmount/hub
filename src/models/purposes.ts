// What Pimwell uses models for, and the default model for each (admin spec 10.1). Admin can change any of these;
// a model_route row overrides the default for the hub or for one organization.

export type Purpose = { id: string; title: string; why: string; provider: string; model: string };

export const PURPOSES: Purpose[] = [
  { id: "deep", title: "Deep reasoning", why: "Diagnosis from logs and code, first-principles cost estimates, the situation workflow.", provider: "openai", model: "gpt-5.5-pro" },
  { id: "reasoning", title: "Reasoning", why: "Summaries, plans, status reports, assignment proposals.", provider: "openai", model: "gpt-5.5" },
  { id: "fast", title: "Fast", why: "Titles, short classifications, quick checks.", provider: "openai", model: "gpt-5.4-mini" },
  { id: "code", title: "Code", why: "Helpers that read and change code, run through the Pi coding agent.", provider: "openai", model: "gpt-5.3-codex" },
];

export function purpose(id: string): Purpose | null {
  return PURPOSES.find((p) => p.id === id) ?? null;
}
