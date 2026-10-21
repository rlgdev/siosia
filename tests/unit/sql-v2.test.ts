// @vitest-environment node
// Siosia 2.0 backend rules against the REAL SQL migration in PGlite: the service catalog,
// appointments (single and series), rides as part of a service, reminders, the calendar token.
// Same cases as the engine tests (tests/unit/appointments.test.ts) — the twin rule (V19).

import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, errorOf, type Json, type SqlHarness } from "./sql-harness";

const U = {
  client: "00000000-0000-4000-8000-000000000101",
  siosia: "00000000-0000-4000-8000-000000000102",
  driver: "00000000-0000-4000-8000-000000000103",
  other: "00000000-0000-4000-8000-000000000104",
  stranger: "00000000-0000-4000-8000-000000000105",
  master: "00000000-0000-4000-8000-000000000106",
  gone: "00000000-0000-4000-8000-000000000107"
};

const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const SCHOOL = { lat: 52.2663135, lng: 20.814317, label: "Husarska 16" };
const MIN = 60_000;
const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();

let h: SqlHarness;
const pub: Record<string, string> = {};

/**
 * Sends a request from `uid` to `provider` (a key of U; null = an open request to anyone, 2.1)
 * starting `startMin` minutes from now.
 */
function request(uid: string, provider: string | null, startMin: number, o: { service?: string; duration?: number; place?: unknown; note?: string; repeat?: unknown; startsAt?: number } = {}) {
  return h.call<Json>(uid, "siosia_request_service", [
    o.service ?? "childcare",
    provider === null ? null : pub[provider],
    o.startsAt !== undefined ? new Date(o.startsAt).toISOString() : at(startMin),
    o.duration ?? 180,
    o.place === undefined ? HOME : o.place,
    o.note ?? "",
    o.repeat ?? null
  ]);
}
const answer = (uid: string, id: unknown, d: "accept" | "decline") => h.call<Json>(uid, "siosia_answer_appointment", [id, d]);
const take = (uid: string, id: unknown) => h.call<Json>(uid, "siosia_take_request", [id]);
const cancel = (uid: string, id: unknown, scope: "one" | "series" = "one") => h.call(uid, "siosia_cancel_appointment", [id, null, scope]);
const book = (uid: string, pickupMin: number, appt: unknown = null, leg: string | null = null) =>
  h.call<Json>(uid, "siosia_book_ride", [HOME, SCHOOL, 3, 8, false, at(pickupMin), appt, leg]);
const getAppt = (uid: string, id: unknown) => h.call<Json>(uid, "siosia_get_appointment", [id]);
const outbox = async () =>
  (await h.admin("select kind, user_id, params, appointment_id from public.push_outbox order by id")).rows as { kind: string; user_id: string; params: Json; appointment_id: string }[];
const sweep = () => h.admin("select public.siosia_sweep()");
const shift = (id: unknown, startMin: number, requestedMin?: number) =>
  h.admin(
    `update public.appointments set starts_at = now() + make_interval(mins => $2)${requestedMin === undefined ? "" : ", requested_at = now() + make_interval(mins => $3)"} where id = $1`,
    requestedMin === undefined ? [id, startMin] : [id, startMin, requestedMin]
  );

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  await h.onboard(U.client, "Toria");
  await h.onboard(U.siosia, "Siosia");
  await h.onboard(U.driver, "Roman", true);
  await h.onboard(U.other, "Ewa");
  await h.onboard(U.gone, "Gosia");
  for (const k of ["client", "siosia", "driver", "other", "gone"] as const) {
    pub[k] = String((await h.call<Json>(U[k], "siosia_get_profile")).publicId);
    // Notifications on (only subscribers get them, v1 rule).
    await h.call(U[k], "siosia_save_push", [`https://web.push.apple.com/${k}`, "p".repeat(40), "a".repeat(16)]);
  }
  await h.call(U.siosia, "siosia_set_offers", [["learning", "childcare"]]);
  await h.call(U.gone, "siosia_set_offers", [["learning"]]);
}, 60_000);

beforeEach(async () => {
  await h.db.exec("delete from public.ratings; delete from public.rides; delete from public.appointments; delete from public.appointment_series; delete from public.push_outbox;");
});

describe("catalog and schema (T1)", () => {
  it("seeds ride, learning and childcare once, and gives every profile a public id", async () => {
    const { rows } = await h.admin("select services from public.app_config where id = 1");
    const services = rows[0].services as Json[];
    expect(services.slice(0, 3).map((s) => s.id)).toEqual(["ride", "learning", "childcare"]);
    expect(services[2]).toMatchObject({ kind: "time", duration: { default: 180, min: 60, max: 720, step: 30 }, price: null });
    const ids = await h.admin("select public_id from public.profiles");
    expect(ids.rows.every((r) => /^[A-Za-z0-9_-]{12}$/.test(String(r.public_id)))).toBe(true);
    expect(new Set(ids.rows.map((r) => r.public_id)).size).toBe(ids.rows.length);
  });

  it("keeps appointments out of clients' direct reach", async () => {
    expect(await errorOf(h.as(U.client, "select count(*) from public.appointments"))).toMatch(/permission denied/);
    expect(await errorOf(h.as(U.client, "select count(*) from public.appointment_series"))).toMatch(/permission denied/);
  });

  it("validates the catalog: one ride entry, well-formed ids and durations, nothing deleted", async () => {
    const base = ((await h.admin("select services from public.app_config where id = 1")).rows[0].services as Json[]).slice(0, 3);
    const set = (v: unknown) => h.admin("select public.siosia_set_services($1::jsonb)", [JSON.stringify(v)]);
    expect(await errorOf(set([...base, { ...base[1], id: "Bad-Id" }]))).toMatch(/bad id/);
    expect(await errorOf(set([...base, { ...base[0], id: "ride2" }]))).toMatch(/ride entry has the id "ride"|exactly one/);
    expect(await errorOf(set([base[0], base[1]]))).toMatch(/keep every entry.*childcare/);
    expect(await errorOf(set([base[0], base[1], { ...base[2], duration: { default: 30, min: 60, max: 720, step: 30 } }]))).toMatch(/duration/);
    expect(await errorOf(set([base[0], base[1], { ...base[2], duration: { default: 180, min: 60, max: 720, step: 20 } }]))).toMatch(/duration/);
    const music = { id: "music", kind: "time", name: { en: "Music", pl: "Muzyka" }, description: { en: "", pl: "" }, icon: "🎹", duration: { default: 45, min: 30, max: 90, step: 15 }, price: { perHour: 80 }, needsPlace: false, enabled: false };
    await set([...base, music]);
    const saved = (await h.admin("select services from public.app_config where id = 1")).rows[0].services as Json[];
    expect(saved.map((s) => s.id)).toEqual(["ride", "learning", "childcare", "music"]);
  });

  it("allows a rating of a ride or of an appointment, never both", async () => {
    expect(await errorOf(h.admin("insert into public.ratings (from_user, to_user, stars) values ($1, $2, 5)", [U.client, U.siosia]))).toMatch(
      /ratings_one_target/
    );
  });
});

describe("catalog, offers, My place (FR-090–094, FR-140, FR-143)", () => {
  it("lists who offers each enabled entry by public id, never a user id, without the viewer", async () => {
    const cat = await h.call<Json[]>(U.client, "siosia_catalog");
    expect(cat.map((e) => e.id)).toEqual(["ride", "learning", "childcare"]); // music is disabled
    const childcare = cat.find((e) => e.id === "childcare")!;
    expect(childcare.providers).toEqual([expect.objectContaining({ nickname: "Siosia", publicId: pub.siosia })]);
    expect(cat.find((e) => e.id === "ride")!.providers).toEqual([]);
    const text = JSON.stringify(cat);
    for (const id of Object.values(U)) expect(text).not.toContain(id);
    const own = await h.call<Json[]>(U.siosia, "siosia_catalog");
    expect(own.find((e) => e.id === "childcare")!.providers).toEqual([]);
  });

  it("offers only enabled time entries; saves My place", async () => {
    expect(await errorOf(h.call(U.other, "siosia_set_offers", [["ride"]]))).toBe("bad_service");
    expect(await errorOf(h.call(U.other, "siosia_set_offers", [["music"]]))).toBe("bad_service");
    const p = await h.call<Json>(U.client, "siosia_save_home", [HOME]);
    expect(p).toMatchObject({ home: HOME, offers: [], offersPreset: false });
    expect(await errorOf(h.call(U.client, "siosia_save_home", [{ lat: 99, lng: 0, label: "x" }]))).toBe("bad_input");
  });
});

