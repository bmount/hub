// Mail in the workbench: the inbox as the list, a message with the work filed from it in the inspector.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

async function world() {
  const t = await seedTenant("acme");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const insert = (id: string, verdict: string, subject: string) => env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, project_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded)
    VALUES (?, ?, ?, ?, 'pat@example.com', 'acme.site@pimwell.test', ?, ?, 100, ?, 'Prices look wrong for metformin.', '[]', 1)`).bind(id, t.id, p.id, pat.identity.id, subject, Date.now(), verdict).run();
  await insert("M1", "admitted", "Prices look wrong");
  await insert("M2", "quarantined", "Held one");
  const get = (path: string, token: string) => SELF.fetch(`https://${HOST}${path}`, { headers: cookieHeaders(token, HOST) });
  return { pat, ada, get };
}

describe("mail in the workbench", () => {
  it("lists admitted mail for members and held mail for admins too, with the addresses beside it", async () => {
    const w = await world();
    const member = await (await w.get("/mail", w.pat.token)).text();
    expect(member).toContain('data-href="/mail/M1"');
    expect(member).not.toContain("/mail/M2");
    expect(member).toContain("<code>acme.site@pimwell.test</code>");
    expect(await (await w.get("/mail", w.ada.token)).text()).toContain('<span class="pill">held</span>');
    expect((await w.get("/mail/M2", w.pat.token)).status).toBe(404);
  });

  it("shows a message beside the list, with Propose work and the work already filed from it", async () => {
    const w = await world();
    await apiPost(HOST, "work.create", { project: "site", kind: "snag", title: "Metformin price wrong", source_kind: "mail", source_ref: "M1", source_quote: "Prices look wrong" }, cookieHeaders(w.pat.token, HOST));
    const page = await (await w.get("/mail/M1", w.pat.token)).text();
    expect(page).toContain("<h1>Prices look wrong</h1>");
    expect(page).toContain('action="/api/mail.propose_work"');
    expect(page).toContain("<h2>Filed from this</h2>");
    expect(page).toContain('href="/site/w/1">Metformin price wrong</a>');
    expect(page).toMatch(/data-key="mail:M1:admitted:1"/);
  });
});
