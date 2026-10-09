import { describe, expect, it } from "vitest";
import { CHAT_PRESENCE_JS } from "../src/chatPresenceScript";

class Element {
  textContent = "";
  disabled = false;
  children: Element[] = [];
  listeners = new Map<string, (event?: { persisted?: boolean; detail?: { contains: (el: unknown) => boolean } }) => void>();
  replaceChildren() { this.children = []; }
  append(el: Element) { this.children.push(el); }
  addEventListener(name: string, fn: (event?: { persisted?: boolean; detail?: { contains: (el: unknown) => boolean } }) => void) { this.listeners.set(name, fn); }
  removeEventListener(name: string) { this.listeners.delete(name); }
  fire(name: string, event?: { persisted?: boolean; detail?: { contains: (el: unknown) => boolean } }) { this.listeners.get(name)?.(event); }
}

function client() {
  const connection = new Element(), sharing = new Element(), freshness = new Element(), list = new Element(), toggle = new Element();
  const selectors: Record<string, Element> = { "[data-presence-connection]": connection, "[data-presence-sharing]": sharing, "[data-presence-freshness]": freshness, "[data-presence-list]": list, "[data-presence-toggle]": toggle };
  const docEvents = new Element(), winEvents = new Element();
  const document = { hidden: false, querySelector: () => ({ dataset: { chatPresence: "general" }, querySelector: (s: string) => selectors[s] }), createElement: () => new Element(), addEventListener: docEvents.addEventListener.bind(docEvents), removeEventListener: docEvents.removeEventListener.bind(docEvents) };
  const navigator = { onLine: true };
  let time = 0, wall = 0, denied = false;
  class ClockDate extends Date { static now() { return wall; } }
  const calls: Array<{ name: string; status?: string; signal: AbortSignal }> = [];
  let delayed: Promise<void> | null = null, delayedBody: Promise<void> | null = null;
  let failNext = false, timeoutId = 0;
  const intervals = new Map<number, () => void>(), timeouts = new Map<number, () => void>();
  let entries = [{ handle: '<img src=x onerror=alert(1)>', kind: "agent", via_assistant: false, state: "online", last_seen: 1000, expires_at: 91000 }];
  const fetch = async (url: string, init: { body: string; signal: AbortSignal }) => {
    const input = JSON.parse(init.body); calls.push({ name: url, status: input.status, signal: init.signal });
    const result = { entries, observed_at: 1000 };
    const bodyWait = delayedBody; delayedBody = null;
    const response = { ok: !denied, status: denied ? 404 : 200, json: async () => {
      if (bodyWait) await bodyWait;
      return { ok: true, result };
    } };
    const wait = delayed; delayed = null;
    const fail = failNext; failNext = false;
    // Deliberately allow late delivery even after abort: generation guards must also work.
    if (wait) await wait;
    if (fail) throw new Error("ambiguous transport failure");
    return response;
  };
  // Execute the exact shipped asset with small DOM/transport fakes, not a second implementation.
  const start = new Function("document", "window", "navigator", "fetch", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date", CHAT_PRESENCE_JS);
  start(document, { addEventListener: winEvents.addEventListener.bind(winEvents), removeEventListener: winEvents.removeEventListener.bind(winEvents) }, navigator, fetch, { now: () => time },
    (fn: () => void, ms: number) => { intervals.set(ms, fn); return ms; }, (id: number) => intervals.delete(id), (fn: () => void) => { timeouts.set(++timeoutId, fn); return timeoutId; }, (id: number) => timeouts.delete(id), ClockDate);
  return { connection, sharing, freshness, list, toggle, document, navigator, calls, docEvents, winEvents,
    delayNext: () => { let release!: () => void; delayed = new Promise<void>((resolve) => { release = resolve; }); return release; },
    delayBodyNext: () => { let release!: () => void; delayedBody = new Promise<void>((resolve) => { release = resolve; }); return release; },
    deadline: () => { for (const fn of timeouts.values()) fn(); },
    failNext: () => { failNext = true; },
    allow: () => { denied = false; },
    state: (state: string, expires_at = 91000) => { entries = [{ ...entries[0]!, state, expires_at }]; },
    elapsed: (ms: number) => { time = ms; wall = ms; intervals.get(1000)?.(); },
    clocks: (monotonic: number, wallTime: number, draw = true) => { time = monotonic; wall = wallTime; if (draw) intervals.get(1000)?.(); },
    poll: () => intervals.get(30000)?.(), deny: () => { denied = true; },
    empty: () => { entries = []; },
    assistant: () => { entries = [{ ...entries[0]!, kind: "human", via_assistant: true }]; },
    dispose: () => docEvents.fire("wb:before-replace", { detail: { contains: () => true } }),
  };
}
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

describe("presence browser asset", () => {
  it("releases an aborted headers/body request without waiting for ignored transport, recovers query-only and ignores late denial", async () => {
    for (const body of [false, true]) {
      const c = client(); await settle();
      if (!body) c.deny();
      const release = body ? c.delayBodyNext() : c.delayNext();
      c.toggle.fire("click"); await settle();
      const request = c.calls.at(-1)!;
      c.deadline(); await settle();
      expect(request.signal.aborted).toBe(true);
      expect(c.list.children).toEqual([]);
      expect(c.sharing.textContent).toContain("Delivery is uncertain");
      expect(c.toggle.textContent).toBe("Share presence in this channel");
      c.allow(); const count = c.calls.length;
      c.poll(); await settle();
      expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
      expect(c.list.children).toHaveLength(1);
      c.toggle.fire("click"); await settle();
      expect(c.toggle.textContent).toBe("Stop sharing presence");
      const renewed = c.calls.length;
      release(); await settle();
      expect(c.calls).toHaveLength(renewed);
      expect(c.toggle.disabled).toBe(false);
      expect(c.toggle.textContent).toBe("Stop sharing presence");
      expect(c.list.children).toHaveLength(1);
    }
  });

  it("can restore or reconnect while obsolete transport never settles, without writing until new consent", async () => {
    for (const lifecycle of ["history", "freeze", "offline", "dispose"]) {
      const c = client(); await settle();
      const release = c.delayBodyNext(); c.toggle.fire("click"); await settle();
      if (lifecycle === "history") c.winEvents.fire("pagehide");
      else if (lifecycle === "freeze") c.docEvents.fire("freeze");
      else if (lifecycle === "dispose") c.dispose();
      else { c.navigator.onLine = false; c.winEvents.fire("offline"); }
      await settle(); const count = c.calls.length;
      if (lifecycle === "history") c.winEvents.fire("pageshow", { persisted: true });
      else if (lifecycle === "freeze") c.docEvents.fire("resume");
      else if (lifecycle === "offline") { c.navigator.onLine = true; c.winEvents.fire("online"); }
      c.poll(); await settle();
      expect(c.calls.slice(count).every(x => x.name === "/api/chat.presence")).toBe(true);
      if (lifecycle === "dispose") {
        expect(c.calls).toHaveLength(count); expect(c.list.children).toEqual([]);
      } else {
        expect(c.calls.length).toBeGreaterThan(count);
        expect(c.list.children).toHaveLength(1);
        c.toggle.fire("click"); await settle();
        expect(c.calls.at(-2)!.status).toBe("online");
      }
      const renewed = c.calls.length; release(); await settle();
      expect(c.calls).toHaveLength(renewed);
      expect(c.list.children).toHaveLength(lifecycle === "dispose" ? 0 : 1);
    }
  });

  it("rejects a late heartbeat at the exact deadline even when the abort timer did not run, without replaying queued changes", async () => {
    const c = client(); await settle();
    const release = c.delayNext(); c.toggle.fire("click"); await settle();
    c.toggle.fire("click"); // Queue explicit offline behind the pending online write.
    const count = c.calls.length;
    c.clocks(0, 8000, false); release(); await settle();
    expect(c.list.children).toEqual([]);
    expect(c.sharing.textContent).toContain("Delivery is uncertain");
    expect(c.calls).toHaveLength(count); // No continuation into a query or queued offline.
    c.poll(); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
    expect(c.toggle.textContent).toBe("Share presence in this channel");
    c.toggle.fire("click"); await settle();
    expect(c.calls.at(-2)!.status).toBe("online");
  });

  it("rejects a late read response at the exact deadline despite wall-clock rollback", async () => {
    const c = client(); await settle();
    const release = c.delayNext(); c.poll(); await settle();
    c.clocks(8000, -10000, false); release(); await settle();
    expect(c.list.children).toEqual([]);
    expect(c.connection.textContent).toContain("Current status is unknown");
    expect(c.calls.some(x => x.status)).toBe(false);
    c.poll(); await settle(); expect(c.list.children).toHaveLength(1);
  });

  it("bounds body decoding by the same deadline and cancels consent queued behind a late read", async () => {
    const c = client(); await settle();
    const release = c.delayBodyNext(); c.poll(); await settle();
    c.toggle.fire("click"); // New consent queued while read body is pending.
    const count = c.calls.length;
    c.clocks(8000, 8000, false); release(); await settle();
    expect(c.list.children).toEqual([]);
    expect(c.sharing.textContent).toContain("Share explicitly again");
    expect(c.calls.slice(count).some(x => x.status)).toBe(false);
    c.poll(); await settle();
    expect(c.toggle.textContent).toBe("Share presence in this channel");
  });

  it("does not accept success after timeout abortion, even if transport ignores the signal", async () => {
    for (const body of [false, true]) {
      const c = client(); await settle();
      const release = body ? c.delayBodyNext() : c.delayNext();
      c.toggle.fire("click"); await settle();
      const request = c.calls.at(-1)!;
      c.deadline(); expect(request.signal.aborted).toBe(true);
      release(); await settle();
      expect(c.list.children).toEqual([]);
      expect(c.toggle.textContent).toBe("Share presence in this channel");
      expect(c.calls.at(-1)!.name).toBe("/api/chat.heartbeat");
    }
  });

  it("accepts sub-deadline responses and charges their time against snapshot freshness", async () => {
    const c = client(); await settle();
    const release = c.delayBodyNext(); c.poll(); await settle();
    c.clocks(7999, 7999, false); release(); await settle();
    expect(c.list.children).toHaveLength(1);
    expect(c.freshness.textContent).toContain("7 seconds old");
    expect(c.connection.textContent).toContain("snapshot refreshed");
  });

  it("expires consent before a throttled timer can renew it, even when the monotonic clock pauses during sleep", async () => {
    const c = client(); await settle(); c.toggle.fire("click"); await settle();
    const count = c.calls.length;
    c.clocks(0, 90000, false); // No expiry callback ran while asleep.
    c.poll(); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
    expect(c.toggle.textContent).toBe("Share presence in this channel");
    expect(c.sharing.textContent).toContain("Share explicitly again");
    c.toggle.fire("click"); await settle();
    expect(c.calls.at(-2)!.status).toBe("online");
  });

  it("expires all cached states on wall-clock sleep without manufacturing offline", async () => {
    for (const state of ["online", "away", "offline", "empty"]) {
      const c = client(); await settle();
      if (state === "empty") c.empty(); else c.state(state);
      c.poll(); await settle();
      c.clocks(0, 89999); expect(c.list.children).toHaveLength(1);
      c.clocks(0, 90000);
      expect(c.list.children).toEqual([]);
      expect(c.connection.textContent).toContain("snapshot expired");
      expect(c.calls.some(x => x.status)).toBe(false);
    }
  });

  it("invalidates a stalled sharing interval's late transport before query-only recovery", async () => {
    const c = client(); await settle(); c.toggle.fire("click"); await settle();
    c.clocks(30000, 30000, false);
    const release = c.delayNext(); c.poll(); await settle();
    const request = c.calls.at(-1)!;
    c.clocks(30000, 120000);
    expect(request.signal.aborted).toBe(true);
    expect(c.list.children).toEqual([]);
    const count = c.calls.length;
    release(); await settle();
    expect(c.calls).toHaveLength(count); // Late write cannot continue into a snapshot.
    c.poll(); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
    expect(c.toggle.textContent).toBe("Share presence in this channel");
  });

  it("uses monotonic age despite wall-clock rollback and does not extend consent via queries", async () => {
    const c = client(); await settle(); c.toggle.fire("click"); await settle();
    c.document.hidden = true; c.docEvents.fire("visibilitychange"); await settle();
    c.clocks(89999, -500000, false); c.poll(); await settle();
    expect(c.toggle.textContent).toBe("Stop sharing presence");
    const count = c.calls.length;
    c.clocks(90000, -500000, false);
    c.document.hidden = false; c.docEvents.fire("visibilitychange"); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
    expect(c.toggle.textContent).toBe("Share presence in this channel");
  });

  it("preserves fresh explicit consent after an expired interval's late denial", async () => {
    const c = client(); await settle(); c.toggle.fire("click"); await settle();
    c.deny(); const release = c.delayNext(); c.poll(); await settle();
    c.clocks(90000, 90000);
    c.allow(); c.toggle.fire("click"); release(); await settle();
    expect(c.toggle.disabled).toBe(false);
    expect(c.toggle.textContent).toBe("Stop sharing presence");
    expect(c.calls.filter(x => x.status === "online")).toHaveLength(3);
    expect(c.list.children).toHaveLength(1);
  });

  it("does not use clock expiry or renewed clicks to bypass current access denial", async () => {
    const c = client(); await settle(); c.toggle.fire("click"); await settle();
    c.deny(); c.poll(); await settle();
    expect(c.toggle.disabled).toBe(true);
    const count = c.calls.length;
    c.clocks(120000, 120000); c.toggle.fire("click"); c.poll(); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
    expect(c.list.children).toEqual([]);
    expect(c.toggle.disabled).toBe(true);
  });

  it("requires renewed consent after ambiguous heartbeat delivery, polls query-only and does not claim offline", async () => {
    const c = client(); await settle();
    c.failNext(); c.toggle.fire("click"); await settle();
    expect(c.list.children).toEqual([]);
    expect(c.toggle.disabled).toBe(false);
    expect(c.toggle.textContent).toBe("Share presence in this channel");
    expect(c.sharing.textContent).toContain("Share explicitly again");
    expect(c.sharing.textContent).toContain("expires within 90 seconds");
    const count = c.calls.length;
    c.poll(); await settle(); c.winEvents.fire("online"); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence", "/api/chat.presence"]);
    expect(c.list.children).toHaveLength(1);
    c.toggle.fire("click"); await settle();
    expect(c.calls.at(-2)!.status).toBe("online");
  });

  it("stops consent on disconnect during an opted-in heartbeat and does not republish on reconnection", async () => {
    const c = client(); await settle(); c.toggle.fire("click"); await settle();
    const release = c.delayNext(); c.poll(); await settle();
    const request = c.calls.at(-1)!;
    c.navigator.onLine = false; c.winEvents.fire("offline");
    expect(request.signal.aborted).toBe(true);
    expect(c.toggle.textContent).toBe("Share presence in this channel");
    expect(c.sharing.textContent).toContain("Share explicitly again");
    const count = c.calls.length;
    c.navigator.onLine = true; c.winEvents.fire("online"); release(); await settle();
    c.poll(); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence", "/api/chat.presence"]);
    expect(c.list.children).toHaveLength(1);
    c.toggle.fire("click"); await settle();
    expect(c.calls.at(-2)!.status).toBe("online");
  });

  it("never replays queued sharing changes after ambiguous delivery, including stop-sharing failures", async () => {
    for (const stop of [false, true]) {
      const c = client(); await settle();
      if (stop) { c.toggle.fire("click"); await settle(); }
      c.failNext(); const release = c.delayNext(); c.toggle.fire("click"); await settle();
      expect(c.calls.at(-1)!.status).toBe(stop ? "offline" : "online");
      // A click during the pending operation is not permission to retry its ambiguous result.
      c.toggle.fire("click");
      const count = c.calls.length;
      release(); await settle(); c.poll(); await settle();
      expect(c.calls.slice(count).every(x => x.name === "/api/chat.presence")).toBe(true);
      expect(c.toggle.textContent).toBe("Share presence in this channel");
      expect(c.sharing.textContent).toContain("expires within 90 seconds");
    }
  });

  it("stops publishing on a failed query while opted in, even if its heartbeat was already accepted", async () => {
    const c = client(); await settle(); c.toggle.fire("click"); await settle();
    const release = c.delayNext(); c.poll(); await settle();
    // The heartbeat is in flight; fail the following query, not that write.
    c.failNext(); release(); await settle();
    expect(c.calls.at(-1)!.name).toBe("/api/chat.presence");
    expect(c.list.children).toEqual([]);
    expect(c.toggle.textContent).toBe("Share presence in this channel");
    const count = c.calls.length;
    c.poll(); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
  });

  it("ignores a failed old heartbeat after restoration rather than cancelling fresh consent", async () => {
    const c = client(); await settle();
    c.failNext(); const release = c.delayNext(); c.toggle.fire("click"); await settle();
    c.winEvents.fire("pagehide"); c.winEvents.fire("pageshow", { persisted: true });
    c.toggle.fire("click"); release(); await settle();
    expect(c.toggle.textContent).toBe("Stop sharing presence");
    expect(c.calls.filter(x => x.status === "online")).toHaveLength(2);
    expect(c.list.children).toHaveLength(1);
  });

  it("labels assistant-reported human presence separately", async () => {
    const c = client(); await settle(); c.assistant(); c.poll(); await settle();
    expect(c.list.children[0]!.textContent).toContain("human via-assistant");
  });

  it("disposes the old channel on pane replacement, aborts transport and never resumes publishing on later events", async () => {
    const c = client(); await settle();
    c.toggle.fire("click"); await settle();
    const release = c.delayNext(); c.poll(); await settle();
    const request = c.calls.at(-1)!;
    c.dispose();
    expect(request.signal.aborted).toBe(true);
    expect(c.list.children).toEqual([]);
    const count = c.calls.length;
    release(); await settle();
    c.poll(); c.elapsed(120000); c.winEvents.fire("online");
    c.winEvents.fire("pageshow", { persisted: true }); c.docEvents.fire("visibilitychange"); await settle();
    expect(c.calls).toHaveLength(count);
    expect(c.list.children).toEqual([]);
    expect(c.docEvents.listeners.size).toBe(0);
    expect(c.winEvents.listeners.size).toBe(0);
  });
  it("freezes without pagehide, aborts late transport and resumes query-only until renewed opt-in", async () => {
    const c = client(); await settle();
    c.toggle.fire("click"); await settle();
    const release = c.delayNext(); c.poll(); await settle();
    const request = c.calls.at(-1)!;
    c.docEvents.fire("freeze");
    expect(request.signal.aborted).toBe(true);
    expect(c.list.children).toEqual([]);
    expect(c.connection.textContent).toContain("Page suspended");
    const count = c.calls.length;
    c.toggle.fire("click"); c.poll(); c.winEvents.fire("online"); await settle();
    expect(c.calls).toHaveLength(count);
    c.docEvents.fire("resume");
    release(); await settle();
    expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
    expect(c.sharing.textContent).toContain("Share explicitly again");
    c.poll(); await settle();
    expect(c.calls.slice(count).some(x => x.name.endsWith("heartbeat"))).toBe(false);
    c.toggle.fire("click"); await settle();
    expect(c.calls.at(-2)!.status).toBe("online");
  });

  it("does not let resume bypass pagehide or disposed-pane suspension", async () => {
    for (const dispose of [false, true]) {
      const c = client(); await settle();
      c.toggle.fire("click"); await settle();
      c.docEvents.fire("freeze");
      if (dispose) c.dispose(); else c.winEvents.fire("pagehide");
      const count = c.calls.length;
      c.docEvents.fire("resume"); c.toggle.fire("click"); c.poll(); await settle();
      expect(c.calls).toHaveLength(count);
      expect(c.list.children).toEqual([]);
      if (!dispose) {
        c.winEvents.fire("pageshow", { persisted: true }); await settle();
        expect(c.calls.slice(count).map(x => x.name)).toEqual(["/api/chat.presence"]);
      }
    }
  });

  it("ignores a frozen generation's late denial while applying current access loss on resume", async () => {
    const c = client(); await settle();
    c.deny(); const release = c.delayNext(); c.poll(); await settle();
    c.docEvents.fire("freeze"); c.allow(); c.docEvents.fire("resume");
    release(); await settle();
    expect(c.toggle.disabled).toBe(false);
    expect(c.list.children).toHaveLength(1);
    c.deny(); c.poll(); await settle();
    expect(c.toggle.disabled).toBe(true);
    c.docEvents.fire("freeze"); c.docEvents.fire("resume"); await settle();
    c.toggle.fire("click"); await settle();
    expect(c.calls.some(x => x.name.endsWith("heartbeat"))).toBe(false);
    expect(c.list.children).toEqual([]);
  });

  it("only reads until explicit opt-in, renders names as text and expires cached online status with a monotonic clock", async () => {
    const c = client(); await settle();
    expect(c.calls.map((x) => x.name)).toEqual(["/api/chat.presence"]);
    expect(c.list.children[0]!.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(c.list.children[0]!.textContent).toContain(" · online · ");
    c.state("online", 61000); c.poll(); await settle();
    c.elapsed(60000);
    expect(c.list.children[0]!.textContent).toContain(" · stale · ");
    expect(c.freshness.textContent).toContain("60 seconds old");
    c.elapsed(90000);
    expect(c.list.children).toEqual([]);
    expect(c.connection.textContent).toContain("snapshot expired");
    c.toggle.fire("click"); await settle();
    expect(c.calls.find((x) => x.status === "online")?.name).toBe("/api/chat.heartbeat");
    c.document.hidden = true; c.docEvents.fire("visibilitychange"); await settle();
    expect(c.calls.some((x) => x.status === "away")).toBe(true);
    const heartbeats = () => c.calls.filter((x) => x.name === "/api/chat.heartbeat");
    const before = heartbeats().length;
    c.poll(); await settle(); expect(heartbeats()).toHaveLength(before);
    c.document.hidden = false; c.docEvents.fire("visibilitychange"); await settle();
    expect(heartbeats().at(-1)?.status).toBe("online");
    c.winEvents.fire("pagehide");
    const hidden = heartbeats().length;
    c.poll(); await settle(); expect(heartbeats()).toHaveLength(hidden);
    c.winEvents.fire("pageshow", { persisted: true }); await settle();
    expect(heartbeats()).toHaveLength(hidden);
    expect(c.sharing.textContent).toContain("Share explicitly again");
    c.toggle.fire("click"); await settle();
    c.toggle.fire("click"); await settle();
    expect(heartbeats().at(-1)?.status).toBe("offline");
    const stopped = heartbeats().length;
    c.poll(); await settle(); expect(heartbeats()).toHaveLength(stopped);
  });

  it("bounds cached offline and empty snapshots and never presents a failed refresh as an empty current directory", async () => {
    const c = client(); await settle();
    c.state("offline"); c.poll(); await settle();
    c.elapsed(89999); expect(c.list.children[0]!.textContent).toContain(" · offline · ");
    c.elapsed(90000); expect(c.list.children).toEqual([]);
    expect(c.freshness.textContent).toBe("No current presence snapshot.");
    c.empty(); c.poll(); await settle();
    expect(c.list.children[0]!.textContent).toContain("No recent explicit heartbeats");
    c.elapsed(180000); expect(c.list.children).toEqual([]);
    c.deny(); c.poll(); await settle(); c.elapsed(181000);
    expect(c.list.children).toEqual([]);
    expect(c.connection.textContent).toContain("Current status is unknown");
  });

  it("immediately clears and aborts a pending query on disconnect and ignores its late success", async () => {
    const c = client(); await settle();
    const release = c.delayNext(); c.poll(); await settle();
    const request = c.calls.at(-1)!;
    c.navigator.onLine = false; c.winEvents.fire("offline");
    expect(request.signal.aborted).toBe(true);
    expect(c.list.children).toEqual([]);
    release(); await settle();
    expect(c.list.children).toEqual([]);
    c.elapsed(1000); expect(c.list.children).toEqual([]);
    c.navigator.onLine = true; c.winEvents.fire("online"); await settle();
    expect(c.list.children).toHaveLength(1);
    expect(c.calls.some((x) => x.name === "/api/chat.heartbeat")).toBe(false);
  });

  it("does not continue an old heartbeat into a restored page or resume publishing without new opt-in", async () => {
    const c = client(); await settle();
    const release = c.delayNext(); c.toggle.fire("click"); await settle();
    expect(c.calls.at(-1)!.status).toBe("online");
    c.winEvents.fire("pagehide");
    expect(c.list.children).toEqual([]);
    expect(c.calls.at(-1)!.signal.aborted).toBe(true);
    c.winEvents.fire("pageshow", { persisted: true });
    release(); await settle();
    expect(c.calls.filter((x) => x.name === "/api/chat.heartbeat")).toHaveLength(1);
    // Only the fresh generation reads: no query continues the suspended heartbeat.
    expect(c.calls.filter((x) => x.name === "/api/chat.presence")).toHaveLength(2);
    expect(c.sharing.textContent).toContain("Share explicitly again");
    c.poll(); await settle();
    expect(c.calls.filter((x) => x.name === "/api/chat.heartbeat")).toHaveLength(1);
  });

  it("ignores late access denial from a suspended generation but applies denial to the current view", async () => {
    const c = client(); await settle();
    c.deny(); const release = c.delayNext(); c.poll(); await settle();
    c.winEvents.fire("pagehide"); c.allow();
    c.winEvents.fire("pageshow", { persisted: true });
    release(); await settle();
    expect(c.toggle.disabled).toBe(false);
    expect(c.list.children).toHaveLength(1);
    c.deny(); c.poll(); await settle();
    expect(c.toggle.disabled).toBe(true);
    expect(c.list.children).toEqual([]);
  });

  it("charges slow transport against both snapshot age and heartbeat expiry", async () => {
    const c = client(); await settle();
    c.state("online", 7000);
    const release = c.delayNext(); c.poll(); await settle();
    c.elapsed(7000); release(); await settle();
    expect(c.freshness.textContent).toContain("7 seconds old");
    expect(c.list.children[0]!.textContent).toContain(" · stale · ");
    const late = c.delayNext(); c.poll(); await settle();
    c.elapsed(15000); late(); await settle();
    expect(c.list.children).toEqual([]);
    expect(c.connection.textContent).toContain("Current status is unknown");
  });

  it("clears cached activity on disconnect or denied access and never implies the server received an offline update", async () => {
    const c = client(); await settle();
    c.navigator.onLine = false; c.winEvents.fire("offline"); await settle();
    expect(c.list.children).toEqual([]);
    expect(c.connection.textContent).toContain("Current status is unknown");
    c.toggle.fire("click"); await settle(); c.toggle.fire("click"); await settle();
    expect(c.sharing.textContent).toContain("Delivery is uncertain");
    expect(c.calls.some((x) => x.name === "/api/chat.heartbeat")).toBe(false);
    c.navigator.onLine = true; c.winEvents.fire("online"); await settle();
    expect(c.list.children).toHaveLength(1);
    c.deny(); c.poll(); await settle();
    expect(c.list.children).toEqual([]); expect(c.toggle.disabled).toBe(true);
    expect(c.sharing.textContent).toContain("channel access is unavailable");
  });
});
