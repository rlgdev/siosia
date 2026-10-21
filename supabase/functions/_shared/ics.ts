// Calendar export (FR-135, FR-136; V27, V28): the .ics of an appointment, a series or a booked ride
// as one viewer may see it (FR-114), and the Google Calendar template link. One module for the
// Edge Function "calendar", the demo's in-browser download and the app, so all three agree; the
// words are those of the notifications (push-text). Positions and user ids never go in.
// 2.1: an open request has no provider yet; every function here reads it as such (V37).
//
// Single events are written in UTC. A series is one VEVENT with an RRULE: its start is written as
// local time with the deployment's TZID (and a VTIMEZONE), so every date keeps its wall-clock time
// across a daylight-saving change, as the series itself does (§7 wall-clock rule).

import { apptStatusText, rideLineText } from "./push-text.ts";

type Lang = "en" | "pl";

export interface IcsPlace {
  lat: number;
  lng: number;
  label: string;
}

export interface IcsAppointment {
  id: string;
  status: string;
  /** 2.1: "candidate" = a member who could take an open request. */
  role: "client" | "provider" | "candidate";
  serviceId: string;
  service: { name: { en: string; pl: string }; icon: string } | null;
  startsAt: number;
  endsAt: number;
  durationMin: number;
  place: IcsPlace | null;
  note: string;
  client: { nickname: string };
  /** null while the request is open (2.1: nobody took it yet). */
  provider: { nickname: string } | null;
  rides: { leg: string; status: string; driver: { nickname: string } | null }[];
  series: { id: string; rule: "weekly" | "biweekly"; count: number; status: string; starts: number[]; gaps: number[] } | null;
}

export interface IcsRide {
  id: string;
  status: string;
  role: "rider" | "driver";
  pickup: IcsPlace;
  dropoff: IcsPlace;
  scheduledFor: number | null;
  requestedAt: number;
  estMin: number;
  fare: number;
  currency: string;
  rider: { nickname: string };
  driver: { nickname: string; vehicle?: { make: string; model: string; colour: string; plate: string } | null } | null;
}

export interface IcsContext {
  lang: string;
  /** The deployment's IANA time zone. */
  timezone: string;
  /** Appointment reminder slots in minutes before the start. */
  reminderMin: number[];
  /** The app's address, for the link back (?open=planned). */
  siteUrl: string | null;
  /** DTSTAMP (tests pass a fixed one). */
  now?: number;
}

const RIDE_ALARM_MIN = 30;

const lng = (l: string): Lang => (l === "pl" ? "pl" : "en");

// ---------------------------------------------------------------- words

const W = {
  en: {
    with: (s: string, o: string) => `${s} with ${o}`,
    openTitle: (s: string) => `${s} — open request`,
    openLine: "Open request: anyone in the group can take it",
    ride: (a: string, b: string) => `Ride: ${a} → ${b}`,
    withWho: (n: string) => `With ${n}`,
    forWho: (n: string) => `For ${n}`,
    driver: (n: string) => `Driver: ${n}`,
    rider: (n: string) => `Rider: ${n}`,
    noDriver: "No driver yet",
    fare: "Fare",
    cancelled: "Cancelled",
    open: "Open in Siosia",
    note: "Note"
  },
  pl: {
    with: (s: string, o: string) => `${s} — ${o}`,
    openTitle: (s: string) => `${s} — otwarta prośba`,
    openLine: "Otwarta prośba: może się jej podjąć każdy w grupie",
    ride: (a: string, b: string) => `Przejazd: ${a} → ${b}`,
    withWho: (n: string) => `Z: ${n}`,
    forWho: (n: string) => `Dla: ${n}`,
    driver: (n: string) => `Kierowca: ${n}`,
    rider: (n: string) => `Pasażer: ${n}`,
    noDriver: "Jeszcze bez kierowcy",
    fare: "Cena",
    cancelled: "Odwołane",
    open: "Otwórz w Siosi",
    note: "Notatka"
  }
} as const;

