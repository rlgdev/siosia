// Siosia 2.7 test accounts in the engine (the SQL twin is tests/unit/sql-sandbox.test.ts — same cases,
// V19): who joins with the test invite code is in the sandbox and meets only other test accounts —
// never in a real member's lists, catalog, open requests, rides or bookings, and the other way round (V66).

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent } from "../../src/core/engine";
import { ServerError, type Place } from "../../src/core/types";

const MIN = 60_000;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const AWAY: Place = { lat: 52.2663135, lng: 20.814317, label: "Husarska 16" };
const CFG: EngineConfig = {
  ...DEFAULT_CONFIG,
  services: DEFAULT_SERVICES,
  inviteCode: "PILOT",
  testInviteCode: "SMOKE TEST",
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
const names = (list: { nickname: string }[]) => list.map((p) => p.nickname).sort();

function user(uid: string, nick: string, invite: string, car = false) {
  at((e) => e.join(uid, invite, `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
  if (car) at((e) => e.saveVehicle(uid, { make: "Kia", model: "Ceed", colour: "Blue", plate: `W ${uid}`, seats: 4 }));
}
const request = (uid: string, provider: string | null) =>
  at((e) => e.requestService(uid, { serviceId: "childcare", providerId: provider && pub(provider), startsAt: now + 26 * 60 * MIN, durationMin: 180, place: HOME, note: "" }));

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 28, 10, 0);
  pushes = [];
  user("anna", "Anna", "pilot", true);
  user("toria", "Toria", "pilot");
  user("t1", "Smoke Rider", "smoke test");
  user("t2", "Smoke Driver", "SMOKETEST", true);
  for (const u of ["toria", "t2"]) at((e) => e.setOffers(u, ["childcare"]));
  pushes = [];
});

describe("test accounts (2.7, V66)", () => {
  it("the test invite code admits into the sandbox; a wrong code does not", () => {
    expect(code(() => at((e) => e.join("x", "nope", "dev-x")))).toBe("bad_invite");
    expect(db.sandbox).toEqual({ t1: true, t2: true });
  });

  it("lists, the catalog and lookups by public id stay within the realm", () => {
    expect(names(at((e) => e.memberList("anna")))).toEqual(["Toria"]);
    expect(names(at((e) => e.memberList("t1")))).toEqual(["Smoke Driver"]);
    expect(names(at((e) => e.catalog("anna")).find((x) => x.id === "childcare")!.providers)).toEqual(["Toria"]);
    expect(names(at((e) => e.catalog("t1")).find((x) => x.id === "childcare")!.providers)).toEqual(["Smoke Driver"]);
    expect(code(() => request("anna", "t2"))).toBe("no_provider");
    expect(code(() => request("t1", "toria"))).toBe("no_provider");
    expect(code(() => at((e) => e.inviteToFamily("anna", pub("t1"))))).toBe("not_found");
    expect(code(() => at((e) => e.proposeContract("t1", { to: pub("toria"), as: "family", rates: [{ serviceId: "childcare", perHour: 1 }] })))).toBe("not_found");
    expect(code(() => request("t1", "t2"))).toBe("ok");
  });

  it("an open request reaches its own realm only", () => {
    const real = request("anna", null);
    const test = request("t1", null);
    expect(pushes.filter((p) => p.kind === "appt_open").map((p) => p.userId).sort()).toEqual(["t2", "toria"]);
    expect(at((e) => e.planned("toria")).open.map((a) => a.id)).toEqual([real.id]);
    expect(at((e) => e.planned("t2")).open.map((a) => a.id)).toEqual([test.id]);
    expect(at((e) => e.myState("toria")).openRequests).toBe(1);
    expect(code(() => at((e) => e.getAppointment("toria", test.id)))).toBe("not_found");
    expect(code(() => at((e) => e.takeRequest("toria", test.id)))).toBe("not_found");
    expect(code(() => at((e) => e.takeRequest("t2", real.id)))).toBe("not_found");
  });

  it("rides and bookings are offered within the realm only", () => {
    at((e) => e.setOnline("anna", true));
    at((e) => e.setOnline("t2", true));
    const ride = at((e) => e.requestRide("t1", { pickup: HOME, dropoff: AWAY, estKm: 3, estMin: 8, fareIsEstimate: false }));
    expect(at((e) => e.heartbeat("anna", HOME))).toMatchObject({ offer: null, nearbyRequests: 0 });
    expect(at((e) => e.heartbeat("t2", HOME)).offer?.rideId).toBe(ride.id);
    at((e) => e.cancelRide("t1", ride.id));
    at((e) => e.setOnline("anna", false));
    at((e) => e.setOnline("t2", false));
    pushes = [];
    const b = at((e) => e.bookRide("t1", { pickup: HOME, dropoff: AWAY, estKm: 3, estMin: 8, fareIsEstimate: false, scheduledFor: now + 26 * 60 * MIN }));
    expect(pushes.filter((p) => p.kind === "booking_new").map((p) => p.userId)).toEqual(["t2"]);
    expect(at((e) => e.openBookings("anna", null))).toEqual([]);
    expect(at((e) => e.myState("anna")).openBookings).toBe(0);
    expect(code(() => at((e) => e.claimBooking("anna", b.id)))).toBe("not_found");
    expect(at((e) => e.claimBooking("t2", b.id))).toBe("won");
  });

  it("a master profile's phones are listed once — its newest account — and not to its own phones (V67)", () => {
    at((e) => e.joinMaster("m1", "nanny-token", "dev-m1", "pl"));
    now += MIN;
    at((e) => e.joinMaster("m2", "nanny-token", "dev-m2", "pl"));
    const listed = (viewer: string) => at((e) => e.memberList(viewer)).filter((p) => p.nickname === "Niania").map((p) => p.publicId);
    expect(listed("anna")).toEqual([pub("m2")]);
    expect(at((e) => e.catalog("anna")).find((x) => x.id === "childcare")!.providers.filter((p) => p.nickname === "Niania").map((p) => p.publicId)).toEqual([pub("m2")]);
    expect(listed("m1")).toEqual([]);
    expect(listed("t1")).toEqual([]);
  });

  it("a test account's invite link admits a test account (2.8, FR-303)", () => {
    at((e) => e.joinWithLink("n1", at((e) => e.createMemberInvite("t1")).token, "dev-n1"));
    at((e) => e.joinWithLink("n2", at((e) => e.createMemberInvite("anna")).token, "dev-n2"));
    expect(db.sandbox?.n1).toBe(true);
    expect(db.sandbox?.n2).toBeUndefined();
  });

  it("a test account stays one after the account move", () => {
    const { code: c } = at((e) => e.createTransfer("t1"));
    at((e) => e.redeemTransfer("t1b", c, "dev-t1b"));
    expect(db.sandbox).toEqual({ t1b: true, t2: true });
    expect(names(at((e) => e.memberList("t1b")))).toEqual(["Smoke Driver"]);
  });
});
