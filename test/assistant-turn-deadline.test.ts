import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/auth/context";
import { runTurn } from "../src/assistant/run";
import { ASSISTANT_TURN_TIMEOUT_MS, turnBudget } from "../src/assistant/deadline";

import * as store from "../src/models/store";
import * as secretbox from "../src/models/secretbox";
import * as providers from "../src/models/providers";
import * as usage from "../src/models/usage";
import * as tools from "../src/mcp/tools";
const mocks = { route: vi.fn(), cred: vi.fn(), open: vi.fn(), turn: vi.fn(), tool: vi.fn(), usage: vi.fn() };
const deferred = <T>() => { let resolve!: (x: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const call = (id: string) => ({ call_id: id, name: "fixture_write", arguments: "{}" });
const output = (calls: ReturnType<typeof call>[] = []) => ({ text: "answer", calls, output: [], inputTokens: 3, outputTokens: 2 });
let wall: number;
let history: ReturnType<typeof vi.fn>, batch: ReturnType<typeof vi.fn>, ctx: Ctx;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(store, "resolveRoute").mockImplementation(mocks.route);
  vi.spyOn(store, "activeCredentialRow").mockImplementation(mocks.cred);
  vi.spyOn(secretbox, "open").mockImplementation(mocks.open);
  vi.spyOn(providers, "provider").mockReturnValue({ name: "Fixture", turn: mocks.turn } as unknown as providers.Provider);
  vi.spyOn(usage, "usageStatement").mockImplementation(() => ({ run: mocks.usage }) as unknown as D1PreparedStatement);
  vi.spyOn(tools, "toolsFor").mockReturnValue([]);
  vi.spyOn(tools, "callTool").mockImplementation(mocks.tool);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  wall = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  mocks.route.mockResolvedValue({ provider: "fixture", model: "fixture" });
  mocks.cred.mockResolvedValue({ id: "credential", secret_ciphertext: "synthetic", secret_iv: "synthetic" });
  mocks.open.mockResolvedValue("synthetic-key");
  mocks.turn.mockResolvedValue(output());
  mocks.tool.mockResolvedValue({ content: [{ text: "written" }] });
  mocks.usage.mockResolvedValue({});
  history = vi.fn().mockResolvedValue({ results: [] });
  batch = vi.fn().mockResolvedValue([]);
  const statement = { bind: () => statement, all: history };
  ctx = { db: { prepare: () => statement, batch }, env: { HUB_SECRETS_KEY: "fixture" }, tenant: { id: "tenant", display_name: "Fixture" }, identity: { id: "human", display_name: "Human" }, now: wall } as unknown as Ctx;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("assistant whole-turn budget", () => {
  it.each(["route", "credential", "decrypt", "history", "usage", "tool", "transcript"])("bounds stalled %s even when abort is ignored; no late continuation", async phase => {
    const held = deferred<any>();
    if (phase === "route") mocks.route.mockReturnValue(held.promise);
    if (phase === "credential") mocks.cred.mockReturnValue(held.promise);
    if (phase === "decrypt") mocks.open.mockReturnValue(held.promise);
    if (phase === "history") history.mockReturnValue(held.promise);
    if (phase === "usage") mocks.usage.mockReturnValue(held.promise);
    if (phase === "tool") { mocks.turn.mockResolvedValue(output([call("first"), call("second")])); mocks.tool.mockReturnValue(held.promise); }
    if (phase === "transcript") batch.mockReturnValue(held.promise);
    const result = runTurn(ctx, "thread", "write", "fixture").catch(e => e);
    await vi.advanceTimersByTimeAsync(ASSISTANT_TURN_TIMEOUT_MS - 1);
    let settled = false; void result.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 504, reason: "assistant_timeout", detail: expect.stringContaining("may still complete") });
    const counts = [mocks.turn.mock.calls.length, mocks.tool.mock.calls.length, mocks.usage.mock.calls.length, batch.mock.calls.length];
    held.resolve(phase === "route" ? { provider: "fixture", model: "fixture" } : phase === "credential" ? { id: "credential" } : phase === "history" ? { results: [] } : {});
    await vi.advanceTimersByTimeAsync(0);
    expect([mocks.turn.mock.calls.length, mocks.tool.mock.calls.length, mocks.usage.mock.calls.length, batch.mock.calls.length]).toEqual(counts);
    expect(mocks.tool).toHaveBeenCalledTimes(phase === "tool" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("spans rounds and tools; wall-only expiry prevents the next tool without timer dispatch", async () => {
    mocks.turn.mockImplementation(async () => { wall += 20_000; return output([call("first"), call("second")]); });
    mocks.tool.mockImplementation(async () => { wall += 10_000; return { content: [] }; });
    await expect(runTurn(ctx, "thread", "write", "fixture")).rejects.toMatchObject({ reason: "assistant_timeout" });
    expect(mocks.turn).toHaveBeenCalledTimes(2);
    expect(mocks.tool).toHaveBeenCalledTimes(2);
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    expect(batch).not.toHaveBeenCalled();
  });

  it.each(["model", "tool", "transcript"])("rejects exact-boundary late %s success before any follow-on effect", async phase => {
    const expire = async () => { wall += ASSISTANT_TURN_TIMEOUT_MS; return phase === "model" ? output([call("late")]) : phase === "tool" ? { content: [] } : []; };
    if (phase === "model") mocks.turn.mockImplementation(expire);
    if (phase === "tool") { mocks.turn.mockResolvedValue(output([call("first"), call("late")])); mocks.tool.mockImplementation(expire); }
    if (phase === "transcript") batch.mockImplementation(expire);
    await expect(runTurn(ctx, "thread", "write", "fixture")).rejects.toMatchObject({ reason: "assistant_timeout" });
    expect(mocks.tool).toHaveBeenCalledTimes(phase === "tool" ? 1 : 0);
    expect(batch).toHaveBeenCalledTimes(phase === "transcript" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before", "model", "tool"])("propagates %s caller cancellation and never resumes abandoned work", async phase => {
    const parent = new AbortController(), held = deferred<any>();
    let signal!: AbortSignal;
    mocks.turn.mockImplementation(async (_key, _model, _items, opts) => {
      signal = opts.signal;
      if (phase === "model") { parent.abort(); return held.promise; }
      return output([call("first"), call("late")]);
    });
    mocks.tool.mockImplementation(async () => { parent.abort(); return held.promise; });
    if (phase === "before") parent.abort();
    await expect(runTurn(ctx, "thread", "write", "fixture", { signal: parent.signal })).rejects.toMatchObject({ status: 408, reason: "assistant_cancelled" });
    expect(mocks.turn).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    if (phase !== "before") expect(signal.aborted).toBe(true);
    held.resolve(output()); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.tool).toHaveBeenCalledTimes(phase === "tool" ? 1 : 0);
    expect(batch).not.toHaveBeenCalled();
  });

  it("accepts final persistence just inside the boundary and cleans up parent subscription", async () => {
    const parent = new AbortController();
    batch.mockImplementation(async () => { wall += ASSISTANT_TURN_TIMEOUT_MS - 1; return []; });
    await expect(runTurn(ctx, "thread", "read", "fixture", { signal: parent.signal })).resolves.toEqual({ reply: "answer", steps: [] });
    const signal = mocks.turn.mock.calls[0]![3].signal;
    parent.abort(); await vi.advanceTimersByTimeAsync(ASSISTANT_TURN_TIMEOUT_MS);
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("late database rejection cannot mask wall-only deadline before timer dispatch", async () => {
    history.mockImplementation(async () => { wall += ASSISTANT_TURN_TIMEOUT_MS; throw new Error("obsolete database error"); });
    await expect(runTurn(ctx, "thread", "write", "fixture")).rejects.toMatchObject({ reason: "assistant_timeout" });
    expect(mocks.turn).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("monotonic time expires despite wall rollback and late errors cannot mask expiry", async () => {
    const budget = turnBudget();
    const held = deferred<void>();
    const result = budget.wait(() => held.promise).catch(e => e);
    wall -= 100_000;
    await vi.advanceTimersByTimeAsync(ASSISTANT_TURN_TIMEOUT_MS);
    expect(await result).toMatchObject({ reason: "assistant_timeout" });
    held.resolve(); budget.dispose();
    await expect(budget.wait(async () => { throw new Error("obsolete denial"); })).rejects.toMatchObject({ reason: "assistant_timeout" });
  });
});
