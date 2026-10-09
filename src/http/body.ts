import { HubError } from "../errors";

export const MAX_API_BODY_BYTES = 1024 * 1024;
export const MAX_MCP_BODY_BYTES = MAX_API_BODY_BYTES;
// Small credential/consent forms, including multipart framing. Never use this
// allowance for voice uploads or forwarded Git bodies.
export const MAX_AUTH_FORM_BODY_BYTES = 16 * 1024;
export const MAX_OAUTH_TOKEN_BODY_BYTES = 16 * 1024;
// URL-encoding can triple the channel's existing 8 KiB message allowance;
// allow that plus form framing. JSON budgets include UTF-8 bytes.
export const MAX_CHANNEL_FORM_BODY_BYTES = 64 * 1024;
export const MAX_ASSISTANT_BODY_BYTES = 64 * 1024;
export const MAX_PLAYGROUND_BODY_BYTES = 64 * 1024;
// Small service-binding credential/reference envelopes; eval runs may name up
// to 60 cases. These limits do not apply to Git bodies forwarded to Ardi.
export const MAX_INTERNAL_BODY_BYTES = 16 * 1024;
export const MAX_INTENT_EVAL_BODY_BYTES = 64 * 1024;
// Retain the voice clip allowance separately from multipart framing/context.
export const MAX_VOICE_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_VOICE_RECORDING_BODY_BYTES = MAX_VOICE_AUDIO_BYTES + 64 * 1024;
// Accommodate the existing 40,000 UTF-16-unit envelope in UTF-8, without
// increasing the decoded transcript/context limits.
export const MAX_VOICE_CORRECTION_BODY_BYTES = 128 * 1024;
// Whole original-body reads, not inactivity or downstream handler deadlines.
export const MAX_REQUEST_BODY_READ_MS = 10_000;
export const MAX_VOICE_RECORDING_READ_MS = 60_000;

/** Content-Length is only an early rejection hint. Bound actual bytes before
 * JSON/form parsers or SDK classification. Do not retain source-owned chunks or
 * an unbounded list of tiny chunks. Cancellation must never delay a refusal.
 */
export async function readRequestBytes(request: Request, maximum: number,
  readMs = MAX_REQUEST_BODY_READ_MS): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError("invalid body limit");
  if (!Number.isSafeInteger(readMs) || readMs < 1) throw new RangeError("invalid body deadline");
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
  const deadline = performance.now() + readMs;
  let failure: HubError | undefined;
  let rejectRead: ((e: HubError) => void) | undefined;
  const stop = (e: HubError) => {
    if (failure) return;
    failure = e;
    rejectRead?.(e);
    cancel();
  };
  const timeout = () => new HubError(408, "request_timeout", "request body read timed out");
  const onAbort = () => stop(new HubError(400, "bad_request", "request body aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(timeout()), readMs);
  const check = () => {
    if (signal.aborted) onAbort();
    // A delayed timer must not authorize late chunks, EOF or buffer assembly.
    if (!failure && performance.now() >= deadline) stop(timeout());
    if (failure) throw failure;
  };
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(Math.min(8192, maximum));
  let size = 0;
  try {
    check();
    for (;;) {
      // Only the pending read has a rejection callback: unlike repeatedly racing
      // one unresolved abort promise, tiny chunks retain no per-chunk handlers.
      const { value, done } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        rejectRead = reject;
        reader.read().then(resolve, reject);
      });
      rejectRead = undefined;
      check();
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
    const bytes = buffer.slice(0, size);
    check();
    return bytes;
  } catch (e) {
    cancel();
    if (e instanceof HubError) throw e;
    throw new HubError(400, "bad_request", "request body could not be read");
  } finally {
    clearTimeout(timer);
    rejectRead = undefined;
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Keep malformed-form behavior separate from streamed overflow/abort errors:
 * callers may preserve their neutral form handling, but must return 413/400 for
 * a refused body rather than silently proceeding with an empty form.
 */
export async function readRequestForm(request: Request, maximum: number,
  readMs = MAX_REQUEST_BODY_READ_MS): Promise<FormData | null> {
  const bytes = await readRequestBytes(request, maximum, readMs);
  return requestWithBytes(request, bytes).formData().catch(() => null);
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