describe("request, answer, cancel (FR-100–103, V2–V5)", () => {
  it("validates a request and puts it in both schedules", async () => {
    expect(await errorOf(request(U.client, "siosia", 24 * 60, { service: "ride" }))).toBe("bad_service");
    expect(await errorOf(request(U.client, "siosia", 24 * 60, { service: "music" }))).toBe("bad_service");
    expect(await errorOf(request(U.client, "client", 24 * 60))).toBe("no_provider");
    expect(await errorOf(request(U.client, "other", 24 * 60))).toBe("not_offered");
    expect(await errorOf(request(U.client, "siosia", 10))).toBe("bad_time");
    expect(await errorOf(request(U.client, "siosia", 31 * 24 * 60))).toBe("bad_time");
    expect(await errorOf(request(U.client, "siosia", 24 * 60, { duration: 45 }))).toBe("bad_duration");
    expect(await errorOf(request(U.client, "siosia", 24 * 60, { duration: 750 }))).toBe("bad_duration");
    expect(await errorOf(request(U.client, "siosia", 24 * 60, { place: null }))).toBe("bad_input");
    expect(await errorOf(request(U.client, "siosia", 24 * 60, { note: "x".repeat(201) }))).toBe("bad_input");
    const a = await request(U.client, "siosia", 30 * 60, { note: "Kids back from school at 14:30" });
    expect(a).toMatchObject({ status: "requested", role: "client", serviceId: "childcare", durationMin: 180, price: null, series: null, rides: [] });
    expect(a.provider).toMatchObject({ nickname: "Siosia", publicId: pub.siosia });
    expect(a.service).toMatchObject({ name: { en: "Childcare", pl: "Opieka nad dziećmi" } });
    const theirs = await h.call<Json>(U.siosia, "siosia_planned");
    expect(theirs.appointments).toEqual([expect.objectContaining({ id: a.id, role: "provider", note: "Kids back from school at 14:30" })]);
    expect(await h.call<Json>(U.siosia, "siosia_my_state")).toMatchObject({ toAnswer: 1, planned: 1, nextPlanned: { kind: "appointment", title: "Childcare" } });
    expect(await outbox()).toEqual([expect.objectContaining({ kind: "appt_new", user_id: U.siosia, appointment_id: a.id, params: expect.objectContaining({ service: "Childcare", client: "Toria" }) })]);
    // Both parties were told to refetch (realtime, no new channels).
    const topics = (await h.admin("select topic from realtime.messages where event = 'changed'")).rows.map((r) => r.topic);
    expect(topics).toEqual(expect.arrayContaining([`user:${U.client}`, `user:${U.siosia}`]));
    expect(await errorOf(getAppt(U.other, a.id))).toBe("not_found");
  });

  it("refuses an 11th open request", async () => {
    for (let i = 0; i < 10; i++) await request(U.client, "siosia", 24 * 60 + i * 300, { duration: 60 });
    expect(await errorOf(request(U.client, "siosia", 24 * 60 + 3000, { duration: 60 }))).toBe("too_many");
  });

  it("accepts atomically, refuses overlaps, declines into history", async () => {
    const a = await request(U.client, "siosia", 30 * 60);
    expect(await errorOf(answer(U.client, a.id, "accept"))).toBe("not_found");
    expect(await answer(U.siosia, a.id, "accept")).toMatchObject({ status: "accepted", role: "provider" });
    expect(await errorOf(answer(U.siosia, a.id, "accept"))).toBe("illegal_transition");
    expect((await outbox()).map((o) => `${o.kind}>${o.user_id === U.client ? "client" : "siosia"}`)).toEqual(["appt_new>siosia", "appt_accepted>client"]);
    const clash = await request(U.other, "siosia", 30 * 60 + 60);
    expect(await errorOf(answer(U.siosia, clash.id, "accept"))).toBe("overlap");
    expect(await answer(U.siosia, clash.id, "decline")).toMatchObject({ status: "declined" });
    expect((await h.call<Json>(U.other, "siosia_planned")).appointments).toEqual([]);
    const hist = await h.call<Json[]>(U.other, "siosia_timeline");
    expect(hist).toEqual([expect.objectContaining({ kind: "appointment", appointment: expect.objectContaining({ id: clash.id, status: "declined" }) })]);
  });

  it("counts a booking taken as a driver as busy", async () => {
    await h.call(U.driver, "siosia_set_offers", [["learning"]]);
    const ride = await book(U.client, 26 * 60);
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    const lesson = await request(U.client, "driver", 26 * 60 - 30, { service: "learning", duration: 60 });
    expect(await errorOf(answer(U.driver, lesson.id, "accept"))).toBe("overlap");
    await h.call(U.driver, "siosia_set_offers", [[]]);
  });

  it("lets the client withdraw a request and either party cancel before the start; nothing is counted", async () => {
    const before = await h.call<Json>(U.client, "siosia_get_profile");
    const a = await request(U.client, "siosia", 24 * 60);
    expect(await errorOf(cancel(U.siosia, a.id))).toBe("illegal_transition"); // she declines instead
    await cancel(U.client, a.id);
    expect(await getAppt(U.client, a.id)).toMatchObject({ status: "cancelled", cancelledBy: "client" });
    const b = await request(U.client, "siosia", 48 * 60);
    await answer(U.siosia, b.id, "accept");
    await cancel(U.siosia, b.id);
    expect(await getAppt(U.client, b.id)).toMatchObject({ status: "cancelled", cancelledBy: "provider" });
    expect((await outbox()).filter((o) => o.kind === "appt_cancelled").map((o) => o.user_id)).toEqual([U.siosia, U.client]);
    const after = await h.call<Json>(U.client, "siosia_get_profile");
    expect(after.riderCancels).toBe(before.riderCancels);
    // Once it has started it can no longer be cancelled; at its end it is done.
    const c = await request(U.client, "siosia", 72 * 60);
    await answer(U.siosia, c.id, "accept");
    await shift(c.id, -10);
    expect(await errorOf(cancel(U.client, c.id))).toBe("illegal_transition");
    await shift(c.id, -181);
    expect(await getAppt(U.client, c.id)).toMatchObject({ status: "done" });
  });

  it("expires an unanswered request at its start and lets both rate a done appointment once", async () => {
    const a = await request(U.client, "siosia", 24 * 60);
    await shift(a.id, -1);
    await sweep();
    expect(await getAppt(U.client, a.id)).toMatchObject({ status: "expired" });
    expect((await outbox()).map((o) => o.kind)).toEqual(["appt_new", "appt_expired"]);
    const b = await request(U.client, "siosia", 24 * 60);
    expect(await errorOf(h.call(U.client, "siosia_rate_appointment", [b.id, 5, ""]))).toBe("illegal_transition");
    await answer(U.siosia, b.id, "accept");
    await shift(b.id, -200);
    await h.call(U.client, "siosia_rate_appointment", [b.id, 5, "Great"]);
    await h.call(U.siosia, "siosia_rate_appointment", [b.id, 4, ""]);
    expect(await errorOf(h.call(U.client, "siosia_rate_appointment", [b.id, 5, ""]))).toBe("already_rated");
    expect(await getAppt(U.client, b.id)).toMatchObject({ myRating: 5 });
    await h.admin("update public.appointments set ended_at = now() - interval '25 hours' where id = $1", [b.id]);
    expect(await errorOf(h.call(U.other, "siosia_rate_appointment", [b.id, 5, ""]))).toBe("not_found");
  });
});

describe("rides as part of a service (FR-110–116, V9–V12)", () => {
  it("adds a ride to an accepted appointment with every guard, shows it to each party as allowed", async () => {
    const a = await request(U.client, "siosia", 4 * 60);
    expect(await errorOf(book(U.siosia, 3 * 60, a.id, "there"))).toBe("not_accepted");
    await answer(U.siosia, a.id, "accept");
    expect(await errorOf(book(U.siosia, 3 * 60, a.id, "sideways"))).toBe("bad_leg");
    expect(await errorOf(book(U.siosia, 4 * 60 + 5, a.id, "there"))).toBe("bad_time");
    expect(await errorOf(book(U.siosia, 3 * 60, a.id, "back"))).toBe("bad_time");
    expect(await errorOf(book(U.other, 3 * 60, a.id, "there"))).toBe("not_found");
    const ride = await book(U.siosia, 3 * 60, a.id, "there");
    expect(ride).toMatchObject({ status: "scheduled", appointmentId: a.id, leg: "there", role: "rider" });
    expect(await errorOf(book(U.siosia, 3 * 60 + 10, a.id, "there"))).toBe("ride_exists");
    const mine = await getAppt(U.siosia, a.id);
    expect(mine.rides).toEqual([expect.objectContaining({ rideId: ride.id, leg: "there", passenger: "provider", status: "pending", driver: null, mine: true, pickup: HOME })]);
    const theirs = await getAppt(U.client, a.id);
    expect(theirs.rides).toEqual([expect.objectContaining({ leg: "there", status: "pending", mine: false })]);
    expect((theirs.rides as Json[])[0]).not.toHaveProperty("pickup");
    expect((theirs.rides as Json[])[0]).not.toHaveProperty("dropoff");
    expect((await outbox()).filter((o) => o.kind === "appt_ride_added").map((o) => o.user_id)).toEqual([U.client]);
    // The driver sees a plain booking; both parties hear when it gets / loses a driver.
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    const open = await h.call<Json[]>(U.driver, "siosia_bookings");
    expect(open[0]).toMatchObject({ id: ride.id, appointmentId: null, leg: null });
    expect((await getAppt(U.client, a.id)).rides).toEqual([expect.objectContaining({ status: "confirmed", driver: expect.objectContaining({ nickname: "Roman" }) })]);
    await h.call(U.driver, "siosia_release_booking", [ride.id]);
    const kinds = (await outbox()).filter((o) => o.kind.startsWith("appt_ride_") && o.kind !== "appt_ride_added");
    expect(kinds.map((o) => `${o.kind}>${o.user_id === U.client ? "client" : "other"}`)).toEqual(["appt_ride_taken>client", "appt_ride_lost>client"]);
    // Cancelling the appointment cancels its rides and tells their drivers.
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    await cancel(U.client, a.id);
    const r = (await h.admin("select status, cancelled_by, cancel_reason from public.rides where id = $1", [ride.id])).rows[0];
    expect(r).toMatchObject({ status: "cancelled", cancelled_by: "system", cancel_reason: "appointment_cancelled" });
    expect((await outbox()).some((o) => o.kind === "booking_cancelled" && o.user_id === U.driver)).toBe(true);
  });

  it("tells both parties when an attached ride finds no driver; the appointment stays", async () => {
    const a = await request(U.client, "siosia", 5 * 60);
    await answer(U.siosia, a.id, "accept");
    const ride = await book(U.client, 4 * 60, a.id, "there");
    await h.admin("update public.rides set status = 'expired', ended_at = now(), cancelled_by = 'system' where id = $1", [ride.id]);
    const failed = (await outbox()).filter((o) => o.kind === "appt_ride_failed").map((o) => o.user_id).sort();
    expect(failed).toEqual([U.client, U.siosia].sort());
    expect(await getAppt(U.siosia, a.id)).toMatchObject({ status: "accepted", rides: [expect.objectContaining({ status: "failed" })] });
  });
});

describe("reminders (FR-120–122, V7, V8)", () => {
  it("reminds both parties once per slot with the status and ride words, never late or after cancel", async () => {
    const a = await request(U.client, "siosia", 25 * 60);
    await answer(U.siosia, a.id, "accept");
    await book(U.siosia, 24 * 60, a.id, "there");
    await h.admin("delete from public.push_outbox");
    await shift(a.id, 24 * 60 - 1, -3 * 24 * 60);
    await sweep();
    await sweep();
    const rem = (await outbox()).filter((o) => o.kind === "appt_reminder");
    expect(rem.map((o) => o.user_id).sort()).toEqual([U.client, U.siosia].sort());
    expect(rem[0].params).toMatchObject({ lead: 1440, status: "confirmed", rides: [{ leg: "there", status: "pending", driver: null }] });
    expect((await getAppt(U.client, a.id)).reminders).toEqual([1440]);
    // Requested 20 h before: no day-before reminder; the 2 h one comes; the client waits, she answers.
    const b = await request(U.client, "siosia", 20 * 60);
    await h.admin("delete from public.push_outbox");
    await shift(b.id, 24 * 60 - 1, 4 * 60);
    await sweep();
    expect((await outbox()).filter((o) => o.kind === "appt_reminder")).toEqual([]);
    await shift(b.id, 119, -60);
    await sweep();
    const two = (await outbox()).filter((o) => o.kind === "appt_reminder");
    expect(two.map((o) => [o.user_id === U.client ? "client" : "siosia", o.params.status, o.params.lead]).sort()).toEqual([
      ["client", "waiting", 120],
      ["siosia", "answer", 120]
    ]);
    // A cancelled appointment gets nothing.
    const c = await request(U.client, "siosia", 72 * 60);
    await cancel(U.client, c.id);
    await h.admin("delete from public.push_outbox");
    await shift(c.id, 100, -3 * 24 * 60);
    await sweep();
    expect(await outbox()).toEqual([]);
  });
});

