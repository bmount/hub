import { Buffer } from "node:buffer";
import { Unzip, UnzipInflate } from "fflate";
import { parse } from "parse5";
import { sanitizePage } from "../security/pages";
import { defineVerb, type McpInputSchema } from "./table";
import { reqString, optInt, optString } from "./params";
import { featureProject } from "./featureProject";
import { requireProjectFeature } from "../projectFeatures";
import { wikiSlug } from "./wiki";
import { filePath, inferredFileType, validateFile } from "./files";
import { badRequest, conflict, notFound, HubError } from "../errors";
import { sha256Hex, ulid, randomToken } from "../ids";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";

export const PAGE_BYTES = 25 * 1024 * 1024;
export const currentPage =
  "r.revision = (SELECT MAX(h.revision) FROM page_revision h WHERE h.tenant_id=r.tenant_id AND h.project_id=r.project_id AND h.slug=r.slug)";
export type PageRow = {
  slug: string;
  revision: number;
  title: string;
  entry: string;
  object_key: string;
  text: string;
  size: number;
  author_id: string;
  author: string;
  created_at: number;
  deleted: number;
};
export type Bundle = Record<string, { type: string; data: string }>;
export async function pagesProject(ctx: Ctx, project: string, writing = false) {
  const p = await featureProject(ctx, project);
  requireProjectFeature(p, "pages");
  if (writing && p.state !== "active") throw conflict("project is archived");
  return p;
}
const allowed = new Set([
  "text/html",
  "image/svg+xml",
  "text/css",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "font/woff",
  "font/woff2",
]);
export function pageBundle(
  filename: string,
  bytes: Uint8Array,
): { bundle: Bundle; entry: string; text: string; size: number } {
  if (bytes.length > PAGE_BYTES)
    throw badRequest("page bundle limit is 25 MiB");
  const bundle: Bundle = Object.create(null);
  let size = 0,
    count = 0;
  const add = (path: string, data: Uint8Array) => {
    filePath(path);
    if (/[?#%:]/.test(path))
      throw badRequest("bundle paths cannot contain ?, #, %, or :");
    if (/\.(?:js|mjs|cjs)$/i.test(path))
      throw badRequest(
        "JavaScript files are not allowed in Pages; pre-render charts as SVG instead",
      );
    const type = inferredFileType(path);
    if (!allowed.has(type)) throw badRequest(`unsupported page asset: ${path}`);
    if (Object.hasOwn(bundle, path)) throw badRequest("duplicate bundle path");
    size += data.length;
    if (size > PAGE_BYTES || data.length > 5 * 1024 * 1024 || ++count > 200)
      throw badRequest(
        "bundle limit: 25 MiB expanded, 200 assets, 5 MiB per asset",
      );
    validateFile(path, type, data);
    bundle[path] = { type, data: Buffer.from(data).toString("base64") };
  };
  let entry = "index.html";
  if (/\.zip$/i.test(filename)) {
    let failure: unknown;
    let expanded = 0,
      entries = 0,
      pending = 0;
    const unzip = new Unzip((file) => {
      if (++entries > 400) {
        failure = badRequest("ZIP has too many entries (200 assets maximum)");
        return;
      }
      if (file.name.endsWith("/")) return;
      pending++;
      // Check declared lengths before inflation, and count actual streamed bytes too.
      if (
        file.originalSize !== undefined &&
        file.originalSize > 5 * 1024 * 1024
      ) {
        failure = badRequest("page asset limit is 5 MiB");
        return;
      }
      const chunks: Uint8Array[] = [];
      let n = 0;
      file.ondata = (err, data, final) => {
        if (err) {
          failure = badRequest("invalid ZIP");
          return;
        }
        n += data.length;
        expanded += data.length;
        if (n > 5 * 1024 * 1024 || expanded > PAGE_BYTES) {
          failure = badRequest("ZIP expands beyond page limits");
          file.terminate();
          return;
        }
        chunks.push(data);
        if (final) pending--;
        if (final && !failure) {
          const all = new Uint8Array(n);
          let at = 0;
          for (const c of chunks) {
            all.set(c, at);
            at += c.length;
          }
          try {
            add(file.name, all);
          } catch (e) {
            failure = e;
          }
        }
      };
      if (!failure) file.start();
    });
    unzip.register(UnzipInflate);
    try {
      unzip.push(bytes, true);
    } catch {
      throw badRequest("invalid ZIP");
    }
    if (failure) throw failure;
    if (pending) throw badRequest("incomplete or unsupported ZIP entry");
    if (!Object.hasOwn(bundle, entry))
      throw badRequest("ZIP must contain index.html at its root");
  } else {
    if (!/\.(html|svg)$/i.test(filename))
      throw badRequest("upload one .html, .svg or .zip file");
    entry = /\.svg$/i.test(filename) ? "index.svg" : "index.html";
    add(entry, bytes);
  }
  const source = Buffer.from(bundle[entry]!.data, "base64").toString("utf8");
  const tree = parse(
    sanitizePage(
      source,
      { origin: "https://page.invalid", prefix: "/bundle/", path: entry },
      entry.endsWith(".svg"),
    ),
  );
  let text = "";
  function visible(node: any) {
    if (
      ["script", "style", "head", "template", "noscript"].includes(node.tagName)
    )
      return;
    if (node.nodeName === "#text") text += node.value + " ";
    for (const child of node.childNodes ?? []) visible(child);
  }
  visible(tree);
  return {
    bundle,
    entry,
    text: text.replace(/\s+/g, " ").slice(0, 131072),
    size,
  };
}
export type PublishParams = {
  project: string;
  slug: string;
  title: string;
  filename: string;
  expected_revision: number;
};
export async function publishPage(
  ctx: Ctx,
  v: PublishParams,
  bytes: Uint8Array,
) {
  const p = await pagesProject(ctx, v.project, true);
  const data = pageBundle(v.filename, bytes);
  const bucket = ctx.env.GIT_PUSH_STAGING;
  if (!bucket) throw new HubError(503, "unavailable");
  const key = `project-files/${ctx.tenant!.id}/${p.id}/${ulid(ctx.now)}`;
  await bucket.put(key, JSON.stringify(data.bundle));
  const result = await ctx.db
    .prepare(
      `INSERT INTO page_revision (tenant_id,project_id,slug,revision,title,entry,object_key,text,size,author_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM page_revision WHERE tenant_id=? AND project_id=? AND slug=?),0)=? AND EXISTS (SELECT 1 FROM project WHERE id=? AND tenant_id=? AND state='active' AND NOT EXISTS (SELECT 1 FROM meta WHERE key='project_delete:v1:' || project.tenant_id || ':' || project.id))`,
    )
    .bind(
      ctx.tenant!.id,
      p.id,
      v.slug,
      v.expected_revision + 1,
      v.title,
      data.entry,
      key,
      data.text,
      data.size,
      ctx.identity!.id,
      ctx.now,
      ctx.tenant!.id,
      p.id,
      v.slug,
      v.expected_revision,
      p.id,
      ctx.tenant!.id,
    )
    .run();
  if (!result.meta.changes) {
    await bucket.delete(key);
    throw conflict(
      "stale page upload: read the latest revision before publishing",
    );
  }
  await recordEvent(
    ctx.db,
    {
      tenant_id: ctx.tenant!.id,
      identity_id: ctx.identity!.id,
      session_id: ctx.session!.id,
      kind: "page.publish",
      target_kind: "project",
      target_id: p.id,
      summary: `Published ${v.project}/pages/${v.slug} v${v.expected_revision + 1}`,
    },
    ctx.now,
  );
  return {
    project: v.project,
    slug: v.slug,
    revision: v.expected_revision + 1,
    url: `/${v.project}/pages/${v.slug}`,
  };
}
export async function readPage(
  ctx: Ctx,
  project: string,
  slug: string,
  revision: number | null = null,
) {
  const p = await pagesProject(ctx, project);
  const row = await ctx.db
    .prepare(
      `SELECT r.*,i.display_name AS author FROM page_revision r JOIN identity i ON i.id=r.author_id WHERE r.tenant_id=? AND r.project_id=? AND r.slug=? AND ${revision === null ? currentPage : "r.revision=?"}`,
    )
    .bind(ctx.tenant!.id, p.id, slug, ...(revision === null ? [] : [revision]))
    .first<PageRow>();
  if (!row || (revision === null && row.deleted))
    throw notFound("no such page");
  return row;
}
const schema = (
  extra: Record<string, Record<string, unknown>> = {},
  required = ["project", "slug"],
): McpInputSchema => ({
  type: "object",
  properties: {
    project: { type: "string" },
    slug: { type: "string" },
    ...extra,
  },
  required,
  additionalProperties: false,
});
const ref = (i: Record<string, unknown>) => ({
  project: reqString(i, "project", { max: 127 }),
  slug: wikiSlug(reqString(i, "slug", { max: 100 })),
});
const base = { scope: "tenant", freshProofMinutes: null } as const;
const publishProperties = {
  title: { type: "string" },
  filename: { type: "string" },
  expected_revision: { type: "integer", minimum: 0 },
  html: { type: "string" },
  base64: { type: "string" },
};
export function parsePublish(i: Record<string, unknown>): PublishParams {
  return {
    ...ref(i),
    title: reqString(i, "title", { max: 200 }),
    filename: reqString(i, "filename", { max: 240 }),
    expected_revision:
      optInt(i, "expected_revision", { min: 0, max: 2147483646 }) ??
      (() => {
        throw badRequest("expected_revision required (0 for new page)");
      })(),
  };
}
export const pagePublish = defineVerb({
  ...base,
  name: "page.publish",
  kind: "command",
  minRole: "member",
  summary:
    "Publish script-free HTML/SVG or a ZIP with index.html and assets. expected_revision: 0 for new, current revision to update. Inline html/base64 up to 512 KiB; omit both to get a one-use upload URL for a PUT up to 25 MiB. JavaScript files refused. Old versions retained.",
  mcp: {
    scope: "write",
    destructive: false,
    auditKeysOnly: true,
    title: "Publish page",
    input: schema(publishProperties, [
      "project",
      "slug",
      "title",
      "filename",
      "expected_revision",
    ]),
  },
  parse: (i) => ({
    ...parsePublish(i),
    html: optString(i, "html", { max: 524288 }),
    base64: optString(i, "base64", { max: 700000 }),
  }),
  run: async (ctx, v) => {
    if (v.html !== null && v.base64 !== null)
      throw badRequest("send html or base64, not both");
    if (v.html !== null || v.base64 !== null) {
      const b =
        v.html !== null
          ? Buffer.from(v.html)
          : Buffer.from(v.base64!, "base64");
      if (b.length > 524288)
        throw badRequest(
          "inline limit is 512 KiB; omit content for an upload URL",
        );
      return publishPage(ctx, v, b);
    }
    const p = await pagesProject(ctx, v.project, true),
      token = randomToken("page");
    await ctx.db
      .prepare("DELETE FROM page_upload WHERE expires_at <= ?")
      .bind(ctx.now)
      .run();
    await ctx.db
      .prepare(
        "INSERT INTO page_upload (token_hash,tenant_id,project_id,identity_id,expires_at,params) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        await sha256Hex(token),
        ctx.tenant!.id,
        p.id,
        ctx.identity!.id,
        ctx.now + 900000,
        JSON.stringify(v),
      )
      .run();
    return {
      upload_url: `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/${v.project}/pages-upload?token=${token}`,
      method: "PUT",
      expires_at: ctx.now + 900000,
      max_bytes: PAGE_BYTES,
    };
  },
});
export const pageRead = defineVerb({
  ...base,
  name: "page.read",
  kind: "query",
  minRole: "reader",
  summary:
    "Read page metadata and visible text, optionally at a historical revision. URL is the full-screen viewer.",
  mcp: {
    scope: "read",
    destructive: false,
    title: "Read page",
    input: schema({ revision: { type: "integer", minimum: 1 } }),
  },
  parse: (i) => ({
    ...ref(i),
    revision: optInt(i, "revision", { min: 1, max: 2147483647 }),
  }),
  run: async (ctx, v) => {
    const { object_key, ...page } = await readPage(
      ctx,
      v.project,
      v.slug,
      v.revision,
    );
    return {
      page,
      url: `/${v.project}/pages/${v.slug}?revision=${page.revision}`,
    };
  },
});
export const pageList = defineVerb({
  ...base,
  name: "page.list",
  kind: "query",
  minRole: "reader",
  summary:
    "List current project Pages, 200 at a time, with title, revision, author and update time.",
  mcp: {
    scope: "read",
    destructive: false,
    title: "List pages",
    input: schema({ after: { type: "string" } }, ["project"]),
  },
  parse: (i) => ({
    project: reqString(i, "project", { max: 127 }),
    after: optString(i, "after", { max: 100 }) ?? "",
  }),
  run: async (ctx, v) => {
    const p = await pagesProject(ctx, v.project);
    const rows = (
      await ctx.db
        .prepare(
          `SELECT r.slug,r.title,r.revision,r.created_at,i.display_name AS author FROM page_revision r JOIN identity i ON i.id=r.author_id WHERE r.tenant_id=? AND r.project_id=? AND ${currentPage} AND r.deleted=0 AND r.slug>? ORDER BY r.slug LIMIT 201`,
        )
        .bind(ctx.tenant!.id, p.id, v.after)
        .all<PageRow>()
    ).results;
    return {
      pages: rows.slice(0, 200),
      next_cursor: rows.length > 200 ? rows[199]!.slug : null,
    };
  },
});
export const pageHistory = defineVerb({
  ...base,
  name: "page.history",
  kind: "query",
  minRole: "reader",
  summary:
    "Page versions, newest first. Each revision URL retains its original bundle and assets.",
  mcp: {
    scope: "read",
    destructive: false,
    title: "Page history",
    input: schema({ before: { type: "integer", minimum: 1 } }),
  },
  parse: (i) => ({
    ...ref(i),
    before: optInt(i, "before", { min: 1, max: 2147483647 }) ?? 2147483648,
  }),
  run: async (ctx, v) => {
    const p = await pagesProject(ctx, v.project);
    const rows = (
      await ctx.db
        .prepare(
          "SELECT r.revision,r.title,r.created_at,r.deleted,i.display_name AS author FROM page_revision r JOIN identity i ON i.id=r.author_id WHERE r.tenant_id=? AND r.project_id=? AND r.slug=? AND r.revision<? ORDER BY r.revision DESC LIMIT 201",
        )
        .bind(ctx.tenant!.id, p.id, v.slug, v.before)
        .all<PageRow>()
    ).results;
    return {
      history: rows.slice(0, 200),
      next_cursor: rows.length > 200 ? rows[199]!.revision : null,
    };
  },
});
export const pageDelete = defineVerb({
  ...base,
  name: "page.delete",
  kind: "command",
  minRole: "admin",
  summary:
    "Admin: remove a page from list and search; preserve version history. Requires current expected_revision.",
  mcp: {
    scope: "write",
    destructive: true,
    title: "Delete page",
    input: schema({ expected_revision: { type: "integer", minimum: 1 } }, [
      "project",
      "slug",
      "expected_revision",
    ]),
  },
  parse: (i) => ({
    ...ref(i),
    expected_revision:
      optInt(i, "expected_revision", { min: 1, max: 2147483646 }) ?? 0,
  }),
  run: async (ctx, v) => {
    const p = await pagesProject(ctx, v.project, true);
    const r = await readPage(ctx, v.project, v.slug);
    if (r.revision !== v.expected_revision) throw conflict("stale revision");
    const result = await ctx.db
      .prepare(
        "INSERT INTO page_revision SELECT tenant_id,project_id,slug,revision+1,title,entry,object_key,text,size,?, ?,1 FROM page_revision WHERE tenant_id=? AND project_id=? AND slug=? AND revision=? AND revision=(SELECT MAX(revision) FROM page_revision WHERE tenant_id=? AND project_id=? AND slug=?)",
      )
      .bind(
        ctx.identity!.id,
        ctx.now,
        ctx.tenant!.id,
        p.id,
        v.slug,
        v.expected_revision,
        ctx.tenant!.id,
        p.id,
        v.slug,
      )
      .run();
    if (!result.meta.changes) throw conflict("stale revision");
    return { slug: v.slug, revision: r.revision + 1, deleted: true };
  },
});
export const pageVerbs = [
  pagePublish,
  pageRead,
  pageList,
  pageHistory,
  pageDelete,
];
