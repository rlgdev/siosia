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
    expect(cfg).toMatchObject({ tariff: { currency: "PLN" }, timers: { offerS: 20, expiryS: 180, noShowS: 300 }, dispatchRadiusKm: 8 });
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
    expect(await as<number>(U.d1, "select count(*)::int from public.vehicles")).toBe(1); // only own row
    expect(await as<number>(U.d1, "select count(*)::int from public.profiles")).toBe(1);
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
    expect(await errorOf(call(U.rider, "siosia_set_online", [true]))).toBe("no_vehicle");
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
    expect(await as<number>(U.d3, "select count(*)::int from public.rides")).toBe(0);
    expect(await as(U.d3, "select public.siosia_rt_can_read($1)", [`ride:${rideId}`])).toBe(false);
    expect(await as(U.d1, "select public.siosia_rt_can_read($1)", [`ride:${rideId}`])).toBe(true);
    expect(await as(U.rider, "select public.siosia_rt_can_write($1, 'broadcast')", [`ride:${rideId}`])).toBe(true);
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

  it("expires an unaccepted request after 3 minutes on read (§6 rule 7)", async () => {
    const ride = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, true]);
    await admin("update public.rides set dispatch_started_at = now() - interval '181 seconds' where id = $1", [ride.id]);
    const st = await call<Json>(U.rider2, "siosia_my_state");
    expect(st.ride).toBeNull();
    const after = await call<Json>(U.rider2, "siosia_get_ride", [ride.id]);
    expect(after).toMatchObject({ status: "expired", cancelledBy: "system", fareIsEstimate: true });
  });

  it("re-dispatches when the assigned driver goes silent for 60 s (§12)", async () => {
    const ride = await call<Json>(U.rider2, "siosia_request_ride", [PICKUP, DROPOFF, 2, 6, false]);
    const s3 = await call<Json>(U.d3, "siosia_heartbeat", [NEAR(0.03).lat, NEAR(0.03).lng]);
    await call(U.d3, "siosia_decide_offer", [(s3.offer as Json).id, "accept"]);
    await admin("update public.driver_status set last_seen = now() - interval '61 seconds' where user_id = $1", [U.d3]);
    const r = await call<Json>(U.rider2, "siosia_get_ride", [ride.id]);
    expect(r).toMatchObject({ status: "requested", cancelReason: "driver_lost", redispatchCount: 1 });
    const d3 = await call<Json>(U.d3, "siosia_my_state");
    expect(d3.driverOnline).toBe(false);
    await call(U.rider2, "siosia_cancel_ride", [ride.id, null]);
    const p = await call<Json>(U.rider2, "siosia_get_profile");
    expect(p.riderCancels).toBe(1);
  });

  it("anonymises a deleted profile", async () => {
    await call(U.far, "siosia_set_online", [false]);
    await call(U.far, "siosia_delete_profile");
    expect(await errorOf(call(U.far, "siosia_my_state"))).toBe("not_member");
    const nick = (await admin("select nickname, deleted from public.profiles where user_id = $1", [U.far])).rows[0];
    expect(nick).toEqual({ nickname: "Deleted user", deleted: true });
  });
});
