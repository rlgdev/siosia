// @vitest-environment node
// Siosia 2.9 backend rules against the REAL SQL migration in PGlite: the notifications bell (V73) and
// tips after an appointment or a ride (V74). Same cases as the engine tests
// (tests/unit/notify-tips.test.ts) — the twin rule (V19).

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, errorOf, type Json, type SqlHarness } from "./sql-harness";

const U = {
  dad: "00000000-0000-4000-8000-000000000301",
  mum: "00000000-0000-4000-8000-000000000302",
  nanny: "00000000-0000-4000-8000-000000000303",
  other: "00000000-0000-4000-8000-000000000304",
  d1: "00000000-0000-4000-8000-000000000305"
};
type Who = keyof typeof U;
const NAMES: Record<Who, string> = { dad: "Roman", mum: "Anna", nanny: "Toria", other: "Ewa", d1: "Adam" };
const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const PICKUP = { lat: 52.2297, lng: 21.0122, label: "Centrum" };
const DROPOFF = { lat: 52.2432, lng: 21.0441, label: "Praga" };
const MIN = 60_000;
const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args);
const code = (p: Promise<unknown>) => errorOf(p);
const name = (uid: unknown) => (Object.keys(U) as Who[]).find((k) => U[k] === uid) ?? String(uid);
const outbox = async () =>
  ((await h.admin("select kind, user_id, params, ride_id, appointment_id from public.push_outbox order by id")).rows as Json[]).map((r) => ({ ...r, kind: String(r.kind), who: name(r.user_id) }));
const sent = async () => (await outbox()).map((r) => `${r.kind}>${r.who}`).sort();
const clearOutbox = () => h.admin("delete from public.push_outbox");
const bell = (who: Who) => call<{ items: Json[]; unread: number }>(who, "siosia_notifications");
const request = (who: Who, provider: Who) =>
  call<Json>(who, "siosia_request_service", ["childcare", pub[provider], at(26 * 60), 180, HOME, "", null]);
/** An accepted appointment that ended `agoMin` minutes ago, marked done by the sweep. */
async function done(who: Who, provider: Who, agoMin = 1): Promise<Json> {
  const a = await request(who, provider);
  await call(provider, "siosia_answer_appointment", [a.id, "accept"]);
  await h.admin(
    "update public.appointments set starts_at = now() - make_interval(mins => duration_min + $2), requested_at = now() - interval '30 days' where id = $1",
    [a.id, agoMin]
  );
  await h.admin("select public.siosia_sweep()");
  return a;
}
/** A ride of dad's with d1 that completed `agoMin` minutes ago. */
async function ride(agoMin = 1): Promise<string> {
  const r = await h.admin(
    `insert into public.rides (rider_id, driver_id, status, pickup_lat, pickup_lng, pickup_label, dropoff_lat, dropoff_lng, dropoff_label,
                               est_km, est_min, fare, currency, accepted_at, started_at, ended_at, requested_at)
     values ($1, $2, 'completed', 52.2297, 21.0122, 'Centrum', 52.2432, 21.0441, 'Praga', 3.4, 9, 18, 'PLN',
             now() - make_interval(mins => $3 + 20), now() - make_interval(mins => $3 + 10), now() - make_interval(mins => $3),
             now() - make_interval(mins => $3 + 30))
     returning id`,
    [U.dad, U.d1, agoMin]
  );
  return String((r.rows[0] as Json).id);
}

/** The local day ("YYYY-MM-DD", Warsaw) of a row's moment — the week the report counts it in. */
const localDay = async (table: string, col: string, id: unknown) =>
  String(((await h.admin(`select to_char((${col} at time zone 'Europe/Warsaw')::date, 'YYYY-MM-DD') as d from public.${table} where id = $1`, [id])).rows[0] as Json).d);

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  for (const k of Object.keys(U) as Who[]) {
    await h.onboard(U[k], NAMES[k], k === "d1");
    pub[k] = String((await call<Json>(k, "siosia_get_profile")).publicId);
    await call(k, "siosia_save_push", [`https://web.push.apple.com/${k}`, "p".repeat(40), "a".repeat(16)]);
  }
  await call("nanny", "siosia_set_offers", [["childcare"]]);
  await call("dad", "siosia_family_invite", [pub.mum]);
  await call("mum", "siosia_family_answer", [((await call<Json>("mum", "siosia_family")).incoming as Json[])[0].id, "join"]);
}, 60_000);

beforeEach(async () => {
  await h.db.exec("delete from public.ratings; delete from public.rides; delete from public.appointments; delete from public.push_outbox; delete from public.notifications;");
});

