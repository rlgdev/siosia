// Calendar export (FR-135, FR-136; V27, V28, NFR-20): the shared .ics module, the Google link and
// the calendar function's request handling.

import { describe, expect, it, vi } from "vitest";
import {
  appointmentGoogleLink,
  appointmentIcs,
  escapeText,
  fold,
  rideGoogleLink,
  rideIcs,
  seriesIcs,
  type IcsAppointment,
  type IcsContext,
  type IcsRide
} from "../../supabase/functions/_shared/ics";
import { handleCalendar, type CalendarView } from "../../supabase/functions/calendar/handler";

const CTX: IcsContext = { lang: "en", timezone: "Europe/Warsaw", reminderMin: [1440, 120], siteUrl: "https://rlgdev.github.io/siosia/", now: Date.UTC(2026, 9, 20, 10, 0) };
// Tue 20 Oct 2026 16:00 in Warsaw (CEST, UTC+2) = 14:00Z.
const START = Date.UTC(2026, 9, 20, 14, 0);
const WEEK = 7 * 86_400_000;

function appt(over: Partial<IcsAppointment> = {}): IcsAppointment {
  return {
    id: "6f1c1d2e-0000-4000-8000-000000000001",
    status: "accepted",
    role: "client",
    serviceId: "childcare",
    service: { name: { en: "Childcare", pl: "Opieka nad dziećmi" }, icon: "🧸" },
    startsAt: START,
    endsAt: START + 3600_000,
    durationMin: 60,
    place: { lat: 52.2297, lng: 21.0122, label: "Warszawska 269, Ożarów" },
    note: "Kids back at 14:30; snack in the fridge",
    client: { nickname: "Toria" },
    provider: { nickname: "Siosia" },
    rides: [{ leg: "there", status: "confirmed", driver: { nickname: "Roman" } }],
    series: null,
    ...over
  };
}

const RIDE: IcsRide = {
  id: "6f1c1d2e-0000-4000-8000-0000000000aa",
  status: "scheduled",
  role: "rider",
  pickup: { lat: 52.25, lng: 20.82, label: "Home" },
  dropoff: { lat: 52.23, lng: 21.01, label: "School" },
  scheduledFor: START - 30 * 60_000,
  requestedAt: START - WEEK,
  estMin: 22,
  fare: 41.5,
  currency: "PLN",
  rider: { nickname: "Toria" },
  driver: { nickname: "Roman", vehicle: { make: "Porsche", model: "Taycan", colour: "Green", plate: "W1 LLRUN" } }
};

/** Unfolded content lines. */
const lines = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n");

