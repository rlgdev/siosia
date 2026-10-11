// Notification texts (EN/PL) for every push kind. Shared by the Edge Function that sends Web Push
// (supabase/functions/push-dispatch) and by the in-browser demo backend, so both say the same.
// No imports: runs unchanged in Deno and in the browser.

export type PushKind =
  | "booking_new"
  | "booking_taken"
  | "booking_released"
  | "booking_cancelled"
  | "time_to_go"
  | "driver_coming"
  | "driver_arrived"
  | "booking_open"
  | "request_new";

export interface PushParams {
  /** Booked pickup time: ms or an ISO timestamp (as Postgres sends it). */
  at?: number | string | null;
  pickup?: string | null;
  dropoff?: string | null;
  driver?: string | null;
  rider?: string | null;
}

export interface PushText {
  title: string;
  body: string;
  /** Same tag = the newer notification replaces the older one. */
  tag: string;
}

type Lang = "en" | "pl";

function toMs(at: PushParams["at"]): number | null {
  if (at === null || at === undefined) return null;
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

function fmt(ms: number | null, lang: Lang, tz: string, withDay: boolean): string {
  if (ms === null) return "";
  const opts: Intl.DateTimeFormatOptions = withDay
    ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz }
    : { hour: "2-digit", minute: "2-digit", timeZone: tz };
  try {
    return new Intl.DateTimeFormat(lang === "pl" ? "pl-PL" : "en-GB", opts).format(ms);
  } catch {
    return new Intl.DateTimeFormat(lang === "pl" ? "pl-PL" : "en-GB", { ...opts, timeZone: "UTC" }).format(ms);
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
    driver_arrived: ["{driver} is here", "Your driver has arrived at the pickup."],
    booking_open: ["Looking for a driver", "Your booking {when} is now offered to drivers nearby."],
    request_new: ["New ride request", "Pickup: {pickup}. Open Siosia to take it."]
  },
  pl: {
    booking_new: ["Nowa rezerwacja {when}", "{pickup} → {dropoff}. Weź ją w Siosi → Rezerwacje."],
    booking_taken: ["{driver} Cię zawiezie", "Twój kurs {when} ma kierowcę."],
    booking_released: ["Rezerwacja szuka nowego kierowcy", "{when}: proponujemy ją ponownie innym kierowcom."],
    booking_cancelled: ["Rezerwacja anulowana", "{when} z {pickup} — pasażer anulował."],
    time_to_go: ["Czas jechać", "Odbiór {time}: {rider}, {pickup}. Otwórz Siosię."],
    driver_coming: ["{driver} jest w drodze", "Kierowca jedzie do miejsca odbioru."],
    driver_arrived: ["{driver} czeka", "Kierowca jest na miejscu odbioru."],
    booking_open: ["Szukamy kierowcy", "Twoja rezerwacja {when} trafiła do kierowców w pobliżu."],
    request_new: ["Nowe zamówienie", "Odbiór: {pickup}. Otwórz Siosię, aby je przyjąć."]
  }
};

export function pushText(kind: PushKind, params: PushParams, lang: string, tz: string, rideId?: string | null): PushText {
  const l: Lang = lang === "pl" ? "pl" : "en";
  const [title, body] = TEXTS[l][kind] ?? TEXTS[l].booking_open;
  const ms = toMs(params.at);
  const vars: Record<string, string> = {
    when: fmt(ms, l, tz, true),
    time: fmt(ms, l, tz, false),
    pickup: params.pickup ?? "",
    dropoff: params.dropoff ?? "",
    driver: params.driver ?? "",
    rider: params.rider ?? ""
  };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "").replace(/\s+/g, " ").trim();
  return { title: fill(title), body: fill(body), tag: `${kind}:${rideId ?? ""}` };
}
