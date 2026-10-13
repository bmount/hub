// Code in the workbench: /<project>/code (commits as the list, one commit with its diff in the inspector) and
// /<project>/files (a directory as the list, a file in the inspector). Reads go to Ardi as the viewer.
import type { Env } from "../env";
import { emptyState, esc, htmlResponse, inspectorSection, kitTable, kitTabs, toolbar, workbench } from "../html";
import { buildContext, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { getVerb } from "../verbs/table";
import { type ArdiCommit, type ArdiEntry, type ArdiRef } from "../code/ardi";
import { repoProject, type After, type FileChange } from "../verbs/code";
import type { commitWorkResults } from "../work/commitEvidence";
import { sha256Hex } from "../ids";
import { codeDiff as diffHtml, recordedWorkTable } from "./codeMarkup";

const ago = (s: number, now: number) => {
  const m = Math.max(0, Math.round((now - s * 1000) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : m < 1440 * 60 ? `${Math.round(m / 1440)}d` : new Date(s * 1000).toISOString().slice(0, 10);
};
const branchOf = (r: string) => r.replace(/^refs\/heads\//, "");

async function run<T>(ctx: Ctx, verb: string, input: Record<string, unknown>): Promise<T> {
  const v = getVerb(verb)!;
  return (await v.run(ctx, v.parse(input))) as T;
}

async function base(request: Request, env: Env, slug: string) {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return { ctx, extra, project: null };
  try { return { ctx, extra, project: await repoProject(ctx, slug, true) }; }
  catch (e) { if (e instanceof HubError && e.status === 404) return { ctx, extra, project: null }; throw e; }
}

function navigation(project: { slug: string }, view: string, url: URL): string {
  const link = (v: string) => { const u = new URL(url); u.pathname = `/${project.slug}/${v}`; for (const k of ["c","f","path","next"]) u.searchParams.delete(k); return u.pathname+u.search; };
  return kitTabs("Repository views", [{label:"Commits",href:link("code"),current:view === "code"},{label:"Files",href:link("files"),current:view === "files"}]);
}

const unavailable = (e: unknown) => emptyState("Repository unavailable", e instanceof HubError ? e.detail ?? e.reason : "The git host could not be read.", {label:"Try again",href:"#"});
export async function codePage(request: Request, env: Env, slug: string): Promise<Response> {
  const { ctx, extra, project } = await base(request, env, slug);
  if (!project) return notFoundPage(extra);
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") ?? "";
  const oid = url.searchParams.get("c") ?? "";
  let list: string; let inspector: string | null = null; let inspectorKey = "";
  const crumbs = navigation(project, "code", url);
  try {
    const [refs, log] = await Promise.all([
      run<{ refs: ArdiRef[] }>(ctx, "repo.branches", { project: project.slug }),
      run<{ commits: ArdiCommit[]; next: string | null; who: Record<string, string> }>(ctx, "repo.log", { project: project.slug, ...(ref ? { ref } : {}), limit: 50, ...(url.searchParams.get("next") ? { next: url.searchParams.get("next") } : {}) }),
    ]);
    const heads = refs.refs.filter((r) => r.name.startsWith("refs/heads/"));
    const q = (changes: Record<string, string | null>) => { const u = new URL(url); for (const [k,v] of Object.entries(changes)) v === null ? u.searchParams.delete(k) : u.searchParams.set(k,v); return u.pathname+u.search; };
    list = `<div class="head"><h1>Commits</h1><span>${esc(branchOf(ref || heads[0]?.name || "HEAD"))}</span></div>
${toolbar("Repository actions and filters", crumbs, `<form method="get"><label>Branch <select name="ref">${heads.map(h => `<option value="${esc(branchOf(h.name))}"${branchOf(h.name) === ref ? " selected" : ""}>${esc(branchOf(h.name))}</option>`).join("")}</select></label><button type="submit" class="quiet">Show</button><input data-filter name="filter" aria-label="Filter the list" placeholder="Filter these (/)" size="16"></form>`)}
${log.commits.length ? kitTable("Commits", [{label:"Commit"},{label:"Summary"},{label:"Author"},{label:"When"}],log.commits.map(c => ({href:q({c:c.oid}),selected:c.oid === oid,cells:[{html:`<code>${esc(c.oid.slice(0,8))}</code>`},{html:`<a href="${esc(q({c:c.oid}))}">${esc(c.summary)}</a>`},{html:esc(c.author_name)+(c.principal && log.who[c.principal] ? ` · pushed by ${esc(log.who[c.principal]!) }` : "")},{html:ago(c.commit_time,ctx.now)}]}))) : emptyState("No commits", "This branch has no recorded commits.", {label:"Files",href:`/${project.slug}/files`})}
${log.next ? `<p><a href="${esc(q({next:log.next,c:null}))}">Older commits</a></p>` : ""}`;
    if (oid) {
      const c = await run<{ commit: ArdiCommit; pushed_by: string | null; files: FileChange[]; after: After } & ReturnType<typeof commitWorkResults>>(ctx, "repo.commit", { project: project.slug, oid });
      inspectorKey = `commit:${project.id}:${oid.toLowerCase()}:${await sha256Hex(JSON.stringify([c.relatedWork, c.relatedWorkCoverage, c.after]))}`;
      inspector = `<a class="back" href="${esc(q({c:null}))}">‹ Commits</a><div class="head"><code>${oid.slice(0, 12)}</code><span>${esc(c.commit.author_name)}</span>${c.pushed_by ? `<span>pushed by ${esc(c.pushed_by)}</span>` : ""}<span>${new Date(c.commit.commit_time * 1000).toISOString().slice(0, 16).replace("T", " ")}</span></div>
<h1>${esc(c.commit.summary)}</h1>${(c.commit.message ?? "").trim().split("\n").slice(1).join("\n").trim() ? `<div class="prose">${esc((c.commit.message ?? "").trim().split("\n").slice(1).join("\n").trim())}</div>` : ""}
<h2>Recorded work</h2><p class="lede">Full commit references and exact canonical URLs only. Recorded associations do not prove that this commit completes, reviews or approves the work.</p>
${c.relatedWork.length ? recordedWorkTable(c.relatedWork) : `<p class="lede">No work associations recorded for this commit.</p>`}
<p class="lede">${c.relatedWorkCoverage.shown} related work items shown${c.relatedWorkCoverage.truncated ? `; capped at ${c.relatedWorkCoverage.limit}, more omitted` : "; complete for recorded associations"}.</p>
<h2>After this commit</h2><p class="lede">Recorded deploy/time associations do not prove live rollout, continued deployment, absence of errors or causation.</p>
${inspectorSection("Record", [{label:"Recorded deploy",html:`${c.after.shipped ? `<a href="/apps?d=${esc(encodeURIComponent(c.after.shipped.id))}">${esc(c.after.shipped.script)}</a> <code>${esc(c.after.shipped.tag ?? "")}</code>, ${new Date(c.after.shipped.at).toISOString().slice(0, 16).replace("T", " ")} · ${c.after.shipped.match === "full-commit" ? "exact full commit ID" : "tag-prefix hint"}` : "no supported deploy association recorded"}`},{label:"Deploy sample from commit time",html:`${c.after.since.length ? c.after.since.map((d) => `<a href="/apps?d=${esc(encodeURIComponent(d.id))}"><code>${esc(d.tag ?? "?")}</code></a>`).join(" ") : "none recorded"}<br>${c.after.sinceCoverage.shown} shown${c.after.sinceCoverage.truncated ? "; capped at 10, more omitted" : "; complete for the recorded time window"}`},{label:"Recorded error groups",html:`${c.after.errors.length ? c.after.errors.map((e) => `<a href="/apps?g=${esc(encodeURIComponent(e.id))}">${esc(e.title)}</a> ×${e.count}`).join("<br>") : "none recorded"}<br>${c.after.errorsCoverage.shown} shown${c.after.errorsCoverage.truncated ? "; capped at 10, more omitted" : "; complete for the recorded time window"}<br>First recorded at or after ${new Date(c.after.errorsSince.at).toISOString()} (${c.after.errorsSince.basis})`}])}
${c.commit.parents.length ? `<p class="lede">Parent${c.commit.parents.length > 1 ? "s" : ""}: ${c.commit.parents.map((p) => `<a href="${esc(q({c:p}))}"><code>${p.slice(0, 8)}</code></a>`).join(" ")}</p>` : ""}
${c.files.map((f) => diffHtml(f.path, f.diff, f.note, f.kind)).join("")}`;
    } else if (project.slug.startsWith("agent-src/")) {
      let directions: { text: string | null; binary: boolean; size: number } | null = null;
      let path = "";
      for (const candidate of ["pi-agent/AGENTS.md", "AGENTS.md"]) {
        try {
          directions = await run(ctx, "repo.file", { project: project.slug, path: candidate });
          path = candidate; break;
        } catch (e) { if (!(e instanceof HubError && e.status === 404)) throw e; }
      }
      inspector = `<h1>Current directions</h1><p class="lede">At the repository head. Commit messages in the list explain self-changes.</p>
${directions ? `<p><a href="/${esc(project.slug)}/files?f=${esc(encodeURIComponent(path))}"><code>${esc(path)}</code></a></p>${directions.binary ? "<p>Binary file.</p>" : directions.text === null ? "<p>Too large to show.</p>" : `<pre class="prose">${esc(directions.text)}</pre>`}` : "<p>No pi-agent/AGENTS.md or AGENTS.md at the head.</p>"}`;
      inspectorKey = `directions:${project.id}:${await sha256Hex(JSON.stringify(directions))}`;
    } else {
      inspector = `<div class="head"><span>Repository</span></div><h1>${esc(project.display_name)}</h1>
${inspectorSection("Repository", [{label:"Branches",html:String(heads.length)},{label:"Tags",html:String(refs.refs.length-heads.length)},{label:"Clone",html:`<code>git clone https://${esc(ctx.tenant!.slug)}.${esc(env.HUB_DOMAIN)}/${esc(project.slug)}.git</code>`}])}
<p class="lede">Choose a commit to see what changed, who wrote it, and who pushed it. Mention <code>${esc(project.slug)}#12</code> in a commit message and it links to that work item.</p>`;
    }
  } catch (e) {
    list = `${crumbs}${unavailable(e)}`;
  }
  return htmlResponse(workbench(`${project.display_name}: commits`, { list, listKey: `code:${project.slug}:${ref}:${url.searchParams.get("next") ?? ""}`, inspector, inspectorKey },
    shellFor(ctx, env, project.slug.startsWith("agent-src/") ? "people" : "project", project.slug)!), 200, extra);
}

export async function filesPage(request: Request, env: Env, slug: string): Promise<Response> {
  const { ctx, extra, project } = await base(request, env, slug);
  if (!project) return notFoundPage(extra);
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") ?? "";
  const dir = (url.searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "");
  const file = url.searchParams.get("f") ?? "";
  const link = (p: string, f = "") => { const u = new URL(url); u.searchParams.set("path",p); f ? u.searchParams.set("f",f) : u.searchParams.delete("f"); return u.pathname+u.search; };
  let list: string; let inspector: string | null = null;
  const crumbs = navigation(project, "files", url);
  try {
    const d = await run<{ entries: ArdiEntry[] }>(ctx, "repo.file", { project: project.slug, path: dir, ...(ref ? { ref } : {}) });
    const parts = dir ? dir.split("/") : [];
    const trail = [`<a href="${esc(link(""))}">${esc(project.slug)}</a>`, ...parts.map((p, i) => `<a href="${esc(link(parts.slice(0, i + 1).join("/")))}">${esc(p)}</a>`)].join(" / ");
    list = `<div class="head"><h1>Files</h1><span>${trail}</span></div>${toolbar("Repository actions and filters", crumbs, '<input data-filter aria-label="Filter the list" placeholder="Filter these (/)" size="16">')}
${d.entries?.length ? kitTable("Code files",[{label:"Type"},{label:"Name"}],d.entries.map(e => { const p = dir ? `${dir}/${e.name}` : e.name; const target = e.kind === "tree" ? link(p) : link(dir,p); return {href:target,selected:p === file,cells:[{html:e.kind === "tree" ? "Folder" : "File"},{html:`<a href="${esc(target)}">${esc(e.name)}${e.kind === "tree" ? "/" : ""}</a>`}]}; })) : emptyState("No files", "This directory contains no files.", {label:"Repository root",href:link("")})}`;
    if (file) {
      const f = await run<{ text: string | null; binary: boolean; size: number }>(ctx, "repo.file", { project: project.slug, path: file, ...(ref ? { ref } : {}) });
      inspector = `<a class="back" href="${esc(link(dir))}">‹ Files</a><div class="head"><code>${esc(file)}</code><span>${f.size} bytes</span><a href="/${esc(project.slug)}/code?${ref ? `ref=${esc(encodeURIComponent(ref))}&amp;` : ""}">History</a></div>
${f.binary ? `<p class="lede">Binary file.</p>` : f.text === null ? `<p class="lede">Too large to show here.</p>` : `<div class="wb-code">${kitTable(file,[{label:"Line"},{label:"Source"}],f.text.replace(/\n$/, "").split("\n").slice(0,5000).map((l,i)=>({cells:[{html:String(i+1),className:"ln"},{html:`<code>${esc(l)}</code>`}]})))}</div>`}`;
    }
  } catch (e) {
    list = `${crumbs}${unavailable(e)}`;
  }
  return htmlResponse(workbench(`${project.display_name}: files`, { list, listKey: `files:${project.slug}:${ref}:${dir}`, inspector, inspectorKey: file ? `file:${file}` : "" },
    shellFor(ctx, env, project.slug.startsWith("agent-src/") ? "people" : "project", project.slug)!), 200, extra);
}
