export const MAX_RAW_MAIL_BYTES = 10 * 1024 * 1024;
export const MAX_RAW_MAIL_READ_MS = 10_000;

/** Original ingress has its own whole-read budget. DoH callers instead supply
 * their query-scoped abort signal. Never return partial or late original bytes.
 * The timer bounds pending reads, while monotonic checks also reject overdue
 * completions/chunk loops when the event loop has not dispatched the timer yet.
 */
export async function readOriginalMail(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const controller = new AbortController();
  const deadline = performance.now() + MAX_RAW_MAIL_READ_MS;
  const timer = setTimeout(() => controller.abort(), MAX_RAW_MAIL_READ_MS);
  try {
    return await readBoundedMail(stream, MAX_RAW_MAIL_BYTES, controller.signal, deadline);
  } finally { clearTimeout(timer); }
}

/** Bound actual stream bytes, not just the platform's declared rawSize. Preserve
 * original bytes so independent cryptographic verification can reuse them.
 * Snapshot each observed chunk before requesting another: stream producers may
 * reuse/mutate backing storage, including offset views and Node Buffer chunks.
 * Optional cancellation bounds a pending read too; never await a source's
 * possibly stalled cancel callback before returning a limit/abort failure.
 */
export async function readBoundedMail(stream: ReadableStream<Uint8Array>, maximum = MAX_RAW_MAIL_BYTES,
  signal?: AbortSignal, deadline?: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const check = () => {
    if (signal?.aborted) throw new Error("mail read aborted");
    if (deadline !== undefined && performance.now() >= deadline) {
      cancel();
      throw new Error("mail read deadline");
    }
  };
  let onAbort: (() => void) | undefined;
  const aborted = signal ? new Promise<never>((_, reject) => {
    onAbort = () => { reject(new Error("mail read aborted")); cancel(); };
    signal.addEventListener("abort", onAbort, { once: true });
  }) : undefined;
  try {
    check();
    for (;;) {
      const { value, done } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      check();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { cancel(); throw new Error("message too large"); }
      // Uint8Array's copy constructor also copies Node Buffer inputs; value.slice()
      // would retain an alias for Buffers. Copy only after the actual-byte limit.
      chunks.push(new Uint8Array(value));
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // Assembly is synchronous; a delayed timer must not authorize late evidence.
    check();
    return bytes;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    if (signal?.aborted) cancel();
    reader.releaseLock();
  }
}
