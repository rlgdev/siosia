// @vitest-environment node
// Siosia 2.14 "proposing a change" against the REAL SQL migration in PGlite: who may propose and
// answer, the windows, one pending per appointment, lapses in the sweep, acceptance (the appointment,
// its price, reminders, cost, rides and their drivers follow), the view, toAnswer, series dates moved,
// and the clean-ups. Same cases as the engine tests (V19). SQL has no fake clock: rows are shifted.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, errorOf, MIGRATION, type Json, type SqlHarness } from "./sql-harness";

const U = {
  client: "00000000-0000-4000-8000-000000000301",
  siosia: "00000000-0000-4000-8000-000000000302",
  driver: "00000000-0000-4000-8000-000000000303",
  driver2: "00000000-0000-4000-8000-000000000304",
  other: "00000000-0000-4000-8000-000000000305",
  fam: "00000000-0000-4000-8000-000000000306",
  gone: "00000000-0000-4000-8000-000000000307",
  alt: "00000000-0000-4000-8000-000000000308",
  alt2: "00000000-0000-4000-8000-000000000309"
};
type Who = keyof typeof U;
const NAMES: Record<Who, string> = {
  client: "Toria", siosia: "Siosia", driver: "Roman", driver2: "Karol", other: "Ewa", fam: "Ań", gone: "Gosia", alt: "Alt", alt2: "Alt2"
};

const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const SCHOOL = { lat: 52.2663135, lng: 20.814317, label: "Husarska 16" };
const PARK = { lat: 52.2301, lng: 20.8012, label: "Park" };
const NEWHOME = { lat: 52.24, lng: 20.83, label: "Nowa 1" };
const MIN = 60_000;
const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();
const iso = (t: number) => new Date(t).toISOString();
/** A timestamp column (a Date from PGlite) or a JSON timestamp, in ms. */
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args);
const code = (p: Promise<unknown>) => errorOf(p);
const name = (uid: unknown) => (Object.keys(U) as Who[]).find((k) => U[k] === uid) ?? String(uid);

/** An accepted childcare appointment client → siosia at SCHOOL, `startMin` from now. */
async function appt(startMin: number, o: { duration?: number; client?: Who; accept?: boolean } = {}) {
  const a = await call<Json>(o.client ?? "client", "siosia_request_service",
    ["childcare", pub.siosia, at(startMin), o.duration ?? 180, SCHOOL, "", null]);
  if (o.accept !== false) await call("siosia", "siosia_answer_appointment", [a.id, "accept"]);
  return a;
}
const propose = (who: Who, id: unknown, input: unknown) => call<Json>(who, "siosia_propose_change", [id, JSON.stringify(input)]);
const answerCh = (who: Who, id: unknown, d: string) => call<Json>(who, "siosia_answer_change", [id, d]);
const withdraw = (who: Who, id: unknown) => call<Json>(who, "siosia_withdraw_change", [id]);
const getAppt = (who: Who, id: unknown) => call<Json>(who, "siosia_get_appointment", [id]);
const book = (who: Who, whenIso: string, apptId: unknown, leg: string, from = HOME, to = SCHOOL) =>
  call<Json>(who, "siosia_book_ride", [from, to, 3, 8, false, whenIso, apptId, leg]);
const ride = async (id: unknown) => (await h.admin("select * from public.rides where id = $1", [id])).rows[0];
const changes = async (apptId: unknown) =>
  (await h.admin("select status, proposed_by from public.appointment_changes where appointment_id = $1 order by created_at, id", [apptId])).rows.map(
    (r) => `${r.status}:${name(r.proposed_by)}`
  );
const outbox = async () =>
  ((await h.admin("select kind, user_id, params, ride_id from public.push_outbox order by id")).rows as { kind: string; user_id: string; params: Json; ride_id: string }[]).map(
    (r) => ({ ...r, who: name(r.user_id) })
  );
const sent = async (kind?: string) => (await outbox()).filter((r) => !kind || r.kind === kind).map((r) => `${r.kind}>${r.who}`).sort();
const clearOutbox = () => h.admin("delete from public.push_outbox");
const sweep = () => h.admin("select public.siosia_sweep()");
const shift = (id: unknown, startMin: number) =>
  h.admin("update public.appointments set starts_at = now() + make_interval(mins => $2), requested_at = now() - interval '30 days' where id = $1", [id, startMin]);
/** Ended `agoMin` minutes ago; the sweep makes it done (ended_at = its end). */
const endAgo = async (id: unknown, agoMin: number) => {
  await h.admin(
    "update public.appointments set starts_at = now() - make_interval(mins => duration_min + $2), requested_at = now() - interval '30 days'," +
      " ended_at = case when status = 'done' then now() - make_interval(mins => $2) end where id = $1",
    [id, agoMin]
  );
  await sweep();
};
const km = async (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Number((await h.admin("select public.siosia_km($1, $2, $3, $4) as k", [a.lat, a.lng, b.lat, b.lng])).rows[0].k);
const fare = async (k: number, m: number) => Number((await h.admin("select public.siosia_fare($1, $2) as f", [k, m])).rows[0].f);

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  for (const k of Object.keys(U) as Who[]) {
    await h.onboard(U[k], NAMES[k], k === "driver" || k === "driver2");
    pub[k] = String((await call<Json>(k, "siosia_get_profile")).publicId);
    await call(k, "siosia_save_push", [`https://web.push.apple.com/${k}`, "p".repeat(40), "a".repeat(16)]);
  }
  await call("siosia", "siosia_set_offers", [["learning", "childcare"]]);
  // Ań is in Toria's family (role "family" on her appointments).
  await call("client", "siosia_family_invite", [pub.fam]);
  const inc = (await call<Json>("fam", "siosia_family")).incoming as Json[];
  await call("fam", "siosia_family_answer", [inc[0].id, "join"]);
}, 120_000);

