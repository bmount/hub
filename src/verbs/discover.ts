// Helping helpers find their way (overnight plan task 5): skills, what this connection can do, and project history.
import { defineVerb, listVerbs } from "./table";
import { optInt, reqString } from "./params";
import { notFound } from "../errors";
import { exposedVerbs, mcpViolations, toolName } from "../mcp/policy";
import { SKILLS, skill } from "../skills";
import { DATA_NOTE, cleanText } from "../mcp/render";
import type { Ctx } from "../auth/context";

export const skillList = defineVerb({
  name: "skill.list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "Skills: short guides to using Pimwell well. Read start-here first.",
  mcp: {
    scope: "read", destructive: false, title: "Skills",
    input: { type: "object", properties: {}, additionalProperties: false },
    render: (r) => ["**Skills** (read one with skill_read; start with start-here)", ...(r as { skills: Array<{ name: string; summary: string }> }).skills.map((s) => `- \`${s.name}\`: ${s.summary}`)].join("\n"),
  },
  parse: () => ({}),
  run: async () => ({ skills: SKILLS.map(({ name, title, summary }) => ({ name, title, summary, uri: `pimwell://skills/${name}` })) }),
});

export const skillRead = defineVerb({
  name: "skill.read", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "Read one skill.",
  mcp: {
    scope: "read", destructive: false, title: "Read a skill",
    input: { type: "object", properties: { name: { type: "string", description: "A skill name from skill_list, e.g. start-here." } }, required: ["name"], additionalProperties: false },
    render: (r) => { const s = r as { title: string; body: string }; return `# ${s.title}\n\n${s.body}`; },
  },
  parse: (i) => ({ name: reqString(i, "name", { max: 60 }) }),
  run: async (_ctx, p) => {
    const s = skill(p.name);
    if (!s) throw notFound("no such skill; see skill_list");
    return s;
  },
});

/** Scopes a connection holds: an assistant's granted scopes, or everything its role allows on pages and the API. */
function scopesOf(ctx: Ctx): string[] {
  if (ctx.authKind === "oauth") return [...(ctx.oauth?.scopes ?? [])];
  if (ctx.playground) return [...ctx.playground.scopes];
  return ["read", "write"];
}

export const capabilities = defineVerb({
  name: "capabilities", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "What this connection can do here, and for anything it cannot, why not and what would change that.",
  mcp: {
    scope: "read", destructive: false, title: "Capabilities",
    input: { type: "object", properties: {}, additionalProperties: false },
    render: (r) => {
      const x = r as { who: string; role: string | null; scopes: string[]; tools: string[]; not_available: Array<{ tool: string; why: string }> };
      return [`You are ${cleanText(x.who)}, role ${x.role ?? "none here"}, with scopes ${x.scopes.join(", ") || "none"}.`,
        `**Available** (${x.tools.length}): ${x.tools.join(", ")}`,
        x.not_available.length ? `**Not available**:\n${x.not_available.map((n) => `- ${n.tool}: ${n.why}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
    },
  },
  parse: () => ({}),
  run: async (ctx) => {
    const scopes = scopesOf(ctx);
    const available = exposedVerbs(ctx.role, scopes);
    const have = new Set(available.map((v) => v.name));
    const not_available = listVerbs().filter((v) => v.mcp && !have.has(v.name)).map((v) => {
      let why: string;
      if (mcpViolations(v).length) why = "not offered over MCP yet (administration arrives with the admin spec's plans and approvals)";
      else if (!scopes.includes(v.mcp!.scope)) why = `needs the ${v.mcp!.scope} scope; reconnect and grant it`;
      else why = `needs role ${v.minRole} or higher in this organization`;
      return { tool: toolName(v.name), why };
    });
    return {
      who: ctx.identity ? `${ctx.identity.display_name} <${ctx.identity.email}>` : "not signed in",
      role: ctx.role, scopes, tools: available.map((v) => toolName(v.name)), not_available,
      tenant: ctx.tenant?.slug ?? null, is_helper: ctx.identity?.kind === "agent",
    };
  },
});

type Ev = { id: string; kind: string; summary: string; created_at: number; who: string | null; who_kind: string | null; target_kind: string; target_id: string };

export const projectHistory = defineVerb({
  name: "project.history", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "What happened in a project, newest first: work filed, claimed and finished, mail received, and changes to the project.",
  mcp: {
    scope: "read", destructive: false, title: "Project history",
    input: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project name." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 30." },
        before: { type: "integer", description: "Only events before this time (ms since epoch), for the next page." },
      },
      required: ["project"], additionalProperties: false,
    },
    render: (r) => {
      const x = r as { project: string; events: Ev[]; next_before: number | null };
      return [DATA_NOTE, "", `**${x.project}: what happened** (${x.events.length})`,
        ...x.events.map((e) => `- ${new Date(e.created_at).toISOString().slice(0, 16)} ${e.who ? `${cleanText(e.who)}${e.who_kind === "agent" ? " (helper)" : ""}: ` : ""}${cleanText(e.summary)}`),
        x.next_before ? `\nnext page: before=${x.next_before}` : ""].join("\n");
    },
  },
  parse: (i) => ({ project: reqString(i, "project", { max: 63 }), limit: optInt(i, "limit", { min: 1, max: 100 }) ?? 30, before: optInt(i, "before", { min: 0, max: 9e15 }) }),
  run: async (ctx, p) => {
    const pr = await ctx.db.prepare("SELECT id, slug FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel'").bind(ctx.tenant!.id, p.project.trim().toLowerCase()).first<{ id: string; slug: string }>();
    if (!pr) throw notFound("no such project");
    const r = await ctx.db.prepare(`SELECT e.id, e.kind, e.summary, e.created_at, e.target_kind, e.target_id, i.display_name AS who, i.kind AS who_kind
      FROM event e LEFT JOIN identity i ON i.id = e.identity_id
      WHERE e.tenant_id = ? AND (? IS NULL OR e.created_at < ?) AND ((e.target_kind = 'project' AND e.target_id = ?)
        OR (e.target_kind = 'work_item' AND e.target_id IN (SELECT id FROM work_item WHERE project_id = ?))
        OR (e.target_kind = 'inbound_mail' AND e.target_id IN (SELECT id FROM inbound_mail WHERE project_id = ?)))
      ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).bind(ctx.tenant!.id, p.before, p.before, pr.id, pr.id, pr.id, p.limit).all<Ev>();
    const events = r.results;
    return { project: pr.slug, events, next_before: events.length === p.limit ? events[events.length - 1]!.created_at : null };
  },
});

