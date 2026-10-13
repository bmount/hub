import type { Ctx } from "../auth/context";
import { getProjectByPath } from "../db/projects";
import { notFound } from "../errors";

/** Bare slugs mean top-level projects, except on a pinned project MCP endpoint. */
export async function featureProject(ctx: Ctx, path: string) {
  const scoped = ctx.mcpProject;
  if (scoped && path !== scoped.path && path !== scoped.slug) throw notFound("no such project");
  const parts = (scoped?.path ?? path).split("/");
  if (parts.length > 2 || parts.some(p => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p) || p.length > 63)) throw notFound("no such project");
  const p = await getProjectByPath(ctx.db, ctx.tenant!.id, parts.length === 2 ? parts[0]! : null, parts.at(-1)!);
  if (!p || (scoped && p.id !== scoped.id)) throw notFound("no such project");
  return p;
}
