import type { AuthorKind } from "./types";

/** Messaging spec 4.6. */
export const HANDLE_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const RESERVED_HANDLES = new Set(["channel", "here", "all", "hub", "admin", "root", "system", "everyone"]);

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h) && !RESERVED_HANDLES.has(h) && !RESERVED_SKELETONS.has(skeleton(h));
}

/** Reserved handles compared by skeleton, so `h-ub`, `ad-min`, `sys-tem`, and `r00t` are refused too. */
export const RESERVED_SKELETONS = new Set([...RESERVED_HANDLES].map((h) => skeleton(h)));

/**
 * Confusable skeleton (Unicode TR39) for the handle alphabet. Handles are ASCII by grammar, so only the ASCII
 * confusables apply; hyphens are dropped so `ti-dy` cannot sit beside `tidy`.
 */
export function skeleton(h: string): string {
  // Single-character maps and hyphen removal first, then every multi-character confusable expanded to its canonical
  // pair (m→rn, d→cl, w→vv), so the result does not depend on the order of the folds.
  return h.toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/-/g, "").replace(/m/g, "rn").replace(/d/g, "cl").replace(/w/g, "vv");
}

/** The handle an address suggests. Agents get their slug: their address is `<slug>@<tenant>.<domain>`. */
export function candidateHandle(email: string): string {
  let h = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(h)) h = `u${h}`;
  h = h.slice(0, 24).replace(/-+$/, "");
  while (h.length < 2) h += "x";
  return h;
}

function withSuffix(base: string, n: number): string {
  if (n === 1) return base;
  const s = `-${n}`;
  return base.slice(0, 24 - s.length).replace(/-+$/, "") + s;
}

/** Give every membership in the tenant without a handle one, oldest first; the unique skeleton index settles races. */
export async function ensureHandles(db: D1Database, tenant_id: string): Promise<void> {
  const r = await db.prepare(
    "SELECT m.id, i.email FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.handle IS NULL ORDER BY m.created_at, m.id",
  ).bind(tenant_id).all<{ id: string; email: string }>();
  for (const row of r.results) {
    const base = candidateHandle(row.email);
    for (let n = 1; n <= 99; n++) {
      const h = withSuffix(base, n);
      if (!isValidHandle(h)) continue;
      try {
        await db.prepare("UPDATE membership SET handle = ?, handle_skeleton = ? WHERE id = ? AND handle IS NULL").bind(h, skeleton(h), row.id).run();
        break;
      } catch (e) {
        if (!String(e).includes("UNIQUE")) throw e;
      }
    }
  }
}

export type Person = { identity_id: string; kind: "human" | "agent"; display_name: string; handle: string; operator_id: string | null; active: boolean };

/** Every member of the tenant, current or former, by identity id (a tenant holds about 20 identities: spec 1). */
export async function people(db: D1Database, tenant_id: string): Promise<Map<string, Person>> {
  await ensureHandles(db, tenant_id);
  const r = await db.prepare(
    `SELECT i.id, i.kind, i.display_name, i.operator_id, i.state AS i_state, m.state AS m_state, m.handle
       FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ?`,
  ).bind(tenant_id).all<{ id: string; kind: "human" | "agent"; display_name: string; operator_id: string | null; i_state: string; m_state: string; handle: string | null }>();
  const out = new Map<string, Person>();
  for (const x of r.results) {
    out.set(x.id, {
      identity_id: x.id, kind: x.kind, display_name: x.display_name, handle: x.handle ?? "unknown", operator_id: x.operator_id,
      active: x.i_state === "active" && x.m_state === "active",
    });
  }
  return out;
}

/** Spec 4.6: handle, display name, kind, operator for agents, session label, and `via assistant`. Never from message text. */
export type NameTag = {
  identity_id: string; handle: string; display_name: string; kind: AuthorKind; operator_handle: string | null;
  session_id: string | null; session_label: string | null; via_assistant: boolean;
};
export type TagOf = (author_id: string, session_id: string | null) => NameTag;

export const HUB_TAG: NameTag = {
  identity_id: "hub", handle: "hub", display_name: "Pimwell", kind: "hub", operator_handle: null, session_id: null, session_label: null, via_assistant: false,
};

/** Run labels are chosen by an agent's runner: only `[A-Za-z0-9._-]`, at most 32, so a label cannot forge a header. */
export function safeLabel(label: string | null): string | null {
  if (!label) return null;
  const s = label.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return s || null;
}

/**
 * `session_kind` is the kind stored with the message when it was written; it wins over the session row's current
 * kind for `via assistant`. The session row is looked up only within the tenant (or a tenantless session).
 */
export async function nameTags(
  db: D1Database, tenant_id: string, pairs: Array<{ author_id: string; session_id: string | null; session_kind?: string | null }>,
): Promise<TagOf> {
  const dir = await people(db, tenant_id);
  const ids = [...new Set(pairs.map((p) => p.session_id).filter((x): x is string => typeof x === "string" && x.length > 0))];
  const sessions = new Map<string, { kind: string; label: string | null }>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const r = await db.prepare(`SELECT id, kind, label FROM session WHERE id IN (${chunk.map(() => "?").join(", ")}) AND (tenant_id IS NULL OR tenant_id = ?)`)
      .bind(...chunk, tenant_id).all<{ id: string; kind: string; label: string | null }>();
    for (const s of r.results) sessions.set(s.id, s);
  }
  const stored = new Map<string, string>();
  for (const p of pairs) if (p.session_id && p.session_kind && !stored.has(p.session_id)) stored.set(p.session_id, p.session_kind);
  return (author_id, session_id) => {
    if (author_id === "hub") return HUB_TAG;
    const p = dir.get(author_id);
    const s = session_id ? sessions.get(session_id) : undefined;
    const kind = (session_id ? stored.get(session_id) : undefined) ?? s?.kind;
    return {
      identity_id: author_id, handle: p?.handle ?? "unknown", display_name: p?.display_name ?? "unknown", kind: p?.kind ?? "human",
      operator_handle: p?.operator_id ? dir.get(p.operator_id)?.handle ?? null : null, session_id,
      session_label: s && kind === "agent_run" ? safeLabel(s.label) : null, via_assistant: kind === "oauth",
    };
  };
}