describe("series (FR-107–109, FR-117, V23–V26)", () => {
  it("creates a weekly series, answers it as a whole with clashes, cancels all remaining", async () => {
    expect(await errorOf(request(U.client, "siosia", 48 * 60, { service: "learning", duration: 60, repeat: { every: 3, count: 4 } }))).toBe("bad_repeat");
    expect(await errorOf(request(U.client, "siosia", 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 1 } }))).toBe("bad_repeat");
    expect(await errorOf(request(U.client, "siosia", 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 13 } }))).toBe("bad_repeat");
    expect(await errorOf(request(U.client, "siosia", 25 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 2, count: 6 } }))).toBe("bad_repeat");
    const first = await request(U.client, "siosia", 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 4 } });
    expect(first.series).toMatchObject({ rule: "weekly", count: 4, seq: 1, remaining: 4 });
    const starts = (first.series as Json).starts as number[];
    expect(starts.length).toBe(4);
    // Weekly at the same wall-clock time, also across the end of daylight saving time.
    const hm = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" }).format(ms);
    expect(new Set(starts.map(hm)).size).toBe(1);
    expect((await outbox()).map((o) => o.kind)).toEqual(["appt_new"]);
    expect((await outbox())[0].params).toMatchObject({ rule: "weekly", count: 4 });
    // A clash for the 2nd occurrence: she accepts another appointment then, before answering.
    const busy = await request(U.other, "siosia", 0, { service: "learning", duration: 60, startsAt: starts[1] + 15 * MIN });
    await answer(U.siosia, busy.id, "accept");
    expect(await h.call<Json>(U.siosia, "siosia_my_state")).toMatchObject({ toAnswer: 1 });
    const accepted = await answer(U.siosia, first.id, "accept");
    expect((accepted.series as Json).declined).toEqual([((first.series as Json).starts as number[])[1]]);
    const statuses = (await h.admin("select status from public.appointments where series_id = $1 order by seq", [(first.series as Json).id])).rows.map((r) => r.status);
    expect(statuses).toEqual(["accepted", "declined", "accepted", "accepted"]);
    const pushes = (await outbox()).filter((o) => o.kind === "appt_accepted" && o.user_id === U.client && o.appointment_id === first.id);
    expect(pushes.length).toBe(1);
    expect(pushes[0].params).toMatchObject({ accepted: 3 });
    // Cancel all remaining from the 3rd: 3 and 4 go, one notification.
    const third = (await h.admin("select id from public.appointments where series_id = $1 and seq = 3", [(first.series as Json).id])).rows[0].id;
    await h.admin("delete from public.push_outbox");
    await shift(first.id, -30);
    await cancel(U.client, third, "series");
    const after = (await h.admin("select seq, status from public.appointments where series_id = $1 order by seq", [(first.series as Json).id])).rows;
    expect(after.map((r) => r.status)).toEqual(["accepted", "declined", "cancelled", "cancelled"]);
    expect((await outbox()).map((o) => o.kind)).toEqual(["appt_cancelled"]);
    expect((await outbox())[0].params).toMatchObject({ left: 2 });
  });

  it("expires an unanswered series as a whole and limits open series to 3", async () => {
    const s = await request(U.client, "siosia", 48 * 60, { service: "learning", duration: 60, repeat: { every: 2, until: Date.now() + 40 * 24 * 3600_000 } });
    expect(s.series).toMatchObject({ rule: "biweekly", count: 3 });
    await h.admin("update public.appointment_series set first_start = now() - interval '1 minute' where id = $1", [(s.series as Json).id]);
    await h.admin("delete from public.push_outbox");
    await sweep();
    const st = (await h.admin("select status from public.appointments where series_id = $1", [(s.series as Json).id])).rows.map((r) => r.status);
    expect(st).toEqual(["expired", "expired", "expired"]);
    expect((await outbox()).map((o) => o.kind)).toEqual(["appt_expired"]);
    for (let i = 0; i < 3; i++) await request(U.client, "siosia", 48 * 60 + i * 120, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } });
    expect(await errorOf(request(U.client, "siosia", 48 * 60 + 600, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } }))).toBe("too_many");
  });

  it("books the series' rides from a template as occurrences enter the 30-day horizon", async () => {
    const s = await request(U.client, "siosia", 20 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 4 } });
    await answer(U.siosia, s.id, "accept");
    const sid = (s.series as Json).id;
    const tpl = { leg: "there", pickup: HOME, dropoff: SCHOOL, offsetMin: -30, estKm: 3, estMin: 8, fareIsEstimate: false };
    expect(await errorOf(h.call(U.siosia, "siosia_set_ride_template", [sid, { ...tpl, offsetMin: 10 }]))).toBe("bad_time");
    const view = await h.call<Json>(U.siosia, "siosia_set_ride_template", [sid, tpl]);
    expect((view.series as Json).rideTemplates).toEqual([expect.objectContaining({ leg: "there", offsetMin: -30, mine: true })]);
    const rides = async () => (await h.admin("select appointment_id, auto_booked from public.rides where rider_id = $1 order by scheduled_for", [U.siosia])).rows;
    expect((await rides()).length).toBe(2); // days 20 and 27; 34 and 41 are beyond the horizon
    expect((await rides()).every((r) => r.auto_booked)).toBe(true);
    const client = await getAppt(U.client, s.id);
    expect((client.series as Json).rideTemplates).toEqual([{ passenger: "provider", leg: "there", offsetMin: -30, mine: false }]);
    // A week later the next occurrence enters the horizon: the daily sweep books it.
    await h.admin("update public.appointments set starts_at = starts_at - interval '7 days' where series_id = $1", [sid]);
    await h.admin("update public.rides set scheduled_for = scheduled_for - interval '7 days' where rider_id = $1", [U.siosia]);
    await h.admin("update public.appointment_series set templates_at = now() - interval '2 days' where id = $1", [sid]);
    await sweep();
    expect((await rides()).length).toBe(3);
    // A removed ride stays removed; ending the template keeps the bookings.
    const one = (await rides())[0];
    const rideId = (await h.admin("select id from public.rides where appointment_id = $1", [one.appointment_id])).rows[0].id;
    await h.call(U.siosia, "siosia_cancel_ride", [rideId, null]);
    await h.admin("update public.appointment_series set templates_at = null where id = $1", [sid]);
    await sweep();
    expect((await h.admin("select count(*)::int as n from public.rides where appointment_id = $1", [one.appointment_id])).rows[0].n).toBe(1);
    await h.call(U.siosia, "siosia_drop_ride_template", [sid, "there"]);
    expect((await h.admin("select ride_templates from public.appointment_series where id = $1", [sid])).rows[0].ride_templates).toEqual([]);
    expect((await h.admin("select count(*)::int as n from public.rides where status = 'scheduled'")).rows[0].n).toBe(2);
  });
});

