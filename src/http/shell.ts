// The signed-in shell: who you are, which organization, and every section one click away.
import type { Env } from "../env";
import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import type { Shell } from "../html";

export type Section = "home" | "docket" | "mail" | "chat" | "people" | "admin" | "account" | "hub" | "project";

// Short reminders that the old way is not required any more. One per page, chosen by page, so it rotates.
export const TIPS = [
  "No triage meeting needed. File it here, or forward the thread to the project's address.",
  "You don't need to know which team owns something. Send it to the project and Pimwell sorts it.",
  "Status comes from the record, so nobody has to write a status report.",
  "Helpers can pick work up the moment it's filed. No waiting for the next standup.",
  "Everything here also works from Claude or ChatGPT, over MCP.",
  "Nothing finished is thrown away. Archived work still answers questions.",
  "A decision made in a thread can be filed as a call, with its source, in one step.",
  "You don't have to look things up for a helper. Each job arrives with what Pimwell already knows.",
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
    const nav = [
      { href: "/", label: "Home", section: "home" },
      { href: "/docket", label: "Docket", section: "docket" },
      { href: "/mail", label: "Mail", section: "mail" },
      { href: "/c", label: "Conversations", section: "chat" },
      { href: "/people", label: "People and helpers", section: "people" },
      ...(rank(ctx.role) >= rank("admin") ? [{ href: "/admin/agents", label: "Admin", section: "admin" }] : []),
    ];
    return {
      brandHref: hub, org: { name: ctx.tenant.display_name, href: "/" }, me, tip: tipFor(key),
      nav: nav.map((n) => ({ href: n.href, label: n.label, active: n.section === active })),
    };
  }
  const nav = [
    { href: "/", label: "Your organizations", section: "home" },
    { href: "/me", label: "Account", section: "account" },
    { href: "/me/sessions", label: "Sessions", section: "hub" },
    ...(ctx.identity.is_root === 1 ? [{ href: "/admin/orgs", label: "Hub admin", section: "admin" }] : []),
  ];
  return { brandHref: hub, org: null, me, tip: tipFor(key), nav: nav.map((n) => ({ href: n.href, label: n.label, active: n.section === active })) };
}
