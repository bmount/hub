import { esc } from "../html";

/** Forms use the API's same-origin guard and the verb's fresh-proof check. */
export function projectControls(p: { slug: string; namespace?: string | null }, archived: boolean): string {
  const fields = `<input type="hidden" name="slug" value="${esc(p.slug)}">${p.namespace ? `<input type="hidden" name="namespace" value="${esc(p.namespace)}">` : ""}`;
  if (!archived) return `<form method="post" action="/api/project.archive">${fields}<input type="hidden" name="_back" value="/archive"><button class="quiet">Archive project</button></form>`;
  return `<details><summary>Delete project permanently</summary><p>This removes items, comments, project channels and messages, mail, documents, knowledge and its repository. It cannot be undone. Requires a web sign-in verified in the last 10 minutes.</p>
<form method="post" action="/api/project.delete">${fields}<input type="hidden" name="_back" value="@result"><label>Type <code>${esc(p.slug)}</code> to confirm <input name="confirm" required autocomplete="off" pattern="${esc(p.slug)}" maxlength="63"></label><button>Delete project permanently</button></form></details>`;
}
