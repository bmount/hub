import { describe, expect, it } from "vitest";
import { CHAT_PRESENCE_JS } from "../src/chatPresenceScript";

class Element {
  textContent = "";
  disabled = false;
  children: Element[] = [];
  listeners = new Map<string, (event?: { persisted: boolean }) => void>();
  replaceChildren() { this.children = []; }
  append(el: Element) { this.children.push(el); }
  addEventListener(name: string, fn: (event?: { persisted: boolean }) => void) { this.listeners.set(name, fn); }
  fire(name: string, event?: { persisted: boolean }) { this.listeners.get(name)?.(event); }
}

function client() {
  const connection = new Element(), sharing = new Element(), list = new Element(), toggle = new Element();
  const selectors: Record<string, Element> = { "[data-presence-connection]": connection, "[data-presence-sharing]": sharing, "[data-presence-list]": list, "[data-presence-toggle]": toggle };
  const docEvents = new Element(), winEvents = new Element();
  const document = { hidden: false, querySelector: () => ({ dataset: { chatPresence: "general" }, querySelector: (s: string) => selectors[s] }), createElement: () => new Element(), addEventListener: docEvents.addEventListener.bind(docEvents) };
  const navigator = { onLine: true };
  let time = 0, denied = false;
  const calls: Array<{ name: string; status?: string }> = [];
  const intervals = new Map<number, () => void>();
  let entries = [{ handle: '<img src=x onerror=alert(1)>', kind: "agent", state: "online", last_seen: 1000, expires_at: 91000 }];
  const fetch = async (url: string, init: { body: string }) => {
    const input = JSON.parse(init.body); calls.push({ name: url, status: input.status });
    return { ok: !denied, status: denied ? 404 : 200, json: async () => ({ ok: true, result: { entries, observed_at: 1000 } }) };
  };
  // Execute the exact shipped asset with small DOM/transport fakes, not a second implementation.
  const start = new Function("document", "window", "navigator", "fetch", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout", CHAT_PRESENCE_JS);
  start(document, { addEventListener: winEvents.addEventListener.bind(winEvents) }, navigator, fetch, { now: () => time },
    (fn: () => void, ms: number) => { intervals.set(ms, fn); return ms; }, (id: number) => intervals.delete(id), () => 1, () => {});
  return { connection, sharing, list, toggle, document, navigator, calls, docEvents, winEvents,
    elapsed: (ms: number) => { time = ms; intervals.get(1000)?.(); },
    poll: () => intervals.get(30000)?.(), deny: () => { denied = true; },
    empty: () => { entries = []; },
  };
}
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

describe("presence browser asset", () => {
  it("only reads until explicit opt-in, renders names as text and expires cached online status with a monotonic clock", async () => {
    const c = client(); await settle();
    expect(c.calls.map((x) => x.name)).toEqual(["/api/chat.presence"]);
    expect(c.list.children[0]!.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(c.list.children[0]!.textContent).toContain(" · online · ");
    c.elapsed(90000);
    expect(c.list.children[0]!.textContent).toContain(" · stale · ");
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

  it("clears cached activity on disconnect or denied access and never implies the server received an offline update", async () => {
    const c = client(); await settle();
    c.navigator.onLine = false; c.winEvents.fire("offline"); await settle();
    expect(c.list.children).toEqual([]);
    expect(c.connection.textContent).toContain("Current status is unknown");
    c.toggle.fire("click"); await settle(); c.toggle.fire("click"); await settle();
    expect(c.sharing.textContent).toContain("If the offline update cannot be delivered");
    expect(c.calls.some((x) => x.name === "/api/chat.heartbeat")).toBe(false);
    c.navigator.onLine = true; c.winEvents.fire("online"); await settle();
    expect(c.list.children).toHaveLength(1);
    c.deny(); c.poll(); await settle();
    expect(c.list.children).toEqual([]); expect(c.toggle.disabled).toBe(true);
    expect(c.sharing.textContent).toContain("channel access is unavailable");
  });
});
