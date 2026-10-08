// The intent model's call. Deliberately narrow (owner, 2026-10-08): its context is the catalog's instructions and
// the person's own words in this exchange, and nothing else. This module takes no Ctx and touches no database, so no
// organization data can reach the model by accident; the ids passed along only label the call in the AI usage ledger.
import type { Env } from "../env";
import { ask } from "../models/ask";
import { intentInstructions, parseIntent, type Intent } from "./catalog";

/** One exchange: what they said, and the model's follow-up questions, in order. */
export type Turn = { who: "person" | "pimwell"; text: string };

export type Ledger = { tenant_id: string; identity_id: string; session_id: string | null; project_id?: string | null; client?: string };

export async function interpret(env: Env, turns: Turn[], ledger: Ledger, purpose = "fast"): Promise<Intent> {
  const input = turns.slice(-6).map((t) => `${t.who === "person" ? "Person" : "You asked"}: ${t.text.slice(0, 1000)}`).join("\n");
  const r = await ask(env, purpose, input, { ...ledger, instructions: intentInstructions(), maxOutputTokens: 400 });
  return parseIntent(r.text);
}
