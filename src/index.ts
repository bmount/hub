import { Hono } from "hono";
import type { Env } from "./env";
import { handleApi } from "./http/api";
import { registerAllVerbs } from "./verbs/index";
import { authLinkPage, consumeLinkPage, loginPage, loginPostPage } from "./http/login";
import { googleCallbackPage, googleStartPage } from "./http/googleLogin";
import { privacyPage, termsPage } from "./http/privacy";
import { adminModelsPage } from "./http/adminModels";
import { adminOrgsPage } from "./http/adminOrgs";
import { mePage } from "./http/me";
import { adminAgentsPage } from "./http/adminAgents";
import { handleEmail } from "./mail/inbound";
import { introspect } from "./http/internal";
import { internalBacklinks } from "./http/internalBacklinks";
import { forwardGit } from "./http/git";
import { asMetadataPage, protectedResourcePage } from "./http/oauthMeta";
import { authorizePage, consentPage, consentPost } from "./http/oauthAuthorize";
import { tokenEndpoint } from "./oauth/token";
import { registerEndpoint } from "./http/oauthRegister";
import { handleMcp } from "./mcp/handler";
import { channelPage, channelPost, channelsPage, inboxPage, permalinkPage, threadPage } from "./http/chatPages";
import { acceptInvitePage, archivePage, homePage, invitePage, notFoundPage, sessionsPage } from "./http/pages";

export { Conversation } from "./chat/conversationDO";
export { Inbox } from "./chat/inboxDO";

registerAllVerbs();

const app = new Hono<{ Bindings: Env }>();

// Git smart HTTP on tenant hosts belongs to Ardi (integration spec 3); everything else stays here.
app.use("*", async (c, next) => {
  const forwarded = await forwardGit(c.req.raw, c.env);
  if (forwarded) return forwarded;
  await next();
});

/** Hono types its execution context separately from workers-types; at runtime it is the Worker's own. */
const workerCtx = (c: unknown): ExecutionContext => c as ExecutionContext;

app.get("/healthz", (c) => c.text("ok"));
app.get("/privacy", () => privacyPage());
app.get("/terms", () => termsPage());
app.post("/api/*", (c) => handleApi(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
app.get("/", (c) => homePage(c.req.raw, c.env));
app.get("/archive", (c) => archivePage(c.req.raw, c.env));
app.get("/invite/:token", (c) => invitePage(c.req.raw, c.env));
app.post("/invite/:token", (c) => acceptInvitePage(c.req.raw, c.env));
app.get("/login", (c) => loginPage(c.req.raw, c.env));
app.post("/login", (c) => loginPostPage(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
app.get("/login/google", (c) => googleStartPage(c.req.raw, c.env));
app.get("/login/google/callback", (c) => googleCallbackPage(c.req.raw, c.env));
app.get("/auth/:token", (c) => authLinkPage(c.req.raw, c.env));
app.post("/auth/:token", (c) => consumeLinkPage(c.req.raw, c.env));
app.get("/me", (c) => mePage(c.req.raw, c.env));
app.get("/admin/agents", (c) => adminAgentsPage(c.req.raw, c.env));
app.get("/admin/models", (c) => adminModelsPage(c.req.raw, c.env));
app.get("/admin/orgs", (c) => adminOrgsPage(c.req.raw, c.env));
app.get("/me/sessions", (c) => sessionsPage(c.req.raw, c.env));
app.get("/c", (c) => channelsPage(c.req.raw, c.env));
app.get("/c/:slug", (c) => channelPage(c.req.raw, c.env, c.req.param("slug")));
app.post("/c/:slug", (c) => channelPost(c.req.raw, c.env, c.req.param("slug"), null));
app.get("/c/:slug/t/:seq", (c) => threadPage(c.req.raw, c.env, c.req.param("slug"), c.req.param("seq")));
app.post("/c/:slug/t/:seq", (c) => channelPost(c.req.raw, c.env, c.req.param("slug"), c.req.param("seq")));
app.get("/m/:msg", (c) => permalinkPage(c.req.raw, c.env, c.req.param("msg")));
app.get("/inbox", (c) => inboxPage(c.req.raw, c.env));
app.post("/internal/introspect", (c) => introspect(c.req.raw, c.env));
app.post("/internal/backlinks", (c) => internalBacklinks(c.req.raw, c.env));
app.get("/.well-known/oauth-authorization-server", (c) => asMetadataPage(c.req.raw, c.env));
app.get("/.well-known/oauth-protected-resource", (c) => protectedResourcePage(c.req.raw, c.env));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => protectedResourcePage(c.req.raw, c.env));
app.post("/oauth/register", (c) => registerEndpoint(c.req.raw, c.env, workerCtx(c.executionCtx)));
app.get("/oauth/authorize", (c) => authorizePage(c.req.raw, c.env));
app.post("/oauth/token", (c) => tokenEndpoint(c.req.raw, c.env, workerCtx(c.executionCtx)));
app.post("/oauth/revoke", (c) => tokenEndpoint(c.req.raw, c.env, workerCtx(c.executionCtx)));
app.get("/oauth/consent/:id", (c) => consentPage(c.req.raw, c.env));
app.post("/oauth/consent/:id", (c) => consentPost(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p)));
app.notFound(() => notFoundPage());

export default { fetch: app.fetch, email: handleEmail } satisfies ExportedHandler<Env>;
