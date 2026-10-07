// The signed-in shell: who you are, which organization, and every section one click away.
import type { Env } from "../env";
import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import type { Shell } from "../html";

export type Section = "home" | "apps" | "usage" | "attention" | "docket" | "mine" | "mail" | "chat" | "people" | "admin" | "account" | "hub" | "project" | "playground" | "planned" | "new";

// Short reminders that the old way is not required any more. One per page, chosen by page, so it rotates.
export const TIPS = [
  "No triage meeting needed. File it here, or forward the thread to the project's address.",
  "You don't need to know which team owns something. Send it to the project and Pimwell sorts it.",
  "Status comes from the record, so nobody has to write a status report.",
  "Agents can pick work up the moment it's filed. No waiting for the next standup.",
  "Everything here also works from Claude or ChatGPT, over MCP.",
  "Nothing finished is thrown away. Archived work still answers questions.",
  "A decision made in a thread can be filed as a call, with its source, in one step.",
  "You don't have to look things up for an agent. Each job arrives with what Pimwell already knows.",
];

function tipFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TIPS[h % TIPS.length]!;
}

export function shellFor(ctx: Ctx, env: Env, active: Section, key: string = active): Shell | undefined {
  if (!ctx.identity) return undefined;
  const hub = `https://${env.HUB_DOMAIN}/`;
  const me = { name: ctx.identity.display_name, href: `${hub}me` };
  if (ctx.host.kind === "tenant" && ctx.tenant && ctx.role) {
    const r = ctx.rail;
    const link = (href: string, label: string, section: Section | null, count?: number) => ({ href, label, active: section === active, ...(count !== undefined ? { count } : {}) });
    const nav = [
      link("/", "Home", "home"),
      link("/attention", "Needs me", "attention", r?.needs),
      link("/docket", "Docket", "docket", r?.open),
      link("/docket?owner=me", "Mine", "mine", r?.mine),
      link("/mail", "Mail", "mail", r?.held),
      link("/c", "Conversations", "chat"),
      link("/people", "People and agents", "people"),
      link("/assistant", "Assistant", "playground"),
      link("/apps", "Apps", "apps"),
      link("/usage", "AI usage", "usage"),
      ...(rank(ctx.role) >= rank("admin") ? [link("/admin/agents", "Admin", "admin")] : []),
    ];
    const projects = (r?.projects ?? []).map((p) => ({ href: `/${p.slug}/docket`, label: p.display_name, active: active !== "home" && key === p.slug, count: p.open }));
    const planned = PLANNED_LINKS.map((l) => ({ href: l.href, label: l.label, active: active === "planned" && key === l.key, planned: true }));
    const tabs = [
      { href: "/docket", label: "Docket", active: active === "docket" || active === "project", count: r?.open },
      { href: "/attention", label: "Needs me", active: active === "attention", count: r?.needs },
      { href: "/mail", label: "Mail", active: active === "mail", count: r?.held },
      { href: "/assistant", label: "Assistant", active: active === "playground" },
    ];
    return {
      brandHref: hub, org: { name: ctx.tenant.display_name, href: "/" }, me, tip: tipFor(key), nav, projects, planned, tabs,
      canFile: rank(ctx.role) >= rank("member"),
    };
  }
  const nav = [
    { href: "/", label: "Your organizations", section: "home" },
    { href: "/me", label: "Account", section: "account" },
    { href: "/me/sessions", label: "Sessions", section: "hub" },
    ...(ctx.identity.is_root === 1 ? [{ href: "/admin/orgs", label: "Hub admin", section: "admin" }, { href: "/admin/apps", label: "Apps to approve", section: "apps" }] : []),
  ];
  return { brandHref: hub, org: null, me, tip: tipFor(key), nav: nav.map((n) => ({ href: n.href, label: n.label, active: n.section === active })) };
}

/** Areas still being built, kept in plain view (src/verbs/planned.ts). */
export const PLANNED_LINKS = [
  { href: "/planned/review", label: "Reviews", key: "review" },
  { href: "/planned/code", label: "Code", key: "code" },
  { href: "/planned", label: "Everything coming", key: "all" },
];