const serviceName = (a: IcsAppointment, l: Lang) => a.service?.name[l] || a.service?.name.en || a.serviceId;
/** Nobody took it yet (2.1): no provider. */
const isOpen = (a: IcsAppointment) => !a.provider;
const other = (a: IcsAppointment) => (a.role === "client" ? (a.provider?.nickname ?? "") : a.client.nickname);
const link = (ctx: IcsContext) => (ctx.siteUrl ? `${bare(ctx.siteUrl).replace(/[?#].*$/, "")}?open=planned` : null);
const gone = (status: string) => status === "cancelled" || status === "declined" || status === "expired";
const icsStatus = (status: string) => (gone(status) ? "CANCELLED" : status === "requested" ? "TENTATIVE" : "CONFIRMED");

/** A series as its one calendar event: the status is the series' own (every date gone → cancelled,
 *  not answered yet → requested, else confirmed), never that of the occurrence the view was read
 *  from, which may be a declined clash or a cancelled date of a live series (C4). No ride lines. */
function asSeries(a: IcsAppointment): IcsAppointment {
  const s = a.series;
  if (!s) return a;
  const allGone = s.status === "cancelled" || s.status === "expired" || (s.starts.length > 0 && s.gaps.length >= s.starts.length);
  return { ...a, status: allGone ? "cancelled" : s.status === "requested" ? "requested" : "accepted", rides: [] };
}

export function appointmentTitle(a: IcsAppointment, lang: string): string {
  const l = lng(lang);
  return isOpen(a) ? W[l].openTitle(serviceName(a, l)) : W[l].with(serviceName(a, l), other(a));
}

export function rideTitle(r: IcsRide, lang: string): string {
  return W[lng(lang)].ride(r.pickup.label, r.dropoff.label);
}

/** The description: who, status, note, the ride lines the viewer may see, the link back. */
export function appointmentDetails(a: IcsAppointment, ctx: IcsContext): string {
  const l = lng(ctx.lang);
  const open = isOpen(a);
  const lines: string[] = [];
  if (a.role !== "client") lines.push(W[l].forWho(a.client.nickname));
  else if (!open) lines.push(W[l].withWho(other(a)));
  if (open) lines.push(W[l].openLine);
  if (gone(a.status)) lines.push(W[l].cancelled);
  else
    lines.push(
      apptStatusText(a.status === "accepted" || a.status === "done" ? "confirmed" : open ? "open" : a.role === "client" ? "waiting" : "answer", a.provider?.nickname, l)
    );
  if (a.note) lines.push(`${W[l].note}: ${a.note}`);
  for (const r of a.rides) lines.push(rideLineText({ leg: r.leg, status: r.status as never, driver: r.driver?.nickname ?? null }, l));
  const back = link(ctx);
  if (back) lines.push(`${W[l].open}: ${back}`);
  return lines.join("\n");
}

