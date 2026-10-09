// A provider budget covers headers AND body decoding. Cancellation is advisory
// at the transport, so race it independently and reject overdue late success.
export const MODEL_CALL_TIMEOUT_MS = 30_000;
export class ModelCallTimeout extends Error {
  constructor() { super("model call timed out; delivery and usage may be unknown"); this.name = "ModelCallTimeout"; }
}
export class ModelCallCancelled extends Error {
  constructor() { super("model call cancelled; delivery and usage may be unknown"); this.name = "ModelCallCancelled"; }
}

export async function modelCall<T>(operation: (signal: AbortSignal, check: () => void) => Promise<T>,
  parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const wall = Date.now(), monotonic = performance.now();
  let failure: Error | undefined;
  let rejectStop!: (e: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (e: Error) => {
    if (failure) return;
    failure = e;
    rejectStop(e);
    controller.abort();
  };
  const onAbort = () => stop(new ModelCallCancelled());
  const timer = setTimeout(() => stop(new ModelCallTimeout()), MODEL_CALL_TIMEOUT_MS);
  parent?.addEventListener("abort", onAbort, { once: true });
  const check = () => {
    if (parent?.aborted) onAbort();
    if (!failure && Math.max(Date.now() - wall, performance.now() - monotonic) >= MODEL_CALL_TIMEOUT_MS) stop(new ModelCallTimeout());
    if (failure) throw failure;
  };
  // Schedule the initial check inside the raced operation: pre-aborted calls
  // must not start transport or leave an unhandled rejection behind.
  const pending = Promise.resolve().then(async () => {
    check();
    const result = await operation(controller.signal, check);
    check();
    return result;
  });
  try { return await Promise.race([pending, stopped]); }
  finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}
