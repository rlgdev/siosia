// Siosia 2.0 server rules in the engine (the SQL twin is tests/unit/sql-v2.test.ts — same cases,
// V19): catalog and offers, the appointment lifecycle and limits, overlap, rides as part of a
// service, reminders with a faked clock, series with clashes / cancel scopes / templates; 2.1 open
// requests (V34–V37) and the car colour (V38); 2.3 kids, kid ratings, photos and chat (V44–V48).

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent, type StoredTemplate } from "../../src/core/engine";
import { ServerError, type AppointmentView, type ChatRoom, type KidInput, type Place, type RepeatInput, type RideTemplateInput } from "../../src/core/types";

const MIN = 60_000;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const SCHOOL: Place = { lat: 52.2663135, lng: 20.814317, label: "Husarska 16" };
const MUSIC = { ...DEFAULT_SERVICES[1], id: "music", name: { en: "Music", pl: "Muzyka" }, enabled: false };
const CFG: EngineConfig = {
  ...DEFAULT_CONFIG,
  services: [...DEFAULT_SERVICES, MUSIC],
  inviteCode: "PILOT",
  masters: [{ id: "nanny", token: "nanny-token", nickname: "Niania", icon: null, fixedFare: null, role: "rider", offers: ["childcare"] }]
};

let db: DbState;
let now: number;
let pushes: PushEvent[];
/** Who got a realtime "changed" from the last successful call (sorted). */
let changed: string[];
const at = <T>(fn: (e: Engine) => T): T => {
  const e = new Engine(db, CFG, now);
  const out = fn(e);
  pushes.push(...e.effects.push);
  changed = [...e.effects.notify].sort();
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

/** A request to `provider`, or (null) an open request to anyone in the group (2.1); 2.3: with kids. */
function request(
  uid: string,
  provider: string | null,
  startMin: number,
  o: { service?: string; duration?: number; place?: Place | null; note?: string; repeat?: RepeatInput; startsAt?: number; kidIds?: string[] } = {}
): AppointmentView {
  return at((e) =>
    e.requestService(uid, {
      serviceId: o.service ?? "childcare",
      providerId: provider === null ? null : pub(provider),
      startsAt: o.startsAt ?? now + startMin * MIN,
      durationMin: o.duration ?? 180,
      place: o.place === undefined ? HOME : o.place,
      note: o.note ?? "",
      repeat: o.repeat,
      kidIds: o.kidIds
    })
  );
}
const answer = (uid: string, id: string, d: "accept" | "decline") => at((e) => e.answerAppointment(uid, id, d));
const cancel = (uid: string, id: string, scope: "one" | "series" = "one") => at((e) => e.cancelAppointment(uid, id, null, scope));
const book = (uid: string, pickupMin: number, appointmentId: string | null = null, leg: "there" | "back" | null = null) =>
  at((e) => e.bookRide(uid, { pickup: HOME, dropoff: SCHOOL, estKm: 3, estMin: 8, fareIsEstimate: false, scheduledFor: now + pickupMin * MIN, appointmentId, leg }));
const getAppt = (uid: string, id: string) => at((e) => e.getAppointment(uid, id));
const sweep = () => at((e) => e.sweep());
const appt = (id: string) => db.appointments![id];
const kinds = () => pushes.map((p) => p.kind);

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 20, 10, 0); // Tue 20 Oct 2026, 12:00 in Warsaw (DST ends on 25 Oct)
  pushes = [];
  user("client", "Toria");
  user("siosia", "Siosia");
  user("driver", "Roman", true);
  user("other", "Ewa");
  user("gone", "Gosia");
  at((e) => e.setOffers("siosia", ["learning", "childcare"]));
  at((e) => e.setOffers("gone", ["learning"]));
  pushes = [];
});

describe("catalog, offers, My place (FR-090–094, FR-140, FR-143)", () => {
  it("lists who offers each enabled entry by public id, never a user id, without the viewer", () => {
    const cat = at((e) => e.catalog("client"));
    expect(cat.map((x) => x.id)).toEqual(["ride", "learning", "childcare"]);
    expect(cat.find((x) => x.id === "childcare")!.providers).toEqual([expect.objectContaining({ nickname: "Siosia", publicId: pub("siosia") })]);
    expect(cat.find((x) => x.id === "ride")!.providers).toEqual([]);
    const text = JSON.stringify(cat);
    for (const uid of ["client", "siosia", "driver", "other", "gone"]) expect(text).not.toContain(`"${uid}"`);
    expect(at((e) => e.catalog("siosia")).find((x) => x.id === "childcare")!.providers).toEqual([]);
    expect(pub("client")).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("offers only enabled time entries; saves My place", () => {
    expect(code(() => at((e) => e.setOffers("other", ["ride"])))).toBe("bad_service");
    expect(code(() => at((e) => e.setOffers("other", ["music"])))).toBe("bad_service");
    expect(at((e) => e.saveHome("client", HOME))).toMatchObject({ home: HOME, offers: [], offersPreset: false });
    expect(code(() => at((e) => e.saveHome("client", { lat: 99, lng: 0, label: "x" })))).toBe("bad_input");
  });
});

describe("request, answer, cancel (FR-100–103, V2–V5)", () => {
  it("validates a request and puts it in both schedules", () => {
    expect(code(() => request("client", "siosia", 30 * 60, { service: "ride" }))).toBe("bad_service");
    expect(code(() => request("client", "siosia", 30 * 60, { service: "music" }))).toBe("bad_service");
    expect(code(() => request("client", "client", 30 * 60))).toBe("no_provider");
    expect(code(() => request("client", "other", 30 * 60))).toBe("not_offered");
    expect(code(() => request("client", "siosia", 10))).toBe("bad_time");
    expect(code(() => request("client", "siosia", 31 * 24 * 60))).toBe("bad_time");
    expect(code(() => request("client", "siosia", 30 * 60, { duration: 45 }))).toBe("bad_duration");
    expect(code(() => request("client", "siosia", 30 * 60, { duration: 750 }))).toBe("bad_duration");
    expect(code(() => request("client", "siosia", 30 * 60, { place: null }))).toBe("bad_input");
    expect(code(() => request("client", "siosia", 30 * 60, { note: "x".repeat(201) }))).toBe("bad_input");
    const a = request("client", "siosia", 30 * 60, { note: "Kids back from school at 14:30" });
    expect(a).toMatchObject({ status: "requested", role: "client", serviceId: "childcare", durationMin: 180, price: null, series: null, rides: [] });
    expect(a.provider).toMatchObject({ nickname: "Siosia", publicId: pub("siosia") });
    expect(a.service).toMatchObject({ name: { en: "Childcare", pl: "Opieka nad dziećmi" } });
    expect(at((e) => e.planned("siosia")).appointments).toEqual([expect.objectContaining({ id: a.id, role: "provider", note: "Kids back from school at 14:30" })]);
    expect(at((e) => e.myState("siosia"))).toMatchObject({ toAnswer: 1, planned: 1, nextPlanned: { kind: "appointment", title: "Childcare" } });
    expect(pushes).toEqual([expect.objectContaining({ kind: "appt_new", userId: "siosia", appointmentId: a.id, params: expect.objectContaining({ service: "Childcare", client: "Toria" }) })]);
    expect(code(() => getAppt("other", a.id))).toBe("not_found");
  });

  it("refuses an 11th open request", () => {
    for (let i = 0; i < 10; i++) request("client", "siosia", 24 * 60 + i * 300, { duration: 60 });
    expect(code(() => request("client", "siosia", 24 * 60 + 3000, { duration: 60 }))).toBe("too_many");
  });

  it("accepts atomically, refuses overlaps, declines into history", () => {
    const a = request("client", "siosia", 30 * 60);
    expect(code(() => answer("client", a.id, "accept"))).toBe("not_found");
    expect(answer("siosia", a.id, "accept")).toMatchObject({ status: "accepted", role: "provider" });
    expect(code(() => answer("siosia", a.id, "accept"))).toBe("illegal_transition");
    expect(pushes.map((p) => `${p.kind}>${p.userId}`)).toEqual(["appt_new>siosia", "appt_accepted>client"]);
    const clash = request("other", "siosia", 30 * 60 + 60);
    expect(code(() => answer("siosia", clash.id, "accept"))).toBe("overlap");
    expect(answer("siosia", clash.id, "decline")).toMatchObject({ status: "declined" });
    expect(at((e) => e.planned("other")).appointments).toEqual([]);
    expect(at((e) => e.timeline("other"))).toEqual([expect.objectContaining({ kind: "appointment", appointment: expect.objectContaining({ id: clash.id, status: "declined" }) })]);
  });

  it("counts a booking taken as a driver as busy", () => {
    at((e) => e.setOffers("driver", ["learning"]));
    const ride = book("client", 26 * 60);
    at((e) => e.claimBooking("driver", ride.id));
    const lesson = request("client", "driver", 26 * 60 - 30, { service: "learning", duration: 60 });
    expect(code(() => answer("driver", lesson.id, "accept"))).toBe("overlap");
  });

  it("lets the client withdraw a request and either party cancel before the start; nothing is counted", () => {
    const before = at((e) => e.getProfile("client"))!;
    const a = request("client", "siosia", 24 * 60);
    expect(code(() => cancel("siosia", a.id))).toBe("illegal_transition");
    cancel("client", a.id);
    expect(getAppt("client", a.id)).toMatchObject({ status: "cancelled", cancelledBy: "client" });
    const b = request("client", "siosia", 48 * 60);
    answer("siosia", b.id, "accept");
    cancel("siosia", b.id);
    expect(getAppt("client", b.id)).toMatchObject({ status: "cancelled", cancelledBy: "provider" });
    expect(pushes.filter((p) => p.kind === "appt_cancelled").map((p) => p.userId)).toEqual(["siosia", "client"]);
    expect(at((e) => e.getProfile("client"))!.riderCancels).toBe(before.riderCancels);
    const c = request("client", "siosia", 72 * 60);
    answer("siosia", c.id, "accept");
    now = appt(c.id).startsAt + 10 * MIN;
    expect(code(() => cancel("client", c.id))).toBe("illegal_transition");
    now = appt(c.id).startsAt + 181 * MIN;
    expect(getAppt("client", c.id)).toMatchObject({ status: "done" });
  });

  it("expires an unanswered request at its start and lets both rate a done appointment once", () => {
    const a = request("client", "siosia", 24 * 60);
    now = appt(a.id).startsAt + 1;
    sweep();
    expect(getAppt("client", a.id)).toMatchObject({ status: "expired" });
    expect(kinds()).toEqual(["appt_new", "appt_expired"]);
    const b = request("client", "siosia", 24 * 60);
    expect(code(() => at((e) => e.rateAppointment("client", b.id, 5, "")))).toBe("illegal_transition");
    answer("siosia", b.id, "accept");
    now = appt(b.id).startsAt + 200 * MIN;
    at((e) => e.rateAppointment("client", b.id, 5, "Great"));
    at((e) => e.rateAppointment("siosia", b.id, 4, ""));
    expect(code(() => at((e) => e.rateAppointment("client", b.id, 5, "")))).toBe("already_rated");
    expect(getAppt("client", b.id)).toMatchObject({ myRating: 5 });
    expect(at((e) => e.getProfile("siosia"))!.rating.count).toBe(1);
    now += 25 * 3600_000;
    expect(code(() => at((e) => e.rateAppointment("other", b.id, 5, "")))).toBe("not_found");
  });
});

describe("rides as part of a service (FR-110–116, V9–V12)", () => {
  it("adds a ride to an accepted appointment with every guard, shows it to each party as allowed", () => {
    const a = request("client", "siosia", 4 * 60);
    expect(code(() => book("siosia", 3 * 60, a.id, "there"))).toBe("not_accepted");
    answer("siosia", a.id, "accept");
    expect(code(() => book("siosia", 3 * 60, a.id, "sideways" as "there"))).toBe("bad_leg");
    expect(code(() => book("siosia", 4 * 60 + 5, a.id, "there"))).toBe("bad_time");
    expect(code(() => book("siosia", 3 * 60, a.id, "back"))).toBe("bad_time");
    expect(code(() => book("other", 3 * 60, a.id, "there"))).toBe("not_found");
    const ride = book("siosia", 3 * 60, a.id, "there");
    expect(ride).toMatchObject({ status: "scheduled", appointmentId: a.id, leg: "there", role: "rider" });
    expect(code(() => book("siosia", 3 * 60 + 10, a.id, "there"))).toBe("ride_exists");
    expect(getAppt("siosia", a.id).rides).toEqual([expect.objectContaining({ rideId: ride.id, leg: "there", passenger: "provider", status: "pending", driver: null, mine: true, pickup: HOME })]);
    const theirs = getAppt("client", a.id).rides;
    expect(theirs).toEqual([expect.objectContaining({ leg: "there", status: "pending", mine: false })]);
    expect(theirs[0]).not.toHaveProperty("pickup");
    expect(theirs[0]).not.toHaveProperty("dropoff");
    expect(pushes.filter((p) => p.kind === "appt_ride_added").map((p) => p.userId)).toEqual(["client"]);
    at((e) => e.claimBooking("driver", ride.id));
    expect(at((e) => e.bookings("driver"))[0]).toMatchObject({ id: ride.id, appointmentId: null, leg: null });
    expect(getAppt("client", a.id).rides).toEqual([expect.objectContaining({ status: "confirmed", driver: expect.objectContaining({ nickname: "Roman" }) })]);
    at((e) => e.releaseBooking("driver", ride.id));
    expect(pushes.filter((p) => p.kind === "appt_ride_taken" || p.kind === "appt_ride_lost").map((p) => `${p.kind}>${p.userId}`)).toEqual([
      "appt_ride_taken>client",
      "appt_ride_lost>client"
    ]);
    at((e) => e.claimBooking("driver", ride.id));
    cancel("client", a.id);
    expect(db.rides[ride.id]).toMatchObject({ status: "cancelled", cancelledBy: "system", cancelReason: "appointment_cancelled" });
    expect(pushes.some((p) => p.kind === "booking_cancelled" && p.userId === "driver")).toBe(true);
  });

  it("tells both parties when an attached ride finds no driver; the appointment stays", () => {
    const a = request("client", "siosia", 5 * 60);
    answer("siosia", a.id, "accept");
    const ride = book("client", 4 * 60, a.id, "there");
    now = ride.scheduledFor! - 20 * MIN; // opens to dispatch…
    sweep();
    now = ride.scheduledFor! + 16 * MIN; // …nobody took it: given up 15 min after its time
    sweep();
    expect(db.rides[ride.id].status).toBe("expired");
    expect(pushes.filter((p) => p.kind === "appt_ride_failed").map((p) => p.userId).sort()).toEqual(["client", "siosia"]);
    expect(getAppt("siosia", a.id)).toMatchObject({ status: "accepted", rides: [expect.objectContaining({ status: "failed" })] });
  });
});

describe("reminders (FR-120–122, V7, V8)", () => {
  it("reminds both parties once per slot with the status and ride words, never late or after cancel", () => {
    const a = request("client", "siosia", 25 * 60);
    answer("siosia", a.id, "accept");
    book("siosia", 24 * 60, a.id, "there");
    pushes = [];
    now = appt(a.id).startsAt - 24 * 60 * MIN + 1;
    sweep();
    sweep();
    const rem = pushes.filter((p) => p.kind === "appt_reminder");
    expect(rem.map((p) => p.userId).sort()).toEqual(["client", "siosia"]);
    expect(rem[0].params).toMatchObject({ lead: 1440, status: "confirmed", rides: [{ leg: "there", status: "pending", driver: null }] });
    expect(getAppt("client", a.id).reminders).toEqual([1440]);
    // Requested 20 h before: no day-before reminder; the 2 h one comes; the client waits, she answers.
    const b = request("client", "siosia", 20 * 60);
    pushes = [];
    sweep();
    expect(pushes.filter((p) => p.kind === "appt_reminder")).toEqual([]);
    now = appt(b.id).startsAt - 119 * MIN;
    sweep();
    const two = pushes.filter((p) => p.kind === "appt_reminder" && p.appointmentId === b.id);
    expect(two.map((p) => [p.userId, p.params.status, p.params.lead]).sort()).toEqual([
      ["client", "waiting", 120],
      ["siosia", "answer", 120]
    ]);
    // A cancelled appointment gets nothing.
    const c = request("client", "siosia", 30 * 60);
    cancel("client", c.id);
    pushes = [];
    now = appt(c.id).startsAt - 100 * MIN;
    sweep();
    expect(pushes.filter((p) => p.appointmentId === c.id)).toEqual([]);
  });
});

describe("series (FR-107–109, FR-117, V23–V26)", () => {
  it("creates a weekly series, answers it as a whole with clashes, cancels all remaining", () => {
    const s = (o: RepeatInput, startMin = 48 * 60) => request("client", "siosia", startMin, { service: "learning", duration: 60, repeat: o });
    expect(code(() => s({ every: 3 as 1, count: 4 }))).toBe("bad_repeat");
    expect(code(() => s({ every: 1, count: 1 }))).toBe("bad_repeat");
    expect(code(() => s({ every: 1, count: 13 }))).toBe("bad_repeat");
    expect(code(() => s({ every: 2, count: 6 }, 25 * 24 * 60))).toBe("bad_repeat");
    const first = s({ every: 1, count: 4 });
    expect(first.series).toMatchObject({ rule: "weekly", count: 4, seq: 1, remaining: 4 });
    const starts = first.series!.starts;
    const hm = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" }).format(ms);
    expect(new Set(starts.map(hm)).size).toBe(1); // same wall-clock time across the end of DST
    expect(starts[1] - starts[0]).toBe(7 * 24 * 3600_000 + 3600_000);
    expect(kinds()).toEqual(["appt_new"]);
    expect(pushes[0].params).toMatchObject({ rule: "weekly", count: 4 });
    const busy = request("other", "siosia", 0, { service: "learning", duration: 60, startsAt: starts[1] + 15 * MIN });
    answer("siosia", busy.id, "accept");
    const accepted = answer("siosia", first.id, "accept");
    expect(accepted.series!.declined).toEqual([starts[1]]);
    const occ = Object.values(db.appointments!).filter((x) => x.seriesId === first.series!.id).sort((x, y) => x.seq! - y.seq!);
    expect(occ.map((x) => x.status)).toEqual(["accepted", "declined", "accepted", "accepted"]);
    const acc = pushes.filter((p) => p.kind === "appt_accepted" && p.userId === "client" && p.appointmentId === first.id);
    expect(acc.length).toBe(1);
    expect(acc[0].params).toMatchObject({ accepted: 3 });
    pushes = [];
    now = starts[0] + 30 * MIN;
    cancel("client", occ[2].id, "series");
    expect(occ.map((x) => x.status)).toEqual(["accepted", "declined", "cancelled", "cancelled"]);
    expect(kinds()).toEqual(["appt_cancelled"]);
    expect(pushes[0].params).toMatchObject({ left: 2 });
  });

  it("expires an unanswered series as a whole and limits open series to 3", () => {
    const s = request("client", "siosia", 48 * 60, { service: "learning", duration: 60, repeat: { every: 2, until: now + 40 * 24 * 3600_000 } });
    expect(s.series).toMatchObject({ rule: "biweekly", count: 3 });
    pushes = [];
    now = s.startsAt + MIN;
    sweep();
    expect(Object.values(db.appointments!).filter((x) => x.seriesId === s.series!.id).map((x) => x.status)).toEqual(["expired", "expired", "expired"]);
    expect(kinds()).toEqual(["appt_expired"]);
    for (let i = 0; i < 3; i++) request("client", "siosia", 48 * 60 + i * 120, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } });
    expect(code(() => request("client", "siosia", 48 * 60 + 600, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } }))).toBe("too_many");
  });

  it("books the series' rides from a template as occurrences enter the 30-day horizon", () => {
    const s = request("client", "siosia", 20 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 4 } });
    answer("siosia", s.id, "accept");
    const sid = s.series!.id;
    const tpl = { leg: "there" as const, pickup: HOME, dropoff: SCHOOL, offsetMin: -30, estKm: 3, estMin: 8, fareIsEstimate: false };
    expect(code(() => at((e) => e.setRideTemplate("siosia", sid, { ...tpl, offsetMin: 10 })))).toBe("bad_time");
    const view = at((e) => e.setRideTemplate("siosia", sid, tpl));
    expect(view.series!.rideTemplates).toEqual([expect.objectContaining({ leg: "there", offsetMin: -30, mine: true })]);
    const rides = () => Object.values(db.rides).filter((r) => r.riderId === "siosia").sort((x, y) => x.scheduledFor! - y.scheduledFor!);
    expect(rides().length).toBe(2);
    expect(rides().every((r) => r.autoBooked)).toBe(true);
    expect(getAppt("client", s.id).series!.rideTemplates).toEqual([{ passenger: "provider", leg: "there", offsetMin: -30, mine: false }]);
    now += 7 * 24 * 3600_000;
    sweep();
    expect(rides().length).toBe(3);
    const firstRide = rides()[0];
    at((e) => e.cancelRide("siosia", firstRide.id));
    db.series![sid].templatesAt = null;
    sweep();
    expect(Object.values(db.rides).filter((r) => r.appointmentId === firstRide.appointmentId).length).toBe(1);
    at((e) => e.dropRideTemplate("siosia", sid, "there"));
    expect(db.series![sid].rideTemplates).toEqual([]);
    expect(Object.values(db.rides).filter((r) => r.status === "scheduled").length).toBe(2);
  });
});