beforeEach(async () => {
  await h.db.exec("delete from public.rides; delete from public.appointments; delete from public.appointment_series; delete from public.push_outbox;");
});

describe("who and when (FR-334–336, V90)", () => {
  it("the two parties only: the other one sees it and may answer, family and strangers learn nothing", async () => {
    const a = await appt(2 * 24 * 60);
    const start = Number(a.startsAt);
    await clearOutbox();
    for (const who of ["other", "fam", "driver"] as Who[])
      expect(await code(propose(who, a.id, { kind: "move", startsAt: start + 60 * MIN }))).toBe("not_found");
    const mine = await propose("client", a.id, { kind: "move", startsAt: iso(start + 60 * MIN), note: "  later, please " });
    expect(mine.change).toMatchObject({
      kind: "move", by: "client", mine: true, startsAt: start + 60 * MIN, durationMin: 180, endsAt: start + 240 * MIN,
      place: SCHOOL, minutes: null, price: null, note: "later, please", rides: []
    });
    expect(Number((mine.change as Json).expiresAt)).toBe(start);
    expect((await getAppt("siosia", a.id)).change).toMatchObject({ by: "client", mine: false });
    const fam = await getAppt("fam", a.id);
    expect(fam.role).toBe("family");
    expect(fam.change).toBeNull();
    // one push, to the other party, with the old and the new range
    const out = await outbox();
    expect(out.map((r) => `${r.kind}>${r.who}`)).toEqual(["appt_change_proposed>siosia"]);
    const p = out[0].params;
    expect([ms(p.fromAt), ms(p.fromEnd), ms(p.at), ms(p.end)]).toEqual([
      start, start + 180 * MIN, start + 60 * MIN, start + 240 * MIN
    ]);
    expect(p).toMatchObject({ change: "move", who: "Toria", text: "later, please", place: "Husarska 16", service: "Childcare" });
    expect(p).not.toHaveProperty("fromPlace");
    expect(p).not.toHaveProperty("minutes");
    // only the other party answers
    for (const who of ["client", "fam", "other"] as Who[]) expect(await code(answerCh(who, a.id, "accept"))).toBe("not_found");
    expect(await code(withdraw("siosia", a.id))).toBe("not_found");
    expect(await code(answerCh("siosia", a.id, "maybe"))).toBe("bad_input");
    expect(await call<Json>("siosia", "siosia_my_state")).toMatchObject({ toAnswer: 1 });
    expect(await call<Json>("client", "siosia_my_state")).toMatchObject({ toAnswer: 0 });
    // the raw table stays closed
    expect(await code(h.as(U.client, "select count(*) from public.appointment_changes"))).toMatch(/permission denied/);
  });

  it("a move: accepted and not started; the request rules; something must change", async () => {
    const r = await appt(2 * 24 * 60, { accept: false });
    expect(await code(propose("client", r.id, { kind: "move", startsAt: Number(r.startsAt) + 60 * MIN }))).toBe("illegal_transition");
    const a = await appt(3 * 24 * 60);
    const start = Number(a.startsAt);
    expect(await code(propose("client", a.id, { kind: "jump" }))).toBe("bad_input");
    expect(await code(propose("client", a.id, { kind: "move", startsAt: Date.now() + 10 * MIN }))).toBe("bad_time");
    expect(await code(propose("client", a.id, { kind: "move", startsAt: Date.now() + 31 * 24 * 60 * MIN }))).toBe("bad_time");
    expect(await code(propose("client", a.id, { kind: "move", startsAt: "soon" }))).toBe("bad_time");
    expect(await code(propose("client", a.id, { kind: "move", durationMin: 45 }))).toBe("bad_duration");
    expect(await code(propose("client", a.id, { kind: "move", durationMin: 750 }))).toBe("bad_duration");
    expect(await code(propose("client", a.id, { kind: "move", durationMin: 90.5 }))).toBe("bad_duration");
    expect(await code(propose("client", a.id, { kind: "move", place: null }))).toBe("bad_input");
    expect(await code(propose("client", a.id, { kind: "move", place: { lat: 1, lng: 2, label: "  " } }))).toBe("bad_input");
    expect(await code(propose("client", a.id, { kind: "move", durationMin: 120, note: "x".repeat(201) }))).toBe("bad_input");
    expect(await code(propose("client", a.id, { kind: "move" }))).toBe("no_change");
    expect(await code(propose("client", a.id, { kind: "move", startsAt: start, durationMin: 180, place: { ...SCHOOL, label: " Husarska 16 " }, note: "hi" }))).toBe("no_change");
    // a new place is stored cleaned (V33)
    const moved = await propose("client", a.id, { kind: "move", place: { ...PARK, label: `  ${PARK.label}  `, extra: 1 } });
    expect((moved.change as Json).place).toEqual(PARK);
    // under way: no move any more (a new length instead)
    await shift(a.id, -10);
    expect(await code(propose("siosia", a.id, { kind: "move", startsAt: start }))).toBe("illegal_transition");
  });

  it("a length: under way, or done within 24 h; 15–1440 on the quarter hour; the same → no_change", async () => {
    const a = await appt(2 * 24 * 60);
    expect(await code(propose("siosia", a.id, { kind: "length", minutes: 240 }))).toBe("illegal_transition");
    await shift(a.id, -30);
    expect(await code(propose("siosia", a.id, { kind: "length", minutes: 170 }))).toBe("bad_duration");
    expect(await code(propose("siosia", a.id, { kind: "length", minutes: 1455 }))).toBe("bad_duration");
    expect(await code(propose("siosia", a.id, { kind: "length" }))).toBe("bad_duration");
    expect(await code(propose("siosia", a.id, { kind: "length", minutes: 180 }))).toBe("no_change");
    const v = await propose("siosia", a.id, { kind: "length", minutes: 240 });
    const s = Number(v.startsAt);
    expect(v.change).toMatchObject({ kind: "length", by: "provider", startsAt: s, durationMin: 240, endsAt: s + 240 * MIN, minutes: null });
    expect(Number((v.change as Json).expiresAt)).toBe(s + 240 * MIN + 24 * 60 * MIN);
    const out = (await outbox()).find((r) => r.kind === "appt_change_proposed")!;
    expect(out.who).toBe("client");
    expect(out.params).toMatchObject({ change: "length", minutes: 240, who: "Siosia" });
    const b = await appt(2 * 24 * 60 + 600);
    await endAgo(b.id, 60);
    expect((await getAppt("client", b.id)).status).toBe("done");
    const d = await propose("client", b.id, { kind: "length", minutes: 150 });
    expect(d.change).toMatchObject({ minutes: 150, durationMin: 180 });
    await endAgo(b.id, 25 * 60);
    expect(await code(propose("client", b.id, { kind: "length", minutes: 120 }))).toBe("window_closed");
  });
});

