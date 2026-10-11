// A commit's files from one shallow Git fetch, for code search. Artifacts has no grep or archive endpoint, and reading
// files one REST call at a time would spend hundreds of API requests per search; one protocol-v2 fetch with deepen 1
// returns the whole snapshot as a single pack.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { packet } from "./gitProtocol";

export type SnapshotFile = { path: string; text: string | null; size: number; binary: boolean };

const enc = new TextEncoder();
const MAX_TEXT_BYTES = 400_000;
const TYPES = ["", "commit", "tree", "blob", "tag"] as const;

/** The upload-pack request body for the tree of one commit, without history. */
export function shallowFetchBody(oid: string): Uint8Array {
  const parts = [packet("command=fetch\n"), enc.encode("0001"), packet("no-progress\n"), packet("deepen 1\n"), packet(`want ${oid}\n`), packet("done\n"), enc.encode("0000")];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The pack bytes from a protocol-v2 fetch response (sideband channel 1 of the packfile section). */
export function packFromResponse(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let inPack = false;
  for (let at = 0; at < bytes.length;) {
    const len = Number.parseInt(new TextDecoder().decode(bytes.subarray(at, at + 4)), 16);
    if (!Number.isInteger(len) || (len > 2 && len < 4) || at + Math.max(len, 4) > bytes.length) throw new Error("invalid fetch response");
    if (len <= 2) { at += 4; continue; }
    const body = bytes.subarray(at + 4, at + len);
    at += len;
    if (inPack) {
      if (body[0] === 1) chunks.push(body.subarray(1));
      else if (body[0] === 3) throw new Error(`git error: ${new TextDecoder().decode(body.subarray(1, 200))}`);
      continue;
    }
    // Section headers arrive bare, or behind a channel-1 byte when the server multiplexes everything.
    const line = new TextDecoder().decode(body[0] === 1 ? body.subarray(1) : body).trimEnd();
    if (line === "packfile") inPack = true;
    else if (line.startsWith("ERR ")) throw new Error(`git error: ${line.slice(4, 200)}`);
  }
  if (!chunks.length) throw new Error("fetch response has no pack");
  const pack = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { pack.set(c, at); at += c.length; }
  return pack;
}

type Obj = { type: (typeof TYPES)[number]; data: Uint8Array };

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let at = 0;
  const size = () => { let n = 0, shift = 0, b; do { b = delta[at++]!; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return n; };
  if (size() !== base.length) throw new Error("delta base size mismatch");
  const out = new Uint8Array(size());
  let o = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let off = 0, len = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= delta[at++]! << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) len |= delta[at++]! << (8 * i);
      len ||= 0x10000;
      out.set(base.subarray(off >>> 0, (off >>> 0) + len), o); o += len;
    } else if (op) { out.set(delta.subarray(at, at + op), o); o += op; at += op; }
    else throw new Error("invalid delta");
  }
  if (o !== out.length) throw new Error("delta result size mismatch");
  return out;
}

/** Every object in a pack, by id. Deltas are resolved against objects in the same pack. */
export function readPack(pack: Uint8Array): Map<string, Obj> {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK" || view.getUint32(4) !== 2) throw new Error("not a version 2 pack");
  const count = view.getUint32(8);
  const byOffset = new Map<number, Obj>(), byId = new Map<string, Obj>();
  let at = 12;
  for (let n = 0; n < count; n++) {
    const start = at;
    let b = pack[at++]!, type = (b >> 4) & 7;
    while (b & 0x80) b = pack[at++]!;
    let base: Obj | undefined;
    if (type === 6) {
      b = pack[at++]!;
      let off = b & 0x7f;
      while (b & 0x80) { b = pack[at++]!; off = ((off + 1) * 128) + (b & 0x7f); }
      base = byOffset.get(start - off);
    } else if (type === 7) {
      base = byId.get([...pack.subarray(at, at + 20)].map((x) => x.toString(16).padStart(2, "0")).join(""));
      at += 20;
    }
    const { buffer, engine } = inflateSync(pack.subarray(at), { info: true }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
    at += engine.bytesWritten;
    let obj: Obj;
    if (type === 6 || type === 7) {
      if (!base) throw new Error("delta base missing from pack");
      obj = { type: base.type, data: applyDelta(base.data, new Uint8Array(buffer)) };
    } else if (TYPES[type]) obj = { type: TYPES[type], data: new Uint8Array(buffer) };
    else throw new Error("unknown pack object type");
    const id = createHash("sha1").update(`${obj.type} ${obj.data.length}\0`).update(obj.data).digest("hex");
    byOffset.set(start, obj); byId.set(id, obj);
  }
  return byId;
}

/** Every file in a commit's tree, with text for readable files under the size cap. Submodules are skipped. */
export function snapshotFiles(objects: Map<string, Obj>, commit: string): SnapshotFile[] {
  const c = objects.get(commit);
  if (c?.type !== "commit") throw new Error("commit missing from pack");
  const root = /^tree ([0-9a-f]{40})$/m.exec(new TextDecoder().decode(c.data))?.[1];
  const files: SnapshotFile[] = [];
  const walk = (id: string, prefix: string, depth: number) => {
    const t = objects.get(id);
    if (t?.type !== "tree" || depth > 64) throw new Error("tree missing from pack");
    for (let at = 0; at < t.data.length;) {
      const sp = t.data.indexOf(0x20, at), nul = t.data.indexOf(0, sp);
      const mode = new TextDecoder().decode(t.data.subarray(at, sp)), name = new TextDecoder().decode(t.data.subarray(sp + 1, nul));
      const oid = [...t.data.subarray(nul + 1, nul + 21)].map((x) => x.toString(16).padStart(2, "0")).join("");
      at = nul + 21;
      if (mode === "40000") walk(oid, `${prefix}${name}/`, depth + 1);
      else if (mode !== "160000") {
        const blob = objects.get(oid);
        if (!blob) throw new Error("blob missing from pack");
        const binary = blob.data.subarray(0, 8000).includes(0);
        files.push({ path: prefix + name, size: blob.data.length, binary,
          text: binary || blob.data.length > MAX_TEXT_BYTES ? null : new TextDecoder().decode(blob.data) });
      }
    }
  };
  walk(root ?? "", "", 0);
  return files;
}
