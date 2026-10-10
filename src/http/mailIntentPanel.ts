import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import { HubError } from "../errors";
import { esc } from "../html";
import { responseIntent } from "../mail/responseIntent";
import { extraCheck, proofFresh } from "./extraCheck";

/** Browser-only own intent. Never display controls on private or unproven mail. */
export async function mailIntentPanel(ctx: Ctx, id: string): Promise<{ html: string; key: string }> {
  if (ctx.identity?.kind !== "human" || rank(ctx.role) < rank("member")
    || ctx.authKind !== "cookie" || ctx.session?.kind !== "browser") return { html: "", key: "" };
  let intent: Awaited<ReturnType<typeof responseIntent>>;
  try { intent = await responseIntent(ctx, id); }
  catch (e) { if (e instanceof HubError && e.reason === "not_found") return { html: "", key: "" }; throw e; }
  const fresh = proofFresh(ctx), path = `/mail/${id}`;
  const labels: Record<string, string> = {
    unset: "No intention recorded.", planned: "You recorded an intention to respond.", cancelled: "You cancelled your intention.",
    overdue: "Your intended respond-by time has passed. No reply or automated action is inferred.",
    completed: "You self-reported that you completed your response intention. This is your assertion, not observed recipient delivery or independently verified fulfillment.",
    stale: "Your recorded intention is stale: current mailbox preferences or availability changed.",
    invalid: "Stored intention is invalid; reconciliation is required. It cannot be silently reset.",
  };
  const replyLabels: Record<typeof intent.reply_observation.state, string> = {
    not_applicable: "No current planned revision to compare with reply records.",
    no_record: "No matching own reply attempt is recorded since this revision's time. This does not prove that no mail was sent.",
    transport_accepted: "The latest matching own reply record reports transport acceptance, not recipient delivery or fulfillment of your intention.",
    consent_refused: "The latest matching own reply record reports a consent refusal. This is not a delivery observation.",
    outcome_unknown: "The latest matching own reply record has an unknown outcome. Do not infer that nothing was sent or blindly retry.",
  };
  const reply = intent.reply_observation;
  const recorded = ["planned", "overdue", "stale"].includes(intent.state);
  const transitions = intent.revision === null ? [] : [
    ...(intent.can_plan ? [{ state: "planned", label: recorded ? "Update my respond-by time" : "I intend to respond" }] : []),
    ...(recorded ? [{ state: "cancelled", label: "Cancel my intention" }] : []),
    ...(intent.can_complete ? [{ state: "completed", label: "I have completed my response" }] : []),
  ];
  const due = intent.respond_by === null ? "" : new Date(intent.respond_by).toISOString().slice(0, 16);
  const controls = transitions.length && !fresh
    ? extraCheck(ctx.env, ctx, path, "Recording, cancelling or self-reporting completion of your response intention needs a recent confirmation that it's really you.", false)
    : transitions.map(t => `<form method="post" action="/api/mail.set_response_intent" data-reload>
<input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="state" value="${t.state}">
<input type="hidden" name="expected_revision" value="${intent.revision}"><input type="hidden" name="_back" value="${esc(path)}">
${t.state === "planned" ? `<label>Optional respond-by (UTC)<input type="datetime-local" name="respond_by_utc" step="60" value="${esc(due)}"></label>
<p>Enter a future UTC minute within 30 days of receiving this message. Blank records no deadline (or clears your existing deadline). This is not a timer, reminder or automatic send.</p>` : t.state === "completed" ? `<p>Record only if you have completed your intended response. This records your own assertion; it does not send mail, verify the response or prove recipient delivery.</p>` : ""}
<button type="submit">${t.label}</button></form>`).join("");
  return { html: `<section><h2>My response intention</h2><p>${labels[intent.state]} Revision: ${intent.revision ?? "unavailable"}.</p>
${intent.respond_by !== null ? `<p>Intended respond-by: ${esc(new Date(intent.respond_by).toISOString())} (UTC).</p>` : ""}
<p>Self-recorded intention only: no mail, notification or automated work is requested. This does not guarantee a reply. Actual replies and delivery status are separate.</p>
<h3>Own recorded reply evidence</h3><p>${replyLabels[reply.state]}</p>
${reply.outbound_id !== null ? `<p>Outbound record: ${esc(reply.outbound_id)}. Recorded at ${esc(new Date(reply.recorded_at!).toISOString())}.</p>` : ""}
<p>Only the latest exact mailbox/sender/source match since this revision's timestamp is observed, not a complete send history or causal link to the intention. Recipient delivery is not observed; no intention is automatically completed.</p>
${controls}${!intent.can_plan && intent.state !== "invalid" ? "<p>Current mailbox preferences do not select you. An admin can manage shared-mailbox preferences; this page does not grant access or assign anyone else.</p>" : ""}
<p>If a save's outcome is unknown, reload to reconcile the revision; do not blindly resubmit.</p></section>`, key: JSON.stringify([intent, fresh]) };
}
