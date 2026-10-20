// The "calendar" function's request handling (FR-136, NFR-20), apart from Deno so it is unit-tested:
// GET ?a=<appointment> | ?s=<series> | ?r=<ride>, &u=<viewer public id>, &t=<token>. The database
// checks the token (an HMAC of the id and the viewer, keyed with push_secret) and returns that
// viewer's view; anything else is a plain 404. Nothing about the request or the event is logged.

import { appointmentIcs, rideIcs, seriesIcs, type IcsAppointment, type IcsContext, type IcsRide } from "../_shared/ics.ts";

export interface CalendarView {
  kind: "a" | "s" | "r";
  lang: string;
  timezone: string;
  reminderMin: number[];
  siteUrl: string | null;
  view: IcsAppointment | IcsRide;
}

export type ReadView = (kind: string, id: string, publicId: string, token: string) => Promise<CalendarView | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });

export async function handleCalendar(req: Request, read: ReadView): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const q = new URL(req.url).searchParams;
  const kind = (["a", "s", "r"] as const).find((k) => q.has(k));
  const id = kind ? (q.get(kind) ?? "") : "";
  const u = q.get("u") ?? "";
  const t = q.get("t") ?? "";
  if (!kind || !UUID.test(id) || !/^[A-Za-z0-9_-]{6,40}$/.test(u) || !/^[0-9a-f]{32}$/.test(t)) return notFound();
  let data: CalendarView | null;
  try {
    data = await read(kind, id, u, t);
  } catch {
    return new Response("unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!data?.view) return notFound();
  const ctx: IcsContext = { lang: data.lang, timezone: data.timezone, reminderMin: data.reminderMin ?? [], siteUrl: data.siteUrl };
  const body =
    data.kind === "r" ? rideIcs(data.view as IcsRide, ctx) : data.kind === "s" ? seriesIcs(data.view as IcsAppointment, ctx) : appointmentIcs(data.view as IcsAppointment, ctx);
  return new Response(req.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="siosia.ics"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
