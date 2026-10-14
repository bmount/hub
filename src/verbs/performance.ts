import { defineVerb } from "./table";
import { reqString } from "./params";
import { findSite } from "./sites";
import { performanceSelection, readPerformance, PerformanceUnavailable } from "../apps/performance";
import { badRequest, HubError } from "../errors";
import { DATA_NOTE } from "../mcp/render";

const descriptions = {
  summary: "Top routes and interactions by total waiting time in a 1, 24 or 168 hour window.",
  route: "One route or interaction: weighted percentiles, breakdown, histogram, colo, version and cold-start splits.",
  compare: "Two production versions side by side, by route, with weighted percentiles and total waiting time.",
  exemplar: "A slow request waterfall from the selected route or interaction's five slowest exemplars. Request IDs never grant access.",
  statements: "Slowest D1 statements for a route or interaction, with fingerprints, versions and recorded call sites.",
};
export const performanceVerbs = Object.entries(descriptions).map(([operation, description]) => defineVerb({
  name: `perf.${operation}`, kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: `${description} All organizations on this site by default; only_my_org restricts the population. Same owning organization membership, active code project and registered Worker boundaries as the Performance view. Durations are milliseconds; counts are sample-weighted.`,
  mcp: { scope: "read", destructive: false, title: `Performance ${operation}`, input: {
    type: "object", properties: {
      site: { type: "string", description: "Registered site name; discover with site_list." },
      only_my_org: { type: "boolean", default: false, description: "Only the viewer’s organization; default includes every organization and unscoped traffic on this site." },
      hours: { type: "integer", enum: [1, 24, 168], default: 24 },
      ...(operation !== "summary" && operation !== "compare" ? { kind: { type: "string", enum: ["routes", "interactions", "verbs", "tools", "spinners"], default: "routes" }, selected: { type: "string", description: "Normalized route or interaction label." } } : {}),
      ...(operation !== "compare" ? { version: { type: "string" } } : { version: { type: "string" }, previous: { type: "string" } }),
      ...(operation === "exemplar" ? { request: { type: "string", description: "Optional exemplar request ID; defaults to slowest." } } : {}),
    }, required: ["site", ...(operation === "compare" ? ["version", "previous"] : operation === "summary" ? [] : ["selected"])], additionalProperties: false,
  }, render: r => `${DATA_NOTE}\n\n${JSON.stringify(r, null, 2)}` },
  parse: i => {
    const site = reqString(i, "site", { max: 253 }).toLowerCase();
    if (operation !== "summary" && operation !== "compare") reqString(i, "selected", { max: 200 });
    if (operation === "compare") { reqString(i, "version", { max: 64 }); reqString(i, "previous", { max: 64 }); }
    if (i.hours !== undefined && (typeof i.hours !== "number" || ![1, 24, 168].includes(i.hours))) throw badRequest("invalid performance range");
    if (i.kind !== undefined && !["routes", "interactions", "verbs", "tools", "spinners"].includes(String(i.kind))) throw badRequest("invalid performance kind");
    for (const key of ["kind", "selected", "version", "previous", "request"]) if (i[key] !== undefined && typeof i[key] !== "string") throw badRequest(`${key} must be a string`);
    if (i.only_my_org !== undefined && typeof i.only_my_org !== "boolean") throw badRequest("only_my_org must be a boolean");
    const params = new URLSearchParams();
    if (i.only_my_org !== undefined) params.set("only_my_org", String(i.only_my_org));
    for (const key of ["hours", "kind", "selected", "version", "previous", "request"]) if (i[key] !== undefined) params.set(key, String(i[key]));
    if (operation === "compare") params.set("kind", "deploys");
    if (operation === "summary") { params.set("kind", "routes"); params.delete("selected"); }
    const selection = performanceSelection(params);
    return { site, selection };
  },
  run: async (ctx, p) => {
    const site = await findSite(ctx, p.site);
    try {
      const data = await readPerformance(ctx, site, p.selection, operation !== "summary" && operation !== "compare");
      const context = { site: site.name, only_my_org: !!p.selection.onlyMyOrg, hours: p.selection.hours, kind: p.selection.kind, selected: p.selection.selected, version: p.selection.version, units: "milliseconds", note: "Sample-weighted observations; missing data is not zero latency. Breakdown and call sites require recorded telemetry. Interaction origin splits use up to 2000 recent points; statements use slow exemplars." };
      if (operation === "summary") {
        const interactions = await readPerformance(ctx, site, { ...p.selection, kind: "interactions", selected: "" });
        return { ...context, routes: data.overview, interactions: interactions.overview };
      }
      if (operation === "compare") return { ...context, previous: p.selection.previous, comparison: data.comparison };
      if (operation === "exemplar") return { ...context, exemplars: data.exemplars, waterfall: data.waterfall };
      if (operation === "statements") return { ...context, statements: data.sql };
      return { ...context, metrics: data.overview.filter(r => r.label === p.selection.selected), breakdown: data.breakdown.filter(r => r.label === p.selection.selected), browser: data.browser.filter(r => r.label === p.selection.selected), histogram: data.histogram, splits: data.splits, exemplars: data.exemplars };
    } catch (e) {
      if (e instanceof PerformanceUnavailable) throw new HubError(503, "performance_unavailable", e.message);
      throw e;
    }
  },
}));