describe("one pending change (FR-336, V90)", () => {
  it("mine is replaced; a counter-proposal declines theirs (told); the proposer withdraws; answered or none", async () => {
    const a = await appt(2 * 24 * 60);
    const start = Number(a.startsAt);
    expect(await code(answerCh("siosia", a.id, "accept"))).toBe("not_found");
    expect(await code(withdraw("client", a.id))).toBe("not_found");
    await propose("client", a.id, { kind: "move", startsAt: start + 60 * MIN });
    await propose("client", a.id, { kind: "move", startsAt: start + 120 * MIN });
    expect(await changes(a.id)).toEqual(["replaced:client", "proposed:client"]);
    await clearOutbox();
    const counter = await propose("siosia", a.id, { kind: "move", startsAt: start + 30 * MIN });
    expect(counter.change).toMatchObject({ by: "provider", mine: true, startsAt: start + 30 * MIN });
    expect(await changes(a.id)).toEqual(["replaced:client", "declined:client", "proposed:siosia"]);
    expect(await sent()).toEqual(["appt_change_declined>client", "appt_change_proposed>client"]);
    const declined = (await outbox()).find((r) => r.kind === "appt_change_declined")!.params;
    expect(ms(declined.at)).toBe(start + 120 * MIN);
    expect(declined).toMatchObject({ who: "Siosia", change: "move" });
    await clearOutbox();
    const w = await withdraw("siosia", a.id);
    expect(w.change).toBeNull();
    expect(await sent()).toEqual([]);
    expect(await code(withdraw("siosia", a.id))).toBe("illegal_transition");
    expect(await code(answerCh("client", a.id, "accept"))).toBe("illegal_transition");
    await propose("client", a.id, { kind: "move", startsAt: start + 60 * MIN });
    const dec = await answerCh("siosia", a.id, "decline");
    expect(dec.change).toBeNull();
    expect(dec.startsAt).toBe(start);
    expect(await sent()).toEqual(["appt_change_declined>client", "appt_change_proposed>siosia"]);
  });

  it("lapses in the sweep, nobody told; cancelling the appointment or deleting a party's profile ends it", async () => {
    const a = await appt(2 * 24 * 60);
    await propose("client", a.id, { kind: "move", startsAt: Number(a.startsAt) + 60 * MIN });
    await h.admin("update public.appointment_changes set expires_at = now() - interval '1 second' where appointment_id = $1", [a.id]);
    await clearOutbox();
    await sweep();
    expect(await changes(a.id)).toEqual(["expired:client"]);
    expect(await sent()).toEqual([]);
    expect(await code(answerCh("siosia", a.id, "accept"))).toBe("illegal_transition");
    // an appointment no longer accepted or done (whatever ended it) takes its change along
    await propose("client", a.id, { kind: "move", startsAt: Number(a.startsAt) + 60 * MIN });
    await h.admin("update public.appointments set status = 'expired' where id = $1", [a.id]);
    // even past its moment: withdrawn, not expired
    await h.admin("update public.appointment_changes set expires_at = now() - interval '1 second' where appointment_id = $1 and status = 'proposed'", [a.id]);
    await sweep();
    expect(await changes(a.id)).toEqual(["expired:client", "withdrawn:client"]);
    const b = await appt(2 * 24 * 60 + 300);
    await propose("siosia", b.id, { kind: "move", durationMin: 120 });
    await call("client", "siosia_cancel_appointment", [b.id, null, "one"]);
    expect(await changes(b.id)).toEqual(["withdrawn:siosia"]);
    const c = await appt(2 * 24 * 60 + 600, { client: "gone" });
    await propose("siosia", c.id, { kind: "move", durationMin: 120 });
    await call("gone", "siosia_delete_profile");
    expect(await changes(c.id)).toEqual(["withdrawn:siosia"]);
  });
});

