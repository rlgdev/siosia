// @vitest-environment node
// Backend-rules tests (spec §11 "Backend rules") against the REAL SQL migration, executed in PGlite
// (Postgres compiled to WebAssembly) — no cloud project or credentials needed. A small prelude stubs
// the parts of Supabase the migration relies on: auth.uid(), auth.users, realtime.messages/send/topic.

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(new URL("../../supabase/migrations/0001_siosia.sql", import.meta.url), "utf8");

const PRELUDE = `
create schema if not exists extensions;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists realtime;
create table if not exists realtime.messages (
  id bigserial primary key, topic text not null, extension text not null default 'broadcast',
  event text, payload jsonb, private boolean, inserted_at timestamptz default now());
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '') $$;
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language sql security definer as $$
  insert into realtime.messages (topic, extension, event, payload, private) values (topic, 'broadcast', event, payload, private) $$;
grant usage on schema public, auth, realtime, extensions to anon, authenticated;
grant select, insert on realtime.messages to authenticated;
`;

type Json = Record<string, unknown>;

let db: PGlite;

const U = {
  rider: "00000000-0000-4000-8000-000000000001",
  d1: "00000000-0000-4000-8000-000000000002",
  d2: "00000000-0000-4000-8000-000000000003",
  d3: "00000000-0000-4000-8000-000000000004",
  far: "00000000-0000-4000-8000-000000000005",
  stranger: "00000000-0000-4000-8000-000000000006",
  rider2: "00000000-0000-4000-8000-000000000007"
};

const PICKUP = { lat: 52.2297, lng: 21.0122, label: "Centrum" };
const DROPOFF = { lat: 52.2397, lng: 21.0422, label: "Praga" };
const NEAR = (dLat: number) => ({ lat: PICKUP.lat + dLat, lng: PICKUP.lng });

/** Runs `sql` as an authenticated user (RLS applies), returning the first column of the first row. */
async function as<T = Json>(uid: string, sql: string, params: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await tx.exec("set local role authenticated");
    const res = await tx.query<Record<string, unknown>>(sql, params);
    const row = res.rows[0];
    return (row ? Object.values(row)[0] : undefined) as T;
  });
}

/** Calls an API function and unwraps {ok} / throws on {error}. */
async function call<T = Json>(uid: string, fn: string, args: unknown[] = []): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  const res = await as<{ ok?: T; error?: string }>(uid, `select public.${fn}(${placeholders})`, args);
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error(res.error);
  return (res as { ok: T }).ok;
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
}

async function admin(sql: string, params: unknown[] = []) {
  return db.query<Record<string, unknown>>(sql, params);
}

async function onboard(uid: string, nick: string, vehicle = false) {
  await call(uid, "siosia_join", ["pilot 2026", `dev-${uid.slice(-2)}`]);
  await call(uid, "siosia_save_profile", [nick, "en"]);
  if (vehicle) await call(uid, "siosia_save_vehicle", ["Skoda", "Fabia", "Blue", `WX ${uid.slice(-4)}`, 4]);
}

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // idempotent re-run
  for (const id of Object.values(U)) await admin("insert into auth.users (id) values ($1)", [id]);
  await admin("select public.siosia_set_invite_code('PILOT 2026')");
}, 60_000);

