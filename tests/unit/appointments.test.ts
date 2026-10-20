// Siosia 2.0 server rules in the engine (the SQL twin is tests/unit/sql-v2.test.ts — same cases,
// V19): catalog and offers, the appointment lifecycle and limits, overlap, rides as part of a
// service, reminders with a faked clock, series with clashes / cancel scopes / templates.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent } from "../../src/core/engine";
import { ServerError, type AppointmentView, type Place, type RepeatInput } from "../../src/core/types";

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

function request(uid: string, provider: string, startMin: number, o: { service?: string; duration?: number; place?: Place | null; note?: string; repeat?: RepeatInput; startsAt?: number } = {}): AppointmentView {
  return at((e) =>
    e.requestService(uid, {
      serviceId: o.service ?? "childcare",
      providerId: pub(provider),
      startsAt: o.startsAt ?? now + startMin * MIN,
      durationMin: o.duration ?? 180,
      place: o.place === undefined ? HOME : o.place,
      note: o.note ?? "",
      repeat: o.repeat
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
