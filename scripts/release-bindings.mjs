// Only these exact additive, content-free telemetry bindings are allowed automatically.
export function compatibleRuntime(oldRuntime, freshRuntime, worker) {
  if (JSON.stringify(oldRuntime) === JSON.stringify(freshRuntime)) return true;
  if (worker !== "pimwell-tail") return false;
  const flags = oldRuntime.compatibility_flags ?? [];
  if (flags.includes("nodejs_compat")) return false;
  return JSON.stringify({ ...oldRuntime, compatibility_flags: [...flags, "nodejs_compat"] }) === JSON.stringify(freshRuntime);
}
export function compatibleBindings(oldBindings, freshBindings) {
  const additive = b => (b.name === "WORKER_VERSION" && b.type === "version_metadata" && Object.keys(b).every(k => k === "name" || k === "type")) ||
    (b.name === "PERF" && b.type === "analytics_engine" && b.dataset === "pimwell_perf" && Object.keys(b).every(k => ["name", "type", "dataset"].includes(k))) ||
    (b.name === "PERF_TENANT_KEY" && b.type === "secret_text" && Object.keys(b).every(k => k === "name" || k === "type"));
  const normalize = bindings => JSON.stringify([...bindings].sort((a, b) => a.name.localeCompare(b.name)));
  const newBindings = freshBindings.filter(b => !oldBindings.some(old => old.name === b.name));
  return newBindings.every(additive) && normalize(oldBindings) === normalize(freshBindings.filter(b => !newBindings.includes(b)));
}
