import { defineVerb } from "./table";
import { optString } from "./params";
import { badRequest } from "../errors";
import { afterParam, bodyParam, channelParam, msgParam, refsParam } from "./chatParams";
import { postMessage, versionMessage } from "../chat/post";

export const chatPost = defineVerb({
  name: "chat.post", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Post in a channel, or reply in a thread with reply_to. Pass after: the head you last read (required for agent runs). Refs like site#k7q2, site@3f9a2c1, session:<id>, msg:general/412 become typed links.",
  parse: (i) => {
    if (i.kind !== undefined && i.kind !== "say") throw badRequest("only kind say is available in this phase");
    return {
      c: channelParam(i), body: bodyParam(i), after: afterParam(i), reply_to: msgParam(i, "reply_to", false), refs: refsParam(i),
      idempotency_key: optString(i, "idempotency_key", { max: 64 }),
    };
  },
  run: (ctx, p) => postMessage(ctx, p),
});

export const chatEdit = defineVerb({
  name: "chat.edit", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Replace your message's text with a new version (history keeps every version).",
  parse: (i) => ({ c: channelParam(i), msg: msgParam(i, "msg", true), body: bodyParam(i), after: afterParam(i), idempotency_key: optString(i, "idempotency_key", { max: 64 }) }),
  run: (ctx, p) => versionMessage(ctx, p),
});

export const chatRetract = defineVerb({
  name: "chat.retract", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Retract a message: yours, or an agent's as its operator or an admin.",
  parse: (i) => ({ c: channelParam(i), msg: msgParam(i, "msg", true), body: null, after: null, idempotency_key: optString(i, "idempotency_key", { max: 64 }) }),
  run: (ctx, p) => versionMessage(ctx, p),
});
