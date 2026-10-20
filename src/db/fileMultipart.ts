import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import verifier from "stream-json/utils/verifier.js";
import type { Duplex } from "node:stream";
import type { Ctx } from "../auth/context";
import type { Env } from "../env";
import { badRequest, conflict, notFound, HubError } from "../errors";
import { sha256Hex, ulid } from "../ids";
import { fileProject, fileType, putFile, validateFile, FILE_BYTES, FILE_TEXT_BYTES, type FileParams } from "../verbs/files";
import { readRequestBytes } from "../http/body";

export const FILE_JSON_MAX_DEPTH = 256;
export const FILE_PART_BYTES = 16 * 1024 * 1024;
export const FILE_UPLOAD_LIFETIME = 24 * 60 * 60 * 1000;
type Upload = {token_hash: string; tenant_id: string; project_id: string; identity_id: string; params: string; object_key: string; upload_id: string; size: number; sha256: string; expires_at: number; state: string; result: string | null};

export async function startFileUpload(ctx: Ctx, v: FileParams, size: number, sha256: string) {
  if (!Number.isSafeInteger(size) || size < 1 || size > FILE_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) throw badRequest("invalid upload size or SHA-256");
  const p = await fileProject(ctx, v.project, true);
  const bucket = ctx.env.GIT_PUSH_STAGING;
  if (!bucket) throw new HubError(503, "unavailable");
  const active = await ctx.db.prepare("SELECT COUNT(*) AS n FROM file_multipart WHERE identity_id = ? AND expires_at > ? AND state != 'done'").bind(ctx.identity!.id, ctx.now).first<{n: number}>();
  if (active!.n >= 10) throw conflict("at most 10 active uploads per identity; abandon an upload first");
  const key = `project-files/${ctx.tenant!.id}/${p.id}/${ulid(ctx.now)}`;
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const upload = await bucket.createMultipartUpload(key);
  const expires_at = ctx.now + FILE_UPLOAD_LIFETIME;
  try {
    await ctx.db.prepare("INSERT INTO file_multipart (token_hash, tenant_id, project_id, identity_id, params, object_key, upload_id, size, sha256, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(await sha256Hex(token), ctx.tenant!.id, p.id, ctx.identity!.id, JSON.stringify(v), key, upload.uploadId, size, sha256, expires_at).run();
  } catch (e) { await upload.abort(); throw e; }
  return {upload_url: `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/${ctx.mcpProject?.path ?? v.project}/documents/upload?multipart=1&token=${token}`, expires_at, max_bytes: FILE_BYTES, part_bytes: FILE_PART_BYTES, parts: Math.ceil(size / FILE_PART_BYTES), sha256, protocol: "GET status; PUT &part=N (1-based, exact part_bytes except last); POST finish; DELETE abandon. Authenticate every request with your own credential."};
}

export async function multipartRequest(ctx: Ctx, request: Request, projectId: string) {
  const url = new URL(request.url), token = url.searchParams.get("token");
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound("invalid upload capability");
  const hash = await sha256Hex(token);
  const row = await ctx.db.prepare("SELECT * FROM file_multipart WHERE token_hash = ? AND tenant_id = ? AND project_id = ? AND identity_id = ? AND expires_at > ?").bind(hash, ctx.tenant!.id, projectId, ctx.identity!.id, ctx.now).first<Upload>();
  if (!row) throw notFound("expired or unknown upload");
  const bucket = ctx.env.GIT_PUSH_STAGING!;
  const parts = (await ctx.db.prepare("SELECT part, etag, sha256 FROM file_multipart_part WHERE token_hash = ? ORDER BY part").bind(hash).all<{part: number; etag: string; sha256: string}>()).results;
  const count = Math.ceil(row.size / FILE_PART_BYTES);
  if (request.method === "GET") return {state: row.state, size: row.size, sha256: row.sha256, part_bytes: FILE_PART_BYTES, parts: count, received: parts.map(p => ({part: p.part, sha256: p.sha256})), expires_at: row.expires_at, result: row.result ? JSON.parse(row.result) : null};
  if (row.state === "done") {
    if (request.method === "POST") return JSON.parse(row.result!);
    throw conflict("upload already finished");
  }
  if (request.method === "DELETE") {
    // Expire first: no new authorized work can start. Cleanup retries storage failures.
    await ctx.db.prepare("UPDATE file_multipart SET state = 'abandoned', expires_at = ? WHERE token_hash = ?").bind(ctx.now, hash).run();
    await bucket.resumeMultipartUpload(row.object_key, row.upload_id).abort();
    return {abandoned: true};
  }
  if (request.method === "PUT") {
    if (row.state !== "open") throw conflict("upload is finishing; retry POST");
    const n = Number(url.searchParams.get("part"));
    if (!Number.isSafeInteger(n) || n < 1 || n > count) throw badRequest("invalid part number");
    const expected = Math.min(FILE_PART_BYTES, row.size - (n - 1) * FILE_PART_BYTES);
    const bytes = await readRequestBytes(request, expected);
    if (bytes.length !== expected) throw badRequest("part length does not match declaration; retry the same part");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const declared = request.headers.get("x-content-sha256");
    if (declared !== null && declared !== sha256) throw badRequest("part SHA-256 mismatch");
    const prior = parts.find(p => p.part === n);
    if (prior) {
      if (prior.sha256 !== sha256) throw conflict("part already stored with different bytes");
      return {part: n, sha256};
    }
    const part = await bucket.resumeMultipartUpload(row.object_key, row.upload_id).uploadPart(n, bytes);
    await ctx.db.prepare("INSERT INTO file_multipart_part (token_hash, part, etag, sha256) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM file_multipart WHERE token_hash = ? AND state = 'open' AND expires_at > ?) ON CONFLICT(token_hash, part) DO NOTHING").bind(hash, n, part.etag, sha256, hash, ctx.now).run();
    return {part: n, sha256};
  }
  if (request.method !== "POST") throw badRequest("use GET, PUT, POST or DELETE");
  if (row.state !== 'open' && row.state !== 'finishing') throw conflict("upload is not active");
  if (parts.length !== count || parts.some((p, i) => p.part !== i + 1)) throw conflict("upload has missing parts");
  await ctx.db.prepare("UPDATE file_multipart SET state = 'finishing' WHERE token_hash = ? AND state = 'open'").bind(hash).run();
  // Complete is immutable. A lost response can be recovered by reading the unique key.
  let object = await bucket.get(row.object_key);
  if (!object) {
    try { await bucket.resumeMultipartUpload(row.object_key, row.upload_id).complete(parts.map(p => ({partNumber: p.part, etag: p.etag}))); }
    catch (e) { if (!await bucket.head(row.object_key)) throw e; }
    object = await bucket.get(row.object_key);
  }
  if (!object || object.size !== row.size) throw conflict("stored size does not match upload");
  const v: FileParams = JSON.parse(row.params);
  const verified = await verifyFileStream(object.body, v, row.size);
  if (verified.sha256 !== row.sha256) throw badRequest("file SHA-256 mismatch; abandon and start again");
  const result = await putFile(ctx, v, new Uint8Array(), `multipart:${hash}`, {key: row.object_key, size: row.size, token_hash: hash, ...verified});
  await ctx.db.prepare("UPDATE file_multipart SET state = 'done', result = ? WHERE token_hash = ?").bind(JSON.stringify(result), hash).run();
  return result;
}

/** Hash and validate without buffering the object; storage stays private until verified. */
export async function verifyFileStream(body: ReadableStream<Uint8Array>, v: FileParams, size: number) {
  const type = fileType(v.path, v.content_type), hash = createHash("sha256");
  const textual = type.startsWith("text/") || type === "application/json" || type === "application/x-ndjson";
  const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: false});
  let head = new Uint8Array(), tail = new Uint8Array(), text = "", total = 0;
  // Verifier checks grammar without constructing values (even a multi-GB JSON string).
  const json = type === "application/json", ndjson = type === "application/x-ndjson";
  const newVerifier = () => { const p = verifier.asStream(); p.on("error", () => {}); return p; };
  let parser: Duplex | null = json ? newVerifier() : null;
  let depth = 0, inString = false, escaped = false;
  const endJson = async () => {
    if (parser) { const p = parser; try { await new Promise<void>((resolve, reject) => p.end((e: Error | null | undefined) => e ? reject(e) : resolve())); } finally { p.destroy(); parser = null; } }
    depth = 0; inString = false; escaped = false;
  };
  const writeJson = async (s: string) => {
    // Bound the verifier's stack before handing it untrusted input. String/escape
    // state survives chunk boundaries; grammar remains the verifier's job.
    for (const c of s) {
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "[" || c === "{") {
        if (++depth > FILE_JSON_MAX_DEPTH) throw badRequest(`JSON nesting exceeds ${FILE_JSON_MAX_DEPTH}`);
      } else if (c === "]" || c === "}") depth--;
    }
    if (!parser && ndjson && s.trim()) parser = newVerifier();
    if (parser) { const p = parser; await new Promise<void>((resolve, reject) => p.write(s, e => e ? reject(e) : resolve())); }
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.length;
      if (total > size || total > FILE_BYTES) throw badRequest("file size mismatch");
      hash.update(value);
      if (head.length < FILE_TEXT_BYTES) { const next = new Uint8Array(Math.min(FILE_TEXT_BYTES, head.length + value.length)); next.set(head); next.set(value.subarray(0, next.length - head.length), head.length); head = next; }
      tail = value.length >= 4 ? value.slice(-4) : new Uint8Array([...tail, ...value].slice(-4));
      if (textual) {
        const decoded = decoder.decode(value, {stream: true});
        if (decoded.includes("\0")) throw badRequest("text files must be UTF-8 without NUL bytes");
        if (json) await writeJson(decoded);
        if (ndjson) {
          const lines = decoded.split("\n");
          for (let i = 0; i < lines.length; i++) { await writeJson(lines[i]!); if (i < lines.length - 1) await endJson(); }
        }
      }
    }
    if (textual) { decoder.decode(); await endJson(); text = new TextDecoder().decode(head); }
  } catch (e) { await reader.cancel().catch(() => {}); if (e instanceof HubError) throw e; throw badRequest("invalid UTF-8 or JSON data"); }
  finally { parser?.destroy(); reader.releaseLock(); }
  if (total !== size) throw badRequest("file size mismatch");
  if (!textual) {
    if (type === "application/vnd.apache.parquet" && size < 12) throw badRequest("file bytes do not match the content type");
    const sample = type === "application/vnd.apache.parquet" ? new Uint8Array([...head, ...tail]) : head;
    validateFile(v.path, type, sample);
  } else if (type === "text/tab-separated-values" && /^\s*(?:<|#!|MZ|\u007fELF)/.test(text)) throw badRequest("file bytes do not match the content type");
  return {type, text, sha256: hash.digest("hex")};
}

export async function cleanupFileUploads(env: Env, now: number) {
  const bucket = env.GIT_PUSH_STAGING;
  if (!bucket) return;
  const rows = (await env.HUB_DB.prepare("SELECT * FROM file_multipart WHERE expires_at <= ? ORDER BY expires_at LIMIT 20").bind(now - 60 * 60 * 1000).all<Upload>()).results;
  for (const row of rows) {
    await env.HUB_DB.prepare("DELETE FROM file_multipart WHERE token_hash = ? AND expires_at <= ?").bind(row.token_hash, now).run();
  }
  const pending = (await env.HUB_DB.prepare("SELECT object_key, upload_id FROM file_multipart_gc LIMIT 20").all<{object_key: string; upload_id: string}>()).results;
  for (const row of pending) {
    await bucket.resumeMultipartUpload(row.object_key, row.upload_id).abort();
    // Completed keys are handled by the orphan scanner, which protects every revision.
    await env.HUB_DB.prepare("DELETE FROM file_multipart_gc WHERE object_key = ?").bind(row.object_key).run();
  }
}
