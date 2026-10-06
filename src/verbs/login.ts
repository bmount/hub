import { defineVerb } from "./table";
import { optBool, optString, reqString } from "./params";
import { badRequest, HubError, notFound, unauthorized } from "../errors";
import { consumeLink, NEUTRAL_LOGIN_MESSAGE, requestLink, type LinkRequest } from "../auth/login";
import type { Ctx } from "../auth/context";

// Off the response path when the Worker gives us waitUntil, so timing does not reveal known addresses.
async function dispatch(ctx: Ctx, req: LinkRequest): Promise<void> {
  const work = requestLink(ctx.env, req, ctx.now).catch((e) => console.log("login request failed", e instanceof Error ? e.name : "error"));
  if (ctx.waitUntil) ctx.waitUntil(work);
  else await work;
}

export const loginRequest = defineVerb({
  name: "login.request", kind: "command", scope: "hub", minRole: "public", freshProofMinutes: null,
  summary: "Ask for a sign-in link by email, or with reproof a confirmation link to your own address. The answer never says whether the address is known.",
  parse: (i) => ({
    email: optString(i, "email", { max: 254 }),
    reproof: optBool(i, "reproof") ?? false,
    next: optString(i, "next", { max: 63 }),
  }),
  run: async (ctx, p) => {
    if (p.reproof) {
      if (!ctx.identity || !ctx.session || ctx.session.kind !== "browser") throw unauthorized();
      await dispatch(ctx, { email: ctx.identity.email, purpose: "reproof", ip: ctx.ip, next: p.next, session_id: ctx.session.id });
    } else {
      if (!p.email) throw badRequest("email is required");
      await dispatch(ctx, { email: p.email, purpose: "login", ip: ctx.ip, next: p.next, session_id: null });
    }
    return { message: NEUTRAL_LOGIN_MESSAGE };
  },
});

export const loginVerify = defineVerb({
  name: "login.verify", kind: "command", scope: "hub", minRole: "public", freshProofMinutes: null,
  summary: "Consume a sign-in or confirmation link token. A login link returns a new browser session token; a reproof link refreshes the calling session.",
  parse: (i) => ({ token: reqString(i, "token", { max: 128 }), next: optString(i, "next", { max: 63 }) }),
  run: async (ctx, p) => {
    const r = await consumeLink(ctx.env, ctx, p.token, p.next, ctx.now);
    if (r.kind === "invalid") throw notFound("link not valid");
    if (r.kind === "wrong_browser") throw new HubError(403, "session_mismatch", "a confirmation link must be used by the session that asked for it");
    return { identity_id: r.identity.id, session_id: r.session.id, session_token: r.newToken, location: r.location };
  },
});
