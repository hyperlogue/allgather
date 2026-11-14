import { afterAll, afterEach, expect, test } from "bun:test";
import { liveEvents } from "../web/live-events.ts";

class FakeEventSource extends EventTarget {
  static all: FakeEventSource[] = [];
  closed = false;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
}
const page = new EventTarget();
const transition = (type: "pagehide" | "pageshow", persisted: boolean) =>
  page.dispatchEvent(Object.assign(new Event(type), { persisted }));
const saved = {
  EventSource: globalThis.EventSource,
  add: globalThis.addEventListener,
  remove: globalThis.removeEventListener,
};
Object.assign(globalThis, {
  EventSource: FakeEventSource,
  addEventListener: page.addEventListener.bind(page),
  removeEventListener: page.removeEventListener.bind(page),
});
afterEach(() => {
  FakeEventSource.all = [];
});
afterAll(() =>
  Object.assign(globalThis, {
    EventSource: saved.EventSource,
    addEventListener: saved.add,
    removeEventListener: saved.remove,
  }),
);

test("live events close for the back/forward cache and reconnect when the page is restored", () => {
  const seen: string[] = [];
  const stop = liveEvents({
    ready: () => seen.push("ready"),
    change: () => seen.push("change"),
    error: () => seen.push("error"),
  });
  const [first] = FakeEventSource.all;
  expect(first?.url).toBe("/api/events");
  first?.dispatchEvent(new Event("ready"));
  first?.dispatchEvent(new Event("change"));
  first?.onerror?.();
  expect(seen).toEqual(["ready", "change", "error"]);

  transition("pagehide", true);
  expect(first?.closed).toBe(true);
  transition("pageshow", false);
  expect(FakeEventSource.all).toHaveLength(1);
  transition("pageshow", true);
  expect(FakeEventSource.all).toHaveLength(2);
  transition("pageshow", true);
  expect(FakeEventSource.all).toHaveLength(2);
  const second = FakeEventSource.all[1];
  second?.dispatchEvent(new Event("ready"));
  expect(seen.at(-1)).toBe("ready");

  stop();
  expect(second?.closed).toBe(true);
  transition("pageshow", true);
  expect(FakeEventSource.all).toHaveLength(2);
});
