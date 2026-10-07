#!/usr/bin/env node
// Production perf smoke (overnight plan 2, N4): times public pages and the /mcp front door, with the server's own view.
// Usage: node scripts/perf-smoke.mjs [org-slug] [runs]   (the org host is optional; no org names live in this repo)
const DOMAIN = process.env.HUB_DOMAIN ?? "pimwell.com";
const [org, runsArg] = process.argv.slice(2);
const RUNS = Number(runsArg ?? 7);
const UA = { "user-agent": "pimwell-perf-smoke/1" };

const checks = [
  ["GET", `https://${DOMAIN}/`],
  ["GET", `https://${DOMAIN}/privacy`],
  ["GET", `https://${DOMAIN}/login`],
  ["GET", `https://${DOMAIN}/.well-known/oauth-authorization-server`],
];
if (org) {
  checks.push(["GET", `https://${org}.${DOMAIN}/`]);
  checks.push(["POST", `https://${org}.${DOMAIN}/mcp`, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "perf-smoke", version: "1" } } })]);
}

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
for (const [method, url, body] of checks) {
  const total = []; let status = 0; let timing = "";
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const res = await fetch(url, { method, body, redirect: "manual", headers: body ? { ...UA, "content-type": "application/json", accept: "application/json, text/event-stream" } : UA });
    await res.arrayBuffer();
    total.push(Math.round(performance.now() - t));
    status = res.status; timing = res.headers.get("server-timing") ?? "";
  }
  console.log(`${method} ${url.replace(/^https:\/\//, "")}  ${status}  median ${pct(total, 0.5)} ms  p90 ${pct(total, 0.9)} ms  | ${timing}`);
}
