import { recordFileDownload } from "../db/fileDownloads";
import { ASSETS } from "../assets";
import { Buffer } from "node:buffer";
import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { checkAccess, checkScope } from "../verbs/dispatch";
import { getVerb } from "../verbs/table";
import {
  pagesProject,
  pageList,
  pageHistory,
  readPage,
  publishPage,
  parsePublish,
  PAGE_BYTES,
  type Bundle,
} from "../verbs/pages";
import {
  pageCSS,
  pageHeaders,
  sanitizePage,
  type PageLocation,
} from "../security/pages";
import { esc, page, htmlResponse, localTime } from "../html";
import { sameOrigin } from "./login";
import { readRequestBytes, requestWithBytes } from "./body";
import { sha256Hex } from "../ids";
import { HubError, badRequest, notFound } from "../errors";
import { shellFor } from "./shell";

export async function projectPages(
  request: Request,
  env: Env,
  project: string,
  slug?: string,
  asset?: { revision: string; path: string },
): Promise<Response> {
  const ctx = await buildContext(request, env, Date.now(), undefined, {
    longLivedToken: true,
  });
  const url = new URL(request.url);
  try {
    const writing = request.method !== "GET";
    const verb = getVerb(writing ? "page.publish" : "page.read")!;
    checkScope(ctx, verb);
    checkAccess(ctx, verb);
    if (writing && ctx.authKind === "cookie" && !sameOrigin(request))
      throw new HubError(403, "bad_origin");
    const p = await pagesProject(ctx, project, writing);
    if (writing) {
      let v, bytes: Uint8Array;
      if (request.method === "PUT") {
        const token = url.searchParams.get("token");
        if (!token) throw notFound("missing upload capability");
        const row = await ctx.db
          .prepare(
            "DELETE FROM page_upload WHERE token_hash=? AND tenant_id=? AND project_id=? AND identity_id=? AND expires_at>? RETURNING params",
          )
          .bind(
            await sha256Hex(token),
            ctx.tenant!.id,
            p.id,
            ctx.identity!.id,
            ctx.now,
          )
          .first<{ params: string }>();
        if (!row) throw notFound("expired or consumed upload capability");
        v = parsePublish(JSON.parse(row.params));
        bytes = await readRequestBytes(request, PAGE_BYTES);
      } else if (request.method === "POST") {
        const fd = await requestWithBytes(
          request,
          await readRequestBytes(request, PAGE_BYTES + 16384),
        ).formData();
        const file = fd.get("file");
        if (!(file instanceof File)) throw badRequest("file required");
        v = parsePublish({
          project,
          slug: fd.get("slug"),
          title: fd.get("title"),
          expected_revision: fd.get("expected_revision"),
          filename: file.name,
        });
        bytes = new Uint8Array(await file.arrayBuffer());
      } else throw badRequest("use POST form or PUT upload URL");
      const result = await publishPage(ctx, v, bytes);
      return request.method === "PUT"
        ? Response.json({ ok: true, result })
        : new Response(null, {
            status: 303,
            headers: { location: result.url },
          });
    }
    if (slug) {
      const raw = asset?.revision ?? url.searchParams.get("revision");
      const revision = raw === null ? null : Number(raw);
      if (
        revision !== null &&
        (!Number.isSafeInteger(revision) || revision < 1)
      )
        throw badRequest("invalid revision");
      const row = await readPage(ctx, project, slug, revision);
      const base = `/${project}/pages/${slug}`;
      if (asset) {
        const object = await env.GIT_PUSH_STAGING?.get(row.object_key);
        if (!object) throw notFound("page storage unavailable");
        const bundle = await object.json<Bundle>();
        const path = asset.path;
        const item = Object.hasOwn(bundle, path) ? bundle[path] : undefined;
        if (!item) throw notFound("no such page asset");
        const bytes = Buffer.from(item.data, "base64"),
          location: PageLocation = {
            origin: url.origin,
            prefix: `/${project}/pages-content/${slug}/${row.revision}/`,
            path,
          };
        // Opaque sandbox documents cannot send SameSite=Lax cookies for their
        // subresources. Embed only authenticated bundle assets instead of issuing
        // bearer asset URLs or weakening the sandbox/session cookie.
        let embedded = 0;
        const active = new Set<string>();
        location.inline = (path) => {
          const asset = Object.hasOwn(bundle, path) ? bundle[path] : undefined;
          if (!asset || active.has(path) || active.size >= 5) return null;
          const data = Buffer.from(asset.data, "base64");
          embedded += data.length;
          if (embedded > PAGE_BYTES * 2)
            throw badRequest(
              "page embeds too many asset references (50 MiB rendered limit)",
            );
          if (asset.type === "text/css")
            return { type: asset.type, source: data.toString("utf8"), url: "" };
          if (!/^(image\/|font\/)/.test(asset.type)) return null;
          active.add(path);
          try {
            const encoded =
              asset.type === "image/svg+xml"
                ? Buffer.from(
                    sanitizePage(
                      data.toString("utf8"),
                      { ...location, path },
                      true,
                    ),
                  ).toString("base64")
                : asset.data;
            return {
              type: asset.type,
              source: "",
              url: `data:${asset.type};base64,${encoded}`,
            };
          } finally {
            active.delete(path);
          }
        };
        const body =
          item.type === "text/html" || item.type === "image/svg+xml"
            ? sanitizePage(
                bytes.toString("utf8"),
                location,
                item.type === "image/svg+xml",
              )
            : item.type === "text/css"
              ? pageCSS(bytes.toString("utf8"), location)
              : bytes;
        await recordFileDownload(
          ctx,
          p.id,
          { path: `pages/${slug}/${asset.path}`, revision: row.revision },
          typeof body === "string" ? Buffer.byteLength(body) : body.length,
          "download",
        );
        return new Response(body, {
          headers: {
            ...pageHeaders(location),
            "content-type":
              item.type === "text/html"
                ? "text/html; charset=utf-8"
                : item.type,
            "access-control-allow-origin": "*",
          },
        });
      }
      const history = url.searchParams.has("history")
        ? (await pageHistory.run(ctx, pageHistory.parse({ project, slug })))
            .history
        : [];
      const content = `/${project}/pages-content/${slug}/${row.revision}/${row.entry}`;
      return htmlResponse(
        page(
          row.title,
          `<style>html,body{margin:0!important;padding:0!important;width:100%;height:100%;overflow:hidden}body>header.top,body>footer{display:none}body>main{max-width:none!important;margin:0!important;padding:0!important;height:100%}.page-view{height:100dvh;display:flex;flex-direction:column;background:Canvas;color:CanvasText;color-scheme:light dark}.page-bar{display:flex;align-items:center;gap:.7rem;padding:.4rem .6rem;flex-wrap:wrap;font:13px system-ui}.page-bar strong{max-width:30vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.page-bar a,.page-bar button{font:inherit;padding:.2rem;min-height:28px;margin:0;line-height:1.2;box-shadow:none}.page-view iframe{border:0;flex:1;width:100%;min-height:0;background:Canvas}.page-view:fullscreen .page-bar,.page-view:fullscreen .page-history{display:none}.page-history{max-height:35vh;overflow:auto;padding:.5rem}@media(max-width:600px){.page-bar .by{font-size:11px;flex-basis:100%;order:1}.page-bar{gap:.4rem}}</style><section class="page-view" id="page-view"><header class="page-bar"><a href="/${esc(project)}/pages" aria-label="Pages list">‹ Pages</a><strong>${esc(row.title)}</strong><span>v${row.revision}</span><span class="by">${esc(row.author)} · ${localTime(row.created_at)}</span><button id="copy-page">Copy link</button><a href="${base}?revision=${row.revision}&history=1">History</a><button id="full-page">Full-screen</button></header>${history.length ? `<nav class="page-history">${history.map((r) => `<a href="${base}?revision=${r.revision}">v${r.revision} · ${esc(r.title)} · ${esc(r.author)}${r.deleted ? " (removed)" : ""}</a><br>`).join("")}</nav>` : ""}<iframe title="${esc(row.title)}" src="${esc(content)}" sandbox="allow-popups allow-popups-to-escape-sandbox" allowfullscreen></iframe></section><script defer src="${ASSETS.pages.path}"></script>`,
        ),
      );
    }
    const list = await pageList.run(
      ctx,
      pageList.parse({ project, after: url.searchParams.get("after") }),
    );
    const writable = rank(ctx.role) >= rank("member") && p.state === "active";
    const edit = url.searchParams.get("edit");
    const previous = edit ? await readPage(ctx, project, edit) : null;
    return htmlResponse(
      page(
        "Pages",
        `<h1>Pages</h1><p>Script-free HTML, SVG or a ZIP containing index.html and assets. 25 MiB per bundle, 5 MiB per asset, 200 assets. No JavaScript or external resources.</p>${list.pages.map((r) => `<p><a href="/${esc(project)}/pages/${r.slug}">${esc(r.title)}</a> · v${r.revision} · ${localTime(r.created_at)} · ${esc(r.author)} ${writable ? `<a href="?edit=${r.slug}">Upload new version</a>` : ""}</p>`).join("")}${list.next_cursor ? `<a href="?after=${list.next_cursor}">Next pages</a>` : ""}${writable ? `<form id="page-upload" method="post" enctype="multipart/form-data" action="/${esc(project)}/pages-upload"><h2>${previous ? "Upload new version" : "Upload page"}</h2><label>Slug <input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="100" value="${esc(previous?.slug ?? "")}" ${previous ? "readonly" : ""}></label><label>Title <input name="title" required maxlength="200" value="${esc(previous?.title ?? "")}"></label><input name="expected_revision" type="hidden" value="${previous?.revision ?? 0}"><label id="page-drop">Choose or drop one .html, .svg or .zip file <input type="file" name="file" accept=".html,.svg,.zip" required></label><button>Upload</button></form><script defer src="${ASSETS.pages.path}"></script>` : ""}`,
        shellFor(ctx, env, "project", "pages") ?? undefined,
      ),
    );
  } catch (e) {
    if (e instanceof HubError)
      return htmlResponse(
        page(
          "Pages",
          `<h1>Page request refused</h1><p>${esc(e.detail ?? e.reason)}</p><a href="/${esc(project)}/pages">Back to Pages</a>`,
        ),
        e.status,
      );
    throw e;
  }
}
