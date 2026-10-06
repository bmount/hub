import { Server, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { Env } from "../env";
import type { Ctx } from "../auth/context";
import { classifyHost } from "../tenant";
import { oauthJson } from "../http/oauthMeta";
import { notFoundPage } from "../http/pages";
import { mcpAuth } from "./context";
import { callTool, toolDefinition, toolsFor } from "./tools";

/** DNS-rebinding and browser-CSRF defense (MCP spec 8.7): only these browser origins, or none. */
const ALLOWED_ORIGINS = new Set(["https://claude.ai", "https://chatgpt.com"]);

/** A fresh low-level server per request: the tool list is whatever this grant and role allow right now. */
function serverFor(ctx: Ctx): Server {
  const server = new Server({ name: "pimwell", version: "1.0.0" }, { capabilities: { tools: {} }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  server.setRequestHandler("tools/list", async () => ({ tools: toolsFor(ctx).map(toolDefinition) }));
  server.setRequestHandler("tools/call", async (req) => callTool(ctx, req.params.name, req.params.arguments ?? {}));
  return server;
}

/**
 * Stateless Streamable HTTP (MCP spec 8.7): no session, no Durable Object; 2025-era clients use the stateless
 * fallback. Built on first use, never at module load: Workers forbid timers and randomness in global scope.
 */
let mcp: McpHttpHandler | null = null;
function mcpHandler(): McpHttpHandler {
  mcp ??= createMcpHandler((rc) => {
    const ctx = rc.authInfo?.extra?.hub as Ctx | undefined;
    if (!ctx) throw new Error("MCP request without hub authentication");
    return serverFor(ctx);
  }, { legacy: "stateless", onerror: (e) => console.log("mcp error", e.name) });
  return mcp;
}

export async function handleMcp(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void, now: number = Date.now()): Promise<Response> {
  const host = classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN);
  if (host.kind !== "tenant") return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin !== null && !ALLOWED_ORIGINS.has(origin)) return oauthJson({ error: "forbidden_origin" }, 403);
  const auth = await mcpAuth(request, env, host.slug, now, waitUntil);
  if (auth.kind === "deny") return auth.response;
  const o = auth.ctx.oauth!;
  return mcpHandler().fetch(request, {
    authInfo: { token: auth.token, clientId: o.client_id, scopes: o.scopes, expiresAt: auth.expiresAt, resource: new URL(auth.resource), extra: { hub: auth.ctx } },
  });
}
