// Only these exact additive telemetry bindings (and the hub synthetic browser approved in #217) are allowed automatically.
export function compatibleRuntime(oldRuntime, freshRuntime, worker) {
  const normalize = runtime => JSON.stringify(Object.fromEntries(Object.entries(runtime).sort(([a], [b]) => a.localeCompare(b))));
  if (normalize(oldRuntime) === normalize(freshRuntime)) return true;
  const addition = worker === "pimwell-tail" ? "nodejs_compat" : worker === "pimwell-hub" ? "global_fetch_strictly_public" : null;
  if (!addition) return false;
  const flags = oldRuntime.compatibility_flags ?? [];
  if (flags.includes(addition)) return false;
  return normalize({ ...oldRuntime, compatibility_flags: [...flags, addition] }) === normalize(freshRuntime);
}
export function compatibleBindings(oldBindings, freshBindings, worker) {
  const additive = b => (worker === "pimwell-hub" && b.name === "SYNTHETIC_BROWSER" && b.type === "browser" && (b.version === undefined || b.version === 2) && Object.keys(b).every(k => ["name", "type", "version"].includes(k))) ||
    (b.name === "WORKER_VERSION" && b.type === "version_metadata" && Object.keys(b).every(k => k === "name" || k === "type")) ||
    (b.name === "PERF" && b.type === "analytics_engine" && b.dataset === "pimwell_perf" && Object.keys(b).every(k => ["name", "type", "dataset"].includes(k))) ||
    (["PERF_TENANT_KEY", "PERF_ANALYTICS_TOKEN"].includes(b.name) && b.type === "secret_text" && Object.keys(b).every(k => k === "name" || k === "type"));
  const normalize = bindings => JSON.stringify([...bindings].sort((a, b) => a.name.localeCompare(b.name)));
  const newBindings = freshBindings.filter(b => !oldBindings.some(old => old.name === b.name));
  return newBindings.every(additive) && normalize(oldBindings) === normalize(freshBindings.filter(b => !newBindings.includes(b)));
}
