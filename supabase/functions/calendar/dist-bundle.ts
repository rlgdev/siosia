// supabase/functions/calendar/index.ts
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

// supabase/functions/_shared/push-text.ts
var LEG = {
  en: { there: "there", back: "back" },
  pl: { there: "tam", back: "powrotny" }
};
function apptStatusText(status, provider, lang) {
  const l = lang === "pl" ? "pl" : "en";
  if (status === "confirmed") return l === "pl" ? "Potwierdzone" : "Confirmed";
  if (status === "open" || status === "waiting" && !provider) return l === "pl" ? "Czeka, a\u017C kto\u015B si\u0119 podejmie" : "Waiting for someone to take it";
  if (status === "waiting") return l === "pl" ? `Czeka na odpowied\u017A: ${provider}` : `Waiting for an answer from ${provider}`;
  if (status === "answer") return l === "pl" ? "Odpowiedz, prosz\u0119" : "Please answer";
  return "";
}
function rideLineText(r, lang) {
  const l = lang === "pl" ? "pl" : "en";
  const leg = LEG[l][r.leg ?? "there"] ?? r.leg ?? "";
  const head = l === "pl" ? `Przejazd ${leg}` : `Ride ${leg}`;
  switch (r.status) {
    case "confirmed":
      return `${head}: ${r.driver ?? ""} \u2713`;
    case "pending":
      return `${head}: ${l === "pl" ? "jeszcze bez kierowcy" : "no driver yet"}`;
    case "done":
      return `${head}: ${l === "pl" ? "odby\u0142 si\u0119" : "done"}`;
    default:
      return `${head}: ${l === "pl" ? "nie znaleziono kierowcy" : "no driver found"}`;
  }
}

