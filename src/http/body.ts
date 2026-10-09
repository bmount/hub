import { HubError } from "../errors";

export const MAX_API_BODY_BYTES = 1024 * 1024;
export const MAX_MCP_BODY_BYTES = MAX_API_BODY_BYTES;

/** Content-Length is only an early rejection hint. Bound actual bytes before
 * JSON/form parsers or SDK classification. Do not retain source-owned chunks or
 * an unbounded list of tiny chunks. Cancellation must never delay a refusal.
 */
export async function readRequestBytes(request: Request, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError("invalid body limit");
  const tooLarge = () => new HubError(413, "too_large", `request body exceeds ${maximum} bytes`);
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    void request.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const signal = request.signal;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { reject(new HubError(400, "bad_request", "request body aborted")); cancel(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(Math.min(8192, maximum));
  let size = 0;
  try {
    if (signal.aborted) throw new HubError(400, "bad_request", "request body aborted");
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new HubError(400, "bad_request", "request body aborted");
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new HubError(400, "bad_request", "invalid request body stream");
      const next = size + value.byteLength;
      if (next > maximum) throw tooLarge();
      if (next > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(maximum, Math.max(next, buffer.byteLength * 2)));
        grown.set(buffer.subarray(0, size));
        buffer = grown;
      }
      buffer.set(value, size);
      size = next;
    }
    return buffer.slice(0, size);
  } catch (e) {
    cancel();
    if (e instanceof HubError) throw e;
    throw new HubError(400, "bad_request", "request body could not be read");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Rebuild only from bounded bytes. Authentication/logging use the original
 * request; metadata must not keep a forged Content-Length or transfer framing.
 */
export function requestWithBytes(request: Request, bytes: Uint8Array<ArrayBuffer>): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, { method: request.method, headers, body: bytes, signal: request.signal });
}