export function rideDetails(r: IcsRide, ctx: IcsContext): string {
  const l = lng(ctx.lang);
  const lines: string[] = [];
  if (r.role === "driver") lines.push(W[l].rider(r.rider.nickname));
  else if (r.driver) {
    const v = r.driver.vehicle;
    lines.push(W[l].driver(r.driver.nickname) + (v ? ` · ${v.colour} ${v.make} ${v.model} · ${v.plate}` : ""));
  } else lines.push(W[l].noDriver);
  if (gone(r.status)) lines.push(W[l].cancelled);
  lines.push(`${W[l].fare}: ${r.fare.toFixed(2)} ${r.currency}`);
  const back = link(ctx);
  if (back) lines.push(`${W[l].open}: ${back}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- time

/** Offset of `tz` from UTC at instant `ms`, in minutes. */
function offsetMin(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 20261022T120000Z */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 20261022T140000 — the wall-clock time in `tz`. */
export function localStamp(ms: number, tz: string): string {
  return utcStamp(ms + offsetMin(ms, tz) * 60_000).slice(0, 15);
}

const offsetText = (min: number) => `${min < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;

/** VTIMEZONE for `tz` over [from, to]: the observance in force at `from` and every change until `to`. */
export function vtimezone(tz: string, from: number, to: number): string[] {
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  const first = offsetMin(from, tz);
  const changes: { at: number; from: number; to: number }[] = [];
  let prev = first;
  for (let t = from; t <= to + 86_400_000; t += 86_400_000) {
    const o = offsetMin(t, tz);
    if (o === prev) continue;
    // Narrow the change down to the minute.
    let lo = t - 86_400_000;
    let hi = t;
    while (hi - lo > 60_000) {
      const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
      if (offsetMin(mid, tz) === prev) lo = mid;
      else hi = mid;
    }
    changes.push({ at: hi, from: prev, to: o });
    prev = o;
  }
  const block = (kind: string, start: string, fromOff: number, toOff: number) => [
    `BEGIN:${kind}`,
    `DTSTART:${start}`,
    `TZOFFSETFROM:${offsetText(fromOff)}`,
    `TZOFFSETTO:${offsetText(toOff)}`,
    `END:${kind}`
  ];
  // The observance in force before the first change (or throughout).
  const before = changes[0]?.from ?? first;
  const after = changes[0]?.to ?? first;
  lines.push(...block(before >= after && changes.length ? "DAYLIGHT" : "STANDARD", "19700101T000000", before, before));
  for (const c of changes) lines.push(...block(c.to > c.from ? "DAYLIGHT" : "STANDARD", utcStamp(c.at + c.from * 60_000).slice(0, 15), c.from, c.to));
  lines.push("END:VTIMEZONE");
  return lines;
}

// ---------------------------------------------------------------- .ics

/** RFC 5545 text escaping. Every line break a reader may honour (CRLF, CR, LF, NEL, LS, PS) becomes
 *  \n and the other control characters go (a tab becomes a space), so user text can never end its
 *  content line and start one of its own (C15). */
export function escapeText(s: string): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, "\\n")
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\x00-\x1f\x7f]/g, "");
}

/** A value written without escaping (UID, URL): ids and config, but never a line break or control. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const bare = (s: string) => String(s ?? "").replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, "");

/** Folds a content line at 75 octets (UTF-8), never inside a character. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function calendar(events: string[], extra: string[] = []): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Siosia//Siosia//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...extra, ...events, "END:VCALENDAR"];
  return lines.map(fold).join("\r\n") + "\r\n";
}

const alarm = (min: number, summary: string) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(summary)}`, `TRIGGER:-PT${min}M`, "END:VALARM"];

/** LOCATION when there is a label, GEO only from two real numbers (the database may hold a place
 *  with a missing coordinate or label: no line rather than a crash or "GEO:NaN"). */
function placeLines(p: IcsPlace | null): string[] {
  if (!p) return [];
  const out = p.label ? [`LOCATION:${escapeText(p.label)}`] : [];
  if (typeof p.lat === "number" && typeof p.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
    out.push(`GEO:${p.lat.toFixed(6)};${p.lng.toFixed(6)}`);
  }
  return out;
}

/** One appointment (C3 "This date"). */
export function appointmentIcs(a: IcsAppointment, ctx: IcsContext): string {
  const summary = appointmentTitle(a, ctx.lang);
  const status = icsStatus(a.status);
  const back = link(ctx);
  const ev = [
    "BEGIN:VEVENT",
    `UID:${bare(a.id)}`,
    `DTSTAMP:${utcStamp(ctx.now ?? Date.now())}`,
    `DTSTART:${utcStamp(a.startsAt)}`,
    `DTEND:${utcStamp(a.endsAt)}`,
    `SUMMARY:${escapeText(summary)}`,
    ...placeLines(a.place),
    `DESCRIPTION:${escapeText(appointmentDetails(a, ctx))}`,
    ...(back ? [`URL:${back}`] : []),
    `STATUS:${status}`,
    ...(status === "CANCELLED" ? [] : ctx.reminderMin.flatMap((m) => alarm(m, summary))),
    "END:VEVENT"
  ];
  return calendar(ev);
}

