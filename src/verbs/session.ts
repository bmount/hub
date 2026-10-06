import { defineVerb } from "./table";
import { reqString } from "./params";
import { notFound, unauthorized } from "../errors";
import { listSessions, revokeSession } from "../db/sessions";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";
import type { Session } from "../db/types";

function requireIdentity(ctx: Ctx) {
  if (!ctx.identity || !ctx.session) throw unauthorized();
  return { identity: ctx.identity, session: ctx.session };
}

export const sessionList = defineVerb({
  name: "session.list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, summary: "List your active sessions.",
  parse: () => ({}),
  run: async (ctx) => {
    const { identity, session } = requireIdentity(ctx);
    const rows = await listSessions(ctx.db, identity.id, ctx.now);
    return {
      sessions: rows.map((s) => ({
        id: s.id, kind: s.kind, label: s.label, created_at: s.created_at, last_seen_at: s.last_seen_at,
        expires_at: s.expires_at, last_proof_at: s.last_proof_at, current: s.id === session.id,
      })),
    };
  },
});

export const sessionRevoke = defineVerb({
  name: "session.revoke", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, summary: "Revoke one of your sessions (root: any session).",
  parse: (i) => ({ session_id: reqString(i, "session_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity, session } = requireIdentity(ctx);
    const target = await ctx.db.prepare("SELECT * FROM session WHERE id = ?").bind(p.session_id).first<Session>();
    if (!target || (target.identity_id !== identity.id && identity.is_root !== 1)) throw notFound("no such session");
    await revokeSession(ctx.db, target.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: null, identity_id: identity.id, session_id: session.id, kind: "session.revoke", target_kind: "session", target_id: target.id, summary: `Revoked session ${target.id}` }, ctx.now);
    return { ok: true };
  },
});

export const sessionEnd = defineVerb({
  name: "session.end", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, summary: "Sign out: revoke the current session.",
  parse: () => ({}),
  run: async (ctx) => {
    const { identity, session } = requireIdentity(ctx);
    await revokeSession(ctx.db, session.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: null, identity_id: identity.id, session_id: session.id, kind: "session.end", target_kind: "session", target_id: session.id, summary: "Signed out" }, ctx.now);
    ctx.staleCookie = ctx.authKind === "cookie";
    return { ok: true };
  },
});