describe("bounded templates, an isolated sweep, clean places (review C0–C7)", () => {
  const TPL: RideTemplateInput = { leg: "there", pickup: HOME, dropoff: SCHOOL, offsetMin: -30, estKm: 3, estMin: 8, fareIsEstimate: false };
  /** An accepted weekly series of 4 starting in 20 days (two dates within the booking horizon). */
  function acceptedSeries() {
    const s = request("client", "siosia", 20 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 4 } });
    answer("siosia", s.id, "accept");
    return s.series!.id;
  }
  const setTpl = (uid: string, sid: string, t: unknown) => at((e) => e.setRideTemplate(uid, sid, t as RideTemplateInput));

  it("refuses a ride estimate over a day or a trip over maxTripKm (C0, C1)", () => {
    const sid = acceptedSeries();
    expect(code(() => setTpl("siosia", sid, { ...TPL, estMin: 1e300 }))).toBe("bad_input");
    expect(code(() => setTpl("siosia", sid, { ...TPL, estMin: 3e8 }))).toBe("bad_input");
    expect(code(() => setTpl("siosia", sid, { ...TPL, estMin: 1441 }))).toBe("bad_input");
    // Too far, as for a one-off booking of the same trip (a bad estimate is still bad_input first).
    expect(code(() => setTpl("siosia", sid, { ...TPL, estKm: 51 }))).toBe("too_far");
    expect(code(() => setTpl("siosia", sid, { ...TPL, estKm: 51, estMin: 1441 }))).toBe("bad_input");
    expect(db.series![sid].rideTemplates).toEqual([]);
    const ride = { pickup: HOME, dropoff: SCHOOL, estKm: 3, fareIsEstimate: false };
    expect(code(() => at((e) => e.bookRide("client", { ...ride, estKm: 51, estMin: 8, scheduledFor: now + 3 * 60 * MIN })))).toBe("too_far");
    expect(code(() => at((e) => e.bookRide("client", { ...ride, estMin: 3e8, scheduledFor: now + 3 * 60 * MIN })))).toBe("bad_input");
    expect(code(() => at((e) => e.requestRide("client", { ...ride, estMin: 1e300 })))).toBe("bad_input");
    expect(book("client", 3 * 60)).toMatchObject({ status: "scheduled", estMin: 8 });
  });

  it("keeps the sweep (and everyone's calls) working past a bad stored template (C0, C1)", () => {
    const sid = acceptedSeries();
    db.series![sid].rideTemplates = [
      { ...TPL, passenger: "provider", estMin: 1e300 },
      { ...TPL, passenger: "provider", leg: "back", offsetMin: 0, estMin: 3e8 },
      null as unknown as StoredTemplate, // not even a template
      { ...TPL, passenger: "client", leg: "back", offsetMin: 0 } // a good one still books
    ];
    db.series![sid].templatesAt = null;
    expect(() => sweep()).not.toThrow();
    expect(at((e) => e.myState("other"))).toMatchObject({ planned: 0 });
    expect(db.series![sid].templatesAt).toBe(now);
    const rides = Object.values(db.rides).filter((r) => appt(r.appointmentId ?? "")?.seriesId === sid);
    expect(rides.map((r) => `${r.riderId}:${r.leg}`)).toEqual(["client:back", "client:back"]);
  });

  it("refuses a template with missing fields and stores only the known keys (C5)", () => {
    const sid = acceptedSeries();
    expect(code(() => setTpl("siosia", sid, { leg: "there" }))).toBe("bad_input");
    for (const k of ["pickup", "dropoff", "offsetMin", "estKm", "estMin"] as const) {
      const t: Partial<RideTemplateInput> = { ...TPL };
      delete t[k];
      expect(code(() => setTpl("siosia", sid, t))).toBe("bad_input");
    }
    expect(code(() => setTpl("siosia", sid, { ...TPL, dropoff: { lat: 52.2, label: "No lng" } }))).toBe("bad_input");
    setTpl("siosia", sid, { ...TPL, junk: "x".repeat(5000), pickup: { ...HOME, junk: "y".repeat(5000) }, fareIsEstimate: "yes" });
    expect(db.series![sid].rideTemplates).toEqual([{ passenger: "provider", leg: "there", pickup: HOME, dropoff: SCHOOL, offsetMin: -30, estKm: 3, estMin: 8, fareIsEstimate: false }]);
  });

  it("refuses a place without lng for a request and for My place (C6)", () => {
    const noLng = { lat: 52.2504843, label: "Warszawska 269" } as Place;
    expect(code(() => request("client", "siosia", 24 * 60, { place: noLng }))).toBe("bad_input");
    expect(code(() => at((e) => e.saveHome("client", noLng)))).toBe("bad_input");
    expect(code(() => at((e) => e.saveHome("client", { lng: 20.8, label: "No lat" } as Place)))).toBe("bad_input");
    expect(at((e) => e.saveHome("client", { ...HOME, junk: 1 } as Place)).home).toEqual(HOME);
  });

  it("tells the other party once when the same template is set again (C7)", () => {
    const sid = acceptedSeries();
    const added = () => pushes.filter((p) => p.kind === "appt_ride_added" && p.userId === "client").length;
    setTpl("siosia", sid, TPL);
    setTpl("siosia", sid, TPL);
    setTpl("siosia", sid, { ...TPL, pickup: { ...HOME }, junk: 1 });
    expect(added()).toBe(1);
    setTpl("siosia", sid, { ...TPL, offsetMin: -45 });
    expect(added()).toBe(2);
    expect(db.series![sid].rideTemplates).toEqual([expect.objectContaining({ passenger: "provider", leg: "there", offsetMin: -45 })]);
  });

  it("keeps a template's estimates to 3 decimals and its offset in whole minutes, cut toward 0", () => {
    const sid = acceptedSeries();
    expect(code(() => setTpl("siosia", sid, { ...TPL, estKm: 0.0004 }))).toBe("bad_input"); // rounds to no trip
    setTpl("siosia", sid, { ...TPL, offsetMin: -30.5, estKm: 3.14159, estMin: 8.12345 });
    expect(db.series![sid].rideTemplates).toEqual([expect.objectContaining({ offsetMin: -30, estKm: 3.142, estMin: 8.123 })]);
    const rides = Object.values(db.rides).filter((r) => appt(r.appointmentId ?? "")?.seriesId === sid);
    expect(rides.map((r) => (appt(r.appointmentId!).startsAt - r.scheduledFor!) / MIN)).toEqual([30, 30]);
    setTpl("siosia", sid, { ...TPL, leg: "back", offsetMin: 10.9 });
    expect(db.series![sid].rideTemplates).toEqual([expect.objectContaining({ leg: "there" }), expect.objectContaining({ leg: "back", offsetMin: 10 })]);
  });

  it("accepts any non-blank place label, stored trimmed and cut to 120, and refuses a blank one", () => {
    const sid = acceptedSeries();
    const LONG = { ...HOME, label: "W".repeat(200) }; // a geocoded label can be that long
    const CUT = { ...HOME, label: "W".repeat(120) };
    const BLANK = { ...HOME, label: "   " };
    expect(at((e) => e.saveHome("client", LONG)).home).toEqual(CUT);
    expect(at((e) => e.saveHome("client", { ...HOME, label: `  ${HOME.label}  ` })).home).toEqual(HOME);
    expect(request("client", "siosia", 24 * 60, { place: LONG }).place).toEqual(CUT);
    setTpl("siosia", sid, { ...TPL, pickup: LONG, dropoff: { ...SCHOOL, label: ` ${SCHOOL.label} ` } });
    expect(db.series![sid].rideTemplates).toEqual([expect.objectContaining({ pickup: CUT, dropoff: SCHOOL })]);
    const booked = Object.values(db.rides).filter((r) => r.autoBooked);
    expect(booked.map((r) => [r.pickup.label, r.dropoff.label])).toEqual([[CUT.label, SCHOOL.label], [CUT.label, SCHOOL.label]]);
    const one = at((e) => e.bookRide("client", { pickup: LONG, dropoff: SCHOOL, estKm: 3, estMin: 8, fareIsEstimate: false, scheduledFor: now + 3 * 60 * MIN }));
    expect(one.pickup).toEqual(CUT);
    expect(code(() => at((e) => e.saveHome("client", BLANK)))).toBe("bad_input");
    expect(code(() => request("client", "siosia", 2 * 24 * 60, { place: BLANK }))).toBe("bad_input");
    expect(code(() => setTpl("siosia", sid, { ...TPL, pickup: BLANK }))).toBe("bad_input");
    expect(code(() => setTpl("siosia", sid, { ...TPL, dropoff: { ...SCHOOL, label: "" } }))).toBe("bad_input");
  });
});

