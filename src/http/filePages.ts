import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { getVerb } from "../verbs/table";
import { checkAccess, checkScope } from "../verbs/dispatch";
import { esc, htmlResponse, page } from "../html";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { sameOrigin } from "./login";
import { readRequestBytes, requestWithBytes } from "./body";
import { HubError, badRequest, notFound } from "../errors";
import { sha256Hex } from "../ids";
import { FILE_BYTES, inferredFileType, fileList, fileHistory, fileProject, filePath, parseFileParams, putFile, readFile } from "../verbs/files";

export async function filePage(request: Request, env: Env, project: string, action = ""): Promise<Response> {
  const ctx = await buildContext(request, env, Date.now(), undefined, {longLivedToken: true});
  const url = new URL(request.url);
  try {
    const writing = request.method !== "GET";
    const verb = getVerb(writing ? "file.put" : "file.get")!;
    checkScope(ctx, verb);
    checkAccess(ctx, verb);
    if (writing && ctx.authKind === "cookie" && !sameOrigin(request)) throw new HubError(403, "bad_origin");
    const p = await fileProject(ctx, project, writing);
    if (action === "upload" && writing) {
      if (request.method === "PUT") {
        const token = url.searchParams.get("token");
        if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound("invalid upload capability");
        const row = await ctx.db.prepare(`UPDATE file_upload SET used = 1 WHERE token_hash = ? AND tenant_id = ? AND project_id = ? AND identity_id = ? AND expires_at > ? AND used = 0 RETURNING params`).bind(await sha256Hex(token), ctx.tenant!.id, p.id, ctx.identity!.id, ctx.now).first<{params: string}>();
        if (!row) throw notFound("expired or consumed upload capability");
        const v = parseFileParams(JSON.parse(row.params));
        if ((request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== v.content_type.split(";")[0]!.trim().toLowerCase()) throw badRequest("Content-Type must match the upload declaration");
        const bytes = await readRequestBytes(request, FILE_BYTES);
        const result = await putFile(ctx, v, bytes);
        return Response.json({ok: true, result}, {headers: {"cache-control": "no-store"}});
      }
      if (request.method !== "POST") throw badRequest("use POST multipart or PUT with an upload capability");
      const bytes = await readRequestBytes(request, FILE_BYTES + 16384);
      const fd = await requestWithBytes(request, bytes).formData();
      const file = fd.get("file");
      if (!(file instanceof File)) throw badRequest("file is required");
      const v = parseFileParams({project, path: fd.get("path") || file.name, content_type: file.type || inferredFileType(String(fd.get("path") || file.name)), expected_revision: fd.get("expected_revision"), item_id: fd.get("item_id"), person_id: fd.get("person_id")});
      await putFile(ctx, v, new Uint8Array(await file.arrayBuffer()));
      return new Response(null, {status: 303, headers: {location: `/${project}/documents`, "cache-control": "no-store"}});
    }
    if (writing) throw badRequest("invalid file route");
    if (action === "download") {
      const path = filePath(url.searchParams.get("path") ?? "");
      const n = url.searchParams.get("revision"), revision = n === null ? null : Number(n);
      if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) throw badRequest("invalid revision");
      const r = await readFile(ctx, project, path, revision);
      const object = await env.GIT_PUSH_STAGING?.get(r.object_key);
      if (!object) throw notFound("file storage unavailable");
      // Raster images/PDF only can be inline. SVG and HTML are not accepted at ingress.
      const disposition = r.content_type.startsWith("image/") || r.content_type === "application/pdf" ? "inline" : "attachment";
      return new Response(object.body, {headers: {"content-type": r.content_type, "content-length": String(r.size), "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(r.name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16))}`, "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "private, no-store"}});
    }
    if (action) return notFoundPage();
    const v = await fileList.run(ctx, fileList.parse({project, after: url.searchParams.get("after"), folder: url.searchParams.get("folder")}));
    const link = (path: string, revision: number) => `/${project}/documents/download?path=${encodeURIComponent(path)}&revision=${revision}`;
    let body = `<p><a href="/${esc(project)}">${esc(project)}</a> / Files</p><h1>Files</h1><p>25 MiB per file; 250 MiB per project including versions. Text search retains the first 128 KiB of UTF-8 txt/md/csv. Documents and raster images only; no HTML or SVG.</p><ul>${v.files.map(r => `<li><a href="${esc(link(r.path, r.revision))}">${esc(r.path)}</a> · version ${r.revision} · ${r.size} bytes · <a href="/${esc(project)}/documents?path=${encodeURIComponent(r.path)}">History</a></li>`).join("")}</ul>${v.next_cursor ? `<a href="/${esc(project)}/documents?after=${encodeURIComponent(v.next_cursor)}&folder=${encodeURIComponent(url.searchParams.get("folder") ?? "")}">Next files</a>` : ""}`;
    const path = url.searchParams.get("path");
    if (path) {
      const h = await fileHistory.run(ctx, fileHistory.parse({project, path, before: url.searchParams.get("before")}));
      body += `<h2>History: ${esc(path)}</h2><ul>${h.history.map(r => `<li>${r.deleted ? 'Removed' : `<a href="${esc(link(path,r.revision))}">Version ${r.revision}</a>`} · ${esc(new Date(r.created_at).toISOString())} · ${esc(r.sha256)}</li>`).join("")}</ul>${h.next_cursor ? `<a href="/${esc(project)}/documents?path=${encodeURIComponent(path)}&before=${h.next_cursor}">Older versions</a>` : ""}`;
      if (rank(ctx.role) >= rank("admin")) body += `<form method="post" action="/api/file.delete"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="path" value="${esc(path)}"><input type="hidden" name="_back" value="/${esc(project)}/documents"><button>Remove file and all downloads</button></form>`;
    }
    if (rank(ctx.role) >= rank("member") && p.state === "active") body += `<h2>Upload a file or version</h2><form method="post" enctype="multipart/form-data" action="/${esc(project)}/documents/upload"><label>File <input type="file" name="file" required></label><label>Folder/name (blank uses filename) <input name="path" maxlength="240"></label><label>Current revision (0 for new) <input name="expected_revision" type="number" min="0" value="0" required></label><label>Item ID (optional) <input name="item_id"></label><label>Person ID (optional) <input name="person_id"></label><button>Upload</button></form>`;
    return htmlResponse(page("Files", body, shellFor(ctx, env, "project", project)));
  } catch (e) {
    if (e instanceof HubError) return htmlResponse(page("Files", `<h1>File request refused</h1><p>${esc(e.detail ?? e.reason)}</p>`), e.status);
    throw e;
  }
}
