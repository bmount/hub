import { runInDurableObject } from "cloudflare:test";

/**
 * runInDurableObject with the instance typed by the callback. The pool's own workers-types differ from the
 * project's, so TypeScript cannot infer the object class from the stub; the callback states it instead.
 */
export function inDO<T, R>(stub: unknown, fn: (instance: T, state: DurableObjectState) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stub as never, fn as never) as Promise<R>;
}