describe("profiles and masters", () => {
  it("cancels a deleted provider's upcoming appointments and tells the client", () => {
    const a = request("client", "gone", 24 * 60, { service: "learning", duration: 60 });
    answer("gone", a.id, "accept");
    pushes = [];
    at((e) => e.deleteProfile("gone"));
    expect(getAppt("client", a.id)).toMatchObject({ status: "cancelled", cancelledBy: "system", cancelReason: "user_gone", provider: { nickname: "Deleted user" } });
    expect(pushes.map((p) => `${p.kind}>${p.userId}`)).toEqual(["appt_cancelled>client"]);
    expect(at((e) => e.catalog("client")).find((x) => x.id === "learning")!.providers).toEqual([expect.objectContaining({ nickname: "Siosia" })]);
  });

  it("lets a master profile preset its offers; a rider master can provide other services", () => {
    at((e) => e.joinMaster("nanny", "nanny-token", "dev-n", "pl"));
    expect(at((e) => e.getProfile("nanny"))).toMatchObject({ offers: ["childcare"], offersPreset: true });
    expect(code(() => at((e) => e.setOffers("nanny", ["learning"])))).toBe("forbidden");
    expect(at((e) => e.catalog("client")).find((x) => x.id === "childcare")!.providers).toEqual(expect.arrayContaining([expect.objectContaining({ nickname: "Niania" })]));
    const a = request("client", "nanny", 24 * 60);
    expect(answer("nanny", a.id, "accept")).toMatchObject({ status: "accepted" });
    expect(at((e) => e.myState("nanny"))).toMatchObject({ nextPlanned: { title: "Opieka nad dziećmi" } });
  });
});

