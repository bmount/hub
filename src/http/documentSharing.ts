import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import { address, esc, localTime } from "../html";
import { documentDeliveries } from "../db/documentDelivery";

export async function documentSharing(ctx: Ctx, projectId: string, project: string, kind: "file" | "page", ref: string, writable: boolean, returnHref?: string) {
  const history = await documentDeliveries(ctx, projectId, kind, ref);
  const back = returnHref ?? (kind === "file" ? `/${project}/documents?path=${encodeURIComponent(ref)}` : `/${project}/wiki/${ref}`);
  let html = `<h2>Mail sharing</h2><p class="wb-hint" title="Small files (up to 512 KiB) attach; others use signed-in links. Agents follow their existing mail rule. Latest 200 recipient records. Pending delivery is uncertain: check before resending.">Share with eligible organization members only.</p><ul>${history.map(d => `<li>${address(d.recipient)} · ${esc(d.status)} · ${localTime(d.created_at)} · revision ${d.revision} · ${esc(d.sender)} · ${esc(d.mode)}</li>`).join("")}</ul>`;
  if (writable && rank(ctx.role) >= rank("member")) html += `<form method="post" action="/api/doc.share"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="${kind === "file" ? "path" : "slug"}" value="${esc(ref)}"><input type="hidden" name="_back" value="${esc(back)}"><label>Member email addresses (comma-separated) <input name="recipients" required></label><label>Short note <textarea name="note" maxlength="2000" required></textarea></label><button>Share by mail</button><button class="quiet" formaction="/api/doc.dispatch">Dispatch one mail per member</button></form>`;
  return html;
}
