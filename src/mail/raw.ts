export const MAX_RAW_MAIL_BYTES = 10 * 1024 * 1024;

/** Bound actual stream bytes, not just the platform's declared rawSize. Preserve
 * original bytes so independent cryptographic verification can reuse them.
 * Optional cancellation bounds a pending read too; never await a source's
 * possibly stalled cancel callback before returning a limit/abort failure.
 */
export async function readBoundedMail(stream: ReadableStream<Uint8Array>, maximum = MAX_RAW_MAIL_BYTES,
  signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let onAbort: (() => void) | undefined;
  const aborted = signal ? new Promise<never>((_, reject) => {
    onAbort = () => { reject(new Error("mail read aborted")); cancel(); };
    signal.addEventListener("abort", onAbort, { once: true });
  }) : undefined;
  try {
    if (signal?.aborted) throw new Error("mail read aborted");
    for (;;) {
      const { value, done } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (signal?.aborted) throw new Error("mail read aborted");
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { cancel(); throw new Error("message too large"); }
      chunks.push(value);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    if (signal?.aborted) cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