describe("open requests (2.1: FR-160–164, V34–V37)", () => {
  const ALL = ["client", "driver", "gone", "other", "siosia"];
  const take = (uid: string, id: string) => at((e) => e.takeRequest(uid, id));
  const sent = () => pushes.map((p) => `${p.kind}>${p.userId}`);
  const occurrence = (seriesId: string, seq: number) => Object.values(db.appointments!).find((x) => x.seriesId === seriesId && x.seq === seq)!;

  it("sends a request nobody offers to anyone: the usual rules without the provider's, one appt_open to every other member", () => {
    at((e) => e.setOffers("siosia", [])); // nobody offers childcare now
    at((e) => e.saveProfile("other", "Ewa", "pl"));
    at((e) => e.deleteProfile("gone"));
    pushes = [];
    expect(code(() => request("client", null, 30 * 60, { service: "ride" }))).toBe("bad_service");
    expect(code(() => request("client", null, 30 * 60, { service: "music" }))).toBe("bad_service");
    expect(code(() => request("client", null, 10))).toBe("bad_time");
    expect(code(() => request("client", null, 31 * 24 * 60))).toBe("bad_time");
    expect(code(() => request("client", null, 30 * 60, { duration: 45 }))).toBe("bad_duration");
    expect(code(() => request("client", null, 30 * 60, { place: null }))).toBe("bad_input");
    expect(code(() => request("client", null, 30 * 60, { note: "x".repeat(201) }))).toBe("bad_input");
    expect(code(() => request("client", null, 30 * 60, { repeat: { every: 1, count: 13 } }))).toBe("bad_repeat");
    expect(pushes).toEqual([]);
    const a = request("client", null, 30 * 60, { note: "Kids back from school at 14:30" });
    expect(changed).toEqual(["client", "driver", "other", "siosia"]); // everyone's list and badge
    expect(a).toMatchObject({ status: "requested", role: "client", open: true, provider: null, series: null, note: "Kids back from school at 14:30" });
    expect(appt(a.id).providerId).toBeNull();
    // Every other member with a profile, once, in their language (not the client, not a deleted one).
    expect(sent().sort()).toEqual(["appt_open>driver", "appt_open>other", "appt_open>siosia"]);
    for (const p of pushes)
      expect(p).toMatchObject({ appointmentId: a.id, rideId: null, params: { serviceId: "childcare", at: a.startsAt, end: a.endsAt, client: "Toria", provider: "", place: HOME.label, open: true } });
    expect(pushes.find((p) => p.userId === "other")!.params.service).toBe("Opieka nad dziećmi");
    expect(pushes.find((p) => p.userId === "driver")!.params.service).toBe("Childcare");
    // The client's own schedule has it (waiting for anyone); the others could take it.
    expect(at((e) => e.planned("client"))).toMatchObject({ appointments: [{ id: a.id, role: "client", open: true, provider: null }], open: [] });
    expect(at((e) => e.myState("client"))).toMatchObject({ planned: 1, toAnswer: 0, openRequests: 0 });
    expect(at((e) => e.planned("driver"))).toMatchObject({ appointments: [], open: [{ id: a.id, role: "candidate", open: true, provider: null }] });
    expect(at((e) => e.myState("driver"))).toMatchObject({ planned: 0, toAnswer: 0, openRequests: 1 });
    // A series is announced once, by its first date, with its rule.
    pushes = [];
    const s = request("client", null, 2 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 2, count: 3 } });
    expect(sent().sort()).toEqual(["appt_open>driver", "appt_open>other", "appt_open>siosia"]);
    expect(pushes[0]).toMatchObject({ appointmentId: s.id, params: { rule: "biweekly", count: 3, first: s.startsAt, last: s.series!.until, open: true } });
  });

  it("shows a candidate what is asked and by whom — never user ids, anyone's My place, rides or reminders (V34)", () => {
    at((e) => e.saveHome("client", { lat: 52.3, lng: 20.9, label: "Toria's secret home" }));
    at((e) => e.saveHome("other", { lat: 52.31, lng: 20.91, label: "Ewa's secret home" }));
    const later = request("client", null, 5 * 24 * 60, { service: "learning", duration: 60, place: SCHOOL, note: "Maths" });
    const series = request("client", null, 2 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 } });
    const addressed = request("client", "siosia", 3 * 24 * 60); // to Siosia: nobody else's business
    const open = at((e) => e.planned("other")).open;
    expect(open.map((x) => x.id)).toEqual([series.id, later.id]); // soonest first, a series once
    expect(at((e) => e.myState("other")).openRequests).toBe(2);
    const v = open[1];
    expect(v).toMatchObject({
      role: "candidate",
      open: true,
      status: "requested",
      serviceId: "learning",
      durationMin: 60,
      endsAt: later.startsAt + 60 * MIN,
      place: SCHOOL,
      note: "Maths",
      price: null,
      currency: CFG.tariff.currency,
      client: { nickname: "Toria", publicId: pub("client") },
      provider: null,
      rides: [],
      reminders: [],
      myRating: null,
      series: null,
      calendar: { google: null, ics: null }
    });
    expect(getAppt("other", later.id)).toEqual(v);
    expect(open[0].series).toMatchObject({ rule: "weekly", seq: 1, count: 3, status: "requested", remaining: 3, declined: [], gaps: [], rideTemplates: [], ics: null });
    expect(open[0].series!.starts).toHaveLength(3);
    const text = JSON.stringify([open, getAppt("other", series.id), at((e) => e.myState("other"))]);
    for (const uid of ["client", "siosia", "driver", "other", "gone"]) expect(text).not.toContain(`:"${uid}"`); // as a value ("client" is a key too)
    expect(text).not.toContain("secret home");
    // The client withdraws the series' first date: the series is listed by its next one.
    cancel("client", series.id);
    expect(at((e) => e.planned("other")).open.map((x) => [x.id, x.series?.seq ?? null])).toEqual([
      [later.id, null],
      [occurrence(series.series!.id, 2).id, 2]
    ]);
    // Only members with a profile see them; nobody sees requests addressed to someone else.
    at((e) => e.join("newbie", "pilot", "dev-newbie"));
    expect(at((e) => e.planned("newbie")).open).toEqual([]);
    expect(at((e) => e.myState("newbie")).openRequests).toBe(0);
    expect(code(() => getAppt("newbie", later.id))).toBe("not_found");
    expect(code(() => getAppt("other", addressed.id))).toBe("not_found");
    expect(at((e) => e.planned("siosia")).open.map((x) => x.id)).toEqual([later.id, occurrence(series.series!.id, 2).id]);
  });

  it("counts open requests in the client's limits like any other (FR-104)", () => {
    for (let i = 0; i < 9; i++) request("client", "siosia", 24 * 60 + i * 300, { duration: 60 });
    request("client", null, 24 * 60 + 9 * 300, { duration: 60 });
    expect(code(() => request("client", null, 24 * 60 + 3000, { duration: 60 }))).toBe("too_many");
    const rep = { service: "learning", duration: 60, repeat: { every: 1 as const, count: 2 } };
    request("other", "siosia", 48 * 60, rep);
    request("other", null, 48 * 60 + 120, rep);
    request("other", null, 48 * 60 + 240, rep);
    expect(code(() => request("other", null, 48 * 60 + 360, rep))).toBe("too_many");
  });

  it("makes the first member who takes it the provider: accepted at once, the client told as for an accept (V35)", () => {
    const a = request("client", null, 30 * 60);
    pushes = [];
    expect(code(() => take("client", a.id))).toBe("forbidden");
    expect(code(() => take("other", "a-none"))).toBe("not_found");
    const v = take("other", a.id);
    expect(changed).toEqual(ALL); // the client's schedule, the taker's, everyone's list
    expect(v).toMatchObject({ id: a.id, status: "accepted", role: "provider", open: false, provider: { nickname: "Ewa", publicId: pub("other") }, answeredAt: now });
    expect(sent()).toEqual(["appt_accepted>client"]); // the others are told nothing more (FR-162)
    expect(pushes[0]).toMatchObject({ appointmentId: a.id, params: { client: "Toria", provider: "Ewa", service: "Childcare" } });
    expect(pushes[0].params).not.toHaveProperty("open");
    // Someone was faster.
    expect(code(() => take("driver", a.id))).toBe("taken");
    expect(code(() => take("other", a.id))).toBe("taken");
    expect(code(() => getAppt("driver", a.id))).toBe("not_found");
    expect(at((e) => e.planned("driver")).open).toEqual([]);
    expect(at((e) => e.myState("driver")).openRequests).toBe(0);
    expect(getAppt("client", a.id)).toMatchObject({ status: "accepted", role: "client", open: false, provider: { nickname: "Ewa" } });
    expect(at((e) => e.myState("other"))).toMatchObject({ planned: 1, toAnswer: 0, openRequests: 0 });
    // From now on it is an ordinary accepted appointment of the two.
    expect(book("other", 29 * 60, a.id, "there")).toMatchObject({ appointmentId: a.id, leg: "there" });
    expect(pushes.filter((p) => p.kind === "appt_ride_added").map((p) => p.userId)).toEqual(["client"]);
    cancel("other", a.id);
    expect(pushes.filter((p) => p.kind === "appt_cancelled").map((p) => p.userId)).toEqual(["client"]);
  });

  it("keeps a single request that clashes with the taker's schedule open; takes a series whole, the clashes declined", () => {
    at((e) => e.setOffers("other", ["learning"]));
    const busy = request("client", "other", 48 * 60, { service: "learning", duration: 60 });
    answer("other", busy.id, "accept");
    const single = request("gone", null, 48 * 60 + 30, { service: "learning", duration: 60 });
    expect(code(() => take("other", single.id))).toBe("overlap");
    expect(appt(single.id)).toMatchObject({ providerId: null, status: "requested", answeredAt: null });
    expect(at((e) => e.planned("other")).open.map((x) => x.id)).toEqual([single.id]);
    // A booking taken as a driver counts too.
    const ride = book("client", 72 * 60);
    at((e) => e.claimBooking("driver", ride.id));
    const lesson = request("gone", null, 72 * 60 - 30, { service: "learning", duration: 60 });
    expect(code(() => take("driver", lesson.id))).toBe("overlap");
    // A series: taking any of its dates takes all that are still open; her busy date is declined.
    const first = request("gone", null, 4 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 4 } });
    const starts = first.series!.starts;
    const busy2 = request("client", "other", 0, { service: "learning", duration: 60, startsAt: starts[1] + 15 * MIN });
    answer("other", busy2.id, "accept");
    const occ = [1, 2, 3, 4].map((k) => occurrence(first.series!.id, k));
    cancel("gone", occ[3].id); // withdrawn by the client before anyone took it
    pushes = [];
    const v = take("other", occ[2].id);
    expect(v).toMatchObject({ id: occ[2].id, status: "accepted", role: "provider", provider: { nickname: "Ewa" } });
    expect(occ.map((x) => [x.status, x.providerId])).toEqual([
      ["accepted", "other"],
      ["declined", "other"],
      ["accepted", "other"],
      ["cancelled", null]
    ]);
    expect(db.series![first.series!.id]).toMatchObject({ providerId: "other", status: "answered", answeredAt: now });
    expect(v.series).toMatchObject({ declined: [starts[1]], gaps: [starts[1], starts[3]], remaining: 2 });
    expect(sent()).toEqual(["appt_accepted>gone"]);
    expect(pushes[0]).toMatchObject({ appointmentId: occ[2].id, params: { rule: "weekly", count: 4, accepted: 2, declined: [starts[1]], provider: "Ewa" } });
    expect(code(() => take("driver", occ[0].id))).toBe("taken");
    expect(at((e) => e.planned("driver")).open.map((x) => x.id)).toEqual([single.id, lesson.id]);
    expect(at((e) => e.myState("other"))).toMatchObject({ toAnswer: 0, openRequests: 2 });
    // The withdrawn date stays the client's alone, without a provider, in their history.
    expect(at((e) => e.timeline("gone")).map((x) => x.kind === "appointment" && [x.appointment.id, x.appointment.status, x.appointment.provider?.nickname ?? null])).toEqual([
      [occ[3].id, "cancelled", null],
      [occ[1].id, "declined", "Ewa"]
    ]);
    expect(at((e) => e.timeline("other")).map((x) => x.kind === "appointment" && x.appointment.id)).toEqual([occ[1].id]);
  });

  it("keeps a series open when the taker is free for none of its open dates: overlap, nothing changed or told (V35)", () => {
    at((e) => e.setOffers("other", ["learning"]));
    const first = request("gone", null, 4 * 24 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 } });
    const sid = first.series!.id;
    const starts = first.series!.starts;
    const busy = [0, 2].map((k) => request("client", "other", 0, { service: "learning", duration: 60, startsAt: starts[k] + 15 * MIN }));
    for (const b of busy) answer("other", b.id, "accept");
    const occ = [1, 2, 3].map((k) => occurrence(sid, k));
    cancel("gone", occ[1].id); // her only free date, withdrawn by the client
    pushes = [];
    const before = structuredClone(db);
    for (const o of [occ[0], occ[2]]) {
      const e = new Engine(db, CFG, now);
      expect(code(() => e.takeRequest("other", o.id))).toBe("overlap");
      expect(e.effects.push).toEqual([]);
      expect([...e.effects.notify]).toEqual([]);
    }
    expect(db).toEqual(before);
    expect(db.series![sid]).toMatchObject({ providerId: null, status: "requested", answeredAt: null });
    expect(occ.map((x) => [x.status, x.providerId, x.answeredAt])).toEqual([
      ["requested", null, null],
      ["cancelled", null, null],
      ["requested", null, null]
    ]);
    expect(pushes).toEqual([]);
    expect(at((e) => e.planned("other")).open.map((x) => x.id)).toEqual([occ[0].id]);
    expect(at((e) => e.planned("driver")).open.map((x) => x.id)).toEqual([occ[0].id]);
    // One free date is enough: freed of her first clash, she takes the series (the other clash declined).
    cancel("other", busy[0].id);
    pushes = [];
    const v = take("other", occ[2].id);
    expect(v).toMatchObject({ status: "declined", role: "provider", provider: { nickname: "Ewa" } });
    expect(occ.map((x) => [x.status, x.providerId])).toEqual([
      ["accepted", "other"],
      ["cancelled", null],
      ["declined", "other"]
    ]);
    expect(sent()).toEqual(["appt_accepted>gone"]);
    expect(pushes[0].params).toMatchObject({ accepted: 1, declined: [starts[2]] });
  });

  it("lets the client withdraw it (nobody else is told) and expires it at its start: Nobody took it (V37)", () => {
    const a = request("client", null, 24 * 60);
    pushes = [];
    cancel("client", a.id);
    expect(changed).toEqual(ALL); // off everyone's list
    expect(getAppt("client", a.id)).toMatchObject({ status: "cancelled", cancelledBy: "client", provider: null, open: false });
    expect(code(() => take("other", a.id))).toBe("illegal_transition");
    const s = request("client", null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 } });
    pushes = [];
    cancel("client", s.id, "series");
    expect(changed).toEqual(ALL);
    expect([1, 2, 3].map((k) => occurrence(s.series!.id, k).status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(db.series![s.series!.id].status).toBe("cancelled");
    expect(pushes).toEqual([]);
    // Unanswered at its start: expired, and the client hears it was open (a series as a whole).
    const b = request("client", null, 24 * 60);
    const c = request("client", null, 26 * 60, { service: "learning", duration: 60, repeat: { every: 2, count: 2 } });
    const d = request("client", "siosia", 25 * 60); // addressed: the usual words
    pushes = [];
    now = c.startsAt + 1;
    sweep();
    expect(changed).toEqual(ALL); // off everyone's list
    expect(pushes.map((p) => [p.kind, p.userId, p.appointmentId, p.params.open ?? false])).toEqual([
      ["appt_expired", "client", c.id, true],
      ["appt_expired", "client", b.id, true],
      ["appt_expired", "client", d.id, false]
    ]);
    expect(pushes[0].params).toMatchObject({ rule: "biweekly", count: 2, provider: "" });
    expect(getAppt("client", b.id)).toMatchObject({ status: "expired", provider: null, open: false });
    expect(code(() => take("other", b.id))).toBe("illegal_transition");
    expect(code(() => take("other", occurrence(c.series!.id, 2).id))).toBe("illegal_transition");
    expect(at((e) => e.planned("other")).open).toEqual([]);
    expect(at((e) => e.timeline("client")).filter((x) => x.kind === "appointment" && x.appointment.provider === null)).toHaveLength(7);
  });

  it("refuses to take a request whose start has passed", () => {
    const a = request("client", null, 30 * 60);
    now = a.startsAt;
    expect(code(() => take("other", a.id))).toBe("illegal_transition");
    expect(appt(a.id)).toMatchObject({ status: "expired", providerId: null });
  });

  it("reminds only the client of an open request, in waiting-for-anyone words (V37)", () => {
    const a = request("client", null, 25 * 60);
    pushes = [];
    now = a.startsAt - 24 * 60 * MIN + 1;
    sweep();
    sweep();
    expect(pushes.map((p) => [p.kind, p.userId, p.appointmentId, p.params.lead, p.params.role, p.params.status, p.params.other])).toEqual([
      ["appt_reminder", "client", a.id, 1440, "client", "open", ""]
    ]);
    expect(getAppt("client", a.id).reminders).toEqual([1440]);
    expect(at((e) => e.planned("other")).open[0].reminders).toEqual([]);
    // Taken later: both parties get the next one, in the usual words.
    take("other", a.id);
    pushes = [];
    now = a.startsAt - 119 * MIN;
    sweep();
    expect(pushes.map((p) => [p.userId, p.params.status, p.params.other]).sort()).toEqual([
      ["client", "confirmed", "Ewa"],
      ["other", "confirmed", "Toria"]
    ]);
  });

  it("never trips over the missing provider: rides, answers, ratings, templates, deleting either side (R7)", () => {
    const a = request("client", null, 24 * 60);
    const s = request("client", null, 48 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 2 } });
    const tpl: RideTemplateInput = { leg: "there", pickup: HOME, dropoff: SCHOOL, offsetMin: -30, estKm: 3, estMin: 8, fareIsEstimate: false };
    expect(code(() => book("client", 23 * 60, a.id, "there"))).toBe("not_accepted"); // only accepted ones take rides
    expect(code(() => book("other", 23 * 60, a.id, "there"))).toBe("not_found");
    expect(code(() => answer("other", a.id, "accept"))).toBe("not_found");
    expect(code(() => cancel("other", a.id))).toBe("not_found");
    expect(code(() => at((e) => e.rateAppointment("client", a.id, 5, "")))).toBe("illegal_transition");
    expect(code(() => at((e) => e.setRideTemplate("client", s.series!.id, tpl)))).toBe("not_accepted");
    expect(code(() => at((e) => e.dropRideTemplate("client", s.series!.id, "there")))).toBe("ok");
    expect(changed).toEqual(["client"]);
    // A candidate leaving changes nothing; the client leaving withdraws them, with nobody to tell.
    at((e) => e.deleteProfile("other"));
    expect(appt(a.id).status).toBe("requested");
    pushes = [];
    at((e) => e.deleteProfile("client"));
    expect(changed).toEqual(["client", "driver", "gone", "siosia"]);
    expect(pushes).toEqual([]);
    expect(appt(a.id)).toMatchObject({ status: "cancelled", cancelledBy: "system", cancelReason: "user_gone", providerId: null });
    expect(db.series![s.series!.id].status).toBe("cancelled");
    expect(at((e) => e.planned("driver")).open).toEqual([]);
    now += 3 * 24 * 3600_000;
    expect(() => sweep()).not.toThrow();
    expect(at((e) => e.timeline("driver"))).toEqual([]);
  });
});

describe("car colour (2.1: FR-170, V38)", () => {
  const paint = (uid: string, colour: string, p: string) => at((e) => e.setCarColour(uid, colour, p));

  it("sets the colour name and paint of the caller's car, validated; editing the car keeps the paint", () => {
    expect(at((e) => e.getVehicle("driver"))).toMatchObject({ colour: "Zielony", paint: null });
    expect(code(() => paint("client", "Green", "#1f7a3d"))).toBe("no_vehicle");
    for (const [c, p] of [
      ["", "#1f7a3d"],
      ["   ", "#1f7a3d"],
      ["x".repeat(21), "#1f7a3d"],
      ["Green", "green"],
      ["Green", "#1f7a3"],
      ["Green", "#1f7a3d0"],
      ["Green", "#1g7a3d"],
      ["Green", " #1f7a3d"],
      ["Green", "#1f7a3d\n"],
      ["Green", ""]
    ])
      expect(code(() => paint("driver", c, p)), `${c}/${p}`).toBe("bad_vehicle");
    expect(at((e) => e.getVehicle("driver"))).toMatchObject({ colour: "Zielony", paint: null });
    expect(paint("driver", "  Ciemnozielony  ", "#1F7A3D")).toEqual({ make: "Porsche", model: "Taycan", colour: "Ciemnozielony", plate: "W DRIVER", seats: 4, paint: "#1f7a3d" });
    expect(changed).toEqual(["driver"]);
    expect(at((e) => e.saveVehicle("driver", { make: "Porsche", model: "Taycan", colour: "Green", plate: "W 1", seats: 4 }))).toMatchObject({ colour: "Green", paint: "#1f7a3d" });
    expect(at((e) => e.getVehicle("driver"))).toMatchObject({ colour: "Green", plate: "W 1", paint: "#1f7a3d" });
    // A rider master profile has no car to paint, whether or not a car is stored for it.
    at((e) => e.joinMaster("nanny", "nanny-token", "dev-n", "pl"));
    expect(code(() => paint("nanny", "Green", "#1f7a3d"))).toBe("rider_only");
    at((e) => e.joinMaster("driver", "nanny-token", "dev-driver-2", "en", true));
    expect(db.vehicles.driver).toBeTruthy();
    expect(code(() => paint("driver", "Green", "#1f7a3d"))).toBe("rider_only");
  });

  it("shows the paint to riders with the car: booking cards and the ride (V38)", () => {
    paint("driver", "Zielony", "#1f7a3d");
    const ride = book("client", 3 * 60);
    expect(at((e) => e.bookings("client"))[0].driver).toBeNull();
    expect(JSON.stringify(at((e) => e.openBookings("driver", null)))).not.toContain("#1f7a3d");
    expect(at((e) => e.openBookings("driver", null))[0].ride.rider.paint).toBeNull(); // the rider has no car
    at((e) => e.claimBooking("driver", ride.id));
    expect(at((e) => e.bookings("client"))[0].driver!.vehicle).toMatchObject({ colour: "Zielony", paint: "#1f7a3d" });
    paint("driver", "Czerwony", "#C0392B");
    expect(at((e) => e.getRide("client", ride.id)).driver!.vehicle).toEqual({ make: "Porsche", model: "Taycan", colour: "Czerwony", plate: "W DRIVER", seats: 4, paint: "#c0392b" });
  });

  it("draws a person's car in their paint in provider chips and appointment parties — the paint only (PublicParty.paint)", () => {
    const KEYS = ["icon", "nickname", "paint", "photo", "publicId", "rating"];
    paint("driver", "Zielony", "#1F7A3D");
    at((e) => e.setOffers("driver", ["learning"]));
    const chips = at((e) => e.catalog("client")).find((x) => x.id === "learning")!.providers;
    expect(chips.map((p) => [p.nickname, p.paint])).toEqual([
      ["Gosia", null],
      ["Roman", "#1f7a3d"],
      ["Siosia", null]
    ]);
    for (const p of chips) expect(Object.keys(p).sort()).toEqual(KEYS);
    expect(JSON.stringify(chips)).not.toMatch(/W DRIVER|Zielony|Porsche|Taycan/);
    // Addressed to him: both sides see his paint on his party row, the client's (no car) is null.
    const a = request("client", "driver", 30 * 60, { service: "learning", duration: 60 });
    expect(a.provider).toMatchObject({ nickname: "Roman", paint: "#1f7a3d" });
    expect(getAppt("driver", a.id)).toMatchObject({ client: { nickname: "Toria", paint: null }, provider: { paint: "#1f7a3d" } });
    for (const p of [a.client, a.provider!]) expect(Object.keys(p).sort()).toEqual(KEYS);
    // An open request he asks for: a candidate sees his paint as the client's.
    const o = request("driver", null, 48 * 60, { service: "childcare" });
    expect(at((e) => e.planned("other")).open.find((x) => x.id === o.id)!.client).toMatchObject({ nickname: "Roman", paint: "#1f7a3d" });
    expect(JSON.stringify(getAppt("other", o.id))).not.toMatch(/W DRIVER|Zielony|Porsche|Taycan/);
    // A new paint shows at once; a deleted profile's car (and paint) is gone.
    paint("driver", "Czerwony", "#c0392b");
    expect(getAppt("client", a.id).provider!.paint).toBe("#c0392b");
    at((e) => e.deleteProfile("driver"));
    expect(getAppt("client", a.id).provider).toMatchObject({ paint: null });
  });
});

