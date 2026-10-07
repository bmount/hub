// Default channels for every project (owner, 2026-10-07): a place to talk about it and a place where its operations
// show up. Names follow the project: #<project>-team and #<project>-ops. A name that is taken or too long is skipped.
import { createChannel } from "../db/chat";
import { HubError } from "../errors";

export const PROJECT_CHANNELS = [
  { suffix: "team", topic: (name: string) => `Talk about ${name}: questions, decisions and handoffs, with people and agents.` },
  { suffix: "ops", topic: (name: string) => `${name} in operation: deploys, health checks and errors, posted by Pimwell and agents.` },
] as const;

export async function ensureProjectChannels(
  db: D1Database, project: { tenant_id: string; slug: string; display_name: string }, created_by: string, now: number,
): Promise<string[]> {
  const made: string[] = [];
  for (const c of PROJECT_CHANNELS) {
    const slug = `${project.slug}-${c.suffix}`;
    if (slug.length > 63) continue;
    try {
      await createChannel(db, { tenant_id: project.tenant_id, slug, display_name: `${project.display_name} ${c.suffix}`, topic: c.topic(project.display_name), created_by }, now);
      made.push(slug);
    } catch (e) {
      if (!(e instanceof HubError) || e.status !== 409) throw e;
    }
  }
  return made;
}
