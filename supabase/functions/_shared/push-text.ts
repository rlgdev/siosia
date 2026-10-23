// Notification texts (EN/PL) for every push kind. Shared by the Edge Function that sends Web Push
// (supabase/functions/push-dispatch), by the in-browser demo backend and by the app's Planned list
// (the appointment and ride status words — one source, NFR-16), so all of them say the same.
// 2.1: an open request has no provider; every text reads without one (V37).
// No imports: runs unchanged in Deno and in the browser.

export type PushKind =
  | "booking_new"
  | "booking_taken"
  | "booking_released"
  | "booking_cancelled"
  | "time_to_go"
  | "driver_coming"
  // 2.2: the car started moving towards the pickup (booked rides)
  | "driver_departed"
  | "driver_arrived"
  | "booking_open"
  | "request_new"
  // 2.0: appointments (siosia-spec-v2.0.md §8)
  | "appt_new"
  // 2.1: an open request, to every other member who could take it
  | "appt_open"
  | "appt_accepted"
  | "appt_declined"
  | "appt_cancelled"
  | "appt_expired"
  | "appt_reminder"
  | "appt_ride_added"
  | "appt_ride_taken"
  | "appt_ride_lost"
  | "appt_ride_failed"
  // 2.3: a chat message (tag per room; opens the chat)
  | "chat_message"
  // 2.5: a session update (tag per appointment; opens C3) and the client heading home
  | "session_update"
  | "client_coming";

/** Moments are ms or ISO timestamps (as Postgres sends them). */
type Moment = number | string | null;

/** An attached ride in a reminder: leg, status (pending | confirmed | done | failed), driver. */
export interface RideLine {
  leg?: string | null;
  status?: string | null;
  driver?: string | null;
}

export interface PushParams {
  /** Booked pickup time (rides) or the appointment start. */
  at?: Moment;
  pickup?: string | null;
  dropoff?: string | null;
  driver?: string | null;
  rider?: string | null;
  // 2.0: appointments
  serviceId?: string;
  /** The service's name in the recipient's language. */
  service?: string;
  end?: Moment;
  client?: string;
  provider?: string;
  place?: string;
  /** Reminder slot, minutes before the start. */
  lead?: number;
  role?: "client" | "provider";
  other?: string;
  /** confirmed | waiting (client of a request) | answer (provider of a request) | open (2.1: nobody took it yet). */
  status?: string;
  /** 2.1: an open request (no provider yet). */
  open?: boolean;
  /** 2.3: chat — the sender and the first words. */
  sender?: string;
  text?: string;
  /** The room, for the tag and the open URL. */
  room?: string;
  /** The message's id: push-dispatch drops a message the recipient read before it went out (C6). */
  messageId?: string;
  /** 2.3: the attached kids' names, for reminders and the accept text ("with Zosia and Kuba"). */
  kids?: string[];
  /** 2.5: a session update — the kid it is about (null = everyone), whether it carries a photo, its id. */
  kid?: string | null;
  photo?: boolean;
  updateId?: string;
  /** 2.5: heading home — the minutes away and the expected arrival. */
  minutes?: number;
  etaAt?: Moment;
  rides?: RideLine[];
  rule?: "weekly" | "biweekly";
  count?: number;
  first?: Moment;
  last?: Moment;
  /** Series answers: how many occurrences were confirmed, and the declined dates. */
  accepted?: number;
  declined?: Moment[];
  who?: string;
  /** "All remaining": from this date, this many. */
  from?: Moment;
  left?: number;
  leg?: string;
  /** Pickup time of an attached ride. */
  time?: Moment;
  repeat?: boolean;
}

export interface PushText {
  title: string;
  body: string;
  /** Same tag = the newer notification replaces the older one. */
  tag: string;
}

type Lang = "en" | "pl";

