import { situationsPage } from "./http/situationPage";
import { statusPage } from "./http/statusPage";
import { boardPage } from "./http/boardPage";
import { reviewsPage } from "./http/reviewPages";
import { syncAll } from "./code/sync";
import { codePage, filesPage } from "./http/codePages";
import { searchPage } from "./http/searchPage";
import { assistantChat, assistantPage } from "./http/assistantPages";
import { onboardBody } from "./skills/onboard";
import { adminAppsPage, appsPage } from "./http/appsPages";
import { WorkerEntrypoint } from "cloudflare:workers";
import { ingest } from "./apps/ingest";
import { usagePage } from "./http/usagePages";
import { assetResponse } from "./assets";
import { page } from "./html";
import { Hono } from "hono";
import type { Env } from "./env";
import { meteredD1, serverTiming, type Meter } from "./perf";
import { emit, note, requestLine } from "./log";
import { handleApi } from "./http/api";
import { registerAllVerbs } from "./verbs/index";
import { authLinkPage, consumeLinkPage, loginPage, loginPostPage } from "./http/login";
import { googleCallbackPage, googleStartPage } from "./http/googleLogin";
import { privacyPage, termsPage } from "./http/privacy";
import { adminModelsPage } from "./http/adminModels";
import { adminOrgsPage } from "./http/adminOrgs";
import { mailListPage, mailReadPage } from "./http/mailPages";
import { attentionPage, docketPage, jumpPage, newWorkPage, orgDocketPage, plannedPage, workItemPage } from "./http/workPages";
import { projectPage } from "./http/orgPages";
import { peoplePage } from "./http/peoplePages";
import { skillsPage } from "./http/skillsPages";
import { playgroundCall, playgroundPage } from "./http/playground";
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
// Performance is first-class (overnight plan task 7): every hub response says how long the Worker spent on it.
// Workers' clock only advances across I/O, so this is wall time spent waiting on D1, KV and other services.
app.use("*", async (c, next) => {
  const started = Date.now();
  const meter: Meter = { trips: 0, statements: 0, ms: 0 };
  // This request's own copy of the bindings, with D1 metered; other requests are unaffected.
  c.env = { ...c.env, HUB_DB: meteredD1(c.env.HUB_DB, meter) };
  await next();
  if (c.error) {
    const e = c.error;
    note(c.req.raw, { error: { reason: "exception", detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } });
    console.error(JSON.stringify({ msg: "exception", path: new URL(c.req.url).pathname, ray: c.req.header("cf-ray") ?? null, stack: e instanceof Error ? e.stack ?? null : null }));
  }
  if (c.res && !c.res.headers.has("server-timing")) {
    try { c.res.headers.set("server-timing", serverTiming(Date.now() - started, meter)); } catch { /* immutable response: leave it */ }
  }
  // Logging must never break a response.
  try { emit(requestLine(c.req.raw, c.res?.status ?? 500, Date.now() - started, meter)); } catch { /* ignore */ }
});

app.use("*", async (c, next) => {
  const forwarded = await forwardGit(c.req.raw, c.env);
  if (forwarded) return forwarded;
  await next();
});

/** Hono types its execution context separately from workers-types; at runtime it is the Worker's own. */
const workerCtx = (c: unknown): ExecutionContext => c as ExecutionContext;

app.get("/healthz", (c) => c.text("ok"));
// What an agent reads when its person says "set up pimwell.com" (skill: onboard). Public: it holds no secrets.
app.get("/setup", (c) => new Response(`# Set up Pimwell\n\n${onboardBody(c.env.HUB_DOMAIN)}\n`, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } }));
app.get("/assets/:file", (c) => assetResponse(new URL(c.req.url).pathname));
app.get("/signed-out", (c) => c.html(page("Signed out", `<h1>You're signed out</h1><p><a href="https://${c.env.HUB_DOMAIN}/login">Sign in again</a></p>`)));
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
app.get("/mail", (c) => mailListPage(c.req.raw, c.env));
app.get("/mail/:id", (c) => mailReadPage(c.req.raw, c.env, c.req.param("id")));
app.get("/docket", (c) => orgDocketPage(c.req.raw, c.env));
app.get("/new", (c) => newWorkPage(c.req.raw, c.env));
app.get("/attention", (c) => attentionPage(c.req.raw, c.env));
app.get("/usage", (c) => usagePage(c.req.raw, c.env));
app.get("/apps", (c) => appsPage(c.req.raw, c.env));
app.get("/admin/apps", (c) => adminAppsPage(c.req.raw, c.env));
app.get("/jump", (c) => jumpPage(c.req.raw, c.env));
app.get("/search", (c) => searchPage(c.req.raw, c.env));
app.get("/planned", (c) => plannedPage(c.req.raw, c.env, null));
app.get("/planned/:area", (c) => plannedPage(c.req.raw, c.env, c.req.param("area")));
app.get("/people", (c) => peoplePage(c.req.raw, c.env));
app.get("/people/:who", (c) => peoplePage(c.req.raw, c.env, c.req.param("who")));
app.get("/skills", (c) => skillsPage(c.req.raw, c.env));
app.get("/assistant", (c) => assistantPage(c.req.raw, c.env));
app.post("/assistant/chat", (c) => assistantChat(c.req.raw, c.env));
app.get("/assistant/tools", (c) => playgroundPage(c.req.raw, c.env));
app.get("/playground", (c) => c.redirect("/assistant/tools", 301));
app.post("/playground/call", (c) => playgroundCall(c.req.raw, c.env));
app.get("/skills/:name", (c) => skillsPage(c.req.raw, c.env, c.req.param("name")));
app.get("/:project/docket", (c) => docketPage(c.req.raw, c.env, c.req.param("project")));
app.get("/:project/code", (c) => codePage(c.req.raw, c.env, c.req.param("project")));
app.get("/reviews", (c) => reviewsPage(c.req.raw, c.env, null, null));
app.get("/situations", (c) => situationsPage(c.req.raw, c.env));
app.get("/board", (c) => boardPage(c.req.raw, c.env, null));
app.get("/:project/board", (c) => boardPage(c.req.raw, c.env, c.req.param("project")));
app.get("/:project/status", (c) => statusPage(c.req.raw, c.env, c.req.param("project")));
app.get("/:project/reviews", (c) => reviewsPage(c.req.raw, c.env, c.req.param("project"), null));
app.get("/:project/reviews/:n", (c) => reviewsPage(c.req.raw, c.env, c.req.param("project"), c.req.param("n")));
app.get("/:project/files", (c) => filesPage(c.req.raw, c.env, c.req.param("project")));
app.get("/:project/w/:n", (c) => workItemPage(c.req.raw, c.env, c.req.param("project"), c.req.param("n")));
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

// Last: a project's own page, /<project>. Every named page above wins first.
app.get("/:project", (c) => projectPage(c.req.raw, c.env, c.req.param("project")));

export default {
  fetch: app.fetch,
  email: handleEmail,
  // Every five minutes: push sync from the git host (src/code/sync.ts).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncAll(env, Date.now()).then((r) => console.log(JSON.stringify({ msg: "push sync", ...r })), (e) => console.error(JSON.stringify({ msg: "push sync failed", error: e instanceof Error ? e.message : "error" }))));
  },
} satisfies ExportedHandler<Env>;

/** App telemetry from pimwell-tail (src/apps/ingest.ts). An RPC entrypoint: callable only through a service binding. */
export class Ingest extends WorkerEntrypoint<Env> {
  async events(batch: unknown): Promise<{ accepted: number; dropped: number }> {
    return ingest(this.env, batch, Date.now());
  }
}
