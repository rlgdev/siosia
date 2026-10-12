// supabase/functions/push-dispatch/index.ts
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import webpush from "npm:web-push@3.6.7";

// supabase/functions/_shared/push-text.ts
function toMs(at) {
  if (at === null || at === void 0) return null;
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}
function fmt(ms, lang, tz, withDay) {
  if (ms === null) return "";
  const opts = withDay ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz } : { hour: "2-digit", minute: "2-digit", timeZone: tz };
  try {
    return new Intl.DateTimeFormat(lang === "pl" ? "pl-PL" : "en-GB", opts).format(ms);
  } catch {
    return new Intl.DateTimeFormat(lang === "pl" ? "pl-PL" : "en-GB", { ...opts, timeZone: "UTC" }).format(ms);
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
    driver_arrived: ["{driver} is here", "Your driver has arrived at the pickup."],
    booking_open: ["Looking for a driver", "Your booking {when} is now offered to drivers nearby."],
    request_new: ["New ride request", "Pickup: {pickup}. Open Siosia to take it."]
  },
  pl: {
    booking_new: ["Nowa rezerwacja {when}", "{pickup} \u2192 {dropoff}. We\u017A j\u0105 w Siosi \u2192 Rezerwacje."],
    booking_taken: ["{driver} Ci\u0119 zawiezie", "Tw\xF3j kurs {when} ma kierowc\u0119."],
    booking_released: ["Rezerwacja szuka nowego kierowcy", "{when}: proponujemy j\u0105 ponownie innym kierowcom."],
    booking_cancelled: ["Rezerwacja anulowana", "{when} z {pickup} \u2014 pasa\u017Cer anulowa\u0142."],
    time_to_go: ["Czas jecha\u0107", "Odbi\xF3r {time}: {rider}, {pickup}. Otw\xF3rz Siosi\u0119."],
    driver_coming: ["{driver} jest w drodze", "Kierowca jedzie do miejsca odbioru."],
    driver_arrived: ["{driver} czeka", "Kierowca jest na miejscu odbioru."],
    booking_open: ["Szukamy kierowcy", "Twoja rezerwacja {when} trafi\u0142a do kierowc\xF3w w pobli\u017Cu."],
    request_new: ["Nowe zam\xF3wienie", "Odbi\xF3r: {pickup}. Otw\xF3rz Siosi\u0119, aby je przyj\u0105\u0107."]
  }
};
function pushText(kind, params, lang, tz, rideId) {
  const l = lang === "pl" ? "pl" : "en";
  const [title, body] = TEXTS[l][kind] ?? TEXTS[l].booking_open;
  const ms = toMs(params.at);
  const vars = {
    when: fmt(ms, l, tz, true),
    time: fmt(ms, l, tz, false),
    pickup: params.pickup ?? "",
    dropoff: params.dropoff ?? "",
    driver: params.driver ?? "",
    rider: params.rider ?? ""
  };
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "").replace(/\s+/g, " ").trim();
  return { title: fill(title), body: fill(body), tag: `${kind}:${rideId ?? ""}` };
}

// supabase/functions/push-dispatch/dispatch.ts
var MAX_ATTEMPTS = 5;
async function dispatch(deps, limit = 100) {
  const result = { sent: 0, failed: 0, dropped: 0 };
  for (const row of await deps.pending(limit)) {
    const text = pushText(row.kind, row.params ?? {}, row.lang, row.tz, row.ride_id);
    const payload = JSON.stringify({ ...text, url: "./" });
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
    }
  });
  return Response.json({ ...result, vapidPublicKey: pub });
});