describe("bounded templates, an isolated sweep, clean places (review C0–C7)", () => {
  const TPL = { leg: "there", pickup: HOME, dropoff: SCHOOL, offsetMin: -30, estKm: 3, estMin: 8, fareIsEstimate: false };
  /** An accepted weekly series of 4 starting in 20 days (two dates within the booking horizon). */
  async function acceptedSeries() {
    const s = await request(U.client, "siosia", 20 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 4 } });
    await answer(U.siosia, s.id, "accept");
    return { first: s, sid: String((s.series as Json).id) };
  }
  const setTpl = (uid: string, sid: string, t: unknown) => h.call<Json>(uid, "siosia_set_ride_template", [sid, t]);

  it("refuses a ride estimate over a day or a trip over max_trip_km (C0, C1)", async () => {
    const { sid } = await acceptedSeries();
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, estMin: 1e300 }))).toBe("bad_input");
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, estMin: 3e8 }))).toBe("bad_input");
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, estMin: 1441 }))).toBe("bad_input");
    // Too far, as for a one-off booking of the same trip (a bad estimate is still bad_input first).
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, estKm: 51 }))).toBe("too_far");
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, estKm: 51, estMin: 1441 }))).toBe("bad_input");
    expect(await errorOf(h.call(U.client, "siosia_book_ride", [HOME, SCHOOL, 51, 8, false, at(3 * 60)]))).toBe("too_far");
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, offsetMin: -1e300 }))).toBe("bad_time");
    expect((await h.admin("select ride_templates from public.appointment_series where id = $1", [sid])).rows[0].ride_templates).toEqual([]);
    // The same bound for every booking and request (one would overflow est_min / the fare).
    expect(await errorOf(h.call(U.client, "siosia_book_ride", [HOME, SCHOOL, 3, 3e8, false, at(3 * 60)]))).toBe("bad_input");
    expect(await errorOf(h.call(U.client, "siosia_book_ride", [HOME, SCHOOL, 3, 1e300, false, at(3 * 60), null, null]))).toBe("bad_input");
    expect(await errorOf(h.call(U.client, "siosia_request_ride", [HOME, SCHOOL, 3, 1e300, false]))).toBe("bad_input");
    expect(await errorOf(h.call(U.client, "siosia_request_ride", [HOME, SCHOOL, 3, "NaN", false]))).toBe("bad_input");
    expect(await book(U.client, 3 * 60)).toMatchObject({ status: "scheduled", estMin: 8 });
  });

  it("keeps the sweep (and everyone's calls) working past a bad template written behind validation (C0, C1)", async () => {
    const { sid } = await acceptedSeries();
    const bad = [
      { ...TPL, passenger: "provider", estMin: 1e300 }, // integer out of range
      { ...TPL, passenger: "provider", leg: "back", offsetMin: 0, estMin: 3e8 }, // numeric field overflow
      { passenger: "client", leg: "there", offsetMin: "soon" }, // not even a template
      { ...TPL, passenger: "client", leg: "back", offsetMin: 0 } // a good one still books
    ];
    await h.admin("update public.appointment_series set ride_templates = $2::jsonb, templates_at = null where id = $1", [sid, JSON.stringify(bad)]);
    await sweep();
    expect(await h.call<Json>(U.other, "siosia_my_state")).toMatchObject({ planned: 0 });
    const s = (await h.admin("select templates_at from public.appointment_series where id = $1", [sid])).rows[0];
    expect(s.templates_at).not.toBeNull();
    const rides = (await h.admin("select rider_id, leg from public.rides r join public.appointments a on a.id = r.appointment_id where a.series_id = $1", [sid])).rows;
    expect(rides.map((r) => `${r.rider_id === U.client ? "client" : "siosia"}:${r.leg}`)).toEqual(["client:back", "client:back"]);
  });

  it("keeps the templates a list: the table refuses anything else, and every reader skips one that slipped in", async () => {
    const { first, sid } = await acceptedSeries();
    const write = (v: string) => h.admin("update public.appointment_series set ride_templates = $2::jsonb, templates_at = null where id = $1", [sid, v]);
    expect(await errorOf(write('{"x": 1}'))).toMatch(/appointment_series_ride_templates_check/);
    expect(await errorOf(write('"[]"'))).toMatch(/appointment_series_ride_templates_check/);
    // A database without the check (dropped by hand): the series still reads, sweeps and drops.
    const check = "appointment_series_ride_templates_check";
    const def = String((await h.admin("select pg_get_constraintdef(oid) as d from pg_constraint where conname = $1", [check])).rows[0].d);
    expect(def).toMatch(/jsonb_typeof\(ride_templates\) = 'array'/);
    await h.admin(`alter table public.appointment_series drop constraint ${check}`);
    try {
      await write('{"x": 1}');
      expect((await getAppt(U.client, first.id)).series).toMatchObject({ id: sid, rideTemplates: [] });
      expect((await h.call<Json>(U.siosia, "siosia_planned")).appointments).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id })]));
      // Skipped by the sweep too, and not retried on every call.
      await sweep();
      expect((await h.admin("select templates_at from public.appointment_series where id = $1", [sid])).rows[0].templates_at).not.toBeNull();
      expect(await h.call<Json>(U.client, "siosia_my_state")).toMatchObject({ planned: expect.any(Number) });
      await h.call(U.siosia, "siosia_drop_ride_template", [sid, "there"]);
      expect((await h.admin("select ride_templates from public.appointment_series where id = $1", [sid])).rows[0].ride_templates).toEqual([]);
    } finally {
      await h.admin("update public.appointment_series set ride_templates = '[]' where jsonb_typeof(ride_templates) <> 'array'");
      await h.admin(`alter table public.appointment_series add constraint ${check} ${def}`);
    }
  });

  it("shows a confirmed series in the calendar by its first live date, not a cancelled first one (C4)", async () => {
    const secret = String((await h.admin("select push_secret from public.app_secrets where id = 1")).rows[0].push_secret);
    const token = (id: unknown, who: string) => createHmac("sha256", secret).update(`${id}:${who}`).digest("hex").slice(0, 32);
    const first = await request(U.client, "siosia", 2 * 24 * 60, { repeat: { every: 1, count: 3 } });
    await answer(U.siosia, first.id, "accept");
    await cancel(U.client, first.id);
    const sid = String((first.series as Json).id);
    const v = (await h.admin("select public.siosia_calendar_view('s', $1, $2, $3) as v", [sid, pub.client, token(sid, pub.client)])).rows[0].v as Json;
    expect(v.view).toMatchObject({ status: "accepted", series: { id: sid, seq: 2, gaps: [((first.series as Json).starts as number[])[0]] } });
  });

  it("refuses a template with missing fields and stores only the known keys (C5)", async () => {
    const { sid } = await acceptedSeries();
    expect(await errorOf(setTpl(U.siosia, sid, { leg: "there" }))).toBe("bad_input");
    for (const k of ["pickup", "dropoff", "offsetMin", "estKm", "estMin"]) {
      const t: Json = { ...TPL };
      delete t[k];
      expect(await errorOf(setTpl(U.siosia, sid, t))).toBe("bad_input");
    }
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, pickup: null }))).toBe("bad_input");
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, dropoff: { lat: 52.2, label: "No lng" } }))).toBe("bad_input");
    await setTpl(U.siosia, sid, { ...TPL, junk: "x".repeat(5000), pickup: { ...HOME, junk: "y".repeat(5000) }, fareIsEstimate: "yes" });
    const stored = (await h.admin("select ride_templates from public.appointment_series where id = $1", [sid])).rows[0].ride_templates;
    expect(stored).toEqual([{ passenger: "provider", leg: "there", pickup: HOME, dropoff: SCHOOL, offsetMin: -30, estKm: 3, estMin: 8, fareIsEstimate: false }]);
  });

  it("refuses a place without lng for a request and for My place (C6)", async () => {
    const noLng = { lat: 52.2504843, label: "Warszawska 269" };
    expect(await errorOf(request(U.client, "siosia", 24 * 60, { place: noLng }))).toBe("bad_input");
    expect(await errorOf(h.call(U.client, "siosia_save_home", [noLng]))).toBe("bad_input");
    expect(await errorOf(h.call(U.client, "siosia_save_home", [{ lng: 20.8, label: "No lat" }]))).toBe("bad_input");
    expect((await h.admin("select siosia_valid_place($1::jsonb) as v", [JSON.stringify(noLng)])).rows[0].v).toBe(false);
    expect((await h.admin("select siosia_valid_place(null) as v")).rows[0].v).toBe(true);
    expect((await h.call<Json>(U.client, "siosia_save_home", [{ ...HOME, junk: 1 }])).home).toEqual(HOME);
  });

  it("tells the other party once when the same template is set again (C7)", async () => {
    const { sid } = await acceptedSeries();
    const added = async () => (await outbox()).filter((o) => o.kind === "appt_ride_added" && o.user_id === U.client).length;
    await setTpl(U.siosia, sid, TPL);
    await setTpl(U.siosia, sid, TPL);
    await setTpl(U.siosia, sid, { ...TPL, pickup: { ...HOME }, junk: 1 });
    expect(await added()).toBe(1);
    await setTpl(U.siosia, sid, { ...TPL, offsetMin: -45 });
    expect(await added()).toBe(2);
    expect((await h.admin("select ride_templates from public.appointment_series where id = $1", [sid])).rows[0].ride_templates).toEqual([
      expect.objectContaining({ passenger: "provider", leg: "there", offsetMin: -45 })
    ]);
  });

  it("answers an error, never raises, for numbers past float8; estimates to 3 decimals, offsets cut toward 0", async () => {
    const { sid } = await acceptedSeries();
    const stored = async () => (await h.admin("select ride_templates from public.appointment_series where id = $1", [sid])).rows[0].ride_templates;
    // Hand-made JSON (JSON.stringify cannot write these; the engine would read Infinity / 0): in
    // jsonb the later of two equal keys wins.
    const raw = (extra: string) => `${JSON.stringify(TPL).slice(0, -1)}, ${extra}}`;
    expect(await errorOf(setTpl(U.siosia, sid, raw('"estKm": 1e400')))).toBe("too_far");
    expect(await errorOf(setTpl(U.siosia, sid, raw('"estKm": -1e400')))).toBe("bad_input");
    expect(await errorOf(setTpl(U.siosia, sid, raw('"estKm": 1e-400')))).toBe("bad_input"); // rounds to no trip
    expect(await errorOf(setTpl(U.siosia, sid, raw('"estKm": 0.0004')))).toBe("bad_input");
    expect(await errorOf(setTpl(U.siosia, sid, raw('"estMin": 1e400')))).toBe("bad_input");
    expect(await errorOf(setTpl(U.siosia, sid, raw('"offsetMin": -1e400')))).toBe("bad_time");
    const tiny = '{"lat": 1e-400, "lng": 20.8, "label": "Tiny"}';
    expect(await errorOf(setTpl(U.siosia, sid, raw(`"pickup": ${tiny}`)))).toBe("bad_input");
    expect(await errorOf(h.call(U.client, "siosia_save_home", [tiny]))).toBe("bad_input");
    expect(await errorOf(request(U.client, "siosia", 24 * 60, { place: tiny }))).toBe("bad_input");
    expect(await stored()).toEqual([]);
    await setTpl(U.siosia, sid, { ...TPL, offsetMin: -30.5, estKm: 3.14159, estMin: 8.12345 });
    expect(await stored()).toEqual([expect.objectContaining({ offsetMin: -30, estKm: 3.142, estMin: 8.123 })]);
    const rides = await h.admin(
      "select (extract(epoch from a.starts_at - r.scheduled_for) / 60)::int as m from public.rides r join public.appointments a on a.id = r.appointment_id where a.series_id = $1 order by r.scheduled_for",
      [sid]
    );
    expect(rides.rows.map((r) => r.m)).toEqual([30, 30]);
    await setTpl(U.siosia, sid, { ...TPL, leg: "back", offsetMin: 10.9 });
    expect(await stored()).toEqual([expect.objectContaining({ leg: "there" }), expect.objectContaining({ leg: "back", offsetMin: 10 })]);
    await setTpl(U.siosia, sid, raw('"estMin": 1e-400'));
    expect(await stored()).toEqual(expect.arrayContaining([expect.objectContaining({ leg: "there", offsetMin: -30, estKm: 3, estMin: 0 })]));
  });

  it("accepts any non-blank place label, stored trimmed and cut to 120, and refuses a blank one", async () => {
    const { sid } = await acceptedSeries();
    const LONG = { ...HOME, label: "W".repeat(200) }; // a geocoded label can be that long
    const CUT = { ...HOME, label: "W".repeat(120) };
    const BLANK = { ...HOME, label: "   " };
    expect((await h.call<Json>(U.client, "siosia_save_home", [LONG])).home).toEqual(CUT);
    expect((await h.call<Json>(U.client, "siosia_save_home", [{ ...HOME, label: `  ${HOME.label}  ` }])).home).toEqual(HOME);
    expect((await request(U.client, "siosia", 24 * 60, { place: LONG })).place).toEqual(CUT);
    await setTpl(U.siosia, sid, { ...TPL, pickup: LONG, dropoff: { ...SCHOOL, label: ` ${SCHOOL.label} ` } });
    expect((await h.admin("select ride_templates from public.appointment_series where id = $1", [sid])).rows[0].ride_templates).toEqual([
      expect.objectContaining({ pickup: CUT, dropoff: SCHOOL })
    ]);
    const booked = (await h.admin("select pickup_label, dropoff_label from public.rides where auto_booked order by scheduled_for")).rows;
    expect(booked.map((r) => [r.pickup_label, r.dropoff_label])).toEqual([[CUT.label, SCHOOL.label], [CUT.label, SCHOOL.label]]);
    expect((await h.call<Json>(U.client, "siosia_book_ride", [LONG, SCHOOL, 3, 8, false, at(3 * 60)])).pickup).toEqual(CUT);
    expect((await h.call<Json>(U.client, "siosia_request_ride", [LONG, { ...SCHOOL, label: ` ${SCHOOL.label}` }, 3, 8, false]))).toMatchObject({
      pickup: CUT,
      dropoff: SCHOOL
    });
    expect(await errorOf(h.call(U.client, "siosia_save_home", [BLANK]))).toBe("bad_input");
    expect(await errorOf(request(U.client, "siosia", 2 * 24 * 60, { place: BLANK }))).toBe("bad_input");
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, pickup: BLANK }))).toBe("bad_input");
    expect(await errorOf(setTpl(U.siosia, sid, { ...TPL, dropoff: { ...SCHOOL, label: "" } }))).toBe("bad_input");
    // An operator's master profile: the same rule, the same cut (and still an error for a blank label).
    const master = (pickup: unknown) =>
      h.admin("select public.siosia_set_master('longlabel', 'longlabel-token-0123456789', 'Daleko', null, null, 'rider', $1::jsonb)", [JSON.stringify(pickup)]);
    try {
      await master(LONG);
      expect((await h.admin("select default_pickup from public.master_profiles where id = 'longlabel'")).rows[0].default_pickup).toEqual(CUT);
      expect(await errorOf(master(BLANK))).toMatch(/A place is/);
      expect(await errorOf(master({ lat: HOME.lat, lng: HOME.lng }))).toMatch(/A place is/);
    } finally {
      await h.admin("delete from public.master_profiles where id = 'longlabel'");
    }
  });
});

