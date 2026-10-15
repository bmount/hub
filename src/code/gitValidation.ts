import type { ArtifactsRest } from "./artifactsRest";
import { packet, parseAdvertisedRefs, reportOutcomes, ZERO_OID, type RefUpdate } from "./gitProtocol";
import { HubError } from "../errors";

function stream(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const part of parts) c.enqueue(part);c.close(); } });
}

/** Protocol v2 filters at the server: never download a lifetime-sized advertisement. */
export async function validationRefs(api: ArtifactsRest, namespace: string, repo: string, prefixes: string[]): Promise<Map<string, string>> {
  if (!prefixes.length) return new Map();
  const request = new Request(`https://git.internal/${repo}.git/git-upload-pack`, { method: "POST", headers: { "git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request" } });
  const response = await api.git(namespace, repo, "git-upload-pack", request,
    stream([packet("command=ls-refs\n"), new TextEncoder().encode("0001"), packet("peel\n"), ...prefixes.map(ref => packet(`ref-prefix ${ref}\n`)), new TextEncoder().encode("0000")]), false, false);
  if (!response.ok) throw new HubError(502, "unavailable", "Git refs unavailable");
  return new Map(parseAdvertisedRefs(new Uint8Array(await response.arrayBuffer())).map(ref => [ref.name, ref.target]));
}

export function stageRefs(id: string, updates: RefUpdate[]): RefUpdate[] {
  return updates.filter(update => update.newOid !== ZERO_OID).map((update, index) => ({ oldOid: ZERO_OID, newOid: update.newOid, ref: `refs/tags/pimwell-stage-${id}/${index}` }));
}

/** Reconcile only touched canonical refs, then discard this attempt's private roots.
 * Canonical names are also the cache's bounded mirror (including its initial fork).
 * Mirror CAS failures from concurrent reconciliation retain the private roots; cleanup retries.
 */
export async function settleValidation(api: ArtifactsRest, namespace: string, repo: string, shadow: string, id: string, updates: RefUpdate[]): Promise<void> {
  const staged = stageRefs(id, updates), names = [...new Set(updates.map(u => u.ref))];
  // Read the mirror first. Reading these in parallel could pair an old canonical
  // snapshot with a newer mirror and successfully CAS the mirror backwards.
  const cached = await validationRefs(api, namespace, shadow, [...names, `refs/tags/pimwell-stage-${id}/`]);
  const canonical = await validationRefs(api, namespace, repo, names);
  const commands: RefUpdate[] = [];
  for (const ref of names) {
    const oldOid = cached.get(ref) ?? ZERO_OID, newOid = canonical.get(ref) ?? ZERO_OID;
    if (oldOid !== newOid) commands.push({ ref, oldOid, newOid });
  }
  const removals = staged.flatMap(update => {
    const oldOid = cached.get(update.ref);
    return oldOid ? [{ ref: update.ref, oldOid, newOid: ZERO_OID }] : [];
  });
  if (!commands.length && !removals.length) return;
  // Even a refs-only creation/update needs a valid empty pack.
  const header = new Uint8Array([80,65,67,75,0,0,0,2,0,0,0,0]);
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-1", header));
  const request = new Request(`https://git.internal/${shadow}.git/git-receive-pack`, { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" } });
  const apply = async (changes: RefUpdate[]) => {
    if (!changes.length) return;
    const response = await api.git(namespace, shadow, "git-receive-pack", request, stream([
      ...changes.map((u, i) => packet(`${u.oldOid} ${u.newOid} ${u.ref}${i ? "" : "\0report-status delete-refs"}\n`)), new TextEncoder().encode("0000"), header, checksum,
    ]), true, false);
    if (!response.ok || reportOutcomes(new Uint8Array(await response.arrayBuffer()), changes).some(u => u.outcome !== "ok"))
      throw new HubError(502, "unavailable", "validation ref cleanup incomplete");
  };
  // Artifacts does not advertise atomic receive-pack. Keep private roots until every
  // mirror update is confirmed, including on partial failure or a lost response.
  await apply(commands);
  await apply(removals);
}
