export const MAX_RAW_MAIL_BYTES = 10 * 1024 * 1024;

/** Bound actual stream bytes, not just the platform's declared rawSize. Preserve
 * original bytes so independent cryptographic verification can reuse them.
 */
export async function readBoundedMail(stream: ReadableStream<Uint8Array>, maximum = MAX_RAW_MAIL_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("message too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