describe("open requests (2.1: FR-160–164, V34–V37)", () => {
  /** Every member but the client (all of them have a profile and notifications on here). */
  const OTHERS = () => [U.siosia, U.driver, U.other, U.gone].sort();
  const changed = async () => (await h.admin("select topic from realtime.messages where event = 'changed'")).rows.map((r) => String(r.topic));
  const openOf = async (uid: string) => (await h.call<Json>(uid, "siosia_planned")).open as Json[];
  const row = async (id: unknown) => (await h.admin("select provider_id, status from public.appointments where id = $1", [id])).rows[0];
  /** Empties the notification queue and the realtime log. */
  const quiet = () => h.db.exec("delete from public.push_outbox; delete from realtime.messages;");

  it("creates an open request (single and series) every other member sees as a candidate — never a user id or My place", async () => {
    await h.call(U.client, "siosia_save_home", [HOME]);
    const a = await request(U.client, null, 30 * 60, { place: SCHOOL, note: "Two kids, homework first" });
    expect(a).toMatchObject({ status: "requested", role: "client", open: true, provider: null, serviceId: "childcare", place: SCHOOL, series: null });
    // The client keeps it in their own schedule (not among the ones to take).
    const mine = await h.call<Json>(U.client, "siosia_planned");
    expect(mine.appointments).toEqual([expect.objectContaining({ id: a.id, role: "client", open: true, provider: null })]);
    expect(mine.open).toEqual([]);
    expect(await h.call<Json>(U.client, "siosia_my_state")).toMatchObject({ planned: 1, toAnswer: 0, openRequests: 0 });
    // Everyone else: what, when, where, by whom — nothing of the parties' own (rides, reminders, links).
    const theirs = await openOf(U.other);
    expect(theirs).toEqual([
      expect.objectContaining({
        id: a.id, role: "candidate", open: true, status: "requested", provider: null, serviceId: "childcare",
        service: expect.objectContaining({ name: { en: "Childcare", pl: "Opieka nad dziećmi" } }),
        startsAt: a.startsAt, endsAt: a.endsAt, durationMin: 180, place: SCHOOL, note: "Two kids, homework first",
        price: null, currency: "PLN", client: expect.objectContaining({ nickname: "Toria", publicId: pub.client }),
        rides: [], reminders: [], myRating: null, series: null, calendar: { google: null, ics: null }
      })
    ]);
    const text = JSON.stringify(theirs);
    for (const id of Object.values(U)) expect(text).not.toContain(id);
    expect(text).not.toContain(HOME.label);
    expect(text).not.toMatch(/"home"|"userId"/);
    expect((await h.call<Json>(U.other, "siosia_planned")).appointments).toEqual([]);
    expect(await h.call<Json>(U.siosia, "siosia_my_state")).toMatchObject({ openRequests: 1, toAnswer: 0, planned: 0 });
    // A series is listed once, as its first date, soonest first; candidates get no templates or links.
    await h.admin("update public.app_config set calendar_function_url = 'https://x.supabase.co/functions/v1/calendar' where id = 1");
    try {
      const s = await request(U.client, null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 } });
      expect(s).toMatchObject({ open: true, provider: null, series: { rule: "weekly", count: 3, seq: 1, remaining: 3 } });
      expect(((s.series as Json).ics as string) ?? "").toContain(`u=${pub.client}`);
      const list = await openOf(U.other);
      expect(list.map((x) => x.id)).toEqual([a.id, s.id]);
      expect(list[1]).toMatchObject({
        role: "candidate",
        calendar: { google: null, ics: null },
        series: { id: (s.series as Json).id, rule: "weekly", seq: 1, count: 3, status: "requested", remaining: 3, declined: [], gaps: [], starts: (s.series as Json).starts, rideTemplates: [], ics: null }
      });
      expect(await h.call<Json>(U.other, "siosia_my_state")).toMatchObject({ openRequests: 2 });
    } finally {
      await h.admin("update public.app_config set calendar_function_url = null where id = 1");
    }
    // Only for someone with a profile.
    expect((await h.admin("select count(*)::int as n from public.siosia_open_rows($1)", [U.stranger])).rows[0].n).toBe(0);
    expect((await h.admin("select count(*)::int as n from public.siosia_open_rows($1)", [U.other])).rows[0].n).toBe(2);
  });

  it("tells every other member once (appt_open, their language), never the client; everyone's list refreshes", async () => {
    await h.call(U.other, "siosia_save_profile", ["Ewa", "pl"]);
    try {
      await h.admin("delete from realtime.messages");
      const a = await request(U.client, null, 30 * 60);
      const box = await outbox();
      expect(box.every((o) => o.kind === "appt_open" && o.appointment_id === a.id)).toBe(true);
      expect(box.map((o) => o.user_id).sort()).toEqual(OTHERS());
      const ewa = box.find((o) => o.user_id === U.other)!;
      expect(ewa.params).toMatchObject({ service: "Opieka nad dziećmi", client: "Toria", place: HOME.label, open: true });
      expect(box.find((o) => o.user_id === U.siosia)!.params).toMatchObject({ service: "Childcare", serviceId: "childcare", open: true });
      expect(ewa.params).toHaveProperty("at");
      expect(ewa.params).toHaveProperty("end");
      expect(await changed()).toEqual(expect.arrayContaining([U.client, ...OTHERS()].map((u) => `user:${u}`)));
      // A series: one each, tagged with its first date, with the rule.
      await h.admin("delete from public.push_outbox");
      const s = await request(U.client, null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 2, count: 3 } });
      const sbox = await outbox();
      expect(sbox.map((o) => `${o.kind}>${o.appointment_id === s.id}`)).toEqual(Array(4).fill("appt_open>true"));
      expect(sbox.map((o) => o.user_id).sort()).toEqual(OTHERS());
      expect(sbox[0].params).toMatchObject({ rule: "biweekly", count: 3, open: true, first: expect.any(String), last: expect.any(String) });
    } finally {
      await h.call(U.other, "siosia_save_profile", ["Ewa", "en"]);
    }
  });

  it("applies every request rule and limit to an open request", async () => {
    expect(await errorOf(request(U.client, null, 24 * 60, { service: "ride" }))).toBe("bad_service");
    expect(await errorOf(request(U.client, null, 24 * 60, { service: "music" }))).toBe("bad_service");
    expect(await errorOf(request(U.client, null, 10))).toBe("bad_time");
    expect(await errorOf(request(U.client, null, 31 * 24 * 60))).toBe("bad_time");
    expect(await errorOf(request(U.client, null, 24 * 60, { duration: 45 }))).toBe("bad_duration");
    expect(await errorOf(request(U.client, null, 24 * 60, { place: null }))).toBe("bad_input");
    expect(await errorOf(request(U.client, null, 24 * 60, { note: "x".repeat(201) }))).toBe("bad_input");
    expect(await errorOf(request(U.client, null, 48 * 60, { repeat: { every: 3, count: 2 } }))).toBe("bad_repeat");
    // A provider id that is nobody's is still no provider (only null is open).
    expect(await errorOf(h.call(U.client, "siosia_request_service", ["childcare", "nobody-at-all", at(24 * 60), 180, HOME, "", null]))).toBe("no_provider");
    expect(await outbox()).toEqual([]);
    // Open and addressed requests count together: 10 open singles, 3 open series, 20 new a day.
    const singles: unknown[] = [];
    for (let i = 0; i < 10; i++) singles.push((await request(U.client, i % 2 ? "siosia" : null, 24 * 60 + i * 300, { duration: 60 })).id);
    expect(await errorOf(request(U.client, null, 24 * 60 + 3000, { duration: 60 }))).toBe("too_many");
    for (let i = 0; i < 3; i++) await request(U.client, i === 1 ? "siosia" : null, 48 * 60 + i * 120, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } });
    expect(await errorOf(request(U.client, null, 48 * 60 + 600, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } }))).toBe("too_many");
    for (const id of singles) await cancel(U.client, id);
    for (let i = 0; i < 7; i++) await request(U.client, null, 26 * 60 + i * 300, { duration: 60 });
    expect(await errorOf(request(U.client, null, 26 * 60 + 3000, { duration: 60 }))).toBe("too_many");
  });

  it("lets the first taker have it: provider and accepted at once, the client told as for an accept", async () => {
    const a = await request(U.client, null, 30 * 60);
    await quiet();
    const t = await take(U.other, a.id);
    expect(t).toMatchObject({ id: a.id, role: "provider", status: "accepted", open: false, provider: { nickname: "Ewa", publicId: pub.other } });
    expect(t.answeredAt).toEqual(expect.any(Number));
    expect(await row(a.id)).toEqual({ provider_id: U.other, status: "accepted" });
    expect((await outbox()).map((o) => `${o.kind}>${o.user_id === U.client ? "client" : o.user_id}`)).toEqual(["appt_accepted>client"]);
    expect((await outbox())[0].params).toMatchObject({ provider: "Ewa", client: "Toria", service: "Childcare" });
    // The client and every member refetch: it left the candidates' lists and badges.
    expect(await changed()).toEqual(expect.arrayContaining([U.client, ...OTHERS()].map((u) => `user:${u}`)));
    expect(await getAppt(U.client, a.id)).toMatchObject({ role: "client", status: "accepted", open: false, provider: { nickname: "Ewa" } });
    expect((await h.call<Json>(U.other, "siosia_planned")).appointments).toEqual([expect.objectContaining({ id: a.id, role: "provider" })]);
    expect(await openOf(U.siosia)).toEqual([]);
    expect(await h.call<Json>(U.siosia, "siosia_my_state")).toMatchObject({ openRequests: 0 });
    expect(await errorOf(getAppt(U.siosia, a.id))).toBe("not_found"); // no longer anyone's to take
    // Later takers: taken; the client cannot take their own; gone or started: illegal_transition.
    expect(await errorOf(take(U.siosia, a.id))).toBe("taken");
    const own = await request(U.client, null, 40 * 60);
    expect(await errorOf(take(U.client, own.id))).toBe("forbidden");
    expect(await errorOf(take(U.other, "00000000-0000-4000-8000-00000000dead"))).toBe("not_found");
    expect(await getAppt(U.other, own.id)).toMatchObject({ role: "candidate" });
    await cancel(U.client, own.id);
    expect(await errorOf(take(U.other, own.id))).toBe("illegal_transition");
    expect(await errorOf(getAppt(U.other, own.id))).toBe("not_found");
    const late = await request(U.client, null, 50 * 60);
    await shift(late.id, -1);
    expect(await errorOf(take(U.other, late.id))).toBe("illegal_transition");
    expect(await row(late.id)).toEqual({ provider_id: null, status: "expired" });
    expect((await outbox()).filter((o) => o.kind === "appt_accepted")).toHaveLength(1);
    // The claim itself is atomic: someone faster between the check and the claim (here a trigger
    // claims it for Siosia first) leaves the slower taker with taken, and nothing of theirs.
    const raced = await request(U.client, null, 60 * 60);
    await h.db.exec(`
      create function public.test_faster() returns trigger language plpgsql as $$
      begin
        if old.provider_id is null and new.provider_id is not null and current_setting('test.faster', true) is distinct from '1' then
          perform set_config('test.faster', '1', true);
          update public.appointments set provider_id = '${U.siosia}' where id = old.id;
          return null;
        end if;
        return new;
      end $$;
      create trigger test_faster before update on public.appointments for each row execute function public.test_faster();`);
    try {
      expect(await errorOf(take(U.other, raced.id))).toBe("taken");
    } finally {
      await h.db.exec("drop trigger test_faster on public.appointments; drop function public.test_faster();");
    }
    expect(await row(raced.id)).toEqual({ provider_id: U.siosia, status: "requested" });
    expect((await outbox()).filter((o) => o.kind === "appt_accepted")).toHaveLength(1);
  });

  it("takes a series as a whole, declining the dates that clash with the taker's schedule", async () => {
    const s = await request(U.client, null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 4 } });
    const starts = (s.series as Json).starts as number[];
    const sid = (s.series as Json).id;
    const busy = await request(U.other, "siosia", 0, { service: "learning", duration: 60, startsAt: starts[1] + 15 * MIN });
    await answer(U.siosia, busy.id, "accept");
    await h.admin("delete from public.push_outbox");
    const t = await take(U.siosia, s.id);
    expect(t).toMatchObject({ role: "provider", status: "accepted", open: false, provider: { nickname: "Siosia" }, series: { status: "answered", declined: [starts[1]] } });
    const occ = (await h.admin("select provider_id, status from public.appointments where series_id = $1 order by seq", [sid])).rows;
    expect(occ.map((r) => r.status)).toEqual(["accepted", "declined", "accepted", "accepted"]);
    expect(occ.every((r) => r.provider_id === U.siosia)).toBe(true);
    expect((await h.admin("select provider_id, status from public.appointment_series where id = $1", [sid])).rows[0]).toEqual({ provider_id: U.siosia, status: "answered" });
    const pushes = await outbox();
    expect(pushes.map((o) => `${o.kind}>${o.user_id === U.client ? "client" : o.user_id}:${o.appointment_id === s.id}`)).toEqual(["appt_accepted>client:true"]);
    expect(pushes[0].params).toMatchObject({ accepted: 3, declined: [expect.any(String)], rule: "weekly", provider: "Siosia" });
    expect(await openOf(U.other)).toEqual([]);
    expect(await errorOf(take(U.other, s.id))).toBe("taken");
    // Taking any of its dates takes the whole series.
    const s2 = await request(U.client, null, 72 * 60, { service: "learning", duration: 60, repeat: { every: 2, count: 2 } });
    const second = (await h.admin("select id from public.appointments where series_id = $1 and seq = 2", [(s2.series as Json).id])).rows[0].id;
    expect(await take(U.other, second)).toMatchObject({ id: second, role: "provider", status: "accepted", series: { seq: 2, remaining: 2 } });
    expect((await h.admin("select provider_id, status from public.appointments where series_id = $1 order by seq", [(s2.series as Json).id])).rows).toEqual([
      { provider_id: U.other, status: "accepted" },
      { provider_id: U.other, status: "accepted" }
    ]);
  });

  it("refuses a single request that clashes with the taker's appointments or taken bookings; it stays open", async () => {
    const busy = await request(U.other, "siosia", 30 * 60, { duration: 180 });
    await answer(U.siosia, busy.id, "accept");
    const a = await request(U.client, null, 30 * 60 + 60, { duration: 60 });
    await quiet();
    expect(await errorOf(take(U.siosia, a.id))).toBe("overlap");
    expect(await row(a.id)).toEqual({ provider_id: null, status: "requested" });
    expect(await outbox()).toEqual([]);
    expect(await changed()).toEqual([]); // the claim was undone with everything it set off
    expect((await openOf(U.siosia)).map((x) => x.id)).toEqual([a.id]);
    // A booking the caller took as a driver counts too.
    const ride = await book(U.client, 26 * 60);
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    const lesson = await request(U.client, null, 26 * 60 - 30, { service: "learning", duration: 60 });
    expect(await errorOf(take(U.driver, lesson.id))).toBe("overlap");
    expect(await row(lesson.id)).toEqual({ provider_id: null, status: "requested" });
    // Someone free takes it.
    expect(await take(U.other, lesson.id)).toMatchObject({ status: "accepted", provider: { nickname: "Ewa" } });
  });

  it("refuses a series none of whose dates the taker is free for: overlap, nothing claimed, declined or told (B6)", async () => {
    const s = await request(U.client, null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 } });
    const starts = (s.series as Json).starts as number[];
    const sid = (s.series as Json).id;
    const rows = async () => (await h.admin("select provider_id, status from public.appointments where series_id = $1 order by seq", [sid])).rows;
    const series = async () => (await h.admin("select provider_id, status from public.appointment_series where id = $1", [sid])).rows[0];
    // Siosia has a lesson on each of the three dates.
    const busy: unknown[] = [];
    for (const t of starts) {
      const b = await request(U.other, "siosia", 0, { service: "learning", duration: 60, startsAt: t + 15 * MIN });
      await answer(U.siosia, b.id, "accept");
      busy.push(b.id);
    }
    await quiet();
    expect(await errorOf(take(U.siosia, s.id))).toBe("overlap");
    expect(await rows()).toEqual(Array(3).fill({ provider_id: null, status: "requested" }));
    expect(await series()).toEqual({ provider_id: null, status: "requested" });
    expect(await outbox()).toEqual([]);
    expect(await changed()).toEqual([]);
    expect((await openOf(U.siosia)).map((x) => x.id)).toEqual([s.id]);
    expect(await getAppt(U.client, s.id)).toMatchObject({ status: "requested", open: true, provider: null, series: { status: "requested", declined: [] } });
    // By any of its dates.
    const third = (await h.admin("select id from public.appointments where series_id = $1 and seq = 3", [sid])).rows[0].id;
    expect(await errorOf(take(U.siosia, third))).toBe("overlap");
    expect(await rows()).toEqual(Array(3).fill({ provider_id: null, status: "requested" }));
    // One free date is enough: the 2nd lesson goes; the take accepts that date and declines the others.
    await cancel(U.other, busy[1]);
    await quiet();
    expect(await take(U.siosia, s.id)).toMatchObject({ role: "provider", series: { status: "answered", declined: [starts[0], starts[2]] } });
    expect((await rows()).map((r) => r.status)).toEqual(["declined", "accepted", "declined"]);
    expect((await rows()).every((r) => r.provider_id === U.siosia)).toBe(true);
    expect(await series()).toEqual({ provider_id: U.siosia, status: "answered" });
    const pushes = await outbox();
    expect(pushes.map((o) => `${o.kind}>${o.user_id === U.client ? "client" : o.user_id}`)).toEqual(["appt_accepted>client"]);
    expect(pushes[0].params).toMatchObject({ accepted: 1, declined: [expect.any(String), expect.any(String)] });
  });

  it("stays right when a date is withdrawn as the claim lands: accepts a date actually claimed, or undoes everything (second guard)", async () => {
    // A withdrawal landing with the claim itself: here a trigger cancels the 1st date as the series row is claimed.
    const withdrawFirst = () =>
      h.db.exec(`
      create function public.test_withdraw_first() returns trigger language plpgsql as $$
      begin
        if old.provider_id is null and new.provider_id is not null then
          update public.appointments set status = 'cancelled', ended_at = now(), cancelled_by = 'client'
           where series_id = new.id and seq = 1 and status = 'requested';
        end if;
        return new;
      end $$;
      create trigger test_withdraw_first before update on public.appointment_series for each row execute function public.test_withdraw_first();`);
    const restore = () => h.db.exec("drop trigger test_withdraw_first on public.appointment_series; drop function public.test_withdraw_first();");
    const rows = async (sid: unknown) => (await h.admin("select provider_id, status from public.appointments where series_id = $1 order by seq", [sid])).rows;
    const series = async (sid: unknown) => (await h.admin("select provider_id, status from public.appointment_series where id = $1", [sid])).rows[0];
    // The date asked for goes, the others are taken: the Accept works on a date actually claimed; the view is of the first taken.
    const s = await request(U.client, null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 } });
    const sid = (s.series as Json).id;
    const second = (await h.admin("select id from public.appointments where series_id = $1 and seq = 2", [sid])).rows[0].id;
    await quiet();
    await withdrawFirst();
    let t: Json;
    try {
      t = await take(U.other, s.id);
    } finally {
      await restore();
    }
    expect(t).toMatchObject({ id: second, role: "provider", status: "accepted", open: false, series: { status: "answered", seq: 2, remaining: 2, declined: [] } });
    expect(await rows(sid)).toEqual([
      { provider_id: null, status: "cancelled" },
      { provider_id: U.other, status: "accepted" },
      { provider_id: U.other, status: "accepted" }
    ]);
    expect(await series(sid)).toEqual({ provider_id: U.other, status: "answered" });
    const pushes = await outbox();
    expect(pushes.map((o) => `${o.kind}>${o.user_id === U.client ? "client" : o.user_id}`)).toEqual(["appt_accepted>client"]);
    expect(pushes[0].params).toMatchObject({ accepted: 2, declined: [] });
    // The only date the taker was free for goes: nothing is accepted — the claim, the declines and
    // the notification are undone (overlap), the series stays open. (The withdrawal, part of the
    // same transaction here, is undone with them.)
    const s2 = await request(U.client, null, 72 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } });
    const sid2 = (s2.series as Json).id;
    const busy = await request(U.other, "siosia", 0, { service: "learning", duration: 60, startsAt: ((s2.series as Json).starts as number[])[1] + 15 * MIN });
    await answer(U.siosia, busy.id, "accept");
    await quiet();
    await withdrawFirst();
    try {
      expect(await errorOf(take(U.siosia, s2.id))).toBe("overlap");
    } finally {
      await restore();
    }
    expect(await rows(sid2)).toEqual(Array(2).fill({ provider_id: null, status: "requested" }));
    expect(await series(sid2)).toEqual({ provider_id: null, status: "requested" });
    expect(await outbox()).toEqual([]);
    expect(await changed()).toEqual([]);
    expect((await openOf(U.siosia)).map((x) => x.id)).toEqual([s2.id]);
  });

  it("cancels and takes in either order with the series row locked first (the lock order, run in sequence)", async () => {
    const status = async (sid: unknown) => (await h.admin("select status from public.appointment_series where id = $1", [sid])).rows[0].status;
    // A withdrawn series cannot be taken.
    const s = await request(U.client, null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } });
    await cancel(U.client, s.id, "series");
    expect(await errorOf(take(U.other, s.id))).toBe("illegal_transition");
    expect(await status((s.series as Json).id)).toBe("cancelled");
    // A date withdrawn alone leaves the rest to take; then either party cancels, one date or the rest.
    const s2 = await request(U.client, null, 72 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 } });
    const sid2 = (s2.series as Json).id;
    const ids = (await h.admin("select id from public.appointments where series_id = $1 order by seq", [sid2])).rows.map((r) => r.id);
    await cancel(U.client, ids[0], "one");
    expect(await status(sid2)).toBe("requested");
    expect(await errorOf(take(U.other, ids[0]))).toBe("illegal_transition");
    expect(await take(U.other, ids[1])).toMatchObject({ id: ids[1], role: "provider", status: "accepted", series: { seq: 2, remaining: 2 } });
    expect(await errorOf(cancel(U.siosia, ids[2]))).toBe("not_found"); // no party
    await cancel(U.client, ids[2], "one");
    await quiet();
    await cancel(U.other, ids[1], "series");
    expect((await h.admin("select status from public.appointments where series_id = $1 order by seq", [sid2])).rows.map((r) => r.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled"
    ]);
    expect(await status(sid2)).toBe("cancelled");
    expect((await outbox()).map((o) => `${o.kind}>${o.user_id === U.client ? "client" : o.user_id}`)).toEqual(["appt_cancelled>client"]);
  });

  it("lets the client withdraw it (one or the whole series); nobody to tell, members' lists update", async () => {
    const a = await request(U.client, null, 30 * 60);
    const s = await request(U.client, null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 } });
    await quiet();
    await cancel(U.client, a.id);
    expect(await getAppt(U.client, a.id)).toMatchObject({ status: "cancelled", cancelledBy: "client", open: false, provider: null });
    expect(await changed()).toEqual(expect.arrayContaining(OTHERS().map((u) => `user:${u}`)));
    expect((await openOf(U.other)).map((x) => x.id)).toEqual([s.id]);
    expect(await errorOf(cancel(U.other, s.id))).toBe("not_found"); // a candidate is no party
    await cancel(U.client, s.id, "series");
    const st = (await h.admin("select status from public.appointments where series_id = $1", [(s.series as Json).id])).rows.map((r) => r.status);
    expect(st).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(await openOf(U.other)).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it("expires an open request nobody took — the client told with open — and reminds only its client", async () => {
    const a = await request(U.client, null, 24 * 60);
    const s = await request(U.client, null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } });
    await h.admin("delete from public.push_outbox");
    await shift(a.id, -1);
    await h.admin("update public.appointment_series set first_start = now() - interval '1 minute' where id = $1", [(s.series as Json).id]);
    await sweep();
    expect(await row(a.id)).toEqual({ provider_id: null, status: "expired" });
    const box = await outbox();
    expect(box.map((o) => `${o.kind}>${o.user_id === U.client ? "client" : o.user_id}`)).toEqual(["appt_expired>client", "appt_expired>client"]);
    expect(box.find((o) => o.appointment_id === s.id)!.params).toMatchObject({ open: true, rule: "weekly", count: 2 });
    expect(box.find((o) => o.appointment_id === a.id)!.params).toMatchObject({ open: true, provider: "" });
    // In the client's history, without a provider.
    const hist = await h.call<Json[]>(U.client, "siosia_timeline");
    expect(hist).toEqual(expect.arrayContaining([expect.objectContaining({ appointment: expect.objectContaining({ id: a.id, status: "expired", provider: null, open: false }) })]));
    // Reminders: the client only, "open" (nobody took it yet).
    const b = await request(U.client, null, 25 * 60);
    await h.admin("delete from public.push_outbox");
    await shift(b.id, 24 * 60 - 1, -3 * 24 * 60);
    await sweep();
    await sweep();
    const rem = await outbox();
    expect(rem.map((o) => `${o.kind}>${o.user_id === U.client ? "client" : o.user_id}`)).toEqual(["appt_reminder>client"]);
    expect(rem[0].params).toMatchObject({ lead: 1440, role: "client", status: "open", other: "", rides: [] });
    expect((await getAppt(U.client, b.id)).reminders).toEqual([1440]);
  });

  it("never fails on a request without a provider: rides, ratings, calendar, deleted client, retention", async () => {
    const a = await request(U.client, null, 30 * 60);
    // Only an accepted appointment takes rides; a candidate is no party.
    expect(await errorOf(book(U.client, 29 * 60, a.id, "there"))).toBe("not_accepted");
    expect(await errorOf(book(U.other, 29 * 60, a.id, "there"))).toBe("not_found");
    expect(await errorOf(h.call(U.client, "siosia_rate_appointment", [a.id, 5, ""]))).toBe("illegal_transition");
    expect(await errorOf(h.call(U.other, "siosia_rate_appointment", [a.id, 5, ""]))).toBe("not_found");
    // A candidate may open it (C3), as in the list; the calendar is the parties' only.
    expect(await getAppt(U.other, a.id)).toMatchObject({ id: a.id, role: "candidate", open: true, provider: null, rides: [], calendar: { ics: null } });
    // The calendar: the client's own link works; a candidate's token gets nothing.
    const secret = String((await h.admin("select push_secret from public.app_secrets where id = 1")).rows[0].push_secret);
    const token = (id: unknown, who: string) => createHmac("sha256", secret).update(`${id}:${who}`).digest("hex").slice(0, 32);
    const view = async (who: string) => (await h.admin("select public.siosia_calendar_view('a', $1, $2, $3) as v", [a.id, who, token(a.id, who)])).rows[0].v as Json | null;
    expect((await view(pub.client))?.view).toMatchObject({ id: a.id, role: "client", open: true, provider: null });
    expect(await view(pub.other)).toBeNull();
    // A client who deletes their profile takes their open requests along; nobody is pushed.
    const Z = "00000000-0000-4000-8000-000000000109";
    await h.admin("insert into auth.users (id) values ($1) on conflict do nothing", [Z]);
    await h.onboard(Z, "Zosia");
    const z = await request(Z, null, 30 * 60);
    expect((await openOf(U.other)).map((x) => x.id)).toEqual(expect.arrayContaining([z.id]));
    await h.admin("delete from public.push_outbox");
    await h.call(Z, "siosia_delete_profile");
    expect((await h.admin("select status, cancelled_by, cancel_reason, provider_id from public.appointments where id = $1", [z.id])).rows[0]).toEqual({
      status: "cancelled",
      cancelled_by: "system",
      cancel_reason: "user_gone",
      provider_id: null
    });
    expect(await outbox()).toEqual([]);
    expect((await openOf(U.other)).map((x) => x.id)).toEqual([a.id]);
    // Retention removes an old one like any other.
    await cancel(U.client, a.id);
    await h.admin("update public.appointments set ended_at = now() - interval '13 months' where id = $1", [a.id]);
    await h.admin("select public.siosia_retention()");
    expect((await h.admin("select count(*)::int as n from public.appointments where id = $1", [a.id])).rows[0].n).toBe(0);
  });
});