describe(".ics (V27)", () => {
  it("writes one appointment: UID, summary, UTC times, place, description, link, alarms, status", () => {
    const ics = appointmentIcs(appt(), CTX);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    const l = lines(ics);
    expect(l).toEqual(expect.arrayContaining(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "END:VEVENT", "END:VCALENDAR"]));
    expect(l).toContain("UID:6f1c1d2e-0000-4000-8000-000000000001");
    expect(l).toContain("SUMMARY:Childcare with Siosia");
    expect(l).toContain("DTSTART:20261020T140000Z");
    expect(l).toContain("DTEND:20261020T150000Z");
    expect(l).toContain("LOCATION:Warszawska 269\\, Ożarów");
    expect(l).toContain("GEO:52.229700;21.012200");
    const desc = l.find((x) => x.startsWith("DESCRIPTION:"))!;
    expect(desc).toContain("With Siosia\\nConfirmed\\nNote: Kids back at 14:30\\; snack in the fridge\\nRide there: Roman ✓");
    expect(desc).toContain("Open in Siosia: https://rlgdev.github.io/siosia/?open=planned");
    expect(l).toContain("URL:https://rlgdev.github.io/siosia/?open=planned");
    expect(l).toContain("STATUS:CONFIRMED");
    expect(l.filter((x) => x.startsWith("TRIGGER:"))).toEqual(["TRIGGER:-PT1440M", "TRIGGER:-PT120M"]);
  });

  it("marks a cancelled appointment CANCELLED without alarms, a requested one TENTATIVE; Polish words", () => {
    const cancelled = lines(appointmentIcs(appt({ status: "cancelled" }), CTX));
    expect(cancelled).toContain("STATUS:CANCELLED");
    expect(cancelled.some((x) => x.startsWith("BEGIN:VALARM"))).toBe(false);
    expect(lines(appointmentIcs(appt({ status: "requested" }), CTX))).toContain("STATUS:TENTATIVE");
    const pl = lines(appointmentIcs(appt({ role: "provider" }), { ...CTX, lang: "pl" }));
    expect(pl).toContain("SUMMARY:Opieka nad dziećmi — Toria");
    expect(pl.find((x) => x.startsWith("DESCRIPTION:"))).toContain("Dla: Toria\\nPotwierdzone");
    expect(pl.find((x) => x.startsWith("DESCRIPTION:"))).toContain("Przejazd tam: Roman ✓");
  });

  it("writes a series as one event in local time with RRULE, EXDATEs and the time zone across the DST change", () => {
    const starts = [0, 1, 2, 3].map((i) => START + i * WEEK + (i > 0 ? 3600_000 : 0)); // 16:00 local: 14:00Z, then 15:00Z after 25 Oct
    const a = appt({ series: { id: "6f1c1d2e-0000-4000-8000-0000000000ss", rule: "weekly", count: 4, status: "answered", starts, gaps: [starts[2]] } });
    const l = lines(seriesIcs(a, CTX));
    expect(l).toContain("UID:6f1c1d2e-0000-4000-8000-0000000000ss");
    expect(l).toContain("DTSTART;TZID=Europe/Warsaw:20261020T160000");
    expect(l).toContain("DTEND;TZID=Europe/Warsaw:20261020T170000");
    expect(l).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=4");
    expect(l).toContain("EXDATE;TZID=Europe/Warsaw:20261103T160000");
    // VTIMEZONE: summer time, then winter time from 25 Oct 03:00 local.
    const tz = l.slice(l.indexOf("BEGIN:VTIMEZONE"), l.indexOf("END:VTIMEZONE") + 1);
    expect(tz).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Warsaw",
      "BEGIN:DAYLIGHT",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0200",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:20261025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE"
    ]);
    expect(l.filter((x) => x.startsWith("TRIGGER:"))).toHaveLength(2);
    const biweekly = lines(seriesIcs({ ...a, series: { ...a.series!, rule: "biweekly", gaps: starts } }, CTX));
    expect(biweekly).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4");
    expect(biweekly).toContain("STATUS:CANCELLED"); // every date gone
  });

  it("writes a booked ride with one alarm 30 min before; the rider sees the car, the driver the rider", () => {
    const l = lines(rideIcs(RIDE, CTX));
    expect(l).toContain("SUMMARY:Ride: Home → School");
    expect(l).toContain("DTSTART:20261020T133000Z");
    expect(l).toContain("DTEND:20261020T135200Z");
    expect(l.filter((x) => x.startsWith("TRIGGER:"))).toEqual(["TRIGGER:-PT30M"]);
    expect(l.find((x) => x.startsWith("DESCRIPTION:"))).toContain("Driver: Roman · Green Porsche Taycan · W1 LLRUN\\nFare: 41.50 PLN");
    expect(lines(rideIcs({ ...RIDE, role: "driver" }, CTX)).find((x) => x.startsWith("DESCRIPTION:"))).toContain("Rider: Toria");
    expect(lines(rideIcs({ ...RIDE, status: "cancelled" }, CTX))).toContain("STATUS:CANCELLED");
  });

  it("carries no user ids, public ids or positions other than the place (NFR-20)", () => {
    const view = { ...appt(), client: { nickname: "Toria", publicId: "pub-toria", userId: "uid-1" }, rides: [{ leg: "there", status: "pending", driver: null, pickup: { lat: 52.987654, lng: 20.123456, label: "x" } }] };
    const ics = appointmentIcs(view as IcsAppointment, CTX);
    expect(ics).not.toContain("pub-toria");
    expect(ics).not.toContain("uid-1");
    expect(ics).not.toContain("52.98");
  });

  it("escapes text and folds long lines at 75 octets without splitting a character", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const long = "DESCRIPTION:" + "Żółć ".repeat(40);
    const folded = fold(long);
    expect(folded.split("\r\n").every((x) => new TextEncoder().encode(x).length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });
});