describe("accepting (FR-337, V91)", () => {
  it("a move: start, length, place and the price at the rate; past reminders count as sent; the proposer is told", async () => {
    const a = await appt(2 * 24 * 60);
    await h.admin("update public.appointments set rate = 40, price = 120 where id = $1", [a.id]);
    const newStart = Date.now() + 10 * 60 * MIN;
    const v = await propose("client", a.id, { kind: "move", startsAt: newStart, durationMin: 240, place: PARK });
    expect((v.change as Json).price).toBe(160);
    const p = (await outbox()).find((r) => r.kind === "appt_change_proposed")!.params;
    expect(p).toMatchObject({ fromPlace: "Husarska 16", place: "Park" });
    await clearOutbox();
    const ok = await answerCh("siosia", a.id, "accept");
    expect(ok).toMatchObject({ status: "accepted", durationMin: 240, endsAt: Number(ok.startsAt) + 240 * MIN, place: PARK, price: 160, change: null });
    expect(Math.abs(Number(ok.startsAt) - newStart)).toBeLessThan(1000);
    expect(ok.reminders).toEqual([1440]);
    expect(await changes(a.id)).toEqual(["accepted:client"]);
    expect(await sent()).toEqual(["appt_change_accepted>client"]);
    const acc = (await outbox())[0].params;
    expect(acc).toMatchObject({ who: "Siosia", change: "move", place: "Park", fromPlace: "Husarska 16" });
    expect(ms(acc.fromAt)).toBe(Number(a.startsAt));
    await clearOutbox();
    await sweep(); // no burst of the 24-hour reminder for the new start
    expect(await sent("appt_reminder")).toEqual([]);
  });

  it("everything is checked again at the moment of acceptance: overlap with the provider's day", async () => {
    const a = await appt(2 * 24 * 60);
    const busy = await call<Json>("other", "siosia_request_service", ["childcare", pub.siosia, at(3 * 24 * 60), 180, SCHOOL, "", null]);
    await propose("client", a.id, { kind: "move", startsAt: Number(busy.startsAt) + 60 * MIN });
    await call("siosia", "siosia_answer_appointment", [busy.id, "accept"]);
    expect(await code(answerCh("siosia", a.id, "accept"))).toBe("overlap");
    // and the window: a move whose new start is too close by now
    await h.admin("update public.appointment_changes set starts_at = now() + interval '5 minutes' where appointment_id = $1", [a.id]);
    expect(await code(answerCh("siosia", a.id, "accept"))).toBe("bad_time");
  });

  it("a length under way: duration and price; done: actual minutes and the corrected cost to the client's side", async () => {
    const a = await appt(2 * 24 * 60);
    await h.admin("update public.appointments set rate = 40, price = 120 where id = $1", [a.id]);
    await shift(a.id, -30);
    await propose("siosia", a.id, { kind: "length", minutes: 240 });
    const ok = await answerCh("client", a.id, "accept");
    expect(ok).toMatchObject({ status: "accepted", durationMin: 240, price: 160, change: null });
    expect(await sent("appt_change_accepted")).toEqual(["appt_change_accepted>siosia"]);
    const b = await appt(2 * 24 * 60 + 600);
    await h.admin("update public.appointments set rate = 40, price = 120 where id = $1", [b.id]);
    await endAgo(b.id, 30);
    await clearOutbox();
    const v = await propose("siosia", b.id, { kind: "length", minutes: 240 });
    expect((v.change as Json).price).toBe(160);
    const done = await answerCh("client", b.id, "accept");
    expect(done).toMatchObject({ status: "done", durationMin: 180, actualMin: 240, cost: { minutes: 240, total: 160, corrected: true } });
    expect(await sent()).toEqual(["appt_change_accepted>siosia", "appt_change_proposed>client", "appt_summary>client", "appt_summary>fam"]);
    expect((await outbox()).find((r) => r.kind === "appt_summary")!.params).toMatchObject({ minutes: 240, total: 160, corrected: true });
    expect(await code(propose("client", b.id, { kind: "length", minutes: 240 }))).toBe("no_change");
    await propose("client", b.id, { kind: "length", minutes: 180 });
    expect(await answerCh("siosia", b.id, "accept")).toMatchObject({ actualMin: null, cost: { minutes: 180, total: 120 } });
  });
});

