import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { ASSETS } from "../src/assets";
import { breadcrumb, emptyState, esc, formRow, HTML_CSP, htmlResponse, inspectorSection, kitList, kitTable, kitTabs, kitTree, page, statusChip, toolbar, workbench } from "../src/html";

describe("workbench kit", () => {
  it("keeps page timestamps in the shared helper", () => {
    // @ts-expect-error Vite transforms raw page imports in the Workers test build.
    const pages = import.meta.glob("../src/http/*.ts", {query:"?raw", import:"default", eager:true});
    for (const [path, source] of Object.entries(pages)) {
      expect(source, path).not.toMatch(/\.toISOString\(|\.toUTCString\(|\.toLocale(?:Date|Time)?String\(/);
    }
  });
  it("renders selectable table/list rows with native links and scoped headings", () => {
    const table = kitTable('Work <items>', [{label: 'Title', className: 'hide-s'}], [
      {href: '/sample/w/1?owner=me&kind=wish', selected: true, cells: [{html: '<a href="/sample/w/1">One</a>'}]},
      {href: '/sample/w/2', cells: [{html: 'Two', className: 'ref'}]},
    ]);
    expect(table).toContain('aria-label="Work &lt;items&gt;"');
    expect(table).toContain('<th scope="col" class="hide-s">Title</th>');
    expect(table).toContain('data-href="/sample/w/1?owner=me&amp;kind=wish" aria-selected="true"');
    expect(table).toContain('data-href="/sample/w/2" aria-selected="false"');
    expect(table).toContain('<td class="ref">Two</td>');
    expect(kitList('Work', [{html: '<a href="/w/1">One</a>', href: '/w/1', selected: true}])).toContain('aria-selected="true"');
  });

  it("renders native collapsible trees with zero counts and current links", () => {
    const tree = kitTree('Project <resources>', [{label: 'Wiki', href: '/wiki', count: 0, expanded: true, children: [
      {label: '<Handbook>', href: '/wiki/handbook', current: true},
      {label: 'Archive', href: '/wiki/archive', children: []},
    ]}]);
    expect(tree).toContain('aria-label="Project &lt;resources&gt;"');
    expect(tree).toContain('<details open><summary><span class="wb-chevron" aria-hidden="true">›</span><a href="/wiki">Wiki</a></summary>');
    expect(tree).toContain('<a href="/wiki/handbook" aria-current="page">&lt;Handbook&gt;</a>');
    expect(tree).toContain('<details><summary><span class="wb-chevron" aria-hidden="true">›</span><a href="/wiki/archive">Archive</a></summary>');
  });

  it("renders URL tabs, breadcrumb and labeled action/filter groups", () => {
    const links = [{label: 'Docket & work', href: '/docket', current: true}];
    expect(kitTabs('Views', links)).toContain('<nav class="wb-tabs" aria-label="Views"><a href="/docket" aria-current="page">Docket &amp; work</a>');
    expect(breadcrumb(links)).toContain('aria-label="Breadcrumb"><ol><li>');
    expect(toolbar('Work <actions>', '<button>File</button>', '<form>Filters</form>')).toContain('aria-label="Work &lt;actions&gt;"><div class="wb-actions"><button>File</button></div><div class="wb-filters"><form>Filters</form>');
    expect(toolbar('Actions', '')).not.toContain('wb-filters');
  });

  it("renders text-labeled state/kind chips, inline edit sections and form labels", () => {
    expect(statusChip('Under way', 'doing')).toBe('<span class="wb-chip wb-state wb-tone-doing">Under way</span>');
    expect(statusChip('<Snag>', 'snag')).toContain('&lt;Snag&gt;');
    const section = inspectorSection('Details <1>', [{label: 'Title', html: 'Item', editHtml: '<form><input name="title"></form>'}]);
    expect(section).toContain('<h2>Details &lt;1&gt;</h2><dl><dt>Title</dt><dd><details class="wb-inline-edit"><summary aria-label="Change Title">Item');
    expect(formRow('title', 'Title <required>', '<input id="title" aria-describedby="title-hint">', 'Be clear & brief')).toContain('<label for="title">Title &lt;required&gt;</label><div><input id="title" aria-describedby="title-hint"><p class="wb-hint" id="title-hint">Be clear &amp; brief</p>');
  });

  it("explains empty content and an add action, escapes text and rejects executable links", () => {
    const empty = emptyState('<No work>', 'Open items belong here & can be filed.', {label: '+ File', href: '/new'});
    expect(empty).toContain('<h2>&lt;No work&gt;</h2><p>Open items belong here &amp; can be filed.</p><a href="/new">+ File</a>');
    for (const href of ['javascript:alert(1)', 'data:text/html,x', '//evil.test', 'relative']) {
      expect(kitTabs('Views', [{label: '<script>', href}])).toContain('href="#">&lt;script&gt;</a>');
    }
    expect(breadcrumb([{label: 'Quote', href: '/x?name="&'}])).toContain('href="/x?name=&quot;&amp;"');
  });
});

describe("html", () => {
  it.each(["/", "/login", "/signed-out", "/privacy", "/terms", "/invite/invalid", "/auth/invalid", "/unknown"])('protects the HTML route %s without inline scripts', async path => {
    const res = await SELF.fetch(`https://pimwell.test${path}`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(HTML_CSP);
    expect(await res.text()).not.toMatch(/<script(?![^>]*\bsrc=)|\son(?:click|submit|change)=|javascript:/i);
  });

  it("serves every script as a current, immutable, nosniff static asset", async () => {
    for (const asset of Object.values(ASSETS)) {
      const res = await SELF.fetch(`https://pimwell.test${asset.path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(asset.type);
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe(asset.body);
      if (asset.type.startsWith("text/javascript")) expect(() => new Function(asset.body)).not.toThrow();
    }
    expect((await SELF.fetch("https://pimwell.test/assets/assistant.old.js")).status).toBe(404);
  });

  it("escapes the five characters", () => {
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  it("wraps a body in a document with the escaped title", () => {
    const doc = page("Acme <1>", "<p>hi</p>");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>Acme &lt;1&gt;</title>");
    expect(doc).toContain("<p>hi</p>");
  });

  it("collapses unselected summaries and supplies shared inspector controls", () => {
    const shell = {brandHref: "/", org: null, nav: [], tip: "", me: {name: "Pat", email: "pat@example.test", role: "member", href: "/me"}};
    const panes = {list: "Rows", listKey: "rows", inspector: "Summary"};
    const closed = workbench("Rows", panes, shell);
    expect(closed).toContain('<main class="panes one">');
    expect(closed).not.toContain('>Summary</section>');
    const opened = workbench("Row", {...panes, inspectorKey: "row:1"}, shell);
    expect(opened).toContain('<main class="panes">');
    expect(opened).toContain('aria-label="Inspector width"');
    expect(opened).toContain('data-close-inspector');
    expect(workbench("Create", {...panes, focus: "inspector"}, shell)).toContain('<main class="panes">');
  });

  it("escapes the account address and role in the single top-bar display", () => {
    const doc = page("Account", "", {
      brandHref: "/", org: null, nav: [], tip: "",
      me: { name: "<Name>", email: 'a"<b>@example.com', role: "<role>", href: "/me" },
    });
    expect(doc).toContain('<code id="header-email">a&quot;&lt;b&gt;@example.com</code> (&lt;role&gt;)</a>');
    expect(doc).not.toContain('class="account-details"');
    expect(doc).not.toContain('<Name>');
    expect(doc).not.toContain("<role>");
  });

  it("returns an html response with no-store", () => {
    const res = htmlResponse("<p>x</p>", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(HTML_CSP);
    for (const rule of ["default-src 'self'", "script-src 'self'", "script-src-attr 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      expect(HTML_CSP.split("; ")).toContain(rule);
    }
    expect(HTML_CSP).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|https:|data:|blob:)/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
