// Following and attention (migration 0010). Filing, owning and commenting follow an item; changes to it put an entry
// in each follower's attention list ("What needs me"), never the actor's own. Mentions in comments reach the person
// named even if they don't follow. Everything here is a few statements in one batch.
import { ulid } from "../ids";
import type { Ctx } from "../auth/context";
import type { WorkItem } from "../db/work";

export type Reason = "mention" | "comment" | "assigned" | "changed" | "filed";

export function followStatement(ctx: Ctx, identity_id: string, kind: "item" | "project", target_id: string): D1PreparedStatement {
  return ctx.db.prepare("INSERT OR IGNORE INTO follow (tenant_id, identity_id, target_kind, target_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(ctx.tenant!.id, identity_id, kind, target_id, ctx.now);
}

/** Followers of the item or its project who are still active members, minus the actor. */
export async function followers(ctx: Ctx, item: WorkItem): Promise<string[]> {
  const r = await ctx.db.prepare(
    `SELECT DISTINCT f.identity_id FROM follow f JOIN membership m ON m.identity_id = f.identity_id AND m.tenant_id = f.tenant_id AND m.state = 'active'
     WHERE f.tenant_id = ? AND ((f.target_kind = 'item' AND f.target_id = ?) OR (f.target_kind = 'project' AND f.target_id = ?))`,
  ).bind(ctx.tenant!.id, item.id, item.project_id).all<{ identity_id: string }>();
  return r.results.map((x) => x.identity_id).filter((id) => id !== ctx.identity!.id);
}

/** One attention entry per person (deduplicated, never the actor), as statements for the caller's batch. */
export function attentionStatements(ctx: Ctx, item: WorkItem, entries: Array<{ to: string; reason: Reason; summary: string }>): D1PreparedStatement[] {
  const seen = new Set<string>();
  const out: D1PreparedStatement[] = [];
  for (const e of entries) {
    if (e.to === ctx.identity!.id || seen.has(e.to)) continue;
    seen.add(e.to);
    out.push(ctx.db.prepare("INSERT INTO attention (id, tenant_id, identity_id, reason, item_id, actor_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(ulid(ctx.now), ctx.tenant!.id, e.to, e.reason, item.id, ctx.identity!.id, e.summary.slice(0, 300), ctx.now));
  }
  return out;
}

/** After a change by the actor: follow it themselves, and tell followers (and a new owner) what happened. */
export async function afterChange(ctx: Ctx, item: WorkItem, summary: string, opts: { newOwner?: string | null; reason?: Reason } = {}): Promise<void> {
  const fs = await followers(ctx, item);
  const entries: Array<{ to: string; reason: Reason; summary: string }> = [];
  if (opts.newOwner) entries.push({ to: opts.newOwner, reason: opts.reason === "filed" ? "filed" : "assigned", summary });
  for (const f of fs) entries.push({ to: f, reason: opts.reason ?? "changed", summary });
  const stmts = [followStatement(ctx, ctx.identity!.id, "item", item.id), ...(opts.newOwner ? [followStatement(ctx, opts.newOwner, "item", item.id)] : []), ...attentionStatements(ctx, item, entries)];
  await ctx.db.batch(stmts);
}
