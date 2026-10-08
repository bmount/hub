// "What do you want to do?": words become a link or one prefilled action. The model sees only the catalog and the
// person's words; names are matched afterwards against what the person can see.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential } from "../src/models/store";
import { createProject } from "../src/db/projects";
import { parseIntent } from "../src/intent/catalog";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
afterEach(() => setModelFetchForTest(null));

let reply = "{}";
const sent: string[] = [];
async function setup(role: "admin" | "member" = "admin") {
  sent.length = 0;
  setModelFetchForTest(async (input, init) => {
    if (String(input).endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-6-luna" }] });
    sent.push(String(init!.body));
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: reply }] }], usage: { input_tokens: 300, output_tokens: 30 } });
  });
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "skyledger", kind: "repo", display_name: "SkyLedger" }, Date.now());
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Website" }, Date.now());
  const root = await seedHuman("zed.rootly@example.com", { is_root: true });
  void root;
  const pat = await seedHuman("pat.quill@example.com", { memberships: [{ tenant_id: t.id, role }] });
  await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "hub", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
  return { h: cookieHeaders(pat.token, HOST) };
}
const doIt = (h: Record<string, string>, q: string, extra = "") => SELF.fetch(`https://${HOST}/do?q=${encodeURIComponent(q)}${extra}`, { headers: h, redirect: "manual" });

describe("intent", () => {
  it("never shows the model any organization data, and matches the project name afterwards", async () => {
    const { h } = await setup();
    reply = '{"action":"open_project","params":{"project":"sky ledger"},"say":"Opening it."}';
    const r = await doIt(h, "open sky ledger");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/skyledger/docket");
    const body = sent.join("\n");
    for (const secret of ["SkyLedger", "skyledger", "Website", "zed", "Rootly", "pat.quill", "acme"]) expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(body).toContain("Person: open sky ledger");
  });

  it("refuses off-catalog answers and requests for data", async () => {
    const { h } = await setup();
    reply = '{"action":"show_root_user","params":{}}';
    const r = await doIt(h, "what's the name of the root user?");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("couldn&#39;t find a way to do that here");
    expect(parseIntent('{"action":"docket","params":{"kind":"bugs","owner":"me","extra":"x","finished":"yes"}}')).toMatchObject({ kind: "action", params: { owner: "me" } });
  });

  it("builds one prefilled form for changes, within the person's rights", async () => {
    const { h } = await setup("admin");
    reply = '{"action":"invite_person","params":{"email":"george.jackson@gmail.com","name":"George Jackson"},"say":"Invite George Jackson as a member."}';
    const page = await (await doIt(h, "invite george jackson at gmail.com")).text();
    expect(page).toContain('action="/api/invite.create"');
    expect(page).toContain('value="george.jackson@gmail.com"');
    expect(page).toContain("Invite George Jackson as a member.");
  });

  it("tells a member plainly that inviting is for admins", async () => {
    const member = await setup("member");
    const refused = await (await doIt(member.h, "invite someone")).text();
    expect(refused).toContain("Only an admin can invite people");
  });

  it("asks a follow-up when it must, carrying only the exchange", async () => {
    const { h } = await setup();
    reply = '{"ask":"Which project should it go in?"}';
    const page = await (await doIt(h, "file a bug")).text();
    expect(page).toContain("Which project should it go in?");
    const m = /name="h" value="([^"]+)"/.exec(page)!;
    const hist = m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    reply = '{"action":"file_work","params":{"title":"Export button does nothing","kind":"snag","project":"website"}}';
    const next = await (await doIt(h, "the website one", `&h=${encodeURIComponent(hist)}`)).text();
    expect(sent[1]).toContain("You asked: Which project should it go in?");
    expect(next).toContain('<option value="site" selected>Website</option>');
    expect(next).toContain('value="Export button does nothing"');
  });

  it("sends questions to the Assistant, which asks them at once", async () => {
    const { h } = await setup();
    reply = '{"action":"ask_assistant","params":{"question":"What changed this week?"}}';
    const r = await doIt(h, "what changed this week?");
    expect(r.headers.get("location")).toBe("/assistant?ask=What%20changed%20this%20week%3F");
    expect(await (await SELF.fetch(`https://${HOST}${r.headers.get("location")}`, { headers: h })).text()).toContain('data-autoask="What changed this week?"');
  });

  it("answers list questions with the person's own read verbs, results never shown to the model", async () => {
    const { h } = await setup();
    reply = '{"action":"show","params":{"what":"projects"},"say":"Your projects."}';
    const page = await (await doIt(h, "what are my projects?")).text();
    expect(page).toContain('href="/skyledger/docket">SkyLedger</a>');
    expect(page).toContain('href="/site/docket">Website</a>');
    await SELF.fetch(`https://${HOST}/api/work.create`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ project: "site", kind: "snag", title: "Export button does nothing", owner: "me" }) });
    reply = '{"action":"show","params":{"what":"my_work"}}';
    const mine = await (await doIt(h, "my latest issues")).text();
    expect(mine).toContain('href="/site/w/1">site#1</a> Export button does nothing');
    expect(sent.join("\n")).not.toContain("Export button");
    expect(sent.join("\n").toLowerCase()).not.toContain("skyledger");
  });
});
