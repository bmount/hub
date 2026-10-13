# Outgoing mail notices

## Agent recipient eligibility

Agents reply from their own mailbox only to active human members of their organization who wrote to them or were copied on admitted mail to them. Incoming admission and outgoing eligibility are separate: a root sender can have proven mail admitted without tenant membership, but an agent still cannot reply to that address. A human administrator must explicitly set up active membership for the exact sender address; admission never grants membership. Missing, archived or other-tenant membership does not qualify. Reply-all skips ineligible copied recipients rather than granting access. It still sends to the eligible original sender and copied members. The reply body and tool result name the omitted addresses and explain that they need active human membership for their exact address, through joining or accepting an administrator's invitation. The notice is stored with the outgoing reply; it is not a separate email to excluded recipients.

Recipient-policy refusals explain this distinction and the required setup. Existing sending switches, daily caps and consent withdrawal still apply to eligible root recipients. No membership or consent is changed by a send attempt.

## Sharing project documents

Members use `doc.share` / `doc_share` to send a file or wiki/KB/research page in one message to up to ten recipients. `doc.dispatch` / `doc_dispatch` sends one separate message per recipient, without exposing the other recipients' addresses. Give `project`, exactly one of `path` (file) or `slug` (page), `recipients` (member email addresses), and a short `note`. Both are available on workspace/wiki project MCP endpoints with the project supplied implicitly, and as forms on file inspectors and wiki pages. Sending uses the current document revision from an active project.

Every recipient must have an active human identity and active organization membership for that exact email address; contact records alone never qualify. Humans send from the project's address to any such member without requiring earlier inbound mail. Agents send from their own address and reuse `agentRecipientRefusals`: the member must have written to the agent or been copied on admitted mail to it. No approval is added. Sending configuration, sender/organization daily caps and consent withdrawal still apply; explicit member eligibility does not require a separate consent grant. These document rules do not broaden the existing `mail.send` or `mail.reply` gates.

Files of at most 512 KiB are MIME attachments. Larger files and pages use revision-pinned authenticated URLs; links grant no capability or public access, and require the same tenant membership/project-read checks as normal downloads/pages. Attachments intentionally provide recipients a copy outside Pimwell; subsequent withdrawal cannot recall an already sent copy.

The complete recipient list is checked before any transport. Dispatch rechecks policy and caps before each message and stops on the first refusal or uncertain failure; its result lists `deliveries` and `not_attempted`. A successful API response is not proof that every requested message was sent: inspect each delivery's status. Do not retry uncertain attempts automatically.

D1 `document_delivery` records document kind/ref, immutable revision, recipient, sender, mode, attempt time, status and outbound-mail ID. Each attempt is recorded as pending before transport, then updated to sent/refused/failed/uncertain. An interruption leaves pending evidence rather than claiming nothing happened. The latest 200 recipient records are shown on the document page and returned by `file.get` / `wiki.read`, under the document's normal read boundary. Sent means accepted by the mail transport, not confirmed inbox receipt. The outbound record retains the note and pinned URL; document revision storage retains attachment evidence. Project/tenant deletion includes these delivery records.

## Delivery notices

Mail shows the latest 50 recorded outgoing problems the viewer can read, filtered before the limit. Each notice names affected recipients, a fixed safe reason and a next action. Reply attempts also appear in the received message's inspector. Failed browser submissions show the same notice immediately.

Organization and project replies share the received message's read boundary. New outgoing messages are visible only to their sender, the sender agent's current human operator with tenant access, or a human tenant admin. An elevated agent role does not grant access to other private mailboxes. Reading a notice does not grant permission to send or change configuration.

Valid attempts blocked by sending configuration, daily limits, the contact window, recipient eligibility or consent are recorded as `refused`. Authorization failures, inaccessible messages and invalid requests do not create outgoing records. Missing consent and withdrawn consent both block delivery; neither is described as an invitation to bypass policy.

A failure before calling the transport is stored as `failed` with `pre_transport_failure`. A rejected transport call is stored as `failed` with `unknown`: it may already have delivered, including some earlier recipient envelopes. Legacy failed records are also displayed as uncertain. Raw transport diagnostics and unrecognized stored error strings are never rendered. A `sent` reply means the mail service accepted it, not that inbox delivery was confirmed.

Review links open the original reply or Assistant; they never send or replay mail. Uncertain delivery must be checked with recipients before another attempt. Human admins get a sending-configuration link. Reader-only viewers do not get retry or configuration controls. The existing consent, membership, contact-window and sending gates remain in force.

These notices are not a durable outbox or an idempotency guarantee. An interruption after transport but before recording can still leave no outgoing record. An unexpected browser-send failure therefore warns that delivery is uncertain rather than claiming nothing changed. Optional welcome guidance keeps its existing terminal failed state for transport failures and is never automatically retried; neither welcome failure nor transport failure proves a DMARC failure.
