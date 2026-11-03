// Siosia 2.14 change proposals in the engine (FR-330–336, V87–V91): who may propose, the move and
// length windows, no_change, counter-proposals and replacing, withdraw and lapse, the checks again at
// acceptance (overlap, ride_started), reminders, price and cost, rides following (shift, clamp,
// too soon, pickups and fares, the place followed), drivers kept or dropped, the view per role,
// toAnswer, series dates moved and gaps at the rule's slot, cancel / delete / merge.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { computeFare } from "../../src/core/fare";
import { haversineKm } from "../../src/core/geo";
import { addWeeksWallClock } from "../../src/core/time";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent } from "../../src/core/engine";
import { ServerError, type AppointmentView, type ChangeInput, type Leg, type Place, type RepeatInput } from "../../src/core/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const SCHOOL: Place = { lat: 52.2663135, lng: 20.814317, label: "Husarska 16" };
const PARK: Place = { lat: 52.2297, lng: 21.0122, label: "Plac Zamkowy" };
/** About 100 m from HOME (a ride there "at the place"). */
const NEAR_HOME: Place = { lat: 52.2513843, lng: 20.8253459, label: "Warszawska 271" };
/** About 1 km from HOME (does not follow). */
const AWAY: Place = { lat: 52.2594843, lng: 20.8253459, label: "Lazurowa 1" };
const KRAKOW: Place = { lat: 50.0614, lng: 19.9366, label: "Rynek Główny" };
// Childcare at 40 an hour (a catalog rate), learning at a fixed 100.
const SERVICES = DEFAULT_SERVICES.map((s) =>
  s.id === "childcare" ? { ...s, price: { perHour: 40 } } : s.id === "learning" ? { ...s, price: { fixed: 100 } } : s
);
const CFG: EngineConfig = { ...DEFAULT_CONFIG, services: SERVICES, inviteCode: "PILOT", masters: [] };

let db: DbState;
let now: number;
let pushes: PushEvent[];
const at = <T>(fn: (e: Engine) => T): T => {
  const e = new Engine(db, CFG, now);
  const out = fn(e);
  pushes.push(...e.effects.push);
  return out;
};
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof ServerError ? e.code : String(e);
  }
};
const pub = (uid: string) => at((e) => e.getProfile(uid))!.publicId!;

