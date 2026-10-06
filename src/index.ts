import { Hono } from "hono";
import type { Env } from "./env";
import { handleApi } from "./http/api";
import { registerAllVerbs } from "./verbs/index";
import { authLinkPage, consumeLinkPage, loginPage, loginPostPage } from "./http/login";
import { mePage } from "./http/me";
import { adminAgentsPage } from "./http/adminAgents";
import { handleEmail } from "./mail/inbound";
import { introspect } from "./http/internal";
import { asMetadataPage, protectedResourcePage } from "./http/oauthMeta";
import { authorizePage, consentPage, consentPost } from "./http/oauthAuthorize";
import { tokenEndpoint } from "./oauth/token";
import { registerEndpoint } from "./http/oauthRegister";
import { handleMcp } from "./mcp/handler";
import { acceptInvitePage, archivePage, homePage, invitePage, notFoundPage, sessionsPage } from "./http/pages";

registerAllVerbs();

const app = new Hono<{ Bindings: Env }>();

/** Hono types its execution context separately from workers-types; at runtime it is the Worker's own. */
const workerCtx = (c: unknown): ExecutionContext => c as ExecutionContext;

app.get("/healthz", (c) => c.text("ok"));
app.post("/api/*", (c) => handleApi(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
app.get("/", (c) => homePage(c.req.raw, c.env));
app.get("/archive", (c) => archivePage(c.req.raw, c.env));
app.get("/invite/:token", (c) => invitePage(c.req.raw, c.env));
app.post("/invite/:token", (c) => acceptInvitePage(c.req.raw, c.env));
app.get("/login", (c) => loginPage(c.req.raw, c.env));
app.post("/login", (c) => loginPostPage(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
app.get("/auth/:token", (c) => authLinkPage(c.req.raw, c.env));
app.post("/auth/:token", (c) => consumeLinkPage(c.req.raw, c.env));
app.get("/me", (c) => mePage(c.req.raw, c.env));
app.get("/admin/agents", (c) => adminAgentsPage(c.req.raw, c.env));
app.get("/me/sessions", (c) => sessionsPage(c.req.raw, c.env));
app.post("/internal/introspect", (c) => introspect(c.req.raw, c.env));
app.get("/.well-known/oauth-authorization-server", (c) => asMetadataPage(c.req.raw, c.env));
app.get("/.well-known/oauth-protected-resource", (c) => protectedResourcePage(c.req.raw, c.env));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => protectedResourcePage(c.req.raw, c.env));
app.post("/oauth/register", (c) => registerEndpoint(c.req.raw, c.env, workerCtx(c.executionCtx)));
app.get("/oauth/authorize", (c) => authorizePage(c.req.raw, c.env));
app.post("/oauth/token", (c) => tokenEndpoint(c.req.raw, c.env, workerCtx(c.executionCtx)));
app.post("/oauth/revoke", (c) => tokenEndpoint(c.req.raw, c.env, workerCtx(c.executionCtx)));
app.get("/oauth/consent/:id", (c) => consentPage(c.req.raw, c.env));
app.post("/oauth/consent/:id", (c) => consentPost(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));
app.notFound(() => notFoundPage());

export default { fetch: app.fetch, email: handleEmail } satisfies ExportedHandler<Env>;
