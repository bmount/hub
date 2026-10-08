// The hub's line diff (src/code/diff.ts): applying the diff to the old text must give the new text exactly.
import { describe, expect, it } from "vitest";
import { decode, diffText, unified } from "../src/code/diff";

/** Rebuild b from a and the hunks; any mismatch means the diff is wrong. */
function apply(a: string, d: ReturnType<typeof diffText>): string {
  const src = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let at = 0;
  for (const h of d.hunks) {
    while (at < h.aStart - 1 && h.aLines > 0) out.push(src[at++]!);
    if (h.aLines === 0) while (at < h.aStart) out.push(src[at++]!);
    for (const l of h.lines) {
      if (l.op === " ") { expect(src[at]).toBe(l.text); out.push(src[at++]!); }
      else if (l.op === "-") { expect(src[at]).toBe(l.text); at++; }
      else out.push(l.text);
    }
  }
  while (at < src.length) out.push(src[at++]!);
  return out.join("\n");
}

describe("line diff", () => {
  it("reproduces the new text from the old one", () => {
    const cases: Array<[string, string]> = [
      ["a\nb\nc\n", "a\nB\nc\n"],
      ["", "one\ntwo\n"],
      ["one\ntwo\n", ""],
      [Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), Array.from({ length: 40 }, (_, i) => (i % 13 === 0 ? `changed ${i}` : `line ${i}`)).join("\n") + "\nextra"],
      ["x\ny\nz", "x\ny\nz"],
    ];
    for (const [a, b] of cases) expect(apply(a, diffText(a, b))).toBe(b.replace(/\n$/, ""));
  });

  it("counts lines and writes unified hunks", () => {
    const d = diffText("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nX\ne\nf\ng\nh\n");
    expect([d.added, d.removed, d.hunks.length]).toEqual([1, 1, 1]);
    expect(unified("f.txt", d)).toBe("--- a/f.txt\n+++ b/f.txt\n@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+X\n e\n f\n g\n");
    expect(diffText("same\n", "same\n").hunks).toEqual([]);
  });

  it("matches on random edits", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let t = 0; t < 30; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 60) }, () => `l${Math.floor(rnd() * 8)}`);
      const b = a.flatMap((l) => (rnd() < 0.15 ? [] : rnd() < 0.15 ? [l, `n${Math.floor(rnd() * 8)}`] : [l]));
      expect(apply(a.join("\n"), diffText(a.join("\n"), b.join("\n")))).toBe(b.join("\n"));
    }
  });

  it("recognises binary content", () => {
    expect(decode(btoa("abc\u0000def")).binary).toBe(true);
    expect(decode(btoa("plain")).text).toBe("plain");
  });
});