describe("kids, kid ratings, photos, chat (2.3: FR-200–225, V44–V48)", () => {
  /** Tiny JPEG data URLs (the app resizes real photos before they get here). */
  const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z";
  const JPEG2 = JPEG.slice(0, -4) + "AAA=";
  const USERS = ["client", "siosia", "driver", "other", "gone"];
  const kid = (uid: string, name: string, o: Partial<KidInput> = {}) => at((e) => e.addKid(uid, { name, bornYear: o.bornYear ?? null, note: o.note ?? "" }));
  const kids = (uid: string) => at((e) => e.kids(uid));
  const attach = (uid: string, id: string, ids: string[]) => at((e) => e.setAppointmentKids(uid, id, ids));
  const rateKid = (uid: string, aid: string, kidId: string, stars: number, comment = "") => at((e) => e.rateKid(uid, aid, kidId, stars, comment));
  const photo = (uid: string, target: { kind: "profile" } | { kind: "kid"; id: string }, dataUrl: string | null) => at((e) => e.setPhoto(uid, target, dataUrl));
  const chat = (uid: string, room: ChatRoom, markRead = false) => at((e) => e.chat(uid, room, markRead));
  const send = (uid: string, room: ChatRoom, text: string) => at((e) => e.sendMessage(uid, room, text));
  const sent = () => pushes.map((p) => `${p.kind}>${p.userId}`);

  it("keeps up to 8 kids per member — name 1–30, year of birth, note ≤ 200 — for their owner only (FR-200, V44)", () => {
    expect(kids("client")).toEqual([]);
    for (const bad of [{ name: "" }, { name: "   " }, { name: "x".repeat(31) }, { name: "Zosia", bornYear: 1899 }, { name: "Zosia", bornYear: 2027 }, { name: "Zosia", bornYear: 2018.5 }, { name: "Zosia", note: "x".repeat(201) }])
      expect(code(() => kid("client", bad.name, bad)), JSON.stringify(bad)).toBe("bad_input");
    const z = kid("client", "  Zosia ", { bornYear: 2018, note: "  Nut allergy " });
    expect(z).toEqual({ id: expect.any(String), name: "Zosia", photo: null, bornYear: 2018, note: "Nut allergy", rating: { mean: null, count: 0 }, ratings: [] });
    expect(changed).toEqual(["client"]);
    const k = kid("client", "Kuba", { bornYear: 2026 }); // born this year
    expect(kids("client").map((x) => x.name)).toEqual(["Zosia", "Kuba"]);
    expect(kids("siosia")).toEqual([]);
    expect(db.kids![z.id]).toEqual({ id: z.id, ownerId: "client", name: "Zosia", photoPath: null, bornYear: 2018, note: "Nut allergy", createdAt: now });
    // The owner only.
    const edit = { name: "Zuzia", bornYear: null, note: "" };
    expect(code(() => at((e) => e.updateKid("siosia", z.id, edit)))).toBe("not_found");
    expect(code(() => at((e) => e.removeKid("siosia", z.id)))).toBe("not_found");
    expect(code(() => at((e) => e.updateKid("client", "k-none", edit)))).toBe("not_found");
    expect(code(() => at((e) => e.updateKid("client", z.id, { ...edit, name: "" })))).toBe("bad_input");
    expect(at((e) => e.updateKid("client", z.id, edit))).toMatchObject({ id: z.id, name: "Zuzia", bornYear: null, note: "" });
    for (let i = 0; i < 6; i++) kid("client", `K${i}`);
    expect(code(() => kid("client", "Ninth"))).toBe("too_many");
    at((e) => e.removeKid("client", k.id));
    expect(kids("client")).toHaveLength(7);
    expect(code(() => kid("client", "Eighth"))).toBe("ok");
    expect(code(() => kid("stranger", "X"))).toBe("not_member");
    at((e) => e.join("newbie", "pilot", "dev-newbie"));
    expect(code(() => kid("newbie", "X"))).toBe("no_profile");
  });

  it("lets the client attach their own kids to a requested or accepted appointment until it ends; a series: every occurrence (FR-201)", () => {
    const z = kid("client", "Zosia", { bornYear: 2018 });
    const k = kid("client", "Kuba");
    const ewas = kid("other", "Ewa jr");
    expect(code(() => request("client", "siosia", 25 * 60, { kidIds: [ewas.id] }))).toBe("bad_input");
    expect(code(() => request("client", "siosia", 25 * 60, { kidIds: ["k-none"] }))).toBe("bad_input");
    const a = request("client", "siosia", 25 * 60, { kidIds: [z.id, z.id] });
    expect(a.kids.map((x) => x.id)).toEqual([z.id]); // each once
    expect(a.kidCount).toBe(1);
    expect(db.appointmentKids![a.id]).toEqual([z.id]);
    // The client, with a subset of their own kids.
    expect(code(() => attach("siosia", a.id, [z.id]))).toBe("forbidden");
    expect(code(() => attach("other", a.id, [ewas.id]))).toBe("forbidden");
    expect(code(() => attach("client", "a-none", [z.id]))).toBe("not_found");
    expect(code(() => attach("client", a.id, [z.id, ewas.id]))).toBe("bad_input");
    expect(code(() => attach("client", a.id, "zosia" as unknown as string[]))).toBe("bad_input");
    expect(code(() => attach("client", a.id, null as unknown as string[]))).toBe("bad_input"); // not a list (C13, both twins)
    expect(attach("client", a.id, [k.id, z.id]).kids.map((x) => x.name)).toEqual(["Kuba", "Zosia"]);
    expect(changed).toEqual(["client", "siosia"]);
    answer("siosia", a.id, "accept");
    expect(attach("client", a.id, []).kids).toEqual([]);
    expect(attach("client", a.id, [z.id]).kidCount).toBe(1);
    // Still while it runs; not once it ended.
    now = a.startsAt + 10 * MIN;
    expect(code(() => attach("client", a.id, [k.id]))).toBe("ok");
    now = a.endsAt + 1;
    expect(code(() => attach("client", a.id, [z.id]))).toBe("illegal_transition");
    expect(getAppt("siosia", a.id)).toMatchObject({ status: "done", kids: [expect.objectContaining({ name: "Kuba" })], kidCount: 1 });
    // A cancelled one has ended too.
    const b = request("client", "siosia", 48 * 60);
    answer("siosia", b.id, "accept");
    cancel("client", b.id);
    expect(code(() => attach("client", b.id, [z.id]))).toBe("illegal_transition");
    // A series takes the kids on every occurrence; one occurrence changes alone.
    const s = request("client", "siosia", 72 * 60, { service: "learning", duration: 60, repeat: { every: 1, count: 3 }, kidIds: [z.id] });
    const occ = Object.values(db.appointments!)
      .filter((x) => x.seriesId === s.series!.id)
      .sort((x, y) => x.seq! - y.seq!);
    expect(occ.map((x) => db.appointmentKids![x.id])).toEqual([[z.id], [z.id], [z.id]]);
    attach("client", occ[1].id, []);
    expect(occ.map((x) => db.appointmentKids![x.id])).toEqual([[z.id], [], [z.id]]);
    expect(getAppt("siosia", occ[2].id).kids.map((x) => x.name)).toEqual(["Zosia"]);
  });

  it("shows the kids' cards to both parties, a count to a candidate, nothing to drivers or others — never a user id (FR-202, V44)", () => {
    photo("client", { kind: "profile" }, JPEG);
    const z = kid("client", "Zosia", { bornYear: 2018, note: "Nut allergy" });
    photo("client", { kind: "kid", id: z.id }, JPEG2);
    const k = kid("client", "Kuba", { bornYear: 2021 });
    const open = request("client", null, 25 * 60, { kidIds: [z.id, k.id] });
    const cand = at((e) => e.planned("other")).open[0];
    expect(cand).toMatchObject({ id: open.id, role: "candidate", kids: [], kidCount: 2, unread: 0 });
    expect(getAppt("driver", open.id)).toMatchObject({ kids: [], kidCount: 2 });
    expect(JSON.stringify(cand)).not.toMatch(/Zosia|Kuba|allergy|2018|data:image/);
    // Taken: the provider sees the cards (name, photo, age, note, rating), the client their own.
    const v = at((e) => e.takeRequest("other", open.id));
    expect(v.kids).toEqual([
      { id: z.id, name: "Zosia", photo: JPEG2, age: 8, note: "Nut allergy", rating: { mean: null, count: 0 }, myRating: null },
      { id: k.id, name: "Kuba", photo: null, age: 5, note: "", rating: { mean: null, count: 0 }, myRating: null }
    ]);
    expect(v.kidCount).toBe(2);
    expect(getAppt("client", open.id).kids).toEqual(v.kids);
    for (const uid of USERS) expect(JSON.stringify(v.kids)).not.toContain(`"${uid}"`);
    // The driver of an attached ride sees a plain booking.
    const ride = book("client", 24 * 60, open.id, "there");
    at((e) => e.claimBooking("driver", ride.id));
    const dv = at((e) => e.bookings("driver"))[0];
    expect(dv).toMatchObject({ id: ride.id, appointmentId: null });
    expect(JSON.stringify(dv)).not.toMatch(/Zosia|Kuba|kid/i);
    // The request and the reminders tell the provider who comes; the client's copies do not.
    const a = request("client", "siosia", 26 * 60, { kidIds: [z.id] });
    expect(pushes.at(-1)).toMatchObject({ kind: "appt_new", userId: "siosia", params: { kids: ["Zosia"] } });
    answer("siosia", a.id, "accept");
    expect(pushes.at(-1)).toMatchObject({ kind: "appt_accepted", userId: "client" });
    expect(pushes.at(-1)!.params).not.toHaveProperty("kids");
    pushes = [];
    now = a.startsAt - 24 * 60 * MIN + 1;
    sweep();
    const rem = pushes.filter((p) => p.kind === "appt_reminder" && p.appointmentId === a.id);
    expect(rem.map((p) => p.userId).sort()).toEqual(["client", "siosia"]);
    expect(rem.find((p) => p.userId === "siosia")!.params.kids).toEqual(["Zosia"]);
    expect(rem.find((p) => p.userId === "client")!.params).not.toHaveProperty("kids");
    // A renamed kid shows its new name (the providers refetch); a removed one leaves every appointment.
    at((e) => e.updateKid("client", z.id, { name: "Zuzia", bornYear: 2018, note: "" }));
    expect(changed).toEqual(["client", "other", "siosia"]);
    expect(getAppt("siosia", a.id).kids.map((x) => [x.name, x.note])).toEqual([["Zuzia", ""]]);
    // A new photo is a changed card too: the same providers refetch (C12, as siosia_set_photo).
    photo("client", { kind: "kid", id: z.id }, JPEG);
    expect(changed).toEqual(["client", "other", "siosia"]);
    expect(getAppt("siosia", a.id).kids[0].photo).toBe(JPEG);
    photo("client", { kind: "profile" }, JPEG2);
    expect(changed).toEqual(["client"]); // my own photo: my tabs only
    at((e) => e.removeKid("client", z.id));
    expect(changed).toEqual(["client", "other", "siosia"]);
    expect(getAppt("siosia", a.id)).toMatchObject({ kids: [], kidCount: 0 });
    expect(getAppt("other", open.id).kids.map((x) => x.name)).toEqual(["Kuba"]);
    expect(db.appointmentKids![open.id]).toEqual([k.id]);
  });

  it("lets the provider rate each attached kid once within 24 h of a done appointment; the owner reads them; their own rating stays (FR-203, V45)", () => {
    const z = kid("client", "Zosia");
    const k = kid("client", "Kuba");
    const home = kid("client", "Stayed home");
    const a = request("client", "siosia", 25 * 60, { kidIds: [z.id, k.id] });
    answer("siosia", a.id, "accept");
    expect(code(() => rateKid("siosia", a.id, z.id, 5))).toBe("illegal_transition");
    now = a.endsAt + MIN;
    expect(getAppt("client", a.id).status).toBe("done");
    expect(code(() => rateKid("client", a.id, z.id, 5))).toBe("forbidden");
    expect(code(() => rateKid("other", a.id, z.id, 5))).toBe("not_found");
    expect(code(() => rateKid("siosia", a.id, home.id, 5))).toBe("not_found");
    expect(code(() => rateKid("siosia", "a-none", z.id, 5))).toBe("not_found");
    for (const s of [0, 6, NaN]) expect(code(() => rateKid("siosia", a.id, z.id, s))).toBe("bad_input");
    const before = at((e) => e.getProfile("client"))!.rating;
    pushes = [];
    rateKid("siosia", a.id, z.id, 5, " Lovely " + "x".repeat(200));
    expect(changed).toEqual(["client", "siosia"]);
    expect(pushes).toEqual([]);
    expect(code(() => rateKid("siosia", a.id, z.id, 4))).toBe("already_rated");
    rateKid("siosia", a.id, k.id, 4);
    expect(getAppt("siosia", a.id).kids.map((x) => [x.name, x.myRating, x.rating])).toEqual([
      ["Zosia", 5, { mean: 5, count: 1 }],
      ["Kuba", 4, { mean: 4, count: 1 }]
    ]);
    expect(getAppt("client", a.id).kids.map((x) => x.myRating)).toEqual([null, null]);
    // The owner reads who, when, how (comment cut to 140); the owner's own rating (FR-060) is untouched.
    const mine = kids("client").find((x) => x.id === z.id)!;
    expect(mine.rating).toEqual({ mean: 5, count: 1 });
    expect(mine.ratings).toEqual([{ appointmentId: a.id, by: "Siosia", stars: 5, comment: "Lovely " + "x".repeat(133), at: now }]);
    expect(at((e) => e.getProfile("client"))!.rating).toEqual(before);
    expect(db.ratings.filter((g) => g.appointmentId === a.id)).toEqual([]);
    expect(db.kidRatings).toEqual([
      { appointmentId: a.id, kidId: z.id, fromUser: "siosia", stars: 5, comment: expect.any(String), createdAt: now },
      { appointmentId: a.id, kidId: k.id, fromUser: "siosia", stars: 4, comment: "", createdAt: now }
    ]);
    // A later appointment with Zosia shows her summary (the mean of all, one decimal) to its provider.
    at((e) => e.setOffers("other", ["childcare"]));
    const b = request("client", "other", 25 * 60, { kidIds: [z.id] });
    answer("other", b.id, "accept");
    expect(getAppt("other", b.id).kids[0]).toMatchObject({ rating: { mean: 5, count: 1 }, myRating: null });
    now = b.endsAt + MIN;
    rateKid("other", b.id, z.id, 4);
    expect(getAppt("other", b.id).kids[0]).toMatchObject({ rating: { mean: 4.5, count: 2 }, myRating: 4 });
    expect(kids("client").find((x) => x.id === z.id)!.ratings.map((g) => g.by)).toEqual(["Ewa", "Siosia"]); // newest first
    // 24 h after the end the window closes.
    const c = request("client", "siosia", 25 * 60, { kidIds: [k.id] });
    answer("siosia", c.id, "accept");
    now = c.endsAt + 24 * 60 * MIN;
    expect(code(() => rateKid("siosia", c.id, k.id, 5))).toBe("ok");
    const d = request("client", "siosia", 25 * 60, { kidIds: [k.id] });
    answer("siosia", d.id, "accept");
    now = d.endsAt + 24 * 60 * MIN + 1;
    expect(code(() => rateKid("siosia", d.id, k.id, 5))).toBe("window_closed");
    // A removed kid takes its ratings along; the appointments keep nothing of it.
    at((e) => e.removeKid("client", z.id));
    expect(db.kidRatings!.map((g) => g.kidId)).toEqual([k.id, k.id]);
    expect(getAppt("other", b.id).kids).toEqual([]);
    expect(getAppt("siosia", a.id).kids.map((x) => x.name)).toEqual(["Kuba"]);
  });

  it("stores photos as object paths and serves them as signed URLs to allowed viewers only; replacing and clearing delete the object (FR-210–212, V46)", () => {
    expect(at((e) => e.getProfile("client"))!.photo).toBeNull();
    for (const bad of ["", "data:image/png;base64,AAAA", "https://x/y.jpg", "data:image/jpeg;base64,", "data:image/jpeg;base64,!!", "data:image/jpeg;base64," + "A".repeat(220_001)])
      expect(code(() => photo("client", { kind: "profile" }, bad)), bad.slice(0, 40)).toBe("bad_input");
    expect(photo("client", { kind: "profile" }, JPEG)).toBe(JPEG);
    expect(changed).toEqual(["client"]);
    const path = db.users.client.photoPath!;
    expect(path).toMatch(/^profiles\/.+\.jpg$/);
    expect(db.photos).toEqual({ [path]: JPEG });
    expect(JSON.stringify(db.users)).not.toContain("data:"); // rows hold the path, never the content or a URL
    expect(at((e) => e.getProfile("client"))!.photo).toBe(JPEG);
    // Replacing deletes the old object; clearing too.
    expect(photo("client", { kind: "profile" }, JPEG2)).toBe(JPEG2);
    expect(Object.keys(db.photos!)).toHaveLength(1);
    expect(db.photos![path]).toBeUndefined();
    expect(photo("client", { kind: "profile" }, null)).toBeNull();
    expect(db.photos).toEqual({});
    expect(db.users.client.photoPath).toBeNull();
    // A kid's photo: the owner's kid only.
    const z = kid("client", "Zosia");
    expect(code(() => photo("siosia", { kind: "kid", id: z.id }, JPEG))).toBe("not_found");
    expect(code(() => photo("client", { kind: "kid", id: "k-none" }, JPEG))).toBe("not_found");
    expect(code(() => photo("client", { kind: "car" } as unknown as { kind: "profile" }, JPEG))).toBe("bad_input");
    expect(photo("client", { kind: "kid", id: z.id }, JPEG)).toBe(JPEG);
    expect(kids("client")[0].photo).toBe(JPEG);
    expect(db.kids![z.id].photoPath).toMatch(/^kids\/.+\.jpg$/);
    // Removing a kid removes its object (C4/C5; the SQL twin drops it server-side too).
    const tymek = kid("client", "Tymek");
    photo("client", { kind: "kid", id: tymek.id }, JPEG2);
    const tp = db.kids![tymek.id].photoPath!;
    expect(db.photos![tp]).toBe(JPEG2);
    at((e) => e.removeKid("client", tymek.id));
    expect(db.photos![tp]).toBeUndefined();
    expect(Object.keys(db.photos!)).toEqual([db.kids![z.id].photoPath]);
    // Who sees whose photo…
    photo("client", { kind: "profile" }, JPEG2);
    photo("siosia", { kind: "profile" }, JPEG);
    photo("driver", { kind: "profile" }, JPEG);
    // …the catalog: the providers' photos, to anyone browsing;
    expect(at((e) => e.catalog("other")).find((x) => x.id === "childcare")!.providers[0]).toMatchObject({ nickname: "Siosia", photo: JPEG });
    // …an open request: a candidate is no party yet and sees none (nor the kid's);
    const open = request("client", null, 25 * 60, { kidIds: [z.id] });
    expect(at((e) => e.planned("other")).open[0].client.photo).toBeNull();
    expect(JSON.stringify([at((e) => e.planned("other")), getAppt("driver", open.id)])).not.toContain("data:image");
    // …an appointment: the parties see each other, the provider the kid;
    const a = request("client", "siosia", 26 * 60, { kidIds: [z.id] });
    expect(a.provider!.photo).toBe(JPEG);
    expect(a.client.photo).toBe(JPEG2);
    expect(getAppt("siosia", a.id)).toMatchObject({ client: { photo: JPEG2 }, provider: { photo: JPEG }, kids: [{ photo: JPEG }] });
    at((e) => e.takeRequest("other", open.id));
    expect(getAppt("other", open.id)).toMatchObject({ client: { photo: JPEG2 }, kids: [{ photo: JPEG }] });
    // …a booking: the parties once a driver took it; a driver browsing sees none.
    const ride = book("client", 3 * 60);
    expect(at((e) => e.openBookings("driver", null))[0].ride.rider.photo).toBeNull();
    at((e) => e.claimBooking("driver", ride.id));
    expect(at((e) => e.getRide("client", ride.id)).driver!.photo).toBe(JPEG);
    expect(at((e) => e.getRide("driver", ride.id)).rider.photo).toBe(JPEG2);
    expect(at((e) => e.bookings("driver"))[0].rider.photo).toBe(JPEG2);
    // Deleting the profile deletes its photo and the kids with theirs.
    at((e) => e.cancelRide("client", ride.id));
    at((e) => e.deleteProfile("client"));
    expect(db.photos).toEqual({ [db.users.siosia.photoPath!]: JPEG, [db.users.driver.photoPath!]: JPEG });
    expect(db.kids).toEqual({});
    expect(db.users.client.photoPath).toBeNull();
    expect(getAppt("siosia", a.id)).toMatchObject({ client: { nickname: "Deleted user", photo: null }, kids: [], kidCount: 0 });
  });

  it("opens a room per accepted appointment for its two parties: sending while live and 24 h after, read marks, unread counts, one push (FR-220–224, V47, V48)", () => {
    photo("siosia", { kind: "profile" }, JPEG);
    const a = request("client", "siosia", 25 * 60);
    const room: ChatRoom = `appt:${a.id}`;
    expect(code(() => chat("client", room))).toBe("not_found"); // not accepted yet
    expect(code(() => send("client", room, "Hi"))).toBe("not_found");
    answer("siosia", a.id, "accept");
    expect(code(() => chat("other", room))).toBe("not_found");
    expect(code(() => send("other", room, "Hi"))).toBe("not_found");
    expect(code(() => chat("client", "appt:a-none"))).toBe("not_found");
    expect(code(() => chat("client", "nonsense" as ChatRoom))).toBe("not_found");
    expect(code(() => chat("client", `ride:${a.id}`))).toBe("not_found");
    expect(code(() => chat("client", room.toUpperCase() as ChatRoom))).toBe("not_found"); // spelled as the rows name it (C14, both twins)
    expect(code(() => send("client", `appt:${a.id.toUpperCase()}`, "Hi"))).toBe("not_found");
    expect(chat("client", room)).toEqual({ room, other: expect.objectContaining({ nickname: "Siosia", photo: JPEG }), messages: [], open: true, unread: 0 });
    for (const bad of ["", "   ", "x".repeat(501)]) expect(code(() => send("client", room, bad))).toBe("bad_input");
    pushes = [];
    const m1 = send("client", room, "  Zosia has a nut allergy  ");
    expect(m1).toEqual({ id: expect.any(String), room, mine: true, text: "Zosia has a nut allergy", sentAt: now, readAt: null });
    expect(changed).toEqual(["client", "siosia"]); // both threads refresh live
    expect(db.messages).toEqual([{ id: m1.id, room, sender: "client", text: "Zosia has a nut allergy", sentAt: now, readAt: null }]);
    // One push to the other party: the sender, the first words, the room, the message (dispatch skips one
    // read by then, V48); tagged with the appointment.
    expect(pushes).toEqual([{ userId: "siosia", kind: "chat_message", rideId: null, appointmentId: a.id, params: { sender: "Toria", text: "Zosia has a nut allergy", room, messageId: m1.id } }]);
    now += MIN;
    send("client", room, "x".repeat(500));
    expect(pushes.at(-1)!.params.text).toBe("x".repeat(500)); // the whole text is queued; push-text cuts it to the first words (C21)
    // Each side's view: mine / theirs, oldest first; unread for the reader only.
    expect(getAppt("siosia", a.id).unread).toBe(2);
    expect(getAppt("client", a.id).unread).toBe(0);
    expect(at((e) => e.myState("siosia")).unreadChats).toBe(2);
    expect(at((e) => e.myState("client")).unreadChats).toBe(0);
    expect(at((e) => e.planned("siosia")).appointments[0].unread).toBe(2);
    const theirs = chat("siosia", room);
    expect(theirs).toMatchObject({ other: expect.objectContaining({ nickname: "Toria", photo: null }), open: true, unread: 2 });
    expect(theirs.messages.map((m) => [m.mine, m.text.length, m.readAt])).toEqual([
      [false, 23, null],
      [false, 500, null]
    ]);
    expect(changed).toEqual([]); // reading without marking changes nothing
    // Marking read: the sender sees the marks and is told to refetch.
    now += MIN;
    const read = chat("siosia", room, true);
    expect(read.unread).toBe(0);
    expect(read.messages.map((m) => m.readAt)).toEqual([now, now]);
    expect(changed).toEqual(["client", "siosia"]);
    expect(chat("client", room).messages.map((m) => [m.mine, m.readAt])).toEqual([
      [true, now],
      [true, now]
    ]);
    expect(at((e) => e.myState("siosia")).unreadChats).toBe(0);
    chat("siosia", room, true);
    expect(changed).toEqual([]); // nothing left to mark
    send("siosia", room, "Noted 🙂");
    expect(pushes.at(-1)).toMatchObject({ userId: "client", kind: "chat_message", appointmentId: a.id, params: { sender: "Siosia", text: "Noted 🙂", room } });
    expect(at((e) => e.myState("client")).unreadChats).toBe(1);
    expect(chat("client", room).messages.map((m) => m.mine)).toEqual([true, true, false]);
    // Open up to 24 h after the end, then read-only; the thread stays readable.
    now = a.endsAt + 24 * 60 * MIN;
    expect(getAppt("client", a.id).status).toBe("done");
    expect(code(() => send("client", room, "Did she forget a jacket?"))).toBe("ok");
    expect(chat("client", room).open).toBe(true);
    now += 1;
    expect(code(() => send("client", room, "Still there?"))).toBe("illegal_transition");
    expect(chat("siosia", room)).toMatchObject({ open: false, unread: 1 });
    expect(chat("siosia", room).messages).toHaveLength(4);
    expect(at((e) => e.timeline("siosia"))[0]).toMatchObject({ kind: "appointment", appointment: { id: a.id, unread: 1 } });
    // Cancelled after acceptance: the room stays 24 h; declined or withdrawn: there never was one.
    const b = request("client", "siosia", 48 * 60);
    answer("siosia", b.id, "accept");
    cancel("client", b.id);
    expect(code(() => send("siosia", `appt:${b.id}`, "Pity"))).toBe("ok");
    now += 24 * 60 * MIN + 1;
    expect(code(() => send("siosia", `appt:${b.id}`, "Pity"))).toBe("illegal_transition");
    const c = request("client", "siosia", 48 * 60);
    answer("siosia", c.id, "decline");
    expect(code(() => chat("client", `appt:${c.id}`))).toBe("not_found");
    const d = request("client", "siosia", 48 * 60);
    cancel("client", d.id);
    expect(code(() => chat("client", `appt:${d.id}`))).toBe("not_found");
    // An open request has a room once someone took it — for the client and the taker.
    const o = request("client", null, 48 * 60);
    expect(code(() => chat("other", `appt:${o.id}`))).toBe("not_found");
    at((e) => e.takeRequest("other", o.id));
    expect(chat("other", `appt:${o.id}`).other.nickname).toBe("Toria");
    expect(chat("client", `appt:${o.id}`).other.nickname).toBe("Ewa");
    expect(code(() => chat("driver", `appt:${o.id}`))).toBe("not_found");
    for (const uid of USERS) expect(JSON.stringify(chat("other", `appt:${o.id}`))).not.toContain(`:"${uid}"`); // as a value ("other" is a key)
  });

  it("opens a booking's room with its driver and closes it for a driver who gave it back; the next driver starts afresh (FR-220, FR-223)", () => {
    const ride = book("client", 3 * 60);
    const room: ChatRoom = `ride:${ride.id}`;
    expect(code(() => chat("client", room))).toBe("not_found"); // no driver yet
    at((e) => e.claimBooking("driver", ride.id));
    expect(chat("driver", room)).toMatchObject({ other: expect.objectContaining({ nickname: "Toria" }), open: true, messages: [] });
    pushes = [];
    send("driver", room, "I will be 5 min early");
    expect(pushes).toEqual([{ userId: "client", kind: "chat_message", rideId: ride.id, appointmentId: null, params: { sender: "Roman", text: "I will be 5 min early", room, messageId: expect.any(String) } }]);
    expect(at((e) => e.bookings("client"))[0].unread).toBe(1);
    expect(at((e) => e.myState("client")).unreadChats).toBe(1);
    expect(code(() => chat("siosia", room))).toBe("not_found");
    // Given back: no driver, no room — and no badge for the rider.
    at((e) => e.releaseBooking("driver", ride.id));
    expect(code(() => chat("driver", room))).toBe("not_found");
    expect(code(() => chat("client", room))).toBe("not_found");
    expect(at((e) => e.bookings("client"))[0].unread).toBe(0);
    expect(at((e) => e.myState("client")).unreadChats).toBe(0);
    // Another driver takes it: a fresh thread for the two of them; the first driver stays out.
    user("d2", "Daria", true);
    at((e) => e.claimBooking("d2", ride.id));
    expect(chat("d2", room)).toMatchObject({ other: expect.objectContaining({ nickname: "Toria" }), messages: [] });
    expect(chat("client", room)).toMatchObject({ other: expect.objectContaining({ nickname: "Daria" }), messages: [] });
    expect(db.messages).toEqual([]);
    expect(code(() => send("driver", room, "Hello?"))).toBe("not_found");
    expect(code(() => chat("driver", room))).toBe("not_found");
  });

  it("allows 30 messages per room per sender in 10 minutes (FR-225)", () => {
    const a = request("client", "siosia", 25 * 60);
    answer("siosia", a.id, "accept");
    const room: ChatRoom = `appt:${a.id}`;
    for (let i = 0; i < 30; i++) send("client", room, `m${i}`);
    expect(code(() => send("client", room, "one more"))).toBe("too_many");
    expect(code(() => send("siosia", room, "her own count"))).toBe("ok");
    const b = request("client", "siosia", 48 * 60);
    answer("siosia", b.id, "accept");
    expect(code(() => send("client", `appt:${b.id}`, "another room"))).toBe("ok");
    now += 10 * MIN - 1;
    expect(code(() => send("client", room, "still"))).toBe("too_many");
    now += 1;
    expect(code(() => send("client", room, "free again"))).toBe("ok");
    expect(chat("siosia", room).messages).toHaveLength(32);
  });

  it("does not notify a driver on a trip — in any room; the message waits in the thread (FR-222, V48)", () => {
    at((e) => e.setOffers("driver", ["learning"]));
    const lesson = request("siosia", "driver", 25 * 60, { service: "learning", duration: 60 });
    answer("driver", lesson.id, "accept");
    const ride = book("client", 3 * 60);
    at((e) => e.claimBooking("driver", ride.id));
    now = ride.scheduledFor! - 30 * MIN;
    sweep(); // the booking starts: accepted, the driver on duty
    at((e) => e.advance("driver", ride.id, "arrived"));
    at((e) => e.advance("driver", ride.id, "in_progress"));
    pushes = [];
    const room: ChatRoom = `ride:${ride.id}`;
    send("client", room, "Please stop at the pharmacy");
    expect(changed).toEqual(["client", "driver"]); // the thread still refreshes live
    send("siosia", `appt:${lesson.id}`, "Bring the book, please");
    expect(pushes).toEqual([]);
    expect(at((e) => e.getRide("driver", ride.id)).unread).toBe(1);
    expect(at((e) => e.myState("driver"))).toMatchObject({ unreadChats: 2, ride: expect.objectContaining({ unread: 1 }) });
    // The trip over, the next messages are pushed again.
    at((e) => e.advance("driver", ride.id, "completed", 3));
    send("client", room, "Thanks!");
    send("siosia", `appt:${lesson.id}`, "See you");
    expect(sent()).toEqual(["chat_message>driver", "chat_message>driver"]);
    expect(pushes.map((p) => [p.rideId, p.appointmentId])).toEqual([
      [ride.id, null],
      [null, lesson.id]
    ]);
  });

  it("does not notify someone who has the thread open: presence stamped on reading, good for 45 s, per room (FR-222, V48, C10)", () => {
    const a = request("client", "siosia", 25 * 60);
    answer("siosia", a.id, "accept");
    const room: ChatRoom = `appt:${a.id}`;
    chat("siosia", room); // a background refetch says nothing about where Siosia looks
    expect(db.chatPresence).toEqual({});
    chat("siosia", room, true); // the thread open and visible: present
    expect(db.chatPresence).toEqual({ siosia: { [room]: now } });
    pushes = [];
    send("client", room, "Hello");
    expect(pushes).toEqual([]);
    expect(changed).toEqual(["client", "siosia"]); // it lands live all the same
    expect(chat("siosia", room).unread).toBe(1);
    // 45 s without the heartbeat: she looked away — notified again, with the whole text.
    now += 45_000 - 1;
    send("client", room, "Still there?");
    expect(pushes).toEqual([]);
    now += 1;
    send("client", room, "Hello?");
    expect(sent()).toEqual(["chat_message>siosia"]);
    expect(pushes[0].params).toEqual({ sender: "Toria", text: "Hello?", room, messageId: expect.any(String) });
    // The heartbeat (a mark with nothing new to mark) refreshes the stamp.
    pushes = [];
    chat("siosia", room, true);
    now += 30_000;
    chat("siosia", room, true);
    expect(changed).toEqual([]);
    now += 30_000;
    send("client", room, "Good");
    expect(pushes).toEqual([]);
    // Another room is another thread: there she is absent.
    const b = request("client", "siosia", 48 * 60);
    answer("siosia", b.id, "accept");
    pushes = [];
    send("client", `appt:${b.id}`, "About Thursday");
    expect(sent()).toEqual(["chat_message>siosia"]);
    expect(db.chatPresence).toEqual({ siosia: { [room]: now - 30_000 } });
    // The stamp is per user: Toria's own tabs never make Siosia present.
    pushes = [];
    now += 60_000;
    chat("client", room, true);
    send("client", room, "One more");
    expect(sent()).toEqual(["chat_message>siosia"]);
  });

  it("moves kids, kid ratings, messages, presence and photos with a profile into the app; deleting it removes them all, cards included (V49); a database saved before 2.3 works without the new keys", () => {
    const z = kid("client", "Zosia");
    photo("client", { kind: "profile" }, JPEG);
    photo("client", { kind: "kid", id: z.id }, JPEG2);
    const a = request("client", "siosia", 25 * 60, { kidIds: [z.id] });
    answer("siosia", a.id, "accept");
    const room: ChatRoom = `appt:${a.id}`;
    send("client", room, "Hi");
    send("siosia", room, "Hello");
    chat("client", room, true); // read: present in the room
    // Toria also rates a kid as a provider (the rating she GAVE moves with her).
    at((e) => e.setOffers("client", ["learning"]));
    const ewa = kid("other", "Ewa jr");
    const b = request("other", "client", 48 * 60, { service: "learning", duration: 60, kidIds: [ewa.id] });
    answer("client", b.id, "accept");
    now = a.endsAt + MIN;
    rateKid("siosia", a.id, z.id, 5);
    now = b.endsAt + MIN;
    rateKid("client", b.id, ewa.id, 4, "Bright");
    const { code: move } = at((e) => e.createTransfer("client"));
    at((e) => e.join("app", "pilot", "dev-app"));
    at((e) => e.redeemTransfer("app", move, "dev-app"));
    // The app has it all: the kid with its photo and rating, my photo, the thread with `mine` right, the presence, the rating given.
    expect(kids("app")).toEqual([expect.objectContaining({ id: z.id, name: "Zosia", photo: JPEG2, rating: { mean: 5, count: 1 } })]);
    expect(at((e) => e.getProfile("app"))!.photo).toBe(JPEG);
    expect(chat("app", room).messages.map((m) => [m.text, m.mine])).toEqual([
      ["Hi", true],
      ["Hello", false]
    ]);
    expect(chat("siosia", room).messages.map((m) => m.mine)).toEqual([false, true]);
    expect(db.messages!.filter((m) => m.sender === "client")).toEqual([]);
    expect(db.chatPresence).toEqual({ app: { [room]: expect.any(Number) } });
    expect(db.kidRatings!.find((g) => g.kidId === ewa.id)).toMatchObject({ fromUser: "app", stars: 4 });
    expect(kids("other")[0].ratings).toEqual([expect.objectContaining({ by: "Toria", stars: 4, comment: "Bright" })]);
    expect(code(() => kids("client"))).toBe("not_member");
    const snapshot = structuredClone(db);
    // Deleting the profile: kids with attachments and ratings, messages sent, presence, photos — gone;
    // the provider's history shows no card of the kid (V44, V49). The rating given stays as a deleted user's.
    const c = request("app", "siosia", 25 * 60, { kidIds: [z.id] });
    answer("siosia", c.id, "accept");
    expect(getAppt("siosia", c.id).kids.map((k) => k.name)).toEqual(["Zosia"]);
    at((e) => e.deleteProfile("app"));
    expect(Object.values(db.kids!).map((k) => [k.name, k.ownerId])).toEqual([["Ewa jr", "other"]]); // Ewa's kid stays
    expect(db.appointmentKids![c.id]).toEqual([]);
    expect(db.kidRatings!.map((g) => g.kidId)).toEqual([ewa.id]);
    expect(db.messages!.filter((m) => m.sender === "app")).toEqual([]);
    expect(db.messages!.map((m) => m.text)).toEqual(["Hello"]);
    expect(db.chatPresence).toEqual({});
    expect(db.photos).toEqual({});
    expect(db.users.app.photoPath).toBeNull();
    expect(at((e) => e.timeline("siosia"))[0]).toMatchObject({
      kind: "appointment",
      appointment: { id: c.id, status: "cancelled", cancelReason: "user_gone", kids: [], kidCount: 0, client: { nickname: "Deleted user", photo: null } }
    });
    expect(chat("siosia", room).messages.map((m) => [m.text, m.mine])).toEqual([["Hello", true]]);
    expect(kids("other")[0].ratings).toEqual([expect.objectContaining({ by: "Deleted user", stars: 4 })]);
    // Before 2.3 none of the new keys existed.
    const old = snapshot as Partial<DbState>;
    delete old.kids;
    delete old.appointmentKids;
    delete old.kidRatings;
    delete old.messages;
    delete old.photos;
    delete old.chatPresence;
    db = old as DbState;
    expect(at((e) => e.myState("siosia"))).toMatchObject({ unreadChats: 0 });
    expect(getAppt("siosia", a.id)).toMatchObject({ kids: [], kidCount: 0, unread: 0, client: { photo: null } });
    expect(kids("app")).toEqual([]);
    expect(code(() => kid("app", "Kuba"))).toBe("ok");
    expect(code(() => send("app", room, "Hello again"))).toBe("ok");
    expect(code(() => chat("app", room, true))).toBe("ok");
    expect(code(() => photo("app", { kind: "profile" }, JPEG))).toBe("ok");
    expect(code(() => at((e) => e.deleteProfile("app")))).toBe("ok");
  });
});

