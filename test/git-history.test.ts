import { describe, expect, it } from "vitest";
import { protectGitHistory } from "../src/code/gitHistory";
import { packet, peekCommands, replaceCommands, reportOutcomes, ZERO_OID } from "../src/code/gitProtocol";
const id = (n: number) => n.toString(16).padStart(40, "0");
const update = (old: number, next: number, ref = "refs/heads/main") => ({ oldOid: id(old), newOid: id(next), ref });
const commit = (n: number, ...parents: number[]) => ({ hash: id(n), parents: parents.map(id) });

describe("published Git history protection", () => {
  it("accepts new refs without needing old ancestry", async () => {
    await protectGitHistory([{ ...update(0, 2), oldOid: ZERO_OID }], async () => { throw new Error("should not read"); });
  });
  it("accepts fast-forward updates and no-ops", async () => {
    await protectGitHistory([update(1, 3)], async () => [commit(3, 2), commit(2, 1), commit(1)]);
    await protectGitHistory([update(1, 1)], async () => { throw new Error("should not read"); });
  });
  it("follows the second parent of a merge, not just the first-parent history", async () => {
    await protectGitHistory([update(1, 4)], async ref => ref === id(4) ? [commit(4, 3, 2), commit(3)] : [commit(2, 1), commit(1)]);
  });
  it("continues when a first-parent page ends before the old tip", async () => {
    await protectGitHistory([update(1, 4)], async ref => ref === id(4) ? [commit(4, 3), commit(3, 2)] : [commit(2, 1), commit(1)]);
  });
  it("rejects rewinds and divergent histories even though Artifacts permits them", async () => {
    await expect(protectGitHistory([update(3, 1)], async () => [commit(1)])).rejects.toThrow("cannot be rewritten");
    await expect(protectGitHistory([update(2, 3)], async () => [commit(3, 1), commit(1)])).rejects.toThrow("cannot be rewritten");
  });
  it("rejects published tag changes and ref deletion without attempting publication", async () => {
    await expect(protectGitHistory([update(1, 2, "refs/tags/v1")], async () => [])).rejects.toThrow("tags cannot be changed");
    await expect(protectGitHistory([{ ...update(1, 0), newOid: ZERO_OID }], async () => [])).rejects.toThrow("cannot be deleted");
  });
  it("fails closed on missing, substituted, or discontinuous commit data", async () => {
    for (const data of [[], [commit(4)], [commit(3, 2), commit(5, 1)]])
      await expect(protectGitHistory([update(1, 3)], async () => data)).rejects.toThrow("ancestry");
  });
  it("does not hang on repeated ancestry", async () => {
    await expect(protectGitHistory([update(1, 3)], async () => [commit(3, 3)])).rejects.toThrow("cannot be rewritten");
  });
});

describe("command replacement", () => {
  it("changes only commands and preserves binary pack and push-option bytes exactly", async () => {
    const prefix = packet(`${id(1)} ${id(2)} refs/heads/main\0report-status push-options\n`);
    const tail = new Uint8Array([48, 48, 48, 48, 80, 65, 67, 75, 0, 255, 0]);
    const original = new Uint8Array(prefix.length + 4 + tail.length);
    original.set(prefix);original.set(new TextEncoder().encode("0000"), prefix.length);original.set(tail, prefix.length + 4);
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(original);controller.close(); } });
    const inspected = await peekCommands(source);
    const rewritten = replaceCommands(inspected.stream, inspected.prefixBytes, [update(0, 2, "refs/ardi/forks/heads/main/synthetic")], inspected.capabilities);
    const result = await peekCommands(rewritten);
    expect(result.updates).toEqual([update(0, 2, "refs/ardi/forks/heads/main/synthetic")]);
    const replay = new Uint8Array(await new Response(result.stream).arrayBuffer());
    expect(replay.slice(result.prefixBytes)).toEqual(tail);
  });
  it("does not turn missing status into accepted refs", () => {
    expect(reportOutcomes(new Uint8Array(), [update(1, 2)])[0]!.outcome).toBe("unknown");
  });
});
