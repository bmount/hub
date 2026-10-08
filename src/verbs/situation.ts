// Situations in, the truth out (roadmap milestone 7, first version). A person describes a problem; the assistant
// investigates read-only with Pimwell's tools and answers in a fixed shape: cause, evidence (each item cited), who
// should act, an honest estimate, and its confidence. The report is a record, and resolve() records what turned out
// to be true, so diagnoses can be checked against reality later.
import { defineVerb } from "./table";
import { reqString } from "./params";
import { badRequest, notFound } from "../errors";
import { ulid } from "../ids";
import { recordEvent } from "../db/events";
import { DATA_NOTE, cleanText } from "../mcp/render";
import { instructions, runTurn } from "../assistant/run";
import type { Ctx } from "../auth/context";

export const DIAGNOSIS = `This is a situation report. Investigate before answering: look at recent work, commits, deploys, errors, reviews and mail with your tools.
Answer in exactly these sections, plainly:
Cause: the most likely cause, in one or two sentences. If the record doesn't show it, say so.
Evidence: a list; each item names its record (project#n, a commit id, a deploy tag, an error, a mail subject) and why it matters.
Who should act: people or agents, and what each should do.
Estimate: honest effort and time to fix, from first principles; say what would make it longer.
Confidence: low, medium or high, and what would raise it.
Never say everything is fine unless the record shows it. Never invent a record.`;

export async function openSituation(ctx: Ctx, question: string): Promise<{ id: string; thread: string; report: string; steps: number }> {
  const q = question.trim();
  if (q.length < 10) throw badRequest("describe the situation in a sentence or two");
  const threadId = ulid(ctx.now);
  const title = q.replace(/\s+/g, " ").slice(0, 80);
  await ctx.db.prepare("INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, 'read', ?, ?)")
    .bind(threadId, ctx.tenant!.id, ctx.identity!.id, `Situation: ${title}`, ctx.now, ctx.now).run();
  const r = await runTurn(ctx, threadId, "read", q, { instructions: `${instructions(ctx, "read")}\n\n${DIAGNOSIS}` });
  const id = ulid(ctx.now);
  await ctx.db.prepare("INSERT INTO situation (id, tenant_id, identity_id, thread_id, title, question, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ctx.tenant!.id, ctx.identity!.id, threadId, title, q, r.reply, ctx.now).run();
  await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: "situation.open", target_kind: "situation", target_id: id, summary: `Situation: ${title}` }, ctx.now);
  return { id, thread: threadId, report: r.reply, steps: r.steps.length };
}

export const situationOpen = defineVerb({
  name: "situation.open", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Describe a problem; Pimwell investigates the record read-only and answers with cause, cited evidence, who should act, an honest estimate and its confidence. The report is kept.",
  formBack: (r) => `/situations?s=${(r as { id: string }).id}`,
  parse: (i) => ({ text: reqString(i, "text", { max: 4000 }) }),
  run: async (ctx, p) => openSituation(ctx, p.text),
});

export const situationResolve = defineVerb({
  name: "situation.resolve", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Record what actually turned out to be true for a situation, so its diagnosis can be compared with reality.",
  mcp: {
    scope: "write", destructive: false, title: "Record what happened",
    input: { type: "object", properties: { id: { type: "string" }, outcome: { type: "string", description: "What turned out to be true" } }, required: ["id", "outcome"], additionalProperties: false },
    render: () => `${DATA_NOTE}\n\nRecorded.`,
  },
  parse: (i) => ({ id: reqString(i, "id", { max: 40 }), outcome: reqString(i, "outcome", { max: 4000 }) }),
  run: async (ctx, p) => {
    const r = await ctx.db.prepare("UPDATE situation SET outcome = ?, outcome_by = ?, outcome_at = ? WHERE id = ? AND tenant_id = ?").bind(p.outcome.trim(), ctx.identity!.id, ctx.now, p.id, ctx.tenant!.id).run();
    if (!r.meta.changes) throw notFound("no such situation");
    return { id: p.id };
  },
});

export const situationList = defineVerb({
  name: "situation.list", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Situations reported here, newest first, with their diagnoses and, where known, what turned out to be true.",
  mcp: {
    scope: "read", destructive: false, title: "Situations",
    input: { type: "object", properties: {}, additionalProperties: false },
    render: (r) => { const x = (r as { situations: Array<{ id: string; title: string; report: string; outcome: string | null }> }).situations; return [DATA_NOTE, "", ...x.map((s) => `- \`${s.id}\` ${cleanText(s.title)}${s.outcome ? ` — outcome: ${cleanText(s.outcome).slice(0, 200)}` : ""}\n  ${cleanText(s.report).slice(0, 400)}`)].join("\n"); },
  },
  parse: () => ({}),
  run: async (ctx) => ({ situations: (await ctx.db.prepare("SELECT s.id, s.title, s.report, s.outcome, s.created_at, i.display_name AS who FROM situation s JOIN identity i ON i.id = s.identity_id WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 50").bind(ctx.tenant!.id).all()).results }),
});
