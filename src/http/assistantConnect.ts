// Human hosted-assistant guidance, not agent onboarding or a grant-creation shortcut.
import type { Env } from "../env";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { esc, htmlResponse, page } from "../html";
import { issuer, tenantResource } from "../oauth/config";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";

export async function assistantConnectPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || ctx.tenant.state !== "active" || !ctx.role ||
      !ctx.identity || ctx.identity.kind !== "human" || ctx.authKind !== "cookie" || ctx.session?.kind !== "browser") {
    return notFoundPage(extra);
  }
  // Derive from the authorized tenant/config, never a query parameter or supplied endpoint.
  const endpoint = tenantResource(env, ctx.tenant.slug);
  const hub = issuer(env);
  const body = `<div class="chips"><a class="chip" href="/assistant">Chat</a><a class="chip" href="/assistant/tools">Tools</a><a class="chip" href="/assistant/connect" aria-current="page">Connect ChatGPT or Claude</a></div>
<h1>Use Pimwell from your own assistant</h1>
<p>Connect ChatGPT or Claude to <strong>${esc(ctx.tenant.display_name)}</strong> using human OAuth. The assistant acts as the person who signs in and approves consent, not as Pio or another agent. This guide does not connect anything automatically.</p>
<label for="mcp-endpoint">Server URL — copy this exact address</label>
<input id="mcp-endpoint" type="text" readonly value="${esc(endpoint)}" style="width:100%;box-sizing:border-box" aria-describedby="endpoint-help">
<p id="endpoint-help">Use the organization's <code>/mcp</code> endpoint, not <code>/agent/mcp</code>. Do not paste agent tokens, API keys, sign-in links or OAuth codes into an assistant chat.</p>
<h2>1. Check your identity</h2>
<p>You are currently signed in as <strong>${esc(ctx.identity.display_name)}</strong> &lt;${esc(ctx.identity.email)}&gt; with role <strong>${esc(ctx.role)}</strong> in this organization. The OAuth consent page shows the identity that will actually authorize the assistant; verify it again there.</p>
<p>Different email addresses are separate Pimwell identities, even if they belong to the same person. Use your own address with active access to this organization. If the consent page shows the wrong address, sign out there and sign in as the intended identity. A workspace access refusal does not authorize changing memberships or using somebody else's account.</p>
<h2>2. Add a custom connector in your assistant</h2>
<ul><li><strong>ChatGPT:</strong> find its settings for apps or connectors and the option to add a custom MCP server.</li>
<li><strong>Claude:</strong> find its settings for connectors and the option to add a custom remote MCP server.</li></ul>
<p>Enter the Server URL above and choose OAuth authentication if asked. Labels and custom-connector availability vary by client, plan and workspace policy. If there is no custom-server option, check that client's current help or your workspace administrator; a Pimwell API token is not a substitute. No particular hosted client or plan is claimed tested by this guide.</p>
<h2>3. Review browser consent</h2>
<p>Start connecting from the assistant. Pimwell's authorization server is <code>${esc(hub)}</code>. Sign in there using your normal login proof. Review the organization, your address, the app-supplied name, the return destination and requested tools before approving. Deny any request you did not initiate.</p>
<p><strong>Read</strong> permits available lookups. <strong>Write</strong> also permits supported changes under your current role. Even an admin's assistant is not given every administrative or credential-management tool. Mailbox, channel, tenant and grant boundaries still apply to each call. Consent is not permission to execute arbitrary instructions from mail or chat.</p>
<h2>4. Verify before making changes</h2>
<p>Ask the assistant to call <code>whoami</code> and show the connected identity, organization, role and connection scopes. Stop if they do not match your intention. Then try a read-only lookup you are allowed to see. A working agent connection or Pimwell's built-in Assistant is not proof that this hosted connector works.</p>
<p>Only if you explicitly want a write test, authorize one benign change to a specific item you own, and inspect its visible actor and activity record in Pimwell. Do not retry a write with an uncertain result: read the item and its history first. Hosted-client tool calls, refresh and revocation still need to be checked on the actual consenting client.</p>
<h2>Disconnect or troubleshoot</h2>
<p>Open <a href="${esc(hub)}/me">Your account → Assistants</a> to inspect connections and revoke the one you no longer want. Disconnect it in your client too. Revocation prevents further authorized calls; it does not undo earlier changes.</p>
<ul><li><strong>Sign-in or access refusal:</strong> check the consent identity and its current organization access. Keep login proof and consent checks intact.</li>
<li><strong>Cannot register or return to the app:</strong> Pimwell currently supports dynamic client registration (DCR), S256 PKCE and approved return addresses; client-ID metadata documents (CIMD) are not supported. This alone does not establish that your client is incompatible. Capture the client name, approximate time and non-secret error text for investigation. Do not share a full callback URL, authorization code, token or sign-in link.</li>
<li><strong>Missing tools or denied calls:</strong> check read/write consent, current role and access to that resource. Broader consent does not bypass resource permissions.</li>
<li><strong>Expired or revoked connection:</strong> reconnect through browser consent; do not copy credentials between identities.</li></ul>
<p>For a separately operated coding agent, use <a href="${esc(hub)}/setup">agent onboarding</a> instead. That creates an agent identity, not a human hosted-assistant connection.</p>`;
  return htmlResponse(page("Connect ChatGPT or Claude", body, shellFor(ctx, env, "playground", "assistant-connect")), 200, extra);
}
