// Siosia 2.9 server rules in the engine (the SQL twin is tests/unit/sql-notify-tips.test.ts — same
// cases, V19): the notifications bell (V73) and tips after an appointment or a ride (V74).

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent } from "../../src/core/engine";
import { destination } from "../../src/core/geo";
import { ServerError, type AppointmentView, type LatLng, type Place, type RideView } from "../../src/core/types";
import { pushUrl } from "../../supabase/functions/_shared/push-text";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const PICKUP = { lat: 52.2297, lng: 21.0122, label: "Centrum" };
const DROPOFF = { ...destination(PICKUP, 60, 3), label: "Praga" };
const CFG: EngineConfig = { ...DEFAULT_CONFIG, services: DEFAULT_SERVICES, inviteCode: "PILOT" };

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
const sent = () => pushes.map((p) => `${p.kind}>${p.userId}`).sort();
const bell = (uid: string) => at((e) => e.notifications(uid));

function user(uid: string, nick: string, vehicle = false) {
  at((e) => e.join(uid, "pilot", `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
  if (vehicle) at((e) => e.saveVehicle(uid, { make: "Toyota", model: "Yaris", colour: "Red", plate: `wx ${uid}`, seats: 4 }));
}
function request(uid: string, provider: string, startMin = 26 * 60): AppointmentView {
  return at((e) =>
    e.requestService(uid, { serviceId: "childcare", providerId: pub(provider), startsAt: now + startMin * MIN, durationMin: 180, place: HOME, note: "" })
  );
}
/** An accepted appointment, then the clock at its end (the sweep marks it done). */
function done(uid: string, provider: string): AppointmentView {
  const a = request(uid, provider);
  at((e) => e.answerAppointment(provider, a.id, "accept"));
  now = a.endsAt;
  at((e) => e.sweep());
  return a;
}
/** A ride from request to completed with d1. */
function ride(): RideView {
  const r = at((e) => e.requestRide("dad", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3.42, estMin: 8.6, fareIsEstimate: false }));
  const near: LatLng = destination(PICKUP, 0, 1);
  at((e) => e.setOnline("d1", true));
  const offer = at((e) => e.heartbeat("d1", near)).offer!;
  at((e) => e.decideOffer("d1", offer.id, "accept"));
  for (const to of ["arrived", "in_progress", "completed"] as const) at((e) => e.advance("d1", r.id, to, 3));
  at((e) => e.setOnline("d1", false));
  return at((e) => e.getRide("dad", r.id));
}

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 20, 10, 0); // Tue 20 Oct 2026, 12:00 in Warsaw
  pushes = [];
  user("dad", "Roman");
  user("mum", "Anna");
  user("nanny", "Toria");
  user("other", "Ewa");
  user("d1", "Adam", true);
  at((e) => e.setOffers("nanny", ["childcare"]));
  at((e) => e.inviteToFamily("dad", pub("mum")));
  at((e) => e.answerInvite("mum", e.family("mum").incoming[0].id, "join"));
  db.notifications = [];
  pushes = [];
});

describe("the notifications bell (FR-311–313, V73)", () => {
  it("keeps what was notified (but chat), newest first, with an unread count that opening clears", () => {
    const a = request("dad", "nanny");
    let b = bell("nanny");
    expect(b.unread).toBe(1);
    expect(b.items).toEqual([expect.objectContaining({ kind: "appt_new", appointmentId: a.id, rideId: null, read: false, createdAt: now })]);
    expect(b.items[0].params).toMatchObject({ service: "Childcare", client: "Roman" });
    expect(at((e) => e.myState("nanny")).unreadNotifications).toBe(1);
    expect(bell("other")).toEqual({ items: [], unread: 0 });
    now += MIN;
    at((e) => e.answerAppointment("nanny", a.id, "accept"));
    expect(bell("dad").items.map((n) => n.kind)).toEqual(["appt_accepted"]);
    // A chat message is a push, never a bell entry.
    pushes = [];
    at((e) => e.sendMessage("nanny", `appt:${a.id}`, "Hi!"));
    expect(sent()).toEqual(["chat_message>dad"]);
    expect(bell("dad").items).toHaveLength(1);
    now += MIN;
    at((e) => e.readNotifications("nanny"));
    b = bell("nanny");
    expect(b.unread).toBe(0);
    expect(b.items.every((n) => n.read)).toBe(true);
    expect(at((e) => e.myState("nanny")).unreadNotifications).toBe(0);
  });

  it("lists the newest 50 of the last 60 days, keeps 200 per member; a booking reaches every driver's bell", () => {
    for (let i = 0; i < 205; i++) {
      at((e) => e.inviteToFamily("other", pub("nanny")));
      at((e) => e.withdrawInvite("other", e.family("other").invites[0].id));
    }
    expect(db.notifications!.filter((n) => n.userId === "nanny")).toHaveLength(200);
    const b = bell("nanny");
    expect(b.items).toHaveLength(50);
    expect(b.unread).toBe(200);
    expect(Number(b.items[0].createdAt)).toBeGreaterThanOrEqual(Number(b.items[49].createdAt));
    now += 61 * DAY;
    expect(bell("nanny")).toEqual({ items: [], unread: 0 });
    // A booking: every driver who could take it finds it in the bell (with notifications on or not).
    const r = at((e) => e.bookRide("dad", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3.42, estMin: 8.6, fareIsEstimate: false, scheduledFor: now + 2 * 60 * MIN }));
    expect(bell("d1").items[0]).toMatchObject({ kind: "booking_new", rideId: r.id, params: { pickup: "Centrum", dropoff: "Praga" } });
    expect(bell("mum").items).toEqual([]);
  });

  it("opens what a notification is about (the push's URL)", () => {
    expect(pushUrl("appt_tip", {}, "a1")).toBe("./?appointment=a1");
    expect(pushUrl("ride_tip", {})).toBe("./?open=history");
    expect(pushUrl("appt_new", {}, "a1")).toBe("./?open=planned");
    expect(pushUrl("contract_proposed", {})).toBe("./?open=family");
    expect(pushUrl("driver_arrived", {})).toBe("./");
  });

  it("goes with a deleted profile", () => {
    request("dad", "nanny");
    at((e) => e.deleteProfile("nanny"));
    expect(db.notifications!.some((n) => n.userId === "nanny")).toBe(false);
  });
});

describe("tips (FR-314–316, V74)", () => {
  it("the client side tips the provider once after a done appointment, within 7 days", () => {
    const a = request("dad", "nanny");
    expect(code(() => at((e) => e.tipAppointment("dad", a.id, 10)))).toBe("illegal_transition");
    at((e) => e.answerAppointment("nanny", a.id, "accept"));
    now = a.endsAt;
    at((e) => e.sweep());
    pushes = [];
    for (const bad of [0, 0.99, 1000.01, Number.NaN]) expect(code(() => at((e) => e.tipAppointment("mum", a.id, bad))), String(bad)).toBe("bad_input");
    expect(code(() => at((e) => e.tipAppointment("nanny", a.id, 10)))).toBe("not_found");
    expect(code(() => at((e) => e.tipAppointment("other", a.id, 10)))).toBe("not_found");
    const v = at((e) => e.tipAppointment("mum", a.id, 20.004));
    expect(v.tip).toEqual({ amount: 20, by: "Anna", at: now });
    expect(sent()).toEqual(["appt_tip>nanny"]);
    expect(pushes[0]).toMatchObject({ appointmentId: a.id, params: { sender: "Anna", total: 20, currency: "PLN", service: "Childcare" } });
    expect(at((e) => e.getAppointment("nanny", a.id)).tip).toMatchObject({ amount: 20, by: "Anna" });
    expect(at((e) => e.getAppointment("dad", a.id)).tip).toMatchObject({ amount: 20 });
    expect(code(() => at((e) => e.tipAppointment("dad", a.id, 5)))).toBe("already_tipped");
    // The week's report counts it: spent by the client, earned by the provider.
    const week = "2026-10-19";
    expect(at((e) => e.report("dad", week, "me")).spent).toMatchObject({ tips: 20 });
    expect(at((e) => e.report("nanny", week, "me")).earned).toMatchObject({ tips: 20 });
    // 7 days after the end it is too late.
    const b = done("dad", "nanny");
    now = b.endsAt + 7 * DAY + 1;
    expect(code(() => at((e) => e.tipAppointment("dad", b.id, 10)))).toBe("window_closed");
  });

  it("the rider tips the driver once after a completed ride, within 24 h", () => {
    const r = ride();
    pushes = [];
    expect(code(() => at((e) => e.tipRide("d1", r.id, 5)))).toBe("forbidden");
    expect(code(() => at((e) => e.tipRide("mum", r.id, 5)))).toBe("not_found");
    for (const bad of [0, 500.01]) expect(code(() => at((e) => e.tipRide("dad", r.id, bad)))).toBe("bad_input");
    expect(at((e) => e.tipRide("dad", r.id, 5)).tip).toBe(5);
    expect(sent()).toEqual(["ride_tip>d1"]);
    expect(pushes[0]).toMatchObject({ rideId: r.id, params: { sender: "Roman", total: 5, currency: "PLN", pickup: "Centrum" } });
    expect(at((e) => e.getRide("d1", r.id)).tip).toBe(5);
    expect(code(() => at((e) => e.tipRide("dad", r.id, 5)))).toBe("already_tipped");
    expect(at((e) => e.report("dad", null, "me")).spent.tips).toBe(5);
    expect(at((e) => e.report("d1", null, "me")).earned).toMatchObject({ tips: 5, total: r.fare + 5 });
    const late = ride();
    now += DAY + 1;
    expect(code(() => at((e) => e.tipRide("dad", late.id, 5)))).toBe("window_closed");
  });
});
