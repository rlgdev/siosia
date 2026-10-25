// Notifications: the shared texts (EN/PL, deployment time zone) and the push-dispatch logic that
// sends the queued messages (with fakes for the database and the push service).

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { disablePush, enablePush, pushState } from "../../src/services/push";
import { apptStatusText, CHAT_PUSH_CHARS, kidsText, leadText, pushText, rideLineText } from "../../supabase/functions/_shared/push-text";
import { CHAT_GRACE_MS, dispatch, MAX_ATTEMPTS, openUrl, type Deps, type OutboxRow, type Subscription } from "../../supabase/functions/push-dispatch/dispatch";

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

describe("2.3 chat and kids texts (FR-202, FR-222, V48)", () => {
  const TZ = "Europe/Warsaw";
  const H = 3600_000;
  const base = { service: "Childcare", at: AT, end: AT + 3 * H, client: "Toria", provider: "Siosia", place: "Husarska 16" };
  const kids = ["Zosia", "Kuba"];

  it("shows a chat message as sender / text, tagged by the room so the newest replaces the rest", () => {
    expect(pushText("chat_message", { sender: "Toria", text: "Running 5 min late", room: "ride:r1" }, "en", TZ, "r1")).toEqual({
      title: "Toria",
      body: "Running 5 min late",
      tag: "chat:ride:r1"
    });
    expect(pushText("chat_message", { sender: "Toria", text: "Jestem za 5 min", room: "appt:a1" }, "pl", TZ, "a1")).toEqual({
      title: "Toria",
      body: "Jestem za 5 min",
      tag: "chat:appt:a1"
    });
    // Two messages of one room share the tag; another room has its own; the id alone is a fallback.
    expect(pushText("chat_message", { sender: "Roman", text: "ok", room: "ride:r1" }, "en", TZ, "r1").tag).toBe("chat:ride:r1");
    expect(pushText("chat_message", { sender: "Roman", text: "ok", room: "ride:r2" }, "en", TZ, "r2").tag).toBe("chat:ride:r2");
    expect(pushText("chat_message", { sender: "Roman", text: "ok" }, "en", TZ, "r1").tag).toBe("chat:r1");
    // The sender's words stay as typed (no template tidying): "...", a leading dot; only whitespace collapses.
    expect(pushText("chat_message", { sender: "Roman", text: "  Wait...  \n .ok, {x} " , room: "ride:r1" }, "en", TZ).body).toBe("Wait... .ok, {x}");
    // No nickname: "Someone" / "Ktoś"; no text: an empty body, never undefined.
    expect(pushText("chat_message", { room: "ride:r1" }, "en", TZ)).toEqual({ title: "Someone", body: "", tag: "chat:ride:r1" });
    expect(pushText("chat_message", { sender: "", text: "hej", room: "ride:r1" }, "pl", TZ).title).toBe("Ktoś");
    // At most 80 characters, then an ellipsis. C21: the backends queue the full text (a message may be
    // 500 characters long) — this is the one place that cuts; exactly 80 characters get no ellipsis.
    expect(CHAT_PUSH_CHARS).toBe(80);
    const full = pushText("chat_message", { sender: "Toria", text: "x".repeat(500), room: "ride:r1" }, "en", TZ).body;
    expect(full).toBe(`${"x".repeat(80)}…`);
    expect(full).toHaveLength(81);
    expect(pushText("chat_message", { sender: "Toria", text: "x".repeat(500), room: "ride:r1" }, "pl", TZ).body).toBe(`${"x".repeat(80)}…`);
    expect(pushText("chat_message", { sender: "Toria", text: "x".repeat(100), room: "ride:r1" }, "en", TZ).body).toBe(`${"x".repeat(80)}…`);
    expect(pushText("chat_message", { sender: "Toria", text: "x".repeat(80), room: "ride:r1" }, "en", TZ).body).not.toContain("…");
    expect(pushText("chat_message", { sender: "Toria", text: "x".repeat(80), room: "ride:r1" }, "en", TZ).body).toBe("x".repeat(80));
    expect(pushText("chat_message", { sender: "Toria", text: `${"y".repeat(79)} zzzz`, room: "ride:r1" }, "en", TZ).body).toBe(`${"y".repeat(79)}…`);
  });

  it("opens the room from a chat notification; the other kinds keep their URLs", () => {
    expect(openUrl("chat_message", { room: "ride:r1" })).toBe("./?chat=ride:r1");
    expect(openUrl("chat_message", { room: "appt:a1" })).toBe("./?chat=appt:a1");
    expect(openUrl("chat_message", {})).toBe("./");
    expect(openUrl("chat_message")).toBe("./");
    expect(openUrl("appt_accepted", { room: "appt:a1" })).toBe("./?open=planned");
    expect(openUrl("driver_coming", { room: "ride:r1" })).toBe("./");
  });

  it("names the attached kids to the provider — request, accept, reminder — in EN and PL", () => {
    expect(pushText("appt_new", { ...base, kids }, "en", TZ).body).toBe("Toria asks for Childcare, Mon 12 Oct, 14:30–17:30, with Zosia and Kuba. Answer in Siosia → Planned.");
    expect(pushText("appt_new", { ...base, service: "Opieka", kids }, "pl", TZ).body).toMatch(/^Toria prosi o: Opieka, .*14:30–17:30, z: Zosia i Kuba\. Odpowiedz w Siosi → Zaplanowane\.$/);
    // The accept copy the backend sends to the provider (role set or not).
    expect(pushText("appt_accepted", { ...base, kids, role: "provider" }, "en", TZ).body).toBe("Childcare Mon 12 Oct, 14:30–17:30 is confirmed, with Zosia and Kuba.");
    expect(pushText("appt_accepted", { ...base, kids }, "en", TZ).body).toBe("Childcare Mon 12 Oct, 14:30–17:30 is confirmed, with Zosia and Kuba.");
    expect(pushText("appt_accepted", { ...base, service: "Opieka", kids, role: "provider" }, "pl", TZ).body).toMatch(/14:30–17:30 — potwierdzone, z: Zosia i Kuba\.$/);
    const r = { ...base, lead: 1440, role: "provider" as const, other: "Toria", status: "confirmed", kids, rides: [{ leg: "there", status: "confirmed", driver: "Roman" }] };
    expect(pushText("appt_reminder", r, "en", TZ, "a1")).toEqual({
      title: "Tomorrow: Childcare Mon 12 Oct, 14:30–17:30",
      body: "With Toria · Husarska 16, with Zosia and Kuba. Confirmed. Ride there: Roman ✓",
      tag: "appt_reminder:a1"
    });
    expect(pushText("appt_reminder", { ...r, service: "Opieka", lead: 120, rides: [] }, "pl", TZ).body).toBe("Z Toria · Husarska 16, z: Zosia i Kuba. Potwierdzone.");
    expect(pushText("appt_reminder", { ...r, place: "" }, "en", TZ).body).toBe("With Toria, with Zosia and Kuba. Confirmed. Ride there: Roman ✓");
    // One kid, three kids: "and" / "i" only before the last.
    expect(pushText("appt_new", { ...base, kids: ["Zosia"] }, "en", TZ).body).toContain(", with Zosia. Answer");
    expect(pushText("appt_new", { ...base, kids: ["Zosia", "Kuba", "Ola"] }, "pl", TZ).body).toContain(", z: Zosia, Kuba i Ola. Odpowiedz");
    expect(kidsText(["Zosia", "Kuba", "Ola"], "en")).toBe("Zosia, Kuba and Ola");
    expect(kidsText([" Zosia ", "", "Kuba"], "pl")).toBe("Zosia i Kuba");
    expect(kidsText(["Zosia"], "pl")).toBe("Zosia");
    expect(kidsText([], "en")).toBe("");
    expect(kidsText(undefined, "pl")).toBe("");
  });

  it("never names kids to the client, and prints nothing (no undefined) when none are attached", () => {
    const client = { ...base, lead: 1440, role: "client" as const, other: "Siosia", status: "confirmed", kids: ["Zosia"], rides: [] };
    expect(pushText("appt_reminder", client, "en", TZ).body).toBe("With Siosia · Husarska 16. Confirmed.");
    expect(pushText("appt_accepted", { ...base, role: "client", kids: ["Zosia"] }, "pl", TZ).body).toMatch(/— potwierdzone\.$/);
    expect(pushText("appt_new", { ...base, role: "client", kids: ["Zosia"] }, "en", TZ).body).not.toContain("Zosia");
    for (const none of [undefined, [], [""], ["  "]])
      for (const lang of ["en", "pl"])
        for (const kind of ["appt_new", "appt_accepted", "appt_reminder"] as const) {
          const t = pushText(kind, { ...base, kids: none, role: "provider", other: "Toria", status: "confirmed", lead: 120 }, lang, TZ, "a1");
          expect(t.body, `${kind} ${lang} ${JSON.stringify(none)}`).not.toMatch(/undefined|null|with\s*[.,]|z:\s*[.,]|,\s*,|\s{2}|\s[.,]/);
        }
    // Without kids the 2.0 words are untouched.
    expect(pushText("appt_new", base, "en", TZ).body).toBe("Toria asks for Childcare, Mon 12 Oct, 14:30–17:30. Answer in Siosia → Planned.");
    expect(pushText("appt_accepted", base, "en", TZ).body).toBe("Childcare Mon 12 Oct, 14:30–17:30 is confirmed.");
    expect(pushText("appt_accepted", { ...base, service: "Opieka" }, "pl", TZ).body).toMatch(/— potwierdzone\.$/);
  });

  it("ships chat_message, the chat URL and the kids words in the push-dispatch bundle (B8: the Edge Function is pasted from it)", () => {
    const bundle = readFileSync("supabase/functions/push-dispatch/dist-bundle.ts", "utf-8");
    for (const s of ["chat_message", "./?chat=", "kidsText", "with ${", "z: ${", "chat:${"]) expect(bundle, s).toContain(s);
    // C6: the read check (messages.read_at by the message id) and the grace are in the bundle too.
    for (const s of ["isMessageRead", '"read_at"', "messageId", "CHAT_GRACE_MS"]) expect(bundle, s).toContain(s);
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

  /** The clock of the fake runs: 2026-10-22 10:00 UTC. */
  const NOW = Date.UTC(2026, 9, 22, 10, 0, 0);

  function fake(rows: OutboxRow[], subs: Record<string, Subscription[]>, fail: Record<string, number>, read: Set<string> = new Set()) {
    const log = {
      sent: [] as string[],
      payloads: [] as string[],
      marked: [] as number[],
      failed: [] as number[],
      dropped: [] as string[],
      /** The read checks and the sends, in order (the check must come before the send). */
      asked: [] as string[],
      waited: [] as number[]
    };
    const deps: Deps = {
      pending: async () => rows,
      subscriptions: async (u) => subs[u] ?? [],
      send: async (s, payload) => {
        if (fail[s.endpoint]) throw Object.assign(new Error("push service"), { statusCode: fail[s.endpoint] });
        log.sent.push(s.endpoint);
        log.payloads.push(payload);
        log.asked.push(`send:${JSON.parse(payload).tag}`);
      },
      markSent: async (id) => void log.marked.push(id),
      markFailed: async (id) => void log.failed.push(id),
      dropSubscription: async (e) => void log.dropped.push(e),
      isMessageRead: async (messageId) => {
        log.asked.push(`read?:${messageId}`);
        return read.has(messageId);
      },
      now: () => NOW,
      wait: async (ms) => void log.waited.push(ms)
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
    expect(await dispatch(deps)).toEqual({ sent: 1, failed: 0, dropped: 0, skipped: 0 });
    expect(JSON.parse(log.payloads[0])).toEqual({
      title: "Can you help? Childcare",
      body: "Toria asks: Childcare Mon 12 Oct, 14:30–17:30 · Husarska 16. Open Siosia to take it.",
      tag: "appt_open:a11",
      url: "./?open=planned",
      kind: "appt_open"
    });
  });

  it("sends a chat message tagged by its room and opening that chat (FR-222, V48)", async () => {
    const { deps, log } = fake(
      [{ ...row(12, "roman", 1), kind: "chat_message", ride_id: "r1", params: { sender: "Toria", text: "Running 5 min late", room: "ride:r1" } }],
      { roman: [sub("https://push/r")] },
      {}
    );
    expect(await dispatch(deps)).toEqual({ sent: 1, failed: 0, dropped: 0, skipped: 0 });
    // kind and room ride along, so the service worker can hand the message to an open thread.
    expect(JSON.parse(log.payloads[0])).toEqual({ title: "Toria", body: "Running 5 min late", tag: "chat:ride:r1", url: "./?chat=ride:r1", kind: "chat_message", room: "ride:r1" });
    // An appointment room: appointment_id set for the outbox, the room still rules the tag and the URL.
    const appt = fake(
      [{ ...row(13, "siosia", 1), kind: "chat_message", ride_id: null, appointment_id: "a1", params: { sender: "Toria", text: "Hi", room: "appt:a1" } }],
      { siosia: [sub("https://push/s")] },
      {}
    );
    await dispatch(appt.deps);
    expect(JSON.parse(appt.log.payloads[0])).toMatchObject({ title: "Toria", body: "Hi", tag: "chat:appt:a1", url: "./?chat=appt:a1" });
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
    expect(await dispatch(deps)).toEqual({ sent: 1, failed: 1, dropped: 1, skipped: 0 });
    expect(log.sent).toEqual(["https://push/a", "https://push/b"]);
    expect(JSON.parse(log.payloads[0])).toEqual({ title: "Roman is on the way", body: "Your driver is heading to the pickup.", tag: "driver_coming:r1", url: "./", kind: "driver_coming" });
    expect(log.dropped).toEqual(["https://push/410"]);
    expect(log.failed).toEqual([3]); // tries again next run
    expect(log.marked).toEqual([1, 2, 4, 5]); // done: delivered, nobody left, out of attempts, no devices
    // No chat row: nothing waited for, nobody asked whether a message was read.
    expect(log.waited).toEqual([]);
    expect(log.asked.filter((a) => a.startsWith("read?"))).toEqual([]);
  });

  describe("2.3 chat messages: the 2 s grace and the read check (C6, V48)", () => {
    /** A chat row queued `ageMs` before the fake clock's now, with its message id in params (null = none). */
    const chat = (id: number, ageMs: number, messageId: string | null = `m${id}`, room = "ride:r1"): OutboxRow => ({
      ...row(id, "roman", 1),
      kind: "chat_message",
      ride_id: "r1",
      created_at: new Date(NOW - ageMs).toISOString(),
      params: { sender: "Toria", text: "Running 5 min late", room, ...(messageId ? { messageId } : {}) }
    });
    const subs = { roman: [sub("https://push/r")] };

    it("drops a message the recipient read meanwhile: marked done, nothing sent (belt and braces to the SQL)", async () => {
      const { deps, log } = fake([chat(21, 10_000)], subs, {}, new Set(["m21"]));
      expect(await dispatch(deps)).toEqual({ sent: 0, failed: 0, dropped: 0, skipped: 1 });
      expect(log.sent).toEqual([]);
      expect(log.marked).toEqual([21]); // done — not left for the next run
      expect(log.failed).toEqual([]);
      expect(log.asked).toEqual(["read?:m21"]);
    });

    it("sends an unread message, asking right before the send; a read one in the same batch is skipped", async () => {
      const { deps, log } = fake([chat(22, 10_000), chat(23, 10_000, "m23", "appt:a1"), chat(24, 10_000)], subs, {}, new Set(["m23"]));
      expect(await dispatch(deps)).toEqual({ sent: 2, failed: 0, dropped: 0, skipped: 1 });
      expect(log.asked).toEqual(["read?:m22", "send:chat:ride:r1", "read?:m23", "read?:m24", "send:chat:ride:r1"]);
      expect(log.marked).toEqual([22, 23, 24]);
      expect(JSON.parse(log.payloads[0])).toMatchObject({ title: "Toria", body: "Running 5 min late", tag: "chat:ride:r1", url: "./?chat=ride:r1", kind: "chat_message", room: "ride:r1" });
    });

    it("gives a fresh message the rest of its 2 s grace before asking, so a visible thread's mark-read lands first", async () => {
      expect(CHAT_GRACE_MS).toBe(2000);
      // Queued 300 ms ago: waits the remaining 1700 ms, then asks — and the answer (read meanwhile) counts.
      const fresh = fake([chat(31, 300)], subs, {}, new Set(["m31"]));
      expect(await dispatch(fresh.deps)).toEqual({ sent: 0, failed: 0, dropped: 0, skipped: 1 });
      expect(fresh.log.waited).toEqual([1700]);
      expect(fresh.log.asked).toEqual(["read?:m31"]);
      // Queued just now: the whole grace; still unread after it: sent.
      const now = fake([chat(32, 0)], subs, {});
      expect(await dispatch(now.deps)).toEqual({ sent: 1, failed: 0, dropped: 0, skipped: 0 });
      expect(now.log.waited).toEqual([2000]);
      // A row whose clock runs ahead of ours never waits longer than the grace.
      const ahead = fake([chat(33, -5000)], subs, {});
      await dispatch(ahead.deps);
      expect(ahead.log.waited).toEqual([2000]);
      // Older than the grace (a retried row, the minute sweep): no wait at all, asked at once.
      const old = fake([chat(34, 2000), chat(35, 60_000)], subs, {});
      expect(await dispatch(old.deps)).toEqual({ sent: 2, failed: 0, dropped: 0, skipped: 0 });
      expect(old.log.waited).toEqual([]);
      expect(old.log.asked).toEqual(["read?:m34", "send:chat:ride:r1", "read?:m35", "send:chat:ride:r1"]);
      // Rows claimed together: the waits of one run add up to about the grace, not to a grace per row.
      const batch = fake([chat(36, 1500), chat(37, 1000), chat(38, 500)], subs, {});
      await dispatch(batch.deps);
      expect(batch.log.waited).toEqual([500, 1000, 1500]); // the fake clock stands still; a real one would wait 500 + 500 + 500
    });

    it("waits with a real timer when none is injected", async () => {
      vi.useFakeTimers({ now: NOW });
      try {
        const { deps, log } = fake([chat(41, 0)], subs, {});
        delete deps.wait;
        delete deps.now;
        let settled = false;
        const run = dispatch(deps).then((r) => ((settled = true), r));
        await vi.advanceTimersByTimeAsync(1500);
        expect(settled).toBe(false);
        expect(log.asked).toEqual([]);
        await vi.advanceTimersByTimeAsync(600);
        expect(await run).toEqual({ sent: 1, failed: 0, dropped: 0, skipped: 0 });
        expect(log.asked).toEqual(["read?:m41", "send:chat:ride:r1"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("neither waits for nor asks about a message without an id, a row without created_at, or the other kinds", async () => {
      const noId = fake([chat(51, 10_000, null)], subs, {}, new Set(["m51"]));
      expect(await dispatch(noId.deps)).toEqual({ sent: 1, failed: 0, dropped: 0, skipped: 0 });
      expect(noId.log.asked).toEqual(["send:chat:ride:r1"]);
      const noStamp = fake([{ ...chat(52, 0), created_at: undefined }, { ...chat(53, 0), created_at: null }], subs, {});
      await dispatch(noStamp.deps);
      expect(noStamp.log.waited).toEqual([]);
      expect(noStamp.log.asked).toEqual(["read?:m52", "send:chat:ride:r1", "read?:m53", "send:chat:ride:r1"]);
      // Another kind with a messageId in its params (never happens) and a fresh created_at: untouched.
      const other = fake([{ ...row(54, "roman", 1), created_at: new Date(NOW).toISOString(), params: { driver: "Roman", messageId: "m54" } }], subs, {}, new Set(["m54"]));
      expect(await dispatch(other.deps)).toEqual({ sent: 1, failed: 0, dropped: 0, skipped: 0 });
      expect(other.log.waited).toEqual([]);
      expect(other.log.asked).toEqual(["send:driver_coming:r1"]);
      expect(JSON.parse(other.log.payloads[0])).not.toHaveProperty("room");
    });

    it("sends when the read check itself fails: the belt and braces never block a push", async () => {
      const { deps, log } = fake([chat(61, 10_000)], subs, {}, new Set(["m61"]));
      deps.isMessageRead = async () => {
        throw new Error("db down");
      };
      expect(await dispatch(deps)).toEqual({ sent: 1, failed: 0, dropped: 0, skipped: 0 });
      expect(log.marked).toEqual([61]);
    });
  });
});

describe("push service worker (public/push-sw.js): a chat message for a thread that is open goes to the window (FR-222, V48)", () => {
  const SCOPE = "https://siosia.example/";
  const CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
  const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
  const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

  type Posted = { type: string; room?: string; url?: string; title?: string; body?: string };
  interface FakeWindow {
    url: string;
    visibilityState: "visible" | "hidden";
    posted: Posted[];
    focus: () => Promise<FakeWindow>;
    postMessage: (msg: Posted, transfer?: Array<{ postMessage(d: unknown): void }>) => void;
  }
  /** A window of the app; `answer` is what it says to "siosia-chat-open?" (undefined = never answers). */
  const win = (visibilityState: "visible" | "hidden", answer?: boolean, url = `${SCOPE}?x=1`): FakeWindow => {
    const w: FakeWindow = {
      url,
      visibilityState,
      posted: [],
      focus: vi.fn(async () => w),
      postMessage: (msg, transfer) => {
        w.posted.push(msg);
        if (msg.type === "siosia-chat-open?" && answer !== undefined) transfer?.[0].postMessage({ open: answer });
      }
    };
    return w;
  };
  /** A MessageChannel whose answers arrive on the next microtask (deterministic under fake timers). */
  class FakeChannel {
    port1 = { onmessage: null as null | ((ev: { data: unknown }) => void), close: vi.fn() };
    port2 = { postMessage: (data: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
  }

  function loadWorker(userAgent: string, windows: FakeWindow[]) {
    const handlers: Record<string, (ev: unknown) => void> = {};
    const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
    const opened: string[] = [];
    const sw = {
      navigator: { userAgent },
      addEventListener: (type: string, fn: (ev: unknown) => void) => void (handlers[type] = fn),
      registration: { scope: SCOPE, showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => void shown.push({ title, options })) },
      clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async (url: string) => void opened.push(url)) }
    };
    new Function("self", readFileSync("public/push-sw.js", "utf-8"))(sw);
    /** Fires a push with this payload and returns what the worker asked to wait for. */
    const push = (payload: unknown): Promise<unknown> => {
      let waited: Promise<unknown> = Promise.resolve();
      handlers.push({
        data: { json: () => payload, text: () => JSON.stringify(payload) },
        waitUntil: (p: Promise<unknown>) => void (waited = p)
      });
      return waited;
    };
    const click = (url: string | undefined): Promise<unknown> => {
      let waited: Promise<unknown> = Promise.resolve();
      handlers.notificationclick({ notification: { close: vi.fn(), data: url === undefined ? undefined : { url } }, waitUntil: (p: Promise<unknown>) => void (waited = p) });
      return waited;
    };
    return { push, click, shown, opened, sw };
  }
  const chatPush = { title: "Toria", body: "Running 5 min late", tag: "chat:ride:r1", url: "./?chat=ride:r1", kind: "chat_message", room: "ride:r1" };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("hands the message to the visible window that says the room is open — no notification", async () => {
    vi.stubGlobal("MessageChannel", FakeChannel);
    const hidden = win("hidden", true);
    const open = win("visible", true);
    const { push, shown } = loadWorker(CHROME, [hidden, open]);
    await push(chatPush);
    expect(shown).toEqual([]);
    // Only visible windows are asked; the one that said yes gets the message (room, words, link).
    expect(hidden.posted).toEqual([]);
    expect(open.posted).toEqual([
      { type: "siosia-chat-open?", room: "ride:r1" },
      { type: "siosia-chat-message", room: "ride:r1", title: "Toria", body: "Running 5 min late", url: "./?chat=ride:r1" }
    ]);
  });

  it("shows when the visible windows say the room is not open, or show another room", async () => {
    vi.stubGlobal("MessageChannel", FakeChannel);
    const a = win("visible", false);
    const b = win("visible", false);
    const { push, shown } = loadWorker(CHROME, [a, b]);
    await push(chatPush);
    expect(a.posted).toEqual([{ type: "siosia-chat-open?", room: "ride:r1" }]);
    expect(b.posted).toEqual([{ type: "siosia-chat-open?", room: "ride:r1" }]);
    expect(shown).toEqual([
      {
        title: "Toria",
        options: { body: "Running 5 min late", tag: "chat:ride:r1", renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: "./?chat=ride:r1" } }
      }
    ]);
  });

  it("shows after ~300 ms when no window answers (an older app), and at once when none is visible", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MessageChannel", FakeChannel);
    const mute = win("visible");
    const { push, shown } = loadWorker(CHROME, [mute]);
    const done = push(chatPush);
    await vi.advanceTimersByTimeAsync(250);
    expect(shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(60);
    await done;
    expect(shown).toHaveLength(1);
    expect(mute.posted).toEqual([{ type: "siosia-chat-open?", room: "ride:r1" }]);
    // Hidden windows and foreign windows are never asked: the notification shows straight away.
    const hidden = win("hidden", true);
    const foreign = win("visible", true, "https://elsewhere.example/");
    const bg = loadWorker(CHROME, [hidden, foreign]);
    await bg.push(chatPush);
    expect(bg.shown).toHaveLength(1);
    expect(hidden.posted).toEqual([]);
    expect(foreign.posted).toEqual([]);
    const none = loadWorker(CHROME, []);
    await none.push(chatPush);
    expect(none.shown).toHaveLength(1);
  });

  it("iOS and Safari always show (a silent push costs the subscription there): the windows are not even asked", async () => {
    vi.stubGlobal("MessageChannel", FakeChannel);
    for (const ua of [IOS, MAC_SAFARI]) {
      const open = win("visible", true);
      const { push, shown, sw } = loadWorker(ua, [open]);
      await push(chatPush);
      expect(shown, ua).toHaveLength(1);
      expect(open.posted, ua).toEqual([]);
      expect(sw.clients.matchAll, ua).not.toHaveBeenCalled();
    }
    // Chrome on a Mac is not Safari.
    const open = win("visible", true);
    const mac = loadWorker(MAC_CHROME, [open]);
    await mac.push(chatPush);
    expect(mac.shown).toEqual([]);
    expect(open.posted).toHaveLength(2);
  });

  it("knows a chat push by its tag when the payload has no kind (older dispatch), and the other kinds show as always", async () => {
    vi.stubGlobal("MessageChannel", FakeChannel);
    const open = win("visible", true);
    const legacy = loadWorker(CHROME, [open]);
    await legacy.push({ title: "Toria", body: "Hi", tag: "chat:appt:a1", url: "./?chat=appt:a1" });
    expect(legacy.shown).toEqual([]);
    expect(open.posted[0]).toEqual({ type: "siosia-chat-open?", room: "appt:a1" });
    // A ride notification shows without a question, even with the thread open in a visible window.
    const other = win("visible", true);
    const ride = loadWorker(CHROME, [other]);
    await ride.push({ title: "Roman is on the way", body: "Your driver is heading to the pickup.", tag: "driver_coming:r1", url: "./", kind: "driver_coming" });
    expect(other.posted).toEqual([]);
    expect(ride.shown).toEqual([
      {
        title: "Roman is on the way",
        options: { body: "Your driver is heading to the pickup.", tag: "driver_coming:r1", renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: "./" } }
      }
    ]);
    // No payload / an unparsable one: the old fallbacks.
    const bare = loadWorker(CHROME, []);
    await bare.push(null);
    expect(bare.shown[0]).toEqual({ title: "Siosia", options: { body: "", tag: undefined, renotify: false, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: "./" } } });
  });

  it("a tap still focuses the open app with the link, or opens a window", async () => {
    const app = win("hidden");
    const { click, opened } = loadWorker(CHROME, [win("visible", undefined, "https://elsewhere.example/"), app]);
    await click("./?chat=ride:r1");
    expect(app.focus).toHaveBeenCalled();
    expect(app.posted).toEqual([{ type: "siosia-open", url: `${SCOPE}?chat=ride:r1` }]);
    expect(opened).toEqual([]);
    const closed = loadWorker(CHROME, []);
    await closed.click(undefined);
    expect(closed.opened).toEqual([SCOPE]);
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

describe("2.5 session update and heading-home texts (FR-232, FR-241, V55, V56)", () => {
  const TZ = "Europe/Warsaw";

  it("names the kid or the service, keeps the words, marks a photo, tags per appointment and opens C3", () => {
    expect(pushText("session_update", { sender: "Siosia", text: "Zosia is drawing", kid: "Zosia", photo: false, service: "Childcare" }, "en", TZ, "a1")).toEqual({
      title: "Siosia · Zosia",
      body: "Zosia is drawing",
      tag: "update:a1"
    });
    expect(pushText("session_update", { sender: "Siosia", text: "Snack time", kid: null, photo: true, service: "Opieka nad dziećmi" }, "pl", TZ, "a1")).toEqual({
      title: "Siosia · Opieka nad dziećmi",
      body: "Snack time 📷",
      tag: "update:a1"
    });
    expect(pushText("session_update", { sender: "Siosia", text: "", photo: true, service: "Opieka" }, "pl", TZ, "a1").body).toBe("📷 Zdjęcie");
    expect(pushText("session_update", { sender: "Siosia", text: "", photo: true }, "en", TZ, "a1").body).toBe("📷 Photo");
    // The author's own words, cut like a chat message; no nickname → Someone.
    expect(pushText("session_update", { text: "x".repeat(100) }, "en", TZ, "a1")).toEqual({ title: "Someone", body: "x".repeat(80) + "…", tag: "update:a1" });
    expect(pushText("session_update", { sender: "Siosia", text: "  Wait...  \n .ok " }, "en", TZ, "a1").body).toBe("Wait... .ok");
    expect(openUrl("session_update", {}, "a1")).toBe("./?appointment=a1");
    expect(openUrl("client_coming", {}, "a1")).toBe("./?appointment=a1");
    expect(openUrl("client_coming", {})).toBe("./?open=planned");
    expect(openUrl("chat_message", { room: "appt:a1" }, "a1")).toBe("./?chat=appt:a1"); // unchanged
  });

  it("says the client is heading home with the minutes and the time, in both languages", () => {
    const eta = Date.UTC(2026, 9, 23, 15, 40); // 17:40 in Warsaw (CEST)
    expect(pushText("client_coming", { client: "Toria", minutes: 25, etaAt: eta, service: "Childcare" }, "en", TZ, "a1")).toEqual({
      title: "Toria is heading home",
      body: "About 25 min — around 17:40.",
      tag: "coming:a1"
    });
    expect(pushText("client_coming", { client: "Toria", minutes: 25, etaAt: new Date(eta).toISOString() }, "pl", TZ, "a1")).toEqual({
      title: "Toria wraca do domu",
      body: "Za około 25 min — na miejscu ok. 17:40.",
      tag: "coming:a1"
    });
    expect(pushText("client_coming", { minutes: 0, etaAt: eta }, "en", TZ, "a1").title).toBe("Someone is heading home");
  });
});

describe("2.6 family, contract, summary and weekly report texts (FR-250–282)", () => {
  const TZ = "Europe/Warsaw";
  it("tells the family and contract news by name, opening the Family panel", () => {
    expect(pushText("family_invite", { sender: "Roman" }, "en", TZ)).toEqual({
      title: "Roman invites you to their family",
      body: "Share kids and appointments. Open Siosia to join.",
      tag: "family"
    });
    expect(pushText("family_joined", { sender: "Anna" }, "pl", TZ).title).toBe("Anna dołącza do Twojej rodziny");
    expect(pushText("contract_proposed", { sender: "Toria" }, "en", TZ)).toMatchObject({ title: "Toria proposes a contract", tag: "contract" });
    expect(pushText("contract_accepted", { sender: "Toria" }, "pl", TZ).title).toBe("Toria akceptuje umowę");
    expect(pushText("contract_declined", { sender: "Toria" }, "en", TZ).body).toBe("Nothing changes; you can propose other rates.");
    expect(pushText("contract_ended", {}, "en", TZ).title).toBe("Someone ended the contract");
    for (const k of ["family_invite", "family_joined", "contract_proposed", "contract_accepted", "contract_declined", "contract_ended"] as const) expect(openUrl(k)).toBe("./?open=family");
  });

  it("sums up a done appointment — time and total in the locale's money — tagged per appointment, opening C3", () => {
    const p = { serviceId: "childcare", service: "Childcare", at: AT, minutes: 210, total: 140, currency: "PLN", provider: "Toria", client: "Roman" };
    expect(pushText("appt_summary", p, "en", TZ, "a1")).toEqual({ title: "Summary: Childcare Mon 12 Oct, 14:30", body: "3 h 30 min · 140.00 PLN", tag: "summary:a1" });
    expect(pushText("appt_summary", { ...p, corrected: true, minutes: 240, total: 160, service: "Opieka nad dziećmi" }, "pl", TZ, "a1").body).toBe("4 godz. · 160,00 PLN (czas poprawiony)");
    expect(openUrl("appt_summary", {}, "a1")).toBe("./?appointment=a1");
  });

  it("sends the week's spent and earned, tagged and opened by its Monday", () => {
    const p = { spent: 240, earned: 90.5, currency: "PLN", week: "2026-10-19" };
    expect(pushText("weekly_report", p, "en", TZ)).toEqual({ title: "Your week in Siosia", body: "Last week: spent 240.00 PLN · earned 90.50 PLN.", tag: "report:2026-10-19" });
    expect(pushText("weekly_report", p, "pl", TZ).body).toBe("Ostatni tydzień: wydane 240,00 PLN · zarobione 90,50 PLN.");
    expect(openUrl("weekly_report", p)).toBe("./?open=report&week=2026-10-19");
  });

  it("ships the 2.6 kinds and their URLs in the push-dispatch bundle (B8)", () => {
    const bundle = readFileSync("supabase/functions/push-dispatch/dist-bundle.ts", "utf-8");
    for (const s of ["family_invite", "contract_proposed", "appt_summary", "weekly_report", "./?open=family", "./?open=report"]) expect(bundle).toContain(s);
  });
});
