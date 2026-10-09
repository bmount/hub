import { defineVerb } from "./table";
import { optInt, optString, reqEnum, reqString } from "./params";
import { badRequest } from "../errors";
import { recipientId } from "../mail/responseRecipients";
import { responseIntent, setResponseIntent } from "../mail/responseIntent";

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
  summary: "Read your own response intention for independently admitted shared mail. Not a reply or delivery guarantee.",
  parse: i => ({ id: mailId(i) }),
  run: (ctx, p) => responseIntent(ctx, p.id),
});
export const mailSetResponseIntent = defineVerb({
  name: "mail.set_response_intent", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: 60, humanOnly: true,
  summary: "Record, retime or cancel your own human response intention with an optional UTC respond-by time. No send, notification, automation or access grant.",
  parse: i => {
    const expected = optInt(i, "expected_revision", { min: 0, max: Number.MAX_SAFE_INTEGER - 2 });
    if (expected === null) throw badRequest("expected_revision is required");
    const state = reqEnum(i, "state", ["planned", "cancelled"] as const), due = respondBy(i);
    if (state === "cancelled" && due !== null) throw badRequest("cancellation does not accept a respond-by time");
    return { id: mailId(i), state, expected, due };
  },
  run: (ctx, p) => setResponseIntent(ctx, p.id, p.state, p.expected, p.due),
});
