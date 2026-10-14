export type RefUpdate = { oldOid: string; newOid: string; ref: string };
export type RefOutcome = RefUpdate & { outcome: "ok" | "ng" | "unknown"; reason?: string };
export const ZERO_OID = "0".repeat(40);
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_UPDATES = 4096;
const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function packetLength(header: Uint8Array): number {
  const text = decode.decode(header);
  if (!/^[0-9a-fA-F]{4}$/.test(text)) throw new Error("invalid packet length");
  const length = Number.parseInt(text, 16);
  if (length !== 0 && (length < 4 || length > 65520)) throw new Error("unsupported packet length");
  return length;
}

export function validGitRef(ref: string): boolean {
  return ref.startsWith("refs/") && ref.length <= 1024 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)
    && !ref.includes("..") && !ref.includes("@{") && !ref.endsWith(".")
    && ref.split("/").every(part => !!part && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Retain only the chunks needed to inspect commands; replay the pack without decoding it. */
export async function peekCommands(source: ReadableStream<Uint8Array>): Promise<{
  updates: RefUpdate[]; capabilities: string[]; prefixBytes: number; stream: ReadableStream<Uint8Array>;
}> {
  const reader = source.getReader();
  const replay: Uint8Array[] = [];
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0, commandBytes = 0;
  const read = async (length: number): Promise<Uint8Array> => {
    commandBytes += length;
    if (commandBytes > MAX_COMMAND_BYTES) throw new Error("push commands too large");
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) throw new Error("truncated push commands");
        chunk = next.value; offset = 0; replay.push(chunk);
      }
      const take = Math.min(length - written, chunk.length - offset);
      result.set(chunk.subarray(offset, offset + take), written);
      offset += take; written += take;
    }
    return result;
  };
  const updates: RefUpdate[] = [], seen = new Set<string>();
  let capabilities: string[] = [];
  try {
    for (;;) {
      const length = packetLength(await read(4));
      if (!length) break;
      const payload = decode.decode(await read(length - 4)).replace(/\n$/, "");
      if (/^shallow [0-9a-f]{40}$/.test(payload) && !updates.length) continue;
      const parts = payload.split("\0");
      if (parts.length > 2 || (parts.length === 2 && updates.length)) throw new Error("invalid command capabilities");
      if (parts.length === 2) {
        if (!/^[\x20-\x7e]*$/.test(parts[1]!)) throw new Error("invalid capabilities");
        capabilities = parts[1]!.trim().split(/ +/).filter(Boolean);
      }
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/.+)$/.exec(parts[0]!);
      if (!match || !validGitRef(match[3]!)) throw new Error("invalid ref command");
      const [, oldOid, newOid, ref] = match as unknown as [string, string, string, string];
      if (seen.has(ref) || (oldOid === ZERO_OID && newOid === ZERO_OID)) throw new Error("invalid duplicate or empty update");
      seen.add(ref); updates.push({ oldOid, newOid, ref });
      if (updates.length > MAX_UPDATES) throw new Error("too many ref commands");
    }
    let replayIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (replayIndex < replay.length) { controller.enqueue(replay[replayIndex++]!); return; }
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(next.value);
      },
      async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
    });
    return { updates, capabilities, prefixBytes: commandBytes, stream };
  } catch (error) {
    await reader.cancel().catch(() => {}); reader.releaseLock(); throw error;
  }
}

export function refAllowed(ref: string, prefixes?: string[]): boolean {
  if (!validGitRef(ref) || ref === "refs/ardi" || ref === "refs/pimwell" || ref.startsWith("refs/ardi/") || ref.startsWith("refs/pimwell/")) return false;
  return prefixes === undefined || prefixes.some(prefix => validGitRef(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix)
    && ref.startsWith(prefix));
}

export type AdvertisedRef = { name: string; target: string };