describe("rides follow (FR-337, V92)", () => {
  it("there by the start's shift, back by the end's (never before the new start); the preview is the outcome", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    const there = await book("client", iso(s - 30 * MIN), a.id, "there");
    const back = await book("client", iso(s + 30 * MIN), a.id, "back", SCHOOL, HOME);
    // +60 min, 60 min long: the end moves 60 min earlier → back would be before the new start
    const v = await propose("siosia", a.id, { kind: "move", startsAt: s + 60 * MIN, durationMin: 60 });
    expect((v.change as Json).rides).toEqual([
      { rideId: there.id, leg: "there", passenger: "client", mine: false, from: s - 30 * MIN, to: s + 30 * MIN, effect: "move" },
      { rideId: back.id, leg: "back", passenger: "client", mine: false, from: s + 30 * MIN, to: s + 60 * MIN, effect: "move" }
    ]);
    const mine = ((await getAppt("client", a.id)).change as Json).rides as Json[];
    // places and fare unchanged: none shown, even to the passenger (FR-114: only when they change)
    expect(mine[0]).toMatchObject({ mine: true });
    expect(mine[0]).not.toHaveProperty("pickup");
    expect(mine[0]).not.toHaveProperty("fare");
    await answerCh("client", a.id, "accept");
    expect(ms((await ride(there.id)).scheduled_for)).toBe(s + 30 * MIN);
    expect(ms((await ride(there.id)).dispatch_started_at)).toBe(s + 30 * MIN);
    expect(ms((await ride(back.id)).scheduled_for)).toBe(s + 60 * MIN);
    expect(Number((await ride(back.id)).fare)).toBe(Number(back.fare));
  });

  it("a ride that would start too soon is cancelled (appointment_changed, its driver told); a dispatched one blocks the change", async () => {
    const a = await appt(3 * 60);
    const s = Number(a.startsAt);
    const there = await book("client", iso(s - 120 * MIN), a.id, "there");
    expect(await call("driver", "siosia_claim_booking", [there.id])).toBe("won");
    const v = await propose("client", a.id, { kind: "move", startsAt: s - 90 * MIN });
    expect(((v.change as Json).rides as Json[])[0]).toMatchObject({ effect: "cancel", to: null });
    await clearOutbox();
    await answerCh("siosia", a.id, "accept");
    expect((await ride(there.id))).toMatchObject({ status: "cancelled", cancelled_by: "system", cancel_reason: "appointment_changed" });
    expect(await sent("booking_cancelled")).toEqual(["booking_cancelled>driver"]);
    // no appt_ride_failed: it goes like a cancelled appointment's ride (not shown)
    expect(await sent("appt_ride_failed")).toEqual([]);
    expect((await getAppt("client", a.id)).rides).toEqual([]);
    // dispatched: refused when proposing and when accepting; the view still shows it (kept)
    const b = await appt(2 * 24 * 60);
    const sb = Number(b.startsAt);
    const r2 = await book("client", iso(sb - 30 * MIN), b.id, "there");
    await h.admin("update public.rides set status = 'requested' where id = $1", [r2.id]);
    expect(await code(propose("client", b.id, { kind: "move", startsAt: sb + 60 * MIN }))).toBe("ride_started");
    await h.admin("update public.rides set status = 'scheduled' where id = $1", [r2.id]);
    await propose("client", b.id, { kind: "move", startsAt: sb + 60 * MIN });
    await h.admin("update public.rides set status = 'requested' where id = $1", [r2.id]);
    expect(((await getAppt("siosia", b.id)).change as Json).rides).toMatchObject([{ effect: "keep", from: sb - 30 * MIN, to: sb - 30 * MIN }]);
    expect(await code(answerCh("siosia", b.id, "accept"))).toBe("ride_started");
  });

  it("pickups: only for my own live ride, with the phone's estimate; fare by the booking rules", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    const there = await book("client", iso(s - 30 * MIN), a.id, "there");
    const pick = (leg: string, o: Json = {}) => ({ leg, pickup: NEWHOME, estKm: 5, estMin: 12, fareIsEstimate: false, ...o });
    expect(await code(propose("siosia", a.id, { kind: "move", pickups: [pick("there")] }))).toBe("forbidden");
    expect(await code(propose("client", a.id, { kind: "move", pickups: [pick("back")] }))).toBe("bad_leg");
    expect(await code(propose("client", a.id, { kind: "move", pickups: [pick("side")] }))).toBe("bad_leg");
    expect(await code(propose("client", a.id, { kind: "move", pickups: [pick("there", { estKm: 0 })] }))).toBe("bad_input");
    expect(await code(propose("client", a.id, { kind: "move", pickups: [pick("there", { estMin: 1441 })] }))).toBe("bad_input");
    expect(await code(propose("client", a.id, { kind: "move", pickups: [pick("there", { pickup: { lat: 52 } })] }))).toBe("bad_input");
    expect(await code(propose("client", a.id, { kind: "move", pickups: [pick("there"), pick("there")] }))).toBe("bad_input");
    try {
      await h.admin("update public.app_config set max_trip_km = 4 where id = 1");
      expect(await code(propose("client", a.id, { kind: "move", pickups: [pick("there")] }))).toBe("too_far");
      await h.admin("update public.app_config set max_trip_km = 50, service_lat = $1, service_lng = $2, service_radius_km = 1 where id = 1", [SCHOOL.lat, SCHOOL.lng]);
      expect(await code(propose("client", a.id, { kind: "move", pickups: [pick("there")] }))).toBe("outside_area");
      // proposed while it passed, the view never fails: that ride shows as kept; accepting refuses
      await h.admin("update public.app_config set service_lat = null, service_lng = null, service_radius_km = null where id = 1");
      await propose("client", a.id, { kind: "move", pickups: [pick("there")] });
      await h.admin("update public.app_config set service_lat = $1, service_lng = $2, service_radius_km = 1 where id = 1", [SCHOOL.lat, SCHOOL.lng]);
      expect(((await getAppt("siosia", a.id)).change as Json).rides).toMatchObject([{ effect: "keep" }]);
      expect(await code(answerCh("siosia", a.id, "accept"))).toBe("outside_area");
      await withdraw("client", a.id);
    } finally {
      await h.admin("update public.app_config set max_trip_km = 50, service_lat = null, service_lng = null, service_radius_km = null where id = 1");
    }
    const v = await propose("client", a.id, { kind: "move", pickups: [pick("there", { pickup: { ...NEWHOME, label: " Nowa 1 " } })] });
    const f = await fare(5, 12);
    expect(((v.change as Json).rides as Json[])[0]).toMatchObject({ effect: "move", from: s - 30 * MIN, to: s - 30 * MIN, pickup: NEWHOME, dropoff: SCHOOL, fare: f });
    expect(((await getAppt("siosia", a.id)).change as Json).rides as Json[]).toEqual([
      { rideId: there.id, leg: "there", passenger: "client", mine: false, from: s - 30 * MIN, to: s - 30 * MIN, effect: "move" }
    ]);
    await answerCh("siosia", a.id, "accept");
    expect(await ride(there.id)).toMatchObject({ pickup_label: "Nowa 1", pickup_lat: NEWHOME.lat, dropoff_label: "Husarska 16", est_min: 12, fare_is_estimate: false });
    expect(Number((await ride(there.id)).est_km)).toBe(Math.max(5, Math.round((await km(NEWHOME, SCHOOL)) * 10) / 10));
    expect(Number((await ride(there.id)).fare)).toBe(f);
  });

  it("a moved place takes the rides at the old place along, estimated from the old route's ratio", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    const there = await book("client", iso(s - 30 * MIN), a.id, "there");
    const back = await book("client", iso(s + 180 * MIN), a.id, "back", SCHOOL, HOME);
    await propose("siosia", a.id, { kind: "move", place: PARK });
    await answerCh("client", a.id, "accept");
    const ratio = Math.min(3, Math.max(1, 3 / Math.max(await km(HOME, SCHOOL), 0.1)));
    const k = (await km(HOME, PARK)) * ratio;
    const m = Math.max(1, Math.round((8 * k) / 3));
    const t = await ride(there.id);
    expect(t).toMatchObject({ pickup_label: "Warszawska 269", dropoff_label: "Park", dropoff_lat: PARK.lat, est_min: m, fare_is_estimate: true });
    expect(Number(t.est_km)).toBe(Math.round(k * 10) / 10);
    expect(Number(t.fare)).toBe(await fare(k, m));
    expect(await ride(back.id)).toMatchObject({ pickup_label: "Park", dropoff_label: "Warszawska 269", fare_is_estimate: true });
    expect(ms((await ride(back.id)).scheduled_for)).toBe(s + 180 * MIN);
  });

  it("a driver keeps a moved booking that still fits their day (booking_moved), else it goes back to the drivers", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    const there = await book("client", iso(s - 30 * MIN), a.id, "there");
    await call("driver", "siosia_claim_booking", [there.id]);
    await propose("client", a.id, { kind: "move", startsAt: s + 60 * MIN });
    await clearOutbox();
    await answerCh("siosia", a.id, "accept");
    expect((await ride(there.id)).driver_id).toBe(U.driver);
    const moved = (await outbox()).filter((r) => r.kind === "booking_moved");
    expect(moved.map((r) => r.who)).toEqual(["driver"]);
    expect(moved[0].ride_id).toBe(there.id);
    expect(moved[0].params).toMatchObject({ pickup: "Warszawska 269", dropped: false });
    expect([ms(moved[0].params.at), ms(moved[0].params.fromAt)]).toEqual([s + 30 * MIN, s - 30 * MIN]);
    // another booking of the driver's at the new time: dropped, offered again
    const busy = await call<Json>("other", "siosia_book_ride", [HOME, SCHOOL, 3, 8, false, iso(s + 90 * MIN), null, null]);
    await call("driver", "siosia_claim_booking", [busy.id]);
    await propose("client", a.id, { kind: "move", startsAt: s + 120 * MIN });
    await clearOutbox();
    await answerCh("siosia", a.id, "accept");
    expect((await ride(there.id)).driver_id).toBeNull();
    const out = await outbox();
    expect(out.find((r) => r.kind === "booking_moved")).toMatchObject({ who: "driver", params: { dropped: true } });
    expect(await sent("booking_new")).toEqual(["booking_new>driver", "booking_new>driver2"]);
    expect(await sent("appt_ride_lost")).toEqual(["appt_ride_lost>siosia"]);
    expect((((await getAppt("siosia", a.id)).rides as Json[])[0]).status).toBe("pending");
  });
});