/** A whole series as one repeating event, the declined and cancelled dates left out (NFR-20). */
export function seriesIcs(a: IcsAppointment, ctx: IcsContext): string {
  const s = a.series;
  if (!s) return appointmentIcs(a, ctx);
  const tz = ctx.timezone;
  const first = s.starts[0] ?? a.startsAt;
  const last = s.starts[s.starts.length - 1] ?? a.startsAt;
  const durMs = a.endsAt - a.startsAt;
  const summary = appointmentTitle(a, ctx.lang);
  const view = asSeries(a);
  const status = icsStatus(view.status);
  const back = link(ctx);
  const ev = [
    "BEGIN:VEVENT",
    `UID:${bare(s.id)}`,
    `DTSTAMP:${utcStamp(ctx.now ?? Date.now())}`,
    `DTSTART;TZID=${tz}:${localStamp(first, tz)}`,
    `DTEND;TZID=${tz}:${localStamp(first + durMs, tz)}`,
    `RRULE:FREQ=WEEKLY;INTERVAL=${s.rule === "biweekly" ? 2 : 1};COUNT=${s.count}`,
    ...s.gaps.map((g) => `EXDATE;TZID=${tz}:${localStamp(g, tz)}`),
    `SUMMARY:${escapeText(summary)}`,
    ...placeLines(a.place),
    `DESCRIPTION:${escapeText(appointmentDetails(view, ctx))}`,
    ...(back ? [`URL:${back}`] : []),
    `STATUS:${status}`,
    ...(status === "CANCELLED" ? [] : ctx.reminderMin.flatMap((m) => alarm(m, summary))),
    "END:VEVENT"
  ];
  return calendar(ev, vtimezone(tz, first - 86_400_000, last + durMs + 86_400_000));
}

/** A booked ride (the P1 booking card): one alarm 30 min before. */
export function rideIcs(r: IcsRide, ctx: IcsContext): string {
  const at = r.scheduledFor ?? r.requestedAt;
  const summary = rideTitle(r, ctx.lang);
  const cancelled = gone(r.status);
  const back = link(ctx);
  const ev = [
    "BEGIN:VEVENT",
    `UID:${bare(r.id)}`,
    `DTSTAMP:${utcStamp(ctx.now ?? Date.now())}`,
    `DTSTART:${utcStamp(at)}`,
    `DTEND:${utcStamp(at + Math.max(5, Math.round(r.estMin)) * 60_000)}`,
    `SUMMARY:${escapeText(summary)}`,
    ...placeLines(r.pickup),
    `DESCRIPTION:${escapeText(rideDetails(r, ctx))}`,
    ...(back ? [`URL:${back}`] : []),
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    ...(cancelled ? [] : alarm(RIDE_ALARM_MIN, summary)),
    "END:VEVENT"
  ];
  return calendar(ev);
}

// ---------------------------------------------------------------- Google Calendar (V28)

const GOOGLE = "https://calendar.google.com/calendar/render";

function googleUrl(p: { text: string; start: number; end: number; tz: string; location: string | null; details: string; recur?: string }): string {
  const q = new URLSearchParams({ action: "TEMPLATE", text: p.text, dates: `${localStamp(p.start, p.tz)}/${localStamp(p.end, p.tz)}`, ctz: p.tz });
  if (p.location) q.set("location", p.location);
  q.set("details", p.details);
  if (p.recur) q.set("recur", p.recur);
  return `${GOOGLE}?${q.toString()}`;
}

/** The prefilled Google Calendar event of one appointment, or of the whole series. */
export function appointmentGoogleLink(a: IcsAppointment, ctx: IcsContext, wholeSeries = false): string {
  const s = wholeSeries ? a.series : null;
  const start = s ? (s.starts[0] ?? a.startsAt) : a.startsAt;
  return googleUrl({
    text: appointmentTitle(a, ctx.lang),
    start,
    end: start + (a.endsAt - a.startsAt),
    tz: ctx.timezone,
    location: a.place?.label ?? null,
    details: appointmentDetails(s ? asSeries(a) : a, ctx),
    recur: s ? `RRULE:FREQ=WEEKLY;INTERVAL=${s.rule === "biweekly" ? 2 : 1};COUNT=${s.count}` : undefined
  });
}

export function rideGoogleLink(r: IcsRide, ctx: IcsContext): string {
  const at = r.scheduledFor ?? r.requestedAt;
  return googleUrl({
    text: rideTitle(r, ctx.lang),
    start: at,
    end: at + Math.max(5, Math.round(r.estMin)) * 60_000,
    tz: ctx.timezone,
    location: r.pickup.label,
    details: rideDetails(r, ctx)
  });
}