describe("profiles, masters, calendar, compatibility", () => {
  it("cancels a deleted provider's upcoming appointments and tells the client", async () => {
    const a = await request(U.client, "gone", 24 * 60, { service: "learning", duration: 60 });
    await answer(U.gone, a.id, "accept");
    await h.admin("delete from public.push_outbox");
    await h.call(U.gone, "siosia_delete_profile");
    expect(await getAppt(U.client, a.id)).toMatchObject({ status: "cancelled", cancelledBy: "system", cancelReason: "user_gone", provider: { nickname: "Deleted user" } });
    expect((await outbox()).map((o) => `${o.kind}>${o.user_id === U.client ? "client" : "x"}`)).toEqual(["appt_cancelled>client"]);
    const cat = await h.call<Json[]>(U.client, "siosia_catalog");
    expect(cat.find((e) => e.id === "learning")!.providers).toEqual([expect.objectContaining({ nickname: "Siosia" })]);
  });

  it("lets a master profile preset its offers; a driver master may request other services", async () => {
    await h.admin(
      "select public.siosia_set_master('nanny', 'nanny-token-0123456789', 'Niania', null, null, 'rider', null, null, null, array['childcare'])"
    );
    await h.call(U.master, "siosia_join_master", ["nanny-token-0123456789", "dev-m", "pl", false]);
    const p = await h.call<Json>(U.master, "siosia_get_profile");
    expect(p).toMatchObject({ offers: ["childcare"], offersPreset: true });
    pub.master = String(p.publicId);
    expect(await errorOf(h.call(U.master, "siosia_set_offers", [["learning"]]))).toBe("forbidden");
    const cat = await h.call<Json[]>(U.client, "siosia_catalog");
    expect(cat.find((e) => e.id === "childcare")!.providers).toEqual(expect.arrayContaining([expect.objectContaining({ nickname: "Niania" })]));
    // A rider master offers childcare, though it cannot offer rides.
    const a = await request(U.client, "master", 24 * 60);
    const ans = await answer(U.master, a.id, "accept");
    expect(ans).toMatchObject({ status: "accepted" });
    expect(await h.call<Json>(U.master, "siosia_my_state")).toMatchObject({ nextPlanned: { title: "Opieka nad dziećmi" } });
  });

  it("links the calendar function with a token bound to the viewer", async () => {
    const a = await request(U.client, "siosia", 24 * 60);
    expect((await getAppt(U.client, a.id)).calendar).toEqual({ google: null, ics: null });
    await h.admin("update public.app_config set calendar_function_url = 'https://x.supabase.co/functions/v1/calendar' where id = 1");
    const ics = String(((await getAppt(U.client, a.id)).calendar as Json).ics);
    const secret = String((await h.admin("select push_secret from public.app_secrets where id = 1")).rows[0].push_secret);
    const token = createHmac("sha256", secret).update(`${a.id}:${pub.client}`).digest("hex").slice(0, 32);
    expect(ics).toBe(`https://x.supabase.co/functions/v1/calendar?a=${a.id}&u=${pub.client}&t=${token}`);
    expect(String(((await getAppt(U.siosia, a.id)).calendar as Json).ics)).toContain(`u=${pub.siosia}`);
    await h.admin("update public.app_config set calendar_function_url = null where id = 1");
  });

  it("serves the calendar view only to a party with that viewer's token, never to clients directly (FR-136, NFR-20)", async () => {
    const secret = String((await h.admin("select push_secret from public.app_secrets where id = 1")).rows[0].push_secret);
    const token = (id: unknown, who: string) => createHmac("sha256", secret).update(`${id}:${who}`).digest("hex").slice(0, 32);
    const view = async (kind: string, id: unknown, who: string, t: string) =>
      (await h.admin("select public.siosia_calendar_view($1, $2, $3, $4) as v", [kind, id, who, t])).rows[0].v as Json | null;
    const a = await request(U.client, "siosia", 24 * 60, { note: "Kids back at 14:30" });
    await answer(U.siosia, a.id, "accept");
    const mine = await view("a", a.id, pub.client, token(a.id, pub.client));
    expect(mine).toMatchObject({ kind: "a", lang: "en", timezone: "Europe/Warsaw", reminderMin: [1440, 120], view: { id: a.id, role: "client", status: "accepted", note: "Kids back at 14:30" } });
    expect((await view("a", a.id, pub.siosia, token(a.id, pub.siosia)))?.view).toMatchObject({ role: "provider" });
    expect(await view("a", a.id, pub.siosia, token(a.id, pub.client))).toBeNull(); // someone else's token
    expect(await view("a", a.id, pub.other, token(a.id, pub.other))).toBeNull(); // a valid token, but not a party
    expect(await view("s", a.id, pub.client, token(a.id, pub.client))).toBeNull(); // not a series id
    // A series: its first occurrence with every date.
    const first = await request(U.client, "siosia", 2 * 24 * 60, { repeat: { every: 1, count: 3 } });
    const sid = String((first.series as Json).id);
    expect((await view("s", sid, pub.client, token(sid, pub.client)))?.view).toMatchObject({ series: { id: sid, count: 3, starts: expect.any(Array) } });
    // A booked ride, for its rider (and not before it is booked for a time).
    const r = await book(U.client, 3 * 60);
    expect((await view("r", r.id, pub.client, token(r.id, pub.client)))?.view).toMatchObject({ id: r.id, role: "rider" });
    expect(await view("r", r.id, pub.driver, token(r.id, pub.driver))).toBeNull();
    expect(await errorOf(h.as(U.client, "select public.siosia_calendar_view($1, $2, $3, $4)", ["a", a.id, pub.client, token(a.id, pub.client)]))).toMatch(/permission denied/);
  });

  it("keeps every v1 function signature next to the new ones (NFR-18)", async () => {
    const sigs = (await h.admin("select p.oid::regprocedure::text as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'siosia\\_%'")).rows.map((r) => String(r.s));
    for (const s of [
      "siosia_book_ride(jsonb,jsonb,double precision,double precision,boolean,timestamp with time zone)",
      "siosia_book_ride(jsonb,jsonb,double precision,double precision,boolean,timestamp with time zone,uuid,text)",
      "siosia_bookings()",
      "siosia_history()",
      "siosia_my_state()",
      "siosia_request_ride(jsonb,jsonb,double precision,double precision,boolean)"
    ])
      expect(sigs).toContain(s);
    const cfg = await h.as<Json>(U.stranger, "select public.siosia_config()");
    expect(cfg).toMatchObject({ booking: { maxOpen: 12 }, appointment: { reminderMin: [1440, 120], seriesMaxDays: 91, seriesMaxCount: 12 }, calendarUrl: null });
    expect((cfg.services as Json[]).map((e) => e.id)).toEqual(["ride", "learning", "childcare"]);
  });

  it("adds the 2.1 calls next to every 2.0 signature, callable by members only (NFR-18)", async () => {
    const sigs = (await h.admin("select p.oid::regprocedure::text as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'siosia\\_%'")).rows.map((r) => String(r.s));
    for (const s of [
      "siosia_request_service(text,text,timestamp with time zone,integer,jsonb,text,jsonb)",
      "siosia_answer_appointment(uuid,text)",
      "siosia_planned()",
      "siosia_save_vehicle(text,text,text,text,integer)",
      "siosia_take_request(uuid)",
      "siosia_set_car_colour(text,text)"
    ])
      expect(sigs).toContain(s);
    const can = async (role: string, fn: string) => (await h.admin("select has_function_privilege($1, $2, 'execute') as ok", [role, `public.${fn}`])).rows[0].ok;
    expect(await can("authenticated", "siosia_take_request(uuid)")).toBe(true);
    expect(await can("authenticated", "siosia_set_car_colour(text,text)")).toBe(true);
    expect(await can("anon", "siosia_take_request(uuid)")).toBe(false);
    for (const internal of ["siosia_answer_as(uuid,uuid,text)", "siosia_open_rows(uuid)", "siosia_open_requests(uuid)", "siosia_notify_members()"])
      expect(await can("authenticated", internal)).toBe(false);
    // A database from before 2.1 gets nullable providers and the paint column on the re-run.
    const cols = (await h.admin(
      "select table_name, column_name, is_nullable from information_schema.columns where table_schema = 'public' and ((table_name in ('appointments', 'appointment_series') and column_name = 'provider_id') or (table_name = 'vehicles' and column_name = 'paint')) order by 1"
    )).rows;
    expect(cols).toEqual([
      { table_name: "appointment_series", column_name: "provider_id", is_nullable: "YES" },
      { table_name: "appointments", column_name: "provider_id", is_nullable: "YES" },
      { table_name: "vehicles", column_name: "paint", is_nullable: "YES" }
    ]);
  });
});