describe("the notifications bell (FR-311–313, V73)", () => {
  it("keeps what was notified (but chat), newest first, with an unread count that opening clears", async () => {
    const a = await request("dad", "nanny");
    let b = await bell("nanny");
    expect(b.unread).toBe(1);
    expect(b.items).toEqual([expect.objectContaining({ kind: "appt_new", appointmentId: a.id, rideId: null, read: false })]);
    expect(b.items[0].params).toMatchObject({ service: "Childcare", client: "Roman" });
    expect((await call<Json>("nanny", "siosia_my_state")).unreadNotifications).toBe(1);
    expect(await bell("other")).toEqual({ items: [], unread: 0 });
    await call("nanny", "siosia_answer_appointment", [a.id, "accept"]);
    expect((await bell("dad")).items.map((n) => n.kind)).toEqual(["appt_accepted"]);
    // A chat message is a push, never a bell entry.
    await clearOutbox();
    await call("nanny", "siosia_send_message", [`appt:${a.id}`, "Hi!"]);
    expect(await sent()).toEqual(["chat_message>dad"]);
    expect((await bell("dad")).items).toHaveLength(1);
    await call("nanny", "siosia_read_notifications");
    b = await bell("nanny");
    expect(b.unread).toBe(0);
    expect(b.items.every((n) => n.read)).toBe(true);
    expect((await call<Json>("nanny", "siosia_my_state")).unreadNotifications).toBe(0);
  });

  it("lists the newest 50 of the last 60 days, keeps 200 per member; a booking reaches every driver's bell", async () => {
    await h.admin("select public.siosia_keep_notification($1, 'family_invite', null, null, '{}') from generate_series(1, 205)", [U.nanny]);
    expect((await h.admin("select count(*)::int as n from public.notifications where user_id = $1", [U.nanny])).rows[0]).toEqual({ n: 200 });
    const b = await bell("nanny");
    expect(b.items).toHaveLength(50);
    expect(b.unread).toBe(200);
    expect(Number(b.items[0].id)).toBeGreaterThan(Number(b.items[49].id));
    await h.admin("update public.notifications set created_at = now() - interval '61 days'");
    expect(await bell("nanny")).toEqual({ items: [], unread: 0 });
    // A booking: every driver who could take it finds it in the bell (with notifications on or not).
    await h.admin("delete from public.push_subscriptions where user_id = $1", [U.d1]);
    const r = await call<Json>("dad", "siosia_book_ride", [PICKUP, DROPOFF, 3.4, 9, false, at(120), null, null]);
    expect((await bell("d1")).items[0]).toMatchObject({ kind: "booking_new", rideId: r.id, params: { pickup: "Centrum", dropoff: "Praga" } });
    expect((await bell("mum")).items).toEqual([]);
    expect(await sent()).toEqual([]);
    await call("d1", "siosia_save_push", [`https://web.push.apple.com/d1`, "p".repeat(40), "a".repeat(16)]);
  });
});

describe("tips (FR-314–316, V74)", () => {
  it("the client side tips the provider once after a done appointment, within 7 days", async () => {
    const a = await request("dad", "nanny");
    expect(await code(call("dad", "siosia_tip_appointment", [a.id, 10]))).toBe("illegal_transition");
    await call("nanny", "siosia_answer_appointment", [a.id, "accept"]);
    await h.admin(
      "update public.appointments set starts_at = now() - make_interval(mins => duration_min + 1), requested_at = now() - interval '30 days' where id = $1",
      [a.id]
    );
    await h.admin("select public.siosia_sweep()");
    await clearOutbox();
    for (const bad of [0, 0.99, 1000.01, null]) expect(await code(call("mum", "siosia_tip_appointment", [a.id, bad])), String(bad)).toBe("bad_input");
    expect(await code(call("nanny", "siosia_tip_appointment", [a.id, 10]))).toBe("not_found");
    expect(await code(call("other", "siosia_tip_appointment", [a.id, 10]))).toBe("not_found");
    const v = await call<Json>("mum", "siosia_tip_appointment", [a.id, 20.004]);
    expect(v.tip).toMatchObject({ amount: 20, by: "Anna" });
    expect(await sent()).toEqual(["appt_tip>nanny"]);
    expect((await outbox())[0]).toMatchObject({ appointment_id: a.id, params: { sender: "Anna", total: 20, currency: "PLN", service: "Childcare" } });
    expect((await call<Json>("nanny", "siosia_get_appointment", [a.id])).tip).toMatchObject({ amount: 20, by: "Anna" });
    expect((await call<Json>("dad", "siosia_get_appointment", [a.id])).tip).toMatchObject({ amount: 20 });
    expect(await code(call("dad", "siosia_tip_appointment", [a.id, 5]))).toBe("already_tipped");
    // The week's report counts it: spent by the client, earned by the provider.
    const w = await localDay("appointments", "starts_at", a.id);
    expect(((await call<Json>("dad", "siosia_report", [w, "me"])).spent as Json).tips).toBe(20);
    expect(((await call<Json>("nanny", "siosia_report", [w, "me"])).earned as Json).tips).toBe(20);
    // 7 days after the end it is too late.
    const b = await done("dad", "nanny", 7 * 24 * 60 + 1);
    expect(await code(call("dad", "siosia_tip_appointment", [b.id, 10]))).toBe("window_closed");
  });

  it("the rider tips the driver once after a completed ride, within 24 h", async () => {
    const r = await ride();
    expect(await code(call("d1", "siosia_tip_ride", [r, 5]))).toBe("forbidden");
    expect(await code(call("mum", "siosia_tip_ride", [r, 5]))).toBe("not_found");
    for (const bad of [0, 500.01]) expect(await code(call("dad", "siosia_tip_ride", [r, bad]))).toBe("bad_input");
    expect((await call<Json>("dad", "siosia_tip_ride", [r, 5])).tip).toBe(5);
    expect(await sent()).toEqual(["ride_tip>d1"]);
    expect((await outbox())[0]).toMatchObject({ ride_id: r, params: { sender: "Roman", total: 5, currency: "PLN", pickup: "Centrum" } });
    expect((await call<Json>("d1", "siosia_get_ride", [r])).tip).toBe(5);
    expect(await code(call("dad", "siosia_tip_ride", [r, 5]))).toBe("already_tipped");
    const w = await localDay("rides", "ended_at", r);
    expect(((await call<Json>("dad", "siosia_report", [w, "me"])).spent as Json).tips).toBe(5);
    expect((await call<Json>("d1", "siosia_report", [w, "me"])).earned).toMatchObject({ tips: 5, total: 23 });
    const late = await ride(24 * 60 + 1);
    expect(await code(call("dad", "siosia_tip_ride", [late, 5]))).toBe("window_closed");
  });
});
