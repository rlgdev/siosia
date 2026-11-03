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
var TEXTS = {
  en: {
    booking_new: ["New booking {when}", "{pickup} \u2192 {dropoff}. Take it in Siosia \u2192 Booked rides."],
    booking_taken: ["{driver} will drive you", "Your ride {when} has a driver."],
    booking_released: ["Your booking needs a new driver", "{when}: we offer it to other drivers again."],
    booking_cancelled: ["Booking cancelled", "{when} from {pickup} was cancelled by the rider."],
    time_to_go: ["Time to go", "Pickup {time}: {rider} at {pickup}. Open Siosia."],
    driver_coming: ["{driver} is on the way", "Your driver is heading to the pickup."],
    driver_departed: ["{driver} has set off", "The car is moving towards your pickup \u2014 see it on the map."],
    driver_arrived: ["{driver} is here", "Your driver has arrived at the pickup."],
    booking_open: ["Looking for a driver", "Your booking {when} is now offered to drivers nearby."],
    request_new: ["New ride request", "Pickup: {pickup}. Open Siosia to take it."],
    appt_new: ["New request: {service} {when}", "{client} asks for {service}, {range}{kids}. Answer in Siosia \u2192 Planned."],
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
    client_coming: ["{client} is heading home", "About {minutes} min \u2014 around {eta}."],
    family_invite: ["{sender} invites you to their family", "Share kids and appointments. Open Siosia to join."],
    family_joined: ["{sender} joined your family", "You now see each other's kids and appointments."],
    contract_proposed: ["{sender} proposes a contract", "Rates per hour: accept or decline in Siosia."],
    contract_accepted: ["{sender} accepted the contract", "The rates apply to new requests."],
    contract_declined: ["{sender} declined the contract", "Nothing changes; you can propose other rates."],
    contract_ended: ["{sender} ended the contract", "New requests follow the price list again."],
    contract_applied: ["{sender} applied the contract to past appointments", "Since {since}: {count} now at the contract's rates."],
    appt_summary: ["Summary: {service} {when}", "{duration} \xB7 {total}{corrected}"],
    weekly_report: ["Your week in Siosia", "Last week: spent {spent} \xB7 earned {earned}."],
    appt_tip: ["{sender} left you a tip: {total}", "For {service} {when}. Thank you!"],
    pay_remind: ["{sender} asks you to settle up", "{total} to pay since {since}. Once paid, tap \u201Cdobry Pancio\u201D on the weekly report."],
    pay_settled: ["{sender}: dobry Pancio!", "{settled} Tap to add a comment."],
    pay_comment: ["{sender} answered your dobry Pancio", "{text}"],
    sign_in: ["Keep your Siosia account", "Tap to sign in. Your profile and history then stay with you on every phone."],
    ride_tip: ["{sender} left you a tip: {total}", "For the ride from {pickup}. Thank you!"],
    // 2.14 (FR-338): {newrange} / {fromrange} are the new and the old date (a move) or length (a
    // length change); {note} is the proposer's own words, quoted.
    appt_change_proposed: ["Change proposed: {service}", "{who} proposes {newrange}{newplace} instead of {fromrange}.{note}"],
    appt_change_accepted: ["{who} accepted the change", "{service} is now {newrange}{newplace}."],
    appt_change_declined: ["{who} declined the change", "{service} stays {fromrange}."],
    booking_moved: ["Booking moved", "From {pickup}: now {when}{was}."],
    // 2.12.3 (FR-331): the reaction, then what it is on (the message's or the update's words, 📷 a photo).
    reaction: ["{sender} reacted {emoji}", "{item}"]
  },
  pl: {
    booking_new: ["Nowa rezerwacja {when}", "{pickup} \u2192 {dropoff}. We\u017A j\u0105 w Siosi \u2192 Rezerwacje."],
    booking_taken: ["{driver} Ci\u0119 zawiezie", "Tw\xF3j kurs {when} ma kierowc\u0119."],
    booking_released: ["Rezerwacja szuka nowego kierowcy", "{when}: proponujemy j\u0105 ponownie innym kierowcom."],
    booking_cancelled: ["Rezerwacja anulowana", "{when} z {pickup} \u2014 pasa\u017Cer anulowa\u0142."],
    time_to_go: ["Czas jecha\u0107", "Odbi\xF3r {time}: {rider}, {pickup}. Otw\xF3rz Siosi\u0119."],
    driver_coming: ["{driver} jest w drodze", "Kierowca jedzie do miejsca odbioru."],
    driver_departed: ["{driver} ruszy\u0142(a)", "Auto jedzie do Twojego miejsca odbioru \u2014 zobacz je na mapie."],
    driver_arrived: ["{driver} czeka", "Kierowca jest na miejscu odbioru."],
    booking_open: ["Szukamy kierowcy", "Twoja rezerwacja {when} trafi\u0142a do kierowc\xF3w w pobli\u017Cu."],
    request_new: ["Nowe zam\xF3wienie", "Odbi\xF3r: {pickup}. Otw\xF3rz Siosi\u0119, aby je przyj\u0105\u0107."],
    appt_new: ["Nowa pro\u015Bba: {service} {when}", "{client} prosi o: {service}, {range}{kids}. Odpowiedz w Siosi \u2192 Zaplanowane."],
    appt_open: ["Mo\u017Cesz pom\xF3c? {service}", "{client} prosi o pomoc: {service} {range}{atplace}. Otw\xF3rz Siosi\u0119, aby si\u0119 tego podj\u0105\u0107."],
    appt_accepted: ["{provider} potwierdza", "{service} {range} \u2014 potwierdzone{kids}.{clashes}"],
    appt_declined: ["{provider} nie mo\u017Ce", "{service} {range} \u2014 odrzucone."],
    appt_cancelled: ["{service} {when} odwo\u0142ane", "Odwo\u0142ane przez: {who}. {service} {range}.{remaining}"],
    appt_expired: ["Brak odpowiedzi od {provider}", "{service} {range} \u2014 bez odpowiedzi, pro\u015Bba wygas\u0142a."],
    appt_reminder: ["{lead}: {service} {range}", "{withplace}{kids}. {status}.{rides}"],
    appt_ride_added: ["{who} dodaje przejazd", "{service} {when}: przejazd {leg}{attime}, szukamy kierowcy."],
    appt_ride_taken: ["Przejazd potwierdzony: {driver}", "{service} {when}: przejazd {leg} ma kierowc\u0119."],
    appt_ride_lost: ["Przejazd szuka kierowcy", "{service} {when}: przejazd {leg} zn\xF3w bez kierowcy."],
    appt_ride_failed: ["Nie znaleziono kierowcy", "{service} {when}: przejazd {leg} nie doszed\u0142 do skutku."],
    chat_message: ["{sender}", "{text}"],
    session_update: ["{sender}{about}", "{update}"],
    client_coming: ["{client} wraca do domu", "Za oko\u0142o {minutes} min \u2014 na miejscu ok. {eta}."],
    family_invite: ["{sender} zaprasza Ci\u0119 do rodziny", "Wsp\xF3lne dzieci i wizyty. Otw\xF3rz Siosi\u0119, aby do\u0142\u0105czy\u0107."],
    family_joined: ["{sender} do\u0142\u0105cza do Twojej rodziny", "Widzicie teraz nawzajem swoje dzieci i wizyty."],
    contract_proposed: ["{sender} proponuje umow\u0119", "Stawki za godzin\u0119: zaakceptuj lub odrzu\u0107 w Siosi."],
    contract_accepted: ["{sender} akceptuje umow\u0119", "Stawki obowi\u0105zuj\u0105 dla nowych pr\xF3\u015Bb."],
    contract_declined: ["{sender} odrzuca umow\u0119", "Nic si\u0119 nie zmienia; mo\u017Cesz zaproponowa\u0107 inne stawki."],
    contract_ended: ["{sender} ko\u0144czy umow\u0119", "Nowe pro\u015Bby zn\xF3w wed\u0142ug cennika."],
    contract_applied: ["{sender} stosuje umow\u0119 do minionych termin\xF3w", "Od {since}: {count} \u2014 teraz wed\u0142ug stawek z umowy."],
    appt_summary: ["Podsumowanie: {service} {when}", "{duration} \xB7 {total}{corrected}"],
    weekly_report: ["Tw\xF3j tydzie\u0144 w Siosi", "Ostatni tydzie\u0144: wydane {spent} \xB7 zarobione {earned}."],
    appt_tip: ["{sender} zostawia Ci napiwek: {total}", "Za {service} {when}. Dzi\u0119kujemy!"],
    pay_remind: ["{sender} prosi o rozliczenie", "Do zap\u0142aty {total} od {since}. Po zap\u0142acie stuknij \u201Edobry Pancio\u201D w raporcie tygodnia."],
    pay_settled: ["{sender}: dobry Pancio!", "{settled} Stuknij, aby doda\u0107 komentarz."],
    pay_comment: ["{sender} odpowiada na dobry Pancio", "{text}"],
    sign_in: ["Zachowaj swoje konto w Siosi", "Stuknij, aby si\u0119 zalogowa\u0107. Profil i historia zostan\u0105 z Tob\u0105 na ka\u017Cdym telefonie."],
    ride_tip: ["{sender} zostawia Ci napiwek: {total}", "Za kurs z {pickup}. Dzi\u0119kujemy!"],
    appt_change_proposed: ["Propozycja zmiany: {service}", "{who} proponuje {newrange}{newplace} zamiast {fromrange}.{note}"],
    appt_change_accepted: ["{who} przyjmuje zmian\u0119", "{service} jest teraz {newrange}{newplace}."],
    appt_change_declined: ["{who} odrzuca zmian\u0119", "{service} bez zmian: {fromrange}."],
    booking_moved: ["Rezerwacja przesuni\u0119ta", "Z {pickup}: teraz {when}{was}."],
    reaction: ["{sender} reaguje {emoji}", "{item}"]
  }
};
var PUSH_KINDS = Object.keys(TEXTS.en);
function kidsText(names, lang) {
  const l = lang === "pl" ? "pl" : "en";
  const list = (names ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
  if (list.length < 2) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} ${l === "pl" ? "i" : "and"} ${list[list.length - 1]}`;
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
    withKids: (k) => `With ${k}`,
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
    withKids: (k) => `Z: ${k}`,
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
  const kids = a.role === "provider" ? kidsText((a.kids ?? []).map((k) => k.name), l) : "";
  if (kids) lines.push(W[l].withKids(kids));
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
function seriesRule(a) {
  const s = a.series;
  const first = s?.first ?? s?.starts[0] ?? a.startsAt;
  const durMs = s?.durationMin !== void 0 && s.durationMin !== null && s.durationMin > 0 ? s.durationMin * 6e4 : a.endsAt - a.startsAt;
  const place = s?.place !== void 0 ? s.place : a.place;
  return { first, durMs, place };
}
function seriesIcs(a, ctx) {
  const s = a.series;
  if (!s) return appointmentIcs(a, ctx);
  const tz = ctx.timezone;
  const { first, durMs, place } = seriesRule(a);
  const moved = s.moved ?? [];
  const summary = appointmentTitle(a, ctx.lang);
  const view = asSeries(a);
  const status = icsStatus(view.status);
  const back = link(ctx);
  const description = `DESCRIPTION:${escapeText(appointmentDetails(view, ctx))}`;
  const tail = [description, ...back ? [`URL:${back}`] : [], `STATUS:${status}`, ...status === "CANCELLED" ? [] : ctx.reminderMin.flatMap((m) => alarm(m, summary))];
  const stamp = `DTSTAMP:${utcStamp(ctx.now ?? Date.now())}`;
  const ev = [
    "BEGIN:VEVENT",
    `UID:${bare(s.id)}`,
    stamp,
    `DTSTART;TZID=${tz}:${localStamp(first, tz)}`,
    `DTEND;TZID=${tz}:${localStamp(first + durMs, tz)}`,
    `RRULE:FREQ=WEEKLY;INTERVAL=${s.rule === "biweekly" ? 2 : 1};COUNT=${s.count}`,
    ...s.gaps.map((g) => `EXDATE;TZID=${tz}:${localStamp(g, tz)}`),
    `SUMMARY:${escapeText(summary)}`,
    ...placeLines(place),
    ...tail,
    "END:VEVENT",
    // 2.14 (FR-340, V95): each moved date overrides its rule slot (RFC 5545 RECURRENCE-ID).
    ...moved.flatMap((m) => [
      "BEGIN:VEVENT",
      `UID:${bare(s.id)}`,
      stamp,
      `RECURRENCE-ID;TZID=${tz}:${localStamp(m.orig, tz)}`,
      `DTSTART;TZID=${tz}:${localStamp(m.start, tz)}`,
      `DTEND;TZID=${tz}:${localStamp(m.end, tz)}`,
      `SUMMARY:${escapeText(summary)}`,
      ...placeLines(m.place),
      ...tail,
      "END:VEVENT"
    ])
  ];
  const times = [first, ...s.starts, ...s.gaps, ...moved.flatMap((m) => [m.orig, m.start, m.end])].filter((t) => Number.isFinite(t));
  const from = Math.min(...times);
  const to = Math.max(...times);
  return calendar(ev, vtimezone(tz, from - 864e5, to + durMs + 864e5));
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