describe("car colour (2.1: FR-170, V38)", () => {
  const colour = (uid: string, name: unknown, paint: unknown) => h.call<Json>(uid, "siosia_set_car_colour", [name, paint]);

  it("sets the colour name and paint, validated; a vehicle saved later keeps the paint", async () => {
    expect(await h.call<Json>(U.driver, "siosia_get_vehicle")).toMatchObject({ colour: "Blue", paint: null });
    expect(await colour(U.driver, "  Zielony ", "#2E7D32")).toEqual({ make: "Skoda", model: "Fabia", colour: "Zielony", plate: `WX ${U.driver.slice(-4)}`, seats: 4, paint: "#2e7d32" });
    for (const [name, paint] of [
      ["", "#2e7d32"],
      ["   ", "#2e7d32"],
      ["x".repeat(21), "#2e7d32"],
      [null, "#2e7d32"],
      ["Green", "green"],
      ["Green", "#2e7d3"],
      ["Green", "#2e7d321"],
      ["Green", "2e7d32"],
      ["Green", "#2e7d3g"],
      ["Green", "#2e7d32\n"],
      ["Green", null]
    ])
      expect(await errorOf(colour(U.driver, name, paint))).toBe("bad_vehicle");
    expect(await h.call<Json>(U.driver, "siosia_get_vehicle")).toMatchObject({ colour: "Zielony", paint: "#2e7d32" });
    expect(await h.call<Json>(U.driver, "siosia_save_vehicle", ["Skoda", "Fabia", "Green", `WX ${U.driver.slice(-4)}`, 4])).toMatchObject({ colour: "Green", paint: "#2e7d32" });
    // The table keeps the form, whatever is written behind the function.
    expect(await errorOf(h.admin("update public.vehicles set paint = '#2E7D32' where user_id = $1", [U.driver]))).toMatch(/vehicles_paint_check/);
  });

  it("needs a vehicle, and a rider profile has none", async () => {
    expect(await errorOf(colour(U.other, "Red", "#c62828"))).toBe("no_vehicle");
    const R = "00000000-0000-4000-8000-000000000110";
    await h.admin("insert into auth.users (id) values ($1) on conflict do nothing", [R]);
    await h.admin("select public.siosia_set_master('painter', 'painter-token-0123456789', 'Malarz', null, null, 'rider')");
    try {
      await h.call(R, "siosia_join_master", ["painter-token-0123456789", "dev-r", "en", false]);
      expect(await errorOf(colour(R, "Red", "#c62828"))).toBe("rider_only");
      expect(await errorOf(colour(U.stranger, "Red", "#c62828"))).toBe("not_member");
    } finally {
      await h.admin("update public.master_profiles set active = false where id = 'painter'");
    }
  });

  it("shows the paint to the rider of a booking the driver took (driver card, booking card)", async () => {
    await colour(U.driver, "Czerwony", "#C62828");
    const ride = await book(U.client, 3 * 60);
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    const card = (await h.call<Json[]>(U.client, "siosia_bookings")).find((r) => r.id === ride.id)!;
    expect(card.driver).toMatchObject({ nickname: "Roman", vehicle: { colour: "Czerwony", paint: "#c62828" } });
    expect((await h.call<Json>(U.client, "siosia_get_ride", [ride.id])).driver).toMatchObject({ vehicle: { paint: "#c62828" } });
    // Before a driver takes it, the rider sees no vehicle at all (FR-044).
    const other = await book(U.client, 5 * 60);
    expect((await h.call<Json>(U.client, "siosia_get_ride", [other.id])).driver).toBeNull();
  });

  it("carries the paint in every party — catalog providers, appointment and ride parties — and nothing else of the car", async () => {
    await colour(U.driver, "Czerwony", "#C62828");
    await h.call(U.driver, "siosia_set_offers", [["learning"]]);
    // A master driver: the icon of the master profile, the paint of the car this phone drives.
    const M = "00000000-0000-4000-8000-000000000111";
    await h.admin("insert into auth.users (id) values ($1) on conflict do nothing", [M]);
    await h.admin(
      "select public.siosia_set_master('wozak', 'wozak-token-0123456789', 'Wozak', 'taycan-ct-green', null, 'driver', null, null, $1::jsonb, array['learning'])",
      [JSON.stringify({ make: "Porsche", model: "Taycan", colour: "Green", plate: "WX 7777", seats: 4 })]
    );
    try {
      await h.call(M, "siosia_join_master", ["wozak-token-0123456789", "dev-wz", "pl", false]);
      await colour(M, "Zielony", "#2e7d32");
      const providers = (await h.call<Json[]>(U.client, "siosia_catalog")).find((e) => e.id === "learning")!.providers as Json[];
      expect(providers.find((p) => p.nickname === "Roman")).toEqual({ nickname: "Roman", rating: { mean: null, count: 0 }, icon: null, paint: "#c62828", publicId: pub.driver });
      expect(providers.find((p) => p.nickname === "Wozak")).toMatchObject({ icon: "taycan-ct-green", paint: "#2e7d32" });
      expect(providers.find((p) => p.nickname === "Siosia")).toMatchObject({ paint: null }); // no car
      // Appointment parties, for either party and for a candidate; nothing of the car but its paint.
      const a = await request(U.client, "driver", 24 * 60, { service: "learning", duration: 60 });
      expect(a).toMatchObject({ provider: { nickname: "Roman", paint: "#c62828" }, client: { nickname: "Toria", paint: null } });
      expect(Object.keys(a.provider as Json).sort()).toEqual(["icon", "nickname", "paint", "publicId", "rating"]);
      expect(await getAppt(U.driver, a.id)).toMatchObject({ role: "provider", provider: { paint: "#c62828" } });
      const open = await request(U.driver, null, 30 * 60);
      const theirs = await h.call<Json>(U.other, "siosia_planned");
      expect(theirs.open).toEqual([expect.objectContaining({ id: open.id, client: expect.objectContaining({ nickname: "Roman", paint: "#c62828" }) })]);
      expect(JSON.stringify(theirs)).not.toMatch(/Skoda|Fabia|WX |"seats"|Czerwony/);
      // Ride parties: rider and driver (the driver's vehicle as well, for the rider of a taken booking).
      const ride = await book(U.client, 3 * 60);
      await h.call(U.driver, "siosia_claim_booking", [ride.id]);
      const view = await h.call<Json>(U.client, "siosia_get_ride", [ride.id]);
      expect(view.driver).toMatchObject({ nickname: "Roman", paint: "#c62828", vehicle: { paint: "#c62828" } });
      expect(view.rider).toMatchObject({ nickname: "Toria", paint: null });
      expect((await h.call<Json>(U.driver, "siosia_get_ride", [ride.id])).rider).toMatchObject({ nickname: "Toria", paint: null });
    } finally {
      await h.call(U.driver, "siosia_set_offers", [[]]);
      await h.admin("update public.master_profiles set active = false where id = 'wozak'");
      await h.admin("update public.profiles set deleted = true where user_id = $1", [M]);
    }
  });
});