export function parseAdvertisedRefs(bytes: Uint8Array, includeHead = false): AdvertisedRef[] {
  const result: AdvertisedRef[] = [];
  for (let position = 0; position < bytes.length;) {
    if (bytes.length - position < 4) throw new Error("truncated refs");
    const length = packetLength(bytes.subarray(position, position + 4));position += 4;
    if (!length) continue;
    if (position + length - 4 > bytes.length) throw new Error("truncated refs");
    const line = decode.decode(bytes.subarray(position, position + length - 4)).split("\0")[0]!.trim();position += length - 4;
    const match = /^([0-9a-f]{40}) (refs\/[^\s]+|HEAD)$/.exec(line);
    if (match && (includeHead || match[2] !== "HEAD")) result.push({ name: match[2]!, target: match[1]! });
  }
  return result;
}

export function packet(text: string): Uint8Array {
  const body = new TextEncoder().encode(text), result = new Uint8Array(body.length + 4);
  if (result.length > 65520) throw new Error("packet too large");
  result.set(new TextEncoder().encode(result.length.toString(16).padStart(4, "0")));
  result.set(body, 4); return result;
}

/** Replace only inspected commands. Pack bytes and negotiated push options stay unchanged. */
export function replaceCommands(source: ReadableStream<Uint8Array>, prefixBytes: number, updates: RefUpdate[], capabilities: string[]): ReadableStream<Uint8Array> {
  if (!updates.length) throw new Error("no replacement commands");
  const reader = source.getReader();
  let skip = prefixBytes;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      updates.forEach((update, index) => controller.enqueue(packet(`${update.oldOid} ${update.newOid} ${update.ref}${index === 0 && capabilities.length ? `\0${capabilities.join(" ")}` : ""}\n`)));
      controller.enqueue(new TextEncoder().encode("0000"));
    },
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          if (skip) controller.error(new Error("truncated original commands"));else controller.close();
          return;
        }
        const consumed = Math.min(skip, next.value.length);skip -= consumed;
        if (consumed < next.value.length) { controller.enqueue(next.value.subarray(consumed));return; }
      }
    },
    async cancel(reason) { await reader.cancel(reason);reader.releaseLock(); },
  });
}

function packets(bytes: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 4) throw new Error("truncated status");
    const length = packetLength(bytes.subarray(offset, offset + 4));
    if (!length) { offset += 4; continue; }
    if (offset + length > bytes.length) throw new Error("truncated status");
    result.push(bytes.subarray(offset + 4, offset + length)); offset += length;
  }
  return result;
}

/** HTTP 200 does not establish ref acceptance; require the server's per-ref report. */
export function reportOutcomes(bytes: Uint8Array, updates: RefUpdate[]): RefOutcome[] {
  const unknown = updates.map(update => ({ ...update, outcome: "unknown" as const }));
  try {
    let lines = packets(bytes);
    if (lines.some(line => line[0] === 1 || line[0] === 2 || line[0] === 3)) {
      if (lines.some(line => line[0] === 3)) return unknown;
      const data = lines.filter(line => line[0] === 1).map(line => line.subarray(1));
      const joined = new Uint8Array(data.reduce((sum, part) => sum + part.length, 0));
      let offset = 0; for (const part of data) { joined.set(part, offset); offset += part.length; }
      lines = packets(joined);
    }
    const text = lines.map(line => decode.decode(line).replace(/\n$/, ""));
    if (text[0] !== "unpack ok") return unknown;
    const reports = new Map<string, { outcome: "ok" | "ng"; reason?: string }>();
    for (const line of text.slice(1)) {
      if (line.startsWith("option ")) continue;
      const match = /^(ok|ng) (refs\/\S+)(?: (.*))?$/.exec(line);
      if (!match || reports.has(match[2]!) || !updates.some(update => update.ref === match[2])) return unknown;
      reports.set(match[2]!, { outcome: match[1] as "ok" | "ng", ...(match[3] ? { reason: match[3].slice(0, 200) } : {}) });
    }
    return updates.map(update => ({ ...update, ...(reports.get(update.ref) ?? { outcome: "unknown" as const }) }));
  } catch { return unknown; }
}
