import { defineVerb } from "./table";
import { optInt, optString } from "./params";
import { listEventsPage } from "../db/events";
import { readableMailEvents } from "../auth/mailAccess";

export const eventList = defineVerb({
  name: "event.list", kind: "query", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "List this tenant's activity, newest first. Pass session_id to see what one session (for example one assistant connection) did.",
  mcp: {
    scope: "read", destructive: false, title: "Tenant activity",
    input: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Rows to return, default 25." },
        cursor: { type: "string", description: "The next_cursor value from the previous page." },
        session_id: { type: "string", description: "Only events recorded by this session." },
      },
      additionalProperties: false,
    },
  },
  parse: (i) => ({
    limit: optInt(i, "limit", { min: 1, max: 100 }) ?? 25,
    cursor: optString(i, "cursor", { max: 26 }),
    session_id: optString(i, "session_id", { max: 26 }),
  }),
  run: async (ctx, p) => {
    const rows = await listEventsPage(ctx.db, ctx.tenant!.id, { limit: p.limit + 1, before: p.cursor, session_id: p.session_id, visibility: readableMailEvents(ctx, "event") });
    const page = rows.slice(0, p.limit);
    return {
      events: page.map((e) => ({
        id: e.id, created_at: e.created_at, kind: e.kind, summary: e.summary, identity_id: e.identity_id, session_id: e.session_id,
        target_kind: e.target_kind, target_id: e.target_id,
      })),
      next_cursor: rows.length > p.limit ? page[page.length - 1]!.id : null,
    };
  },
});
