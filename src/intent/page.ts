// The "What do you want to do?" box and its page, /do. A plain GET form, so it works from any page and without
// script: a link-shaped answer redirects at once; anything that changes data comes back as one card to check and
// press. Follow-up questions carry the exchange in `h`: only the person's words and Pimwell's questions.
import type { Env } from "../env";
import { esc, htmlResponse, page, workbench } from "../html";
import { buildContext, type Ctx } from "../auth/context";
import { listMembershipsForIdentity } from "../db/memberships";
import { listTenants } from "../db/tenants";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "../http/pages";
import { shellFor } from "../http/shell";
import { takeRateDetail } from "../rate";
import { note } from "../log";
import { HubError } from "../errors";
import { interpret, type Turn } from "./model";
import { resolve } from "./resolve";

/** The box itself, used at the top of the organization's home page and on /do. */
export function intentBox(opts: { history?: Turn[]; placeholder?: string; autofocus?: boolean } = {}): string {
  const h = opts.history?.length ? `<input type="hidden" name="h" value="${esc(JSON.stringify(opts.history))}">` : "";
  return `<form class="composer intent" method="get" action="/do" autocomplete="off">${h}
<div class="box"><textarea data-voice data-voice-autosend data-enter-submits data-grow name="q" rows="3" required maxlength="1000" aria-label="What do you want to do?" placeholder="${esc(opts.placeholder ?? "Say or type what you want to do")}"${opts.autofocus ? " autofocus" : ""}></textarea><button type="submit" class="send" aria-label="Go">→</button></div>
</form>`;
}

function readHistory(raw: string | null): Turn[] {
  if (!raw || raw.length > 8000) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.slice(-6).filter((t): t is Turn => !!t && typeof t === "object" && ((t as Turn).who === "person" || (t as Turn).who === "pimwell") && typeof (t as Turn).text === "string")
      .map((t) => ({ who: t.who, text: t.text.slice(0, 1000) }));
  } catch { return []; }
}

const EXAMPLES = ["What's waiting on me?", "File a snag: the export button does nothing", "Show open bugs in the website", "Invite sam@example.com as a member", "Connect an agent called Build box"];

export async function doPage(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const ctx = await buildContext(request, env, Date.now(), waitUntil);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind === "apex" && ctx.identity && ctx.identity.kind === "human" && ctx.authKind === "cookie") return apexDo(request, env, ctx, extra);
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.identity || !ctx.role || ctx.identity.kind !== "human" || ctx.authKind !== "cookie") return notFoundPage(extra);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 1000);
  const history = readHistory(url.searchParams.get("h"));
  note(request, { verb: "intent", via: "do" });
  let out = "";
  let turns: Turn[] = [];
  if (q) {
    const rate = await takeRateDetail(env.RATE, "intent_identity", ctx.identity.id, ctx.now, waitUntil);
    if (!rate.ok) out = `<div class="intent-card"><p class="say">That's a lot for one hour. Try again in a little while, or use the menu.</p></div>`;
    else {
      turns = [...history, { who: "person", text: q }];
      try {
        const intent = await interpret(env, turns, { tenant_id: ctx.tenant.id, identity_id: ctx.identity.id, session_id: ctx.session?.id ?? null });
        const r = await resolve(ctx, intent);
        if (r.kind === "go") return new Response(null, { status: 303, headers: { location: r.href, "cache-control": "no-store", ...extra } });
        out = r.html;
        if (intent.kind === "ask") turns.push({ who: "pimwell", text: intent.question }); else turns = [];
      } catch (e) {
        if (!(e instanceof HubError)) throw e;
        out = `<div class="intent-card"><p class="say">${e.status === 503 ? "This needs a model key: an admin adds one under Models and keys." : "That didn't go through. Try again."}</p></div>`;
        turns = [];
      }
    }
  }
  const asked = turns.length && turns[turns.length - 1]!.who === "pimwell";
  const list = `<div class="intent-page"><h1>What do you want to do?</h1>
${q ? `<p class="said">“${esc(q)}”</p>` : ""}${out}
${intentBox({ history: asked ? turns : [], placeholder: asked ? "Your answer" : undefined, autofocus: !q || !!asked })}
${q ? "" : `<p class="lede">For example:</p><div class="chips">${EXAMPLES.map((x) => `<a class="chip" href="/do?q=${esc(encodeURIComponent(x))}">${esc(x)}</a>`).join("")}</div>`}
<p class="lede small">Pimwell turns what you say into a link or one action for you to check. It works only from your words and what this page can do; it never looks at your organization's data to decide.</p></div>`;
  return htmlResponse(workbench("Do", { list, listKey: `do:${q}:${out.length}`, inspector: null }, shellFor(ctx, env, "home", "do")!), 200, extra);
}

/**
 * The box on the hub's own home page, outside any organization. Which organization it is for is settled here, with
 * no model call: the only one they belong to, or the one whose name they said, or one tap on a list.
 */
async function apexDo(request: Request, env: Env, ctx: Ctx, extra: Record<string, string>): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 1000);
  const h = url.searchParams.get("h");
  const home = `https://${env.HUB_DOMAIN}/`;
  if (!q) return new Response(null, { status: 303, headers: { location: home, ...extra } });
  let orgs = (await listMembershipsForIdentity(env.HUB_DB, ctx.identity!.id)).filter((m) => m.tenant.state === "active" && m.membership.state === "active").map((m) => m.tenant);
  if (!orgs.length && ctx.identity!.is_root === 1) orgs = await listTenants(env.HUB_DB, "active");
  const there = (slug: string) => `https://${slug}.${env.HUB_DOMAIN}/do?q=${encodeURIComponent(q)}${h ? `&h=${encodeURIComponent(h)}` : ""}`;
  if (orgs.length === 1) return new Response(null, { status: 303, headers: { location: there(orgs[0]!.slug), "cache-control": "no-store", ...extra } });
  // A name they said, matched on whole words so "acme" in "acme's site" counts and a stray syllable does not.
  const words = q.toLowerCase().replace(/[^a-z0-9 -]/g, " ").split(/\s+/).filter(Boolean);
  const named = orgs.filter((t) => [t.slug, t.display_name].some((n) => { const nw = n.toLowerCase().replace(/[^a-z0-9 -]/g, " ").split(/\s+/).filter(Boolean); return nw.length > 0 && nw.every((w) => words.includes(w)); }));
  if (named.length === 1) return new Response(null, { status: 303, headers: { location: there(named[0]!.slug), "cache-control": "no-store", ...extra } });
  const body = `<div class="intent-page"><h1>What do you want to do?</h1><p class="said">“${esc(q)}”</p>
<div class="intent-card">${orgs.length ? `<p class="say">In which organization?</p><div class="chips">${orgs.map((t) => `<a class="chip" href="${esc(there(t.slug))}" data-reload>${esc(t.display_name)}</a>`).join("")}</div>` : `<p class="say">You don't belong to an organization yet. Ask whoever invited you to add you to one.</p>`}</div></div>`;
  return htmlResponse(page("Do", body, shellFor(ctx, env, "home")), 200, extra);
}
