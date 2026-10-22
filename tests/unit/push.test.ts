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
    // 2.2 (FR-180): the car set off towards a booked pickup.
    expect(pushText("driver_departed", { driver: "Roman" }, "en", "Europe/Warsaw", "r1")).toEqual({
      title: "Roman has set off",
      body: "The car is moving towards your pickup — see it on the map.",
      tag: "driver_departed:r1"
    });
    expect(pushText("driver_departed", { driver: "Roman" }, "pl", "Europe/Warsaw").title).toBe("Roman ruszył(a)");
    expect(openUrl("driver_departed")).toBe("./");
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

describe("2.1 open request texts (FR-162, FR-164, V36, V37)", () => {
  const TZ = "Europe/Warsaw";
  const H = 3600_000;
  // As the backends send it: no provider ("" from siosia_nick, or nothing), open: true.
  const open = { service: "Childcare", at: AT, end: AT + 3 * H, client: "Toria", provider: "", place: "Husarska 16", open: true };
  const series = { ...open, service: "Learning", end: AT + H, rule: "weekly" as const, count: 8, first: AT, last: AT + 49 * 24 * H };

  it("asks every other member to take it, with the range and the place, opening Planned", () => {
    expect(pushText("appt_open", open, "en", TZ, "a1")).toEqual({
      title: "Can you help? Childcare",
      body: "Toria asks: Childcare Mon 12 Oct, 14:30–17:30 · Husarska 16. Open Siosia to take it.",
      tag: "appt_open:a1"
    });
    expect(pushText("appt_open", { ...open, service: "Opieka nad dziećmi" }, "pl", TZ, "a1")).toMatchObject({
      title: "Możesz pomóc? Opieka nad dziećmi",
      body: expect.stringMatching(/^Toria prosi o pomoc: Opieka nad dziećmi .*12 paź, 14:30–17:30 · Husarska 16\. Otwórz Siosię, aby się tego podjąć\.$/)
    });
    expect(pushText("appt_open", { ...open, place: "" }, "en", TZ).body).toBe("Toria asks: Childcare Mon 12 Oct, 14:30–17:30. Open Siosia to take it.");
    expect(openUrl("appt_open")).toBe("./?open=planned");
  });

  it("names a series' rule, span and count, like appt_new", () => {
    expect(pushText("appt_open", series, "en", TZ).body).toBe(
      "Toria asks: Learning every Mon 14:30–15:30, 12 Oct – 30 Nov (8×) · Husarska 16. Open Siosia to take it."
    );
    expect(pushText("appt_open", { ...series, service: "Nauka" }, "pl", TZ).body).toBe(
      "Toria prosi o pomoc: Nauka co poniedziałek 14:30–15:30, 12 paź – 30 lis (8×) · Husarska 16. Otwórz Siosię, aby się tego podjąć."
    );
    expect(pushText("appt_open", { ...series, rule: "biweekly", first: AT + 2 * 24 * H }, "pl", TZ).body).toMatch(/co drugą środę/);
  });

  it("reads 'waiting for someone to take it' while open — also a waiting client with no provider", () => {
    expect(apptStatusText("open", null, "en")).toBe("Waiting for someone to take it");
    expect(apptStatusText("open", undefined, "pl")).toBe("Czeka, aż ktoś się podejmie");
    expect(apptStatusText("waiting", "", "en")).toBe("Waiting for someone to take it");
    expect(apptStatusText("waiting", null, "pl")).toBe("Czeka, aż ktoś się podejmie");
    expect(apptStatusText("waiting", "Siosia", "en")).toBe("Waiting for an answer from Siosia"); // unchanged with a provider
  });

  it("tells the client that nobody took it when it expires — no provider name", () => {
    expect(pushText("appt_expired", open, "en", TZ, "a1")).toEqual({
      title: "Nobody took it",
      body: "Nobody took your request: Childcare Mon 12 Oct, 14:30–17:30.",
      tag: "appt_expired:a1"
    });
    expect(pushText("appt_expired", { ...open, service: "Opieka" }, "pl", TZ)).toMatchObject({
      title: "Nikt się nie zgłosił",
      body: expect.stringMatching(/^Nikt nie przyjął Twojej prośby: Opieka .*12 paź, 14:30–17:30\.$/)
    });
    expect(pushText("appt_expired", series, "en", TZ).body).toBe("Nobody took your request: Learning every Mon 14:30–15:30, 12 Oct – 30 Nov (8×).");
    // Without the flag, a missing provider still reads as open; with a provider, the 2.0 words stay.
    expect(pushText("appt_expired", { ...open, open: undefined, provider: undefined }, "en", TZ).title).toBe("Nobody took it");
    expect(pushText("appt_expired", { ...open, open: undefined, provider: "Siosia" }, "en", TZ).title).toBe("No answer from Siosia");
  });

  it("reminds the client of an open request without a provider", () => {
    const r = { ...open, lead: 1440, role: "client" as const, other: "", status: "open", rides: [] };
    expect(pushText("appt_reminder", r, "en", TZ, "a1")).toEqual({
      title: "Tomorrow: Childcare Mon 12 Oct, 14:30–17:30",
      body: "Your open request · Husarska 16. Waiting for someone to take it.",
      tag: "appt_reminder:a1"
    });
    expect(pushText("appt_reminder", { ...r, lead: 120 }, "pl", TZ).body).toBe("Twoja otwarta prośba · Husarska 16. Czeka, aż ktoś się podejmie.");
    expect(pushText("appt_reminder", { ...r, place: "" }, "en", TZ).body).toBe("Your open request. Waiting for someone to take it.");
    // Status "waiting" with no provider and no flag (a backend that does not say open) reads the same.
    expect(pushText("appt_reminder", { ...r, open: undefined, status: "waiting", provider: undefined }, "en", TZ).body).toBe(
      "Your open request · Husarska 16. Waiting for someone to take it."
    );
    // No other party for any other reason: the place and the status, never "With  ·".
    expect(pushText("appt_reminder", { ...r, open: undefined, status: "confirmed" }, "en", TZ).body).toBe("Husarska 16. Confirmed.");
    expect(pushText("appt_reminder", { ...r, open: undefined, status: "confirmed", place: "" }, "pl", TZ).body).toBe("Potwierdzone.");
  });

  it("the taker's accept reads as a normal accept", () => {
    expect(pushText("appt_accepted", { ...open, open: undefined, provider: "Ewa" }, "en", TZ)).toMatchObject({
      title: "Ewa accepted",
      body: "Childcare Mon 12 Oct, 14:30–17:30 is confirmed."
    });
  });

  it("never prints undefined, null or a placeholder for any appointment kind without a provider", () => {
    const kinds = [
      "appt_new",
      "appt_open",
      "appt_accepted",
      "appt_declined",
      "appt_cancelled",
      "appt_expired",
      "appt_reminder"
    ] as const;
    const variants = [
      open,
      series,
      { ...open, provider: undefined },
      { ...open, provider: null as unknown as string, open: undefined },
      { ...open, place: "", other: "", status: "open", lead: 120, role: "client" as const },
      { ...open, other: undefined, status: "waiting", lead: 1440, role: "client" as const, open: undefined },
      { ...open, who: undefined, from: AT, left: 2 }
    ];
    for (const kind of kinds)
      for (const lang of ["en", "pl"])
        for (const p of variants) {
          const t = pushText(kind, p, lang, TZ, "a1");
          for (const s of [t.title, t.body]) {
            expect(s, `${kind} ${lang} ${JSON.stringify(p)}`).not.toMatch(/undefined|null|NaN|[{}]/);
            // No empty name: no leading or dangling punctuation, no "With ·", "by :", "przez:." …
            expect(s, `${kind} ${lang}`).not.toMatch(/^[\s.,·:]|\s[.,:·]\s*$|\s{2}|(?<!\p{L})(With|Z|from|od|by)\s*[.,·:]|przez:\s*[.,·]/u);
            expect(s.length, `${kind} ${lang}`).toBeGreaterThan(5);
          }
          expect(t.tag).toBe(`${kind}:a1`);
        }
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

  it("sends an open request to a member as appt_open, tagged by the appointment, opening Planned (V36)", async () => {
    const params = { service: "Childcare", at: AT, end: AT + 3 * 3600_000, client: "Toria", provider: "", place: "Husarska 16", open: true };
    const { deps, log } = fake([{ ...row(11, "ewa", 1), kind: "appt_open", ride_id: null, appointment_id: "a11", params }], { ewa: [sub("https://push/e")] }, {});
    expect(await dispatch(deps)).toEqual({ sent: 1, failed: 0, dropped: 0 });
    expect(JSON.parse(log.payloads[0])).toEqual({
      title: "Can you help? Childcare",
      body: "Toria asks: Childcare Mon 12 Oct, 14:30–17:30 · Husarska 16. Open Siosia to take it.",
      tag: "appt_open:a11",
      url: "./?open=planned"
    });
  });

  it("opens Planned for booking notifications too: their Take it lives there in 2.0, ./ is S1 (C16, FR-125)", async () => {
    const kinds = ["booking_new", "booking_open", "booking_taken", "booking_released", "booking_cancelled"] as const;
    for (const kind of kinds) expect(openUrl(kind)).toBe("./?open=planned");
    expect(openUrl("booking_later" as never)).toBe("./?open=planned"); // any later booking_* kind
    for (const kind of ["time_to_go", "driver_coming", "driver_arrived", "request_new"] as const) expect(openUrl(kind)).toBe("./");
    const { deps, log } = fake([{ ...row(7, "driver", 1), kind: "booking_new", params: { pickup: "Home", dropoff: "School", at: AT } }], { driver: [sub("https://push/d")] }, {});
    await dispatch(deps);
    expect(JSON.parse(log.payloads[0])).toMatchObject({ tag: "booking_new:r1", url: "./?open=planned" });
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