// supabase/functions/_shared/ics.ts
var RIDE_ALARM_MIN = 30;
var lng = (l) => l === "pl" ? "pl" : "en";
var W = {
  en: {
    with: (s, o) => `${s} with ${o}`,
    openTitle: (s) => `${s} \u2014 open request`,
    openLine: "Open request: anyone in the group can take it",
    ride: (a, b) => `Ride: ${a} \u2192 ${b}`,
    withWho: (n) => `With ${n}`,
    forWho: (n) => `For ${n}`,
    driver: (n) => `Driver: ${n}`,
    rider: (n) => `Rider: ${n}`,
    noDriver: "No driver yet",
    fare: "Fare",
    cancelled: "Cancelled",
    open: "Open in Siosia",
    note: "Note"
  },
  pl: {
    with: (s, o) => `${s} \u2014 ${o}`,
    openTitle: (s) => `${s} \u2014 otwarta pro\u015Bba`,
    openLine: "Otwarta pro\u015Bba: mo\u017Ce si\u0119 jej podj\u0105\u0107 ka\u017Cdy w grupie",
    ride: (a, b) => `Przejazd: ${a} \u2192 ${b}`,
    withWho: (n) => `Z: ${n}`,
    forWho: (n) => `Dla: ${n}`,
    driver: (n) => `Kierowca: ${n}`,
    rider: (n) => `Pasa\u017Cer: ${n}`,
    noDriver: "Jeszcze bez kierowcy",
    fare: "Cena",
    cancelled: "Odwo\u0142ane",
    open: "Otw\xF3rz w Siosi",
    note: "Notatka"
  }
};
var serviceName = (a, l) => a.service?.name[l] || a.service?.name.en || a.serviceId;
var isOpen = (a) => !a.provider;
var other = (a) => a.role === "client" ? a.provider?.nickname ?? "" : a.client.nickname;
var link = (ctx) => ctx.siteUrl ? `${bare(ctx.siteUrl).replace(/[?#].*$/, "")}?open=planned` : null;
var gone = (status) => status === "cancelled" || status === "declined" || status === "expired";
var icsStatus = (status) => gone(status) ? "CANCELLED" : status === "requested" ? "TENTATIVE" : "CONFIRMED";
function asSeries(a) {
  const s = a.series;
  if (!s) return a;
  const allGone = s.status === "cancelled" || s.status === "expired" || s.starts.length > 0 && s.gaps.length >= s.starts.length;
  return { ...a, status: allGone ? "cancelled" : s.status === "requested" ? "requested" : "accepted", rides: [] };
}
function appointmentTitle(a, lang) {
  const l = lng(lang);
  return isOpen(a) ? W[l].openTitle(serviceName(a, l)) : W[l].with(serviceName(a, l), other(a));
}
function rideTitle(r, lang) {
  return W[lng(lang)].ride(r.pickup.label, r.dropoff.label);
}
function appointmentDetails(a, ctx) {
  const l = lng(ctx.lang);
  const open = isOpen(a);
  const lines = [];
  if (a.role !== "client") lines.push(W[l].forWho(a.client.nickname));
  else if (!open) lines.push(W[l].withWho(other(a)));
  if (open) lines.push(W[l].openLine);
  if (gone(a.status)) lines.push(W[l].cancelled);
  else
    lines.push(
      apptStatusText(a.status === "accepted" || a.status === "done" ? "confirmed" : open ? "open" : a.role === "client" ? "waiting" : "answer", a.provider?.nickname, l)
    );
  if (a.note) lines.push(`${W[l].note}: ${a.note}`);
  for (const r of a.rides) lines.push(rideLineText({ leg: r.leg, status: r.status, driver: r.driver?.nickname ?? null }, l));
  const back = link(ctx);
  if (back) lines.push(`${W[l].open}: ${back}`);
  return lines.join("\n");
}
function rideDetails(r, ctx) {
  const l = lng(ctx.lang);
  const lines = [];
  if (r.role === "driver") lines.push(W[l].rider(r.rider.nickname));
  else if (r.driver) {
    const v = r.driver.vehicle;
    lines.push(W[l].driver(r.driver.nickname) + (v ? ` \xB7 ${v.colour} ${v.make} ${v.model} \xB7 ${v.plate}` : ""));
  } else lines.push(W[l].noDriver);
  if (gone(r.status)) lines.push(W[l].cancelled);
  lines.push(`${W[l].fare}: ${r.fare.toFixed(2)} ${r.currency}`);
  const back = link(ctx);
  if (back) lines.push(`${W[l].open}: ${back}`);
  return lines.join("\n");
}
function offsetMin(ms, tz) {
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
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(ms / 1e3) * 1e3) / 6e4);
}
var pad = (n, w = 2) => String(n).padStart(w, "0");
function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function localStamp(ms, tz) {
  return utcStamp(ms + offsetMin(ms, tz) * 6e4).slice(0, 15);
}
var offsetText = (min) => `${min < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;
function vtimezone(tz, from, to) {
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  const first = offsetMin(from, tz);
  const changes = [];
  let prev = first;
  for (let t = from; t <= to + 864e5; t += 864e5) {
    const o = offsetMin(t, tz);
    if (o === prev) continue;
    let lo = t - 864e5;
    let hi = t;
    while (hi - lo > 6e4) {
      const mid = Math.floor((lo + hi) / 2 / 6e4) * 6e4;
      if (offsetMin(mid, tz) === prev) lo = mid;
      else hi = mid;
    }
    changes.push({ at: hi, from: prev, to: o });
    prev = o;
  }
  const block = (kind, start, fromOff, toOff) => [
    `BEGIN:${kind}`,
    `DTSTART:${start}`,
    `TZOFFSETFROM:${offsetText(fromOff)}`,
    `TZOFFSETTO:${offsetText(toOff)}`,
    `END:${kind}`
  ];
  const before = changes[0]?.from ?? first;
  const after = changes[0]?.to ?? first;
  lines.push(...block(before >= after && changes.length ? "DAYLIGHT" : "STANDARD", "19700101T000000", before, before));
  for (const c of changes) lines.push(...block(c.to > c.from ? "DAYLIGHT" : "STANDARD", utcStamp(c.at + c.from * 6e4).slice(0, 15), c.from, c.to));
  lines.push("END:VTIMEZONE");
  return lines;
}
function escapeText(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, "\\n").replace(/\t/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
}
var bare = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, "");
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
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
function calendar(events, extra = []) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Siosia//Siosia//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...extra, ...events, "END:VCALENDAR"];
  return lines.map(fold).join("\r\n") + "\r\n";
}
var alarm = (min, summary) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(summary)}`, `TRIGGER:-PT${min}M`, "END:VALARM"];
function placeLines(p) {
  if (!p) return [];
  const out = p.label ? [`LOCATION:${escapeText(p.label)}`] : [];
  if (typeof p.lat === "number" && typeof p.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
    out.push(`GEO:${p.lat.toFixed(6)};${p.lng.toFixed(6)}`);
  }
  return out;
}
function appointmentIcs(a, ctx) {
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
    ...back ? [`URL:${back}`] : [],
    `STATUS:${status}`,
    ...status === "CANCELLED" ? [] : ctx.reminderMin.flatMap((m) => alarm(m, summary)),
    "END:VEVENT"
  ];
  return calendar(ev);
}
function seriesIcs(a, ctx) {
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
    ...back ? [`URL:${back}`] : [],
    `STATUS:${status}`,
    ...status === "CANCELLED" ? [] : ctx.reminderMin.flatMap((m) => alarm(m, summary)),
    "END:VEVENT"
  ];
  return calendar(ev, vtimezone(tz, first - 864e5, last + durMs + 864e5));
}
function rideIcs(r, ctx) {
  const at = r.scheduledFor ?? r.requestedAt;
  const summary = rideTitle(r, ctx.lang);
  const cancelled = gone(r.status);
  const back = link(ctx);
  const ev = [
    "BEGIN:VEVENT",
    `UID:${bare(r.id)}`,
    `DTSTAMP:${utcStamp(ctx.now ?? Date.now())}`,
    `DTSTART:${utcStamp(at)}`,
    `DTEND:${utcStamp(at + Math.max(5, Math.round(r.estMin)) * 6e4)}`,
    `SUMMARY:${escapeText(summary)}`,
    ...placeLines(r.pickup),
    `DESCRIPTION:${escapeText(rideDetails(r, ctx))}`,
    ...back ? [`URL:${back}`] : [],
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    ...cancelled ? [] : alarm(RIDE_ALARM_MIN, summary),
    "END:VEVENT"
  ];
  return calendar(ev);
}