describe("more of the engine's cases (V19)", () => {
  it("a fixed price stays; a ride away from the old place stays; a driver providing an appointment then is dropped", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    await h.admin("update public.appointments set rate = null, price = 100 where id = $1", [a.id]);
    // ~1 km from SCHOOL: does not follow the place
    const AWAY = { lat: SCHOOL.lat + 0.009, lng: SCHOOL.lng, label: "Lazurowa 1" };
    const far = await book("client", iso(s - 30 * MIN), a.id, "there", HOME, AWAY);
    const v = await propose("siosia", a.id, { kind: "move", durationMin: 120, place: PARK });
    expect((v.change as Json).price).toBe(100);
    expect(((v.change as Json).rides as Json[])[0]).toMatchObject({ rideId: far.id, effect: "keep" });
    const ok = await answerCh("client", a.id, "accept");
    expect(ok).toMatchObject({ durationMin: 120, price: 100 });
    expect(await ride(far.id)).toMatchObject({ dropoff_label: "Lazurowa 1", fare_is_estimate: false });
    expect(ms((await ride(far.id)).scheduled_for)).toBe(s - 30 * MIN);
    // the driver provides an accepted appointment at the ride's new time → dropped
    await call("driver", "siosia_claim_booking", [far.id]);
    await call("driver", "siosia_set_offers", [["childcare"]]);
    const busy = await call<Json>("other", "siosia_request_service", ["childcare", pub.driver, iso(s + 60 * MIN), 60, SCHOOL, "", null]);
    await call("driver", "siosia_answer_appointment", [busy.id, "accept"]);
    await propose("client", a.id, { kind: "move", startsAt: s + 90 * MIN });
    await clearOutbox();
    await answerCh("siosia", a.id, "accept");
    expect((await ride(far.id)).driver_id).toBeNull();
    expect(await sent("booking_moved")).toEqual(["booking_moved>driver"]);
    await call("driver", "siosia_set_offers", [[]]);
  });
});

describe("views (FR-339, FR-340, V93, V95)", () => {
  it("toAnswer counts the changes awaiting me; P1 lists a finished one with a new length pending", async () => {
    const a = await appt(2 * 24 * 60);
    const b = await appt(2 * 24 * 60 + 600);
    await endAgo(b.id, 30);
    await propose("client", a.id, { kind: "move", durationMin: 120 });
    await propose("client", b.id, { kind: "length", minutes: 120 });
    expect(await call<Json>("siosia", "siosia_my_state")).toMatchObject({ toAnswer: 2 });
    expect(await call<Json>("client", "siosia_my_state")).toMatchObject({ toAnswer: 0 });
    const planned = (await call<Json>("siosia", "siosia_planned")).appointments as Json[];
    expect(planned.map((x) => [x.id, x.status, (x.change as Json).mine])).toEqual([[b.id, "done", false], [a.id, "accepted", false]]);
    expect(((await call<Json>("client", "siosia_planned")).appointments as Json[]).map((x) => x.id)).toEqual([b.id, a.id]);
    // the family sees the planned one, not the finished one (its parties only)
    expect(((await call<Json>("fam", "siosia_planned")).appointments as Json[]).map((x) => x.id)).toEqual([a.id]);
    await withdraw("client", b.id);
    expect(((await call<Json>("siosia", "siosia_planned")).appointments as Json[]).map((x) => x.id)).toEqual([a.id]);
    expect(await call<Json>("siosia", "siosia_my_state")).toMatchObject({ toAnswer: 1 });
  });

  it("a series: the rule's start and length, a moved date at its rule slot, a cancelled one as a gap at its slot", async () => {
    const first = await call<Json>("client", "siosia_request_service",
      ["childcare", pub.siosia, at(2 * 24 * 60), 180, SCHOOL, "", { every: 1, count: 3 }]);
    await call("siosia", "siosia_answer_appointment", [first.id, "accept"]);
    const starts = (first.series as Json).starts as number[];
    const second = String((await h.admin("select id from public.appointments where series_id = $1 and seq = 2", [(first.series as Json).id])).rows[0].id);
    await propose("siosia", second, { kind: "move", startsAt: starts[1] + 60 * MIN, durationMin: 120, place: PARK });
    await answerCh("client", second, "accept");
    const v = await getAppt("client", first.id);
    expect(v.series).toMatchObject({
      first: starts[0], durationMin: 180, place: SCHOOL, gaps: [],
      moved: [{ orig: starts[1], start: starts[1] + 60 * MIN, end: starts[1] + 180 * MIN, place: PARK }]
    });
    expect((v.series as Json).starts).toEqual([starts[0], starts[1] + 60 * MIN, starts[2]]);
    // the series keeps its own place, viewed from the date moved to the park too
    expect(((await getAppt("client", second)).series as Json).place).toEqual(SCHOOL);
    await call("client", "siosia_cancel_appointment", [second, null, "one"]);
    expect((await getAppt("client", first.id)).series).toMatchObject({ gaps: [starts[1]], moved: [] });
  });
});

