import { defineVerb } from "./table";
import { reqString } from "./params";
import { timingSafeEqual } from "../ids";
import { conflict, forbidden } from "../errors";
import { rootExists } from "../db/identities";
import { createInvite } from "../db/invites";
import { recordEvent } from "../db/events";

export const bootstrap = defineVerb({
  name: "bootstrap",
  kind: "command",
  scope: "hub",
  minRole: "public",
  freshProofMinutes: null,
  summary: "Create the first root invite using the bootstrap secret. Disabled once a root exists.",
  parse: (i) => ({ token: reqString(i, "token", { max: 512 }), email: reqString(i, "email", { max: 254 }), display_name: reqString(i, "display_name", { max: 80 }) }),
  run: async (ctx, p) => {
    if (!ctx.env.HUB_BOOTSTRAP_TOKEN || !timingSafeEqual(p.token, ctx.env.HUB_BOOTSTRAP_TOKEN)) throw forbidden();
    if (await rootExists(ctx.db)) throw conflict("bootstrap already done");
    const pending = await ctx.db.prepare(
      "SELECT 1 FROM invite WHERE role = 'root' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
    ).bind(ctx.now).first();
    if (pending) throw conflict("root invite pending");
    const { invite, token } = await createInvite(ctx.db, { tenant_id: null, email: p.email, role: "root", display_name: p.display_name, created_by: null }, ctx.now);
    await recordEvent(ctx.db, { tenant_id: null, identity_id: null, session_id: null, kind: "bootstrap", target_kind: "invite", target_id: invite.id, summary: "Root invite created by bootstrap" }, ctx.now);
    return { invite_url: `https://${ctx.env.HUB_DOMAIN}/invite/${token}`, expires_at: invite.expires_at };
  },
});
