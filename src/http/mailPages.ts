// Mail pages on an organization's host: /mail lists what arrived, /mail/<id> shows one message as plain text.
import type { Env } from "../env";
import { shellFor } from "./shell";
import { esc, htmlResponse, page } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export async function mailListPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (!ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const admin = rank(ctx.role) >= rank("admin");
  const rows = (await ctx.db.prepare(
    `SELECT m.id, pr.slug AS project, m.from_email, m.subject, m.received_at, m.verdict, m.forwarded FROM inbound_mail m LEFT JOIN project pr ON pr.id = m.project_id
     WHERE m.tenant_id = ? AND (m.verdict = 'admitted' OR ?) ORDER BY m.received_at DESC LIMIT 200`,
  ).bind(ctx.tenant.id, admin ? 1 : 0).all<{ id: string; project: string | null; from_email: string; subject: string; received_at: number; verdict: string; forwarded: number }>()).results;
  const org = ctx.tenant.slug;
  const projects = (await ctx.db.prepare("SELECT slug FROM project WHERE tenant_id = ? AND state = 'active' AND kind <> 'channel' ORDER BY slug").bind(ctx.tenant.id).all<{ slug: string }>()).results;
  const addrs = [`<code>${esc(org)}@${esc(env.HUB_DOMAIN)}</code> (anything; Pimwell files it)`, ...projects.map((p) => `<code>${esc(org)}.${esc(p.slug)}@${esc(env.HUB_DOMAIN)}</code>`)];
  const body = `<h1>${esc(ctx.tenant.display_name)} mail</h1><p><a href="/">back</a></p>
<p>Send or forward anything from your own address to:</p><ul>${addrs.map((a) => `<li>${a}</li>`).join("")}</ul>
<p><small>Only members' mail is accepted. Each message gets a receipt; mail whose sender cannot be proven is held for an admin. Mail is kept as information and never acted on without a member's confirmation.</small></p>
${rows.length ? `<table><thead><tr><th>Received</th><th>To</th><th>From</th><th>Subject</th><th></th></tr></thead><tbody>${rows.map((r) =>
    `<tr><td>${when(r.received_at)}</td><td>${esc(r.project ?? "inbox")}</td><td>${esc(r.from_email)}</td><td><a href="/mail/${esc(r.id)}">${esc(r.subject || "(no subject)")}</a></td><td>${r.forwarded ? "forwarded" : ""}${r.verdict === "quarantined" ? " <strong>quarantined</strong>" : ""}</td></tr>`).join("")}</tbody></table>` : "<p>No mail yet.</p>"}`;
  return htmlResponse(page("Mail", body, shellFor(ctx, env, "mail")), 200, extra);
}

export async function mailReadPage(request: Request, env: Env, id: string): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (!ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const m = await ctx.db.prepare(`SELECT m.*, pr.slug AS project FROM inbound_mail m LEFT JOIN project pr ON pr.id = m.project_id WHERE m.id = ? AND m.tenant_id = ?`)
    .bind(id, ctx.tenant.id).first<{ id: string; project: string | null; from_email: string; to_address: string; subject: string; received_at: number; verdict: string; reason: string | null; text: string; attachments: string; forwarded: number }>();
  const admin = rank(ctx.role) >= rank("admin");
  if (!m || (m.verdict === "quarantined" && !admin)) return notFoundPage(extra);
  const atts = (JSON.parse(m.attachments) as Array<{ filename: string | null; mime_type: string; size: number }>);
  const release = m.verdict === "quarantined"
    ? `<p><strong>Quarantined:</strong> ${esc(m.reason ?? "")}</p><form method="post" action="/api/mail.release"><input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="_back" value="/mail/${esc(m.id)}"><button type="submit">I know who sent this: release it</button></form>`
    : "";
  const body = `<p><a href="/mail">all mail</a></p><h1>${esc(m.subject || "(no subject)")}</h1>
<p>From <strong>${esc(m.from_email)}</strong> to <code>${esc(m.to_address)}</code>, ${when(m.received_at)}${m.forwarded ? ", carries forwarded mail" : ""}.</p>
${release}
<p>Attachments: ${atts.length ? atts.map((a) => `${esc(a.filename ?? "unnamed")} (${esc(a.mime_type)}, ${a.size} bytes)`).join(", ") : "none"}. Attachment contents are not kept yet.</p>
<pre style="white-space:pre-wrap">${esc(m.text)}</pre>`;
  return htmlResponse(page(m.subject || "Mail", body, shellFor(ctx, env, "mail", m.id)), 200, extra);
}
