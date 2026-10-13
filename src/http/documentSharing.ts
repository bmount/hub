import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import { esc } from "../html";
import { documentDeliveries } from "../db/documentDelivery";

export async function documentSharing(ctx: Ctx, projectId: string, project: string, kind: "file" | "page", ref: string, writable: boolean, returnHref?: string) {
  const history = await documentDeliveries(ctx, projectId, kind, ref);
  const back = returnHref ?? (kind === "file" ? `/${project}/documents?path=${encodeURIComponent(ref)}` : `/${project}/wiki/${ref}`);
  let html = `<h2>Mail sharing</h2><p>Only active human organization members. Small files (up to 512 KiB) are attached; other documents use signed-in links. An agent can write only to members eligible under its existing mail rule.</p><ul>${history.map(d => `<li>${esc(d.recipient)} · ${esc(d.status)} · ${esc(new Date(d.created_at).toISOString())} · revision ${d.revision} · ${esc(d.sender)} · ${esc(d.mode)}</li>`).join("")}</ul><p>Latest 200 recipient records shown. Pending means delivery is uncertain; check before sending again.</p>`;
  if (writable && rank(ctx.role) >= rank("member")) html += `<form method="post" action="/api/doc.share"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="${kind === "file" ? "path" : "slug"}" value="${esc(ref)}"><input type="hidden" name="_back" value="${esc(back)}"><label>Member email addresses (comma-separated) <input name="recipients" required></label><label>Short note <textarea name="note" maxlength="2000" required></textarea></label><button>Share by mail</button><button formaction="/api/doc.dispatch">Dispatch one mail per member</button></form>`;
  return html;
}
