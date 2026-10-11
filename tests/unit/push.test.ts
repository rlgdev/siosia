// Notifications: the shared texts (EN/PL, deployment time zone) and the push-dispatch logic that
// sends the queued messages (with fakes for the database and the push service).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { disablePush, enablePush, pushState } from "../../src/services/push";
import { pushText } from "../../supabase/functions/_shared/push-text";
import { dispatch, MAX_ATTEMPTS, type Deps, type OutboxRow, type Subscription } from "../../supabase/functions/push-dispatch/dispatch";

const AT = Date.UTC(2026, 9, 12, 12, 30); // 14:30 in Warsaw (CEST)

describe("notification texts", () => {
  it("names the driver, the place and the booked time in the deployment's time zone", () => {
    expect(pushText("time_to_go", { at: AT, pickup: "Husarska 16, Lipków", rider: "Toria" }, "en", "Europe/Warsaw", "r1")).toEqual({
      title: "Time to go",
      body: "Pickup 14:30: Toria at Husarska 16, Lipków. Open Siosia.",
      tag: "time_to_go:r1"
    });
    expect(pushText("booking_taken", { at: new Date(AT).toISOString(), driver: "Roman" }, "pl", "Europe/Warsaw").title).toBe("Roman Cię zawiezie");
    expect(pushText("booking_taken", { at: AT, driver: "Roman" }, "pl", "Europe/Warsaw").body).toMatch(/^Twój kurs .*14:30 ma kierowcę\.$/);
    expect(pushText("driver_arrived", { driver: "Roman" }, "xx", "Nowhere/Bad_Zone").title).toBe("Roman is here");
  });
});

describe("push-dispatch", () => {
  const row = (id: number, user: string, attempts = 0): OutboxRow => ({
    id,
    user_id: user,
    kind: "driver_coming",
    ride_id: "r1",
    params: { driver: "Roman" },
    lang: "en",
    tz: "Europe/Warsaw",
    attempts
  });
  const sub = (endpoint: string): Subscription => ({ endpoint, p256dh: "p".repeat(20), auth: "a".repeat(12) });

  function fake(rows: OutboxRow[], subs: Record<string, Subscription[]>, fail: Record<string, number>) {
    const log = { sent: [] as string[], payloads: [] as string[], marked: [] as number[], failed: [] as number[], dropped: [] as string[] };
    const deps: Deps = {
      pending: async () => rows,
      subscriptions: async (u) => subs[u] ?? [],
      send: async (s, payload) => {
        if (fail[s.endpoint]) throw Object.assign(new Error("push service"), { statusCode: fail[s.endpoint] });
        log.sent.push(s.endpoint);
        log.payloads.push(payload);
      },
      markSent: async (id) => void log.marked.push(id),
      markFailed: async (id) => void log.failed.push(id),
      dropSubscription: async (e) => void log.dropped.push(e)
    };
    return { deps, log };
  }

  it("sends to every device of the user, drops gone subscriptions, retries transient failures", async () => {
    const { deps, log } = fake(
      // attempts as claimed (each claim counts): 4 is on its last try
      [row(1, "rider", 1), row(2, "gone", 1), row(3, "flaky", 1), row(4, "flaky", MAX_ATTEMPTS), row(5, "nobody", 1)],
      { rider: [sub("https://push/a"), sub("https://push/b")], gone: [sub("https://push/410")], flaky: [sub("https://push/503")] },
      { "https://push/410": 410, "https://push/503": 503 }
    );
    expect(await dispatch(deps)).toEqual({ sent: 1, failed: 1, dropped: 1 });
    expect(log.sent).toEqual(["https://push/a", "https://push/b"]);
    expect(JSON.parse(log.payloads[0])).toEqual({ title: "Roman is on the way", body: "Your driver is heading to the pickup.", tag: "driver_coming:r1", url: "./" });
    expect(log.dropped).toEqual(["https://push/410"]);
    expect(log.failed).toEqual([3]); // tries again next run
    expect(log.marked).toEqual([1, 2, 4, 5]); // done: delivered, nobody left, out of attempts, no devices
  });
});

describe("turning notifications on and off (demo backend)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function stubNotification(initial: NotificationPermission, answer: NotificationPermission) {
    const N = { permission: initial, requestPermission: vi.fn(async () => ((N.permission = answer), answer)) };
    vi.stubGlobal("Notification", N);
    Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
    return N;
  }
  const mockApi = { kind: "mock" } as Backend;

  it("asks on the tap, remembers off, and reports blocked", async () => {
    stubNotification("default", "granted");
    expect(await pushState(mockApi, "")).toBe("off");
    expect(await enablePush(mockApi, "")).toBe("on");
    expect(await pushState(mockApi, "")).toBe("on");
    expect(await disablePush(mockApi)).toBe("off");
    expect(await pushState(mockApi, "")).toBe("off"); // permission stays granted; this phone said off
    expect(await enablePush(mockApi, "")).toBe("on");
    stubNotification("default", "denied");
    expect(await enablePush(mockApi, "")).toBe("blocked");
    expect(await pushState(mockApi, "")).toBe("blocked");
  });

  it("needs a server key for real push", async () => {
    stubNotification("default", "granted");
    vi.stubGlobal("PushManager", function PushManager() {});
    expect(await pushState({ kind: "supabase" } as Backend, "")).toBe("not-configured");
  });
});
