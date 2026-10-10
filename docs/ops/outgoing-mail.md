# Outgoing mail notices

## Agent recipient eligibility

Agents reply from their own mailbox only to active human members of their organization who wrote to them or were copied on admitted mail to them. Incoming admission and outgoing eligibility are separate: a root sender can have proven mail admitted without tenant membership, but an agent still cannot reply to that address. A human administrator must explicitly set up active membership for the exact sender address; admission never grants membership. Missing, archived or other-tenant membership does not qualify. Reply-all skips ineligible copied recipients rather than granting access. It still sends to the eligible original sender and copied members. The reply body and tool result name the omitted addresses and explain that they need active human membership for their exact address, through joining or accepting an administrator's invitation. The notice is stored with the outgoing reply; it is not a separate email to excluded recipients.

Recipient-policy refusals explain this distinction and the required setup. Existing sending switches, daily caps and consent withdrawal still apply to eligible root recipients. No membership or consent is changed by a send attempt.

## Delivery notices

Mail shows the latest 50 recorded outgoing problems the viewer can read, filtered before the limit. Each notice names affected recipients, a fixed safe reason and a next action. Reply attempts also appear in the received message's inspector. Failed browser submissions show the same notice immediately.

Organization and project replies share the received message's read boundary. New outgoing messages are visible only to their sender, the sender agent's current human operator with tenant access, or a human tenant admin. An elevated agent role does not grant access to other private mailboxes. Reading a notice does not grant permission to send or change configuration.

Valid attempts blocked by sending configuration, daily limits, the contact window, recipient eligibility or consent are recorded as `refused`. Authorization failures, inaccessible messages and invalid requests do not create outgoing records. Missing consent and withdrawn consent both block delivery; neither is described as an invitation to bypass policy.

A failure before calling the transport is stored as `failed` with `pre_transport_failure`. A rejected transport call is stored as `failed` with `unknown`: it may already have delivered, including some earlier recipient envelopes. Legacy failed records are also displayed as uncertain. Raw transport diagnostics and unrecognized stored error strings are never rendered. A `sent` reply means the mail service accepted it, not that inbox delivery was confirmed.

Review links open the original reply or Assistant; they never send or replay mail. Uncertain delivery must be checked with recipients before another attempt. Human admins get a sending-configuration link. Reader-only viewers do not get retry or configuration controls. The existing consent, membership, contact-window and sending gates remain in force.

These notices are not a durable outbox or an idempotency guarantee. An interruption after transport but before recording can still leave no outgoing record. An unexpected browser-send failure therefore warns that delivery is uncertain rather than claiming nothing changed. Optional welcome guidance keeps its existing terminal failed state for transport failures and is never automatically retried; neither welcome failure nor transport failure proves a DMARC failure.
