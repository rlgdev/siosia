// @vitest-environment node
// Siosia 2.0 backend rules against the REAL SQL migration in PGlite: the service catalog,
// appointments (single and series), rides as part of a service, reminders, the calendar token;
// 2.3: kids, kid ratings, photos, chat. Same cases as the engine tests
// (tests/unit/appointments.test.ts) — the twin rule (V19).

import { createHmac, randomUUID } from "node:crypto";
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
 * starting `startMin` minutes from now. With `kids` (2.3) the 8-argument call attaches them.
 */
function request(
  uid: string,
  provider: string | null,
  startMin: number,
  o: { service?: string; duration?: number; place?: unknown; note?: string; repeat?: unknown; startsAt?: number; kids?: unknown } = {}
) {
  const args: unknown[] = [
    o.service ?? "childcare",
    provider === null ? null : pub[provider],
    o.startsAt !== undefined ? new Date(o.startsAt).toISOString() : at(startMin),
    o.duration ?? 180,
    o.place === undefined ? HOME : o.place,
    o.note ?? "",
    o.repeat ?? null
  ];
  if (o.kids !== undefined) args.push(o.kids);
  return h.call<Json>(uid, "siosia_request_service", args);
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
  await h.db.exec(
    "delete from public.ratings; delete from public.rides; delete from public.appointments; delete from public.appointment_series; delete from public.push_outbox;" +
      // 2.3: kids (their attachments and ratings follow), messages, photos
      "delete from public.kids; delete from public.messages; update public.profiles set photo_path = null;"
  );
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
      expect(providers.find((p) => p.nickname === "Roman")).toEqual({ nickname: "Roman", rating: { mean: null, count: 0 }, icon: null, paint: "#c62828", publicId: pub.driver, contractRate: null });
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

describe("kids, kid ratings, photos, chat (2.3: FR-200–225, V44–V48)", () => {
  const ZOSIA = { name: "Zosia", bornYear: 2016, note: "Nut allergy" };
  const KUBA = { name: "Kuba", bornYear: null, note: "" };
  const addKid = (uid: string, input: unknown) => h.call<Json>(uid, "siosia_add_kid", [input]);
  const kidsOf = (uid: string) => h.call<Json[]>(uid, "siosia_kids");
  const setKids = (uid: string, id: unknown, kids: unknown) => h.call<Json>(uid, "siosia_set_appointment_kids", [id, kids]);
  const rateKid = (uid: string, id: unknown, kid: unknown, stars: number, comment = "") => h.call(uid, "siosia_rate_kid", [id, kid, stars, comment]);
  const setPhoto = (uid: string, kind: string, kid: unknown, path: unknown) => h.call<string | null>(uid, "siosia_set_photo", [kind, kid, path]);
  const chat = (uid: string, room: string, mark = false) => h.call<Json>(uid, "siosia_chat", [room, mark]);
  const send = (uid: string, room: string, text: string) => h.call<Json>(uid, "siosia_send_message", [room, text]);
  /**
   * Object folders are keyed by the owner's PUBLIC id (V49: a signed URL carries the path, and no
   * auth uid may reach a viewer); a user without a profile gets a folder key nobody has.
   */
  const pidOf: Record<string, string> = {};
  const folder = (uid: string) => pidOf[uid] ?? "nobody-nobody";
  const learnPid = async (uid: string) => {
    pidOf[uid] = String((await h.call<Json>(uid, "siosia_get_profile")).publicId);
  };
  beforeAll(() => {
    for (const k of ["client", "siosia", "driver", "other", "gone"] as const) pidOf[U[k]] = pub[k];
  });
  const prof = (uid: string) => `profile/${folder(uid)}/${randomUUID()}.jpg`;
  const kidPath = (uid: string, kid: unknown) => `kid/${folder(uid)}/${kid}/${randomUUID()}.jpg`;
  const changed = async () => (await h.admin("select topic from realtime.messages where event = 'changed'")).rows.map((r) => String(r.topic));
  const pushes = async () =>
    (await h.admin("select kind, user_id, ride_id, appointment_id, params from public.push_outbox order by id")).rows as {
      kind: string;
      user_id: string;
      ride_id: string | null;
      appointment_id: string | null;
      params: Json;
    }[];
  /** Empties the notification queue and the realtime log. */
  const quiet = () => h.db.exec("delete from public.push_outbox; delete from realtime.messages;");
  /** Toria asks for a ride now; Roman (online, at her place) takes the card: an accepted ride. */
  async function liveRide(): Promise<string> {
    await h.call(U.driver, "siosia_set_online", [true]);
    const ride = await h.call<Json>(U.client, "siosia_request_ride", [HOME, SCHOOL, 3, 8, false]);
    const st = await h.call<Json>(U.driver, "siosia_heartbeat", [HOME.lat, HOME.lng]);
    expect(await h.call(U.driver, "siosia_decide_offer", [(st.offer as Json).id, "accept"])).toBe("won");
    return String(ride.id);
  }

  it("keeps kids as the owner's rows: validated, at most 8, read and changed by the owner only (K1)", async () => {
    const year = new Date().getUTCFullYear();
    for (const bad of [
      { name: "", bornYear: null, note: "" },
      { name: "   ", bornYear: null, note: "" },
      { name: "x".repeat(31), bornYear: null, note: "" },
      { name: "Zosia", bornYear: 1899, note: "" },
      { name: "Zosia", bornYear: year + 1, note: "" },
      { name: "Zosia", bornYear: 2015.5, note: "" },
      { name: "Zosia", bornYear: "2015", note: "" },
      { name: "Zosia", bornYear: null, note: "x".repeat(201) },
      { bornYear: 2015, note: "" },
      null,
      JSON.stringify("Zosia")
    ])
      expect(await errorOf(addKid(U.client, bad))).toBe("bad_input");
    const z = await addKid(U.client, { name: "  Zosia ", bornYear: 2016, note: " Nut allergy " });
    expect(z).toEqual({ id: expect.any(String), name: "Zosia", photo: null, bornYear: 2016, note: "Nut allergy", rating: { mean: null, count: 0 }, ratings: [], ownerNickname: "Toria", mine: true });
    const k = await addKid(U.client, KUBA);
    expect(k).toMatchObject({ name: "Kuba", bornYear: null, note: "" });
    for (let i = 0; i < 6; i++) await addKid(U.client, { name: `Kid ${i}`, bornYear: year, note: "" });
    expect(await errorOf(addKid(U.client, { name: "Ninth", bornYear: null, note: "" }))).toBe("too_many");
    expect((await kidsOf(U.client)).map((x) => x.name)).toEqual(["Zosia", "Kuba", "Kid 0", "Kid 1", "Kid 2", "Kid 3", "Kid 4", "Kid 5"]);
    expect(await kidsOf(U.other)).toEqual([]);
    // Only the owner changes or removes a kid; a stranger has none.
    expect(await errorOf(h.call(U.other, "siosia_update_kid", [z.id, KUBA]))).toBe("not_found");
    expect(await errorOf(h.call(U.other, "siosia_remove_kid", [z.id]))).toBe("not_found");
    expect(await errorOf(h.call(U.client, "siosia_update_kid", [z.id, { name: "", bornYear: null, note: "" }]))).toBe("bad_input");
    expect(await h.call<Json>(U.client, "siosia_update_kid", [z.id, { name: "Zofia", bornYear: 2017, note: "" }])).toMatchObject({ id: z.id, name: "Zofia", bornYear: 2017, note: "" });
    expect(await errorOf(addKid(U.stranger, KUBA))).toBe("not_member");
    expect(await errorOf(h.as(U.client, "select count(*) from public.kids"))).toMatch(/permission denied/);
    // Removing gives the photo's path back (none here); the table keeps its own rules.
    expect(await h.call(U.client, "siosia_remove_kid", [k.id])).toBeNull();
    expect((await kidsOf(U.client)).some((x) => x.id === k.id)).toBe(false);
    expect(await errorOf(h.admin("insert into public.kids (owner_id, name) values ($1, '')", [U.client]))).toMatch(/kids_name_check/);
    expect(await errorOf(h.admin("insert into public.kids (owner_id, name, born_year) values ($1, 'X', 1800)", [U.client]))).toMatch(/kids_born_year_check/);
  });

  it("lets only the client attach their own kids, until the appointment ends; a series request attaches them to every occurrence (K2)", async () => {
    const z = await addKid(U.client, ZOSIA);
    const kb = await addKid(U.client, KUBA);
    const ola = await addKid(U.other, { name: "Ola", bornYear: null, note: "" });
    const a = await request(U.client, "siosia", 24 * 60);
    expect(a).toMatchObject({ kids: [], kidCount: 0 });
    expect(await errorOf(setKids(U.siosia, a.id, [z.id]))).toBe("forbidden");
    expect(await errorOf(setKids(U.other, a.id, [ola.id]))).toBe("forbidden");
    expect(await errorOf(setKids(U.client, "00000000-0000-4000-8000-00000000dead", [z.id]))).toBe("not_found");
    expect(await errorOf(setKids(U.client, a.id, [z.id, ola.id]))).toBe("bad_input");
    expect(await errorOf(setKids(U.client, a.id, ["00000000-0000-4000-8000-00000000dead"]))).toBe("bad_input");
    expect(await errorOf(setKids(U.client, a.id, [z.id, null]))).toBe("bad_input");
    expect(await errorOf(setKids(U.client, a.id, null))).toBe("bad_input"); // not a list (the engine's rule — C13)
    const v = await setKids(U.client, a.id, [z.id, kb.id, z.id]);
    expect(v.kidCount).toBe(2);
    expect((v.kids as Json[]).map((k) => k.name)).toEqual(["Zosia", "Kuba"]);
    expect((await setKids(U.client, a.id, [kb.id])).kids).toEqual([expect.objectContaining({ id: kb.id })]);
    // Still the client's call once accepted, even under way; not once it ended.
    await answer(U.siosia, a.id, "accept");
    await shift(a.id, -10);
    expect((await setKids(U.client, a.id, [z.id])).kidCount).toBe(1);
    await shift(a.id, -181);
    expect(await errorOf(setKids(U.client, a.id, []))).toBe("illegal_transition");
    expect(await getAppt(U.client, a.id)).toMatchObject({ status: "done", kidCount: 1 });
    const c = await request(U.client, "siosia", 48 * 60);
    await cancel(U.client, c.id);
    expect(await errorOf(setKids(U.client, c.id, [z.id]))).toBe("illegal_transition");
    // A request with kids: someone else's kid refuses it; a series carries them on every date.
    expect(await errorOf(request(U.client, "siosia", 72 * 60, { service: "learning", duration: 60, kids: [ola.id] }))).toBe("bad_input");
    const s = await request(U.client, "siosia", 72 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 }, kids: [z.id, kb.id] });
    expect(s).toMatchObject({ kidCount: 2, kids: [expect.objectContaining({ id: z.id }), expect.objectContaining({ id: kb.id })] });
    const perDate = await h.admin(
      "select a.seq, count(ak.kid_id)::int as n from public.appointments a left join public.appointment_kids ak on ak.appointment_id = a.id where a.series_id = $1 group by a.seq order by a.seq",
      [(s.series as Json).id]
    );
    expect(perDate.rows).toEqual([{ seq: 1, n: 2 }, { seq: 2, n: 2 }, { seq: 3, n: 2 }]);
    // The 2.0 call (cached apps) still works, with no kids; an empty list is the same.
    const plain = await h.call<Json>(U.client, "siosia_request_service", ["childcare", pub.siosia, at(26 * 60), 180, HOME, "", null]);
    expect(plain).toMatchObject({ status: "requested", kids: [], kidCount: 0 });
    expect(await request(U.client, "siosia", 27 * 60, { kids: [] })).toMatchObject({ kids: [], kidCount: 0 });
  });

  it("shows the kids to the two parties, only a count to a candidate, nothing to drivers; the provider's notifications name them (K3)", async () => {
    const z = await addKid(U.client, ZOSIA);
    const kb = await addKid(U.client, KUBA);
    const year = new Date().getUTCFullYear();
    await quiet();
    // An open request: candidates see "2 kids" and no names; their notification names none either.
    const open = await request(U.client, null, 30 * 60, { kids: [z.id, kb.id] });
    const cand = await getAppt(U.other, open.id);
    expect(cand).toMatchObject({ role: "candidate", kids: [], kidCount: 2 });
    expect(JSON.stringify(cand)).not.toMatch(/Zosia|Kuba|allergy/);
    const opens = await pushes();
    expect(opens.length).toBeGreaterThan(0);
    expect(opens.every((o) => o.kind === "appt_open" && !("kids" in o.params))).toBe(true);
    // Addressed: both parties get the cards (name, photo, age, note, summary); the provider's push names them.
    await quiet();
    const a = await request(U.client, "siosia", 25 * 60, { kids: [z.id, kb.id] });
    const theirs = await getAppt(U.siosia, a.id);
    expect(theirs.kids).toEqual([
      { id: z.id, name: "Zosia", photo: null, age: year - 2016, note: "Nut allergy", rating: { mean: null, count: 0 }, myRating: null },
      { id: kb.id, name: "Kuba", photo: null, age: null, note: "", rating: { mean: null, count: 0 }, myRating: null }
    ]);
    expect(theirs.kidCount).toBe(2);
    expect(JSON.stringify(theirs)).not.toContain(U.client);
    expect((await getAppt(U.client, a.id)).kids).toEqual(theirs.kids);
    expect(await pushes()).toEqual([expect.objectContaining({ kind: "appt_new", user_id: U.siosia, params: expect.objectContaining({ kids: ["Zosia", "Kuba"] }) })]);
    // The provider's reminder names them, the client's does not; the client's accept text neither.
    await quiet();
    await answer(U.siosia, a.id, "accept");
    expect((await pushes()).map((o) => [o.kind, "kids" in o.params])).toEqual([["appt_accepted", false]]);
    await quiet();
    await shift(a.id, 24 * 60 - 1, -3 * 24 * 60);
    await sweep();
    const rem = (await pushes()).filter((o) => o.kind === "appt_reminder");
    expect(rem.find((o) => o.user_id === U.siosia)!.params).toMatchObject({ kids: ["Zosia", "Kuba"] });
    expect(rem.find((o) => o.user_id === U.client)!.params).not.toHaveProperty("kids");
    // The driver of an attached ride sees a plain booking: no kid anywhere.
    const ride = await book(U.client, 23 * 60, a.id, "there");
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    const driverView = await h.call<Json>(U.driver, "siosia_get_ride", [ride.id]);
    expect(JSON.stringify(driverView)).not.toMatch(/Zosia|Kuba|kid/i);
    expect(JSON.stringify(await h.call<Json[]>(U.driver, "siosia_bookings"))).not.toMatch(/Zosia|Kuba/);
  });

  it("lets the provider rate each attached kid once within 24 h of a done appointment; the owner reads it; nobody's own rating moves (K4)", async () => {
    const z = await addKid(U.client, ZOSIA);
    const kb = await addKid(U.client, KUBA);
    const stray = await addKid(U.client, { name: "Ala", bornYear: null, note: "" });
    const a = await request(U.client, "siosia", 24 * 60, { kids: [z.id, kb.id] });
    expect(await errorOf(rateKid(U.other, a.id, z.id, 5))).toBe("not_found"); // no party
    expect(await errorOf(rateKid(U.client, a.id, z.id, 5))).toBe("forbidden"); // the client
    expect(await errorOf(rateKid(U.siosia, a.id, stray.id, 5))).toBe("not_found"); // not attached
    expect(await errorOf(rateKid(U.siosia, a.id, z.id, 5))).toBe("illegal_transition"); // requested
    await answer(U.siosia, a.id, "accept");
    expect(await errorOf(rateKid(U.siosia, a.id, z.id, 5))).toBe("illegal_transition"); // not done yet
    await shift(a.id, -200);
    expect(await getAppt(U.siosia, a.id)).toMatchObject({ status: "done" });
    expect(await errorOf(rateKid(U.siosia, a.id, z.id, 0))).toBe("bad_input");
    expect(await errorOf(rateKid(U.siosia, a.id, z.id, 6))).toBe("bad_input");
    const before = (await h.call<Json>(U.client, "siosia_get_profile")).rating;
    await rateKid(U.siosia, a.id, z.id, 5, " Lovely " + "x".repeat(200));
    expect(await errorOf(rateKid(U.siosia, a.id, z.id, 4))).toBe("already_rated");
    await rateKid(U.siosia, a.id, kb.id, 4);
    // The cards: the summary for both parties, the viewer's own rating for the provider.
    expect((await getAppt(U.siosia, a.id)).kids).toEqual([
      expect.objectContaining({ id: z.id, rating: { mean: 5, count: 1 }, myRating: 5 }),
      expect.objectContaining({ id: kb.id, rating: { mean: 4, count: 1 }, myRating: 4 })
    ]);
    expect((await getAppt(U.client, a.id)).kids).toEqual([
      expect.objectContaining({ id: z.id, rating: { mean: 5, count: 1 }, myRating: null }),
      expect.objectContaining({ id: kb.id, rating: { mean: 4, count: 1 }, myRating: null })
    ]);
    // The owner reads every rating: who, when, stars, comment (kept to 140).
    const mine = (await kidsOf(U.client)).find((k) => k.id === z.id)!;
    expect(mine.rating).toEqual({ mean: 5, count: 1 });
    expect(mine.ratings).toEqual([{ appointmentId: a.id, by: "Siosia", stars: 5, comment: ("Lovely " + "x".repeat(200)).slice(0, 140), at: expect.any(Number) }]);
    // Neither party's own rating (FR-060) is touched.
    expect((await h.call<Json>(U.client, "siosia_get_profile")).rating).toEqual(before);
    expect((await h.admin("select count(*)::int as n from public.ratings")).rows[0].n).toBe(0);
    // A later appointment with Zosia: the provider sees the summary so far; the mean covers both.
    const b = await request(U.client, "siosia", 48 * 60, { kids: [z.id] });
    expect((await getAppt(U.siosia, b.id)).kids).toEqual([expect.objectContaining({ id: z.id, rating: { mean: 5, count: 1 }, myRating: null })]);
    await answer(U.siosia, b.id, "accept");
    await shift(b.id, -200);
    await rateKid(U.siosia, b.id, z.id, 2);
    const again = (await kidsOf(U.client)).find((k) => k.id === z.id)!;
    expect(again.rating).toEqual({ mean: 3.5, count: 2 });
    expect((again.ratings as Json[]).map((g) => g.stars)).toEqual([2, 5]);
    // The window closes 24 h after the end.
    const c = await request(U.client, "siosia", 72 * 60, { kids: [kb.id] });
    await answer(U.siosia, c.id, "accept");
    await shift(c.id, -200);
    await sweep(); // done, with its end recorded
    await h.admin("update public.appointments set ended_at = now() - interval '25 hours' where id = $1", [c.id]);
    expect(await errorOf(rateKid(U.siosia, c.id, kb.id, 5))).toBe("window_closed");
    // The table: one rating per appointment and kid, stars 1–5.
    expect(await errorOf(h.admin("insert into public.kid_ratings (appointment_id, kid_id, from_user, stars) values ($1, $2, $3, 3)", [a.id, z.id, U.siosia]))).toMatch(/kid_ratings_pkey/);
    expect(await errorOf(h.admin("insert into public.kid_ratings (appointment_id, kid_id, from_user, stars) values ($1, $2, $3, 7)", [c.id, kb.id, U.siosia]))).toMatch(/kid_ratings_stars_check/);
  });

  it("stores photo paths, never URLs, and hands a path only to a viewer allowed to see it (K5)", async () => {
    expect(await errorOf(setPhoto(U.client, "profile", null, "https://x.supabase.co/storage/v1/object/photos/profile/a.jpg"))).toBe("bad_input");
    expect(await errorOf(setPhoto(U.client, "profile", null, prof(U.other)))).toBe("bad_input");
    expect(await errorOf(setPhoto(U.client, "profile", null, `profile/${U.client}/a.png`))).toBe("bad_input");
    expect(await errorOf(setPhoto(U.client, "profile", null, `profile/${U.client}/../x.jpg`))).toBe("bad_input");
    expect(await errorOf(setPhoto(U.client, "selfie", null, prof(U.client)))).toBe("bad_input");
    // A folder keyed by the auth uid (the first 2.3 builds) is refused: the uid would reach every viewer in the URL (V49).
    expect(await errorOf(setPhoto(U.client, "profile", null, `profile/${U.client}/${randomUUID()}.jpg`))).toBe("bad_input");
    const p1 = prof(U.client);
    expect(p1).toMatch(new RegExp(`^profile/${pub.client}/[0-9a-f-]{36}\\.jpg$`));
    expect(p1).not.toContain(U.client);
    expect(await setPhoto(U.client, "profile", null, p1)).toBeNull();
    expect((await h.admin("select photo_path from public.profiles where user_id = $1", [U.client])).rows[0].photo_path).toBe(p1);
    expect(await h.call<Json>(U.client, "siosia_get_profile")).toMatchObject({ photo: null, photoPath: p1 });
    // Replacing gives the old path back (the app removes that object); null clears.
    const p2 = prof(U.client);
    expect(await setPhoto(U.client, "profile", null, p2)).toBe(p1);
    expect(await setPhoto(U.client, "profile", null, null)).toBe(p2);
    expect(await h.call<Json>(U.client, "siosia_get_profile")).not.toHaveProperty("photoPath");
    await setPhoto(U.client, "profile", null, p2);
    // A kid's photo: my kid, under its own folder.
    const z = await addKid(U.client, ZOSIA);
    const ola = await addKid(U.other, { name: "Ola", bornYear: null, note: "" });
    expect(await errorOf(setPhoto(U.client, "kid", ola.id, kidPath(U.client, ola.id)))).toBe("not_found");
    expect(await errorOf(setPhoto(U.client, "kid", z.id, kidPath(U.client, ola.id)))).toBe("bad_input");
    expect(await errorOf(setPhoto(U.client, "kid", z.id, kidPath(U.other, z.id)))).toBe("bad_input");
    expect(await errorOf(setPhoto(U.client, "kid", z.id, prof(U.client)))).toBe("bad_input");
    const kp = kidPath(U.client, z.id);
    expect(await setPhoto(U.client, "kid", z.id, kp)).toBeNull();
    expect((await kidsOf(U.client))[0]).toMatchObject({ id: z.id, photo: null, photoPath: kp });
    const sp = prof(U.siosia);
    await setPhoto(U.siosia, "profile", null, sp);
    // The catalog shows a provider's photo to every member; nothing of the client's there.
    const cat = await h.call<Json[]>(U.other, "siosia_catalog");
    expect((cat.find((e) => e.id === "childcare")!.providers as Json[]).find((p) => p.nickname === "Siosia")).toMatchObject({ photoPath: sp });
    expect(JSON.stringify(cat)).not.toContain(p2);
    // An appointment: each party sees the other's photo and the attached kid's; a candidate sees none.
    const open = await request(U.client, null, 30 * 60, { kids: [z.id] });
    expect(JSON.stringify(await getAppt(U.other, open.id))).not.toMatch(/photoPath/);
    expect(JSON.stringify((await h.call<Json>(U.other, "siosia_planned")).open)).not.toMatch(/photoPath/);
    const a = await request(U.client, "siosia", 25 * 60, { kids: [z.id] });
    const theirs = await getAppt(U.siosia, a.id);
    expect(theirs.client).toMatchObject({ nickname: "Toria", photoPath: p2 });
    expect(theirs.kids).toEqual([expect.objectContaining({ id: z.id, photo: null, photoPath: kp })]);
    expect((await getAppt(U.client, a.id)).provider).toMatchObject({ nickname: "Siosia", photoPath: sp });
    expect(JSON.stringify(theirs)).not.toMatch(/https?:/);
    // A ride: the driver sees the rider's photo once they took the booking, not while browsing.
    const ride = await book(U.client, 3 * 60);
    const browsing = await h.call<Json[]>(U.driver, "siosia_open_bookings", [HOME.lat, HOME.lng]);
    expect(JSON.stringify(browsing.find((b) => (b.ride as Json).id === ride.id))).not.toMatch(/photoPath/);
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    expect((await h.call<Json>(U.driver, "siosia_get_ride", [ride.id])).rider).toMatchObject({ nickname: "Toria", photoPath: p2 });
    expect((await h.call<Json>(U.client, "siosia_get_ride", [ride.id])).driver).toMatchObject({ nickname: "Roman", vehicle: expect.any(Object) });
    expect((await h.call<Json>(U.client, "siosia_get_ride", [ride.id])).driver).not.toHaveProperty("photoPath"); // Roman has none
    // Chat partners see each other's photo.
    expect((await chat(U.driver, `ride:${ride.id}`)).other).toMatchObject({ nickname: "Toria", photoPath: p2 });
    // Removing the kid gives its photo's path back.
    expect(await h.call(U.client, "siosia_remove_kid", [z.id])).toBe(kp);
    expect(await h.call<string[]>(U.client, "siosia_my_photo_paths")).toEqual([p2]);
  });

  it("decides who may read (sign) or write a photo object the way the views do — the Storage policies (K5)", async () => {
    const can = async (path: string, viewer: string) => (await h.admin("select public.siosia_can_see_photo($1, $2) as ok", [path, viewer])).rows[0].ok;
    const up = async (path: string, uid: string) => (await h.admin("select public.siosia_photo_upload_ok($1, $2) as ok", [path, uid])).rows[0].ok;
    const z = await addKid(U.client, ZOSIA);
    const p = prof(U.client);
    const kp = kidPath(U.client, z.id);
    await setPhoto(U.client, "profile", null, p);
    await setPhoto(U.client, "kid", z.id, kp);
    // Writes: a member, under their own folders, their own kid.
    expect(await up(p, U.client)).toBe(true);
    expect(await up(kp, U.client)).toBe(true);
    expect(await up(p, U.other)).toBe(false);
    expect(await up(kidPath(U.other, z.id), U.other)).toBe(false);
    expect(await up(prof(U.stranger), U.stranger)).toBe(false);
    expect(await up(`profile/${pub.client}/x.png`, U.client)).toBe(false);
    expect(await up(`profile/${U.client}/${randomUUID()}.jpg`, U.client)).toBe(false); // never a uid-keyed folder (V49)
    // Reads: the owner; nobody else without a relation; never a stranger or an odd path.
    expect(await can(p, U.client)).toBe(true);
    expect(await can(kp, U.client)).toBe(true);
    expect(await can(p, U.other)).toBe(false);
    expect(await can(kp, U.other)).toBe(false);
    expect(await can(p, U.stranger)).toBe(false);
    expect(await can("https://x/y.jpg", U.client)).toBe(false);
    // What the policies call: the 1-argument forms answer for the CALLER only; the 2-argument rules
    // are the server's — a member cannot ask about anyone else's photos through them (C9).
    expect(await h.as(U.client, "select public.siosia_can_see_photo($1)", [p])).toBe(true);
    expect(await h.as(U.other, "select public.siosia_can_see_photo($1)", [p])).toBe(false);
    expect(await h.as(U.client, "select public.siosia_photo_upload_ok($1)", [kp])).toBe(true);
    expect(await h.as(U.other, "select public.siosia_photo_upload_ok($1)", [kp])).toBe(false);
    expect(await errorOf(h.as(U.other, "select public.siosia_can_see_photo($1, $2)", [p, U.client]))).toMatch(/permission denied/);
    expect(await errorOf(h.as(U.other, "select public.siosia_photo_upload_ok($1, $2)", [p, U.client]))).toMatch(/permission denied/);
    // A provider in the catalog: any member. A candidate of an open request: not yet; its taker: yes, the kid too.
    const sp = prof(U.siosia);
    await setPhoto(U.siosia, "profile", null, sp);
    expect(await can(sp, U.other)).toBe(true);
    const open = await request(U.client, null, 30 * 60, { kids: [z.id] });
    expect(await can(p, U.other)).toBe(false);
    expect(await can(kp, U.other)).toBe(false);
    await take(U.other, open.id);
    expect(await can(p, U.other)).toBe(true);
    expect(await can(kp, U.other)).toBe(true);
    expect(await can(kp, U.siosia)).toBe(false); // not the provider of that kid's appointment
    // A ride shared as rider and driver.
    expect(await can(p, U.driver)).toBe(false);
    const ride = await book(U.client, 3 * 60);
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    expect(await can(p, U.driver)).toBe(true);
    expect(await can(kp, U.driver)).toBe(false);
    // Only the CURRENT photo is readable by others: a replaced one is dead at once (its owner may still remove it).
    const p2 = prof(U.client);
    await setPhoto(U.client, "profile", null, p2);
    expect(await can(p, U.other)).toBe(false);
    expect(await can(p2, U.other)).toBe(true);
    expect(await can(p, U.client)).toBe(true);
  });

  it("opens a room with the ride's driver or on acceptance, for its two parties only: oldest first, read marks, unread counts (K6)", async () => {
    const ride = await book(U.client, 3 * 60);
    const rr = `ride:${ride.id}`;
    expect(await errorOf(chat(U.client, rr))).toBe("not_found"); // no driver yet
    expect(await errorOf(send(U.client, rr, "Hi"))).toBe("not_found");
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    expect(await chat(U.client, rr)).toEqual({ room: rr, other: expect.objectContaining({ nickname: "Roman" }), messages: [], open: true, unread: 0 });
    expect(await errorOf(chat(U.other, rr))).toBe("not_found");
    expect(await errorOf(chat(U.client, "ride:not-a-uuid"))).toBe("not_found");
    expect(await errorOf(chat(U.client, `room:${ride.id}`))).toBe("not_found");
    // The room is spelled as the rows name it (lower case): another spelling is no room — not_found,
    // as in the engine, never a check violation on the insert (C14).
    expect(await errorOf(chat(U.client, rr.toUpperCase()))).toBe("not_found");
    expect(await errorOf(send(U.client, `ride:${String(ride.id).toUpperCase()}`, "Hi"))).toBe("not_found");
    expect(await errorOf(send(U.client, rr, "   "))).toBe("bad_input");
    expect(await errorOf(send(U.client, rr, "x".repeat(501)))).toBe("bad_input");
    const m1 = await send(U.client, rr, "  I will wait at the gate  ");
    expect(m1).toEqual({ id: expect.any(String), room: rr, mine: true, text: "I will wait at the gate", sentAt: expect.any(Number), readAt: null });
    const m2 = await send(U.driver, rr, "On my way");
    // Both see the thread oldest first; `mine` follows the viewer; unread counts the other's.
    const mine = await chat(U.client, rr);
    expect((mine.messages as Json[]).map((m) => [m.text, m.mine])).toEqual([["I will wait at the gate", true], ["On my way", false]]);
    expect(mine.unread).toBe(1);
    expect((await chat(U.driver, rr)).unread).toBe(1);
    expect((await h.call<Json>(U.client, "siosia_get_ride", [ride.id])).unread).toBe(1);
    expect((await h.call<Json[]>(U.driver, "siosia_bookings"))[0]).toMatchObject({ id: ride.id, unread: 1 });
    expect(await h.call<Json>(U.client, "siosia_my_state")).toMatchObject({ unreadChats: 1 });
    // Reading marks the other's messages; they see the mark on theirs (FR-224).
    await quiet();
    const read = await chat(U.client, rr, true);
    expect(read.unread).toBe(0);
    expect((read.messages as Json[]).map((m) => m.readAt === null)).toEqual([true, false]);
    expect((await chat(U.driver, rr)).messages).toEqual([expect.objectContaining({ id: m1.id, mine: false, readAt: null }), expect.objectContaining({ id: m2.id, mine: true, readAt: expect.any(Number) })]);
    // The sender refetches for the marks, the reader for the badge on their other tabs (C11, as the engine).
    expect(await changed()).toEqual(expect.arrayContaining([`user:${U.driver}`, `user:${U.client}`]));
    expect(await h.call<Json>(U.client, "siosia_my_state")).toMatchObject({ unreadChats: 0 });
    // An appointment's room opens on acceptance; a third member never reads it.
    const a = await request(U.client, "siosia", 24 * 60);
    const ar = `appt:${a.id}`;
    expect(await errorOf(chat(U.client, ar))).toBe("not_found");
    expect(await errorOf(send(U.siosia, ar, "Hello"))).toBe("not_found");
    await answer(U.siosia, a.id, "accept");
    await send(U.siosia, ar, "Hello");
    expect(await errorOf(chat(U.other, ar))).toBe("not_found");
    expect(await getAppt(U.client, a.id)).toMatchObject({ unread: 1 });
    expect(await getAppt(U.siosia, a.id)).toMatchObject({ unread: 0 });
    expect((await h.call<Json>(U.client, "siosia_planned")).appointments).toEqual([expect.objectContaining({ id: a.id, unread: 1 })]);
    expect(await h.call<Json>(U.client, "siosia_my_state")).toMatchObject({ unreadChats: 1 });
    // A declined request never had a room; nobody reads the table directly.
    const d = await request(U.other, "siosia", 26 * 60);
    await answer(U.siosia, d.id, "decline");
    expect(await errorOf(chat(U.other, `appt:${d.id}`))).toBe("not_found");
    expect(await errorOf(h.as(U.client, "select count(*) from public.messages"))).toMatch(/permission denied/);
    expect(await errorOf(h.admin("insert into public.messages (room, ride_id, sender, text) values ($1, $2, $3, 'x')", ["appt:" + ride.id, ride.id, U.client]))).toMatch(/messages_check|messages_room_check/);
  });

  it("keeps a thread writable while live and 24 h after the end, then read-only; 30 a sender per 10 minutes; a re-dispatched driver loses the room (K6)", async () => {
    const ride = await book(U.client, 3 * 60);
    const rr = `ride:${ride.id}`;
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    for (let i = 0; i < 30; i++) await send(U.client, rr, `m${i}`);
    expect(await errorOf(send(U.client, rr, "one more"))).toBe("too_many");
    expect(await send(U.driver, rr, "fine for me")).toMatchObject({ mine: true }); // per sender
    await h.admin("update public.messages set sent_at = sent_at - interval '11 minutes' where room = $1 and sender = $2", [rr, U.client]);
    expect(await send(U.client, rr, "again")).toMatchObject({ text: "again" });
    // After the end: a day for questions, then read-only (still readable).
    await h.admin("update public.rides set status = 'completed', ended_at = now() - interval '23 hours' where id = $1", [ride.id]);
    expect(await chat(U.client, rr)).toMatchObject({ open: true });
    await send(U.client, rr, "Did I leave a scarf?");
    await h.admin("update public.rides set ended_at = now() - interval '25 hours' where id = $1", [ride.id]);
    expect(await chat(U.client, rr)).toMatchObject({ open: false });
    expect(await errorOf(send(U.client, rr, "Hello?"))).toBe("illegal_transition");
    expect((await chat(U.driver, rr)).messages).toHaveLength(33);
    // An appointment cancelled after acceptance, or done, keeps its room a day.
    const a = await request(U.client, "siosia", 24 * 60);
    await answer(U.siosia, a.id, "accept");
    await send(U.client, `appt:${a.id}`, "See you");
    await cancel(U.siosia, a.id);
    expect(await chat(U.client, `appt:${a.id}`)).toMatchObject({ open: true, messages: [expect.objectContaining({ text: "See you" })] });
    await h.admin("update public.appointments set ended_at = now() - interval '25 hours' where id = $1", [a.id]);
    expect(await errorOf(send(U.client, `appt:${a.id}`, "Hello?"))).toBe("illegal_transition");
    const b = await request(U.client, "siosia", 48 * 60);
    await answer(U.siosia, b.id, "accept");
    await shift(b.id, -200);
    expect(await chat(U.siosia, `appt:${b.id}`)).toMatchObject({ open: true });
    await h.admin("update public.appointments set ended_at = now() - interval '25 hours' where id = $1", [b.id]);
    expect(await errorOf(send(U.siosia, `appt:${b.id}`, "x"))).toBe("illegal_transition");
    // A live ride's room follows the CURRENT driver (FR-223): none while it looks for one again.
    const live = await liveRide();
    const lr = `ride:${live}`;
    await send(U.client, lr, "Where are you?");
    await h.call(U.driver, "siosia_cancel_ride", [live, "vehicle_problem"]);
    expect(await errorOf(chat(U.driver, lr))).toBe("not_found");
    expect(await errorOf(chat(U.client, lr))).toBe("not_found");
    const D2 = "00000000-0000-4000-8000-000000000112";
    await h.admin("insert into auth.users (id) values ($1) on conflict do nothing", [D2]);
    await h.onboard(D2, "Danka", true);
    await h.call(D2, "siosia_set_online", [true]);
    const st = await h.call<Json>(D2, "siosia_heartbeat", [HOME.lat, HOME.lng]);
    expect(await h.call(D2, "siosia_decide_offer", [(st.offer as Json).id, "accept"])).toBe("won");
    // A fresh thread for the new driver: the first driver's words never reach her, and the rider's
    // thread with her starts empty too (the engine's resetRoom; V47 "parties only").
    expect(await chat(D2, lr)).toMatchObject({ other: expect.objectContaining({ nickname: "Toria" }), open: true, messages: [], unread: 0 });
    expect(await send(D2, lr, "Danka here, five minutes")).toMatchObject({ mine: true });
    const afterSwap = await chat(U.client, lr);
    expect(afterSwap.other).toMatchObject({ nickname: "Danka" });
    expect((afterSwap.messages as Json[]).map((m) => m.text)).toEqual(["Danka here, five minutes"]);
    expect(await errorOf(chat(U.driver, lr))).toBe("not_found");
    expect(await errorOf(send(U.driver, lr, "I am back"))).toBe("not_found");
    await h.call(U.driver, "siosia_set_online", [false]);
  });

  it("tells the other party live and once by notification, tagged with the ride or appointment — never a driver at the wheel (K7)", async () => {
    const live = await liveRide();
    const lr = `ride:${live}`;
    await quiet();
    const long = "I am at the gate, " + "x".repeat(482); // 500: the whole text is queued; push-text cuts it to the first words (C21)
    await send(U.client, lr, long);
    expect(await changed()).toEqual(expect.arrayContaining([`user:${U.driver}`, `user:${U.client}`]));
    expect(await pushes()).toEqual([
      { kind: "chat_message", user_id: U.driver, ride_id: live, appointment_id: null, params: { sender: "Toria", text: long, room: lr, messageId: expect.any(String) } }
    ]);
    // The id is the message's: dispatch skips a message read before it goes out (V48).
    expect((await pushes())[0].params.messageId).toBe(String((await h.admin("select id from public.messages where room = $1 and text = $2", [lr, long])).rows[0].id));
    expect(long).toHaveLength(500);
    await quiet();
    await send(U.driver, lr, "Coming");
    expect((await pushes()).map((o) => `${o.kind}>${o.user_id === U.client ? "client" : "x"}`)).toEqual(["chat_message>client"]);
    // Under way: the driver is not notified; the message waits in the thread, which still refreshes live.
    await h.call(U.driver, "siosia_advance", [live, "arrived", null]);
    await h.call(U.driver, "siosia_advance", [live, "in_progress", null]);
    await quiet();
    await send(U.client, lr, "Please take the long way");
    expect(await pushes()).toEqual([]);
    expect(await changed()).toContain(`user:${U.driver}`);
    expect((await chat(U.driver, lr)).unread).toBe(2);
    // ... in any room of theirs: an appointment's message waits too, and comes through once the ride is over.
    await h.call(U.driver, "siosia_set_offers", [["learning"]]);
    try {
      const a = await request(U.client, "driver", 24 * 60, { service: "learning", duration: 60 });
      await answer(U.driver, a.id, "accept");
      await quiet();
      await send(U.client, `appt:${a.id}`, "Tomorrow then");
      expect(await pushes()).toEqual([]);
      await h.call(U.driver, "siosia_advance", [live, "completed", 3]);
      await quiet();
      await send(U.client, `appt:${a.id}`, "Bring the book");
      expect(await pushes()).toEqual([
        { kind: "chat_message", user_id: U.driver, ride_id: null, appointment_id: a.id, params: { sender: "Toria", text: "Bring the book", room: `appt:${a.id}`, messageId: expect.any(String) } }
      ]);
      // Only people who turned notifications on hear (v1 rule).
      await h.call(U.driver, "siosia_delete_push", ["https://web.push.apple.com/driver"]);
      await quiet();
      await send(U.client, `appt:${a.id}`, "Still there?");
      expect(await pushes()).toEqual([]);
      expect(await changed()).toContain(`user:${U.driver}`);
    } finally {
      await h.call(U.driver, "siosia_save_push", ["https://web.push.apple.com/driver", "p".repeat(40), "a".repeat(16)]);
      await h.call(U.driver, "siosia_set_offers", [[]]);
      await h.call(U.driver, "siosia_set_online", [false]);
    }
  });

  it("takes the messages, attachments and kid ratings along with their ride, appointment or kid; retention and a deleted profile cover them (K8)", async () => {
    const z = await addKid(U.client, ZOSIA);
    const kb = await addKid(U.client, KUBA);
    const ride = await book(U.client, 3 * 60);
    await h.call(U.driver, "siosia_claim_booking", [ride.id]);
    await send(U.client, `ride:${ride.id}`, "Hi");
    const a = await request(U.client, "siosia", 24 * 60, { kids: [z.id, kb.id] });
    await answer(U.siosia, a.id, "accept");
    await send(U.siosia, `appt:${a.id}`, "Hello");
    await shift(a.id, -200);
    await sweep();
    await rateKid(U.siosia, a.id, z.id, 5);
    await rateKid(U.siosia, a.id, kb.id, 4);
    const counts = async () =>
      (
        await h.admin(
          "select (select count(*) from public.messages)::int as m, (select count(*) from public.appointment_kids)::int as ak, (select count(*) from public.kid_ratings)::int as kr, (select count(*) from public.kids)::int as k"
        )
      ).rows[0];
    expect(await counts()).toEqual({ m: 2, ak: 2, kr: 2, k: 2 });
    // A removed kid takes its ratings and attachments; the appointment and its thread stay.
    await h.call(U.client, "siosia_remove_kid", [kb.id]);
    expect(await counts()).toEqual({ m: 2, ak: 1, kr: 1, k: 1 });
    expect((await getAppt(U.siosia, a.id)).kids).toEqual([expect.objectContaining({ id: z.id })]);
    // Retention: a 13-month-old ride goes with its messages, an appointment with its thread,
    // attachments and kid ratings; the kid itself stays (its summary empties).
    await h.admin("update public.rides set status = 'completed', ended_at = now() - interval '13 months' where id = $1", [ride.id]);
    await h.admin("update public.appointments set ended_at = now() - interval '13 months' where id = $1", [a.id]);
    await h.admin("select public.siosia_retention()");
    expect(await counts()).toEqual({ m: 0, ak: 0, kr: 0, k: 1 });
    expect((await kidsOf(U.client))[0]).toMatchObject({ id: z.id, rating: { mean: null, count: 0 }, ratings: [] });
    // Deleting a profile deletes its kids (with their attachments and ratings) and clears the photo paths.
    const Z = "00000000-0000-4000-8000-000000000113";
    await h.admin("insert into auth.users (id) values ($1) on conflict do nothing", [Z]);
    await h.onboard(Z, "Zofia");
    await learnPid(Z);
    const zk = await addKid(Z, ZOSIA);
    await setPhoto(Z, "kid", zk.id, kidPath(Z, zk.id));
    await setPhoto(Z, "profile", null, prof(Z));
    expect(await h.call<string[]>(Z, "siosia_my_photo_paths")).toHaveLength(2);
    const req = await request(Z, "siosia", 24 * 60, { kids: [zk.id] });
    expect((await getAppt(U.siosia, req.id)).kidCount).toBe(1);
    await h.call(Z, "siosia_delete_profile");
    expect((await h.admin("select count(*)::int as n from public.kids where owner_id = $1", [Z])).rows[0].n).toBe(0);
    expect((await h.admin("select count(*)::int as n from public.appointment_kids ak join public.appointments a on a.id = ak.appointment_id where a.client_id = $1", [Z])).rows[0].n).toBe(0);
    expect((await h.admin("select photo_path from public.profiles where user_id = $1", [Z])).rows[0].photo_path).toBeNull();
  });

  it("does not notify someone who has the thread open: presence stamped on reading, good for 45 s, per room (FR-222, V48, C10)", async () => {
    const a = await request(U.client, "siosia", 24 * 60);
    await answer(U.siosia, a.id, "accept");
    const ar = `appt:${a.id}`;
    const presence = async () => (await h.admin("select room from public.chat_presence where user_id = $1 order by room", [U.siosia])).rows.map((r) => String(r.room));
    // Reading without marking (a background refetch) says nothing about where Siosia looks.
    await chat(U.siosia, ar);
    expect(await presence()).toEqual([]);
    // She opens the thread: marked present; what Toria writes lands live, no notification.
    await chat(U.siosia, ar, true);
    expect(await presence()).toEqual([ar]);
    await quiet();
    await send(U.client, ar, "Hello");
    expect(await pushes()).toEqual([]);
    expect(await changed()).toEqual(expect.arrayContaining([`user:${U.siosia}`, `user:${U.client}`]));
    expect((await chat(U.siosia, ar)).unread).toBe(1);
    // 45 s without the heartbeat: she looked away — notified again.
    await h.admin("update public.chat_presence set seen_at = now() - interval '46 seconds' where user_id = $1", [U.siosia]);
    await quiet();
    await send(U.client, ar, "Still there?");
    expect((await pushes()).map((o) => [o.kind, o.user_id, o.params.text])).toEqual([["chat_message", U.siosia, "Still there?"]]);
    // The heartbeat (another mark, nothing new to mark) refreshes the stamp.
    await chat(U.siosia, ar, true);
    await quiet();
    await send(U.client, ar, "Good");
    expect(await pushes()).toEqual([]);
    // Another room is another thread: there she is absent.
    const b = await request(U.client, "siosia", 48 * 60);
    await answer(U.siosia, b.id, "accept");
    await quiet();
    await send(U.client, `appt:${b.id}`, "About Thursday");
    expect((await pushes()).map((o) => [o.kind, o.user_id])).toEqual([["chat_message", U.siosia]]);
    expect(await presence()).toEqual([ar]);
    // The stamp is per user: Toria's own tabs never make Siosia present.
    await h.admin("update public.chat_presence set seen_at = now() - interval '46 seconds' where user_id = $1", [U.siosia]);
    await chat(U.client, ar, true);
    await quiet();
    await send(U.client, ar, "One more");
    expect((await pushes()).map((o) => o.user_id)).toEqual([U.siosia]);
    expect(await errorOf(h.as(U.client, "select count(*) from public.chat_presence"))).toMatch(/permission denied/);
  });

  it("moves kids, kid ratings, messages, presence and photos with the account to a new phone; deleting the profile removes them all, cards included (V49, C0/C1, C4/C5)", async () => {
    // A stand-in for Storage's object table: the server-side drops find it (to_regclass) and delete from it.
    await h.admin("create schema if not exists storage");
    await h.admin("create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null)");
    const objects = async () => (await h.admin("select name from storage.objects where bucket_id = 'photos' order by name")).rows.map((r) => String(r.name));
    const upload = (path: string) => h.admin("insert into storage.objects (bucket_id, name) values ('photos', $1)", [path]);
    const can = async (path: string, viewer: string) => (await h.admin("select public.siosia_can_see_photo($1, $2) as ok", [path, viewer])).rows[0].ok;
    const up = async (path: string, uid: string) => (await h.admin("select public.siosia_photo_upload_ok($1, $2) as ok", [path, uid])).rows[0].ok;
    const MOVER = "00000000-0000-4000-8000-000000000121";
    const PHONE = "00000000-0000-4000-8000-000000000122";
    for (const id of [MOVER, PHONE]) await h.admin("insert into auth.users (id) values ($1) on conflict do nothing", [id]);
    await h.onboard(MOVER, "Marta");
    await learnPid(MOVER);
    await h.call(MOVER, "siosia_set_offers", [["learning"]]);
    // Marta in the browser: a kid with a photo, her own photo, an appointment with the kid and a
    // thread she read, a kid of Toria's she rated as a provider, another appointment ahead.
    const kid = await addKid(MOVER, { name: "Olek", bornYear: 2019, note: "Asks a lot" });
    const kp = kidPath(MOVER, kid.id);
    const pp = prof(MOVER);
    await upload(kp);
    await upload(pp);
    await setPhoto(MOVER, "kid", kid.id, kp);
    await setPhoto(MOVER, "profile", null, pp);
    const a = await request(MOVER, "siosia", 24 * 60, { kids: [kid.id] });
    await answer(U.siosia, a.id, "accept");
    const ar = `appt:${a.id}`;
    await send(MOVER, ar, "Olek is shy at first");
    await send(U.siosia, ar, "No worries");
    await chat(MOVER, ar, true);
    const z = await addKid(U.client, ZOSIA);
    const b = await h.call<Json>(U.client, "siosia_request_service", ["learning", pidOf[MOVER], at(25 * 60), 60, HOME, "", null, [z.id]]);
    await answer(MOVER, b.id, "accept");
    await shift(b.id, -200);
    await sweep();
    await rateKid(MOVER, b.id, z.id, 4, "Bright");
    const c = await request(MOVER, "siosia", 48 * 60, { kids: [kid.id] });
    await answer(U.siosia, c.id, "accept");
    expect(await objects()).toEqual([kp, pp].sort());
    // The move to the app on her phone.
    const { code } = await h.call<Json>(MOVER, "siosia_create_transfer");
    const p = await h.call<Json>(PHONE, "siosia_redeem_transfer", [code, "dev-phone", false]);
    expect(p).toMatchObject({ userId: PHONE, nickname: "Marta", publicId: pidOf[MOVER], photoPath: pp });
    pidOf[PHONE] = String(p.publicId); // the public id — the folder key — moved with the profile
    // The new phone has it all: the kid and its photo, the ratings, the thread with `mine` right, the presence.
    expect(await h.call<Json[]>(PHONE, "siosia_kids")).toEqual([expect.objectContaining({ id: kid.id, name: "Olek", photoPath: kp })]);
    expect((await h.call<string[]>(PHONE, "siosia_my_photo_paths")).sort()).toEqual([kp, pp].sort());
    const thread = await chat(PHONE, ar);
    expect((thread.messages as Json[]).map((m) => [m.text, m.mine])).toEqual([
      ["Olek is shy at first", true],
      ["No worries", false]
    ]);
    expect(thread.other).toMatchObject({ nickname: "Siosia" });
    expect(((await chat(U.siosia, ar)).messages as Json[]).map((m) => m.mine)).toEqual([false, true]);
    expect((await h.admin("select count(*)::int as n from public.messages where sender = $1", [MOVER])).rows[0].n).toBe(0);
    expect((await h.admin("select from_user from public.kid_ratings where kid_id = $1", [z.id])).rows).toEqual([{ from_user: PHONE }]);
    expect((await kidsOf(U.client)).find((k) => k.id === z.id)!.ratings).toEqual([expect.objectContaining({ by: "Marta", stars: 4, comment: "Bright" })]);
    expect((await h.admin("select user_id from public.chat_presence where room = $1", [ar])).rows).toEqual([{ user_id: PHONE }]);
    expect((await getAppt(U.siosia, c.id)).kids).toEqual([expect.objectContaining({ id: kid.id, name: "Olek", photoPath: kp })]);
    expect(await errorOf(h.call(MOVER, "siosia_kids"))).toBe("not_member");
    // The photos: the phone reads, signs and writes them; the provider still sees both; the old account is nobody.
    expect(await can(pp, PHONE)).toBe(true);
    expect(await can(kp, PHONE)).toBe(true);
    expect(await up(pp, PHONE)).toBe(true);
    expect(await up(kp, PHONE)).toBe(true);
    expect(await h.as(PHONE, "select public.siosia_can_see_photo($1)", [kp])).toBe(true);
    expect(await can(pp, U.siosia)).toBe(true);
    expect(await can(kp, U.siosia)).toBe(true);
    expect(await can(pp, MOVER)).toBe(false);
    expect(await up(pp, MOVER)).toBe(false);
    // Replacing from the phone: a new object under the (moved) folder; the old path comes back,
    // dead to others at once, still the owner's to remove.
    const pp2 = prof(PHONE);
    expect(pp2).toContain(`profile/${pidOf[MOVER]}/`);
    await upload(pp2);
    expect(await setPhoto(PHONE, "profile", null, pp2)).toBe(pp);
    expect(await can(pp, U.siosia)).toBe(false);
    expect(await can(pp2, U.siosia)).toBe(true);
    expect(await up(pp, PHONE)).toBe(true);
    await h.admin("delete from storage.objects where name = $1", [pp]);
    // Removing a kid drops its object here, not only in the app (C4/C5).
    const k2 = await addKid(PHONE, { name: "Ida", bornYear: null, note: "" });
    const k2p = kidPath(PHONE, k2.id);
    await upload(k2p);
    await setPhoto(PHONE, "kid", k2.id, k2p);
    expect(await objects()).toContain(k2p);
    expect(await h.call(PHONE, "siosia_remove_kid", [k2.id])).toBe(k2p);
    expect(await objects()).not.toContain(k2p);
    // Deleting the profile: the kids with their attachments and ratings, the messages sent, the
    // presence, the photo paths and objects — gone; the kid's card is gone from Siosia's history.
    await shift(c.id, 365 * 24 * 60); // the newest item of her history
    const orphan = prof(PHONE); // an upload the app never set on the row: swept with the folder
    await upload(orphan);
    await h.call(PHONE, "siosia_delete_profile");
    expect(await objects()).not.toContain(orphan);
    const left = (
      await h.admin(
        `select (select count(*) from public.kids where owner_id = $1)::int as kids,
                (select count(*) from public.appointment_kids ak join public.appointments x on x.id = ak.appointment_id where x.client_id = $1)::int as attached,
                (select count(*) from public.kid_ratings where kid_id = $2)::int as kid_ratings,
                (select count(*) from public.messages where sender = $1)::int as messages,
                (select count(*) from public.chat_presence where user_id = $1)::int as presence,
                (select photo_path from public.profiles where user_id = $1) as photo`,
        [PHONE, kid.id]
      )
    ).rows[0];
    expect(left).toEqual({ kids: 0, attached: 0, kid_ratings: 0, messages: 0, presence: 0, photo: null });
    expect((await objects()).filter((n) => n === pp2 || n === kp)).toEqual([]);
    const history = await h.call<Json[]>(U.siosia, "siosia_timeline");
    expect(history[0]).toMatchObject({ kind: "appointment", appointment: { id: c.id, status: "cancelled", cancelReason: "user_gone", kids: [], kidCount: 0 } });
    expect((history[0].appointment as Json).client).toMatchObject({ nickname: "Deleted user" });
    expect((history[0].appointment as Json).client).not.toHaveProperty("photoPath");
    expect(await getAppt(U.siosia, a.id)).toMatchObject({ status: "cancelled", kids: [], kidCount: 0 });
    // Siosia keeps her own words; the rating Marta gave stays with Zosia as a deleted user's.
    expect(((await chat(U.siosia, ar)).messages as Json[]).map((m) => [m.text, m.mine])).toEqual([["No worries", true]]);
    expect((await kidsOf(U.client)).find((k) => k.id === z.id)!.ratings).toEqual([expect.objectContaining({ by: "Deleted user", stars: 4 })]);
  });

  it("a replaced profile's kids go with it, photos included; the mover's kids and presence come over, as the engine does (V49, FR-200, C0/C1)", async () => {
    await h.admin("create schema if not exists storage");
    await h.admin("create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null)");
    const objects = async () => (await h.admin("select name from storage.objects where bucket_id = 'photos' order by name")).rows.map((r) => String(r.name));
    const upload = (path: string) => h.admin("insert into storage.objects (bucket_id, name) values ('photos', $1)", [path]);
    const OLD = "00000000-0000-4000-8000-000000000123";
    const APP = "00000000-0000-4000-8000-000000000124";
    for (const id of [OLD, APP]) await h.admin("insert into auth.users (id) values ($1) on conflict do nothing", [id]);
    await h.onboard(OLD, "Hanna");
    await h.onboard(APP, "Tester");
    await learnPid(OLD);
    await learnPid(APP);
    // The app already has a profile with a photo and a kid; the browser's account has a kid with a photo.
    const appPhoto = prof(APP);
    await upload(appPhoto);
    await setPhoto(APP, "profile", null, appPhoto);
    const appKid = await addKid(APP, { name: "Max", bornYear: null, note: "" });
    const appKp = kidPath(APP, appKid.id);
    await upload(appKp);
    await setPhoto(APP, "kid", appKid.id, appKp);
    const oldKid = await addKid(OLD, { name: "Lena", bornYear: 2020, note: "" });
    const oldKp = kidPath(OLD, oldKid.id);
    await upload(oldKp);
    await setPhoto(OLD, "kid", oldKid.id, oldKp);
    const oldPhoto = prof(OLD);
    await upload(oldPhoto);
    await setPhoto(OLD, "profile", null, oldPhoto);
    // Both parties of one room, both present in it: the newer stamp stays.
    const a = await request(OLD, "siosia", 24 * 60);
    await answer(U.siosia, a.id, "accept");
    await chat(OLD, `appt:${a.id}`, true);
    // Ewa takes Tester's open request with Max attached: her only link to the replaced profile.
    const b = await request(APP, null, 48 * 60, { kids: [appKid.id] });
    await take(U.other, b.id);
    await chat(APP, `appt:${b.id}`, true);
    const { code } = await h.call<Json>(OLD, "siosia_create_transfer");
    await h.admin("delete from realtime.messages");
    expect(await errorOf(h.call(APP, "siosia_redeem_transfer", [code, "dev-app", false]))).toBe("has_profile");
    const p = await h.call<Json>(APP, "siosia_redeem_transfer", [code, "dev-app", true]);
    expect(p).toMatchObject({ userId: APP, nickname: "Hanna", publicId: pidOf[OLD], photoPath: oldPhoto });
    const deadFolder = pidOf[APP];
    pidOf[APP] = pidOf[OLD];
    // Hanna's photo and kid came with her rows; Tester's profile is a deleted one (FR-200): his
    // objects are gone and so is Max, photo included.
    expect(await objects()).toEqual([oldKp, oldPhoto].sort());
    expect((await h.call<Json[]>(APP, "siosia_kids")).map((k) => [k.name, k.photoPath ?? null])).toEqual([["Lena", oldKp]]);
    expect((await h.admin("select count(*)::int as n from public.kids where id = $1", [appKid.id])).rows[0].n).toBe(0);
    // Ewa expected Max on b: she is told live (as the engine's deleteKid does), and b now lists no kid.
    expect(await changed()).toEqual(expect.arrayContaining([`user:${U.other}`]));
    expect((await h.call<Json>(U.other, "siosia_get_appointment", [b.id])).kids).toEqual([]);
    expect((await h.admin("select room from public.chat_presence where user_id = $1 order by room", [APP])).rows.map((r) => r.room).sort()).toEqual([`appt:${a.id}`, `appt:${b.id}`].sort());
    expect((await h.admin("select count(*)::int as n from public.chat_presence where user_id = $1", [OLD])).rows[0].n).toBe(0);
    const can = async (path: string, viewer: string) => (await h.admin("select public.siosia_can_see_photo($1, $2) as ok", [path, viewer])).rows[0].ok;
    const up = async (path: string, uid: string) => (await h.admin("select public.siosia_photo_upload_ok($1, $2) as ok", [path, uid])).rows[0].ok;
    expect(await can(oldKp, APP)).toBe(true);
    expect(await up(`kid/${pidOf[OLD]}/${oldKid.id}/${randomUUID()}.jpg`, APP)).toBe(true); // uploads go under the moved folder
    expect(await up(`kid/${deadFolder}/${oldKid.id}/${randomUUID()}.jpg`, APP)).toBe(false); // never under the dead one
    expect(await can(oldKp, U.siosia)).toBe(false); // Lena is on no appointment of Siosia's
    expect(await can(oldPhoto, U.siosia)).toBe(true); // Hanna is her client (a's client moved to APP)
    // Replacing a photo: an old object under my folder is left to the app (it removes it, as before);
    // one under a folder that is nobody's any more — beyond the app's delete policy — the server drops.
    const lena2 = kidPath(APP, oldKid.id);
    await upload(lena2);
    expect(await setPhoto(APP, "kid", oldKid.id, lena2)).toBe(oldKp);
    expect(await objects()).toEqual([lena2, oldKp, oldPhoto].sort());
    const stray = `kid/${deadFolder}/${oldKid.id}/${randomUUID()}.jpg`;
    await upload(stray);
    await h.admin("update public.kids set photo_path = $1 where id = $2", [stray, oldKid.id]);
    expect(await can(stray, APP)).toBe(true); // row-based: still hers to see
    const lena3 = kidPath(APP, oldKid.id);
    await upload(lena3);
    expect(await setPhoto(APP, "kid", oldKid.id, lena3)).toBe(stray);
    expect(await objects()).toEqual([lena2, lena3, oldKp, oldPhoto].sort()); // stray is gone, the rest untouched
  });

  it("adds the 2.3 calls next to every earlier signature, for members only, and the checks the Storage policies use (NFR-18)", async () => {
    const sigs = (await h.admin("select p.oid::regprocedure::text as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'siosia\\_%'")).rows.map((r) => String(r.s));
    const api = [
      "siosia_request_service(text,text,timestamp with time zone,integer,jsonb,text,jsonb,uuid[])",
      "siosia_kids()",
      "siosia_add_kid(jsonb)",
      "siosia_update_kid(uuid,jsonb)",
      "siosia_remove_kid(uuid)",
      "siosia_set_appointment_kids(uuid,uuid[])",
      "siosia_rate_kid(uuid,uuid,integer,text)",
      "siosia_set_photo(text,uuid,text)",
      "siosia_my_photo_paths()",
      "siosia_chat(text,boolean)",
      "siosia_send_message(text,text)",
      // the Storage policies' checks: about the caller only (1 argument — C9)
      "siosia_can_see_photo(text)",
      "siosia_photo_upload_ok(text)"
    ];
    for (const s of [...api, "siosia_request_service(text,text,timestamp with time zone,integer,jsonb,text,jsonb)", "siosia_public_party(uuid)", "siosia_public_party(uuid,boolean)", "siosia_can_see_photo(text,uuid)", "siosia_photo_upload_ok(text,uuid)", "siosia_drop_photo_object(text)"])
      expect(sigs).toContain(s);
    const can = async (role: string, fn: string) => (await h.admin("select has_function_privilege($1, $2, 'execute') as ok", [role, `public.${fn}`])).rows[0].ok;
    for (const f of api) {
      expect(await can("authenticated", f)).toBe(true);
      expect(await can("anon", f)).toBe(false);
    }
    for (const internal of [
      "siosia_room(text)",
      "siosia_push_chat(uuid,uuid,uuid,jsonb)",
      "siosia_own_kids(uuid,uuid[])",
      "siosia_drop_photo_objects(uuid)",
      "siosia_drop_photo_object(text)",
      "siosia_can_see_person(uuid,uuid)",
      "siosia_attached_kids_json(uuid,uuid)",
      // the 2-argument rules would be an oracle on anyone's photos (C9)
      "siosia_can_see_photo(text,uuid)",
      "siosia_photo_upload_ok(text,uuid)",
      "siosia_photo_owner(text)"
    ])
      expect(await can("authenticated", internal)).toBe(false);
    // A database from before 2.3 gets the tables and the photo column on the re-run (the harness ran it twice).
    const tables = (await h.admin("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('kids', 'appointment_kids', 'kid_ratings', 'messages', 'chat_presence') order by 1")).rows;
    expect(tables.map((r) => r.table_name)).toEqual(["appointment_kids", "chat_presence", "kid_ratings", "kids", "messages"]);
    expect((await h.admin("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'photo_path'")).rows).toHaveLength(1);
    for (const t of ["kids", "appointment_kids", "kid_ratings", "messages", "chat_presence"]) {
      expect(await errorOf(h.as(U.client, `select count(*) from public.${t}`))).toMatch(/permission denied/);
      expect((await h.admin("select relrowsecurity as on from pg_class where oid = $1::regclass", [`public.${t}`])).rows[0]).toEqual({ on: true });
    }
    expect(await errorOf(h.call(U.stranger, "siosia_kids"))).toBe("not_member");
    expect(await errorOf(h.call(U.stranger, "siosia_chat", ["ride:00000000-0000-4000-8000-00000000dead", false]))).toBe("not_member");
  });
});

