import type { Env } from "../env";
import { esc } from "../html";

/** Shared browser-connector instructions; terminal agents keep their own onboarding. */
export function mcpConnectCard(env: Env, orgs: Array<{ slug: string; name: string }>): string {
  if (!orgs.length) return "";
  return `<section class="mcp-connect" aria-labelledby="mcp-connect-heading"><h2 id="mcp-connect-heading">Connect Claude or ChatGPT</h2>
${orgs.map((org, i) => {
    const id = `mcp-connect-url-${i}`;
    const url = `https://${org.slug}.${env.HUB_DOMAIN}/mcp`;
    return `<div class="mcp-connect-org"><label for="${id}">${esc(org.name)}</label><div class="mcp-connect-row"><input id="${id}" type="text" readonly value="${esc(url)}" spellcheck="false"><button type="button" data-copy="#${id}" aria-label="Copy ${esc(org.name)} MCP URL">Copy</button></div></div>`;
  }).join("")}
<ol><li>In Claude or ChatGPT, add a custom connector.</li><li>Paste your organization's URL above.</li><li>Sign in to Pimwell and approve read and write access.</li></ol></section>`;
}
