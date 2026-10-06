import { describe, expect, it } from "vitest";
import { LIMITS, computeHop, gateRefuses, nextAgentRun, pairTrip, postVerdict, wakesAllowed, windowVerdict, type Recent } from "../src/chat/rules";

const at = (author_id: string, author_kind: Recent["author_kind"], created_at: number): Recent => ({ author_id, author_kind, created_at });

describe("hop", () => {
  it("is 0 for humans and 1 + cause for agents; unprompted agents start at 1", () => {
    expect(computeHop("human", 2)).toBe(0);
    expect(computeHop("agent", null)).toBe(1);
    expect(computeHop("agent", 0)).toBe(1);
    expect(computeHop("agent", 2)).toBe(3);
    expect(wakesAllowed(2)).toBe(true);
    expect(wakesAllowed(3)).toBe(false);
  });
});

describe("human gate", () => {
  it("refuses the ninth consecutive agent message and resets on a human", () => {
    let run = 0;
    for (let i = 0; i < LIMITS.HUMAN_GATE; i++) {
      expect(gateRefuses("agent", run)).toBe(false);
      run = nextAgentRun("agent", run);
    }
    expect(gateRefuses("agent", run)).toBe(true);
    expect(gateRefuses("human", run)).toBe(false);
    expect(nextAgentRun("human", run)).toBe(0);
    expect(nextAgentRun("hub", 3)).toBe(3);
  });
});

describe("pair breaker", () => {
  const now = 1_000_000_000;
  it("trips when two agents alternate more than four times within ten minutes", () => {
    const five = ["A", "B", "A", "B", "A"].map((a, i) => at(a, "agent", now - 60_000 + i));
    expect(pairTrip(five, now)).toBeNull();
    expect(pairTrip([...five, at("B", "agent", now)], now)).toEqual({ a: "A", b: "B" });
  });
  it("does not trip across a human, a third agent, a repeat, or outside the window", () => {
    const alt = (xs: string[]) => xs.map((a, i) => at(a, a === "H" ? "human" : "agent", now - 60_000 + i));
    expect(pairTrip(alt(["A", "B", "A", "H", "B", "A", "B"]), now)).toBeNull();
    expect(pairTrip(alt(["A", "B", "C", "B", "A", "B"]), now)).toBeNull();
    expect(pairTrip(alt(["A", "B", "A", "A", "B", "A"]), now)).toBeNull();
    const old = ["A", "B", "A", "B", "A", "B"].map((a, i) => at(a, "agent", now - LIMITS.PAIR_WINDOW_MS - 10 + i));
    expect(pairTrip(old, now)).toBeNull();
  });
  it("ignores hub messages inside a run", () => {
    const xs = ["A", "B", "hub", "A", "B", "A", "B"].map((a, i) => at(a, a === "hub" ? "hub" : "agent", now - 60_000 + i));
    expect(pairTrip(xs, now)).toEqual({ a: "A", b: "B" });
  });
});

describe("rate windows", () => {
  const now = 10_000_000;
  it("allows up to the limit and reports when the oldest slot frees", () => {
    expect(windowVerdict([now - 1000, now - 2000], now, 60_000, 3)).toEqual({ ok: true });
    expect(windowVerdict([now - 50_000, now - 2000, now - 1000], now, 60_000, 3)).toEqual({ ok: false, retry_after_s: 10 });
    expect(windowVerdict([now - 61_000, now - 2000, now - 1000], now, 60_000, 3)).toEqual({ ok: true });
  });
  it("applies 6 a minute, 60 an hour per agent session and 300 a day per agent; 30 a minute per human", () => {
    const six = Array.from({ length: 6 }, (_, i) => now - i * 1000);
    expect(postVerdict({ is_agent: true, session: six, identity: six, now }).ok).toBe(false);
    expect(postVerdict({ is_agent: true, session: [], identity: six, now }).ok).toBe(true);
    const hourly = Array.from({ length: 60 }, (_, i) => now - 120_000 - i * 1000);
    expect(postVerdict({ is_agent: true, session: hourly, identity: hourly, now }).ok).toBe(false);
    const daily = Array.from({ length: 300 }, (_, i) => now - 4_000_000 - i * 1000);
    expect(postVerdict({ is_agent: true, session: [], identity: daily, now }).ok).toBe(false);
    expect(postVerdict({ is_agent: false, session: six, identity: six, now }).ok).toBe(true);
    const thirty = Array.from({ length: 30 }, (_, i) => now - i * 100);
    expect(postVerdict({ is_agent: false, session: [], identity: thirty, now }).ok).toBe(false);
  });
});
