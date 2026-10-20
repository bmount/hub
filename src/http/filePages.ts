import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { getVerb } from "../verbs/table";
import { checkAccess, checkScope } from "../verbs/dispatch";
import { esc, htmlResponse, page, workbench, kitTree, kitTable, localTime, toolbar } from "../html";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { sameOrigin } from "./login";
import { readRequestBytes, requestWithBytes } from "./body";
import { HubError, badRequest, notFound } from "../errors";
import { sha256Hex } from "../ids";
import { multipartRequest } from "../db/fileMultipart";
import { FILE_REQUEST_BYTES, inferredFileType, fileList, fileHistory, fileProject, filePath, parseFileParams, putFile, readFile } from "../verbs/files";

import { recordFileDownload, fileDownloadAudit } from "../db/fileDownloads";
import { documentSharing } from "./documentSharing";

export async function filePage(request: Request, env: Env, project: string, action = ""): Promise<Response> {
  const ctx = await buildContext(request, env, Date.now(), undefined, {longLivedToken: true});
  const url = new URL(request.url);
  try {
    const writing = request.method !== "GET" || action === "upload";
    const verb = getVerb(writing ? "file.put" : "file.get")!;
    checkScope(ctx, verb);
    checkAccess(ctx, verb);
    if (request.method !== "GET" && ctx.authKind === "cookie" && !sameOrigin(request)) throw new HubError(403, "bad_origin");
    const p = await fileProject(ctx, project, writing);
    if (action === "upload" && writing) {
      if (url.searchParams.get("multipart") === "1") return Response.json({ok: true, result: await multipartRequest(ctx, request, p.id)}, {headers: {"cache-control": "no-store"}});
      if (request.method === "PUT") {
        const token = url.searchParams.get("token");
        if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound("invalid upload capability");
        const row = await ctx.db.prepare(`/*perf-site:src%2Fhttp%2FfilePages.ts:30:27:filePage:d6a002bc*/ UPDATE file_upload SET used = 1 WHERE token_hash = ? AND tenant_id = ? AND project_id = ? AND identity_id = ? AND expires_at > ? AND used = 0 RETURNING params`).bind(await sha256Hex(token), ctx.tenant!.id, p.id, ctx.identity!.id, ctx.now).first<{params: string}>();
        if (!row) throw notFound("expired or consumed upload capability");
        const v = parseFileParams(JSON.parse(row.params));
        if ((request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== v.content_type.split(";")[0]!.trim().toLowerCase()) throw badRequest("Content-Type must match the upload declaration");
        const bytes = await readRequestBytes(request, FILE_REQUEST_BYTES);
        const result = await putFile(ctx, v, bytes);
        return Response.json({ok: true, result}, {headers: {"cache-control": "no-store"}});
      }
      if (request.method !== "POST") throw badRequest("use POST multipart or PUT with an upload capability");
      const bytes = await readRequestBytes(request, FILE_REQUEST_BYTES + 16384);
      const fd = await requestWithBytes(request, bytes).formData();
      const file = fd.get("file");
      if (!(file instanceof File)) throw badRequest("file is required");
      const path = filePath(String(fd.get("path") || file.name));
      const current = await ctx.db.prepare("/*perf-site:src%2Fhttp%2FfilePages.ts:44:29:filePage:20d16db6*/ SELECT COALESCE(MAX(revision), 0) AS revision FROM file_revision WHERE tenant_id = ? AND project_id = ? AND path = ?").bind(ctx.tenant!.id, p.id, path).first<{revision:number}>();
      const v = parseFileParams({project, path, content_type: !file.type || file.type === "application/octet-stream" ? inferredFileType(path) : file.type, expected_revision: fd.get("expected_revision") ?? current!.revision, item_id: fd.get("item_id"), person_id: fd.get("person_id")});
      let back = `/${project}/documents`;
      const returnHref = fd.get("_back");
      if (typeof returnHref === "string" && returnHref.startsWith("/") && !returnHref.startsWith("//")) {
        const target = new URL(returnHref,request.url);
        if (target.origin === url.origin && target.pathname === back) back = target.pathname + target.search;
      }
      await putFile(ctx, v, new Uint8Array(await file.arrayBuffer()));
      return new Response(null, {status: 303, headers: {location: back, "cache-control": "no-store"}});
    }
    if (writing) throw badRequest("invalid file route");
    if (action === "page") {
      return new Response("Files HTML rendering has been retired. Publish an HTML/SVG/ZIP bundle in Pages to view it, or download the original from Files.\n", {status: 410, headers: {"content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox"}});
    }
    if (action === "download") {
      const path = filePath(url.searchParams.get("path") ?? "");
      const n = url.searchParams.get("revision"), revision = n === null ? null : Number(n);
      if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) throw badRequest("invalid revision");
      const r = await readFile(ctx, project, path, revision);
      const etag = `"${r.sha256}"`;
      const rangeHeader = request.headers.get("range");
      let range: {offset: number; length: number} | undefined;
      if (rangeHeader && (!request.headers.has("if-range") || request.headers.get("if-range") === etag)) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!m || (!m[1] && !m[2]) || r.size === 0) return new Response(null, {status: 416, headers: {"content-range": `bytes */${r.size}`, "cache-control": "private, no-store"}});
        const start = m[1] ? Number(m[1]) : Math.max(0, r.size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(r.size - 1, Number(m[2])) : r.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= r.size || end < start) return new Response(null, {status: 416, headers: {"content-range": `bytes */${r.size}`, "cache-control": "private, no-store"}});
        range = {offset: start, length: end - start + 1};
      }
      const object = await env.GIT_PUSH_STAGING?.get(r.object_key, range ? {range} : undefined);
      if (!object) throw notFound("file storage unavailable");
      await recordFileDownload(ctx, p.id, r, range?.length ?? r.size, "download");
      // Active source in Files is downloadable only; publish visual content through Pages.
      const disposition = (r.content_type.startsWith("image/") && r.content_type !== "image/svg+xml") || r.content_type === "application/pdf" ? "inline" : "attachment";
      return new Response(object.body, {status: range ? 206 : 200, headers: {"accept-ranges": "bytes", "etag": etag, "x-content-sha256": r.sha256, ...(range ? {"content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${r.size}`} : {}), "content-type": r.content_type, "content-length": String(range?.length ?? r.size), "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(r.name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16))}`, "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "private, no-store"}});
    }
    if (action) return notFoundPage();
    const v = await fileList.run(ctx, fileList.parse({project, after: url.searchParams.get("after"), folder: url.searchParams.get("folder")}));
    const link = (path: string, revision: number) => `/${project}/documents/download?path=${encodeURIComponent(path)}&revision=${revision}`;
    const query = new URLSearchParams(url.searchParams);
    query.delete("path"); query.delete("before"); query.delete("upload");
    const select = (changes: Record<string,string | null>) => {
      const q = new URLSearchParams(query);
      for (const [k,v] of Object.entries(changes)) {if (v === null) q.delete(k); else q.set(k,v);}
      return `/${project}/documents${q.size ? `?${q}` : ""}`;
    };
    const all = await fileList.run(ctx, fileList.parse({project}));
    const folders = [...new Set(all.files.flatMap(r => r.path.split("/").slice(0,-1).map((_,i)=>r.path.split("/").slice(0,i+1).join("/"))))].sort();
    const folderTree = (parent: string): import("../html").TreeNode[] => folders.filter(f=>f.substring(0,f.lastIndexOf("/")) === parent || !parent && !f.includes("/")).map(f=>({label:f.split("/").at(-1)!,href:select({folder:f,after:null}),current:query.get("folder") === f,expanded:true,children:folderTree(f)}));
    const uploaders = new Map((await ctx.db.prepare("/*perf-site:src%2Fhttp%2FfilePages.ts:80:38:filePage:90599195*/ SELECT id, display_name FROM identity WHERE id IN (SELECT uploader_id FROM file_revision WHERE tenant_id = ? AND project_id = ?)").bind(ctx.tenant!.id,p.id).all<{id:string;display_name:string}>()).results.map(i=>[i.id,i.display_name]));
    const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KiB` : `${(n/1048576).toFixed(1)} MiB`;
    let list = `<h1>Files</h1><p class="wb-hint">Documents and raster images · 5 GiB per file · 50 GiB including versions. Browser form: 25 MiB; use file_upload_url for resumable larger uploads.</p>` + toolbar("File actions", rank(ctx.role) >= rank("member") && p.state === "active" ? `<a href="${esc(select({upload:"1"}))}">Upload</a>` : "") + kitTree("Folders", [{label:"All files",href:select({folder:null,after:null}),current:!query.has("folder"),children:folderTree(""),expanded:true}]) + kitTable("Files",[{label:"File"},{label:"Size"},{label:"Modified"},{label:"By",className:"hide-s"}],v.files.map(r=>({href:select({path:r.path}),selected:r.path === url.searchParams.get("path"),cells:[{html:`<a href="${esc(select({path:r.path}))}">${esc(r.path)}</a>`},{html:size(r.size)},{html:localTime(r.created_at)},{html:esc(uploaders.get(r.uploader_id) ?? "Unknown"),className:"hide-s"}]}))) + (v.next_cursor ? `<a href="${esc(select({after:v.next_cursor}))}">Next files</a>` : "");
    let body = `<a class="back" href="${esc(select({}))}">Close</a>`;
    const path = url.searchParams.get("path");
    if (path) {
      const h = await fileHistory.run(ctx, fileHistory.parse({project, path}));
      const latest = h.history[0];
      body += `<h1>${esc(path)}</h1>${latest ? `<p>${size(latest.size)} · modified ${localTime(latest.created_at)} by ${esc(uploaders.get(latest.uploader_id) ?? "Unknown")}</p>${latest.deleted ? '<p>Removed</p>' : `<p><a class="button quiet" href="${esc(link(path,latest.revision))}">Download</a></p>`}` : ""}`;
      const downloads = await fileDownloadAudit(ctx, p.id, path);
      if (downloads) body += `<h2>Download audit · admins only</h2>` + kitTable("Download audit", [{label:"Who"},{label:"Revision"},{label:"Bytes"},{label:"Source"},{label:"When"}], downloads.map(d => ({cells:[{html:esc(String(d.who))},{html:esc(String(d.revision))},{html:esc(String(d.bytes))},{html:esc(`${d.source} · ${d.operation}`)},{html:localTime(Number(d.created_at))}]})));
      body += await documentSharing(ctx, p.id, project, "file", path, p.state === "active", select({path}));
    }
    const upload = url.searchParams.has("upload") && rank(ctx.role) >= rank("member") && p.state === "active";
    const items = upload ? (await ctx.db.prepare("/*perf-site:src%2Fhttp%2FfilePages.ts:92:35:filePage:29ffe77e*/ SELECT id, number, title FROM work_item WHERE tenant_id = ? AND project_id = ? ORDER BY number DESC LIMIT 200").bind(ctx.tenant!.id,p.id).all<{id:string;number:number;title:string}>()).results : [];
    const people = upload ? (await ctx.db.prepare("/*perf-site:src%2Fhttp%2FfilePages.ts:93:36:filePage:80b3001c*/ SELECT i.id, i.display_name AS name FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active' ORDER BY i.display_name LIMIT 200").bind(ctx.tenant!.id).all<{id:string;name:string}>()).results : [];
    if (upload) body += `<h2>Upload a file or version</h2><form method="post" data-reload enctype="multipart/form-data" action="/${esc(project)}/documents/upload"><input type="hidden" name="_back" value="${esc(select({}))}"><label>File <input type="file" name="file" required></label><label>Folder/name (blank uses filename) <input name="path" maxlength="240"></label><label>Item (optional) <select name="item_id"><option value="">None</option>${items.map(i=>`<option value="${esc(i.id)}">#${i.number} ${esc(i.title)}</option>`).join("")}</select></label><label>Person (optional) <select name="person_id"><option value="">None</option>${people.map(i=>`<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("")}</select></label><button>Upload</button></form>`;
    if (path && p.state === "active" && rank(ctx.role) >= rank("admin")) body += `<form method="post" action="/api/file.delete"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="path" value="${esc(path)}"><input type="hidden" name="_back" value="/${esc(project)}/documents"><button class="quiet destructive">Remove file and all downloads</button></form>`;
    return htmlResponse(workbench("Files", {list, stackOnPhone:true, listKey:`documents:${project}:${query}`, inspector:path || url.searchParams.has("upload") ? body : "", inspectorKey:path ? `document:${path}` : "", focus:url.searchParams.has("upload") ? "inspector" : undefined}, shellFor(ctx, env, "project", project)!));
  } catch (e) {
    if (e instanceof HubError) return htmlResponse(page("Files", `<h1>File request refused</h1><p>${esc(e.detail ?? e.reason)}</p>`), e.status);
    throw e;
  }
}
