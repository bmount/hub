import { Buffer } from "node:buffer";
import { defineVerb } from "./table";
import { reqString, optString } from "./params";
import { badRequest, forbidden, HubError, notFound } from "../errors";
import { filePath, fileProject, readFile } from "./files";
import { readWiki, wikiSlug } from "./wiki";
import { addresses, agentRecipientRefusals, capsAndSwitch, deliver, MAX_RECIPIENTS } from "./mailOut";
import { consentWithdrawn } from "../db/consent";
import { ulid } from "../ids";
import type { Ctx } from "../auth/context";
import type { MailAttachment } from "../mail/mime";

export const DOC_ATTACHMENT_BYTES = 512 * 1024;
const input = {type: "object" as const, properties: {
  project: {type: "string"}, path: {type: "string", description: "File path; give path or slug, not both"},
  slug: {type: "string", description: "Wiki/KB/research page slug"},
  recipients: {type: "array", items: {type: "string"}, description: "Active human organization members' email addresses (up to 10)"},
  note: {type: "string", description: "Short plain-text note"},
}, required: ["project", "recipients", "note"], additionalProperties: false as const};
function parse(i: Record<string, unknown>) {
  const path = optString(i, "path", {max: 240}), slug = optString(i, "slug", {max: 100});
  if (!!path === !!slug) throw badRequest("give exactly one of path (file) or slug (page)");
  const recipients = addresses(i.recipients, "recipients");
  if (!recipients.length || recipients.length > MAX_RECIPIENTS) throw badRequest(`give 1–${MAX_RECIPIENTS} recipients`);
  return {project: reqString(i, "project", {max: 63}), path: path ? filePath(path) : null, slug: slug ? wikiSlug(slug) : null,
    recipients, note: reqString(i, "note", {max: 2000}).trim()};
}
async function recipientsAllowed(ctx: Ctx, recipients: string[]) {
  if (ctx.identity!.kind === "agent") {
    const refused = await agentRecipientRefusals(ctx, recipients);
    if (refused.length) throw forbidden(refused.join("; "));
  } else for (const r of recipients) {
    const member = await ctx.db.prepare(`SELECT 1 FROM identity i JOIN membership m ON m.identity_id = i.id
      WHERE lower(i.email) = ? AND i.kind = 'human' AND i.state = 'active' AND m.tenant_id = ? AND m.state = 'active' LIMIT 1`).bind(r, ctx.tenant!.id).first();
    if (!member) throw forbidden(`${r} is not an active human member of this organization`);
  }
  for (const r of recipients) if (await consentWithdrawn(ctx.db, r)) throw forbidden(`${r} withdrew consent; no mail was sent`);
}
async function sendDocument(ctx: Ctx, v: ReturnType<typeof parse>, mode: "share" | "dispatch") {
  const project = await fileProject(ctx, v.project, true);
  // Check the entire list before transporting anything, including dispatches.
  await recipientsAllowed(ctx, v.recipients);
  await capsAndSwitch(ctx);
  const kind = v.path ? "file" : "page", ref = v.path ?? v.slug!;
  const base = `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/${ctx.mcpProject?.path ?? project.slug}`;
  let revision: number, title: string, url: string;
  let attachments: MailAttachment[] | undefined;
  if (v.path) {
    const file = await readFile(ctx, v.project, v.path);
    revision = file.revision; title = file.name;
    url = `${base}/documents/download?path=${encodeURIComponent(v.path)}&revision=${revision}`;
    if (file.size <= DOC_ATTACHMENT_BYTES) {
      const object = await ctx.env.GIT_PUSH_STAGING?.get(file.object_key);
      if (!object) throw notFound("file storage unavailable");
      const bytes = await object.arrayBuffer();
      if (bytes.byteLength !== file.size) throw new HubError(503, "unavailable", "file storage size mismatch");
      attachments = [{name: file.name, contentType: file.content_type, base64: Buffer.from(bytes).toString("base64")}];
    }
  } else {
    const {page} = await readWiki(ctx, v.project, v.slug!);
    revision = page.revision; title = page.title;
    url = `${base}/wiki/${v.slug}?revision=${revision}`;
  }
  const from = ctx.identity!.kind === "agent" ? ctx.identity!.email : `${ctx.tenant!.slug}.${project.slug}@${ctx.env.HUB_DOMAIN}`;
  const text = `${v.note}\n\n${title} (revision ${revision})\n${url}\n\n${attachments ? "File attached. " : ""}The link requires sign-in and permission to read the project.`;
  const groups = mode === "dispatch" ? v.recipients.map(r => [r]) : [v.recipients];
  const deliveries: Array<{recipients: string[]; status: string; id?: string; detail?: string}> = [];
  for (const recipients of groups) {
    const ids = recipients.map(() => ulid(ctx.now));
    // Preserve an uncertain attempt even if transport or a subsequent DB response is lost.
    await ctx.db.batch(recipients.map((r, n) => ctx.db.prepare(`INSERT INTO document_delivery
      (id, tenant_id, project_id, document_kind, document_ref, revision, recipient, sent_by, mode, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).bind(ids[n], ctx.tenant!.id, project.id, kind, ref, revision, r, ctx.identity!.id, mode, ctx.now)));
    let status: string, id: string | undefined, detail: string | undefined;
    try {
      const result = await deliver(ctx, {from, to: recipients[0]!, cc: recipients.slice(1), inbound_id: null, message_id: null, basis: "member"},
        `Shared: ${title}`.slice(0, 200), text, [], async () => {
          await recipientsAllowed(ctx, recipients);
          await capsAndSwitch(ctx);
        }, attachments);
      status = result.status; id = result.id;
    } catch (e) {
      if (!(e instanceof HubError)) throw e;
      const mail = e.data?.mail_delivery as {id: string; status: string; error?: string} | undefined;
      status = mail?.error === "unknown" ? "uncertain" : mail?.status ?? "refused"; id = mail?.id; detail = e.detail ?? e.reason;
    }
    await ctx.db.batch(ids.map(d => ctx.db.prepare("UPDATE document_delivery SET status = ?, outbound_id = ? WHERE id = ? AND tenant_id = ?").bind(status, id ?? null, d, ctx.tenant!.id)));
    deliveries.push({recipients, status, ...(id ? {id} : {}), ...(detail ? {detail} : {})});
    // Stop on refusal or uncertainty; never retry an ambiguous transport.
    if (status !== "sent") break;
  }
  return {project: v.project, path: v.path, slug: v.slug, revision, from, url, attached: !!attachments, deliveries,
    not_attempted: v.recipients.filter(r => !deliveries.some(d => d.recipients.includes(r)))};
}
const verb = (mode: "share" | "dispatch") => defineVerb({
  name: `doc.${mode}`, kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: `${mode === "share" ? "Share a file or page by one mail" : "Dispatch a file or page in separate mails, one per member"}. Only active human organization members; agents reuse their existing member/contact rule. Files up to 512 KiB attached, otherwise authenticated links. Sending switch, caps and withdrawal apply. Check deliveries and not_attempted before retrying.`,
  mcp: {scope: "write", destructive: false, title: mode === "share" ? "Share document" : "Dispatch document", input},
  parse, run: (ctx, v) => sendDocument(ctx, v, mode),
});
export const docShare = verb("share"), docDispatch = verb("dispatch");
export const docVerbs = [docShare, docDispatch];