describe("Google Calendar link (V28)", () => {
  it("prefills title, local dates with the time zone, place, details and, for a series, the rule", () => {
    const u = new URL(appointmentGoogleLink(appt(), CTX));
    expect(u.origin + u.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(u.searchParams.get("action")).toBe("TEMPLATE");
    expect(u.searchParams.get("text")).toBe("Childcare with Siosia");
    expect(u.searchParams.get("dates")).toBe("20261020T160000/20261020T170000");
    expect(u.searchParams.get("ctz")).toBe("Europe/Warsaw");
    expect(u.searchParams.get("location")).toBe("Warszawska 269, Ożarów");
    expect(u.searchParams.get("details")).toContain("Ride there: Roman ✓");
    expect(u.searchParams.get("details")).toContain("?open=planned");
    expect(u.searchParams.get("recur")).toBeNull();
    const series = appt({ series: { id: "s", rule: "biweekly", count: 6, status: "answered", starts: [START], gaps: [] } });
    expect(new URL(appointmentGoogleLink(series, CTX, true)).searchParams.get("recur")).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=6");
    const ride = new URL(rideGoogleLink(RIDE, { ...CTX, lang: "pl" }));
    expect(ride.searchParams.get("text")).toBe("Przejazd: Home → School");
    expect(ride.searchParams.get("dates")).toBe("20261020T153000/20261020T155200");
  });
});

describe("calendar function (FR-136, NFR-20)", () => {
  const ID = "6f1c1d2e-0000-4000-8000-000000000001";
  const T = "0123456789abcdef0123456789abcdef";
  const view: CalendarView = { kind: "a", lang: "en", timezone: "Europe/Warsaw", reminderMin: [1440, 120], siteUrl: null, view: appt() };

  it("serves the viewer's .ics for a valid link", async () => {
    const read = vi.fn(async () => view);
    const res = await handleCalendar(new Request(`https://x.supabase.co/functions/v1/calendar?a=${ID}&u=pub-toria1&t=${T}`), read);
    expect(read).toHaveBeenCalledWith("a", ID, "pub-toria1", T);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("SUMMARY:Childcare with Siosia");
    const series = await handleCalendar(new Request(`https://x/calendar?s=${ID}&u=pub-toria1&t=${T}`), async () => ({ ...view, kind: "s" as const }));
    expect(await series.text()).not.toContain("RRULE:"); // a view without a series falls back to one event
  });

  it("answers 404 to a wrong token or a non-party (null from the database) and to malformed links, without reading", async () => {
    const read = vi.fn(async () => null);
    expect((await handleCalendar(new Request(`https://x/calendar?a=${ID}&u=pub-toria1&t=${T}`), read)).status).toBe(404);
    const never = vi.fn(async () => view);
    for (const q of [`a=${ID}&u=pub-toria1`, `a=nope&u=pub-toria1&t=${T}`, `u=pub-toria1&t=${T}`, `a=${ID}&u=x&t=${T}`, `a=${ID}&u=pub-toria1&t=XYZ`]) {
      expect((await handleCalendar(new Request(`https://x/calendar?${q}`), never)).status).toBe(404);
    }
    expect(never).not.toHaveBeenCalled();
    expect((await handleCalendar(new Request(`https://x/calendar?a=${ID}&u=pub-toria1&t=${T}`, { method: "POST" }), never)).status).toBe(405);
    expect((await handleCalendar(new Request(`https://x/calendar?a=${ID}&u=pub-toria1&t=${T}`), async () => Promise.reject(new Error("db")))).status).toBe(503);
  });
});
