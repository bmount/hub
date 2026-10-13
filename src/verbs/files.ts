import { featureProject } from "./featureProject";
import { documentDeliveries } from "../db/documentDelivery";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { defineVerb, type McpInputSchema } from "./table";
import { reqString, optString, optInt } from "./params";
import { badRequest, conflict, notFound, HubError } from "../errors";
import type { Ctx } from "../auth/context";
import { requireProjectFeature } from "../projectFeatures";
import { sha256Hex, ulid } from "../ids";
import { recordEvent } from "../db/events";

export const FILE_BYTES = 25 * 1024 * 1024;
export const PROJECT_FILE_BYTES = 250 * 1024 * 1024;
export const BASE64_FILE_BYTES = 512 * 1024;
export const FILE_TEXT_BYTES = 128 * 1024;
export const currentFile = "r.revision = (SELECT MAX(h.revision) FROM file_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.path = r.path)";
export type FileRow = { path: string; revision: number; name: string; folder: string; content_type: string; size: number; sha256: string; object_key: string; uploader_id: string; created_at: number; item_id: string | null; person_id: string | null; deleted: number; text: string };
export function filePath(path: string): string {
  if (path.length > 240 || path.split("/").some(p => !p || p === "." || p === ".." || /[\\\u0000-\u001f\u007f]/.test(p))) throw badRequest("path must be a relative folder/name, at most 240 characters, without dot segments or control characters");
  return path;
}
const TYPES: Record<string, string[]> = {
  txt: ["text/plain"], md: ["text/markdown", "text/plain"], csv: ["text/csv", "text/plain"],
  pdf: ["application/pdf"], png: ["image/png"], jpg: ["image/jpeg"], jpeg: ["image/jpeg"], gif: ["image/gif"], webp: ["image/webp"],
  doc: ["application/msword"], xls: ["application/vnd.ms-excel"], ppt: ["application/vnd.ms-powerpoint"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  odt: ["application/vnd.oasis.opendocument.text"], ods: ["application/vnd.oasis.opendocument.spreadsheet"], odp: ["application/vnd.oasis.opendocument.presentation"],
};
export function inferredFileType(path: string): string { return TYPES[path.split(".").pop()!.toLowerCase()]?.[0] ?? ""; }
export function fileType(path: string, type: string): string {
  const ext = path.split(".").pop()!.toLowerCase();
  const clean = type.toLowerCase().split(";")[0]!.trim();
  if (!TYPES[ext]?.includes(clean)) throw badRequest("unsupported content type or filename/type mismatch (documents, UTF-8 txt/md/csv, and raster images only)");
  return TYPES[ext]![0]!;
}
export function validateFile(path: string, type: string, bytes: Uint8Array): {type: string; text: string} {
  if (bytes.byteLength > FILE_BYTES) throw new HubError(413, "too_large", "file limit is 25 MiB");
  type = fileType(path, type);
  let text = "";
  if (type.startsWith("text/")) {
    try { const decoded = new TextDecoder("utf-8", {fatal: true, ignoreBOM: false}).decode(bytes); if (decoded.includes("\0")) throw new Error(); text = new TextDecoder().decode(bytes.slice(0, FILE_TEXT_BYTES)); }
    catch { throw badRequest("text files must be UTF-8 without NUL bytes"); }
  } else {
    const starts = (...xs: number[]) => xs.every((x, i) => bytes[i] === x);
    const ascii = (s: string, at = 0) => [...s].every((x, i) => bytes[at + i] === x.charCodeAt(0));
    const valid = type === "application/pdf" ? ascii("%PDF-") : type === "image/png" ? starts(137,80,78,71,13,10,26,10)
      : type === "image/jpeg" ? starts(255,216,255) : type === "image/gif" ? ascii("GIF87a") || ascii("GIF89a")
      : type === "image/webp" ? ascii("RIFF") && ascii("WEBP",8)
      : /openxmlformats|opendocument/.test(type) ? starts(80,75,3,4) : starts(208,207,17,224,161,177,26,225);
    if (!valid) throw badRequest("file bytes do not match the content type");
  }
  return {type, text};
}
export async function fileProject(ctx: Ctx, slug: string, writing = false) {
  const p = await featureProject(ctx, slug);
  requireProjectFeature(p, "files");
  if (writing && p.state !== "active") throw conflict("project is archived");
  return p;
}
export type FileParams = {project: string; path: string; content_type: string; expected_revision: number; item_id: string | null; person_id: string | null};
export async function putFile(ctx: Ctx, v: FileParams, bytes: Uint8Array, source: string | null = null) {
  const p = await fileProject(ctx, v.project, true), tid = ctx.tenant!.id;
  filePath(v.path);
  const validated = validateFile(v.path, v.content_type, bytes);
  if (v.item_id && !await ctx.db.prepare("SELECT 1 FROM work_item WHERE id = ? AND tenant_id = ? AND project_id = ?").bind(v.item_id, tid, p.id).first()) throw notFound("no such project item");
  if (v.person_id && !await ctx.db.prepare("SELECT 1 FROM membership WHERE identity_id = ? AND tenant_id = ? AND state = 'active'").bind(v.person_id, tid).first()) throw notFound("no such organization person");
  if (source) {
    const existing = await ctx.db.prepare("SELECT path, revision FROM file_revision WHERE tenant_id = ? AND project_id = ? AND source = ?").bind(tid, p.id, source).first<{path: string; revision: number}>();
    if (existing) return {...existing, project: v.project};
  }
  const bucket = ctx.env.GIT_PUSH_STAGING;
  if (!bucket) throw new HubError(503, "unavailable", "file storage unavailable");
  // A private, disjoint prefix reuses the existing R2 binding; keys are never caller supplied.
  const key = `project-files/${tid}/${p.id}/${ulid(ctx.now)}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await bucket.put(key, bytes);
  const name = v.path.split("/").pop()!, folder = v.path.slice(0, -name.length).replace(/\/$/, "");
  try {
    // Quota and revision comparison occur in the insert, including all retained versions.
    const r = await ctx.db.prepare(`INSERT INTO file_revision (tenant_id, project_id, path, revision, name, folder, content_type, size, sha256, object_key, uploader_id, created_at, item_id, person_id, text, source)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE COALESCE((SELECT MAX(revision) FROM file_revision WHERE tenant_id = ? AND project_id = ? AND path = ?), 0) = ?
      AND COALESCE((SELECT SUM(size) FROM file_revision WHERE tenant_id = ? AND project_id = ?), 0) + ? <= ?
      AND EXISTS (SELECT 1 FROM project WHERE id = ? AND tenant_id = ? AND state = 'active' AND kind IN ('wiki', 'workspace'))`)
      .bind(tid, p.id, v.path, v.expected_revision + 1, name, folder, validated.type, bytes.length, sha256, key, ctx.identity!.id, ctx.now, v.item_id, v.person_id, validated.text, source,
        tid, p.id, v.path, v.expected_revision, tid, p.id, bytes.length, PROJECT_FILE_BYTES, p.id, tid).run();
    if (!r.meta.changes) throw conflict("stale revision, archived project, or project file quota (250 MiB including history) exceeded");
  } catch (e) {
    if (source) {
      const existing = await ctx.db.prepare("SELECT path, revision, object_key FROM file_revision WHERE tenant_id = ? AND project_id = ? AND source = ?").bind(tid, p.id, source).first<{path: string; revision: number; object_key: string}>();
      if (existing) {
        if (existing.object_key !== key) await bucket.delete(key);
        return {project: v.project, path: existing.path, revision: existing.revision};
      }
    }
    // Only a known refused insert is safe to clean up. A lost D1 response may have
    // committed; preserve the object rather than leave a committed version unreadable.
    if (e instanceof HubError && e.reason === "conflict") await bucket.delete(key);
    throw e;
  }
  await recordEvent(ctx.db, {tenant_id: tid, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: "file.put", target_kind: "project", target_id: p.id, summary: `File ${v.path} revision ${v.expected_revision + 1}`}, ctx.now);
  return {project: v.project, path: v.path, revision: v.expected_revision + 1, size: bytes.length, sha256};
}
export async function readFile(ctx: Ctx, project: string, path: string, revision: number | null = null) {
  const p = await fileProject(ctx, project);
  const row = await ctx.db.prepare(`SELECT r.* FROM file_revision r WHERE r.tenant_id = ? AND r.project_id = ? AND r.path = ? AND ${revision === null ? currentFile : "r.revision = ?"} AND r.deleted = 0`).bind(ctx.tenant!.id, p.id, path, ...(revision === null ? [] : [revision])).first<FileRow>();
  if (!row) throw notFound("no such file version");
  return row;
}
export const fileMetadata = ({object_key: _key, text: _text, ...row}: FileRow) => row;
const base = {scope: "tenant", freshProofMinutes: null} as const;
const props = {project: {type: "string"}, path: {type: "string"}};
const input = (extra: Record<string, Record<string, unknown>> = {}, required = ["project", "path"]): McpInputSchema => ({type: "object", properties: {...props, ...extra}, required, additionalProperties: false});
const ref = (i: Record<string, unknown>) => ({project: reqString(i, "project", {max: 127}), path: filePath(reqString(i, "path", {max: 240}))});
const putProps = {content_type: {type: "string"}, expected_revision: {type: "integer", minimum: 0}, item_id: {type: "string"}, person_id: {type: "string"}};
export function parseFileParams(i: Record<string, unknown>): FileParams {
  const expected_revision = optInt(i, "expected_revision", {min: 0, max: 2147483646});
  if (expected_revision === null) throw badRequest("expected_revision is required (0 for new files)");
  const v = {...ref(i), content_type: reqString(i, "content_type", {max: 150}), expected_revision, item_id: optString(i, "item_id", {max: 26}), person_id: optString(i, "person_id", {max: 26})};
  fileType(v.path, v.content_type);
  return v;
}
export const filePut = defineVerb({...base, name: "file.put", kind: "command", minRole: "member", summary: "Upload a document or new version as base64 (512 KiB decoded cap). expected_revision: 0 for new, current otherwise. For larger files use file.upload_url. Limits: 25 MiB/file, 250 MiB/project including history.", mcp: {scope: "write", destructive: false, auditKeysOnly: true, title: "Upload file", input: input({...putProps, base64: {type: "string"}}, ["project", "path", "content_type", "expected_revision", "base64"])}, parse: i => {
  const v = parseFileParams(i);
  if (typeof i.base64 !== "string" || i.base64.length > Math.ceil(BASE64_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(i.base64)) throw badRequest("base64 must be standard padded base64, at most 512 KiB decoded");
  const bytes = new Uint8Array(Buffer.from(i.base64, "base64"));
  if (bytes.length > BASE64_FILE_BYTES) throw badRequest("base64 file limit is 512 KiB");
  return {v, bytes};
}, run: (ctx, {v, bytes}) => putFile(ctx, v, bytes)});
export const fileList = defineVerb({...base, name: "file.list", kind: "query", minRole: "reader", summary: "List current project files (200/page), with optional folder prefix and after path cursor.", mcp: {scope: "read", destructive: false, title: "List files", input: input({folder: {type: "string"}, after: {type: "string"}}, ["project"])}, parse: i => ({project: reqString(i, "project", {max: 127}), folder: optString(i, "folder", {max: 240}) ?? "", after: optString(i, "after", {max: 240}) ?? ""}), run: async (ctx, v) => {
  const p = await fileProject(ctx, v.project);
  const rows = (await ctx.db.prepare(`SELECT r.* FROM file_revision r WHERE r.tenant_id = ? AND r.project_id = ? AND ${currentFile} AND r.deleted = 0 AND r.path > ? AND ( ? = '' OR r.folder = ? OR substr(r.folder, 1, length(?) + 1) = ? || '/') ORDER BY r.path LIMIT 201`).bind(ctx.tenant!.id, p.id, v.after, v.folder, v.folder, v.folder, v.folder).all<FileRow>()).results;
  return {files: rows.slice(0,200).map(fileMetadata), next_cursor: rows.length > 200 ? rows[199]!.path : null};
}});
export const fileGet = defineVerb({...base, name: "file.get", kind: "query", minRole: "reader", summary: "Fetch file metadata and authenticated web download URL; include_base64 returns bytes only up to 512 KiB. Optional revision selects an old version.", mcp: {scope: "read", destructive: false, title: "Get file", input: input({revision: {type: "integer", minimum: 1}, include_base64: {type: "boolean"}})}, parse: i => ({...ref(i), revision: optInt(i, "revision", {min: 1, max: 2147483647}), include_base64: i.include_base64 === true}), run: async (ctx, v) => {
  const r = await readFile(ctx, v.project, v.path, v.revision);
  let base64: string | undefined;
  if (v.include_base64) {
    if (r.size > BASE64_FILE_BYTES) throw badRequest("file too large for base64; use authenticated download_url");
    const object = await ctx.env.GIT_PUSH_STAGING?.get(r.object_key);
    if (!object) throw notFound("file storage unavailable");
    base64 = Buffer.from(await object.arrayBuffer()).toString("base64");
  }
  return {file: fileMetadata(r), deliveries: await documentDeliveries(ctx, (await fileProject(ctx, v.project)).id, "file", v.path), download_url: `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/${ctx.mcpProject?.path ?? v.project}/documents/download?path=${encodeURIComponent(v.path)}&revision=${r.revision}`, ...(base64 === undefined ? {} : {base64})};
}});
export const fileHistory = defineVerb({...base, name: "file.history", kind: "query", minRole: "reader", summary: "List file versions newest first (200/page); before revision selects older history.", mcp: {scope: "read", destructive: false, title: "File history", input: input({before: {type: "integer", minimum: 1}})}, parse: i => ({...ref(i), before: optInt(i, "before", {min: 1, max: 2147483647}) ?? 2147483648}), run: async (ctx, v) => {
  const p = await fileProject(ctx, v.project);
  const rows = (await ctx.db.prepare("SELECT * FROM file_revision WHERE tenant_id = ? AND project_id = ? AND path = ? AND revision < ? ORDER BY revision DESC LIMIT 201").bind(ctx.tenant!.id, p.id, v.path, v.before).all<FileRow>()).results;
  return {history: rows.slice(0,200).map(fileMetadata), next_cursor: rows.length > 200 ? rows[199]!.revision : null};
}});
export const fileDelete = defineVerb({...base, name: "file.delete", kind: "command", minRole: "admin", summary: "Hide a file and all its versions from downloads, lists and search (admin). Retained evidence still counts toward quota.", mcp: {scope: "write", destructive: true, title: "Delete file", input: input()}, parse: ref, run: async (ctx, v) => {
  const p = await fileProject(ctx, v.project, true);
  await ctx.db.prepare("UPDATE file_revision SET deleted = 1 WHERE tenant_id = ? AND project_id = ? AND path = ?").bind(ctx.tenant!.id, p.id, v.path).run();
  await recordEvent(ctx.db, {tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: "file.delete", target_kind: "project", target_id: p.id, summary: `File removed: ${v.path}`}, ctx.now);
  return {project: v.project, path: v.path, deleted: true};
}});
export const fileUploadUrl = defineVerb({...base, name: "file.upload_url", kind: "command", minRole: "member", summary: "Mint a one-time upload capability URL, valid 10 minutes. PUT raw bytes with the declared Content-Type and the same authenticated member credential; max 25 MiB. Token is consumed even on failed upload. No redirects or public R2 access.", mcp: {scope: "write", destructive: false, auditKeysOnly: true, title: "File upload URL", input: input(putProps, ["project", "path", "content_type", "expected_revision"])}, parse: parseFileParams, run: async (ctx, v) => {
  const p = await fileProject(ctx, v.project, true);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expires_at = ctx.now + 600000;
  await ctx.db.prepare("DELETE FROM file_upload WHERE expires_at <= ?").bind(ctx.now).run();
  await ctx.db.prepare("INSERT INTO file_upload (token_hash, tenant_id, project_id, identity_id, params, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(await sha256Hex(token), ctx.tenant!.id, p.id, ctx.identity!.id, JSON.stringify(v), expires_at).run();
  return {upload_url: `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/${ctx.mcpProject?.path ?? v.project}/documents/upload?token=${token}`, method: "PUT", expires_at, max_bytes: FILE_BYTES};
}});
export const fileVerbs = [filePut, fileGet, fileList, fileHistory, fileDelete, fileUploadUrl];
