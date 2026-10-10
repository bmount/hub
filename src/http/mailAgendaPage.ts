// Read-only human agenda. No assignments, notifications, sends or implicit edits.
import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { esc, htmlResponse, workbench } from "../html";
import { HubError } from "../errors";
import { responseAgenda } from "../mail/responseIntent";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";

export async function mailAgendaPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.identity || ctx.identity.kind !== "human"
    || rank(ctx.role) < rank("member") || ctx.authKind !== "cookie" || ctx.session?.kind !== "browser") return notFoundPage(extra);
  const before = new URL(request.url).searchParams.get("before");
  let agenda: Awaited<ReturnType<typeof responseAgenda>>;
  try { agenda = await responseAgenda(ctx, before); }
  catch (e) {
    if (e instanceof HubError && (e.reason === "not_found" || e.reason === "bad_request")) return notFoundPage(extra);
    if (e instanceof HubError && e.reason === "conflict") {
      return htmlResponse(workbench("My response agenda", { list: '<a href="/mail">‹ Mail</a>', listKey: "mail-agenda-conflict",
        inspector: '<h1>Agenda changed while reading</h1><p>Reload to reconcile current access and intentions. No intention was changed.</p>',
        inspectorKey: "mail-agenda-conflict" }, shellFor(ctx, env, "mail", "mail-agenda")!), 409, extra);
    }
    throw e;
  }
  const labels = { planned: "Outstanding intention", overdue: "Intended deadline passed", stale: "Planning eligibility changed" };
  const when = (ms: number) => esc(new Date(ms).toISOString());
  const list = `<a class="back" href="/mail">‹ Mail</a><h1>My response agenda</h1>
<p>Only your outstanding intentions on currently readable, independently admitted shared mail. No other responder's state is shown.</p>
${agenda.entries.length ? `<table><thead><tr><th>Message</th><th>Intention</th><th>Respond by (UTC)</th></tr></thead><tbody>${agenda.entries.map(e =>
    `<tr><td><a href="/mail/${esc(e.mail_id)}">${esc(e.mail_id)}</a></td><td>${labels[e.state]}</td><td>${e.respond_by === null ? "Untimed" : when(e.respond_by)}</td></tr>`).join("")}</tbody></table>` : '<p>No outstanding intentions in this scan page. This is not a claim that no reply was sent or that no older intention exists.</p>'}
<p>Scanned ${agenda.scanned} own recorded intentions at shared sources (maximum ${agenda.scan_limit}); ${agenda.entries.length} outstanding entries shown. Terminal, invalid or unproven records may consume scan slots without appearing. Mail-ID order, not deadline priority or a complete due queue.</p>
${agenda.next_before ? `<p><a href="/mail/agenda?before=${esc(encodeURIComponent(agenda.next_before))}">Scan older records</a></p>` : '<p>No older scan candidates observed. This is a bounded current observation, not a future lock or proof of fulfillment.</p>'}
<p><a href="/mail/agenda">Start a fresh scan</a></p>`;
  const inspector = `<h1>Human intentions, not automated scheduling</h1>
<p class="lede">A deadline is your recorded intention only. This agenda sends no notifications or reminders, wakes nobody, and does not execute, cancel, complete or guarantee a response.</p>
<p>Open a message to read its current intention and independently rechecked source before retiming, cancelling or self-reporting completion. Actual replies have separate consent, sending, quota and transport checks. Transport acceptance is not recipient delivery.</p>
<p>Pages scan existing own records, not messages selected by preferences alone. Concurrent additions or changes can alter later pages; start a fresh scan to reconcile them. No global total or deadline-priority ordering is claimed.</p>`;
  return htmlResponse(workbench("My response agenda", { list, listKey: JSON.stringify([before, agenda]), inspector,
    inspectorKey: "mail-agenda-semantics-v1" }, shellFor(ctx, env, "mail", "mail-agenda")!), 200, extra);
}