describe("SQL backend (PGlite)", () => {
  it("serves the public config without the invite hash", async () => {
    const cfg = await as<Json>(U.stranger, "select public.siosia_config()");
    expect(cfg).toMatchObject({ tariff: { currency: "PLN" }, timers: { offerS: 20, expiryS: 1200, noShowS: 300, retryS: 120 }, dispatchRadiusKm: 8 });
    expect(JSON.stringify(cfg)).not.toMatch(/hash|\$2[aby]\$/);
    expect(await errorOf(as(U.stranger, "select * from public.app_secrets"))).toMatch(/permission denied/);
  });

  it("enforces the invite code server-side (FR-007) and rate-limits guesses", async () => {
    expect(await errorOf(call(U.stranger, "siosia_my_state"))).toBe("not_member");
    expect(await errorOf(call(U.stranger, "siosia_join", ["WRONG", "dev-x"]))).toBe("bad_invite");
    for (let i = 0; i < 9; i++) await errorOf(call(U.stranger, "siosia_join", ["WRONG", "dev-x"]));
    expect(await errorOf(call(U.stranger, "siosia_join", ["PILOT 2026", "dev-x"]))).toBe("rate_limited");
    // codes are normalised: spaces and case do not matter
    await call(U.rider, "siosia_join", [" pilot2026 ", "dev-r"]);
    expect(await as(U.rider, "select public.siosia_is_member('dev-r')")).toBe(true);
    expect(await as(U.rider, "select public.siosia_is_member('other-device')")).toBe(false);
  });

  it("onboards with a nickname only and validates the vehicle", async () => {
    expect(await errorOf(call(U.rider, "siosia_save_profile", ["x", "en"]))).toBe("bad_nickname");
    const p = await call<Json>(U.rider, "siosia_save_profile", ["Ola", "pl"]);
    expect(p).toMatchObject({ nickname: "Ola", language: "pl", rating: { mean: null, count: 0 } });
    await onboard(U.d1, "Adam", true);
    await onboard(U.d2, "Bea", true);
    await onboard(U.d3, "Cyryl", true);
    await onboard(U.far, "Daleki", true);
    await onboard(U.rider2, "Ewa");
    expect(await errorOf(call(U.d1, "siosia_save_vehicle", ["Skoda", "Fabia", "Blue", "WX", 9]))).toBe("bad_vehicle");
    expect(await errorOf(call(U.rider2, "siosia_set_online", [true]))).toBe("no_vehicle");
  });

  it("denies direct table writes and cross-user reads (FR-006, NFR-07)", async () => {
    expect(await errorOf(as(U.d1, "update public.rides set fare = 1"))).toMatch(/permission denied/);
    expect(await errorOf(as(U.d1, "insert into public.profiles (user_id, nickname) values ($1, 'Hacker')", [U.d1]))).toMatch(/permission denied/);
    // No direct reads either: tables would expose other users' ids; the API returns what each may see.
    for (const t of ["vehicles", "profiles", "rides", "offers", "ratings", "driver_status", "memberships"])
      expect(await errorOf(as(U.d1, `select count(*) from public.${t}`)), t).toMatch(/permission denied/);
  });

  let rideId = "";

  it("freezes the fare at request time and refuses a second active ride", async () => {
    const ride = await call<Json>(U.rider, "siosia_request_ride", [PICKUP, DROPOFF, 3.21, 9.4, false]);
    rideId = ride.id as string;
    // 5 + 2.5·3.21 + 0.5·9.4 = 17.725 → 17.50 (FR-050); same as computeFare() in TS
    expect(Number(ride.fare)).toBe(17.5);
    expect(ride).toMatchObject({ status: "requested", role: "rider", driver: null, estKm: 3.2, estMin: 9 });
    expect(await errorOf(call(U.rider, "siosia_request_ride", [PICKUP, DROPOFF, 3, 9, false]))).toBe("active_ride");
    const topics = (await admin("select topic, event from realtime.messages")).rows.map((r) => `${r.topic}/${r.event}`);
    expect(topics).toContain("drivers/ping");
    expect(topics).toContain(`user:${U.rider}/changed`);
  });

  it("refuses a request from an online driver and going online with an active ride (FR-005)", async () => {
    await call(U.d1, "siosia_set_online", [true]);
    expect(await errorOf(call(U.d1, "siosia_request_ride", [PICKUP, DROPOFF, 3, 9, false]))).toBe("online_as_driver");
    await call(U.rider, "siosia_save_vehicle", ["Fiat", "Panda", "Red", "WX RIDER", 4]);
    expect(await errorOf(call(U.rider, "siosia_set_online", [true]))).toBe("active_ride");
  });

  it("dispatches to every eligible driver in range, one card each (§6)", async () => {
    for (const d of [U.d2, U.d3, U.far]) await call(d, "siosia_set_online", [true]);
    const s1 = await call<Json>(U.d1, "siosia_heartbeat", [NEAR(0.01).lat, NEAR(0.01).lng]);
    const s2 = await call<Json>(U.d2, "siosia_heartbeat", [NEAR(0.02).lat, NEAR(0.02).lng]);
    const s3 = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    const sf = await call<Json>(U.far, "siosia_heartbeat", [NEAR(0.2).lat, NEAR(0.2).lng]); // ~22 km
    for (const s of [s1, s2, s3]) {
      expect(s.offer).toMatchObject({ rideId, status: "offered", rider: { nickname: "Ola" } });
      expect(JSON.stringify(s.offer)).not.toMatch(/plate|vehicle/);
    }
    expect(sf.offer).toBeNull();
    const ride = await call<Json>(U.rider, "siosia_get_ride", [rideId]);
    expect(ride.notifiedCount).toBe(3);
    // the driver position was only an argument: no table stores coordinates of drivers
    const cols = (await admin("select column_name from information_schema.columns where table_schema='public' and table_name in ('driver_status','offers')")).rows.map((r) => r.column_name);
    expect(cols.join(",")).not.toMatch(/lat|lng|position/);
  });

  it("hides the plate until assignment and lets exactly one driver win (atomic claim)", async () => {
    const offerOf = async (uid: string) => ((await call<Json>(uid, "siosia_my_state")).offer as Json).id as string;
    const o1 = await offerOf(U.d1);
    const o2 = await offerOf(U.d2);
    expect(await call(U.d1, "siosia_decide_offer", [o1, "accept"])).toBe("won");
    expect(await errorOf(call(U.d2, "siosia_decide_offer", [o2, "accept"]))).toBe("taken");
    const d3 = await call<Json>(U.d3, "siosia_my_state");
    expect(d3.offer).toBeNull();
    const ride = await call<Json>(U.rider, "siosia_get_ride", [rideId]);
    expect(ride).toMatchObject({ status: "accepted", driver: { nickname: "Adam", vehicle: { make: "Skoda", plate: "WX 0002" } } });
    // outsiders cannot read the ride, nor its realtime channel
    expect(await errorOf(call(U.d3, "siosia_get_ride", [rideId]))).toBe("not_found");
    expect(await as(U.d3, "select public.siosia_rt_can_read($1)", [`ride:${rideId}:1`])).toBe(false);
    expect(await as(U.d1, "select public.siosia_rt_can_read($1)", [`ride:${rideId}:1`])).toBe(true);
    expect(await as(U.d1, "select public.siosia_rt_can_read($1)", [`ride:${rideId}`])).toBe(false); // round required
    expect(await as(U.rider, "select public.siosia_rt_can_write($1, 'broadcast')", [`ride:${rideId}:1`])).toBe(true);
    expect(await as(U.rider, "select public.siosia_rt_can_write('drivers', 'presence')")).toBe(false);
    expect(await as(U.d2, "select public.siosia_rt_can_write('drivers', 'presence')")).toBe(true);
    expect(await as(U.rider, `select public.siosia_rt_can_read('user:${U.d1}')`)).toBe(false);
  });

  it("re-dispatches without the driver who cancelled; fare unchanged (FR-051)", async () => {
    expect(await errorOf(call(U.d1, "siosia_set_online", [false]))).toBe("active_trip"); // FR-028
    await call(U.d1, "siosia_cancel_ride", [rideId, "vehicle_problem"]);
    const ride = await call<Json>(U.rider, "siosia_get_ride", [rideId]);
    expect(ride).toMatchObject({ status: "requested", driver: null, redispatchCount: 1, notifiedCount: 0 });
    expect(Number(ride.fare)).toBe(17.5);
    const s1 = await call<Json>(U.d1, "siosia_heartbeat", [NEAR(0.01).lat, NEAR(0.01).lng]);
    expect(s1.offer).toBeNull(); // excluded
    const s2 = await call<Json>(U.d2, "siosia_heartbeat", [NEAR(0.02).lat, NEAR(0.02).lng]);
    expect(await call(U.d2, "siosia_decide_offer", [(s2.offer as Json).id, "accept"])).toBe("won");
    const prof = await call<Json>(U.d1, "siosia_get_profile");
    expect(prof.driverCancels).toBe(1);
    // The live channel is per assignment: the removed driver cannot follow round 2.
    expect((await call<Json>(U.rider, "siosia_get_ride", [rideId])).round).toBe(2);
    expect(await as(U.d1, "select public.siosia_rt_can_read($1)", [`ride:${rideId}:2`])).toBe(false);
    expect(await as(U.d1, "select public.siosia_rt_can_read($1)", [`ride:${rideId}:1`])).toBe(false);
    expect(await as(U.d2, "select public.siosia_rt_can_read($1)", [`ride:${rideId}:2`])).toBe(true);
    expect(await as(U.d2, "select public.siosia_rt_can_read($1)", [`ride:${rideId}:1`])).toBe(false);
  });

  it("validates every transition server-side (§5)", async () => {
    expect(await errorOf(call(U.d2, "siosia_advance", [rideId, "completed", 3]))).toBe("illegal_transition");
    expect(await errorOf(call(U.rider, "siosia_advance", [rideId, "arrived", null]))).toBe("forbidden");
    await call(U.d2, "siosia_advance", [rideId, "arrived", null]);
    expect(await errorOf(call(U.d2, "siosia_cancel_ride", [rideId, "no_show"]))).toBe("too_early"); // FR-025
    await call(U.d2, "siosia_advance", [rideId, "in_progress", null]);
    expect(await errorOf(call(U.rider, "siosia_cancel_ride", [rideId, null]))).toBe("illegal_transition");
    const done = await call<Json>(U.d2, "siosia_advance", [rideId, "completed", 3.6]);
    expect(done).toMatchObject({ status: "completed", actualKm: 3.6 });
    expect(Number(done.fare)).toBe(17.5); // FR-052: frozen fare next to actual totals
  });

  it("records receipt flags, one immutable rating each way, earnings", async () => {
    expect(await errorOf(call(U.d2, "siosia_mark_paid", [rideId]))).toBe("forbidden");
    await call(U.rider, "siosia_mark_paid", [rideId]);
    await call(U.d2, "siosia_mark_collected", [rideId]);
    await call(U.rider, "siosia_rate", [rideId, 5, "Great"]);
    expect(await errorOf(call(U.rider, "siosia_rate", [rideId, 1, ""]))).toBe("already_rated");
    await call(U.d2, "siosia_rate", [rideId, 4, ""]);
    const e = await call<Json>(U.d2, "siosia_earnings");
    expect(e).toMatchObject({ todayCount: 1, monthCount: 1, currency: "PLN" });
    expect(Number(e.todayTotal)).toBe(17.5);
    const hist = await call<Json[]>(U.rider, "siosia_history");
    expect(hist[0]).toMatchObject({ id: rideId, status: "completed", paid: true, myRating: 5 });
    // displayed rating stays "New" below 3 ratings (FR-061)
    const p = await call<Json>(U.d2, "siosia_get_profile");
    expect(p.rating).toEqual({ mean: null, count: 1 });
    // the stored record holds endpoints and totals only (FR-043)
    const cols = (await admin("select column_name from information_schema.columns where table_schema='public' and table_name='rides'")).rows.map((r) => String(r.column_name));
    expect(cols.filter((c) => /lat|lng/.test(c)).sort()).toEqual(["dropoff_lat", "dropoff_lng", "pickup_lat", "pickup_lng"]);
  });

  it("keeps a request open for request_expiry_s (20 min), then expires it on read (§6 rule 7)", async () => {
    const ride = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, true]);
    await admin("update public.rides set dispatch_started_at = now() - interval '1190 seconds' where id = $1", [ride.id]);
    expect((await call<Json>(U.rider2, "siosia_my_state")).ride).toMatchObject({ id: ride.id, status: "requested" });
    await admin("update public.rides set dispatch_started_at = now() - interval '1201 seconds' where id = $1", [ride.id]);
    const st = await call<Json>(U.rider2, "siosia_my_state");
    expect(st.ride).toBeNull();
    const after = await call<Json>(U.rider2, "siosia_get_ride", [ride.id]);
    expect(after).toMatchObject({ status: "expired", cancelledBy: "system", fareIsEstimate: true });
  });

  it("re-dispatches when the assigned driver has been silent for 15 min (§12; iPhones pause the app)", async () => {
    const ride = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    const s3 = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    await call(U.d3, "siosia_decide_offer", [(s3.offer as Json).id, "accept"]);
    // Screen locked or Maps in front for 14 min: the ride stays with the driver.
    await admin("update public.driver_status set last_seen = now() - interval '14 minutes' where user_id = $1", [U.d3]);
    expect(await call<Json>(U.rider2, "siosia_get_ride", [ride.id])).toMatchObject({ status: "accepted", redispatchCount: 0 });
    await admin("update public.driver_status set last_seen = now() - interval '901 seconds' where user_id = $1", [U.d3]);
    const r = await call<Json>(U.rider2, "siosia_get_ride", [ride.id]);
    expect(r).toMatchObject({ status: "requested", cancelReason: "driver_lost", redispatchCount: 1 });
    const d3 = await call<Json>(U.d3, "siosia_my_state");
    expect(d3.driverOnline).toBe(false);
    await call(U.rider2, "siosia_cancel_ride", [ride.id, null]);
    const p = await call<Json>(U.rider2, "siosia_get_profile");
    expect(p.riderCancels).toBe(0); // Siosia gave up on the driver: not held against the rider
  });

  it("counts a rider's cancellation while the ride is the driver's, not once Siosia gave up on the driver", async () => {
    const before = Number((await call<Json>(U.rider2, "siosia_get_profile")).riderCancels);
    const ride = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    await call(U.d3, "siosia_set_online", [true]); // the sweep set d3 offline above
    const s3 = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    await call(U.d3, "siosia_decide_offer", [(s3.offer as Json).id, "accept"]);
    // d3's iPhone in a pocket for 10 min: still d3's ride, a cancel counts.
    await admin("update public.driver_status set last_seen = now() - interval '10 minutes' where user_id = $1", [U.d3]);
    await call(U.rider2, "siosia_cancel_ride", [ride.id, null]);
    expect(Number((await call<Json>(U.rider2, "siosia_get_profile")).riderCancels)).toBe(before + 1);
    // Silent for 15 min: Siosia looks for another driver, and giving up then is not held against the rider.
    const again = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    await call(U.d3, "siosia_set_online", [true]);
    const s3b = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    await call(U.d3, "siosia_decide_offer", [(s3b.offer as Json).id, "accept"]);
    await admin("update public.driver_status set last_seen = now() - interval '901 seconds' where user_id = $1", [U.d3]);
    expect(await call<Json>(U.rider2, "siosia_get_ride", [again.id])).toMatchObject({ status: "requested", cancelReason: "driver_lost" });
    await call(U.rider2, "siosia_cancel_ride", [again.id, null]);
    expect(await call<Json>(U.rider2, "siosia_get_ride", [again.id])).toMatchObject({ status: "cancelled", cancelledBy: "rider" });
    expect(Number((await call<Json>(U.rider2, "siosia_get_profile")).riderCancels)).toBe(before + 1);
    await call(U.d3, "siosia_set_online", [false]);
  });

  it("offers a withdrawn card again when the driver is eligible again; a decline is final (§6 rule 4)", async () => {
    const ride = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    await call(U.d3, "siosia_set_online", [true]); // the sweep set d3 offline above
    const a = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    expect((a.offer as Json).rideId).toBe(ride.id);
    await call(U.d3, "siosia_set_online", [false]); // card withdrawn
    await call(U.d3, "siosia_set_online", [true]);
    const b = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    expect(b.offer).toMatchObject({ id: (a.offer as Json).id, rideId: ride.id, status: "offered" });
    expect((await call<Json>(U.rider2, "siosia_get_ride", [ride.id])).notifiedCount).toBe(1); // not double-counted
    await call(U.d3, "siosia_decide_offer", [(b.offer as Json).id, "decline"]);
    const c = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    expect(c.offer).toBeNull();
    // A card the driver let lapse comes back after offer_retry_s; a declined one never does.
    await admin("update public.offers set status = 'timed_out', decided_at = now() - interval '121 seconds' where id = $1", [(b.offer as Json).id]);
    const again = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    expect(again.offer).toMatchObject({ id: (b.offer as Json).id, status: "offered" });
    await call(U.d3, "siosia_decide_offer", [(b.offer as Json).id, "decline"]);
    // A decline tapped while the card was withdrawn (phone offline) is final as well.
    await admin("update public.offers set status = 'withdrawn' where id = $1", [(b.offer as Json).id]);
    await call(U.d3, "siosia_decide_offer", [(b.offer as Json).id, "decline"]);
    expect((await admin("select status from public.offers where id = $1", [(b.offer as Json).id])).rows[0]).toEqual({ status: "declined" });
    expect((await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng])).offer).toBeNull();
    await call(U.rider2, "siosia_cancel_ride", [ride.id, null]);
  });

  it("sets idle drivers offline after 60 s of silence and lets a dead driver session ride (FR-005, US4-2)", async () => {
    await admin("update public.driver_status set last_seen = now() - interval '61 seconds' where user_id = $1", [U.d2]);
    expect((await call<Json>(U.d2, "siosia_my_state")).driverOnline).toBe(false);
    // d1's driver tab died 13 s ago: requesting a ride closes that stale session instead of refusing.
    await admin("update public.driver_status set last_seen = now() - interval '13 seconds' where user_id = $1", [U.d1]);
    const ride = await call<Json>(U.d1, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    expect(ride.status).toBe("requested");
    expect((await call<Json>(U.d1, "siosia_my_state")).driverOnline).toBe(false);
    await call(U.d1, "siosia_cancel_ride", [ride.id, null]);
  });

  it("records a Decline that lands just after the countdown and returns the request deadline", async () => {
    const ride = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    expect(Number(ride.expiresAt) - Number(ride.dispatchStartedAt)).toBe(1200 * 1000);
    await call(U.d3, "siosia_set_online", [true]);
    const s = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    const id = (s.offer as Json).id;
    await admin("update public.offers set offered_at = now() - interval '21 seconds' where id = $1", [id]);
    await call(U.d3, "siosia_decide_offer", [id, "decline"]); // the sweep times it out first
    expect((await admin("select status from public.offers where id = $1", [id])).rows[0]).toEqual({ status: "declined" });
    await admin("update public.offers set decided_at = now() - interval '200 seconds' where id = $1", [id]);
    expect((await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng])).offer).toBeNull();
    await call(U.rider2, "siosia_cancel_ride", [ride.id, null]);
  });

  it("lets a driver going online, or tapping Show requests, review declined and missed requests again", async () => {
    const at = [NEAR(0.03).lat, NEAR(0.03).lng];
    const base = Number((await admin("select count(*) as n from public.rides where status = 'requested'")).rows[0].n);
    const ride = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    await call(U.d3, "siosia_set_online", [true]);
    const s = await call<Json>(U.d3, "siosia_heartbeat", at);
    expect(s).toMatchObject({ offer: { rideId: ride.id }, nearbyRequests: base + 1 });
    const id = (s.offer as Json).id;
    await call(U.d3, "siosia_decide_offer", [id, "decline"]);
    await call(U.d3, "siosia_set_online", [true]); // already online: the same session, the Decline holds
    expect(await call<Json>(U.d3, "siosia_heartbeat", at)).toMatchObject({ offer: null, nearbyRequests: base + 1 });
    expect((await call<Json>(U.d3, "siosia_my_state")).nearbyRequests).toBeNull(); // no position, no count
    // A new online session reviews it again, automatically.
    await call(U.d3, "siosia_set_online", [false]);
    await call(U.d3, "siosia_set_online", [true]);
    expect((await call<Json>(U.d3, "siosia_heartbeat", at)).offer).toMatchObject({ id, rideId: ride.id, status: "offered" });
    // "Show requests" brings back a declined card at once …
    await call(U.d3, "siosia_decide_offer", [id, "decline"]);
    expect(await call<Json>(U.d3, "siosia_refresh_offers", at)).toMatchObject({ offer: { id, status: "offered" }, nearbyRequests: base + 1 });
    // … and a lapsed one, without waiting for offer_retry_s.
    await admin("update public.offers set status = 'timed_out', offered_at = null, decided_at = now() where id = $1", [id]);
    expect(((await call<Json>(U.d3, "siosia_refresh_offers", at)).offer as Json).id).toBe(id);
    expect((await call<Json>(U.rider2, "siosia_get_ride", [ride.id])).notifiedCount).toBe(1); // not double-counted
    // Guards: offline, bad position, during a trip; the driver who cancelled stays excluded.
    expect(await errorOf(call(U.d1, "siosia_refresh_offers", at))).toBe("not_online");
    expect(await errorOf(call(U.d3, "siosia_refresh_offers", [100, 0]))).toBe("bad_input");
    expect(await call(U.d3, "siosia_decide_offer", [id, "accept"])).toBe("won");
    expect(await errorOf(call(U.d3, "siosia_refresh_offers", at))).toBe("active_trip");
    expect((await call<Json>(U.d3, "siosia_heartbeat", at)).nearbyRequests).toBeNull(); // on a trip: no count
    await call(U.d3, "siosia_cancel_ride", [ride.id, "other"]);
    await call(U.d3, "siosia_set_online", [false]);
    await call(U.d3, "siosia_set_online", [true]);
    expect(await call<Json>(U.d3, "siosia_refresh_offers", at)).toMatchObject({ offer: null, nearbyRequests: base });
    await call(U.rider2, "siosia_cancel_ride", [ride.id, null]);
  });

  it("opens a master profile from its link: shared nickname and icon, rider only, fixed fare", async () => {
    const M1 = "00000000-0000-4000-8000-000000000011";
    const M2 = "00000000-0000-4000-8000-000000000012";
    const M3 = "00000000-0000-4000-8000-000000000013";
    for (const id of [M1, M2, M3]) await admin("insert into auth.users (id) values ($1)", [id]);
    const TOKEN = "roman-link-token-0123456789";
    const join = (uid: string, token: string, device: string, replace = false) => call<Json>(uid, "siosia_join_master", [token, device, "en", replace]);
    // Operator only; the token itself is never stored; only a safe alphabet (links break otherwise).
    expect(await errorOf(as(U.rider, "select public.siosia_set_master('roman', 'x', 'Roman', null, 18)"))).toMatch(/permission denied/);
    expect(await errorOf(admin("select public.siosia_set_master('roman', 'bad+token&0123456789', 'Roman', null, 18)"))).toMatch(/letters, digits/);
    await admin("select public.siosia_set_master('roman', $1, 'Roman', 'taycan-ct-green', 18)", [TOKEN]);
    expect(await errorOf(as(U.rider, "select * from public.master_profiles"))).toMatch(/permission denied/);
    expect(await errorOf(as(U.rider, `select public.siosia_member_ok('${U.rider}')`))).toMatch(/permission denied/);
    expect(JSON.stringify((await admin("select * from public.master_profiles")).rows)).not.toContain(TOKEN);
    expect(await errorOf(join(M1, "wrong-token", "dev-m1"))).toBe("bad_link");
    // No invite code, no nickname step: the link is enough.
    const p = await call<Json>(M1, "siosia_join_master", [` ${TOKEN} `, "dev-m1", "pl", false]);
    expect(p).toMatchObject({ nickname: "Roman", language: "pl", masterId: "roman", icon: "taycan-ct-green", fixedFare: 18 });
    expect(await as(M1, "select public.siosia_is_member('dev-m1')")).toBe(true);
    await join(M2, TOKEN, "dev-m2");
    expect(await call<Json>(M2, "siosia_save_profile", ["Somebody", "pl"])).toMatchObject({ nickname: "Roman", language: "pl" });
    expect(await errorOf(call(M2, "siosia_set_online", [true]))).toBe("rider_only");
    expect(await errorOf(call(M2, "siosia_save_vehicle", ["Kia", "Ceed", "Red", "WX 1", 4]))).toBe("rider_only");
    // Fixed fare whatever the route (30 km / 45 min would be 102.50), never an estimate.
    const ride = await call<Json>(M1, "siosia_request_ride", [PICKUP, DROPOFF, 30, 45, true]);
    expect(ride).toMatchObject({ fareIsEstimate: false, rider: { nickname: "Roman", icon: "taycan-ct-green" } });
    expect(Number(ride.fare)).toBe(18);
    expect(await errorOf(join(M1, TOKEN, "dev-m1", true))).toBe("active_ride"); // no switching mid-request
    await call(U.d3, "siosia_set_online", [true]);
    const s = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    expect(s.offer).toMatchObject({ rideId: ride.id, rider: { nickname: "Roman", icon: "taycan-ct-green" } });
    expect(Number((s.offer as Json).fare)).toBe(18);
    await call(M1, "siosia_cancel_ride", [ride.id, null]);
    // Another profile on the account is replaced only with an explicit yes.
    await admin("select public.siosia_set_master('master', 'master-link-token-0123456789', 'Master Rider', null, 18)");
    await join(M3, TOKEN, "dev-m3");
    expect(await errorOf(join(M3, "master-link-token-0123456789", "dev-m3"))).toBe("has_profile");
    expect(await join(M3, "master-link-token-0123456789", "dev-m3", true)).toMatchObject({ nickname: "Master Rider", masterId: "master", icon: null });
    expect(await errorOf(join(U.rider2, TOKEN, "dev-r2"))).toBe("has_profile");
    expect(await call<Json>(U.rider2, "siosia_get_profile")).toMatchObject({ masterId: null, icon: null, fixedFare: null });
    // Switched off: the link and the link-only phones stop; switched on again: they are back.
    await admin("update public.master_profiles set active = false where id = 'roman'");
    expect(await errorOf(call(M1, "siosia_my_state"))).toBe("not_member");
    expect(await as(M1, "select public.siosia_is_member('dev-m1')")).toBe(false);
    expect(await as(M1, "select public.siosia_rt_can_read($1)", [`user:${M1}`])).toBe(false);
    expect(await errorOf(join(M2, TOKEN, "dev-m2"))).toBe("bad_link");
    await admin("select public.siosia_set_master('roman', $1, 'Roman', 'taycan-ct-green', 18)", [TOKEN]);
    expect((await call<Json>(M1, "siosia_my_state")).driverOnline).toBe(false);
    // A new token retires the old link and signs its phones out until they open the new one.
    await admin("select public.siosia_set_master('roman', 'roman-link-token-NEW-0123', 'Roman', 'taycan-ct-green', 18)");
    expect(await errorOf(call(M1, "siosia_my_state"))).toBe("not_member");
    expect(await errorOf(join(M1, TOKEN, "dev-m1"))).toBe("bad_link");
    expect(await join(M1, "roman-link-token-NEW-0123", "dev-m1")).toMatchObject({ nickname: "Roman" });
    // Deleting the profile on a device leaves the master profile.
    await call(M1, "siosia_delete_profile");
    expect((await admin("select master_id, deleted from public.profiles where user_id = $1", [M1])).rows[0]).toEqual({ master_id: null, deleted: true });
    expect((await admin("select count(*)::int as n from pg_constraint where conname in ('profiles_master_id_fkey', 'memberships_via_master_fkey')")).rows[0]).toEqual({ n: 2 });
  });

  it("gives master profiles one role: Toria rides from default places at a fixed fare, Roman drives a preset car", async () => {
    const T1 = "00000000-0000-4000-8000-000000000021";
    const R1 = "00000000-0000-4000-8000-000000000022";
    for (const id of [T1, R1]) await admin("insert into auth.users (id) values ($1)", [id]);
    const PU = { lat: 52.2504843, lng: 20.8253459, label: "Warszawsa 269, Stare Babice" };
    const DO = { lat: 52.2663135, lng: 20.814317, label: "Husarska 16, Lipków" };
    const CAR = { make: "Porsche", model: "Taycan Cross Turismo", colour: "Green", seats: 4 };
    await admin("select public.siosia_set_master('toria', 'toria-link-token-0123456789', 'Toria', null, 18, 'rider', $1::jsonb, $2::jsonb)", [
      JSON.stringify(PU),
      JSON.stringify(DO)
    ]);
    await admin("select public.siosia_set_master('romand', 'romand-link-token-0123456789', 'Roman', 'taycan-ct-green', null, 'driver', null, null, $1::jsonb)", [
      JSON.stringify(CAR)
    ]);
    expect(await errorOf(admin("select public.siosia_set_master('x1', 'xxxxx-link-token-0123456789', 'X', null, null, 'pilot')"))).toMatch(/rider or driver/);
    expect(await errorOf(admin(`select public.siosia_set_master('x1', 'xxxxx-link-token-0123456789', 'X', null, null, 'rider', '{"lat": 1}'::jsonb)`))).toMatch(/A place is/);
    expect(await errorOf(admin(`select public.siosia_set_master('x1', 'xxxxx-link-token-0123456789', 'X', null, null, 'driver', null, null, '{"make": "Kia"}'::jsonb)`))).toMatch(/A vehicle is/);
    const t = await call<Json>(T1, "siosia_join_master", ["toria-link-token-0123456789", "dev-t1", "pl", false]);
    expect(t).toMatchObject({ nickname: "Toria", masterRole: "rider", fixedFare: 18, defaultPickup: PU, defaultDropoff: DO, masterVehicle: null });
    const r = await call<Json>(R1, "siosia_join_master", ["romand-link-token-0123456789", "dev-r1", "pl", false]);
    expect(r).toMatchObject({ nickname: "Roman", masterRole: "driver", icon: "taycan-ct-green", fixedFare: null, defaultPickup: null, masterVehicle: CAR });
    expect(await errorOf(call(R1, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]))).toBe("driver_only");
    expect(await errorOf(call(R1, "siosia_set_online", [true]))).toBe("no_vehicle");
    await call(R1, "siosia_save_vehicle", ["Porsche", "Taycan Cross Turismo", "Green", "WX 5555", 4]);
    await call(R1, "siosia_set_online", [true]);
    const ride = await call<Json>(T1, "siosia_request_ride", [PU, DO, 3, 7, false]);
    expect(Number(ride.fare)).toBe(18);
    const s = await call<Json>(R1, "siosia_heartbeat", [PU.lat, PU.lng]);
    expect(s.offer).toMatchObject({ rideId: ride.id, rider: { nickname: "Toria" } });
    expect(await call(R1, "siosia_decide_offer", [(s.offer as Json).id, "accept"])).toBe("won");
    expect((await call<Json>(T1, "siosia_get_ride", [ride.id])).driver).toMatchObject({ nickname: "Roman", icon: "taycan-ct-green", vehicle: { plate: "WX 5555" } });
    await call(T1, "siosia_cancel_ride", [ride.id, null]);
    // A complete preset car reaches every phone on the profile; turning it into a rider profile
    // takes its phones out of the driver seat.
    await admin("select public.siosia_set_master('romand', 'romand-link-token-0123456789', 'Roman', 'taycan-ct-green', null, 'driver', null, null, $1::jsonb)", [
      JSON.stringify({ ...CAR, plate: "wx 1234" })
    ]);
    expect(await call<Json>(R1, "siosia_get_vehicle")).toMatchObject({ plate: "WX 1234" });
    await admin("select public.siosia_set_master('romand', 'romand-link-token-0123456789', 'Roman', null, null, 'rider')");
    expect((await call<Json>(R1, "siosia_my_state")).driverOnline).toBe(false);
    expect(await errorOf(call(R1, "siosia_set_online", [true]))).toBe("rider_only");
  });

  it("books rides in advance: window, list, browse with distance, atomic take, overlap, give back, cancel", async () => {
    const B1 = "00000000-0000-4000-8000-000000000041";
    const B2 = "00000000-0000-4000-8000-000000000042";
    const BD = "00000000-0000-4000-8000-000000000043";
    for (const id of [B1, B2, BD]) await admin("insert into auth.users (id) values ($1)", [id]);
    await onboard(B1, "Bella");
    await onboard(B2, "Basia");
    await onboard(BD, "Bogdan", true);
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    const args = (min: number) => [PICKUP, DROPOFF, 2, 6, false, at(min)];
    expect(await errorOf(call(B1, "siosia_book_ride", args(10)))).toBe("bad_time");
    expect(await errorOf(call(B1, "siosia_book_ride", args(31 * 24 * 60)))).toBe("bad_time");
    const b = await call<Json>(B1, "siosia_book_ride", args(120));
    expect(b).toMatchObject({ status: "scheduled", driver: null });
    expect(Number(b.scheduledFor) - Date.now()).toBeGreaterThan(119 * 60_000);
    expect((await call<Json[]>(B1, "siosia_bookings")).map((r) => r.id)).toEqual([b.id]);
    expect(await call<Json>(B1, "siosia_my_state")).toMatchObject({ ride: null, bookings: 1 });
    expect((await call<Json[]>(B1, "siosia_history")).some((r) => r.id === b.id)).toBe(false);
    const open = await call<Json[]>(BD, "siosia_open_bookings", [NEAR(0.01).lat, NEAR(0.01).lng]);
    expect(open.find((x) => (x.ride as Json).id === b.id)).toMatchObject({ ride: { rider: { nickname: "Bella" } }, distanceKm: 1.1 });
    expect(await call(BD, "siosia_claim_booking", [b.id])).toBe("won");
    expect(await call<Json>(BD, "siosia_my_state")).toMatchObject({ bookings: 0, driverBookings: 1, hasProfile: true });
    expect(await call<Json>(B1, "siosia_my_state")).toMatchObject({ bookings: 1, driverBookings: 0 });
    expect(await errorOf(call(U.d3, "siosia_claim_booking", [b.id]))).toBe("taken");
    const b2 = await call<Json>(B2, "siosia_book_ride", args(140));
    expect(await errorOf(call(BD, "siosia_claim_booking", [b2.id]))).toBe("overlap");
    expect((await call<Json[]>(B1, "siosia_bookings"))[0].driver).toMatchObject({ nickname: "Bogdan", vehicle: { make: "Skoda" } });
    // Give back (more than an hour ahead: no mark), then the driver's cancel = give back too.
    await call(BD, "siosia_release_booking", [b.id]);
    expect((await call<Json>(BD, "siosia_get_profile")).driverCancels).toBe(0);
    await call(BD, "siosia_claim_booking", [b.id]);
    await admin("update public.rides set scheduled_for = now() + interval '50 minutes' where id = $1", [b.id]);
    await call(BD, "siosia_cancel_ride", [b.id, "other"]);
    expect((await call<Json>(BD, "siosia_get_profile")).driverCancels).toBe(1);
    expect((await call<Json>(B1, "siosia_get_ride", [b.id]))).toMatchObject({ status: "scheduled", driver: null });
    await call(B1, "siosia_cancel_ride", [b.id, null]);
    expect((await call<Json>(B1, "siosia_get_ride", [b.id])).status).toBe("cancelled");
    await call(B2, "siosia_cancel_ride", [b2.id, null]);
  });

  it("starts a taken booking with its driver 30 min before, opens an untaken one 20 min before", async () => {
    const B1 = "00000000-0000-4000-8000-000000000041";
    const B2 = "00000000-0000-4000-8000-000000000042";
    const BD = "00000000-0000-4000-8000-000000000043";
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    const taken = await call<Json>(B1, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(120)]);
    await call(BD, "siosia_claim_booking", [taken.id]);
    await admin("update public.rides set scheduled_for = now() + interval '31 minutes' where id = $1", [taken.id]);
    expect((await call<Json>(B1, "siosia_get_ride", [taken.id])).status).toBe("scheduled");
    await admin("update public.rides set scheduled_for = now() + interval '29 minutes' where id = $1", [taken.id]);
    expect((await call<Json>(B1, "siosia_my_state")).ride).toMatchObject({ id: taken.id, status: "accepted", driver: { nickname: "Bogdan" } });
    expect(await call<Json>(BD, "siosia_my_state")).toMatchObject({ driverOnline: true, ride: { id: taken.id, status: "accepted" } });
    // The driver's app may stay closed until 15 min after the booked time.
    await admin("update public.driver_status set last_seen = now() - interval '5 minutes' where user_id = $1", [BD]);
    expect((await call<Json>(B1, "siosia_get_ride", [taken.id])).status).toBe("accepted");
    // 16 min past the booked time, silent for 5 min: an iPhone in a pocket — still the driver's.
    await admin("update public.rides set scheduled_for = now() - interval '16 minutes' where id = $1", [taken.id]);
    expect((await call<Json>(B1, "siosia_get_ride", [taken.id])).status).toBe("accepted");
    // Silent for over 15 min as well: someone else takes it.
    await admin("update public.driver_status set last_seen = now() - interval '901 seconds' where user_id = $1", [BD]);
    expect(await call<Json>(B1, "siosia_get_ride", [taken.id])).toMatchObject({ status: "requested", driver: null });
    await call(B1, "siosia_cancel_ride", [taken.id, null]);
    // Untaken: normal dispatch from 20 min before, open until 15 min after the booked time.
    const free = await call<Json>(B2, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(120)]);
    await admin("update public.rides set scheduled_for = now() + interval '19 minutes' where id = $1", [free.id]);
    const r = await call<Json>(B2, "siosia_get_ride", [free.id]);
    expect(r.status).toBe("requested");
    expect(Number(r.expiresAt) - Date.now()).toBeGreaterThan(33 * 60_000);
    await admin("update public.rides set scheduled_for = now() - interval '16 minutes', dispatch_started_at = now() - interval '25 minutes' where id = $1", [free.id]);
    expect((await call<Json>(B2, "siosia_get_ride", [free.id])).status).toBe("expired");
  });

  it("queues notifications only for people who turned them on, in their language", async () => {
    const B1 = "00000000-0000-4000-8000-000000000041";
    const B2 = "00000000-0000-4000-8000-000000000042";
    const BD = "00000000-0000-4000-8000-000000000043";
    const sub = (n: string) => [`https://web.push.apple.com/${n}`, "p".repeat(40), "a".repeat(16)];
    expect(await errorOf(call(B1, "siosia_save_push", ["http://insecure/x", "p".repeat(40), "a".repeat(16)]))).toBe("bad_input");
    // Only real push services: the sender posts to this URL.
    expect(await errorOf(call(B1, "siosia_save_push", ["https://attacker.example/x", "p".repeat(40), "a".repeat(16)]))).toBe("bad_input");
    await call(B1, "siosia_save_push", sub("b1"));
    await call(BD, "siosia_save_push", sub("bd"));
    await call(B1, "siosia_save_profile", ["Bella", "pl"]);
    expect(await errorOf(as(B1, "select * from public.push_outbox"))).toMatch(/permission denied/);
    expect(await errorOf(as(B1, "select * from public.push_subscriptions"))).toMatch(/permission denied/);
    await admin("delete from public.push_outbox");
    const outbox = async () =>
      (await admin("select user_id, kind, lang, tz, params from public.push_outbox order by id")).rows.map((r) => ({
        user: r.user_id === B1 ? "B1" : r.user_id === BD ? "BD" : String(r.user_id),
        kind: r.kind,
        lang: r.lang,
        tz: r.tz,
        params: r.params
      }));
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    const b = await call<Json>(B1, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(120)]);
    expect(await outbox()).toEqual([{ user: "BD", kind: "booking_new", lang: "en", tz: "Europe/Warsaw", params: expect.objectContaining({ pickup: "Centrum" }) }]);
    await admin("delete from public.push_outbox");
    await call(BD, "siosia_claim_booking", [b.id]);
    expect(await outbox()).toEqual([{ user: "B1", kind: "booking_taken", lang: "pl", tz: "Europe/Warsaw", params: expect.objectContaining({ driver: "Bogdan" }) }]);
    await admin("delete from public.push_outbox");
    await admin("update public.rides set scheduled_for = now() + interval '29 minutes' where id = $1", [b.id]);
    await call(B1, "siosia_my_state");
    expect((await outbox()).map((r) => `${r.kind}>${r.user}`)).toEqual(["time_to_go>BD", "driver_coming>B1"]);
    await admin("delete from public.push_outbox");
    // Someone without a subscription gets nothing queued.
    const b2 = await call<Json>(B2, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(300)]);
    await admin("delete from public.push_outbox");
    await call(U.d3, "siosia_claim_booking", [b2.id]);
    expect(await outbox()).toEqual([]);
    // The sender claims rows atomically: a second run right after gets nothing.
    await call(B2, "siosia_cancel_ride", [b2.id, null]);
    await admin("delete from public.push_outbox");
    await admin("select public.siosia_push($1, 'driver_arrived', null, '{}'::jsonb)", [B1]);
    const first = (await admin("select id, attempts from public.siosia_claim_push(10)")).rows;
    expect(first).toEqual([{ id: expect.anything(), attempts: 1 }]);
    expect((await admin("select id from public.siosia_claim_push(10)")).rows).toEqual([]);
    // Turning them off removes this device.
    await call(BD, "siosia_delete_push", ["https://web.push.apple.com/bd"]);
    expect((await admin("select count(*)::int as n from public.push_subscriptions where user_id = $1", [BD])).rows[0]).toEqual({ n: 0 });
    await call(B1, "siosia_cancel_ride", [b.id, null]);
  });

  it("sets up notifications without hand-entered secrets; only the public key leaves the database", async () => {
    const sec = (await admin("select push_secret, vapid_public, vapid_private from public.app_secrets where id = 1")).rows[0];
    expect(String(sec.push_secret)).toMatch(/^[0-9a-f]{48}$/);
    expect(await errorOf(as(U.rider, "select push_secret from public.app_secrets"))).toMatch(/permission denied/);
    expect(await errorOf(as(U.rider, "select public.siosia_kick_push()"))).toMatch(/permission denied/);
    await admin("select public.siosia_kick_push()"); // not set up yet: a no-op
    await admin("update public.app_config set push_function_url = 'https://x.supabase.co/functions/v1/push-dispatch' where id = 1");
    await admin("select public.siosia_kick_push()"); // no pg_net here: still never fails
    await admin("update public.app_config set push_function_url = null where id = 1");
    expect(await as<Json>(U.rider, "select public.siosia_config()")).toMatchObject({ vapidPublicKey: null });
    await admin("update public.app_secrets set vapid_public = 'BPublicKeyExample', vapid_private = 'privateKeyExample' where id = 1");
    const cfg = await as<Json>(U.rider, "select public.siosia_config()");
    expect(cfg.vapidPublicKey).toBe("BPublicKeyExample");
    expect(JSON.stringify(cfg)).not.toContain("privateKeyExample");
    expect(JSON.stringify(cfg)).not.toContain(String(sec.push_secret));
    await admin("update public.app_secrets set vapid_public = null, vapid_private = null where id = 1");
  });

  it("keeps an online driver whose app went quiet on standby: new requests become notifications", async () => {
    const SD = "00000000-0000-4000-8000-000000000061";
    const SR = "00000000-0000-4000-8000-000000000062";
    for (const id of [SD, SR]) await admin("insert into auth.users (id) values ($1)", [id]);
    await onboard(SD, "Stefan", true);
    await onboard(SR, "Sara");
    await call(SD, "siosia_save_push", ["https://web.push.apple.com/sd", "p".repeat(40), "a".repeat(16)]);
    await call(SD, "siosia_set_online", [true]);
    await admin("update public.driver_status set last_seen = now() - interval '2 minutes' where user_id = $1", [SD]);
    expect(await call<Json>(SD, "siosia_my_state")).toMatchObject({ driverOnline: false, standby: true });
    await admin("delete from public.push_outbox");
    const ride = await call<Json>(SR, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    expect((await admin("select user_id, kind, params from public.push_outbox")).rows).toEqual([
      { user_id: SD, kind: "request_new", params: { pickup: "Centrum" } }
    ]);
    await call(SR, "siosia_cancel_ride", [ride.id, null]);
    // Going offline on purpose ends standby.
    await call(SD, "siosia_set_online", [true]);
    await call(SD, "siosia_set_online", [false]);
    expect((await call<Json>(SD, "siosia_my_state")).standby).toBe(false);
    await admin("delete from public.push_outbox");
    const r2 = await call<Json>(SR, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    expect((await admin("select count(*)::int as n from public.push_outbox")).rows[0]).toEqual({ n: 0 });
    await call(SR, "siosia_cancel_ride", [r2.id, null]);
    expect(await as<Json>(U.rider, "select public.siosia_config()")).toMatchObject({ standbyHours: 4 });
  });

  it("keeps the sweep alive when a user with a booking is removed, and checks busy in either role", async () => {
    const G1 = "00000000-0000-4000-8000-000000000051";
    const GD = "00000000-0000-4000-8000-000000000052";
    const G2 = "00000000-0000-4000-8000-000000000053";
    for (const id of [G1, GD, G2]) await admin("insert into auth.users (id) values ($1)", [id]);
    await onboard(G1, "Gosia");
    await onboard(GD, "Grzegorz", true);
    await onboard(G2, "Gabi");
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    const b = await call<Json>(G1, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(120)]);
    await call(GD, "siosia_claim_booking", [b.id]);
    // The operator removes the driver (Authentication → Users): the booking loses its driver,
    // and every other call keeps working.
    await admin("delete from auth.users where id = $1", [GD]);
    await admin("update public.rides set scheduled_for = now() + interval '29 minutes' where id = $1", [b.id]);
    expect((await call<Json>(U.rider2, "siosia_my_state")).ride).toBeNull();
    expect(await call<Json>(G1, "siosia_get_ride", [b.id])).toMatchObject({ status: "requested", driver: null });
    await call(G1, "siosia_cancel_ride", [b.id, null]);
    // The rider removed: their booking ends.
    const b2 = await call<Json>(G2, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(120)]);
    await admin("delete from auth.users where id = $1", [G2]);
    await admin("update public.rides set scheduled_for = now() + interval '19 minutes' where id = $1", [b2.id]);
    await call(U.rider2, "siosia_my_state");
    expect((await admin("select status, cancel_reason from public.rides where id = $1", [b2.id])).rows[0]).toEqual({ status: "cancelled", cancel_reason: "user_gone" });
    // A rider who is driving someone right now is busy: their booking waits.
    const b3 = await call<Json>(U.d3, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(120)]);
    const req = await call<Json>(G1, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    await call(U.d3, "siosia_set_online", [true]);
    const s = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    expect((s.offer as Json).rideId).toBe(req.id);
    await call(U.d3, "siosia_decide_offer", [(s.offer as Json).id, "accept"]);
    await admin("update public.rides set scheduled_for = now() + interval '19 minutes' where id = $1", [b3.id]);
    await call(U.d3, "siosia_my_state");
    expect((await admin("select status from public.rides where id = $1", [b3.id])).rows[0]).toEqual({ status: "scheduled" });
    await call(G1, "siosia_cancel_ride", [req.id, null]);
    await call(U.d3, "siosia_cancel_ride", [b3.id, null]);
    // Open bookings need a car; new bookings are capped at 10 a day.
    expect(await errorOf(call(G1, "siosia_open_bookings", [null, null]))).toBe("no_vehicle");
    expect((await call<Json>(G1, "siosia_my_state")).openBookings).toBe(0);
    for (let i = 0; i < 9; i++) { // G1 booked once today already: 10 in all
      const x = await call<Json>(G1, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(200 + i)]);
      await call(G1, "siosia_cancel_ride", [x.id, null]);
    }
    expect(await errorOf(call(G1, "siosia_book_ride", [PICKUP, DROPOFF, 2, 6, false, at(300)]))).toBe("too_many");
  });

  it("moves a profile into the app with a one-time code (iOS Home Screen apps have their own storage)", async () => {
    const APP = "00000000-0000-4000-8000-000000000031";
    const APP2 = "00000000-0000-4000-8000-000000000032";
    for (const id of [APP, APP2]) await admin("insert into auth.users (id) values ($1)", [id]);
    const before = await call<Json>(U.d2, "siosia_get_profile");
    const rides = ((await call<Json[]>(U.d2, "siosia_history")) ?? []).length;
    const { code, expiresAt } = await call<Json>(U.d2, "siosia_create_transfer");
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(Number(expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(JSON.stringify((await admin("select * from public.account_transfers")).rows)).not.toContain(String(code));
    expect(await errorOf(as(U.d2, "select * from public.account_transfers"))).toMatch(/permission denied/);
    expect(await errorOf(call(APP, "siosia_redeem_transfer", ["WRONG-CODE", "dev-app", false]))).toBe("bad_transfer");
    // The app account has never entered the invite code: the code is enough.
    const p = await call<Json>(APP, "siosia_redeem_transfer", [String(code).toLowerCase().replace("-", " "), "dev-app", false]);
    expect(p).toMatchObject({ userId: APP, nickname: before.nickname, rating: before.rating });
    expect(await as(APP, "select public.siosia_is_member('dev-app')")).toBe(true);
    expect(((await call<Json[]>(APP, "siosia_history")) ?? []).length).toBe(rides);
    expect((await call<Json>(APP, "siosia_get_vehicle"))).toMatchObject({ plate: "WX 0003" });
    expect(await errorOf(call(U.d2, "siosia_my_state"))).toBe("not_member"); // the browser starts fresh
    expect(await errorOf(call(APP2, "siosia_redeem_transfer", [code, "dev-app2", false]))).toBe("bad_transfer"); // once only
    // Into an app that already has a profile: only with a yes (then merged).
    await call(APP2, "siosia_join", ["pilot 2026", "dev-app2"]);
    await call(APP2, "siosia_save_profile", ["Tester", "en"]);
    const again = String((await call<Json>(APP, "siosia_create_transfer")).code);
    expect(await errorOf(call(APP2, "siosia_redeem_transfer", [again, "dev-app2", false]))).toBe("has_profile");
    expect(await call<Json>(APP2, "siosia_redeem_transfer", [again, "dev-app2", true])).toMatchObject({ userId: APP2, nickname: before.nickname });
    expect(((await call<Json[]>(APP2, "siosia_history")) ?? []).length).toBe(rides);
    // A phone on a master link that was since replaced cannot move into a full membership.
    const LINK = "00000000-0000-4000-8000-000000000033";
    const APP3 = "00000000-0000-4000-8000-000000000034";
    for (const id of [LINK, APP3]) await admin("insert into auth.users (id) values ($1)", [id]);
    await admin("select public.siosia_set_master('mvx', 'mvx-link-token-0123456789', 'Mover', null, null, 'rider')");
    await call(LINK, "siosia_join_master", ["mvx-link-token-0123456789", "dev-link", "en", false]);
    const code3 = String((await call<Json>(LINK, "siosia_create_transfer")).code);
    await admin("select public.siosia_set_master('mvx', 'mvx-link-token-NEW-01234567', 'Mover', null, null, 'rider')");
    expect(await errorOf(call(APP3, "siosia_redeem_transfer", [code3, "dev-app3", false]))).toBe("bad_transfer");
  });

  it("upgrades a database from the 3-minute version to 20 minutes once, never overriding a later choice", async () => {
    // Simulate the previous schema: no offer_retry_s column, the old default 180 in the row.
    await admin("alter table public.app_config drop column offer_retry_s");
    await admin("update public.app_config set request_expiry_s = 180 where id = 1");
    await db.exec(MIGRATION);
    expect(await as<Json>(U.rider, "select public.siosia_config()")).toMatchObject({ timers: { expiryS: 1200, retryS: 120 } });
    // An operator's later choice survives another re-run of the file.
    await admin("update public.app_config set request_expiry_s = 180 where id = 1");
    await db.exec(MIGRATION);
    expect(await as<Json>(U.rider, "select public.siosia_config()")).toMatchObject({ timers: { expiryS: 180 } });
    await admin("update public.app_config set request_expiry_s = 1200 where id = 1");
  });

  it("anonymises a deleted profile", async () => {
    await call(U.far, "siosia_set_online", [false]);
    await call(U.far, "siosia_delete_profile");
    expect(await errorOf(call(U.far, "siosia_my_state"))).toBe("not_member");
    const nick = (await admin("select nickname, deleted from public.profiles where user_id = $1", [U.far])).rows[0];
    expect(nick).toEqual({ nickname: "Deleted user", deleted: true });
  });
});
