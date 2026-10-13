// Version metadata is platform-supplied identity, not a new resource or capability.
export function compatibleBindings(oldBindings, freshBindings) {
  const metadata = b => b.name === 'WORKER_VERSION' && b.type === 'version_metadata' && Object.keys(b).every(k => k === 'name' || k === 'type');
  const normalize = bindings => JSON.stringify([...bindings].sort((a, b) => a.name.localeCompare(b.name)));
  if (normalize(oldBindings) === normalize(freshBindings)) return true;
  return !oldBindings.some(b => b.name === 'WORKER_VERSION') && freshBindings.filter(metadata).length === 1 &&
    normalize(oldBindings) === normalize(freshBindings.filter(b => !metadata(b)));
}
