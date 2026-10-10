import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import { canInspectMail } from "../auth/mailAccess";
import { esc } from "../html";

export type DeliveryNotice = { id: string; to_address: string; in_reply_to: string | null; status: string; error: string | null };

const POLICY: Record<string, [string, string]> = {
  sending_off: ["Sending is off in this organization.", "Ask a human organization admin to review the sending configuration."],
  sender_limit: ["The sender's daily limit was reached.", "Wait until the daily limit clears before reviewing another attempt."],
  tenant_limit: ["The organization's daily limit was reached.", "Wait until the daily limit clears before reviewing another attempt."],
  reply_window: ["The recipient has not written to this address within the 30-day reply window.", "Wait for the recipient to write again; do not bypass the reply window."],
  recipient_policy: ["One or more recipients do not qualify under the membership/contact policy.", "Review recipient eligibility with an organization admin; do not bypass the policy."],
  no_consent: ["Recipient consent is unavailable or withdrawn.", "Do not retry unless the recipient independently renews consent."],
};

/** Only fixed reasons are rendered: stored transport diagnostics are not safe UI content. */
export function mailDeliveryNotice(ctx: Ctx, o: DeliveryNotice): string {
  const blocked = o.status === "refused";
  const beforeTransport = o.status === "failed" && o.error === "pre_transport_failure";
  const [reason, next] = blocked
    ? POLICY[o.error ?? ""] ?? ["Sending was blocked by mail policy.", "Ask an organization admin to review the policy before another attempt."]
    : beforeTransport
      ? ["Mail preparation failed before the transport was called. No mail was sent.", "Review the message and mail configuration before trying again."]
      : ["The mail transport reported a failure, or the recorded outcome is incomplete. Some or all recipients may have received the message.", "Check with the recipients before sending again; a retry could duplicate delivery."];
  const review = o.in_reply_to ? `/mail/${encodeURIComponent(o.in_reply_to)}#reply` : "/assistant";
  const canWrite = rank(ctx.role) >= rank("member");
  return `<div class="planned" role="status" data-delivery="${blocked ? "blocked" : beforeTransport ? "failed" : "uncertain"}">
<strong>${blocked ? "Mail blocked — not sent" : beforeTransport ? "Delivery failed — not sent" : "Delivery uncertain"}</strong>
<p>${esc(reason)}</p><p>Affected recipients: <code>${esc(o.to_address)}</code></p><p>${esc(next)}</p>
${canWrite ? `<p><a href="${esc(review)}">Review before another attempt</a></p>` : ""}
${canInspectMail(ctx) ? '<p><a href="/mail#sending">Review sending configuration</a></p>' : ""}
</div>`;
}
