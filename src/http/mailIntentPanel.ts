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
    stale: "Your recorded intention is stale: current mailbox preferences or availability changed.",
    invalid: "Stored intention is invalid; reconciliation is required. It cannot be silently reset.",
  };
  const recorded = ["planned", "overdue", "stale"].includes(intent.state);
  const transitions = intent.revision === null ? [] : [
    ...(intent.can_plan ? [{ state: "planned", label: recorded ? "Update my respond-by time" : "I intend to respond" }] : []),
    ...(recorded ? [{ state: "cancelled", label: "Cancel my intention" }] : []),
  ];
  const due = intent.respond_by === null ? "" : new Date(intent.respond_by).toISOString().slice(0, 16);
  const controls = transitions.length && !fresh
    ? extraCheck(ctx.env, ctx, path, "Recording or cancelling your response intention needs a recent confirmation that it's really you.", false)
    : transitions.map(t => `<form method="post" action="/api/mail.set_response_intent" data-reload>
<input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="state" value="${t.state}">
<input type="hidden" name="expected_revision" value="${intent.revision}"><input type="hidden" name="_back" value="${esc(path)}">
${t.state === "planned" ? `<label>Optional respond-by (UTC)<input type="datetime-local" name="respond_by_utc" step="60" value="${esc(due)}"></label>
<p>Enter a future UTC minute within 30 days of receiving this message. Blank records no deadline (or clears your existing deadline). This is not a timer, reminder or automatic send.</p>` : ""}
<button type="submit">${t.label}</button></form>`).join("");
  return { html: `<section><h2>My response intention</h2><p>${labels[intent.state]} Revision: ${intent.revision ?? "unavailable"}.</p>
${intent.respond_by !== null ? `<p>Intended respond-by: ${esc(new Date(intent.respond_by).toISOString())} (UTC).</p>` : ""}
<p>Self-recorded intention only: no mail, notification or automated work is requested. This does not guarantee a reply. Actual replies and delivery status are separate.</p>
${controls}${!intent.can_plan && intent.state !== "invalid" ? "<p>Current mailbox preferences do not select you. An admin can manage shared-mailbox preferences; this page does not grant access or assign anyone else.</p>" : ""}
<p>If a save's outcome is unknown, reload to reconcile the revision; do not blindly resubmit.</p></section>`, key: JSON.stringify([intent, fresh]) };
}
