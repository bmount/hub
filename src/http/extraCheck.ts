// The extra check before acting for someone (owner, 2026-10-08): connecting an agent or inviting a person needs a
// recent confirmation that it's really them. It is shown up front, where they are, before they fill anything in:
// Google first (a few seconds), or an emailed link. Either way they come straight back to the same page.
import type { Env } from "../env";
import type { Ctx } from "../auth/context";
import { esc } from "../html";
import { googleConfigured, googleReproofAllowed } from "./googleLogin";

export const EXTRA_CHECK_MINUTES = 60;

/** True when this browser session confirmed it's them recently enough for actions that need fresh proof. */
export function proofFresh(ctx: Ctx, minutes: number = EXTRA_CHECK_MINUTES): boolean {
  return !!ctx.session && ctx.session.kind === "browser" && ctx.now - ctx.session.last_proof_at < minutes * 60_000;
}

/**
 * The card. `back` is the page to return to on this organization's host, as a local path (for example
 * "/people?connect=1&name=Build%20box"); `sent` is true once an email link is on its way.
 */
export function extraCheck(env: Env, ctx: Ctx, back: string, why: string, sent: boolean): string {
  const hub = `https://${env.HUB_DOMAIN}`;
  const next = `${ctx.tenant!.slug}${back}`;
  const google = googleConfigured(env) && googleReproofAllowed(ctx.identity!);
  const email = ctx.identity!.email;
  const mail = `<form method="post" action="${hub}/login" data-reload class="inline"><input type="hidden" name="reproof" value="1"><input type="hidden" name="return" value="1"><input type="hidden" name="next" value="${esc(next)}"><button type="submit" class="${google ? "quiet" : ""}">${sent ? "Send it again" : google ? "Email me a link instead" : "Email me a confirmation link"}</button></form>`;
  return `<div class="extra-check">
<h2>One extra check</h2>
<p>${esc(why)} It takes a few seconds, and then you're right back here.</p>
${sent ? `<p class="sent">A link is on its way to <strong>${esc(email)}</strong>. Open it in this browser and you'll come straight back here, ready to go.${google ? " Or use Google now:" : ""}</p>` : ""}
<div class="actions">${google ? `<a class="button" href="${hub}/login/google?reproof=1&amp;next=${esc(encodeURIComponent(next))}" data-reload>Continue with Google</a>` : ""}${mail}</div>
</div>`;
}