// supabase/functions/calendar/handler.ts
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
async function handleCalendar(req, read) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const q = new URL(req.url).searchParams;
  const kind = ["a", "s", "r"].find((k) => q.has(k));
  const id = kind ? q.get(kind) ?? "" : "";
  const u = q.get("u") ?? "";
  const t = q.get("t") ?? "";
  if (!kind || !UUID.test(id) || !/^[A-Za-z0-9_-]{6,40}$/.test(u) || !/^[0-9a-f]{32}$/.test(t)) return notFound();
  let data;
  try {
    data = await read(kind, id, u, t);
  } catch {
    return new Response("unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!data?.view) return notFound();
  const ctx = { lang: data.lang, timezone: data.timezone, reminderMin: data.reminderMin ?? [], siteUrl: data.siteUrl };
  let body;
  try {
    body = data.kind === "r" ? rideIcs(data.view, ctx) : data.kind === "s" ? seriesIcs(data.view, ctx) : appointmentIcs(data.view, ctx);
  } catch {
    return new Response("unavailable", { status: 500, headers: { "cache-control": "no-store" } });
  }
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

// supabase/functions/calendar/index.ts
Deno.serve((req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  return handleCalendar(req, async (kind, id, publicId, token) => {
    const { data, error } = await db.rpc("siosia_calendar_view", { p_kind: kind, p_id: id, p_public: publicId, p_token: token });
    if (error) throw error;
    return data ?? null;
  });
});
