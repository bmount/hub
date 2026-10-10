import { defineVerb } from "./table";
import { optBool, optString } from "./params";
import { budgetParam } from "./chatParams";
import { catchup } from "../chat/catchup";
import { chatText } from "../chat/compact";
import { LIMITS } from "../chat/rules";

export const chatCatchup = defineVerb({
  name: "chat.catchup", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "What happened since your read cursors, across every channel you can read, within a token budget: messages for you first, then your threads, then each channel. Pass next as since to continue.",
  mcp: {
    scope: "read", destructive: false, title: "Catch up", render: chatText,
    input: {
      type: "object",
      properties: {
        since: { type: "string", description: "The next value from an earlier catch-up in this tenant as the same reader; default is your read cursors. Unsigned activity state, not processing proof." },
        budget: { type: "integer", minimum: 100, maximum: LIMITS.BUDGET_MAX, description: "Token budget for the text, default 1500." },
        scope: { type: "string", description: "Only this channel." },
      },
      additionalProperties: false,
    },
  },
  parse: (i) => ({ since: optString(i, "since", { max: 8192 }), budget: budgetParam(i), scope: optString(i, "scope", { max: 64 }), advance: optBool(i, "advance") ?? false }),
  run: (ctx, p) => catchup(ctx, p),
});
