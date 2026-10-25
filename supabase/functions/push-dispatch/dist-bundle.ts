// supabase/functions/push-dispatch/index.ts
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import webpush from "npm:web-push@3.6.7";

// supabase/functions/_shared/push-text.ts
function toMs(at) {
  if (at === null || at === void 0) return null;
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}
var loc = (l) => l === "pl" ? "pl-PL" : "en-GB";
function format(ms, l, tz, opts) {
  if (ms === null) return "";
  try {
    return new Intl.DateTimeFormat(loc(l), { ...opts, timeZone: tz }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(loc(l), { ...opts, timeZone: "UTC" }).format(ms);
  }
}
function fmt(ms, lang, tz, withDay) {
  return format(
    ms,
    lang,
    tz,
    withDay ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }
  );
}
var dayMonth = (ms, l, tz) => format(ms, l, tz, { day: "numeric", month: "short" });
function rangeText(at, end, lang, tz) {
  const l = lang === "pl" ? "pl" : "en";
  const a = toMs(at);
  const e = toMs(end);
  if (a === null) return "";
  return `${fmt(a, l, tz, true)}${e === null ? "" : `\u2013${fmt(e, l, tz, false)}`}`;
}
var PL_EVERY = ["niedziel\u0119", "poniedzia\u0142ek", "wtorek", "\u015Brod\u0119", "czwartek", "pi\u0105tek", "sobot\u0119"];
var PL_FEMININE = [true, false, false, true, false, false, true];
function weekdayIndex(ms, tz) {
  const d = format(ms, "en", tz, { weekday: "short" });
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(d);
}
function seriesText(p, lang, tz) {
  const l = lang === "pl" ? "pl" : "en";
  const first = toMs(p.first ?? p.at);
  const last = toMs(p.last);
  const at = toMs(p.at);
  const end = toMs(p.end);
  if (first === null) return "";
  const minutes = at !== null && end !== null ? end - at : 0;
  const time = `${fmt(first, l, tz, false)}\u2013${fmt(first + minutes, l, tz, false)}`;
  const wd = weekdayIndex(first, tz);
  const biweekly = p.rule === "biweekly";
  const every = l === "pl" ? `co ${biweekly ? PL_FEMININE[wd] ? "drug\u0105 " : "drugi " : ""}${PL_EVERY[wd] ?? ""}` : `every ${biweekly ? "other " : ""}${format(first, "en", tz, { weekday: "short" })}`;
  const span = last !== null ? `, ${dayMonth(first, l, tz)} \u2013 ${dayMonth(last, l, tz)}` : "";
  return `${every} ${time}${span}${p.count ? ` (${p.count}\xD7)` : ""}`;
}
var LEG = {
  en: { there: "there", back: "back" },
  pl: { there: "tam", back: "powrotny" }
};
function leadText(slot, lang) {
  const l = lang === "pl" ? "pl" : "en";
  if (slot === 1440) return l === "pl" ? "Jutro" : "Tomorrow";
  if (slot === 120) return l === "pl" ? "Za 2 godziny" : "In 2 hours";
  if (slot !== void 0 && slot < 60) return l === "pl" ? `Za ${slot} min` : `In ${slot} min`;
  const h = Math.round((slot ?? 0) / 60 * 10) / 10;
  return l === "pl" ? `Za ${h} godz.` : `In ${h} h`;
}
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
    appt_summary: ["Summary: {service} {when}", "{duration} \xB7 {total}{corrected}"],
    weekly_report: ["Your week in Siosia", "Last week: spent {spent} \xB7 earned {earned}."]
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
    appt_summary: ["Podsumowanie: {service} {when}", "{duration} \xB7 {total}{corrected}"],
    weekly_report: ["Tw\xF3j tydzie\u0144 w Siosi", "Ostatni tydzie\u0144: wydane {spent} \xB7 zarobione {earned}."]
  }
};
function moneyText(amount, currency, lang) {
  const l = lang === "pl" ? "pl" : "en";
  const n = Number(amount ?? 0);
  const num = new Intl.NumberFormat(loc(l), { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(Number.isFinite(n) ? n : 0);
  return currency ? `${num} ${currency}` : num;
}
function durationText(minutes, lang) {
  const l = lang === "pl" ? "pl" : "en";
  const m = Math.max(0, Math.round(Number(minutes ?? 0)));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const hours = h ? l === "pl" ? `${h} godz.` : `${h} h` : "";
  return [hours, rest || !h ? `${rest} min` : ""].filter(Boolean).join(" ");
}
var CHAT_PUSH_CHARS = 80;
function kidsText(names, lang) {
  const l = lang === "pl" ? "pl" : "en";
  const list = (names ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
  if (list.length < 2) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} ${l === "pl" ? "i" : "and"} ${list[list.length - 1]}`;
}
var WITH_KIDS = { en: (k) => `, with ${k}`, pl: (k) => `, z: ${k}` };
var OPEN_TEXTS = {
  en: { appt_expired: ["Nobody took it", "Nobody took your request: {service} {range}."] },
  pl: { appt_expired: ["Nikt si\u0119 nie zg\u0142osi\u0142", "Nikt nie przyj\u0105\u0142 Twojej pro\u015Bby: {service} {range}."] }
};
var SOMEONE = { en: "Someone", pl: "Kto\u015B" };
var WITH = { en: (o) => `With ${o}`, pl: (o) => `Z ${o}` };
var YOUR_OPEN = { en: "Your open request", pl: "Twoja otwarta pro\u015Bba" };
function pushText(kind, params, lang, tz, id) {
  const l = lang === "pl" ? "pl" : "en";
  const open = kind.startsWith("appt_") && (!!params.open || params.status === "open" || !params.provider && params.role !== "provider");
  const [title, body] = (open ? OPEN_TEXTS[l][kind] : void 0) ?? TEXTS[l][kind] ?? TEXTS[l].booking_open;
  const ms = toMs(params.at);
  const series = !!params.rule && (kind === "appt_new" || kind === "appt_open" || kind === "appt_accepted" || kind === "appt_declined" || kind === "appt_expired");
  const status = params.status === "waiting" && open ? "open" : params.status;
  const withWho = params.other ? WITH[l](params.other) : status === "open" ? YOUR_OPEN[l] : "";
  const declined = (params.declined ?? []).map((d) => dayMonth(toMs(d), l, tz)).filter(Boolean);
  const total = (params.accepted ?? 0) + declined.length;
  const kids = params.role === "client" ? "" : kidsText(params.kids, l);
  const chat = (params.text ?? "").replace(/\s+/g, " ").trim();
  const cut = chat.length > CHAT_PUSH_CHARS ? `${chat.slice(0, CHAT_PUSH_CHARS).trimEnd()}\u2026` : chat;
  const vars = {
    sender: params.sender || SOMEONE[l],
    text: cut,
    // 2.5: an update's words, "📷" marking a photo — alone when there are no words.
    update: params.photo ? cut ? `${cut} \u{1F4F7}` : l === "pl" ? "\u{1F4F7} Zdj\u0119cie" : "\u{1F4F7} Photo" : cut,
    about: params.kid || params.service ? ` \xB7 ${params.kid || params.service}` : "",
    minutes: params.minutes === void 0 || params.minutes === null ? "" : String(params.minutes),
    duration: durationText(params.minutes, l),
    total: moneyText(params.total, params.currency, l),
    corrected: params.corrected ? l === "pl" ? " (czas poprawiony)" : " (time corrected)" : "",
    spent: moneyText(params.spent, params.currency, l),
    earned: moneyText(params.earned, params.currency, l),
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
    atplace: params.place ? ` \xB7 ${params.place}` : "",
    withplace: [withWho, params.place ?? ""].filter(Boolean).join(" \xB7 "),
    attime: params.time ? l === "pl" ? ` o ${fmt(toMs(params.time), l, tz, false)}` : ` at ${fmt(toMs(params.time), l, tz, false)}` : params.repeat ? l === "pl" ? " w ka\u017Cdym terminie" : " for every date" : "",
    status: apptStatusText(status, params.provider, l),
    rides: (params.rides ?? []).length ? ` ${(params.rides ?? []).map((r) => rideLineText(r, l)).join(" \xB7 ")}` : "",
    clashes: declined.length ? l === "pl" ? ` ${params.accepted} z ${total} potwierdzone; odrzucone: ${declined.join(", ")}` : ` ${params.accepted} of ${total} confirmed; declined: ${declined.join(", ")}` : "",
    remaining: params.left !== void 0 && params.from !== void 0 ? l === "pl" ? ` Od ${dayMonth(toMs(params.from), l, tz)}, ${params.left} ${params.left === 1 ? "termin" : "pozosta\u0142e"}.` : ` From ${dayMonth(toMs(params.from), l, tz)}, ${params.left} left.` : ""
  };
  const tidy = (s) => kind === "chat_message" || kind === "session_update" ? s : s.replace(/\s+([.,])/g, "$1").replace(/\.\./g, ".").trim().replace(/^[.,·]\s*/, "");
  const fill = (s) => tidy(
    s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "").replace(/\s+/g, " ").trim()
  );
  const tag = kind === "chat_message" ? `chat:${params.room ?? id ?? ""}` : kind === "session_update" ? `update:${id ?? ""}` : kind === "client_coming" ? `coming:${id ?? ""}` : kind === "appt_summary" ? `summary:${id ?? ""}` : kind === "weekly_report" ? `report:${params.week ?? ""}` : kind.startsWith("family_") ? "family" : kind.startsWith("contract_") ? "contract" : `${kind}:${id ?? ""}`;
  return { title: fill(title), body: fill(body), tag };
}

// supabase/functions/push-dispatch/dispatch.ts
var openUrl = (kind, params, appointmentId) => {
  if (kind === "chat_message") return params?.room ? `./?chat=${params.room}` : "./";
  if (kind === "session_update" || kind === "client_coming") return appointmentId ? `./?appointment=${appointmentId}` : "./?open=planned";
  if (kind === "appt_summary") return appointmentId ? `./?appointment=${appointmentId}` : "./?open=history";
  if (kind.startsWith("family_") || kind.startsWith("contract_")) return "./?open=family";
  if (kind === "weekly_report") return params?.week ? `./?open=report&week=${params.week}` : "./?open=report";
  return kind.startsWith("appt_") || kind.startsWith("booking_") ? "./?open=planned" : "./";
};
var MAX_ATTEMPTS = 5;
var CHAT_GRACE_MS = 2e3;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function isRead(deps, messageId) {
  try {
    return await deps.isMessageRead(messageId);
  } catch {
    return false;
  }
}
async function dispatch(deps, limit = 100) {
  const result = { sent: 0, failed: 0, dropped: 0, skipped: 0 };
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  for (const row of await deps.pending(limit)) {
    const params = row.params ?? {};
    if (row.kind === "chat_message") {
      const queued = Date.parse(row.created_at ?? "");
      const left = Number.isFinite(queued) ? Math.min(CHAT_GRACE_MS, CHAT_GRACE_MS - (now() - queued)) : 0;
      if (left > 0) await wait(left);
      if (params.messageId && await isRead(deps, params.messageId)) {
        await deps.markSent(row.id);
        result.skipped++;
        continue;
      }
    }
    const text = pushText(row.kind, params, row.lang, row.tz, row.appointment_id ?? row.ride_id);
    const payload = JSON.stringify({
      ...text,
      url: openUrl(row.kind, params, row.appointment_id),
      kind: row.kind,
      ...row.kind === "chat_message" && params.room ? { room: params.room } : {}
    });
    const subs = await deps.subscriptions(row.user_id);
    let delivered = 0;
    let retry = false;
    for (const sub of subs) {
      try {
        await deps.send(sub, payload);
        delivered++;
      } catch (e) {
        const status = e.statusCode ?? 0;
        if (status === 404 || status === 410) {
          await deps.dropSubscription(sub.endpoint);
          result.dropped++;
        } else retry = true;
      }
    }
    if (delivered > 0 || subs.length === 0 || !retry || row.attempts >= MAX_ATTEMPTS) {
      await deps.markSent(row.id);
      if (delivered > 0) result.sent++;
    } else {
      await deps.markFailed(row.id);
      result.failed++;
    }
  }
  return result;
}

// supabase/functions/push-dispatch/index.ts
Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const { data: secrets, error: secretsError } = await db.from("app_secrets").select("push_secret, vapid_public, vapid_private").eq("id", 1).single();
  if (secretsError || !secrets?.push_secret || req.headers.get("x-push-secret") !== secrets.push_secret) {
    return new Response("forbidden", { status: 403 });
  }
  let pub = Deno.env.get("VAPID_PUBLIC_KEY") || secrets.vapid_public;
  let priv = Deno.env.get("VAPID_PRIVATE_KEY") || secrets.vapid_private;
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    await db.from("app_secrets").update({ vapid_public: keys.publicKey, vapid_private: keys.privateKey }).eq("id", 1).is("vapid_public", null);
    const { data: kept } = await db.from("app_secrets").select("vapid_public, vapid_private").eq("id", 1).single();
    pub = kept?.vapid_public ?? keys.publicKey;
    priv = kept?.vapid_private ?? keys.privateKey;
  }
  const { data: cfg } = await db.from("app_config").select("site_url, operator_contact").eq("id", 1).single();
  const contact = cfg?.operator_contact ?? "";
  const subject = Deno.env.get("VAPID_SUBJECT") || (/^[^@\s]+@[^@\s]+$/.test(contact) ? `mailto:${contact}` : "") || cfg?.site_url || "https://github.com/rlgdev/siosia";
  webpush.setVapidDetails(subject, pub, priv);
  const result = await dispatch({
    async pending(limit) {
      const { data, error } = await db.rpc("siosia_claim_push", { p_limit: limit });
      if (error) throw error;
      return data ?? [];
    },
    async subscriptions(userId) {
      const { data, error } = await db.from("push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", userId);
      if (error) throw error;
      return data ?? [];
    },
    async send(sub, payload) {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600, urgency: "high" });
    },
    async markSent(id) {
      await db.from("push_outbox").update({ sent_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", id);
    },
    async markFailed(id) {
      await db.from("push_outbox").update({ claimed_at: null }).eq("id", id);
    },
    async dropSubscription(endpoint) {
      await db.from("push_subscriptions").delete().eq("endpoint", endpoint);
    },
    async isMessageRead(messageId) {
      const { data, error } = await db.from("messages").select("read_at").eq("id", messageId).maybeSingle();
      return !error && !!data?.read_at;
    }
  });
  return Response.json({ ...result, vapidPublicKey: pub });
});
