// From a checked intent to what the person sees: a link to follow at once, or one card with a prefilled, editable
// form whose button runs the ordinary verb (with all its usual checks). Names they said are matched here, against
// what they can see, never by the model.
import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import { esc } from "../html";
import { KINDS } from "../work/names";
import type { Intent } from "./catalog";
import { getVerb } from "../verbs/table";
import { runVerb } from "../verbs/dispatch";
import { DATA_NOTE } from "../mcp/render";
import { format } from "../http/assistantPages";
import { extraCheck, proofFresh } from "../http/extraCheck";

/** "show": the person's own read verb, with their own rights, as they'd get from the API or MCP. The model never sees it. */
const SHOW: Record<string, { verb: string; page: string; title: string }> = {
  projects: { verb: "project.list", page: "/", title: "Projects" },
  waiting_on_me: { verb: "attention.list", page: "/attention", title: "Waiting on you" },
  my_work: { verb: "work.list", page: "/docket?owner=me", title: "Your open work" },
  work: { verb: "work.list", page: "/docket", title: "Work" },
  reviews: { verb: "review.list", page: "/reviews", title: "Open reviews" },
  apps: { verb: "app.list", page: "/apps", title: "Apps" },
  situations: { verb: "situation.list", page: "/situations", title: "Situations" },
  mail: { verb: "mail.list", page: "/mail", title: "Mail" },
};

type WorkRow = { project: string; number: number; title: string; kind: string; state: string };
function showHtml(what: string, result: unknown, verbName: string): string {
  if (what === "projects") {
    const ps = (result as { projects: Array<{ slug: string; display_name: string; path: string; kind: string }> }).projects.filter((x) => x.kind !== "channel");
    return ps.length ? `<ul class="hits">${ps.map((x) => `<li><a href="/${esc(x.slug)}/docket">${esc(x.display_name)}</a> <small>${esc(x.path)}</small></li>`).join("")}</ul>` : `<p class="lede">No projects yet.</p>`;
  }
  if (verbName === "work.list") {
    const items = (result as { items: WorkRow[] }).items;
    return items.length ? `<ul class="hits">${items.slice(0, 15).map((w) => `<li><a href="/${esc(w.project)}/w/${w.number}">${esc(w.project)}#${w.number}</a> ${esc(w.title)} <small>${esc(KINDS[w.kind as keyof typeof KINDS]?.name ?? w.kind)}${w.state === "doing" ? ", under way" : ""}</small></li>`).join("")}</ul>` : `<p class="lede">Nothing here right now.</p>`;
  }
  if (what === "waiting_on_me") {
    const es = (result as { entries: Array<{ slug: string | null; number: number | null; summary: string; reason: string }> }).entries;
    return es.length ? `<ul class="hits">${es.slice(0, 15).map((e) => `<li>${e.slug ? `<a href="/${esc(e.slug)}/w/${e.number}">${esc(e.slug)}#${e.number}</a> ` : ""}${esc(e.summary)} <small>${esc(e.reason)}</small></li>`).join("")}</ul>` : `<p class="lede">Nothing is waiting on you.</p>`;
  }
  const v = getVerb(verbName);
  const text = v?.mcp?.render ? v.mcp.render(result) : JSON.stringify(result);
  return `<div class="hits">${format(text.replace(DATA_NOTE, "").trim().split("\n").slice(0, 30).join("\n"))}</div>`;
}

export type Outcome = { kind: "go"; href: string; say: string } | { kind: "card"; html: string };

