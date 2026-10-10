// Code in the workbench: /<project>/code (commits as the list, one commit with its diff in the inspector) and
// /<project>/files (a directory as the list, a file in the inspector). Reads go to Ardi as the viewer.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { getVerb } from "../verbs/table";
import { type ArdiCommit, type ArdiEntry, type ArdiRef } from "../code/ardi";
import type { FileDiff } from "../code/diff";
import type { After, FileChange } from "../verbs/code";
import type { commitWorkResults } from "../work/commitEvidence";
import { KINDS, STATES } from "../work/names";
import { sha256Hex } from "../ids";

const ago = (s: number, now: number) => {
  const m = Math.max(0, Math.round((now - s * 1000) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : m < 1440 * 60 ? `${Math.round(m / 1440)}d` : new Date(s * 1000).toISOString().slice(0, 10);
};
const branchOf = (r: string) => r.replace(/^refs\/heads\//, "");

async function run<T>(ctx: Ctx, verb: string, input: Record<string, unknown>): Promise<T> {
  const v = getVerb(verb)!;
  return (await v.run(ctx, v.parse(input))) as T;
}

function diffHtml(path: string, d: FileDiff | null, note: string | null, kind: string): string {
  const head = `<div class="head"><code>${esc(path)}</code><span class="pill">${esc(kind)}</span>${d && !d.binary ? `<span class="add">+${d.added}</span><span class="del">−${d.removed}</span>` : ""}</div>`;
  if (!d) return `${head}<p class="lede">${esc(note ?? "")}</p>`;
  if (d.binary) return `${head}<p class="lede">Binary file.</p>`;
  return `${head}<table class="diff"><tbody>${d.hunks.map((h) => `<tr class="hunk"><td colspan="3">@@ -${h.aStart},${h.aLines} +${h.bStart},${h.bLines} @@</td></tr>${h.lines.map((l) =>
    `<tr class="${l.op === "+" ? "ins" : l.op === "-" ? "dl" : ""}"><td class="ln">${l.a ?? ""}</td><td class="ln">${l.b ?? ""}</td><td><code>${esc(l.op + l.text)}</code></td></tr>`).join("")}`).join("")}</tbody></table>${d.truncated ? `<p class="lede">Cut short: the file is very large.</p>` : ""}`;
}

async function base(request: Request, env: Env, slug: string) {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return { ctx, extra, project: null };
  const project = await ctx.db.prepare("SELECT id, slug, display_name FROM project WHERE tenant_id = ? AND slug = ? AND kind = 'repo'").bind(ctx.tenant.id, slug).first<{ id: string; slug: string; display_name: string }>();
  return { ctx, extra, project };
}

const unavailable = (e: unknown) => `<p class="empty">${esc(e instanceof HubError ? e.detail ?? e.reason : "The git host could not be read.")}</p>`;

export async function codePage(request: Request, env: Env, slug: string): Promise<Response> {
  const { ctx, extra, project } = await base(request, env, slug);
  if (!project) return notFoundPage(extra);
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") ?? "";
  const oid = url.searchParams.get("c") ?? "";
  let list: string; let inspector: string | null = null; let inspectorKey = "";
  const crumbs = `<p class="crumbs"><a href="/">${esc(ctx.tenant!.display_name)}</a> / <a href="/${esc(project.slug)}/docket">${esc(project.display_name)}</a></p>
<div class="chips"><a class="chip" href="/${esc(project.slug)}/docket">Docket</a><a class="chip" href="/${esc(project.slug)}/code" aria-current="true">Commits</a><a class="chip" href="/${esc(project.slug)}/files">Files</a></div>`;
  try {
    const [refs, log] = await Promise.all([
      run<{ refs: ArdiRef[] }>(ctx, "repo.branches", { project: project.slug }),
      run<{ commits: ArdiCommit[]; next: string | null; who: Record<string, string> }>(ctx, "repo.log", { project: project.slug, ...(ref ? { ref } : {}), limit: 50, ...(url.searchParams.get("next") ? { next: url.searchParams.get("next") } : {}) }),
    ]);
    const heads = refs.refs.filter((r) => r.name.startsWith("refs/heads/"));
    const q = (extraQ: string) => `/${esc(project.slug)}/code?${ref ? `ref=${esc(encodeURIComponent(ref))}&amp;` : ""}${extraQ}`;
    list = `${crumbs}<div class="head"><h1>Commits</h1><span>${esc(branchOf(ref || heads[0]?.name || "HEAD"))}</span></div>
<div class="chips">${heads.map((h) => `<a class="chip" href="/${esc(project.slug)}/code?ref=${esc(encodeURIComponent(branchOf(h.name)))}"${branchOf(h.name) === (ref || branchOf(heads[0]?.name ?? "")) ? ' aria-current="true"' : ""}>${esc(branchOf(h.name))}</a>`).join("")}</div>
<table><tbody>${log.commits.map((c) => `<tr data-href="${q(`c=${c.oid}`)}"${c.oid === oid ? ' aria-selected="true"' : ""}><td class="ref"><code>${c.oid.slice(0, 8)}</code></td><td><a href="${q(`c=${c.oid}`)}">${esc(c.summary)}</a><div class="lede" style="margin:0">${esc(c.author_name)}${c.principal && log.who[c.principal] ? ` · pushed by ${esc(log.who[c.principal]!)}` : ""}</div></td><td class="when">${ago(c.commit_time, ctx.now)}</td></tr>`).join("")}</tbody></table>
${log.next ? `<p><a href="${q(`next=${esc(log.next)}`)}">Older commits</a></p>` : ""}`;
    if (oid) {
      const c = await run<{ commit: ArdiCommit; pushed_by: string | null; files: FileChange[]; after: After } & ReturnType<typeof commitWorkResults>>(ctx, "repo.commit", { project: project.slug, oid });
      inspectorKey = `commit:${project.id}:${oid.toLowerCase()}:${await sha256Hex(JSON.stringify([c.relatedWork, c.relatedWorkCoverage, c.after]))}`;
      inspector = `<a class="back" href="${q("")}">‹ Commits</a><div class="head"><code>${oid.slice(0, 12)}</code><span>${esc(c.commit.author_name)}</span>${c.pushed_by ? `<span>pushed by ${esc(c.pushed_by)}</span>` : ""}<span>${new Date(c.commit.commit_time * 1000).toISOString().slice(0, 16).replace("T", " ")}</span></div>
<h1>${esc(c.commit.summary)}</h1>${(c.commit.message ?? "").trim().split("\n").slice(1).join("\n").trim() ? `<div class="prose">${esc((c.commit.message ?? "").trim().split("\n").slice(1).join("\n").trim())}</div>` : ""}
<h2>Recorded work</h2><p class="lede">Full commit references and exact canonical URLs only. Recorded associations do not prove that this commit completes, reviews or approves the work.</p>
${c.relatedWork.length ? `<table><tbody>${c.relatedWork.map(w => `<tr><td class="ref">${esc(w.ref)}</td><td>${esc(KINDS[w.kind].name)}</td><td><a href="/${esc(encodeURIComponent(w.project))}/w/${w.number}">${esc(w.title)}</a></td><td>${esc(STATES[w.state])}</td><td>${w.relationship}</td></tr>`).join("")}</tbody></table>` : `<p class="lede">No work associations recorded for this commit.</p>`}
<p class="lede">${c.relatedWorkCoverage.shown} related work items shown${c.relatedWorkCoverage.truncated ? `; capped at ${c.relatedWorkCoverage.limit}, more omitted` : "; complete for recorded associations"}.</p>
<h2>After this commit</h2><dl class="meta"><dt>Shipped</dt><dd>${c.after.shipped ? `${esc(c.after.shipped.script)} <code>${esc(c.after.shipped.tag ?? "")}</code>, ${new Date(c.after.shipped.at).toISOString().slice(0, 16).replace("T", " ")}` : "no deploy tagged with this commit yet"}</dd>
<dt>Deploys since</dt><dd>${c.after.since.length ? c.after.since.map((d) => `<code>${esc(d.tag ?? "?")}</code>`).join(" ") : "none"}</dd>
<dt>New errors since</dt><dd>${c.after.errors.length ? c.after.errors.map((e) => `<a href="/apps?g=${esc(e.id)}">${esc(e.title)}</a> ×${e.count}`).join("<br>") : "none"}</dd></dl>
${c.commit.parents.length ? `<p class="lede">Parent${c.commit.parents.length > 1 ? "s" : ""}: ${c.commit.parents.map((p) => `<a href="/${esc(project.slug)}/code?c=${p}"><code>${p.slice(0, 8)}</code></a>`).join(" ")}</p>` : ""}
${c.files.map((f) => diffHtml(f.path, f.diff, f.note, f.kind)).join("")}`;
    } else {
      inspector = `<div class="head"><span>Repository</span></div><h1>${esc(project.display_name)}</h1>
<dl class="meta"><dt>Branches</dt><dd>${heads.length}</dd><dt>Tags</dt><dd>${refs.refs.length - heads.length}</dd><dt>Clone</dt><dd><code>git clone https://${esc(ctx.tenant!.slug)}.${esc(env.HUB_DOMAIN)}/${esc(project.slug)}.git</code></dd></dl>
<p class="lede">Choose a commit to see what changed, who wrote it, and who pushed it. Mention <code>${esc(project.slug)}#12</code> in a commit message and it links to that work item.</p>`;
    }
  } catch (e) {
    list = `${crumbs}${unavailable(e)}`;
  }
  return htmlResponse(workbench(`${project.display_name}: commits`, { list, listKey: `code:${project.slug}:${ref}:${url.searchParams.get("next") ?? ""}`, inspector, inspectorKey },
    shellFor(ctx, env, "project", project.slug)!), 200, extra);
}

export async function filesPage(request: Request, env: Env, slug: string): Promise<Response> {
  const { ctx, extra, project } = await base(request, env, slug);
  if (!project) return notFoundPage(extra);
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") ?? "";
  const dir = (url.searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "");
  const file = url.searchParams.get("f") ?? "";
  const link = (p: string, f = "") => `/${esc(project.slug)}/files?${ref ? `ref=${esc(encodeURIComponent(ref))}&amp;` : ""}path=${esc(encodeURIComponent(p))}${f ? `&amp;f=${esc(encodeURIComponent(f))}` : ""}`;
  let list: string; let inspector: string | null = null;
  const crumbs = `<p class="crumbs"><a href="/">${esc(ctx.tenant!.display_name)}</a> / <a href="/${esc(project.slug)}/docket">${esc(project.display_name)}</a></p>
<div class="chips"><a class="chip" href="/${esc(project.slug)}/docket">Docket</a><a class="chip" href="/${esc(project.slug)}/code">Commits</a><a class="chip" href="/${esc(project.slug)}/files" aria-current="true">Files</a></div>`;
  try {
    const d = await run<{ entries: ArdiEntry[] }>(ctx, "repo.file", { project: project.slug, path: dir, ...(ref ? { ref } : {}) });
    const parts = dir ? dir.split("/") : [];
    const trail = [`<a href="${link("")}">${esc(project.slug)}</a>`, ...parts.map((p, i) => `<a href="${link(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`)].join(" / ");
    list = `${crumbs}<div class="head"><h1>Files</h1><span>${trail}</span></div>
<table><tbody>${(d.entries ?? []).map((e) => {
      const p = dir ? `${dir}/${e.name}` : e.name;
      const href = e.kind === "tree" ? link(p) : link(dir, p);
      return `<tr data-href="${href}"${p === file ? ' aria-selected="true"' : ""}><td>${e.kind === "tree" ? "📁" : ""}</td><td><a href="${href}">${esc(e.name)}${e.kind === "tree" ? "/" : ""}</a></td></tr>`;
    }).join("")}</tbody></table>`;
    if (file) {
      const f = await run<{ text: string | null; binary: boolean; size: number }>(ctx, "repo.file", { project: project.slug, path: file, ...(ref ? { ref } : {}) });
      inspector = `<a class="back" href="${link(dir)}">‹ Files</a><div class="head"><code>${esc(file)}</code><span>${f.size} bytes</span><a href="/${esc(project.slug)}/code?${ref ? `ref=${esc(encodeURIComponent(ref))}&amp;` : ""}">History</a></div>
${f.binary ? `<p class="lede">Binary file.</p>` : f.text === null ? `<p class="lede">Too large to show here.</p>` : `<table class="diff"><tbody>${f.text.replace(/\n$/, "").split("\n").slice(0, 5000).map((l, i) => `<tr><td class="ln">${i + 1}</td><td><code>${esc(l)}</code></td></tr>`).join("")}</tbody></table>`}`;
    }
  } catch (e) {
    list = `${crumbs}${unavailable(e)}`;
  }
  return htmlResponse(workbench(`${project.display_name}: files`, { list, listKey: `files:${project.slug}:${ref}:${dir}`, inspector, inspectorKey: file ? `file:${file}` : "" },
    shellFor(ctx, env, "project", project.slug)!), 200, extra);
}
