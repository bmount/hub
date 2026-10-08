// Git for agents (owner, 2026-10-08): agents clone and push to their organization's repositories with a git credential
// helper. On each use it trades the agent's own long-lived token for a one-hour run session (session.start); git sees
// only that. No token goes in a URL, a remote, a command line or the conversation. Ardi refuses force pushes and
// history rewrites, so what an agent pushes can always be undone.
import type { Env } from "../env";
import { connectionNames } from "../auth/connect";

/** The helper for one organization, as a POSIX shell script. Public: it holds no secret, only where to find one. */
export function gitHelperScript(env: Env, slug: string): string {
  const n = connectionNames(slug);
  const host = `${slug}.${env.HUB_DOMAIN.toLowerCase()}`;
  return `#!/bin/sh
# Pimwell git credential helper for ${host}.
# Trades your agent token for a one-hour git session each time git asks; git never sees the token itself.
# The token comes from $${n.secret}, or the file ~/.config/pimwell/${slug}.token (mode 0600).
# Install:  git config --global credential.https://${host}.helper "/path/to/this/script"
[ "$1" = get ] || exit 0
TOKEN="$\{${n.secret}:-$(cat "$HOME/.config/pimwell/${slug}.token" 2>/dev/null)}"
[ -n "$TOKEN" ] || { echo "pimwell: set ${n.secret} or ~/.config/pimwell/${slug}.token" >&2; exit 1; }
ANSWER=$(printf 'header = "authorization: Bearer %s"\\n' "$TOKEN" | curl -sf -K - -X POST -H 'content-type: application/json' \\
  --data '{"label":"git","ttl":3600}' "https://${host}/api/session.start") || { echo "pimwell: the hub refused the token" >&2; exit 1; }
SESSION=$(printf '%s' "$ANSWER" | sed -n 's/.*"session_token":"\\(pms_[A-Za-z0-9_-]*\\)".*/\\1/p')
[ -n "$SESSION" ] || exit 1
echo username=agent
echo "password=$SESSION"
`;
}

export function gitHelperResponse(env: Env, slug: string): Response {
  return new Response(gitHelperScript(env, slug), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
}