function user(uid: string, nick: string, vehicle = false) {
  at((e) => e.join(uid, "pilot", `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
  if (vehicle) at((e) => e.saveVehicle(uid, { make: "Porsche", model: "Taycan", colour: "Zielony", plate: `W ${uid}`, seats: 4 }));
}

function request(uid: string, startMin: number, o: { service?: string; duration?: number; place?: Place | null; repeat?: RepeatInput } = {}): AppointmentView {
  return at((e) =>
    e.requestService(uid, {
      serviceId: o.service ?? "childcare",
      providerId: pub("siosia"),
      startsAt: now + startMin * MIN,
      durationMin: o.duration ?? 180,
      place: o.place === undefined ? HOME : o.place,
      note: "",
      repeat: o.repeat
    })
  );
}
/** An accepted childcare (provider Siosia) starting in `startMin` minutes. */
function planned(startMin: number, o: { service?: string; duration?: number; place?: Place | null } = {}): AppointmentView {
  const a = request("client", startMin, o);
  at((e) => e.answerAppointment("siosia", a.id, "accept"));
  return a;
}
const book = (uid: string, pickupMin: number, appointmentId: string, leg: Leg, from: Place = PARK, to: Place = HOME) =>
  at((e) => e.bookRide(uid, { pickup: from, dropoff: to, estKm: 20, estMin: 30, fareIsEstimate: false, scheduledFor: now + pickupMin * MIN, appointmentId, leg }));
const propose = (uid: string, id: string, input: ChangeInput) => at((e) => e.proposeChange(uid, id, input));
const answerC = (uid: string, id: string, d: "accept" | "decline" = "accept") => at((e) => e.answerChange(uid, id, d));
const withdraw = (uid: string, id: string) => at((e) => e.withdrawChange(uid, id));
const view = (uid: string, id: string) => at((e) => e.getAppointment(uid, id));
const appt = (id: string) => db.appointments![id];
const ride = (id: string) => db.rides[id];
const kinds = () => pushes.map((p) => p.kind);
const pushesOf = (kind: string) => pushes.filter((p) => p.kind === kind);
const changes = () => Object.values(db.changes ?? {});
const moveBy = (id: string, min: number, extra: Partial<ChangeInput> = {}): ChangeInput => ({ kind: "move", startsAt: appt(id).startsAt + min * MIN, ...extra });

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 20, 10, 0); // Tue 20 Oct 2026, 12:00 in Warsaw
  pushes = [];
  user("client", "Toria");
  user("siosia", "Siosia");
  user("driver", "Roman", true);
  user("driver2", "Karol", true);
  user("other", "Ewa");
  user("mum", "Mama");
  at((e) => e.setOffers("siosia", ["learning", "childcare"]));
  at((e) => e.inviteToFamily("client", pub("mum")));
  at((e) => e.answerInvite("mum", e.family("mum").incoming[0].id, "join"));
  pushes = [];
});

describe("who may propose, and the view per role (FR-330, V87, V90)", () => {
  it("the two parties only; family, drivers and strangers get not_found and see no change", () => {
    const a = planned(4 * 60);
    for (const u of ["mum", "other", "driver"]) expect(code(() => propose(u, a.id, moveBy(a.id, 60)))).toBe("not_found");
    expect(code(() => propose("client", "nope", moveBy(a.id, 60)))).toBe("not_found");
    propose("client", a.id, moveBy(a.id, 60, { note: "  later please  " }));
    const mine = view("client", a.id).change!;
    expect(mine).toMatchObject({ kind: "move", by: "client", mine: true, startsAt: appt(a.id).startsAt + HOUR, durationMin: 180, note: "later please", minutes: null });
    expect(view("siosia", a.id).change).toMatchObject({ by: "client", mine: false });
    expect(view("mum", a.id).role).toBe("family");
    expect(view("mum", a.id).change).toBeNull();
    // The family cannot answer either.
    expect(code(() => answerC("mum", a.id))).toBe("not_found");
  });

  it("the other party hears once, with the old and the new range (FR-334)", () => {
    const a = planned(4 * 60);
    const old = appt(a.id).startsAt;
    pushes = [];
    propose("client", a.id, moveBy(a.id, 60, { note: "dentist" }));
    expect(kinds()).toEqual(["appt_change_proposed"]);
    expect(pushes[0].userId).toBe("siosia");
    expect(pushes[0].appointmentId).toBe(a.id);
    expect(pushes[0].params).toMatchObject({ at: old + HOUR, end: old + 4 * HOUR, fromAt: old, fromEnd: old + 3 * HOUR, change: "move", who: "Toria", text: "dentist", place: HOME.label });
    expect(pushes[0].params.fromPlace).toBeUndefined();
    pushes = [];
    propose("client", a.id, { kind: "move", place: SCHOOL });
    expect(pushes[0].params).toMatchObject({ at: old, place: SCHOOL.label, fromPlace: HOME.label });
    expect(pushes[0].params.text).toBeUndefined();
  });
});

describe("move: window and checks (FR-330)", () => {
  it("only an accepted appointment before its start", () => {
    const r = request("client", 4 * 60);
    expect(code(() => propose("client", r.id, moveBy(r.id, 60)))).toBe("illegal_transition");
    const a = planned(2 * 60);
    now += 2 * HOUR + MIN;
    expect(code(() => propose("client", a.id, moveBy(a.id, 60)))).toBe("illegal_transition");
  });

  it("start, length, place and note follow the request rules; nothing different is no_change", () => {
    const a = planned(4 * 60);
    const start = appt(a.id).startsAt;
    expect(code(() => propose("client", a.id, { kind: "move", startsAt: now + 20 * MIN }))).toBe("bad_time");
    expect(code(() => propose("client", a.id, { kind: "move", startsAt: now + 31 * 86_400_000 }))).toBe("bad_time");
    expect(code(() => propose("client", a.id, { kind: "move", durationMin: 45 }))).toBe("bad_duration");
    expect(code(() => propose("client", a.id, { kind: "move", durationMin: 200 }))).toBe("bad_duration");
    expect(code(() => propose("client", a.id, { kind: "move", durationMin: 180.5 }))).toBe("bad_duration");
    expect(code(() => propose("client", a.id, { kind: "move", place: null }))).toBe("bad_input");
    expect(code(() => propose("client", a.id, { kind: "move", place: { ...SCHOOL, label: "  " } }))).toBe("bad_input");
    expect(code(() => propose("client", a.id, { kind: "move", place: { lat: 999, lng: 0, label: "x" } }))).toBe("bad_input");
    expect(code(() => propose("client", a.id, moveBy(a.id, 60, { note: "x".repeat(201) })))).toBe("bad_input");
    expect(code(() => propose("client", a.id, { kind: "move" }))).toBe("no_change");
    expect(code(() => propose("client", a.id, { kind: "move", startsAt: start, durationMin: 180, place: { ...HOME, label: ` ${HOME.label} ` } }))).toBe("no_change");
    expect(code(() => propose("client", a.id, { kind: "minutes" as never }))).toBe("bad_input");
    expect(changes()).toHaveLength(0);
    expect(code(() => propose("client", a.id, { kind: "move", durationMin: 240 }))).toBe("ok");
  });
});

describe("length: window and checks (FR-331)", () => {
  it("live or done within 24 h; minutes 15–1440 by 15; the same is no_change", () => {
    const a = planned(60);
    expect(code(() => propose("client", a.id, { kind: "length", minutes: 240 }))).toBe("illegal_transition"); // not started
    now += 90 * MIN;
    expect(code(() => propose("client", a.id, { kind: "length", minutes: 250 }))).toBe("bad_duration");
    expect(code(() => propose("client", a.id, { kind: "length", minutes: 0 }))).toBe("bad_duration");
    expect(code(() => propose("client", a.id, { kind: "length", minutes: 1455 }))).toBe("bad_duration");
    expect(code(() => propose("client", a.id, { kind: "length", minutes: 180 }))).toBe("no_change");
    expect(code(() => propose("client", a.id, { kind: "move", startsAt: now + HOUR }))).toBe("illegal_transition");
    expect(code(() => propose("siosia", a.id, { kind: "length", minutes: 240 }))).toBe("ok");
    expect(view("client", a.id).change).toMatchObject({ kind: "length", by: "provider", durationMin: 240, minutes: null, price: 160 });
    // Done: within 24 h of the end, then window_closed.
    now = appt(a.id).startsAt + 3 * HOUR + MIN;
    expect(view("client", a.id).status).toBe("done");
    expect(code(() => propose("siosia", a.id, { kind: "length", minutes: 180 }))).toBe("no_change");
    now += 24 * HOUR;
    expect(code(() => propose("siosia", a.id, { kind: "length", minutes: 150 }))).toBe("window_closed");
  });
});

describe("one pending change (FR-332)", () => {
  it("my own is replaced; the other party's becomes declined and its proposer hears", () => {
    const a = planned(4 * 60);
    propose("client", a.id, moveBy(a.id, 60));
    pushes = [];
    propose("client", a.id, moveBy(a.id, 90));
    expect(kinds()).toEqual(["appt_change_proposed"]);
    expect(changes().map((c) => c.status)).toEqual(["replaced", "proposed"]);
    pushes = [];
    propose("siosia", a.id, moveBy(a.id, 120));
    expect(changes().map((c) => c.status)).toEqual(["replaced", "declined", "proposed"]);
    expect(kinds()).toEqual(["appt_change_declined", "appt_change_proposed"]);
    expect(pushes[0]).toMatchObject({ userId: "client", params: { who: "Siosia", change: "move", at: appt(a.id).startsAt + 90 * MIN } });
    expect(pushes[1].userId).toBe("client");
    expect(view("siosia", a.id).change).toMatchObject({ by: "provider", mine: true, startsAt: appt(a.id).startsAt + 2 * HOUR });
  });

  it("withdraw: the proposer only, nobody told; answering then is illegal_transition", () => {
    const a = planned(4 * 60);
    expect(code(() => withdraw("client", a.id))).toBe("not_found"); // none at all
    expect(code(() => answerC("siosia", a.id))).toBe("not_found");
    propose("client", a.id, moveBy(a.id, 60));
    expect(code(() => withdraw("siosia", a.id))).toBe("not_found");
    expect(code(() => answerC("client", a.id))).toBe("not_found"); // the proposer cannot answer
    expect(code(() => answerC("siosia", a.id, "maybe" as never))).toBe("bad_input");
    pushes = [];
    expect(withdraw("client", a.id).change).toBeNull();
    expect(pushes).toEqual([]);
    expect(changes()[0].status).toBe("withdrawn");
    expect(code(() => answerC("siosia", a.id))).toBe("illegal_transition");
    expect(code(() => withdraw("client", a.id))).toBe("illegal_transition");
  });

  it("a move lapses when it could no longer be accepted (the booking lead before the earlier start), a length 24 h after the later end — nobody told", () => {
    const a = planned(4 * 60);
    const start = appt(a.id).startsAt;
    const lead = CFG.booking.minLeadMin * MIN;
    propose("client", a.id, { kind: "move", startsAt: start - HOUR });
    expect(view("siosia", a.id).change!.expiresAt).toBe(start - HOUR - lead);
    pushes = [];
    now = start - HOUR - lead;
    at((e) => e.sweep());
    expect(changes()[0].status).toBe("expired");
    expect(pushes.filter((p) => p.kind.startsWith("appt_change"))).toEqual([]);
    expect(code(() => answerC("siosia", a.id))).toBe("illegal_transition");

    const b = planned(2 * 24 * 60);
    now = appt(b.id).startsAt + HOUR;
    propose("client", b.id, { kind: "length", minutes: 240 });
    expect(view("client", b.id).change!.expiresAt).toBe(appt(b.id).startsAt + 4 * HOUR + 24 * HOUR);

    // An appointment no longer accepted or done takes its change along (withdrawn), even past its moment.
    const c = planned(3 * 24 * 60);
    propose("client", c.id, moveBy(c.id, 60));
    appt(c.id).status = "expired";
    now = appt(c.id).startsAt + MIN;
    at((e) => e.sweep());
    expect(changes().find((x) => x.appointmentId === c.id)!.status).toBe("withdrawn");
  });

  it("cancelling the appointment, or a party deleting their profile, withdraws it", () => {
    const a = planned(4 * 60);
    propose("client", a.id, moveBy(a.id, 60));
    at((e) => e.cancelAppointment("siosia", a.id, null, "one"));
    expect(changes()[0].status).toBe("withdrawn");
    const b = planned(6 * 60);
    propose("siosia", b.id, moveBy(b.id, 60));
    at((e) => e.deleteProfile("client"));
    expect(changes()[1].status).toBe("withdrawn");
  });

  it("toAnswer counts the changes waiting for me (V90)", () => {
    const a = planned(4 * 60);
    const b = planned(8 * 60);
    const base = at((e) => e.myState("siosia")).toAnswer;
    propose("client", a.id, moveBy(a.id, 60));
    propose("client", b.id, moveBy(b.id, 60));
    expect(at((e) => e.myState("siosia")).toAnswer).toBe(base + 2);
    expect(at((e) => e.myState("client")).toAnswer).toBe(0);
    answerC("siosia", a.id, "decline");
    expect(at((e) => e.myState("siosia")).toAnswer).toBe(base + 1);
  });

  it("P1 lists a finished appointment with a new length pending, to its two parties only", () => {
    const a = planned(2 * 24 * 60);
    const b = planned(60);
    now = appt(b.id).startsAt + 3 * HOUR + 30 * MIN;
    at((e) => e.sweep());
    expect(appt(b.id).status).toBe("done");
    expect(at((e) => e.planned("siosia")).appointments.map((x) => x.id)).toEqual([a.id]);
    propose("client", b.id, { kind: "length", minutes: 120 });
    propose("client", a.id, { kind: "move", durationMin: 120 });
    expect(at((e) => e.planned("siosia")).appointments.map((x) => [x.id, x.status, x.change?.mine])).toEqual([
      [b.id, "done", false],
      [a.id, "accepted", false]
    ]);
    expect(at((e) => e.planned("client")).appointments.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(at((e) => e.planned("mum")).appointments.map((x) => x.id)).toEqual([a.id]);
    expect(at((e) => e.myState("siosia")).toAnswer).toBe(2);
    withdraw("client", b.id);
    expect(at((e) => e.planned("siosia")).appointments.map((x) => x.id)).toEqual([a.id]);
  });

  it("the proposer follows the account when it moves (merge re-keys proposed_by)", () => {
    const a = planned(4 * 60);
    propose("client", a.id, moveBy(a.id, 60));
    expect(at((e) => e.mergeAccounts("client", "client2", "operator"))).toBe("move");
    expect(changes()[0].proposedBy).toBe("client2");
    pushes = [];
    answerC("siosia", a.id);
    expect(pushesOf("appt_change_accepted").map((p) => p.userId)).toEqual(["client2"]);
  });
});

describe("accept (FR-333, V88)", () => {
  it("decline: the proposer hears, nothing moves", () => {
    const a = planned(4 * 60);
    const start = appt(a.id).startsAt;
    propose("siosia", a.id, moveBy(a.id, 60));
    pushes = [];
    answerC("client", a.id, "decline");
    expect(kinds()).toEqual(["appt_change_declined"]);
    expect(pushes[0]).toMatchObject({ userId: "siosia", params: { who: "Toria", at: start + HOUR, fromAt: start } });
    expect(appt(a.id).startsAt).toBe(start);
  });

  it("a move takes start, length, place; the price follows the stored rate; the proposer hears", () => {
    const a = planned(4 * 60);
    const start = appt(a.id).startsAt;
    expect(appt(a.id).price).toBe(120);
    propose("client", a.id, { kind: "move", startsAt: start + HOUR, durationMin: 240, place: SCHOOL });
    expect(view("siosia", a.id).change!.price).toBe(160);
    pushes = [];
    const v = answerC("siosia", a.id);
    expect(v).toMatchObject({ startsAt: start + HOUR, durationMin: 240, place: SCHOOL, price: 160, change: null });
    expect(kinds()).toEqual(["appt_change_accepted"]);
    expect(pushes[0]).toMatchObject({ userId: "client", params: { at: start + HOUR, end: start + 5 * HOUR, fromAt: start, fromEnd: start + 3 * HOUR, place: SCHOOL.label, fromPlace: HOME.label, who: "Siosia" } });
    expect(changes()[0]).toMatchObject({ status: "accepted", answeredAt: now });
  });

  it("a fixed price stays", () => {
    const a = planned(4 * 60, { service: "learning", duration: 60 });
    expect(appt(a.id).price).toBe(100);
    propose("client", a.id, { kind: "move", durationMin: 120 });
    expect(view("client", a.id).change!.price).toBe(100);
    answerC("siosia", a.id);
    expect(appt(a.id)).toMatchObject({ durationMin: 120, price: 100 });
  });

  it("everything is checked again: the new time must still be ahead, the provider free (overlap)", () => {
    const a = planned(4 * 60);
    propose("client", a.id, { kind: "move", startsAt: now + 6 * HOUR });
    const b = request("client", 7 * 60, { duration: 60 });
    at((e) => e.answerAppointment("siosia", b.id, "accept"));
    expect(code(() => answerC("siosia", a.id))).toBe("overlap");
    at((e) => e.cancelAppointment("client", b.id, null, "one"));
    // A move to 40 min ahead: fine when proposed and up to the booking lead before it (B13: never a
    // pending change that can only fail with bad_time), lapsed after that.
    const c = planned(10 * 60);
    propose("client", c.id, { kind: "move", startsAt: now + 40 * MIN });
    now += 15 * MIN;
    expect(code(() => answerC("siosia", c.id))).toBe("illegal_transition");
    expect(changes().find((x) => x.appointmentId === c.id)!.status).toBe("expired");
    now -= 15 * MIN;
    expect(code(() => answerC("siosia", a.id))).toBe("ok");
  });

  it("reminders: the slots already past for the new start count as sent, the rest go out again", () => {
    const a = planned(3 * 24 * 60);
    now = appt(a.id).startsAt - 23 * HOUR;
    at((e) => e.sweep());
    expect(appt(a.id).reminded).toEqual([1440]);
    // Later by two days: the day-before reminder is due again.
    propose("client", a.id, moveBy(a.id, 2 * 24 * 60));
    answerC("siosia", a.id);
    expect(appt(a.id).reminded).toEqual([]);
    pushes = [];
    now = appt(a.id).startsAt - 24 * HOUR;
    at((e) => e.sweep());
    expect(pushesOf("appt_reminder").map((p) => p.userId).sort()).toEqual(["client", "siosia"]);
    // Earlier, to 90 min ahead: both slots already past — no burst.
    propose("siosia", a.id, { kind: "move", startsAt: now + 90 * MIN });
    answerC("client", a.id);
    expect(appt(a.id).reminded).toEqual([1440, 120]);
    pushes = [];
    at((e) => e.sweep());
    expect(pushesOf("appt_reminder")).toEqual([]);
  });

  it("a longer live session: duration and price follow; a done one: actual minutes and a corrected summary", () => {
    const a = planned(60);
    now += 2 * HOUR;
    propose("siosia", a.id, { kind: "length", minutes: 240 });
    answerC("client", a.id);
    expect(appt(a.id)).toMatchObject({ status: "accepted", durationMin: 240, price: 160 });
    now = appt(a.id).startsAt + 4 * HOUR;
    at((e) => e.sweep());
    expect(appt(a.id).status).toBe("done");
    expect(view("client", a.id).cost).toMatchObject({ minutes: 240, total: 160, corrected: false });
    propose("client", a.id, { kind: "length", minutes: 210 });
    expect(view("siosia", a.id).change).toMatchObject({ durationMin: 240, minutes: 210, price: 140, endsAt: appt(a.id).startsAt + 210 * MIN, rides: [] });
    pushes = [];
    answerC("siosia", a.id);
    expect(appt(a.id)).toMatchObject({ actualMin: 210, durationMin: 240, price: 160 });
    expect(view("client", a.id).cost).toMatchObject({ minutes: 210, total: 140, corrected: true });
    expect(kinds()).toEqual(["appt_change_accepted", "appt_summary", "appt_summary"]);
    expect(pushesOf("appt_summary").map((p) => p.userId).sort()).toEqual(["client", "mum"]);
    // Back to the booked time: actual minutes clear.
    propose("client", a.id, { kind: "length", minutes: 240 });
    answerC("siosia", a.id);
    expect(appt(a.id).actualMin).toBeNull();
  });
});

describe("rides follow (FR-333, V89)", () => {
  it("there by the start's shift, back by the end's shift; the preview says so", () => {
    const a = planned(5 * 60);
    const start = appt(a.id).startsAt;
    const there = book("client", 4 * 60, a.id, "there");
    const back = book("client", 8 * 60 + 5, a.id, "back", HOME, PARK);
    propose("siosia", a.id, { kind: "move", startsAt: start + HOUR, durationMin: 240 });
    const rides = view("client", a.id).change!.rides;
    expect(rides).toEqual([
      expect.objectContaining({ rideId: there.id, leg: "there", passenger: "client", mine: true, from: start - HOUR, to: start, effect: "move" }),
      expect.objectContaining({ rideId: back.id, leg: "back", from: start + 3 * HOUR + 5 * MIN, to: start + 5 * HOUR + 5 * MIN, effect: "move" })
    ]);
    expect(view("siosia", a.id).change!.rides[0].mine).toBe(false);
    // Places and fare unchanged: none shown, even to the passenger (FR-114: only when they change).
    expect(rides[0].pickup).toBeUndefined();
    expect(rides[0].fare).toBeUndefined();
    answerC("client", a.id);
    expect(ride(there.id)).toMatchObject({ status: "scheduled", scheduledFor: start, dispatchStartedAt: start, pickup: PARK, fare: there.fare });
    expect(ride(back.id).scheduledFor).toBe(start + 5 * HOUR + 5 * MIN);
  });

  it("a shorter appointment pulls the back ride no earlier than the new start", () => {
    const a = planned(5 * 60);
    const start = appt(a.id).startsAt;
    const back = book("client", 5 * 60 + 10, a.id, "back", HOME, PARK);
    propose("client", a.id, { kind: "move", durationMin: 60 });
    expect(view("siosia", a.id).change!.rides[0]).toMatchObject({ from: start + 10 * MIN, to: start, effect: "move" });
    answerC("siosia", a.id);
    expect(ride(back.id).scheduledFor).toBe(start);
  });

  it("a ride whose new time is too soon is cancelled (appointment_changed) and its driver told", () => {
    const a = planned(3 * 60);
    const there = book("client", 2 * 60, a.id, "there");
    at((e) => e.claimBooking("driver", there.id));
    propose("client", a.id, { kind: "move", startsAt: now + 60 * MIN });
    expect(view("client", a.id).change!.rides[0]).toMatchObject({ effect: "cancel", to: null });
    pushes = [];
    answerC("siosia", a.id);
    expect(ride(there.id)).toMatchObject({ status: "cancelled", cancelledBy: "system", cancelReason: "appointment_changed" });
    // No appt_ride_failed: a ride the change cancelled goes like a cancelled appointment's.
    expect(kinds().sort()).toEqual(["appt_change_accepted", "booking_cancelled"]);
    expect(pushesOf("booking_cancelled")[0].userId).toBe("driver");
    expect(view("client", a.id).rides).toEqual([]);
    // Booked again by hand.
    expect(code(() => book("client", 20, a.id, "there"))).toBe("bad_time");
    expect(code(() => book("client", 30, a.id, "there"))).toBe("ok");
  });

  it("a ride already dispatched refuses (ride_started) when proposing and when accepting; the view still shows it", () => {
    const a = planned(5 * 60);
    const there = book("client", 4 * 60, a.id, "there");
    at((e) => e.claimBooking("driver", there.id));
    propose("client", a.id, moveBy(a.id, 60));
    now += 3 * 60 * MIN + 31 * MIN; // the driver's time to go
    at((e) => e.sweep());
    expect(ride(there.id).status).toBe("accepted");
    expect(view("siosia", a.id).change!.rides[0]).toMatchObject({ rideId: there.id, effect: "keep" });
    expect(code(() => answerC("siosia", a.id))).toBe("ride_started");
    expect(code(() => propose("siosia", a.id, moveBy(a.id, 30)))).toBe("ride_started");
    // A change that leaves that ride alone is fine (a later end moves only the back leg).
    expect(code(() => propose("siosia", a.id, { kind: "move", durationMin: 240 }))).toBe("ok");
  });

  it("my new pickup with the phone's estimate: fare by the booking rules, shown to me only", () => {
    const a = planned(5 * 60);
    const there = book("client", 4 * 60, a.id, "there");
    expect(code(() => propose("siosia", a.id, { kind: "move", pickups: [{ leg: "there", pickup: SCHOOL, estKm: 3, estMin: 9, fareIsEstimate: true }] }))).toBe("forbidden");
    expect(code(() => propose("client", a.id, { kind: "move", pickups: [{ leg: "back", pickup: SCHOOL, estKm: 3, estMin: 9, fareIsEstimate: true }] }))).toBe("bad_leg");
    expect(code(() => propose("client", a.id, { kind: "move", pickups: [{ leg: "there", pickup: SCHOOL, estKm: 0, estMin: 9, fareIsEstimate: true }] }))).toBe("bad_input");
    expect(code(() => propose("client", a.id, { kind: "move", pickups: [{ leg: "side" as Leg, pickup: SCHOOL, estKm: 3, estMin: 9, fareIsEstimate: true }] }))).toBe("bad_leg");
    expect(code(() => propose("client", a.id, { kind: "move", pickups: [{ leg: "there", pickup: SCHOOL, estKm: 3, estMin: 1441, fareIsEstimate: true }] }))).toBe("bad_input");
    const twice = { leg: "there" as Leg, pickup: SCHOOL, estKm: 3, estMin: 9, fareIsEstimate: true };
    expect(code(() => propose("client", a.id, { kind: "move", pickups: [twice, twice] }))).toBe("bad_input");
    expect(code(() => propose("client", a.id, { kind: "move", pickups: [{ leg: "there", pickup: KRAKOW, estKm: 300, estMin: 200, fareIsEstimate: true }] }))).toBe("too_far");
    // A pickup alone is a change (same time); the estimate never under the straight line.
    propose("client", a.id, { kind: "move", pickups: [{ leg: "there", pickup: SCHOOL, estKm: 0.5, estMin: 9, fareIsEstimate: true }] });
    const km = haversineKm(SCHOOL, HOME);
    const fare = computeFare(CFG.tariff, km, 9);
    expect(view("client", a.id).change!.rides[0]).toMatchObject({ effect: "move", to: there.scheduledFor, pickup: SCHOOL, dropoff: HOME, fare });
    const theirs = view("siosia", a.id).change!.rides[0];
    expect(theirs.effect).toBe("move");
    expect(theirs.pickup).toBeUndefined();
    expect(theirs.fare).toBeUndefined();
    answerC("siosia", a.id);
    expect(ride(there.id)).toMatchObject({ pickup: SCHOOL, estKm: Math.round(km * 10) / 10, estMin: 9, fare, fareIsEstimate: true, scheduledFor: there.scheduledFor });
  });

  it("outside the service area at acceptance → outside_area", () => {
    const a = planned(5 * 60);
    book("client", 4 * 60, a.id, "there");
    propose("client", a.id, { kind: "move", pickups: [{ leg: "there", pickup: SCHOOL, estKm: 3, estMin: 9, fareIsEstimate: false }] });
    const e2 = new Engine(db, { ...CFG, serviceArea: { lat: 50, lng: 19, radiusKm: 20 } }, now);
    // The view never fails: that ride shows as kept.
    expect(e2.getAppointment("siosia", a.id).change!.rides[0]).toMatchObject({ effect: "keep" });
    expect(code(() => e2.answerChange("siosia", a.id, "accept"))).toBe("outside_area");
  });

  it("a new place: rides at the old place (≤ 150 m) follow it, others stay", () => {
    const a = planned(5 * 60);
    const there = book("client", 4 * 60, a.id, "there", PARK, NEAR_HOME);
    const back = book("client", 8 * 60 + 5, a.id, "back", NEAR_HOME, PARK);
    const far = book("siosia", 4 * 60, a.id, "there", PARK, AWAY); // ~1 km from HOME: stays
    propose("siosia", a.id, { kind: "move", place: SCHOOL });
    const mine = view("client", a.id).change!.rides;
    expect(mine.map((x) => [x.rideId, x.effect, x.dropoff?.label ?? null])).toEqual([
      [there.id, "move", SCHOOL.label],
      [far.id, "keep", null],
      [back.id, "move", PARK.label]
    ]);
    answerC("client", a.id);
    expect(ride(there.id)).toMatchObject({ pickup: PARK, dropoff: SCHOOL, fareIsEstimate: true });
    expect(ride(back.id)).toMatchObject({ pickup: SCHOOL, dropoff: PARK, fareIsEstimate: true });
    expect(ride(far.id)).toMatchObject({ pickup: PARK, dropoff: AWAY, estKm: 20, fare: far.fare });
  });

  it("the place followed keeps the old route's ratio to the straight line (clamped 1–3)", () => {
    const a = planned(5 * 60, { place: HOME });
    const there = book("client", 4 * 60, a.id, "there", SCHOOL, NEAR_HOME);
    propose("siosia", a.id, { kind: "move", place: PARK });
    const oldStraight = haversineKm(SCHOOL, NEAR_HOME);
    const ratio = Math.min(3, Math.max(1, 20 / Math.max(oldStraight, 0.1)));
    const km = haversineKm(SCHOOL, PARK) * ratio;
    const min = Math.max(1, Math.round((30 * km) / 20));
    answerC("client", a.id);
    expect(ratio).toBe(3);
    expect(ride(there.id)).toMatchObject({ dropoff: PARK, estKm: Math.round(km * 10) / 10, estMin: min, fare: computeFare(CFG.tariff, km, min), fareIsEstimate: true });
  });

  it("a driver who is still free keeps the booking and hears it moved", () => {
    const a = planned(5 * 60);
    const there = book("client", 4 * 60, a.id, "there");
    at((e) => e.claimBooking("driver", there.id));
    propose("client", a.id, moveBy(a.id, 60));
    pushes = [];
    answerC("siosia", a.id);
    expect(ride(there.id).driverId).toBe("driver");
    const moved = pushesOf("booking_moved");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ userId: "driver", rideId: there.id, params: { at: there.scheduledFor! + HOUR, fromAt: there.scheduledFor, pickup: PARK.label, dropped: false } });
    expect(pushesOf("booking_new")).toEqual([]);
  });

  it("a driver whose other booking clashes at the new time is dropped; the ride is offered again", () => {
    const a = planned(5 * 60);
    const there = book("client", 4 * 60, a.id, "there");
    at((e) => e.claimBooking("driver", there.id));
    const otherRide = at((e) => e.bookRide("other", { pickup: PARK, dropoff: SCHOOL, estKm: 5, estMin: 15, fareIsEstimate: false, scheduledFor: now + 5 * 60 * MIN }));
    at((e) => e.claimBooking("driver", otherRide.id));
    propose("client", a.id, moveBy(a.id, 60));
    pushes = [];
    answerC("siosia", a.id);
    expect(ride(there.id).driverId).toBeNull();
    expect(pushesOf("booking_moved")[0]).toMatchObject({ userId: "driver", params: { dropped: true, fromAt: there.scheduledFor } });
    expect(pushesOf("booking_new").map((p) => p.userId).sort()).toEqual(["driver", "driver2"]);
    // The other party hears there is no driver yet (as the SQL rides trigger tells it).
    expect(pushesOf("appt_ride_lost").map((p) => p.userId)).toEqual(["siosia"]);
    expect(view("siosia", a.id).rides[0]).toMatchObject({ status: "pending", driver: null });
  });

  it("a driver who provides an accepted appointment at the new time is dropped too", () => {
    const a = planned(5 * 60);
    const there = book("client", 4 * 60, a.id, "there");
    at((e) => e.claimBooking("driver", there.id));
    at((e) => e.setOffers("driver", ["childcare"]));
    const busy = at((e) =>
      e.requestService("other", { serviceId: "childcare", providerId: pub("driver"), startsAt: now + 5 * 60 * MIN, durationMin: 60, place: HOME, note: "" })
    );
    at((e) => e.answerAppointment("driver", busy.id, "accept"));
    propose("client", a.id, moveBy(a.id, 60));
    answerC("siosia", a.id);
    expect(ride(there.id).driverId).toBeNull();
  });
});

describe("series: moved dates and gaps at the rule's slot (FR-336)", () => {
  it("a moved date is listed with its slot; cancelled, its gap is the slot", () => {
    const a = request("client", 24 * 60, { repeat: { every: 1, count: 3 } });
    at((e) => e.answerAppointment("siosia", a.id, "accept"));
    const occ = Object.values(db.appointments!).filter((x) => x.seriesId).sort((x, y) => x.seq! - y.seq!);
    const first = occ[0].startsAt;
    const slot2 = addWeeksWallClock(first, 1, CFG.timezone);
    expect(occ[1].startsAt).toBe(slot2);
    let s = view("client", a.id).series!;
    expect(s).toMatchObject({ first, durationMin: 180, place: HOME, moved: [] });
    propose("client", occ[1].id, { kind: "move", startsAt: slot2 + HOUR });
    answerC("siosia", occ[1].id);
    s = view("client", a.id).series!;
    expect(s.moved).toEqual([{ orig: slot2, start: slot2 + HOUR, end: slot2 + 4 * HOUR, place: HOME }]);
    expect(s.starts[1]).toBe(slot2 + HOUR);
    // the series keeps its own place (the calendar's repeating event), whatever date is viewed
    expect(view("client", occ[1].id).series!.place).toEqual(HOME);
    at((e) => e.cancelAppointment("client", occ[1].id, null, "one"));
    s = view("client", a.id).series!;
    expect(s.moved).toEqual([]);
    expect(s.gaps).toEqual([slot2]);
  });
});

// B13 (2026-11-03, the 2.14 pre-release review): the real findings, each pinned (twins in sql-change).
describe("2.14 review fixes (B13)", () => {
  const car = (uid: string) => at((e) => e.saveVehicle(uid, { make: "Kia", model: "Ceed", colour: "Szary", plate: `W ${uid}`, seats: 4 }));

  it("the provider driving their own appointment's ride: an extension and a move are accepted, the ride follows (V88)", () => {
    car("siosia");
    // a back ride the provider drives, extended while live
    const a = planned(60);
    const s = appt(a.id).startsAt;
    const back = book("client", 60 + 180, a.id, "back", HOME, PARK);
    at((e) => e.claimBooking("siosia", back.id));
    now = s + 30 * MIN;
    propose("client", a.id, { kind: "length", minutes: 240 });
    expect(code(() => answerC("siosia", a.id))).toBe("ok");
    expect(ride(back.id)).toMatchObject({ scheduledFor: s + 240 * MIN, driverId: "siosia" });
    // a move later with the back ride, and earlier with the there ride she drives
    const b = planned(2 * 24 * 60);
    const sb = appt(b.id).startsAt;
    const there = book("client", 2 * 24 * 60 - 30, b.id, "there");
    const back2 = book("client", 2 * 24 * 60 + 180, b.id, "back", HOME, PARK);
    at((e) => e.claimBooking("siosia", back2.id));
    propose("client", b.id, moveBy(b.id, 60));
    pushes = [];
    expect(code(() => answerC("siosia", b.id))).toBe("ok");
    expect(ride(back2.id)).toMatchObject({ scheduledFor: sb + 240 * MIN, driverId: "siosia" });
    expect(pushesOf("booking_moved").map((p) => [p.userId, p.params.dropped])).toEqual([["siosia", false]]);
    at((e) => e.releaseBooking("siosia", back2.id));
    at((e) => e.claimBooking("siosia", there.id));
    propose("client", b.id, moveBy(b.id, -15));
    expect(code(() => answerC("siosia", b.id))).toBe("ok");
    expect(ride(there.id)).toMatchObject({ scheduledFor: sb + 15 * MIN, driverId: "siosia" });
  });

  it("a driver on both legs is judged at both new times and keeps them (V89)", () => {
    const a = planned(5 * 60);
    const s = appt(a.id).startsAt;
    const there = book("client", 5 * 60 - 30, a.id, "there");
    const back = book("client", 5 * 60 + 180, a.id, "back", HOME, PARK);
    at((e) => e.claimBooking("driver", there.id));
    at((e) => e.claimBooking("driver", back.id));
    propose("client", a.id, moveBy(a.id, 180));
    pushes = [];
    answerC("siosia", a.id);
    expect([ride(there.id), ride(back.id)].map((r) => [r.scheduledFor, r.driverId])).toEqual([
      [s + 150 * MIN, "driver"],
      [s + 360 * MIN, "driver"]
    ]);
    expect(pushesOf("booking_moved").map((p) => p.params.dropped)).toEqual([false, false]);
    expect(kinds()).not.toContain("appt_ride_lost");
    expect(kinds()).not.toContain("booking_new");
  });

  it("my new pickup and a moved place: the there ride still goes to the new place (FR-333)", () => {
    const a = planned(5 * 60);
    const there = book("client", 4 * 60, a.id, "there", PARK, NEAR_HOME);
    propose("client", a.id, { kind: "move", place: SCHOOL, pickups: [{ leg: "there", pickup: AWAY, estKm: 5, estMin: 12, fareIsEstimate: false }] });
    expect(view("client", a.id).change!.rides[0]).toMatchObject({ effect: "move", pickup: AWAY, dropoff: SCHOOL });
    answerC("siosia", a.id);
    expect(ride(there.id)).toMatchObject({ pickup: AWAY, dropoff: SCHOOL, estMin: 12, fareIsEstimate: false });
    expect(ride(there.id).estKm).toBe(Math.round(Math.max(5, haversineKm(AWAY, SCHOOL)) * 10) / 10);
  });

  it("a length proposed live, viewed after the end: the booked length and the new end; acceptable until it lapses", () => {
    const a = planned(60);
    const s = appt(a.id).startsAt;
    now = s + 30 * MIN;
    propose("client", a.id, { kind: "length", minutes: 240 });
    now = s + 190 * MIN;
    at((e) => e.sweep());
    expect(appt(a.id).status).toBe("done");
    expect(view("siosia", a.id).change).toMatchObject({ durationMin: 180, minutes: 240, endsAt: s + 240 * MIN, expiresAt: s + 240 * MIN + 24 * HOUR });
    // past the end + 24 h but before the stored lapse: still acceptable (never a dead Accept)
    now = s + 180 * MIN + 24 * HOUR + 30 * MIN;
    expect(code(() => answerC("siosia", a.id))).toBe("ok");
    expect(appt(a.id).actualMin).toBe(240);
  });

  it("the note is trimmed of all white space; odd pickup numbers are refused or kept to 3 decimals", () => {
    const a = planned(4 * 60);
    propose("client", a.id, moveBy(a.id, 60, { note: "\n" }));
    expect(view("client", a.id).change!.note).toBe("");
    expect(pushesOf("appt_change_proposed").at(-1)!.params).not.toHaveProperty("text");
    propose("client", a.id, moveBy(a.id, 60, { note: "ok\n\t" }));
    expect(view("client", a.id).change!.note).toBe("ok");
    const b = planned(9 * 60);
    book("client", 9 * 60 - 30, b.id, "there");
    const pick = (o: object) => ({ kind: "move" as const, pickups: [{ leg: "there" as const, pickup: AWAY, estKm: 5, estMin: 12, fareIsEstimate: false, ...o }] });
    expect(code(() => propose("client", b.id, pick({ estKm: Infinity })))).toBe("bad_input");
    expect(code(() => propose("client", b.id, pick({ estKm: 0.0004 })))).toBe("bad_input");
    expect(code(() => propose("client", b.id, pick({ estKm: 100_001 })))).toBe("bad_input");
    propose("client", b.id, pick({ estKm: 5.12345, estMin: 1e-300, fareIsEstimate: "maybe" as unknown as boolean }));
    expect(changes().find((c) => c.appointmentId === b.id && c.status === "proposed")!.pickups[0]).toMatchObject({ estKm: 5.123, estMin: 0, fareIsEstimate: false });
  });

  it("a master's fixed fare stays on a moved ride whose place followed", () => {
    const MASTERS = [{ id: "mt", token: "mt-link-token-0123456789", nickname: "Toria", icon: null, fixedFare: 18, role: "rider" as const }];
    const M = <T>(fn: (e: Engine) => T): T => {
      const e = new Engine(db, { ...CFG, masters: MASTERS }, now);
      const out = fn(e);
      pushes.push(...e.effects.push);
      return out;
    };
    db.users.client.masterId = "mt";
    const a = planned(5 * 60);
    const there = M((e) => e.bookRide("client", { pickup: PARK, dropoff: NEAR_HOME, estKm: 20, estMin: 30, fareIsEstimate: true, scheduledFor: now + 4 * 60 * MIN, appointmentId: a.id, leg: "there" }));
    expect(ride(there.id)).toMatchObject({ fare: 18, fareIsEstimate: false });
    M((e) => e.proposeChange("siosia", a.id, { kind: "move", place: SCHOOL }));
    M((e) => e.answerChange("client", a.id, "accept"));
    expect(ride(there.id)).toMatchObject({ dropoff: SCHOOL, fare: 18, fareIsEstimate: false });
  });

  it("the proposer follows the account when it moves to another phone (redeemTransfer re-keys proposedBy)", () => {
    const a = planned(4 * 60);
    propose("client", a.id, moveBy(a.id, 60));
    const { code: t } = at((e) => e.createTransfer("client"));
    at((e) => e.join("client2", "pilot", "dev-c2"));
    at((e) => e.redeemTransfer("client2", t, "dev-c2"));
    expect(changes()[0].proposedBy).toBe("client2");
    expect(view("client2", a.id).change).toMatchObject({ mine: true, by: "client" });
    expect(withdraw("client2", a.id).change).toBeNull();
  });
});