const SECTION_HREF: Record<string, string> = {
  home: "/", needs_me: "/attention", docket: "/docket", mine: "/docket?owner=me", board: "/board", mail: "/mail", conversations: "/c", people: "/people",
  assistant: "/assistant", reviews: "/reviews", situations: "/situations", apps: "/apps", usage: "/usage", file_work: "/new", admin: "/admin/agents",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** The best match for what they said among names they can see: exact, then prefix, then contains, then a near miss. */
export function bestMatch<T>(said: string, items: T[], names: (t: T) => string[]): { one: T | null; maybe: T[] } {
  const q = norm(said);
  if (!q) return { one: null, maybe: [] };
  const score = (t: T) => Math.max(...names(t).map(norm).map((n) => (n === q ? 4 : n.startsWith(q) || q.startsWith(n) ? 3 : n.includes(q) || q.includes(n) ? 2 : q.length >= 5 && distance(n, q) <= 2 ? 1 : 0)));
  const scored = items.map((t) => ({ t, s: score(t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return { one: null, maybe: [] };
  const top = scored.filter((x) => x.s === scored[0]!.s);
  return top.length === 1 ? { one: top[0]!.t, maybe: [] } : { one: null, maybe: top.map((x) => x.t) };
}

type Project = { slug: string; name: string };
type Person = { name: string; email: string };
const option = (v: string, label: string, sel: boolean) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(label)}</option>`;
const card = (say: string, body: string) => ({ kind: "card" as const, html: `<div class="intent-card">${say ? `<p class="say">${esc(say)}</p>` : ""}${body}</div>` });
const field = (label: string, input: string) => `<label class="f"><span>${esc(label)}</span>${input}</label>`;

export async function resolve(ctx: Ctx, intent: Intent): Promise<Outcome> {
  if (intent.kind === "ask") return card(intent.question, "");
  if (intent.kind === "none") return card(intent.say, `<p class="lede">Try saying it another way, or <a href="/search">search</a>.</p>`);
  const p = intent.params, say = intent.say;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const [projR, peopleR] = await ctx.db.batch([
    ctx.db.prepare("SELECT slug, display_name AS name FROM project WHERE tenant_id = ? AND state = 'active' AND kind <> 'channel' ORDER BY display_name").bind(ctx.tenant!.id),
    ctx.db.prepare(`SELECT i.display_name AS name, i.email FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active' ORDER BY i.display_name`).bind(ctx.tenant!.id),
  ]);
  const projects = projR!.results as Project[], people = peopleR!.results as Person[];
  const findProject = (said: string) => bestMatch(said, projects, (x) => [x.slug, x.name]);
  /** A project they named but we can't pin down: offer the likely ones (or all) as links. */
  const whichProject = (said: string, maybe: Project[], to: (slug: string) => string) => card(`Which project did you mean${said ? ` by "${said}"` : ""}?`,
    `<div class="chips">${(maybe.length ? maybe : projects).map((x) => `<a class="chip" href="${esc(to(x.slug))}">${esc(x.name)}</a>`).join("")}</div>`);
  const member = rank(ctx.role) >= rank("member"), admin = rank(ctx.role) >= rank("admin");

  switch (intent.action.id) {
    case "go": {
      if (p.section === "account") return { kind: "go", href: `https://${ctx.env.HUB_DOMAIN}/me`, say };
      if (p.section === "sessions") return { kind: "go", href: `https://${ctx.env.HUB_DOMAIN}/me/sessions`, say };
      if (p.section === "models") return { kind: "go", href: `https://${ctx.env.HUB_DOMAIN}/admin/models`, say };
      return { kind: "go", href: SECTION_HREF[str("section")] ?? "/", say };
    }
    case "show": {
      const what = str("what"), def = SHOW[what];
      if (!def) return card("I couldn't find a way to do that here.", "");
      const input: Record<string, unknown> = {};
      let page = def.page;
      if (what === "my_work") input.owner = "me";
      if (what === "work" || what === "reviews") {
        if (str("project")) {
          const m = findProject(str("project"));
          if (!m.one) return whichProject(str("project"), m.maybe, (slug) => `/do?q=${encodeURIComponent(`show ${what} in ${slug}`)}`);
          input.project = m.one.slug; page = what === "reviews" ? "/reviews" : `/${m.one.slug}/docket`;
        }
      }
      if (what === "work") {
        if (p.kind) input.kind = str("kind");
        if (p.finished === true) input.state = "done";
        const owner = str("owner");
        if (owner) {
          if (owner.toLowerCase() === "me" || owner.includes("@")) input.owner = owner.toLowerCase();
          else { const who = bestMatch(owner, people, (x) => [x.name, x.email.split("@")[0]!]); if (who.one) input.owner = who.one.email; }
        }
        input.limit = 15;
      }
      if (what === "my_work") input.limit = 15;
      const verb = getVerb(def.verb);
      if (!verb) return card("I couldn't find a way to do that here.", "");
      try {
        const result = await runVerb(ctx, verb, input);
        return card(say || def.title, `${showHtml(what, result, def.verb)}<p><a href="${esc(page)}">Open ${esc(def.title.toLowerCase())}</a></p>`);
      } catch {
        return card("That list isn't available to you here.", "");
      }
    }
    case "search": return { kind: "go", href: `/search?q=${encodeURIComponent(str("query"))}`, say };
    case "ask_assistant": return { kind: "go", href: `/assistant?ask=${encodeURIComponent(str("question"))}`, say };
    case "open_project":
    case "open_item": {
      const m = findProject(str("project"));
      const view = str("view") || "docket";
      const to = (slug: string) => (intent.action.id === "open_item" ? `/${slug}/w/${p.number}` : `/${slug}/${view}`);
      return m.one ? { kind: "go", href: to(m.one.slug), say } : whichProject(str("project"), m.maybe, to);
    }
    case "docket": {
      const q = new URLSearchParams();
      if (p.kind) q.set("kind", str("kind"));
      if (p.finished === true) q.set("closed", "1");
      const owner = str("owner");
      if (owner) {
        if (owner.toLowerCase() === "me") q.set("owner", "me");
        else if (owner.includes("@")) q.set("owner", owner.toLowerCase());
        else {
          const who = bestMatch(owner, people, (x) => [x.name, x.email.split("@")[0]!]);
          if (who.one) q.set("owner", who.one.email);
          else return card(`Whose work did you mean by "${owner}"?`, `<div class="chips">${(who.maybe.length ? who.maybe : people).slice(0, 12).map((x) => { const qq = new URLSearchParams(q); qq.set("owner", x.email); return `<a class="chip" href="/docket?${esc(qq.toString())}">${esc(x.name)}</a>`; }).join("")}</div>`);
        }
      }
      const qs = q.toString() ? `?${q.toString()}` : "";
      if (!str("project")) return { kind: "go", href: `/docket${qs}`, say };
      const m = findProject(str("project"));
      return m.one ? { kind: "go", href: `/${m.one.slug}/docket${qs}`, say } : whichProject(str("project"), m.maybe, (slug) => `/${slug}/docket${qs}`);
    }
    case "file_work": {
      if (!member) return card("Readers can look but not file work. Ask an admin to make you a member.", "");
      if (!projects.length) return card("There are no projects to file into yet.", "");
      const m = str("project") ? findProject(str("project")) : { one: null, maybe: [] as Project[] };
      const kind = str("kind") || "wish";
      return card(say || "Here it is, ready to file. Change anything first if you like.", `<form method="post" action="/api/work.create"><input type="hidden" name="_back" value="@result">
${field("Title", `<input name="title" required maxlength="200" value="${esc(str("title"))}">`)}
<div class="row">${field("Project", `<select name="project">${!m.one ? option("", "Choose a project", true) : ""}${projects.map((x) => option(x.slug, x.name, x.slug === m.one?.slug)).join("")}</select>`)}
${field("Kind", `<select name="kind">${Object.entries(KINDS).map(([k, v]) => option(k, `${v.name} (${v.plain})`, k === kind)).join("")}</select>`)}</div>
${field("Details", `<textarea data-voice name="body" rows="3" maxlength="20000">${esc(str("body"))}</textarea>`)}
<p><button type="submit">File it</button></p></form>`);
    }
    case "invite_person": {
      if (!admin) return card("Only an admin can invite people. Ask one of your organization's admins.", "");
      if (!proofFresh(ctx)) return card(say, extraCheck(ctx.env, ctx, `/people?invite=1${(["email", "name", "role"] as const).map((k) => (str(k) ? `&${k}=${encodeURIComponent(str(k))}` : "")).join("")}`, "Invites let someone into your organization, so we confirm it's really you first.", false));
      const role = str("role") || "member";
      const roles = ["member", "reader", ...(ctx.identity!.is_root === 1 ? ["admin"] : [])];
      return card(say || "Check the address, then make the invite link.", `<form method="post" action="/api/invite.create">
${field("Email", `<input name="email" type="email" required maxlength="254" value="${esc(str("email"))}">`)}
${field("Name", `<input name="display_name" maxlength="80" value="${esc(str("name"))}" placeholder="How they appear here">`)}
${field("Role", `<select name="role">${roles.map((r) => option(r, r, r === role)).join("")}</select>`)}
<p><button type="submit">Create invite link</button></p></form>`);
    }
    case "connect_agent": {
      if (!member) return card("Readers can't connect agents. Ask an admin to make you a member.", "");
      if (!proofFresh(ctx)) return card(say, extraCheck(ctx.env, ctx, `/people?connect=1${str("name") ? `&name=${encodeURIComponent(str("name"))}` : ""}`, "Agents act on your behalf, so we confirm it's really you before connecting one.", false));
      return card(say || "Name the agent, then make its one-time connect link.", `<form method="post" action="/api/agent.connect">
${field("Agent's name", `<input name="display_name" required maxlength="80" value="${esc(str("name"))}" placeholder="Build box">`)}
<p><button type="submit">Make connect link</button></p></form>`);
    }
    case "report_situation": {
      return card(say || "Pimwell will look into this, read only, and answer with the likely cause and evidence.", `<form method="post" action="/api/situation.open"><input type="hidden" name="_back" value="@result">
${field("What's happening", `<textarea data-voice name="text" rows="3" required minlength="10" maxlength="4000">${esc(str("text"))}</textarea>`)}
<p><button type="submit">Look into it</button></p></form>`);
    }
  }
  return card("I couldn't find a way to do that here.", "");
}
