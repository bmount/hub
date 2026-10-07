// /skills and /skills/<name>: the same skills helpers read over MCP, for people too.
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { buildContext } from "../auth/context";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { SKILLS, skill } from "../skills";

/** Enough Markdown for skills: paragraphs, bold, inline code, and bullet or numbered lists. Input is ours, not users'. */
export function miniMarkdown(md: string): string {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of md.split("\n")) {
    const bullet = line.match(/^\s*-\s+(.*)$/), num = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || num) {
      const want = bullet ? "ul" : "ol";
      if (list !== want) { close(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((bullet ?? num)![1]!)}</li>`);
    } else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join("\n");
}

export async function skillsPage(request: Request, env: Env, name?: string): Promise<Response> {
  const ctx = await buildContext(request, env);
  const shell = shellFor(ctx, env, "home", `skills/${name ?? ""}`);
  if (name) {
    const s = skill(name);
    if (!s) return notFoundPage();
    const body = `<p class="crumbs"><a href="/skills">Skills</a> /</p><h1>${esc(s.title)}</h1><p class="lede">${esc(s.summary)}</p>${miniMarkdown(s.body)}
<p><small>Helpers read this over MCP as <code>pimwell://skills/${esc(s.name)}</code>, or with the <code>skill_read</code> tool.</small></p>`;
    return htmlResponse(page(s.title, body, shell));
  }
  const body = `<h1>Skills</h1><p class="lede">Short guides that help people and helpers use Pimwell well. Helpers get the same text over MCP.</p>
<div class="grid">${SKILLS.map((s) => `<div class="card"><h3><a href="/skills/${esc(s.name)}">${esc(s.title)}</a></h3><p>${esc(s.summary)}</p></div>`).join("")}</div>`;
  return htmlResponse(page("Skills", body, shell));
}