describe("session updates and heading home (2.5: FR-230–242, V54–V56)", () => {
  const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z";
  const H = 60 * MIN;
  const feed = (uid: string, id: string, seen = false) => at((e) => e.updates(uid, id, seen));
  const post = (uid: string, id: string, text: string, kidId: string | null = null, photo: string | null = null) => at((e) => e.postUpdate(uid, id, { text, kidId }, photo));
  const del = (uid: string, id: string) => at((e) => e.deleteUpdate(uid, id));
  const coming = (uid: string, id: string, min: number) => at((e) => e.comingHome(uid, id, min));
  const kid = (uid: string, name: string) => at((e) => e.addKid(uid, { name, bornYear: null, note: "" }));
  const chat = (uid: string, room: ChatRoom, markRead = false) => at((e) => e.chat(uid, room, markRead));

  /** An accepted childcare with Zosia attached, starting in `startMin` minutes (asked for with the 30-min lead, then the clock moves). */
  function session(startMin = 60) {
    const z = kid("client", "Zosia");
    const ahead = Math.max(startMin, 31);
    const a = request("client", "siosia", ahead, { kidIds: [z.id] });
    answer("siosia", a.id, "accept");
    now += (ahead - startMin) * MIN;
    pushes = [];
    return { a, z };
  }

  it("opens the feed 30 min before the start, to the two parties only, and keeps it 7 days after the end (FR-230, FR-234, V54)", () => {
    const { a } = session(60);
    expect(getAppt("client", a.id)).toMatchObject({ updateCount: 0, feedOpen: false, coming: null });
    expect(feed("client", a.id)).toEqual({ appointmentId: a.id, open: false, items: [] });
    expect(code(() => post("client", a.id, "Hi"))).toBe("illegal_transition");
    now += 30 * MIN; // start − 30 min
    expect(feed("siosia", a.id).open).toBe(true);
    expect(getAppt("siosia", a.id).feedOpen).toBe(true);
    // Nobody else: not the driver of an attached ride, not another member, not a stranger.
    expect(code(() => feed("driver", a.id))).toBe("not_found");
    expect(code(() => post("other", a.id, "Hi"))).toBe("not_found");
    expect(code(() => feed("stranger", a.id))).toBe("not_member");
    expect(code(() => feed("client", "a-none"))).toBe("not_found");
    // An open request has no feed yet; a candidate learns nothing of it.
    const o = request("client", null, 60);
    expect(code(() => feed("client", o.id))).toBe("not_found");
    expect(getAppt("other", o.id)).toMatchObject({ role: "candidate", updateCount: 0, feedOpen: false, coming: null });
    // Open once done, until 7 days after the end.
    now += 30 * MIN + 180 * MIN; // the end
    sweep();
    expect(appt(a.id).status).toBe("done");
    expect(feed("client", a.id).open).toBe(true);
    now += 7 * 24 * H;
    expect(feed("client", a.id).open).toBe(true);
    now += MIN;
    expect(feed("client", a.id).open).toBe(false);
    expect(getAppt("client", a.id).feedOpen).toBe(false);
    expect(code(() => post("siosia", a.id, "Late"))).toBe("illegal_transition");
    expect(code(() => del("client", feed("client", a.id).items[0]?.id ?? "u-none"))).toMatch(/illegal_transition|not_found/);
  });

  it("posts a text and/or a photo, about everyone or one attached kid; both parties refetch; one push to the other party; the author deletes their own (FR-230–232, V54, V55)", () => {
    const { a, z } = session(20); // already open (start − 20 min)
    const k2 = kid("client", "Kuba"); // not attached
    const bad: [string, string | null, string | null][] = [
      ["", null, null],
      ["   ", null, null],
      ["\n", null, null],
      ["\t \r\n", null, null],
      ["x".repeat(501), null, null],
      ["Hi", k2.id, null],
      ["Hi", "k-none", null],
      ["Hi", null, "data:image/png;base64,AAAA"],
      ["Hi", null, "data:image/jpeg;base64," + "A".repeat(220_001)]
    ];
    for (const b of bad) expect(code(() => post("siosia", a.id, b[0], b[1], b[2])), JSON.stringify(b).slice(0, 60)).toBe("bad_input");
    expect(post("siosia", a.id, "Hi\n\n").text).toBe("Hi"); // keyboard whitespace trimmed, as the SQL does
    pushes = [];
    const u1 = post("siosia", a.id, "  Zosia is drawing  ", z.id);
    expect(u1).toEqual({
      id: expect.any(String),
      appointmentId: a.id,
      author: expect.objectContaining({ nickname: "Siosia" }),
      mine: true,
      kid: { id: z.id, name: "Zosia" },
      text: "Zosia is drawing",
      photo: null,
      createdAt: now
    });
    expect(changed).toEqual(["client", "siosia"]);
    expect(pushes).toEqual([
      expect.objectContaining({
        userId: "client",
        kind: "session_update",
        appointmentId: a.id,
        params: expect.objectContaining({ sender: "Siosia", text: "Zosia is drawing", kid: "Zosia", photo: false, updateId: u1.id, service: "Childcare", client: "Toria", provider: "Siosia" })
      })
    ]);
    pushes = [];
    now += MIN;
    const u2 = post("siosia", a.id, "", null, JPEG); // a photo alone
    expect(u2).toMatchObject({ kid: null, text: "", photo: JPEG });
    expect(pushes[0].params).toMatchObject({ text: "", photo: true, kid: null });
    expect(Object.keys(db.photos!)).toHaveLength(1);
    // The parent's note: the same feed, pushed to the provider (no kids param for a client's words).
    pushes = [];
    now += MIN;
    const u3 = post("client", a.id, "Thanks! She loves it", z.id);
    expect(pushes.map((p) => [p.kind, p.userId])).toEqual([["session_update", "siosia"]]);
    expect(pushes[0].params).toMatchObject({ sender: "Toria", kid: "Zosia", kids: ["Zosia"] }); // the provider's copy names the attached kids, as always
    // As each side sees it: oldest first, mine / theirs, the count on the appointment.
    const mine = feed("client", a.id);
    expect(mine.items.map((u) => [u.text, u.mine, u.kid?.name ?? null])).toEqual([
      ["Hi", false, null],
      ["Zosia is drawing", false, "Zosia"],
      ["", false, null],
      ["Thanks! She loves it", true, "Zosia"]
    ]);
    expect(mine.items[2].photo).toBe(JPEG);
    expect(mine.items[1].author).toMatchObject({ nickname: "Siosia" });
    expect(feed("siosia", a.id).items.map((u) => u.mine)).toEqual([true, true, true, false]);
    expect(getAppt("siosia", a.id)).toMatchObject({ updateCount: 4, feedOpen: true });
    expect(getAppt("client", a.id)).toMatchObject({ updateCount: 4 });
    // The author deletes their own — the photo goes too; never the other's.
    expect(code(() => del("client", u2.id))).toBe("not_found");
    expect(code(() => del("siosia", "u-none"))).toBe("not_found");
    del("siosia", u2.id);
    expect(changed).toEqual(["client", "siosia"]);
    expect(db.photos).toEqual({});
    expect(feed("client", a.id).items.map((u) => u.id).slice(1)).toEqual([u1.id, u3.id]);
    // Deleting is for the open feed only, like posting (V54).
    now += 180 * MIN + 7 * 24 * H + 20 * MIN;
    sweep();
    expect(feed("client", a.id).open).toBe(false);
    expect(code(() => del("client", u3.id))).toBe("illegal_transition");
  });

  it("keeps the kid's name on an update when the kid is removed; no push to a party looking at the feed; 60 per author per hour (FR-231, FR-232, V54, V55)", () => {
    const { a, z } = session(20);
    post("siosia", a.id, "Playing", z.id);
    at((e) => e.removeKid("client", z.id));
    expect(feed("siosia", a.id).items[0].kid).toEqual({ id: null, name: "Zosia" });
    expect(getAppt("siosia", a.id).kids).toEqual([]);
    // The parent has the feed in front (seen within 45 s): no push for what they are looking at.
    pushes = [];
    feed("client", a.id, true);
    now += 30_000;
    post("siosia", a.id, "Snack time");
    expect(pushes).toEqual([]);
    now += 20_000; // 50 s since the stamp
    post("siosia", a.id, "Nap");
    expect(pushes.map((p) => p.kind)).toEqual(["session_update"]);
    // Looking at the chat of the same appointment is not looking at the feed.
    pushes = [];
    chat("client", `appt:${a.id}`, true);
    post("siosia", a.id, "Awake");
    expect(pushes.map((p) => p.kind)).toEqual(["session_update"]);
    // 60 in an hour, then too_many; an hour later it flows again.
    for (let i = 0; i < 56; i++) post("siosia", a.id, `n${i}`); // 4 + 56 = 60
    expect(code(() => post("siosia", a.id, "one more"))).toBe("too_many");
    expect(code(() => post("client", a.id, "mine is fine"))).toBe("ok");
    now += H + 1;
    expect(code(() => post("siosia", a.id, "later"))).toBe("ok");
  });

  it("heading home: the client only, while live, minutes 0–600, repeatable; one client_coming push; shown to both until 2 h after the end (FR-240–242, V56)", () => {
    const { a } = session(60);
    expect(code(() => coming("client", a.id, 20))).toBe("illegal_transition"); // 60 min before
    now += 30 * MIN;
    expect(code(() => coming("siosia", a.id, 20))).toBe("not_found");
    expect(code(() => coming("other", a.id, 20))).toBe("not_found");
    for (const bad of [-1, 601, 1.5, Number.NaN]) expect(code(() => coming("client", a.id, bad)), String(bad)).toBe("bad_input");
    const v = coming("client", a.id, 25);
    expect(v.coming).toEqual({ at: now, etaAt: now + 25 * MIN });
    expect(changed).toEqual(["client", "siosia"]);
    expect(pushes).toEqual([
      expect.objectContaining({
        userId: "siosia",
        kind: "client_coming",
        appointmentId: a.id,
        params: expect.objectContaining({ client: "Toria", provider: "Siosia", minutes: 25, etaAt: now + 25 * MIN, service: "Childcare" })
      })
    ]);
    expect(getAppt("siosia", a.id).coming).toEqual({ at: now, etaAt: now + 25 * MIN });
    // Again within a minute: the notice updates, the provider is not rung twice; later it rings again.
    now += 30_000;
    pushes = [];
    expect(coming("client", a.id, 20).coming).toEqual({ at: now, etaAt: now + 20 * MIN });
    expect(pushes).toEqual([]);
    now += 5 * MIN;
    expect(coming("client", a.id, 0).coming).toEqual({ at: now, etaAt: now });
    expect(pushes).toHaveLength(1);
    // Still possible just after the end (marked done), until 2 h after it; then gone.
    now += 25 * MIN + 180 * MIN; // the end
    sweep();
    expect(appt(a.id).status).toBe("done");
    expect(getAppt("siosia", a.id).coming).not.toBeNull();
    expect(code(() => coming("client", a.id, 5))).toBe("ok");
    now += 2 * H + MIN;
    expect(getAppt("siosia", a.id).coming).toBeNull();
    expect(getAppt("client", a.id).coming).toBeNull();
    expect(code(() => coming("client", a.id, 5))).toBe("illegal_transition");
    // Never on a request nobody took yet, or one still waiting for an answer.
    const o = request("client", null, 60);
    expect(code(() => coming("client", o.id, 5))).toBe("illegal_transition");
    const w = request("client", "siosia", 60);
    expect(code(() => coming("client", w.id, 5))).toBe("illegal_transition");
    // A cancelled appointment shows no notice (FR-242).
    const { a: c } = session(20);
    expect(coming("client", c.id, 15).coming).not.toBeNull();
    cancel("client", c.id);
    expect(getAppt("siosia", c.id)).toMatchObject({ status: "cancelled", coming: null });
    expect(code(() => coming("client", c.id, 5))).toBe("illegal_transition");
  });

  it("deleting a profile removes that person's updates and photos; the account move re-keys them (FR-235, V49)", () => {
    const { a, z } = session(20);
    post("siosia", a.id, "", null, JPEG);
    post("client", a.id, "Note", z.id);
    expect(Object.keys(db.photos!)).toHaveLength(1);
    // The parent moves to a new phone: the note is theirs there.
    const { code: tcode } = at((e) => e.createTransfer("client"));
    at((e) => e.join("client2", "pilot", "dev-c2"));
    at((e) => e.redeemTransfer("client2", tcode, "dev-c2"));
    expect(db.updates!.map((u) => u.author).sort()).toEqual(["client2", "siosia"]);
    expect(feed("client2", a.id).items.map((u) => u.mine)).toEqual([false, true]);
    // The provider leaves: her update and its photo go; the parent's note stays.
    at((e) => e.deleteProfile("siosia"));
    expect(db.photos).toEqual({});
    expect(db.updates!.map((u) => [u.author, u.text])).toEqual([["client2", "Note"]]);
  });
});