describe("accounts and the migration (V90, NFR-18)", () => {
  it("an account merge re-keys the proposer, who can still withdraw", async () => {
    const a = await appt(2 * 24 * 60, { client: "alt" });
    await propose("alt", a.id, { kind: "move", durationMin: 120 });
    const res = (await h.admin("select public.siosia_merge_into($1, $2) as r", [pub.alt, pub.alt2])).rows[0].r as Json;
    expect(res).toHaveProperty("ok");
    expect(await changes(a.id)).toEqual(["proposed:alt2"]);
    expect((await withdraw("alt2", a.id)).change).toBeNull();
  });

  it("re-running the migration keeps the proposals", async () => {
    const a = await appt(2 * 24 * 60);
    await propose("client", a.id, { kind: "move", durationMin: 120 });
    await h.db.exec(MIGRATION);
    expect(await changes(a.id)).toEqual(["proposed:client"]);
    expect(((await getAppt("siosia", a.id)).change as Json).durationMin).toBe(120);
  }, 60_000);
});

// B15 (2026-11-03, the 2.14 pre-release review): the real findings, each pinned (twins in change.test).
describe("2.14 review fixes (B15, V19)", () => {
  const pick = (o: Json = {}) => ({ leg: "there", pickup: NEWHOME, estKm: 5, estMin: 12, fareIsEstimate: false, ...o });

  it("the provider driving their own appointment's ride: an extension and a move are accepted, the ride follows (V91)", async () => {
    await call("siosia", "siosia_save_vehicle", ["Kia", "Ceed", "Szary", "W S1", 4]);
    try {
      const a = await appt(2 * 24 * 60);
      const s = Number(a.startsAt);
      const there = await book("client", iso(s - 30 * MIN), a.id, "there");
      const back = await book("client", iso(s + 180 * MIN), a.id, "back", SCHOOL, HOME);
      await call("siosia", "siosia_claim_booking", [back.id]);
      await propose("client", a.id, { kind: "move", startsAt: s + 60 * MIN });
      await clearOutbox();
      expect(await code(answerCh("siosia", a.id, "accept"))).toBe("no error");
      expect(await ride(back.id)).toMatchObject({ driver_id: U.siosia });
      expect(ms((await ride(back.id)).scheduled_for)).toBe(s + 240 * MIN);
      expect((await outbox()).filter((r) => r.kind === "booking_moved").map((r) => [r.who, r.params.dropped])).toEqual([["siosia", false]]);
      // earlier, with the there ride she drives
      await call("siosia", "siosia_release_booking", [back.id]);
      await call("siosia", "siosia_claim_booking", [there.id]);
      await propose("client", a.id, { kind: "move", startsAt: s + 45 * MIN });
      expect(await code(answerCh("siosia", a.id, "accept"))).toBe("no error");
      expect(ms((await ride(there.id)).scheduled_for)).toBe(s + 15 * MIN);
      expect((await ride(there.id)).driver_id).toBe(U.siosia);
      // a live extension with the back ride she drives
      const b = await appt(3 * 24 * 60);
      const sb = Number(b.startsAt);
      const back2 = await book("client", iso(sb + 180 * MIN), b.id, "back", SCHOOL, HOME);
      await call("siosia", "siosia_claim_booking", [back2.id]);
      await shift(b.id, -30);
      await h.admin(
        "update public.rides set scheduled_for = now() + interval '150 minutes', dispatch_started_at = now() + interval '150 minutes' where id = $1",
        [back2.id]
      );
      const was = ms((await ride(back2.id)).scheduled_for);
      await propose("client", b.id, { kind: "length", minutes: 240 });
      expect(await code(answerCh("siosia", b.id, "accept"))).toBe("no error");
      // by the end's shift (+1 h)
      expect(ms((await ride(back2.id)).scheduled_for)).toBe(was + 60 * MIN);
      expect((await ride(back2.id)).driver_id).toBe(U.siosia);
    } finally {
      await h.admin("delete from public.rides");
      await h.admin("delete from public.vehicles where user_id = $1", [U.siosia]);
    }
  });

  it("a driver on both legs is judged at both new times and keeps them (V92)", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    const there = await book("client", iso(s - 30 * MIN), a.id, "there");
    const back = await book("client", iso(s + 180 * MIN), a.id, "back", SCHOOL, HOME);
    await call("driver", "siosia_claim_booking", [there.id]);
    await call("driver", "siosia_claim_booking", [back.id]);
    await propose("client", a.id, { kind: "move", startsAt: s + 180 * MIN });
    await clearOutbox();
    await answerCh("siosia", a.id, "accept");
    const [t, b] = [await ride(there.id), await ride(back.id)];
    expect([
      [ms(t.scheduled_for), t.driver_id],
      [ms(b.scheduled_for), b.driver_id]
    ]).toEqual([
      [s + 150 * MIN, U.driver],
      [s + 360 * MIN, U.driver]
    ]);
    expect((await outbox()).filter((r) => r.kind === "booking_moved").map((r) => r.params.dropped)).toEqual([false, false]);
    expect(await sent("appt_ride_lost")).toEqual([]);
    expect(await sent("booking_new")).toEqual([]);
  });

  it("my new pickup and a moved place: the there ride still goes to the new place (FR-337)", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    const there = await book("client", iso(s - 30 * MIN), a.id, "there");
    const v = await propose("client", a.id, { kind: "move", place: PARK, pickups: [pick()] });
    expect(((v.change as Json).rides as Json[])[0]).toMatchObject({ effect: "move", pickup: NEWHOME, dropoff: PARK });
    await answerCh("siosia", a.id, "accept");
    const r = await ride(there.id);
    expect(r).toMatchObject({ pickup_label: "Nowa 1", dropoff_label: "Park", est_min: 12, fare_is_estimate: false });
    expect(Number(r.est_km)).toBe(Math.round(Math.max(5, await km(NEWHOME, PARK)) * 10) / 10);
  });

  it("a length proposed live, viewed after the end: the booked length and the new end; acceptable until it lapses", async () => {
    const a = await appt(2 * 24 * 60);
    await shift(a.id, -30);
    await propose("client", a.id, { kind: "length", minutes: 240 });
    await endAgo(a.id, 10);
    const row = (await h.admin("select status, starts_at from public.appointments where id = $1", [a.id])).rows[0];
    expect(row.status).toBe("done");
    const start = ms(row.starts_at);
    expect((await getAppt("siosia", a.id)).change).toMatchObject({ durationMin: 180, minutes: 240, endsAt: start + 240 * MIN });
    // past the end + 24 h but before the stored lapse: still acceptable (never a dead Accept)
    await h.admin(
      "update public.appointments set starts_at = now() - interval '24 hours 210 minutes', ended_at = now() - interval '24 hours 30 minutes' where id = $1",
      [a.id]
    );
    await h.admin("update public.appointment_changes set expires_at = now() + interval '30 minutes' where appointment_id = $1", [a.id]);
    expect(await code(answerCh("siosia", a.id, "accept"))).toBe("no error");
    expect((await h.admin("select actual_min from public.appointments where id = $1", [a.id])).rows[0].actual_min).toBe(240);
  });

  it("a move lapses the booking lead before its new start when that is first", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    const v = await propose("client", a.id, { kind: "move", startsAt: s - 60 * MIN });
    expect(Number((v.change as Json).expiresAt)).toBe(s - 90 * MIN);
  });

  it("the note is trimmed of all white space; odd pickup numbers give bad_input or are kept to 3 decimals, never an error", async () => {
    const a = await appt(2 * 24 * 60);
    const s = Number(a.startsAt);
    await clearOutbox();
    expect(((await propose("client", a.id, { kind: "move", startsAt: s + 60 * MIN, note: "\n" })).change as Json).note).toBe("");
    expect((await outbox()).find((r) => r.kind === "appt_change_proposed")!.params).not.toHaveProperty("text");
    expect(((await propose("client", a.id, { kind: "move", startsAt: s + 60 * MIN, note: "ok\n\t\u000b" })).change as Json).note).toBe("ok");
    await withdraw("client", a.id);
    await book("client", iso(s - 30 * MIN), a.id, "there");
    const raw = (p: string) =>
      code(call("client", "siosia_propose_change", [a.id, '{"kind":"move","pickups":[{"leg":"there","pickup":' + JSON.stringify(NEWHOME) + "," + p + "}]}"]));
    expect(await raw('"estKm":1e400,"estMin":12')).toBe("bad_input");
    expect(await raw('"estKm":0.0004,"estMin":12')).toBe("bad_input");
    expect(await raw('"estKm":5,"estMin":1e400')).toBe("bad_input");
    expect(await raw('"estKm":5.12345,"estMin":1e-400,"fareIsEstimate":"maybe"')).toBe("no error");
    const stored = (await h.admin("select pickups from public.appointment_changes where appointment_id = $1 and status = 'proposed'", [a.id])).rows[0].pickups as Json[];
    expect(stored[0]).toMatchObject({ estKm: 5.123, estMin: 0, fareIsEstimate: false });
  });

  it("a master's fixed fare stays on a moved ride whose place followed", async () => {
    await h.admin("select public.siosia_set_master('mfare', 'mfare-link-token-0123456789', 'Toria', null, 18, 'rider')");
    await h.admin("update public.profiles set master_id = 'mfare' where user_id = $1", [U.client]);
    try {
      const a = await appt(2 * 24 * 60);
      const s = Number(a.startsAt);
      const there = await book("client", iso(s - 30 * MIN), a.id, "there");
      expect(Number((await ride(there.id)).fare)).toBe(18);
      await propose("siosia", a.id, { kind: "move", place: PARK });
      await answerCh("client", a.id, "accept");
      const r = await ride(there.id);
      expect(r).toMatchObject({ dropoff_label: "Park", fare_is_estimate: false });
      expect(Number(r.fare)).toBe(18);
    } finally {
      await h.admin("update public.profiles set master_id = null where user_id = $1", [U.client]);
    }
  });

  it("the proposer follows the account when it moves to another phone (redeem_transfer re-keys proposed_by)", async () => {
    const NEW = "00000000-0000-4000-8000-000000000310";
    await h.addUser(NEW);
    const a = await appt(2 * 24 * 60, { client: "other" });
    await propose("other", a.id, { kind: "move", durationMin: 120 });
    const { code: t } = await call<Json>("other", "siosia_create_transfer");
    await h.call(NEW, "siosia_redeem_transfer", [t, "dev-new", false]);
    expect((await h.admin("select proposed_by from public.appointment_changes where appointment_id = $1", [a.id])).rows[0].proposed_by).toBe(NEW);
    expect((await h.call<Json>(NEW, "siosia_get_appointment", [a.id])).change).toMatchObject({ mine: true, by: "client" });
    expect((await h.call<Json>(NEW, "siosia_withdraw_change", [a.id])).change).toBeNull();
  });
});
