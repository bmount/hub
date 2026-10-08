// Mail in the workbench: what arrived at the organization's and projects' addresses as the list, one message (with
// the work filed from it, and Propose work) in the inspector. Quarantined mail is shown to admins only.
import type { Env } from "../env";
import { shellFor } from "./shell";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { KINDS, STATES, type WorkKind, type WorkState } from "../work/names";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const ago = (ms: number, now: number) => {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : m < 1440 * 60 ? `${Math.round(m / 1440)}d` : new Date(ms).toISOString().slice(0, 10);
};

type Row = { id: string; project: string | null; from_email: string; subject: string; received_at: number; verdict: string; forwarded: number };
type Msg = { id: string; recipient_id: string | null; project: string | null; from_email: string; to_address: string; subject: string; received_at: number; verdict: string; reason: string | null; text: string; attachments: string; forwarded: number };
type Filed = { slug: string; number: number; kind: WorkKind; state: WorkState; title: string };

export const mailListPage = (request: Request, env: Env) => mailPage(request, env, null);
export const mailReadPage = (request: Request, env: Env, id: string) => mailPage(request, env, id);

async function mailPage(request: Request, env: Env, id: string | null): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const admin = rank(ctx.role) >= rank("admin");
  const tid = ctx.tenant.id;
  const [rowsR, projR, msgR, filedR, repliesR, switchR] = await ctx.db.batch([
    ctx.db.prepare(`SELECT m.id, COALESCE(pr.slug, r.display_name) AS project, m.from_email, m.subject, m.received_at, m.verdict, m.forwarded FROM inbound_mail m LEFT JOIN project pr ON pr.id = m.project_id LEFT JOIN identity r ON r.id = m.recipient_id
      WHERE m.tenant_id = ? AND (m.verdict = 'admitted' OR ?) ORDER BY m.received_at DESC LIMIT 200`).bind(tid, admin ? 1 : 0),
    ctx.db.prepare("SELECT slug, display_name FROM project WHERE tenant_id = ? AND state = 'active' AND kind <> 'channel' ORDER BY display_name").bind(tid),
    ctx.db.prepare("SELECT m.*, COALESCE(pr.slug, 'agent ' || r.display_name) AS project FROM inbound_mail m LEFT JOIN project pr ON pr.id = m.project_id LEFT JOIN identity r ON r.id = m.recipient_id WHERE m.id = ? AND m.tenant_id = ?").bind(id ?? "", tid),
    ctx.db.prepare(`SELECT p.slug, w.number, w.kind, w.state, w.title FROM work_item w JOIN project p ON p.id = w.project_id
      WHERE w.tenant_id = ? AND w.source_kind = 'mail' AND w.source_ref = ? ORDER BY w.number`).bind(tid, id ?? ""),
    ctx.db.prepare(`SELECT o.text, o.created_at, o.status, i.display_name AS who FROM outbound_mail o JOIN identity i ON i.id = o.sent_by WHERE o.in_reply_to = ? AND o.tenant_id = ? ORDER BY o.created_at`).bind(id ?? "", tid),
    ctx.db.prepare("SELECT mail_out FROM tenant WHERE id = ?").bind(tid),
  ]);
  const sendingOn = (switchR!.results[0] as { mail_out: number } | undefined)?.mail_out === 1;
  const rows = rowsR!.results as Row[];
  const projects = projR!.results as Array<{ slug: string; display_name: string }>;
  const m = (msgR!.results[0] as Msg | undefined) ?? null;
  if (id && (!m || (m.verdict === "quarantined" && !admin))) return notFoundPage(extra);

  const org = ctx.tenant.slug;
  const list = `<div class="head"><h1>Mail</h1><span>${rows.length} message${rows.length === 1 ? "" : "s"}</span></div>
${rows.length ? `<table><thead><tr><th>To</th><th>From</th><th>Subject</th><th>Received</th></tr></thead><tbody>${rows.map((r) => {
    const href = `/mail/${esc(r.id)}`;
    return `<tr data-href="${href}"${m?.id === r.id ? ' aria-selected="true"' : ""}><td class="ref">${esc(r.project ?? "inbox")}</td><td class="hide-s">${esc(r.from_email)}</td><td><a href="${href}">${esc(r.subject || "(no subject)")}</a>${r.forwarded ? ' <span class="pill">forwarded</span>' : ""}${r.verdict === "quarantined" ? ' <span class="pill">held</span>' : ""}</td><td class="when" title="${when(r.received_at)}">${ago(r.received_at, ctx.now)}</td></tr>`;
  }).join("")}</tbody></table>` : `<p class="empty">No mail yet. Forward a thread to a project's address to start.</p>`}`;

  let inspector: string; let key = "";
  if (m) {
    const atts = JSON.parse(m.attachments) as Array<{ filename: string | null; mime_type: string; size: number }>;
    const filed = filedR!.results as Filed[];
    const release = m.verdict === "quarantined"
      ? `<div class="planned"><b>Held:</b> ${esc(m.reason ?? "")}<form method="post" action="/api/mail.release"><input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="_back" value="/mail/${esc(m.id)}"><button type="submit">I know who sent this: release it</button></form></div>` : "";
    const propose = m.verdict === "admitted" && rank(ctx.role) >= rank("member")
      ? `<form method="post" action="/api/mail.propose_work"><input type="hidden" name="id" value="${esc(m.id)}"><button type="submit">Propose work from this</button> <small>A model reads it as evidence and suggests wishes, snags, errands and calls, each quoting the message. You choose what to file.</small></form>` : "";
    inspector = `<a class="back" href="/mail">‹ Mail</a>
<div class="head"><span>${esc(m.project ?? "Organization inbox")}</span><span>${when(m.received_at)}</span>${m.forwarded ? '<span class="pill">forwarded</span>' : ""}</div>
<h1>${esc(m.subject || "(no subject)")}</h1>
<dl class="meta"><dt>From</dt><dd>${esc(m.from_email)}</dd><dt>To</dt><dd><code>${esc(m.to_address)}</code></dd><dt>Attachments</dt><dd>${atts.length ? atts.map((a) => `${esc(a.filename ?? "unnamed")} (${esc(a.mime_type)}, ${a.size} bytes)`).join(", ") : "none"}</dd></dl>
${release}
${filed.length ? `<h2>Filed from this</h2><table><tbody>${filed.map((f) => `<tr data-href="/${esc(f.slug)}/w/${f.number}"><td class="ref">${esc(f.slug)}#${f.number}</td><td class="k-${f.kind}"><span class="kd"></span>${esc(KINDS[f.kind].name)}</td><td><a href="/${esc(f.slug)}/w/${f.number}">${esc(f.title)}</a></td><td>${esc(STATES[f.state])}</td></tr>`).join("")}</tbody></table>` : ""}
${propose}
<pre>${esc(m.text)}</pre>
${(repliesR!.results as Array<{ text: string; created_at: number; status: string; who: string }>).map((o) => `<h2>Reply from ${esc(o.who)} <small>${when(o.created_at)}${o.status !== "sent" ? ` (${esc(o.status)})` : ""}</small></h2><pre>${esc(o.text)}</pre>`).join("")}
${m.verdict === "admitted" && !m.recipient_id && ctx.identity.kind === "human" && rank(ctx.role) >= rank("member")
  ? sendingOn && ctx.now - m.received_at <= 30 * 86_400_000
    ? `<h2>Reply</h2><form method="post" action="/api/mail.reply"><input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="_back" value="/mail/${esc(m.id)}"><label style="display:block"><textarea data-voice name="body" rows="6" required maxlength="20000" style="display:block;width:100%" placeholder="Sent from ${esc(m.to_address)} to ${esc(m.from_email)}"></textarea></label><button type="submit">Send reply</button></form>`
    : `<p class="lede">${sendingOn ? "More than 30 days have passed; Pimwell writes again once they do." : "Replies are off in this organization; an admin can turn them on below."}</p>` : ""}`;
    key = `mail:${m.id}:${m.verdict}:${filed.length}`;
  } else {
    const toggle = rank(ctx.role) >= rank("admin") ? `<h2>Sending</h2><p>${sendingOn ? "On: members reply from these addresses, and agents from theirs, only to people who wrote in the last 30 days, at most 50 a day each." : "Off: nothing leaves Pimwell except sign-in links and receipts."}</p>
<form method="post" action="/api/mail.sending"><input type="hidden" name="on" value="${sendingOn ? "0" : "1"}"><input type="hidden" name="_back" value="/mail"><button type="submit"${sendingOn ? ' class="quiet"' : ""}>${sendingOn ? "Turn sending off" : "Turn sending on"}</button></form>` : "";
    inspector = `<div class="head"><span>Addresses</span></div><h1>Send anything here</h1>
<p class="lede">Write or forward from your own address. Only members' mail is accepted; each message gets a receipt, and mail whose sender can't be proven is held for an admin. Nothing in mail is acted on until a member chooses to.</p>
<table><tbody><tr><td><code>${esc(org)}@${esc(env.HUB_DOMAIN)}</code></td><td>The organization's inbox; file it later</td></tr>
${projects.map((p) => `<tr><td><code>${esc(org)}.${esc(p.slug)}@${esc(env.HUB_DOMAIN)}</code></td><td>${esc(p.display_name)}</td></tr>`).join("")}</tbody></table>
<h2>Then</h2><p>Open a message and choose <b>Propose work from this</b>: wishes, snags, errands and calls appear, each quoting the message. File the ones you want; they link back here.</p>${toggle}`;
  }
  return htmlResponse(workbench(m ? m.subject || "Mail" : "Mail", { list, listKey: `mail:${rows.length}:${rows[0]?.id ?? ""}`, inspector, inspectorKey: key },
    shellFor(ctx, env, "mail", m?.id ?? "mail")!), 200, extra);
}
