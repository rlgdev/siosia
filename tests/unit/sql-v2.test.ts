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

/** Sends a request from `uid` to `provider` (a key of U) starting `startMin` minutes from now. */
function request(uid: string, provider: string, startMin: number, o: { service?: string; duration?: number; place?: unknown; note?: string; repeat?: unknown; startsAt?: number } = {}) {
  return h.call<Json>(uid, "siosia_request_service", [
    o.service ?? "childcare",
    pub[provider],
    o.startsAt !== undefined ? new Date(o.startsAt).toISOString() : at(startMin),
    o.duration ?? 180,
    o.place === undefined ? HOME : o.place,
    o.note ?? "",
    o.repeat ?? null
  ]);
}
const answer = (uid: string, id: unknown, d: "accept" | "decline") => h.call<Json>(uid, "siosia_answer_appointment", [id, d]);
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
});
