import { rank, type Ctx } from "../auth/context";
import { getMembership } from "../db/memberships";
import { getIdentityById } from "../db/identities";
import { getSessionById } from "../db/sessions";
import { getChannelById, getChannelBySlug } from "../db/chat";
import type { Session } from "../db/types";
import { canRead, viewerOf, type Viewer } from "./access";
import { ardiResolve } from "./ardi";
import { parseRefText, type ParsedRef } from "./grammar";
import { conversationStub } from "./stubs";
import type { MsgView, RefKind, StoredRef, ViewRef } from "./types";

export type Unresolved = { kind: string; text: string; reason: "not_found" | "ardi_unavailable" | "ambiguous" };

const firstLine = (s: string) => (s.split(/\r\n|[\n\r]/)[0] ?? "").slice(0, 80);

/** Whose sessions a viewer may name: their own, their agents' (as operator), and anyone's for admins (spec 11.1 transcript rule). */
async function sessionVisible(db: D1Database, v: Viewer, s: Session): Promise<boolean> {
  // Browser sessions are not bound to a tenant (tenant_id null); agent and oauth sessions are.
  if (s.tenant_id !== null && s.tenant_id !== v.tenant.id) return false;
  if (s.identity_id === v.identity.id) return true;
  if (rank(v.role) >= rank("admin")) {
    if (s.tenant_id !== null) return true;
    const m = await getMembership(db, s.identity_id, v.tenant.id);
    return m !== null && m.state === "active";
  }
  const owner = await getIdentityById(db, s.identity_id);
  return owner !== null && owner.kind === "agent" && owner.operator_id === v.identity.id;
}

async function resolveMsg(ctx: Ctx, v: Viewer, r: Extract<ParsedRef, { kind: "msg" }>): Promise<StoredRef | null> {
  let conversation_id: string | null = null;
  if (r.msg_id) {
    const row = await ctx.db.prepare("SELECT conversation_id FROM msg_index WHERE tenant_id = ? AND msg_id = ? LIMIT 1").bind(v.tenant.id, r.msg_id).first<{ conversation_id: string }>();
    conversation_id = row?.conversation_id ?? null;
  }
  const ch = conversation_id ? await getChannelById(ctx.db, v.tenant.id, conversation_id) : r.channel ? await getChannelBySlug(ctx.db, v.tenant.id, r.channel) : null;
  if (!ch || !(await canRead(ctx.db, v, ch))) return null;
  const m = (await conversationStub(ctx.env, v.tenant.id, ch.project_id).getMessage(v.tenant.id, ch.project_id, r.msg_id ?? String(r.seq))) as MsgView | null;
  if (!m || m.kind === "system") return null;
  return { kind: "msg", key: `${ch.project_id}/${m.msg_id}`, title: m.retracted ? "(retracted)" : firstLine(m.body) };
}

/** Spec 5.2: every ref resolved at post time with the poster's permissions; what fails stays plain text and is reported. */
export async function resolveRefs(ctx: Ctx, parsed: ParsedRef[]): Promise<{ resolved: StoredRef[]; unresolved: Unresolved[] }> {
  const v = viewerOf(ctx);
  const ardiRefs = parsed.filter((r): r is Extract<ParsedRef, { kind: "commit" | "ticket" }> => r.kind === "commit" || r.kind === "ticket");
  const answers = await ardiResolve(ctx.env, {
    tenant: v.tenant.slug, principal: v.identity.id, session: ctx.session?.id ?? "",
    refs: ardiRefs.map((r) => ({ kind: r.kind, repo: r.repo, id: r.kind === "commit" ? r.oid : r.ticket })),
  });
  const resolved: StoredRef[] = [];
  const unresolved: Unresolved[] = [];
  for (const r of parsed) {
    if (r.kind === "commit" || r.kind === "ticket") {
      const a = answers ? answers[ardiRefs.indexOf(r)] : undefined;
      if (a && a.found) resolved.push({ kind: r.kind, key: a.key, title: a.title });
      else if (a) unresolved.push({ kind: r.kind, text: r.text, reason: a.ambiguous ? "ambiguous" : "not_found" });
      // Ardi unavailable: keys that need no lookup are kept unverified (title null); short prefixes cannot be.
      else if (r.kind === "ticket") resolved.push({ kind: "ticket", key: `${r.repo}#${r.ticket}`, title: null });
      else if (r.oid.length === 40) resolved.push({ kind: "commit", key: `${r.repo}@${r.oid}`, title: null });
      else unresolved.push({ kind: "commit", text: r.text, reason: "ardi_unavailable" });
    } else if (r.kind === "session") {
      const s = await getSessionById(ctx.db, r.session_id);
      if (s && (await sessionVisible(ctx.db, v, s))) resolved.push({ kind: "session", key: s.id, title: `${s.kind}${s.label ? ` ${s.label}` : ""}`.slice(0, 80) });
      else unresolved.push({ kind: "session", text: r.text, reason: "not_found" });
    } else {
      const m = await resolveMsg(ctx, v, r);
      if (m) resolved.push(m);
      else unresolved.push({ kind: "msg", text: r.text, reason: "not_found" });
    }
  }
  const seen = new Set<string>();
  return { resolved: resolved.filter((r) => !seen.has(`${r.kind}:${r.key}`) && !!seen.add(`${r.kind}:${r.key}`)), unresolved };
}

/** Spec 5.2: "A ref never grants access": each ref re-checked for this viewer, titles hidden when it may not see the target. */
export async function refsForViewer(db: D1Database, v: Viewer, refs: StoredRef[]): Promise<ViewRef[]> {
  const out: ViewRef[] = [];
  for (const r of refs) {
    let visible: boolean;
    if (r.kind === "session") {
      const s = await getSessionById(db, r.key);
      visible = s !== null && (await sessionVisible(db, v, s));
    } else if (r.kind === "msg") {
      const ch = await getChannelById(db, v.tenant.id, r.key.split("/")[0] ?? "");
      visible = ch !== null && (await canRead(db, v, ch));
    } else {
      // Every hub role maps to Ardi read (integration spec 5).
      visible = rank(v.role) >= rank("reader");
    }
    out.push(visible ? { ...r, no_access: false } : { kind: r.kind, key: r.key, title: null, no_access: true });
  }
  return out;
}

/** What a backlinks query matches; commit prefixes match every full oid that starts with them. Msg targets go through resolveRefs. */
export function backlinkTarget(kind: string, key: string): { kind: RefKind; key: string; prefix: boolean } | null {
  const r = parseRefText(kind, key);
  if (!r) return null;
  if (r.kind === "commit") return { kind: "commit", key: `${r.repo}@${r.oid}`, prefix: r.oid.length < 40 };
  if (r.kind === "ticket") return { kind: "ticket", key: `${r.repo}#${r.ticket}`, prefix: false };
  if (r.kind === "session") return { kind: "session", key: r.session_id, prefix: false };
  return null;
}
