import { defineVerb } from "./table";
import { optInt, reqEnum, reqString } from "./params";
import { badRequest } from "../errors";
import { recipientId } from "../mail/responseRecipients";
import { responseIntent, setResponseIntent } from "../mail/responseIntent";

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
  summary: "Record or cancel your own human response intention. No send, notification, automation or access grant.",
  parse: i => {
    const expected = optInt(i, "expected_revision", { min: 0, max: Number.MAX_SAFE_INTEGER - 2 });
    if (expected === null) throw badRequest("expected_revision is required");
    return { id: mailId(i), state: reqEnum(i, "state", ["planned", "cancelled"] as const), expected };
  },
  run: (ctx, p) => setResponseIntent(ctx, p.id, p.state, p.expected),
});
