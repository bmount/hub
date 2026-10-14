/** p95 milliseconds. Missing observations are unknown, never a pass. */
export const BUDGETS = [
  { id: "page", ms: 300, where: "blob7 = 'request' AND blob11 = 'cookie' AND blob9 = 'GET' AND blob8 NOT LIKE '/api/%' AND blob8 != '/:repo.git/*'" },
  { id: "pane", ms: 500, where: "blob7 = 'client' AND blob9 = 'paint' AND blob14 = 'pane.swap'" },
  { id: "form", ms: 800, where: "blob7 = 'client' AND blob9 = 'paint' AND blob14 = 'form.submit'" },
  { id: "spinner", ms: 1000, where: "blob7 = 'client' AND blob9 = 'spinner'" },
  { id: "mcp", ms: 400, where: "blob7 = 'span' AND blob14 LIKE 'mcp.%' AND substring(blob14,5) NOT LIKE '%.%' AND double14 = 1" },
  { id: "git", ms: 1000, where: "blob7 = 'synthetic' AND blob9 = 'journey' AND blob8 = 'git-ls-remote'" },
] as const;
export const REGRESSION_RATIO = 1.25;
export const MIN_REGRESSION_SAMPLES = 200;
