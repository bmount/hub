import { HubError } from "../errors";

/** Multipart supports Git's chunked uploads; R2 put() requires a known stream length. */
export async function saveGitReplay(bucket: R2Bucket, key: string, source: ReadableStream<Uint8Array>): Promise<void> {
  const upload = await bucket.createMultipartUpload(key);
  const reader = source.getReader(), parts: R2UploadedPart[] = [];
  let buffer = new Uint8Array(8 * 1024 * 1024), used = 0, total = 0;
  try {
    for (;;) {
      const next = await reader.read();if (next.done) break;
      total += next.value.length;
      if (total > 100 * 1024 * 1024) throw new HubError(413, "too_large", "Git push exceeds the HTTP upload limit");
      for (let offset = 0; offset < next.value.length;) {
        const take = Math.min(buffer.length - used, next.value.length - offset);
        buffer.set(next.value.subarray(offset, offset + take), used);used += take;offset += take;
        if (used === buffer.length) {
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(buffer.length);used = 0;
        }
      }
    }
    if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
    await upload.complete(parts);
  } catch (error) {
    await reader.cancel().catch(() => {});await upload.abort().catch(() => {});throw error;
  } finally { reader.releaseLock(); }
}
