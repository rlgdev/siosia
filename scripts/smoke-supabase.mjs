// Live smoke test of a deployed Supabase backend (spec §11 "Backend rules", on demand).
// Three throwaway anonymous users: rider, driver, outsider. Exercises the RPC API, realtime
// authorisation (private channels), the ride channel and the access rules end to end.
//
//   SUPABASE_URL=… SUPABASE_KEY=sb_publishable_… SIOSIA_INVITE=… node scripts/smoke-supabase.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;
const invite = process.env.SIOSIA_INVITE;
if (!url || !key || !invite) {
  console.error("Set SUPABASE_URL, SUPABASE_KEY (publishable) and SIOSIA_INVITE.");
  process.exit(2);
}

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};
const client = () => createClient(url, key, { auth: { storage: memory(), persistSession: true, autoRefreshToken: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

async function rpc(c, fn, args = {}) {
  const { data, error } = await c.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  if (data && typeof data === "object" && "error" in data) throw new Error(`${fn}: ${data.error}`);
  return data && typeof data === "object" && "ok" in data ? data.ok : data;
}

async function user(nick) {
  const c = client();
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw error;
  await c.realtime.setAuth(data.session.access_token);
  await rpc(c, "siosia_join", { p_code: invite, p_device: `smoke-${nick.replace(/\s/g, "")}` });
  await rpc(c, "siosia_save_profile", { p_nickname: nick, p_language: "en" });
  return { c, id: data.user.id };
}

function listen(c, topic, events) {
  const got = [];
  const ch = c.channel(topic, { config: { private: true } });
  for (const e of events) ch.on("broadcast", { event: e }, (m) => got.push({ event: e, payload: m.payload }));
  // supabase-js retries a failed join by itself (as in the app); wait up to 8 s for SUBSCRIBED.
  const ready = new Promise((resolve) => {
    let last = "NO_ANSWER";
    const timer = setTimeout(() => resolve({ s: last }), 8000);
    ch.subscribe((s) => {
      last = s;
      if (s === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve({ s });
      }
    });
  });
  return { ch, got, ready };
}

async function waitFor(pred, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return Date.now() - t0;
    await sleep(50);
  }
  return -1;
}

async function errorOf(p) {
  try {
    await p;
    return "";
  } catch (e) {
    return e.message;
  }
}

const anon = client();
const cfg = await rpc(anon, "siosia_config");
check(Boolean(cfg?.tariff?.currency) && !JSON.stringify(cfg).includes("hash"), `public config readable (${cfg.tariff.currency}, offer ${cfg.timers.offerS} s)`);

const rider = await user("Smoke Rider");
const driver = await user("Smoke Driver");
const outsider = await user("Smoke Outsider");
check(true, "three anonymous users joined with the invite code");
await rpc(driver.c, "siosia_save_vehicle", { p_make: "Test", p_model: "Car", p_colour: "Grey", p_plate: "SMOKE1", p_seats: 4 });
await rpc(driver.c, "siosia_set_online", { p_online: true });

const pings = listen(driver.c, "drivers", ["ping"]);
const riderEvents = listen(rider.c, `user:${rider.id}`, ["changed"]);
const driverEvents = listen(driver.c, `user:${driver.id}`, ["changed"]);
const spy = listen(outsider.c, `user:${rider.id}`, ["changed"]);
const [p1, p2, p3, p4] = await Promise.all([pings.ready, riderEvents.ready, driverEvents.ready, spy.ready]);
check(p1.s === "SUBSCRIBED" && p2.s === "SUBSCRIBED" && p3.s === "SUBSCRIBED", `private channels authorised for their owners (${p1.s}/${p2.s}/${p3.s})`);
check(p4.s !== "SUBSCRIBED", `outsider refused on someone else's user topic (${p4.s})`);

const pickup = { lat: 51.5072, lng: -0.1276, label: "Smoke pickup" };
const dropoff = { lat: 51.5155, lng: -0.0922, label: "Smoke dropoff" };
const ride = await rpc(rider.c, "siosia_request_ride", { p_pickup: pickup, p_dropoff: dropoff, p_est_km: 3.1, p_est_min: 11, p_fare_is_estimate: false });
check(ride.status === "requested" && ride.driver === null, `ride requested, fare frozen at ${ride.fare} ${ride.currency}`);
const pingMs = await waitFor(() => pings.got.length > 0);
check(pingMs >= 0, `driver pinged over realtime in ${pingMs} ms`);

const st0 = await rpc(driver.c, "siosia_heartbeat", { p_lat: 51.509, p_lng: -0.13 });
check(st0.offer?.rideId === ride.id && !JSON.stringify(st0.offer).includes("SMOKE1"), `offer pulled (${st0.offer?.driverDistanceKm} km to pickup)`);
await rpc(driver.c, "siosia_decide_offer", { p_offer: st0.offer.id, p_decision: "decline" });
const st = await rpc(driver.c, "siosia_refresh_offers", { p_lat: 51.509, p_lng: -0.13 });
check(st.offer?.id === st0.offer.id && st.nearbyRequests >= 1, `Show requests brings a declined request back (${st.nearbyRequests} pending nearby)`);
const before = riderEvents.got.length;
check((await rpc(driver.c, "siosia_decide_offer", { p_offer: st.offer.id, p_decision: "accept" })) === "won", "atomic accept won");
const evMs = await waitFor(() => riderEvents.got.length > before);
check(evMs >= 0, `rider notified of acceptance in ${evMs} ms`);
const seen = await rpc(rider.c, "siosia_get_ride", { p_ride: ride.id });
check(seen.driver?.vehicle?.plate === "SMOKE1", "rider sees vehicle and plate only after assignment");

const rch = listen(rider.c, `ride:${ride.id}:${seen.round}`, ["driver_pos"]);
const dch = listen(driver.c, `ride:${ride.id}:${seen.round}`, []);
const och = listen(outsider.c, `ride:${ride.id}:${seen.round}`, ["driver_pos"]);
const [r1, r2, r3] = await Promise.all([rch.ready, dch.ready, och.ready]);
check(r1.s === "SUBSCRIBED" && r2.s === "SUBSCRIBED", `ride channel open for rider and driver (${r1.s}/${r2.s})`);
check(r3.s !== "SUBSCRIBED", `outsider refused on the ride channel (${r3.s})`);
await dch.ch.send({ type: "broadcast", event: "driver_pos", payload: { lat: 51.508, lng: -0.129, heading: 90, accuracy: 5, t: Date.now() } });
const posMs = await waitFor(() => rch.got.length > 0);
check(posMs >= 0, `driver position delivered to rider in ${posMs} ms (never stored)`);

check((await errorOf(rpc(driver.c, "siosia_advance", { p_ride: ride.id, p_to: "completed", p_actual_km: 1 }))).endsWith("illegal_transition"), "illegal transition rejected");
for (const to of ["arrived", "in_progress"]) await rpc(driver.c, "siosia_advance", { p_ride: ride.id, p_to: to, p_actual_km: null });
const done = await rpc(driver.c, "siosia_advance", { p_ride: ride.id, p_to: "completed", p_actual_km: 3.4 });
check(done.status === "completed" && Number(done.fare) === Number(ride.fare), "trip completed with the frozen fare");
await rpc(rider.c, "siosia_mark_paid", { p_ride: ride.id });
await rpc(rider.c, "siosia_rate", { p_ride: ride.id, p_stars: 5, p_comment: "smoke" });
await rpc(driver.c, "siosia_rate", { p_ride: ride.id, p_stars: 5, p_comment: "" });
const earn = await rpc(driver.c, "siosia_earnings");
check(earn.todayCount >= 1, `earnings updated (${earn.todayTotal} ${earn.currency} today)`);

check((await errorOf(rpc(outsider.c, "siosia_get_ride", { p_ride: ride.id }))).endsWith("not_found"), "outsider cannot read the ride");
const { error: writeErr } = await outsider.c.from("rides").update({ fare: 0 }).eq("id", ride.id);
const { data: rows } = await outsider.c.from("rides").select("id").eq("id", ride.id);
check(Boolean(writeErr) && (rows ?? []).length === 0, "direct table writes and reads refused by RLS");

await rpc(driver.c, "siosia_set_online", { p_online: false });
for (const c of [rider.c, driver.c, outsider.c, anon]) await c.removeAllChannels();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll live checks passed.");
process.exit(failures ? 1 : 0);
