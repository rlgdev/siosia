// Notifications: the shared texts (EN/PL, deployment time zone) and the push-dispatch logic that
// sends the queued messages (with fakes for the database and the push service).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { disablePush, enablePush, pushState } from "../../src/services/push";
import { apptStatusText, leadText, pushText, rideLineText } from "../../supabase/functions/_shared/push-text";
import { dispatch, MAX_ATTEMPTS, openUrl, type Deps, type OutboxRow, type Subscription } from "../../supabase/functions/push-dispatch/dispatch";

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

describe("2.0 appointment texts (§8, V8)", () => {
  const TZ = "Europe/Warsaw";
  const H = 3600_000;
  const base = { service: "Childcare", at: AT, end: AT + 3 * H, client: "Toria", provider: "Siosia", place: "Husarska 16" };

  it("asks the provider, with the time range in the deployment's time zone", () => {
    expect(pushText("appt_new", base, "en", TZ, "a1")).toEqual({
      title: "New request: Childcare Mon 12 Oct, 14:30",
      body: "Toria asks for Childcare, Mon 12 Oct, 14:30–17:30. Answer in Siosia → Planned.",
      tag: "appt_new:a1"
    });
    const pl = pushText("appt_new", { ...base, service: "Opieka nad dziećmi" }, "pl", TZ, "a1");
    expect(pl.title).toMatch(/^Nowa prośba: Opieka nad dziećmi .*12 paź.*14:30$/);
    expect(pl.body).toMatch(/^Toria prosi o: Opieka nad dziećmi, .*14:30–17:30\. Odpowiedz w Siosi → Zaplanowane\.$/);
  });

  it("names a series' rule, span and count, and the dates declined on answer", () => {
    const series = { ...base, service: "Learning", end: AT + H, rule: "weekly" as const, count: 8, first: AT, last: AT + 49 * 24 * H };
    expect(pushText("appt_new", series, "en", TZ).body).toBe("Toria asks for Learning, every Mon 14:30–15:30, 12 Oct – 30 Nov (8×). Answer in Siosia → Planned.");
    expect(pushText("appt_new", { ...series, service: "Nauka" }, "pl", TZ).body).toBe("Toria prosi o: Nauka, co poniedziałek 14:30–15:30, 12 paź – 30 lis (8×). Odpowiedz w Siosi → Zaplanowane.");
    expect(pushText("appt_new", { ...series, rule: "biweekly", first: AT + 2 * 24 * H }, "pl", TZ).body).toMatch(/co drugą środę/);
    const ok = pushText("appt_accepted", { ...series, accepted: 7, declined: [AT + 7 * 24 * H] }, "en", TZ);
    expect(ok).toMatchObject({ title: "Siosia accepted", body: "Learning every Mon 14:30–15:30, 12 Oct – 30 Nov (8×) is confirmed. 7 of 8 confirmed; declined: 19 Oct" });
    expect(pushText("appt_cancelled", { ...base, who: "Toria", from: AT, left: 4 }, "en", TZ).body).toBe(
      "Cancelled by Toria: Childcare Mon 12 Oct, 14:30–17:30. From 12 Oct, 4 left."
    );
  });

  it("reminds with the status and the ride lines — the same words Planned shows", () => {
    const r = { ...base, lead: 1440, other: "Siosia", status: "confirmed", rides: [{ leg: "there", status: "confirmed", driver: "Roman" }] };
    expect(pushText("appt_reminder", r, "en", TZ, "a1")).toEqual({
      title: "Tomorrow: Childcare Mon 12 Oct, 14:30–17:30",
      body: "With Siosia · Husarska 16. Confirmed. Ride there: Roman ✓",
      tag: "appt_reminder:a1"
    });
    expect(pushText("appt_reminder", { ...r, service: "Opieka", lead: 120, rides: [{ leg: "back", status: "pending", driver: null }] }, "pl", TZ).body).toBe(
      "Z Siosia · Husarska 16. Potwierdzone. Przejazd powrotny: jeszcze bez kierowcy"
    );
    expect(pushText("appt_reminder", { ...r, status: "waiting", rides: [] }, "en", TZ).body).toBe("With Siosia · Husarska 16. Waiting for an answer from Siosia.");
    expect(apptStatusText("answer", "Siosia", "pl")).toBe("Odpowiedz, proszę");
    expect(rideLineText({ leg: "there", status: "failed" }, "en")).toBe("Ride there: no driver found");
    expect([leadText(1440, "en"), leadText(120, "pl"), leadText(30, "en"), leadText(180, "pl")]).toEqual(["Tomorrow", "Za 2 godziny", "In 30 min", "Za 3 godz."]);
  });

  it("tells the other party about the attached ride", () => {
    expect(pushText("appt_ride_taken", { ...base, leg: "there", driver: "Roman" }, "en", TZ)).toMatchObject({
      title: "Ride confirmed: Roman",
      body: "Childcare Mon 12 Oct, 14:30: the ride there has a driver."
    });
    expect(pushText("appt_ride_added", { ...base, leg: "back", who: "Siosia", time: AT + 3 * H + 5 * 60_000 }, "pl", TZ).body).toMatch(/przejazd powrotny o 17:35, szukamy kierowcy\.$/);
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

  it("tags appointment notifications with the appointment and opens Planned", async () => {
    const { deps, log } = fake([{ ...row(9, "rider", 1), kind: "appt_accepted", ride_id: null, appointment_id: "a9", params: { provider: "Siosia", service: "Childcare", at: AT } }], { rider: [sub("https://push/a")] }, {});
    await dispatch(deps);
    expect(JSON.parse(log.payloads[0])).toMatchObject({ title: "Siosia accepted", tag: "appt_accepted:a9", url: "./?open=planned" });
    expect(openUrl("driver_coming")).toBe("./");
  });

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
