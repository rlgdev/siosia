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

  it("names the attached kids to the provider only, in the words of the pushes (2.3, FR-202)", () => {
    const kids = [
      { id: "kid-1", name: "Zosia" },
      { id: "kid-2", name: "Kuba" }
    ];
    const desc = (l: string[]) => l.find((x) => x.startsWith("DESCRIPTION:"))!;
    const prov = lines(appointmentIcs(appt({ role: "provider", kids }), CTX));
    expect(desc(prov)).toContain("For Toria\\nWith Zosia and Kuba\\nConfirmed");
    expect(desc(lines(appointmentIcs(appt({ role: "provider", kids }), { ...CTX, lang: "pl" })))).toContain("Dla: Toria\\nZ: Zosia i Kuba\\nPotwierdzone");
    expect(desc(lines(appointmentIcs(appt({ role: "provider", kids: [kids[0]] }), CTX)))).toContain("For Toria\\nWith Zosia\\nConfirmed");
    // The client's own kids are not repeated to them; a candidate gets none (FR-202); never a kid id (NFR-20).
    expect(appointmentIcs(appt({ kids }), CTX)).not.toContain("Zosia");
    expect(appointmentIcs(appt({ role: "candidate", provider: null, status: "requested", kids: [] }), CTX)).not.toContain("With ");
    expect(prov.join("\n")).not.toContain("kid-1");
    // The series event and the Google link carry the same line.
    const series = { id: "6f1c1d2e-0000-4000-8000-0000000000ss", rule: "weekly" as const, count: 2, status: "answered", starts: [START, START + WEEK], gaps: [] };
    expect(desc(lines(seriesIcs(appt({ role: "provider", kids, series }), CTX)))).toContain("For Toria\\nWith Zosia and Kuba\\nConfirmed");
    expect(new URL(appointmentGoogleLink(appt({ role: "provider", kids }), CTX)).searchParams.get("details")).toContain("For Toria\nWith Zosia and Kuba\nConfirmed");
    // Nobody attached, or a view without the field: the 2.0 description, unchanged.
    expect(desc(lines(appointmentIcs(appt({ role: "provider", kids: [] }), CTX)))).toContain("For Toria\\nConfirmed");
    expect(desc(lines(appointmentIcs(appt({ role: "provider" }), CTX)))).toContain("For Toria\\nConfirmed");
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

  it("keeps user text inside its own content line: every line break escaped, controls dropped (C15)", () => {
    const evil = appt({
      note: "x\rURL:https://evil.example\rBEGIN:VEVENT",
      place: { lat: 52.2297, lng: 21.0122, label: "Home\u2028GEO:1;1" },
      provider: { nickname: "Sio\u0085STATUS:CANCELLED\u2029sia\x00\x1b\x7f\tX" }
    });
    const series = { ...evil, series: { id: "6f1c1d2e-0000-4000-8000-0000000000ss", rule: "weekly" as const, count: 2, status: "answered", starts: [START, START + WEEK], gaps: [] } };
    const car = { make: "Porsche", model: "Taycan\nEND:VEVENT", colour: "Green", plate: "W1\r\nBEGIN:VEVENT\rUID:x" };
    const ride = { ...RIDE, pickup: { ...RIDE.pickup, label: "Home\rURL:https://evil.example" }, driver: { nickname: "Roman", vehicle: car } };
    for (const ics of [appointmentIcs(evil, CTX), seriesIcs(series, CTX), rideIcs(ride, CTX)]) {
      // Read as the most lenient reader would: a line ends at any line break.
      const l = ics.replace(/\r\n /g, "").split(/\r\n|[\r\n\u0085\u2028\u2029]/);
      expect(l.filter((x) => x === "BEGIN:VEVENT")).toHaveLength(1);
      expect(l.filter((x) => x === "END:VEVENT")).toHaveLength(1);
      expect(l.filter((x) => x.startsWith("URL:"))).toEqual(["URL:https://rlgdev.github.io/siosia/?open=planned"]);
      expect(l.filter((x) => x.startsWith("UID:"))).toHaveLength(1);
      expect(l.filter((x) => x.startsWith("STATUS:"))).toEqual(["STATUS:CONFIRMED"]);
      expect(l.filter((x) => x.startsWith("GEO:"))).toHaveLength(1);
      // CR and LF only as CRLF line ends; no other control character or Unicode line break.
      expect(/\r(?!\n)|(?<!\r)\n/.test(ics)).toBe(false);
      // eslint-disable-next-line no-control-regex -- looking for control characters
      expect(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f\u0085\u2028\u2029]/.test(ics)).toBe(false);
    }
    const l = lines(appointmentIcs(evil, CTX));
    expect(l.find((x) => x.startsWith("DESCRIPTION:"))).toContain("Note: x\\nURL:https://evil.example\\nBEGIN:VEVENT");
    expect(l).toContain("LOCATION:Home\\nGEO:1\\;1");
    expect(l).toContain("SUMMARY:Childcare with Sio\\nSTATUS:CANCELLED\\nsia X");
    expect(escapeText("a\r\nb\rc\nd\u0085e\u2028f\u2029g\x00\x08\x0b\x1b\x7fh\ti")).toBe("a\\nb\\nc\\nd\\ne\\nf\\ngh i");
  });

  it("writes no GEO line for a place missing a coordinate, no LOCATION without a label", () => {
    const l = lines(appointmentIcs(appt({ place: { lat: 52.2297, lng: null as unknown as number, label: "Warszawska 269" } }), CTX));
    expect(l).toContain("LOCATION:Warszawska 269");
    expect(l.some((x) => x.startsWith("GEO:"))).toBe(false);
    const nan = lines(rideIcs({ ...RIDE, pickup: { lat: Number.NaN, lng: 20.82, label: null as unknown as string } }, CTX));
    expect(nan.some((x) => x.startsWith("GEO:") || x.startsWith("LOCATION:"))).toBe(false);
    expect(nan).toContain("STATUS:CONFIRMED");
  });

  it("gives a series the series' status, not the representative date's (C4)", () => {
    const series = (status: string, gaps: number[] = []) => ({ id: "6f1c1d2e-0000-4000-8000-0000000000ss", rule: "weekly" as const, count: 3, status, starts: [START, START + WEEK, START + 2 * WEEK], gaps });
    const desc = (l: string[]) => l.find((x) => x.startsWith("DESCRIPTION:"))!;
    // The first date clashed and was declined; the rest of the series is confirmed.
    const declinedFirst = appt({ status: "declined", series: series("answered", [START]) });
    for (const view of [declinedFirst, { ...declinedFirst, status: "cancelled" }]) {
      const l = lines(seriesIcs(view, CTX));
      expect(desc(l)).toContain("With Siosia\\nConfirmed");
      expect(desc(l)).not.toContain("Cancelled");
      expect(l).toContain("STATUS:CONFIRMED");
      expect(l.filter((x) => x.startsWith("TRIGGER:"))).toHaveLength(2);
      expect(new URL(appointmentGoogleLink(view, CTX, true)).searchParams.get("details")).toContain("With Siosia\nConfirmed");
    }
    // Not answered yet: waiting for the client, answer for the provider; tentative.
    const asked = lines(seriesIcs(appt({ status: "requested", series: series("requested") }), CTX));
    expect(desc(asked)).toContain("With Siosia\\nWaiting for an answer from Siosia");
    expect(asked).toContain("STATUS:TENTATIVE");
    expect(desc(lines(seriesIcs(appt({ role: "provider", status: "requested", series: series("requested") }), CTX)))).toContain("For Toria\\nPlease answer");
    // Every date gone, or the series cancelled: cancelled, even when the view's date was accepted.
    for (const view of [appt({ series: series("answered", [START, START + WEEK, START + 2 * WEEK]) }), appt({ series: series("cancelled") })]) {
      const l = lines(seriesIcs(view, CTX));
      expect(desc(l)).toContain("With Siosia\\nCancelled");
      expect(l).toContain("STATUS:CANCELLED");
      expect(l.some((x) => x.startsWith("BEGIN:VALARM"))).toBe(false);
    }
  });

  it("writes an open request (no provider) without crashing: its own title, open in the details (V37)", () => {
    const desc = (l: string[]) => l.find((x) => x.startsWith("DESCRIPTION:"))!;
    const open = appt({ status: "requested", provider: null, rides: [] });
    const l = lines(appointmentIcs(open, CTX));
    expect(l).toContain("SUMMARY:Childcare — open request");
    expect(desc(l)).toContain("DESCRIPTION:Open request: anyone in the group can take it\\nWaiting for someone to take it\\nNote: ");
    expect(l).toContain("STATUS:TENTATIVE");
    expect(l.filter((x) => x.startsWith("TRIGGER:"))).toHaveLength(2);
    const pl = lines(appointmentIcs(open, { ...CTX, lang: "pl" }));
    expect(pl).toContain("SUMMARY:Opieka nad dziećmi — otwarta prośba");
    expect(desc(pl)).toContain("Otwarta prośba: może się jej podjąć każdy w grupie\\nCzeka\\, aż ktoś się podejmie");
    // A candidate (a member who could take it) reads whose request it is.
    expect(desc(lines(appointmentIcs({ ...open, role: "candidate" }, CTX)))).toContain("For Toria\\nOpen request: anyone in the group can take it\\nWaiting for someone to take it");
    // Expired unanswered: cancelled, no alarms, still no provider.
    const expired = lines(appointmentIcs({ ...open, status: "expired" }, CTX));
    expect(expired).toContain("STATUS:CANCELLED");
    expect(desc(expired)).toContain("Open request: anyone in the group can take it\\nCancelled");
    expect(expired.some((x) => x.startsWith("BEGIN:VALARM"))).toBe(false);
    for (const ics of [appointmentIcs(open, CTX), appointmentIcs({ ...open, role: "provider" }, CTX)]) expect(ics).not.toMatch(/undefined|null|With \\n/);
  });

  it("writes an open series and its Google links without a provider", () => {
    const starts = [START, START + WEEK, START + 2 * WEEK];
    const open = appt({ status: "requested", provider: null, rides: [], series: { id: "6f1c1d2e-0000-4000-8000-0000000000ss", rule: "weekly", count: 3, status: "requested", starts, gaps: [] } });
    const l = lines(seriesIcs(open, CTX));
    expect(l).toContain("SUMMARY:Childcare — open request");
    expect(l).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=3");
    expect(l).toContain("STATUS:TENTATIVE");
    expect(l.find((x) => x.startsWith("DESCRIPTION:"))).toContain("Open request: anyone in the group can take it\\nWaiting for someone to take it");
    for (const whole of [false, true]) {
      const u = new URL(appointmentGoogleLink(open, CTX, whole));
      expect(u.searchParams.get("text")).toBe("Childcare — open request");
      expect(u.searchParams.get("details")).toContain("Open request: anyone in the group can take it\nWaiting for someone to take it");
      expect(u.searchParams.get("details")).not.toMatch(/undefined|null/);
    }
    // Taken: the provider is back and the words are the 2.0 ones.
    expect(lines(seriesIcs({ ...open, provider: { nickname: "Ewa" }, series: { ...open.series!, status: "answered" } }, CTX))).toContain("SUMMARY:Childcare with Ewa");
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

  it("serves the client's .ics of an open request (provider null from the database)", async () => {
    const open = { ...view, view: appt({ status: "requested", provider: null, rides: [] }) };
    for (const kind of ["a", "s"] as const) {
      const res = await handleCalendar(new Request(`https://x/calendar?${kind}=${ID}&u=pub-toria1&t=${T}`), async () => ({ ...open, kind }));
      expect(res.status).toBe(200);
      const l = lines(await res.text());
      expect(l).toContain("SUMMARY:Childcare — open request");
      expect(l).toContain("STATUS:TENTATIVE");
    }
  });

  it("serves a valid .ics for a place with a missing coordinate; a view it cannot write is a plain 500", async () => {
    const noLng = { ...view, view: appt({ place: { lat: 52.2297, lng: null as unknown as number, label: "Warszawska 269" } }) };
    for (const kind of ["a", "s"] as const) {
      const res = await handleCalendar(new Request(`https://x/calendar?${kind}=${ID}&u=pub-toria1&t=${T}`), async () => ({ ...noLng, kind }));
      expect(res.status).toBe(200);
      const l = lines(await res.text());
      expect(l[0]).toBe("BEGIN:VCALENDAR");
      expect(l).toContain("LOCATION:Warszawska 269");
      expect(l.some((x) => x.startsWith("GEO:"))).toBe(false);
      expect(l.filter((x) => x === "END:VCALENDAR")).toHaveLength(1);
    }
    const broken = { ...view, kind: "r" as const, view: { ...RIDE, fare: null as unknown as number } };
    const res = await handleCalendar(new Request(`https://x/calendar?r=${ID}&u=pub-toria1&t=${T}`), async () => broken);
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("unavailable");
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
