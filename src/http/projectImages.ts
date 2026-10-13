import type { Ctx } from "../auth/context";
import { esc } from "../html";
import { badRequest, HubError } from "../errors";
import { filePath, readFile } from "../verbs/files";

/** Images occupy their own Markdown line. Never fetch author-supplied URLs. */
export async function projectImages(ctx: Ctx, project: string, body: string, render: (text: string) => string): Promise<string> {
  const out: string[] = [], text: string[] = [];
  const flush = () => { if (text.length) { out.push(render(text.join("\n"))); text.length = 0; } };
  let count = 0;
  for (const line of body.split("\n")) {
    const match = /^\s*!\[([^\]\n]{0,500})\]\(([^\s()]+)\)\s*$/.exec(line);
    if (!match || ++count > 50) { text.push(line); continue; }
    let image: string | null = null;
    try {
      const origin = `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}`;
      const raw = match[2]!;
      if (!raw.startsWith("/") && !raw.startsWith(origin + "/")) throw badRequest("invalid project image reference");
      const url = new URL(raw, origin);
      if (url.origin !== origin || url.pathname !== `/${project}/documents/download` || url.hash || url.username || url.password) throw badRequest("invalid project image reference");
      if ([...url.searchParams.keys()].some(k => k !== "path" && k !== "revision") || url.searchParams.getAll("path").length !== 1 || url.searchParams.getAll("revision").length !== 1) throw badRequest("invalid project image reference");
      const revisionText = url.searchParams.get("revision")!;
      if (!/^[1-9]\d*$/.test(revisionText)) throw badRequest("invalid project image reference");
      const revision = Number(revisionText);
      if (!Number.isSafeInteger(revision) || revision > 2147483647) throw badRequest("invalid project image reference");
      const path = filePath(url.searchParams.get("path")!);
      const file = await readFile(ctx, project, path, revision);
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.content_type)) throw badRequest("invalid project image reference");
      const href = esc(`/${project}/documents/download?path=${encodeURIComponent(path)}&revision=${file.revision}`);
      const caption = esc(match[1]!);
      image = `<figure class="project-image"><a href="${href}" target="_blank" rel="noopener" data-reload aria-label="Open original image"><img src="${href}" alt="${caption}" loading="lazy" decoding="async" style="display:block;max-width:100%;max-height:480px;width:auto;height:auto;object-fit:contain"></a><figcaption>${caption} · <a href="${href}" target="_blank" rel="noopener" data-reload>Open original · revision ${file.revision}</a></figcaption></figure>`;
    } catch (e) {
      if (!(e instanceof HubError) || ![400, 403, 404].includes(e.status)) throw e;
      // Invalid and unavailable references stay inert text, including their caption.
    }
    if (image) { flush(); out.push(image); } else text.push(line);
  }
  flush();
  return out.join("\n");
}