describe("session updates and heading home (2.5: FR-230–242, V54–V56)", () => {
  const feed = (uid: string, id: unknown, seen = false) => h.call<Json>(uid, "siosia_updates", [id, seen]);
  const post = (uid: string, id: unknown, text: string | null, kid: unknown = null, photo: string | null = null) => h.call<Json>(uid, "siosia_post_update", [id, text, kid, photo]);
  const del = (uid: string, id: unknown) => h.call<string | null>(uid, "siosia_delete_update", [id]);
  const coming = (uid: string, id: unknown, min: number | null) => h.call<Json>(uid, "siosia_coming_home", [id, min]);
  const addKid = (uid: string, name: string) => h.call<Json>(uid, "siosia_add_kid", [{ name, bornYear: null, note: "" }]);
  const changed = async () => (await h.admin("select topic from realtime.messages where event = 'changed'")).rows.map((r) => String(r.topic));
  const pushes = async () =>
    (await h.admin("select kind, user_id, appointment_id, params from public.push_outbox order by id")).rows as { kind: string; user_id: string; appointment_id: string | null; params: Record<string, unknown> }[];
  const quiet = () => h.db.exec("delete from public.push_outbox; delete from realtime.messages;");
  const pidOf = async (uid: string) => String((await h.call<Json>(uid, "siosia_get_profile")).publicId);
  const objects = async () => (await h.admin("select name from storage.objects where bucket_id = 'photos' order by name")).rows.map((r) => String(r.name));
  const upload = (path: string) => h.admin("insert into storage.objects (bucket_id, name) values ('photos', $1)", [path]);
  const can = async (path: string, viewer: string) => (await h.admin("select public.siosia_can_see_photo($1, $2) as ok", [path, viewer])).rows[0].ok;
  const up = async (path: string, uid: string) => (await h.admin("select public.siosia_photo_upload_ok($1, $2) as ok", [path, uid])).rows[0].ok;
  /** Moves the start so that the session ends `endMin` minutes from now (negative = already over; a sweep's ended_at moves with it). */
  const endIn = (id: unknown, endMin: number) =>
    h.admin(
      "update public.appointments set starts_at = now() + make_interval(mins => $2) - make_interval(mins => duration_min), ended_at = case when ended_at is null then null else now() + make_interval(mins => $2) end where id = $1",
      [id, endMin]
    );
  const items = async (uid: string, id: unknown) => (await feed(uid, id)).items as Json[];

  beforeAll(async () => {
    await h.admin("create schema if not exists storage");
    await h.admin("create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null)");
  });
  beforeEach(async () => {
    await h.db.exec("delete from public.appointments; delete from public.kids; delete from public.push_outbox; delete from realtime.messages; delete from storage.objects; delete from public.chat_presence;");
  });

  /** An accepted childcare with Zosia attached, `startMin` minutes ahead (asked for with the 30-min lead, then moved). */
  async function session(startMin = 60) {
    const z = await addKid(U.client, "Zosia");
    const a = await request(U.client, "siosia", Math.max(startMin, 31), { kids: [z.id] });
    await answer(U.siosia, a.id, "accept");
    if (startMin < 31) await shift(a.id, startMin);
    await quiet();
    return { a, z };
  }

  it("opens the feed 30 min before the start, to the two parties only, and keeps it 7 days after the end (FR-230, FR-234, V54)", async () => {
    const { a } = await session(60);
    expect(await getAppt(U.client, a.id)).toMatchObject({ updateCount: 0, feedOpen: false, coming: null });
    expect(await feed(U.client, a.id)).toEqual({ appointmentId: a.id, open: false, items: [] });
    expect(await errorOf(post(U.client, a.id, "Hi"))).toBe("illegal_transition");
    await shift(a.id, 29);
    expect((await feed(U.siosia, a.id)).open).toBe(true);
    expect((await getAppt(U.siosia, a.id)).feedOpen).toBe(true);
    expect(await errorOf(feed(U.driver, a.id))).toBe("not_found");
    expect(await errorOf(post(U.other, a.id, "Hi"))).toBe("not_found");
    expect(await errorOf(feed(U.stranger, a.id))).toBe("not_member");
    expect(await errorOf(feed(U.client, "00000000-0000-4000-8000-00000000dead"))).toBe("not_found");
    // Clients read nothing from the table directly, either (RLS: a party only; never a stranger).
    expect(await errorOf(h.as(U.other, "select count(*) from public.appointment_updates"))).toMatch(/permission denied/);
    // An open request has no feed; a candidate learns nothing of it.
    const o = await request(U.client, null, 60);
    expect(await errorOf(feed(U.client, o.id))).toBe("not_found");
    expect(await getAppt(U.other, o.id)).toMatchObject({ role: "candidate", updateCount: 0, feedOpen: false, coming: null });
    // Open once done, until 7 days after the end.
    await endIn(a.id, -(7 * 24 * 60 - 1));
    expect((await feed(U.client, a.id)).open).toBe(true);
    expect((await getAppt(U.client, a.id)).status).toBe("done");
    await endIn(a.id, -(7 * 24 * 60 + 1));
    expect((await feed(U.client, a.id)).open).toBe(false);
    expect((await getAppt(U.client, a.id)).feedOpen).toBe(false);
    expect(await errorOf(post(U.siosia, a.id, "Late"))).toBe("illegal_transition");
  });

  it("deletes only while the feed is open, like posting; a cancelled appointment shows no notice (FR-231, FR-242, V54, V56)", async () => {
    const { a } = await session(29);
    const u = await post(U.client, a.id, "Note");
    await endIn(a.id, -(7 * 24 * 60 + 1));
    expect(await errorOf(del(U.client, u.id))).toBe("illegal_transition");
    const { a: c } = await session(29);
    expect((await coming(U.client, c.id, 15)).coming).not.toBeNull();
    await h.admin("update public.appointments set starts_at = now() + interval '40 minutes' where id = $1", [c.id]); // not started: cancellable
    await cancel(U.client, c.id);
    expect(await getAppt(U.siosia, c.id)).toMatchObject({ status: "cancelled", coming: null });
    expect(await errorOf(coming(U.client, c.id, 5))).toBe("illegal_transition");
  });

  it("posts a text and/or a photo under my folder for this appointment, about everyone or one attached kid; one push; the Storage checks; the author deletes their own (FR-230–232, FR-234, V54, V55)", async () => {
    const { a, z } = await session(29);
    const k2 = await addKid(U.client, "Kuba"); // not attached
    const zs = await addKid(U.siosia, "Zuzia"); // someone else's
    const mine = `update/${await pidOf(U.siosia)}/${a.id}/${randomUUID()}.jpg`;
    const bad: [string | null, unknown, string | null][] = [
      ["", null, null],
      [null, null, null],
      ["   ", null, null],
      ["\n", null, null],
      ["\t \r\n", null, null],
      ["x".repeat(501), null, null],
      ["Hi", k2.id, null],
      ["Hi", zs.id, null],
      ["Hi", randomUUID(), null],
      ["Hi", null, `update/${await pidOf(U.client)}/${a.id}/${randomUUID()}.jpg`], // not my folder
      ["Hi", null, `update/${await pidOf(U.siosia)}/${randomUUID()}/${randomUUID()}.jpg`], // another appointment
      ["Hi", null, `profile/${await pidOf(U.siosia)}/${randomUUID()}.jpg`], // another shape
      ["Hi", null, `update/${U.siosia}/${a.id}/${randomUUID()}.jpg`] // never a uid-keyed folder (V49)
    ];
    for (const b of bad) expect(await errorOf(post(U.siosia, a.id, b[0], b[1], b[2])), JSON.stringify(b).slice(0, 70)).toBe("bad_input");
    expect(await post(U.siosia, a.id, "Hi\n\n")).toMatchObject({ text: "Hi" }); // keyboard whitespace trimmed, as the engine does
    await quiet();
    const u1 = await post(U.siosia, a.id, "  Zosia is drawing  ", z.id);
    expect(u1).toMatchObject({ appointmentId: a.id, author: { nickname: "Siosia" }, mine: true, kid: { id: z.id, name: "Zosia" }, text: "Zosia is drawing", photo: null });
    expect(u1).not.toHaveProperty("photoPath");
    expect(await changed()).toEqual(expect.arrayContaining([`user:${U.client}`, `user:${U.siosia}`]));
    expect(await pushes()).toEqual([
      expect.objectContaining({
        kind: "session_update",
        user_id: U.client,
        appointment_id: a.id,
        params: expect.objectContaining({ sender: "Siosia", text: "Zosia is drawing", kid: "Zosia", photo: false, updateId: u1.id, service: "Childcare", serviceId: "childcare", client: "Toria", provider: "Siosia" })
      })
    ]);
    await quiet();
    // A photo alone, under my folder for this appointment: the row holds the path; the parties
    // may read (sign) it, nobody else; the policies let the parties write under their own folder.
    await upload(mine);
    const u2 = await post(U.siosia, a.id, "", null, mine);
    expect(u2).toMatchObject({ kid: null, text: "", photoPath: mine });
    expect(await errorOf(post(U.siosia, a.id, "again", null, mine))).toBe("bad_input"); // one object, one update
    expect((await pushes())[0].params).toMatchObject({ text: "", photo: true, kid: null });
    expect(await can(mine, U.client)).toBe(true);
    expect(await can(mine, U.siosia)).toBe(true);
    expect(await can(mine, U.driver)).toBe(false);
    expect(await can(mine, U.other)).toBe(false);
    expect(await up(mine, U.siosia)).toBe(true);
    expect(await up(`update/${await pidOf(U.client)}/${a.id}/${randomUUID()}.jpg`, U.client)).toBe(true);
    expect(await up(`update/${await pidOf(U.client)}/${a.id}/${randomUUID()}.jpg`, U.other)).toBe(false);
    expect(await up(`update/${await pidOf(U.other)}/${a.id}/${randomUUID()}.jpg`, U.other)).toBe(false); // not a party
    expect(await up(`update/${await pidOf(U.siosia)}/${randomUUID()}/${randomUUID()}.jpg`, U.siosia)).toBe(false); // no such appointment
    // The parent's note: the same feed, pushed to the provider.
    await quiet();
    const u3 = await post(U.client, a.id, "Thanks! She loves it", z.id);
    expect((await pushes()).map((p) => [p.kind, p.user_id])).toEqual([["session_update", U.siosia]]);
    expect((await pushes())[0].params).toMatchObject({ sender: "Toria", kid: "Zosia", kids: ["Zosia"] }); // the provider's copy names the attached kids, as always
    const seen = await items(U.client, a.id);
    expect(seen.map((u) => [u.text, u.mine, (u.kid as Json | null)?.name ?? null])).toEqual([
      ["Hi", false, null],
      ["Zosia is drawing", false, "Zosia"],
      ["", false, null],
      ["Thanks! She loves it", true, "Zosia"]
    ]);
    expect(seen[2]).toMatchObject({ photoPath: mine });
    expect((await items(U.siosia, a.id)).map((u) => u.mine)).toEqual([true, true, true, false]);
    expect(await getAppt(U.siosia, a.id)).toMatchObject({ updateCount: 4, feedOpen: true });
    expect(await getAppt(U.client, a.id)).toMatchObject({ updateCount: 4 });
    // The author deletes their own: the object row goes server-side too; never the other's.
    expect(await errorOf(del(U.client, u2.id))).toBe("not_found");
    expect(await errorOf(del(U.siosia, randomUUID()))).toBe("not_found");
    await quiet();
    expect(await del(U.siosia, u2.id)).toBe(mine);
    expect(await changed()).toEqual(expect.arrayContaining([`user:${U.client}`, `user:${U.siosia}`]));
    expect(await objects()).toEqual([]);
    expect((await items(U.client, a.id)).map((u) => u.id).slice(1)).toEqual([u1.id, u3.id]);
    expect(await del(U.client, u3.id)).toBeNull();
  });

  it("keeps the kid's name when the kid is removed; no push to a party looking at the feed; 60 per hour; retention drops the photos (FR-231, FR-232, FR-235, V54, V55)", async () => {
    const { a, z } = await session(29);
    await post(U.siosia, a.id, "Playing", z.id);
    await h.call(U.client, "siosia_remove_kid", [z.id]);
    expect((await items(U.siosia, a.id))[0].kid).toEqual({ id: null, name: "Zosia" });
    // The parent has the feed in front (seen within 45 s): no push for what they are looking at.
    await quiet();
    await feed(U.client, a.id, true);
    await post(U.siosia, a.id, "Snack time");
    expect(await pushes()).toEqual([]);
    await h.admin("update public.chat_presence set seen_at = now() - interval '50 seconds' where user_id = $1", [U.client]);
    await post(U.siosia, a.id, "Nap");
    expect((await pushes()).map((p) => p.kind)).toEqual(["session_update"]);
    // Looking at the chat of the same appointment is not looking at the feed.
    await quiet();
    await h.call(U.client, "siosia_chat", [`appt:${a.id}`, true]);
    await post(U.siosia, a.id, "Awake");
    expect((await pushes()).map((p) => p.kind)).toEqual(["session_update"]);
    // 60 in an hour, then too_many — per author.
    for (let i = 0; i < 56; i++) await post(U.siosia, a.id, `n${i}`); // 4 + 56
    expect(await errorOf(post(U.siosia, a.id, "one more"))).toBe("too_many");
    await post(U.client, a.id, "mine is fine");
    await h.admin("update public.appointment_updates set created_at = created_at - interval '61 minutes' where author = $1", [U.siosia]);
    await post(U.siosia, a.id, "later");
    // Retention: an appointment 13 months old goes with its updates and their photo objects.
    const path = `update/${await pidOf(U.siosia)}/${a.id}/${randomUUID()}.jpg`;
    await upload(path);
    await post(U.siosia, a.id, "", null, path);
    expect(await objects()).toEqual([path]);
    await h.admin("update public.appointments set starts_at = now() - interval '13 months', ended_at = now() - interval '13 months', status = 'done' where id = $1", [a.id]);
    await h.admin("select public.siosia_retention()");
    expect((await h.admin("select count(*)::int as n from public.appointment_updates")).rows[0].n).toBe(0);
    expect(await objects()).toEqual([]);
  });

  it("heading home: the client only, while live, minutes 0–600, repeatable; one client_coming push; shown to both until 2 h after the end (FR-240–242, V56)", async () => {
    const { a } = await session(60);
    expect(await errorOf(coming(U.client, a.id, 20))).toBe("illegal_transition"); // 60 min before
    await shift(a.id, 29);
    expect(await errorOf(coming(U.siosia, a.id, 20))).toBe("not_found");
    expect(await errorOf(coming(U.other, a.id, 20))).toBe("not_found");
    for (const bad of [-1, 601, null]) expect(await errorOf(coming(U.client, a.id, bad)), String(bad)).toBe("bad_input");
    const v = await coming(U.client, a.id, 25);
    const c = v.coming as { at: number; etaAt: number };
    expect(c.etaAt - c.at).toBe(25 * MIN);
    expect(Math.abs(c.at - Date.now())).toBeLessThan(5000);
    expect(await changed()).toEqual(expect.arrayContaining([`user:${U.client}`, `user:${U.siosia}`]));
    expect(await pushes()).toEqual([
      expect.objectContaining({
        kind: "client_coming",
        user_id: U.siosia,
        appointment_id: a.id,
        params: expect.objectContaining({ client: "Toria", provider: "Siosia", minutes: 25, service: "Childcare" })
      })
    ]);
    expect(typeof (await pushes())[0].params.etaAt).toBe("string"); // a timestamp, as Postgres sends it
    expect((await getAppt(U.siosia, a.id)).coming).toEqual(c);
    // Again within a minute: the notice updates, the provider is not rung twice; a minute later it rings again.
    await quiet();
    const again = (await coming(U.client, a.id, 0)).coming as { at: number; etaAt: number };
    expect(again.etaAt).toBe(again.at);
    expect(await pushes()).toEqual([]);
    await h.admin("update public.appointments set coming_at = now() - interval '61 seconds' where id = $1", [a.id]);
    expect((await coming(U.client, a.id, 10)).coming).not.toBeNull();
    expect(await pushes()).toHaveLength(1);
    // Just after the end (done by the sweep) it still works; 2 h after the end it is over.
    await endIn(a.id, -1);
    expect((await getAppt(U.siosia, a.id)).status).toBe("done");
    expect((await getAppt(U.siosia, a.id)).coming).not.toBeNull();
    await coming(U.client, a.id, 5);
    await endIn(a.id, -121);
    expect((await getAppt(U.siosia, a.id)).coming).toBeNull();
    expect((await getAppt(U.client, a.id)).coming).toBeNull();
    expect(await errorOf(coming(U.client, a.id, 5))).toBe("illegal_transition");
    // Never on a request nobody took yet, or one still waiting for an answer.
    const o = await request(U.client, null, 60);
    expect(await errorOf(coming(U.client, o.id, 5))).toBe("illegal_transition");
    const w = await request(U.client, "siosia", 60);
    expect(await errorOf(coming(U.client, w.id, 5))).toBe("illegal_transition");
  });

  it("deleting a profile removes that person's updates and photos; the account move re-keys them (FR-235, V49)", async () => {
    const { a, z } = await session(29);
    const path = `update/${await pidOf(U.siosia)}/${a.id}/${randomUUID()}.jpg`;
    await upload(path);
    await post(U.siosia, a.id, "", null, path);
    await post(U.client, a.id, "Note", z.id);
    // The parent moves to a new phone: the note is theirs there (the old account is no member).
    const NEW = "00000000-0000-4000-8000-000000000250";
    await h.admin("insert into auth.users (id) values ($1) on conflict do nothing", [NEW]);
    await h.call(NEW, "siosia_join", ["pilot 2026", "dev-new25"]);
    const { code } = await h.call<Json>(U.client, "siosia_create_transfer");
    await h.call(NEW, "siosia_redeem_transfer", [code, "dev-new25", false]);
    expect((await h.admin("select author from public.appointment_updates order by created_at")).rows.map((r) => r.author)).toEqual([U.siosia, NEW]);
    expect((await items(NEW, a.id)).map((u) => u.mine)).toEqual([false, true]);
    expect(await can(path, NEW)).toBe(true);
    // The provider leaves: her update and its photo object go; the parent's note stays.
    await h.call(U.siosia, "siosia_delete_profile");
    expect(await objects()).toEqual([]);
    expect((await h.admin("select author, text from public.appointment_updates")).rows).toEqual([{ author: NEW, text: "Note" }]);
    // Back to the usual cast for the tests that follow (the move left U.client without a profile).
    await h.admin("delete from public.memberships where user_id = $1", [NEW]);
    await h.admin("update public.profiles set user_id = $1 where user_id = $2", [U.client, NEW]);
    await h.admin("insert into public.memberships (user_id, device_id) values ($1, 'dev-nt') on conflict do nothing", [U.client]);
    await h.onboard(U.siosia, "Siosia");
    await h.call(U.siosia, "siosia_set_offers", [["learning", "childcare"]]);
  });
});
