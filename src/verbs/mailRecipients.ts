import { defineVerb } from "./table";
import { optInt, reqString } from "./params";
import { badRequest } from "../errors";
import { MAX_RESPONSE_RECIPIENTS, recipientId, responseRecipients, setResponseRecipients } from "../mail/responseRecipients";

const address = (i: Record<string, unknown>) => reqString(i, "address", { max: 254 });
export const mailResponseRecipients = defineVerb({
  name: "mail.response_recipients", kind: "query", scope: "tenant", minRole: "admin", freshProofMinutes: null, humanOnly: true,
  summary: "Inspect shared-mailbox response-recipient preferences and current eligibility. Configuration does not schedule or guarantee a response.",
  parse: i => ({ address: address(i) }),
  run: (ctx, p) => responseRecipients(ctx, p.address),
});
export const mailSetResponseRecipients = defineVerb({
  name: "mail.set_response_recipients", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, humanOnly: true,
  summary: "Set up to ten active same-organization human members for a shared mailbox, with an expected revision. Preferences only; no access grant, mail send or response scheduling.",
  parse: i => {
    const expected = optInt(i, "expected_revision", { min: 0, max: Number.MAX_SAFE_INTEGER - 2 });
    if (expected === null) throw badRequest("expected_revision is required; read the configuration first");
    const recipients = i.recipients;
    if (!Array.isArray(recipients) || recipients.length > MAX_RESPONSE_RECIPIENTS || !recipients.every(recipientId)
      || new Set(recipients).size !== recipients.length) throw badRequest("recipients must be a unique array of at most ten identity ids; [] clears preferences");
    return { address: address(i), recipients: recipients as string[], expected };
  },
  run: (ctx, p) => setResponseRecipients(ctx, p.address, p.recipients, p.expected),
});