function toMs(at: Moment | undefined): number | null {
  if (at === null || at === undefined) return null;
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

const loc = (l: Lang) => (l === "pl" ? "pl-PL" : "en-GB");

function format(ms: number | null, l: Lang, tz: string, opts: Intl.DateTimeFormatOptions): string {
  if (ms === null) return "";
  try {
    return new Intl.DateTimeFormat(loc(l), { ...opts, timeZone: tz }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(loc(l), { ...opts, timeZone: "UTC" }).format(ms);
  }
}

function fmt(ms: number | null, lang: Lang, tz: string, withDay: boolean): string {
  return format(
    ms,
    lang,
    tz,
    withDay ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }
  );
}

const dayMonth = (ms: number | null, l: Lang, tz: string) => format(ms, l, tz, { day: "numeric", month: "short" });

/** "Wed 22 Oct, 14:00–17:00" */
export function rangeText(at: Moment | undefined, end: Moment | undefined, lang: string, tz: string): string {
  const l: Lang = lang === "pl" ? "pl" : "en";
  const a = toMs(at);
  const e = toMs(end);
  if (a === null) return "";
  return `${fmt(a, l, tz, true)}${e === null ? "" : `–${fmt(e, l, tz, false)}`}`;
}

// Polish "co <weekday>" takes the accusative; "co drugi / drugą" follows the weekday's gender.
const PL_EVERY = ["niedzielę", "poniedziałek", "wtorek", "środę", "czwartek", "piątek", "sobotę"];
const PL_FEMININE = [true, false, false, true, false, false, true];

function weekdayIndex(ms: number, tz: string): number {
  const d = format(ms, "en", tz, { weekday: "short" });
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(d);
}

/** "every Tue 16:00–17:00, 28 Oct – 16 Dec (8×)" / "co wtorek 16:00–17:00, 28 paź – 16 gru (8×)" */
export function seriesText(p: PushParams, lang: string, tz: string): string {
  const l: Lang = lang === "pl" ? "pl" : "en";
  const first = toMs(p.first ?? p.at);
  const last = toMs(p.last);
  const at = toMs(p.at);
  const end = toMs(p.end);
  if (first === null) return "";
  const minutes = at !== null && end !== null ? end - at : 0;
  const time = `${fmt(first, l, tz, false)}–${fmt(first + minutes, l, tz, false)}`;
  const wd = weekdayIndex(first, tz);
  const biweekly = p.rule === "biweekly";
  const every =
    l === "pl"
      ? `co ${biweekly ? (PL_FEMININE[wd] ? "drugą " : "drugi ") : ""}${PL_EVERY[wd] ?? ""}`
      : `every ${biweekly ? "other " : ""}${format(first, "en", tz, { weekday: "short" })}`;
  const span = last !== null ? `, ${dayMonth(first, l, tz)} – ${dayMonth(last, l, tz)}` : "";
  return `${every} ${time}${span}${p.count ? ` (${p.count}×)` : ""}`;
}

const LEG: Record<Lang, Record<string, string>> = {
  en: { there: "there", back: "back" },
  pl: { there: "tam", back: "powrotny" }
};

/** "Tomorrow" / "In 2 hours" / "In 3 h" / "In 30 min" from a reminder slot. */
export function leadText(slot: number | undefined, lang: string): string {
  const l: Lang = lang === "pl" ? "pl" : "en";
  if (slot === 1440) return l === "pl" ? "Jutro" : "Tomorrow";
  if (slot === 120) return l === "pl" ? "Za 2 godziny" : "In 2 hours";
  if (slot !== undefined && slot < 60) return l === "pl" ? `Za ${slot} min` : `In ${slot} min`;
  const h = Math.round(((slot ?? 0) / 60) * 10) / 10;
  return l === "pl" ? `Za ${h} godz.` : `In ${h} h`;
}

/** The appointment status words of reminders and Planned (§8, V8). "open" (2.1): a request nobody
 *  took yet; a client still waiting without a provider (an open request) reads the same (V37). */
export function apptStatusText(status: string | undefined, provider: string | null | undefined, lang: string): string {
  const l: Lang = lang === "pl" ? "pl" : "en";
  if (status === "confirmed") return l === "pl" ? "Potwierdzone" : "Confirmed";
  if (status === "open" || (status === "waiting" && !provider)) return l === "pl" ? "Czeka, aż ktoś się podejmie" : "Waiting for someone to take it";
  if (status === "waiting") return l === "pl" ? `Czeka na odpowiedź: ${provider}` : `Waiting for an answer from ${provider}`;
  if (status === "answer") return l === "pl" ? "Odpowiedz, proszę" : "Please answer";
  return "";
}

/** One attached ride in the words of reminders and Planned: "Ride there: Roman ✓". */
export function rideLineText(r: RideLine, lang: string): string {
  const l: Lang = lang === "pl" ? "pl" : "en";
  const leg = LEG[l][r.leg ?? "there"] ?? r.leg ?? "";
  const head = l === "pl" ? `Przejazd ${leg}` : `Ride ${leg}`;
  switch (r.status) {
    case "confirmed":
      return `${head}: ${r.driver ?? ""} ✓`;
    case "pending":
      return `${head}: ${l === "pl" ? "jeszcze bez kierowcy" : "no driver yet"}`;
    case "done":
      return `${head}: ${l === "pl" ? "odbył się" : "done"}`;
    default:
      return `${head}: ${l === "pl" ? "nie znaleziono kierowcy" : "no driver found"}`;
  }
}

const TEXTS: Record<Lang, Record<PushKind, [string, string]>> = {
  en: {
    booking_new: ["New booking {when}", "{pickup} → {dropoff}. Take it in Siosia → Booked rides."],
    booking_taken: ["{driver} will drive you", "Your ride {when} has a driver."],
    booking_released: ["Your booking needs a new driver", "{when}: we offer it to other drivers again."],
    booking_cancelled: ["Booking cancelled", "{when} from {pickup} was cancelled by the rider."],
    time_to_go: ["Time to go", "Pickup {time}: {rider} at {pickup}. Open Siosia."],
    driver_coming: ["{driver} is on the way", "Your driver is heading to the pickup."],
    driver_departed: ["{driver} has set off", "The car is moving towards your pickup — see it on the map."],
    driver_arrived: ["{driver} is here", "Your driver has arrived at the pickup."],
    booking_open: ["Looking for a driver", "Your booking {when} is now offered to drivers nearby."],
    request_new: ["New ride request", "Pickup: {pickup}. Open Siosia to take it."],
    appt_new: ["New request: {service} {when}", "{client} asks for {service}, {range}{kids}. Answer in Siosia → Planned."],
    appt_open: ["Can you help? {service}", "{client} asks: {service} {range}{atplace}. Open Siosia to take it."],
    appt_accepted: ["{provider} accepted", "{service} {range} is confirmed{kids}.{clashes}"],
    appt_declined: ["{provider} can't make it", "{service} {range} was declined."],
    appt_cancelled: ["{service} {when} cancelled", "Cancelled by {who}: {service} {range}.{remaining}"],
    appt_expired: ["No answer from {provider}", "{service} {range} got no answer and expired."],
    appt_reminder: ["{lead}: {service} {range}", "{withplace}{kids}. {status}.{rides}"],
    appt_ride_added: ["{who} added a ride", "{service} {when}: ride {leg}{attime}, looking for a driver."],
    appt_ride_taken: ["Ride confirmed: {driver}", "{service} {when}: the ride {leg} has a driver."],
    appt_ride_lost: ["Ride needs a driver", "{service} {when}: the ride {leg} has no driver again."],
    appt_ride_failed: ["No driver found", "{service} {when}: the ride {leg} didn't happen."],
    // 2.3 (FR-222): the sender's own words; the tag is the room, so a newer message replaces the older.
    chat_message: ["{sender}", "{text}"],
    // 2.5 (FR-232, FR-241): a session update names the kid it is about (else the service); the
    // heading-home notice says how far away the client is.
    session_update: ["{sender}{about}", "{update}"],
    client_coming: ["{client} is heading home", "About {minutes} min — around {eta}."]
  },
  pl: {
    booking_new: ["Nowa rezerwacja {when}", "{pickup} → {dropoff}. Weź ją w Siosi → Rezerwacje."],
    booking_taken: ["{driver} Cię zawiezie", "Twój kurs {when} ma kierowcę."],
    booking_released: ["Rezerwacja szuka nowego kierowcy", "{when}: proponujemy ją ponownie innym kierowcom."],
    booking_cancelled: ["Rezerwacja anulowana", "{when} z {pickup} — pasażer anulował."],
    time_to_go: ["Czas jechać", "Odbiór {time}: {rider}, {pickup}. Otwórz Siosię."],
    driver_coming: ["{driver} jest w drodze", "Kierowca jedzie do miejsca odbioru."],
    driver_departed: ["{driver} ruszył(a)", "Auto jedzie do Twojego miejsca odbioru — zobacz je na mapie."],
    driver_arrived: ["{driver} czeka", "Kierowca jest na miejscu odbioru."],
    booking_open: ["Szukamy kierowcy", "Twoja rezerwacja {when} trafiła do kierowców w pobliżu."],
    request_new: ["Nowe zamówienie", "Odbiór: {pickup}. Otwórz Siosię, aby je przyjąć."],
    appt_new: ["Nowa prośba: {service} {when}", "{client} prosi o: {service}, {range}{kids}. Odpowiedz w Siosi → Zaplanowane."],
    appt_open: ["Możesz pomóc? {service}", "{client} prosi o pomoc: {service} {range}{atplace}. Otwórz Siosię, aby się tego podjąć."],
    appt_accepted: ["{provider} potwierdza", "{service} {range} — potwierdzone{kids}.{clashes}"],
    appt_declined: ["{provider} nie może", "{service} {range} — odrzucone."],
    appt_cancelled: ["{service} {when} odwołane", "Odwołane przez: {who}. {service} {range}.{remaining}"],
    appt_expired: ["Brak odpowiedzi od {provider}", "{service} {range} — bez odpowiedzi, prośba wygasła."],
    appt_reminder: ["{lead}: {service} {range}", "{withplace}{kids}. {status}.{rides}"],
    appt_ride_added: ["{who} dodaje przejazd", "{service} {when}: przejazd {leg}{attime}, szukamy kierowcy."],
    appt_ride_taken: ["Przejazd potwierdzony: {driver}", "{service} {when}: przejazd {leg} ma kierowcę."],
    appt_ride_lost: ["Przejazd szuka kierowcy", "{service} {when}: przejazd {leg} znów bez kierowcy."],
    appt_ride_failed: ["Nie znaleziono kierowcy", "{service} {when}: przejazd {leg} nie doszedł do skutku."],
    chat_message: ["{sender}", "{text}"],
    session_update: ["{sender}{about}", "{update}"],
    client_coming: ["{client} wraca do domu", "Za około {minutes} min — na miejscu ok. {eta}."]
  }
};

/** A chat push carries at most this many characters of the message, then "…". The backends queue
 *  the full text (up to 500 characters, C21): this is the one place that cuts. */
export const CHAT_PUSH_CHARS = 80;

/** 2.3 (FR-202): the attached kids' names in one breath — "Zosia and Kuba" / "Zosia, Kuba i Ola". */
export function kidsText(names: readonly string[] | undefined, lang: string): string {
  const l: Lang = lang === "pl" ? "pl" : "en";
  const list = (names ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
  if (list.length < 2) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} ${l === "pl" ? "i" : "and"} ${list[list.length - 1]}`;
}

/** ", with Zosia and Kuba" / ", z: Zosia i Kuba" — the provider's copy of a request, an accept or a
 *  reminder; "" for the client (their own kids need no mention) and when nobody is attached (K3). */
const WITH_KIDS: Record<Lang, (kids: string) => string> = { en: (k) => `, with ${k}`, pl: (k) => `, z: ${k}` };

/** 2.1: the words of a kind that would name the provider, for an open request (nobody took it, V37). */
const OPEN_TEXTS: Record<Lang, Partial<Record<PushKind, [string, string]>>> = {
  en: { appt_expired: ["Nobody took it", "Nobody took your request: {service} {range}."] },
  pl: { appt_expired: ["Nikt się nie zgłosił", "Nikt nie przyjął Twojej prośby: {service} {range}."] }
};

/** A party with no nickname in a text (never an empty name or a placeholder). */
const SOMEONE: Record<Lang, string> = { en: "Someone", pl: "Ktoś" };
const WITH: Record<Lang, (other: string) => string> = { en: (o) => `With ${o}`, pl: (o) => `Z ${o}` };
const YOUR_OPEN: Record<Lang, string> = { en: "Your open request", pl: "Twoja otwarta prośba" };

/**
 * Title, body and tag of a notification. `id` is the ride (v1 kinds) or the appointment (2.0
 * kinds); the tag `<kind>:<id>` makes a newer notification replace an older one of the same kind.
 * 2.3: a chat message is tagged `chat:<room>` (params.room), so the newest message of a room is
 * the one notification left; the id is only a fallback (V48).
 */
export function pushText(kind: PushKind, params: PushParams, lang: string, tz: string, id?: string | null): PushText {
  const l: Lang = lang === "pl" ? "pl" : "en";
  // 2.1: an open request has no provider (the backends send "" or nothing): its own words, never
  // "No answer from " or "With  · " (V37).
  const open = kind.startsWith("appt_") && (!!params.open || params.status === "open" || (!params.provider && params.role !== "provider"));
  const [title, body] = (open ? OPEN_TEXTS[l][kind] : undefined) ?? TEXTS[l][kind] ?? TEXTS[l].booking_open;
  const ms = toMs(params.at);
  const series =
    !!params.rule && (kind === "appt_new" || kind === "appt_open" || kind === "appt_accepted" || kind === "appt_declined" || kind === "appt_expired");
  const status = params.status === "waiting" && open ? "open" : params.status;
  const withWho = params.other ? WITH[l](params.other) : status === "open" ? YOUR_OPEN[l] : "";
  const declined = (params.declined ?? []).map((d) => dayMonth(toMs(d), l, tz)).filter(Boolean);
  const total = (params.accepted ?? 0) + declined.length;
  // 2.3 (K3): only the provider's copies carry kids; a client's never names their own.
  const kids = params.role === "client" ? "" : kidsText(params.kids, l);
  const chat = (params.text ?? "").replace(/\s+/g, " ").trim();
  const cut = chat.length > CHAT_PUSH_CHARS ? `${chat.slice(0, CHAT_PUSH_CHARS).trimEnd()}…` : chat;
  const vars: Record<string, string> = {
    sender: params.sender || SOMEONE[l],
    text: cut,
    // 2.5: an update's words, "📷" marking a photo — alone when there are no words.
    update: params.photo ? (cut ? `${cut} 📷` : l === "pl" ? "📷 Zdjęcie" : "📷 Photo") : cut,
    about: params.kid || params.service ? ` · ${params.kid || params.service}` : "",
    minutes: params.minutes === undefined || params.minutes === null ? "" : String(params.minutes),
    eta: fmt(toMs(params.etaAt), l, tz, false),
    kids: kids ? WITH_KIDS[l](kids) : "",
    when: fmt(ms, l, tz, true),
    time: fmt(toMs(params.time) ?? ms, l, tz, false),
    pickup: params.pickup ?? "",
    dropoff: params.dropoff ?? "",
    driver: params.driver ?? "",
    rider: params.rider ?? "",
    service: params.service ?? "",
    client: params.client || SOMEONE[l],
    provider: params.provider || SOMEONE[l],
    who: params.who || SOMEONE[l],
    other: params.other ?? "",
    leg: LEG[l][params.leg ?? ""] ?? params.leg ?? "",
    lead: leadText(params.lead, l),
    range: series ? seriesText(params, l, tz) : rangeText(params.at, params.end, l, tz),
    atplace: params.place ? ` · ${params.place}` : "",
    withplace: [withWho, params.place ?? ""].filter(Boolean).join(" · "),
    attime: params.time ? (l === "pl" ? ` o ${fmt(toMs(params.time), l, tz, false)}` : ` at ${fmt(toMs(params.time), l, tz, false)}`) : params.repeat ? (l === "pl" ? " w każdym terminie" : " for every date") : "",
    status: apptStatusText(status, params.provider, l),
    rides: (params.rides ?? []).length ? ` ${(params.rides ?? []).map((r) => rideLineText(r, l)).join(" · ")}` : "",
    clashes: declined.length
      ? l === "pl"
        ? ` ${params.accepted} z ${total} potwierdzone; odrzucone: ${declined.join(", ")}`
        : ` ${params.accepted} of ${total} confirmed; declined: ${declined.join(", ")}`
      : "",
    remaining:
      params.left !== undefined && params.from !== undefined
        ? l === "pl"
          ? ` Od ${dayMonth(toMs(params.from), l, tz)}, ${params.left} ${params.left === 1 ? "termin" : "pozostałe"}.`
          : ` From ${dayMonth(toMs(params.from), l, tz)}, ${params.left} left.`
        : ""
  };
  // A chat body (and an update's, 2.5) is the sender's own words: substituted and trimmed, but never
  // tidied like a template (their "..." or a leading "." stay as typed).
  const tidy = (s: string) =>
    kind === "chat_message" || kind === "session_update"
      ? s
      : s
          .replace(/\s+([.,])/g, "$1")
          .replace(/\.\./g, ".")
          .trim()
          .replace(/^[.,·]\s*/, "");
  const fill = (s: string) =>
    tidy(
      s
        .replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "")
        .replace(/\s+/g, " ")
        .trim()
    );
  const tag =
    kind === "chat_message" ? `chat:${params.room ?? id ?? ""}` : kind === "session_update" ? `update:${id ?? ""}` : kind === "client_coming" ? `coming:${id ?? ""}` : `${kind}:${id ?? ""}`;
  return { title: fill(title), body: fill(body), tag };
}
