import { HubError } from "../errors";

export const ASSISTANT_TURN_TIMEOUT_MS = 60_000;
const uncertainty = "Already-started tool or transcript changes may still complete and are not rolled back; check them before retrying. Usage may be unknown.";

/** A turn-local budget. Races each wait, not a detached entire loop: late
 * operations may complete, but cannot continue into another effect. */
export function turnBudget(parent?: AbortSignal) {
  const controller = new AbortController();
  const wall = Date.now(), monotonic = performance.now();
  let failure: HubError | undefined;
  let rejectStop!: (error: HubError) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  // Pre-abort or time between waits must not cause an unhandled rejection.
  void stopped.catch(() => {});
  const stop = (error: HubError) => {
    if (failure) return;
    failure = error;
    rejectStop(error);
    controller.abort();
  };
  const onAbort = () => stop(new HubError(408, "assistant_cancelled", `the assistant turn was cancelled. ${uncertainty}`));
  const timer = setTimeout(() => stop(new HubError(504, "assistant_timeout", `the assistant turn timed out. ${uncertainty}`)), ASSISTANT_TURN_TIMEOUT_MS);
  parent?.addEventListener("abort", onAbort, { once: true });
  const check = () => {
    if (parent?.aborted) onAbort();
    if (!failure && Math.max(Date.now() - wall, performance.now() - monotonic) >= ASSISTANT_TURN_TIMEOUT_MS) {
      stop(new HubError(504, "assistant_timeout", `the assistant turn timed out. ${uncertainty}`));
    }
    if (failure) throw failure;
  };
  return {
    signal: controller.signal,
    check,
    async wait<T>(operation: () => Promise<T>): Promise<T> {
      check();
      // Start synchronously after the check; no effect starts if already expired.
      const pending = operation();
      try {
        const result = await Promise.race([pending, stopped]);
        check();
        return result;
      } catch (error) {
        check(); // Deadline/cancellation takes precedence over obsolete errors.
        throw error;
      }
    },
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); },
  };
}

export type TurnBudget = ReturnType<typeof turnBudget>;
