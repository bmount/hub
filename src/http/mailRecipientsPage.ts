// Human-admin setup only. Preferences do not authorize mailbox access or schedule responses.
import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { esc, htmlResponse, workbench } from "../html";
import { HubError } from "../errors";
import { responseRecipients } from "../mail/responseRecipients";
import { extraCheck, proofFresh } from "./extraCheck";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";

const MAX_CHOICES = 200;
type Choice = { id: string; display_name: string; email: string };

export async function mailRecipientsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  // Browser-only page, never a way for an agent or assistant connection to manage preferences.
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.identity || ctx.identity.kind !== "human"
    || rank(ctx.role) < rank("admin") || ctx.authKind !== "cookie" || ctx.session?.kind !== "browser") return notFoundPage(extra);
  const url = new URL(request.url);
  const orgAddress = `${ctx.tenant.slug}@${env.HUB_DOMAIN}`;
  const address = (url.searchParams.get("address") ?? orgAddress).trim().toLowerCase();
  if (!address || address.length > 254) return notFoundPage(extra);
  let config: Awaited<ReturnType<typeof responseRecipients>>;
  try { config = await responseRecipients(ctx, address); }
  catch (e) { if (e instanceof HubError && e.reason === "not_found") return notFoundPage(extra); throw e; }
  const [projectsR, choicesR] = await ctx.db.batch([
    ctx.db.prepare("SELECT slug, display_name FROM project WHERE tenant_id = ? AND state = 'active' AND kind <> 'channel' ORDER BY display_name, id").bind(ctx.tenant.id),
    ctx.db.prepare(`SELECT i.id, i.display_name, i.email FROM identity i JOIN membership m ON m.identity_id = i.id
      WHERE m.tenant_id = ? AND m.state = 'active' AND m.role IN ('member', 'admin')
        AND i.kind = 'human' AND i.state = 'active' ORDER BY i.display_name, i.id LIMIT ?`).bind(ctx.tenant.id, MAX_CHOICES + 1),
  ]);
  const choices = choicesR!.results as Choice[];
  const mailboxes = [{ address: orgAddress, name: "Organization inbox" },
    ...(projectsR!.results as Array<{ slug: string; display_name: string }>).map(p => ({ address: `${ctx.tenant!.slug}.${p.slug}@${env.HUB_DOMAIN}`, name: p.display_name }))];
  const path = `/mail/recipients?address=${encodeURIComponent(address)}`;
  const list = `<a class="back" href="/mail">‹ Mail</a><h1>Response-recipient preferences</h1>
<p class="lede">Shared mailboxes only. Direct-agent mail keeps its private recipient.</p>
<ul>${mailboxes.map(m => `<li><a href="/mail/recipients?address=${esc(encodeURIComponent(m.address))}"${m.address === address ? ' aria-current="page"' : ""}>${esc(m.name)} — ${esc(m.address)}</a></li>`).join("")}</ul>`;
  const fresh = proofFresh(ctx);
  const selected = new Set(config.recipients);
  const omittedSelection = config.recipients.some(id => !choices.some(c => c.id === id));
  let edit: string;
  if (config.state === "invalid") {
    edit = `<p class="planned">Stored preferences are invalid. An administrator must reconcile them; this page cannot silently reset them.</p>`;
  } else if (choices.length > MAX_CHOICES || omittedSelection) {
    // Never offer a partial form that could silently drop unseen selected recipients.
    edit = `<p class="planned">The complete eligible selection cannot be shown here. Reload to reconcile eligibility changes, or use the revision-checked mail.response_recipients and mail.set_response_recipients API. The page supports up to ${MAX_CHOICES} eligible people; no preferences were changed.</p>`;
  } else if (!fresh) {
    edit = extraCheck(env, ctx, path, "Changing mailbox preferences needs a recent confirmation that it's really you.", url.searchParams.get("check") === "sent");
  } else {
    edit = `<form method="post" action="/api/mail.set_response_recipients" data-reload>
<input type="hidden" name="address" value="${esc(address)}">
<input type="hidden" name="expected_revision" value="${config.revision}">
<input type="hidden" name="_recipients_present" value="1">
<input type="hidden" name="_back" value="${esc(path)}">
<fieldset><legend>Preferred responders (up to ten active human members or admins)</legend>
${choices.length ? choices.map(c => `<label style="display:block"><input type="checkbox" name="recipients" value="${esc(c.id)}"${selected.has(c.id) ? " checked" : ""}> ${esc(c.display_name)} — ${esc(c.email)}</label>`).join("\n") : '<p>No eligible people. Add people in <a href="/people">People and agents</a>; readers and agents cannot be selected.</p>'}
</fieldset>
<p>Leave all unchecked to explicitly clear preferences.${config.state === "stale" ? ` Saving replaces the stale list and removes ${config.unavailable_count} unavailable recipient(s).` : ""}</p>
<button type="submit">Save preferences only</button>
</form>`;
  }
  const states: Record<string, string> = {
    unset: "Not set — no recipients configured.", empty: "Explicitly empty — no recipients configured.",
    configured: "Configured preferences — not a scheduled response.", stale: "Stale preferences — some recipients are no longer eligible.",
    invalid: "Invalid stored preferences — reconciliation required.",
  };
  const inspector = `<h1>${esc(address)}</h1>
<p><b>${states[config.state]}</b> Revision: ${config.revision ?? "unavailable"}.</p>
<p class="lede">Preferences only: automatic response scheduling is not implemented. Saving does not send notifications, wake responders, grant mailbox access, or guarantee a reply. One-time guidance is unchanged; later mail gets no routine Received receipt.</p>
${edit}
<p>Edits are revision checked. If another admin saves or eligibility changes, read the current state before editing again. If a save's outcome is unknown, reload this page to reconcile it; do not blindly resubmit.</p>`;
  // Full selection/proof observation in the pane key prevents retaining an obsolete form during navigation.
  const key = JSON.stringify([address, config, choices, fresh]);
  return htmlResponse(workbench("Mail response preferences", { list, listKey: JSON.stringify(mailboxes), inspector, inspectorKey: key }, shellFor(ctx, env, "mail", "mail-recipients")!), 200, extra);
}
