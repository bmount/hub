import { defineVerb } from "./table";
import { optInt, optString, reqEnum, reqString } from "./params";
import { badRequest } from "../errors";
import { esc } from "../html";
import { recipientId } from "../mail/responseRecipients";
import { responseAgenda, responseIntent, responseIntentWriteStatus, setResponseIntent } from "../mail/responseIntent";

// UTC minute precision, never server/browser-local interpretation or permissive Date rollover.
function respondBy(i: Record<string, unknown>) {
  const text = optString(i, "respond_by_utc", { max: 16 });
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) throw badRequest("respond_by_utc must be YYYY-MM-DDTHH:mm in UTC");
  const time = Date.parse(text + ":00Z");
  if (!Number.isSafeInteger(time) || new Date(time).toISOString().slice(0, 16) !== text) {
    throw badRequest("respond_by_utc must be a valid UTC calendar minute");
  }
  return time;
}

function mailId(i: Record<string, unknown>) {
  const id = reqString(i, "id", { max: 26 });
  if (!recipientId(id)) throw badRequest("id must be a mail identity id");
  return id;
}
export const mailResponseIntent = defineVerb({
  name: "mail.response_intent", kind: "query", scope: "tenant", minRole: "member", freshProofMinutes: null, humanOnly: true,
  summary: "Read your own response intention and bounded matching own reply-record evidence for independently admitted shared mail. Transport acceptance is not delivery or fulfillment.",
  parse: i => ({ id: mailId(i) }),
  run: (ctx, p) => responseIntent(ctx, p.id),
});
export const mailResponseAgenda = defineVerb({
  name: "mail.response_agenda", kind: "query", scope: "tenant", minRole: "member", freshProofMinutes: null, humanOnly: true,
  summary: "Scan your own outstanding human response intentions on independently admitted shared mail. Bounded mail-id pages, not deadline priority, notification, execution or a reply guarantee.",
  parse: i => {
    const before = optString(i, "before", { max: 26 });
    if (before !== null && !recipientId(before)) throw badRequest("before must be a mail identity id");
    return { before };
  },
  run: (ctx, p) => responseAgenda(ctx, p.before),
});
function editParams(i: Record<string, unknown>) {
  const expected = optInt(i, "expected_revision", { min: 0, max: Number.MAX_SAFE_INTEGER - 2 });
  if (expected === null) throw badRequest("expected_revision is required");
  const state = reqEnum(i, "state", ["planned", "cancelled", "completed"] as const), due = respondBy(i);
  if (state !== "planned" && due !== null) throw badRequest("cancellation or completion does not accept a respond-by time");
  return { id: mailId(i), state, expected, due };
}
function requestId(i: Record<string, unknown>) {
  const id = optString(i, "request_id", { max: 26 });
  if (id !== null && !recipientId(id)) throw badRequest("request_id must be a stable unique identity id");
  return id;
}
export const mailResponseIntentWriteStatus = defineVerb({
  name: "mail.response_intent_write_status", kind: "query", scope: "tenant", minRole: "member", freshProofMinutes: null, humanOnly: true,
  summary: "Reconcile your preserved exact response-intention edit against a durable own request receipt. No resend, notification, execution or retry authorization.",
  parse: i => {
    const request = requestId(i);
    if (request === null) throw badRequest("request_id is required");
    return { ...editParams(i), request };
  },
  run: (ctx, p) => responseIntentWriteStatus(ctx, p.id, p.request, p.state, p.expected, p.due),
  renderForm: r => `<h1>Own intention edit receipt</h1>
<p>Request ID: <code>${esc(r.request_id)}</code>. ${r.status === "committed"
    ? r.matches ? "The original recorded edit matches your submitted values." : "This ID was recorded for a different edit. Your submitted values do not match."
    : r.status === "no_record" ? "No receipt is currently recorded for this ID. This does not prove that nothing changed or that a concurrent write cannot still commit."
    : "The stored receipt or source binding is invalid. Reconciliation is required; do not reset or retry it."}</p>
<p>Original committed revision: ${r.committed_revision ?? "unavailable"}. Current own revision: ${r.current_revision ?? "unavailable"}.
${r.still_current === true ? "The original recorded intention is still current." : r.still_current === false ? "The original recorded intention is no longer current." : "No valid original intention is available to compare."}</p>
<p>This read-only observation is not retry authorization, a send, notification, scheduled execution or a response guarantee. No edit was retried. Recipient delivery is not observed.</p>
<p><a href="/mail/${esc(r.mail_id)}" data-reload>Read current intention</a> before making any new explicit edit.</p>`,
});
export const mailSetResponseIntent = defineVerb({
  name: "mail.set_response_intent", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: 60, humanOnly: true,
  summary: "Record, retime, cancel or explicitly self-report completion of your own human response intention. Completion is not observed recipient delivery. No send, notification, automation or access grant.",
  parse: i => ({ ...editParams(i), request: requestId(i) }),
  run: (ctx, p) => setResponseIntent(ctx, p.id, p.state, p.expected, p.due, p.request),
});
