// Public, grounded connection instructions for humans and AI clients. No credentials or session state.
import type { Env } from "../env";
import { classifyHost } from "../tenant";
import { OAUTH_SCOPES, tenantResource } from "../oauth/config";
import { esc, htmlResponse, page } from "../html";
import { notFoundPage } from "./pages";

export function assistantConnectionGuide(env: Env, slug: string | null) {
  return {
    transport: "streamable-http",
    mcp_url: slug ? tenantResource(env, slug) : null,
    organization_required: slug === null,
    authentication: "oauth",
    supported_scopes: [...OAUTH_SCOPES],
    steps: [
      ...(slug ? [] : ["Open your organization's Pimwell address to obtain its exact MCP URL; do not use the hub's apex as the MCP endpoint."]),
      "In ChatGPT, add a custom MCP connector/app using the organization's MCP URL. Availability and UI names vary by plan and workspace; an administrator may need to enable custom connectors.",
      "Use OAuth. Complete Pimwell sign-in in the browser, verify the displayed identity and organization, then approve the requested supported scopes.",
      "Only grant write access when the server and client offer it and you want changes authorized. A read-only grant cannot perform writes.",
      "Test the connection with whoami and capabilities; compare the identity, organization, and available rights with your intent.",
      "Do not paste agent tokens, one-time connect links, passwords, or API keys into ChatGPT prompts. Headless agent onboarding is a different flow, not a hosted-chat connector.",
      "If the wrong Google identity appears, cancel approval, switch accounts, and reconnect. Review or revoke existing connections under your Pimwell sessions.",
    ],
  };
}

export function connectAssistantPage(request: Request, env: Env): Response {
  const host = classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN);
  if (host.kind !== "apex" && host.kind !== "tenant") return notFoundPage();
  const guide = assistantConnectionGuide(env, host.kind === "tenant" ? host.slug : null);
  if (new URL(request.url).pathname.endsWith(".json")) {
    return new Response(JSON.stringify(guide), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  const endpoint = guide.mcp_url
    ? `<p>MCP URL: <code>${esc(guide.mcp_url)}</code></p>`
    : "<p>Start on your organization's address, for example <code>https://&lt;org&gt;." + esc(env.HUB_DOMAIN) + "/connect-assistant</code>.</p>";
  return htmlResponse(page("Connect ChatGPT or another assistant", `<h1>Connect ChatGPT or another assistant</h1>${endpoint}
<p>Transport: streamable HTTP. Authentication: OAuth. Supported scopes: <code>${esc(guide.supported_scopes.join(", "))}</code>.</p>
<ol>${guide.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
<p><a href="/connect-assistant.json">Machine-readable connection guide</a></p>`), 200, { "cache-control": "no-store" });
}
