// Integration tests on the server rules with a faked clock (spec §11 "Integration (mock backend)"):
// full loop with three drivers, one claim wins, cancellation on each side, re-dispatch, expiry,
// queueing, lost driver, privacy of the stored record.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig } from "../../src/core/engine";
import { destination } from "../../src/core/geo";
import { ServerError, type LatLng, type MyState, type RideView } from "../../src/core/types";

const CFG: EngineConfig = { ...DEFAULT_CONFIG, inviteCode: "PILOT" };
const PICKUP = { lat: 52.2297, lng: 21.0122, label: "Centrum" };
const DROPOFF = { ...destination(PICKUP, 60, 3), label: "Praga" };
const near = (km: number, bearing = 0): LatLng => destination(PICKUP, bearing, km);

let db: DbState;
let now: number;
const at = <T>(fn: (e: Engine) => T): T => fn(new Engine(db, CFG, now));
const code_ = (fn: () => unknown): string => code(fn);
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof ServerError ? e.code : String(e);
  }
};

function user(uid: string, nick: string, vehicle = false) {
  at((e) => e.join(uid, "pilot", `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
  if (vehicle) at((e) => e.saveVehicle(uid, { make: "Toyota", model: "Yaris", colour: "Red", plate: `wx ${uid}`, seats: 4 }));
}

const online = (uid: string, pos: LatLng): MyState => {
  at((e) => e.setOnline(uid, true));
  return at((e) => e.heartbeat(uid, pos));
};
const request = (uid = "rider"): RideView =>
  at((e) => e.requestRide(uid, { pickup: PICKUP, dropoff: DROPOFF, estKm: 3.42, estMin: 8.6, fareIsEstimate: false }));

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 9, 10, 0, 0);
  user("rider", "Ola");
  user("rider2", "Ewa");
  for (const d of ["d1", "d2", "d3", "far"]) user(d, d.toUpperCase(), true);
});

describe("dispatch and the full loop (US1–US3)", () => {
  it("offers a request to every idle driver within 8 km and lets exactly one win", () => {
    const ride = request();
    expect(ride.fare).toBe(18); // 5 + 2.5·3.42 + 0.5·8.6 = 17.85 → 18.00
    const offers = ["d1", "d2", "d3"].map((d, i) => online(d, near(1 + i)).offer);
    expect(online("far", near(12)).offer).toBeNull();
    expect(offers.every((o) => o?.rideId === ride.id)).toBe(true);
    expect(at((e) => e.getRide("rider", ride.id)).notifiedCount).toBe(3);

    expect(at((e) => e.decideOffer("d2", offers[1]!.id, "accept"))).toBe("won");
    expect(code(() => at((e) => e.decideOffer("d1", offers[0]!.id, "accept")))).toBe("taken");
    expect(at((e) => e.myState("d3")).offer).toBeNull(); // card vanished
    const view = at((e) => e.getRide("rider", ride.id));
    expect(view.status).toBe("accepted");
    expect(view.driver?.nickname).toBe("D2");
    expect(view.driver?.vehicle?.plate).toBe("WX D2");
  });

  it("runs accepted → arrived → in_progress → completed with actual totals and earnings", () => {
    const ride = request();
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    expect(code(() => at((e) => e.advance("d1", ride.id, "completed", 3)))).toBe("illegal_transition");
    expect(code(() => at((e) => e.advance("rider", ride.id, "arrived")))).toBe("forbidden");
    // a live driver heartbeats every few seconds; jump the clock with a heartbeat
    const later = (ms: number) => {
      now += ms;
      at((e) => e.heartbeat("d1", null));
    };
    later(50_000);
    at((e) => e.advance("d1", ride.id, "arrived"));
    later(30_000);
    at((e) => e.advance("d1", ride.id, "in_progress"));
    for (let i = 0; i < 9; i++) later(60_000);
    const done = at((e) => e.advance("d1", ride.id, "completed", 3.66));
    expect(done).toMatchObject({ status: "completed", actualKm: 3.7, actualMin: 9, fare: ride.fare });
    expect(at((e) => e.myState("d1")).ride).toBeNull(); // back to idle
    expect(at((e) => e.earnings("d1"))).toMatchObject({ todayTotal: ride.fare, todayCount: 1, monthCount: 1 });
    // receipt actions + one rating each way
    at((e) => e.markPaid("rider", ride.id));
    at((e) => e.markCollected("d1", ride.id));
    at((e) => e.rate("rider", ride.id, 5, "x".repeat(200)));
    expect(code(() => at((e) => e.rate("rider", ride.id, 4, "")))).toBe("already_rated");
    expect(at((e) => e.getRide("rider", ride.id)).myRating).toBe(5);
    expect(db.ratings[0].comment).toHaveLength(140);
    now += 25 * 3600_000;
    expect(code(() => at((e) => e.rate("d1", ride.id, 4, "")))).toBe("window_closed");
  });

  it("sorts nothing server-side but gives each driver one card at a time, oldest first (§6 rule 5)", () => {
    const r1 = request("rider");
    now += 1000;
    const r2 = request("rider2");
    const s = online("d1", near(1));
    expect(s.offer?.rideId).toBe(r1.id);
    expect(s.queuedOffers).toBe(1);
    at((e) => e.decideOffer("d1", s.offer!.id, "decline"));
    const next = at((e) => e.myState("d1"));
    expect(next.offer?.rideId).toBe(r2.id);
    expect(next.offer?.offeredAt).toBe(now); // its own fresh countdown
    expect(at((e) => e.getRide("rider", r1.id)).status).toBe("requested"); // still open for others
  });

  it("times out an offer after 20 s on the server clock only", () => {
    request();
    const o = online("d1", near(1)).offer!;
    now += 10_000;
    expect(at((e) => e.decideOffer("d1", o.id, "timeout"))).toBe("ok");
    expect(at((e) => e.myState("d1")).offer?.id).toBe(o.id); // early client timer ignored
    now += 10_000;
    expect(at((e) => e.myState("d1")).offer).toBeNull();
    expect(db.offers[o.id].status).toBe("timed_out");
    expect(code(() => at((e) => e.decideOffer("d1", o.id, "accept")))).toBe("offer_expired");
  });

  it("gives a driver who comes online later a fresh offer while the request is open", () => {
    const ride = request();
    now += 60_000;
    expect(online("d3", near(2)).offer?.rideId).toBe(ride.id);
  });

  it("gives no offer to a driver with an active trip (US3.5)", () => {
    request("rider");
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    request("rider2");
    expect(at((e) => e.heartbeat("d1", near(1))).offer).toBeNull();
  });
});

describe("cancellation, re-dispatch, expiry (§5, §12)", () => {
  it("re-dispatches without the cancelling driver; fare and rider unchanged", () => {
    const ride = request();
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    expect(code(() => at((e) => e.setOnline("d1", false)))).toBe("active_trip"); // FR-028
    at((e) => e.cancelRide("d1", ride.id, "vehicle_problem"));
    const v = at((e) => e.getRide("rider", ride.id));
    expect(v).toMatchObject({ status: "requested", driver: null, redispatchCount: 1, fare: ride.fare });
    expect(at((e) => e.heartbeat("d1", near(1))).offer).toBeNull();
    expect(online("d2", near(2)).offer?.rideId).toBe(ride.id);
    expect(at((e) => e.getProfile("d1"))?.driverCancels).toBe(1);
  });

  it("keeps a request open for the configured expiry (20 min by default), then expires it server-side", () => {
    expect(CFG.timers.expiryS).toBe(1200);
    const ride = request();
    now += CFG.timers.expiryS * 1000 - 1000;
    expect(at((e) => e.myState("rider")).ride?.status).toBe("requested");
    now += 2_000;
    at((e) => e.sweep());
    const v = at((e) => e.getRide("rider", ride.id));
    expect(v).toMatchObject({ status: "expired", cancelledBy: "system" });
  });

  it("counts a rider cancellation after arrival as late", () => {
    const ride = request();
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    at((e) => e.advance("d1", ride.id, "arrived"));
    at((e) => e.cancelRide("rider", ride.id));
    expect(at((e) => e.getProfile("rider"))).toMatchObject({ riderCancels: 1, lateCancels: 1 });
    expect(at((e) => e.myState("d1")).ride).toBeNull();
  });

  it("allows No-show only 5 minutes after arriving", () => {
    const ride = request();
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    at((e) => e.advance("d1", ride.id, "arrived"));
    now += 4 * 60_000;
    at((e) => e.heartbeat("d1", null));
    expect(code(() => at((e) => e.cancelRide("d1", ride.id, "no_show")))).toBe("too_early");
    now += 60_000;
    at((e) => e.heartbeat("d1", null));
    at((e) => e.cancelRide("d1", ride.id, "no_show"));
    expect(at((e) => e.getRide("rider", ride.id))).toMatchObject({ status: "cancelled", cancelledBy: "driver", cancelReason: "no_show" });
  });

  it("withdraws a silent driver's cards after 12 s and re-dispatches their ride after 60 s", () => {
    const ride = request("rider");
    const o = online("d1", near(1)).offer!;
    now += 13_000;
    at((e) => e.sweep());
    expect(db.offers[o.id].status).toBe("withdrawn");
    const o2 = online("d2", near(1)).offer!;
    expect(o2.rideId).toBe(ride.id);
    at((e) => e.decideOffer("d2", o2.id, "accept"));
    now += 61_000;
    at((e) => e.sweep());
    const v = at((e) => e.getRide("rider", ride.id));
    expect(v).toMatchObject({ status: "requested", cancelReason: "driver_lost", redispatchCount: 1 });
    expect(db.drivers.d2.online).toBe(false);
  });
});

describe("liveness and re-offers (§6 rule 4, §12, US4-2)", () => {
  it("offers a withdrawn card again once the driver is eligible; a decline stays final", () => {
    const ride = request();
    const a = online("d1", near(1)).offer!;
    at((e) => e.setOnline("d1", false));
    expect(db.offers[a.id].status).toBe("withdrawn");
    const b = online("d1", near(1)).offer!;
    expect(b).toMatchObject({ id: a.id, rideId: ride.id, status: "offered" });
    expect(at((e) => e.getRide("rider", ride.id)).notifiedCount).toBe(1);
    at((e) => e.decideOffer("d1", b.id, "decline"));
    expect(at((e) => e.heartbeat("d1", near(1))).offer).toBeNull();
  });

  it("offers a lapsed card again after the retry window; a declined one only in a new online session", () => {
    const ride = request();
    const a = online("d1", near(1)).offer!;
    const b = online("d2", near(1)).offer!;
    at((e) => e.decideOffer("d2", b.id, "decline"));
    now += CFG.timers.offerS * 1000;
    at((e) => e.heartbeat("d1", near(1))); // d1 let the card lapse → timed out
    expect(db.offers[a.id].status).toBe("timed_out");
    now += (CFG.timers.retryS - 5) * 1000;
    expect(at((e) => e.heartbeat("d1", near(1))).offer).toBeNull(); // not yet
    now += 6_000;
    expect(at((e) => e.heartbeat("d1", near(1))).offer).toMatchObject({ id: a.id, rideId: ride.id, offeredAt: now });
    expect(db.offers[b.id].status).toBe("declined");
    at((e) => e.setOnline("d2", true)); // d2 went silent meanwhile (set offline) — a new session:
    expect(at((e) => e.heartbeat("d2", near(1))).offer).toMatchObject({ id: b.id, rideId: ride.id }); // reviews it again
    expect(at((e) => e.getRide("rider", ride.id)).notifiedCount).toBe(2);
    // retryS = 0 disables re-offers: let the card lapse again, then compare both settings later.
    now += CFG.timers.offerS * 1000;
    at((e) => e.heartbeat("d1", null));
    expect(db.offers[a.id].status).toBe("timed_out");
    const copy = structuredClone(db);
    const t2 = now + 200_000;
    expect(new Engine(db, { ...CFG, timers: { ...CFG.timers, retryS: 0 } }, t2).heartbeat("d1", near(1)).offer).toBeNull();
    expect(new Engine(copy, CFG, t2).heartbeat("d1", near(1)).offer?.id).toBe(a.id);
  });

  it("records a Decline that lands just after the countdown, so the card never comes back", () => {
    const ride = request();
    const a = online("d1", near(1)).offer!;
    now += CFG.timers.offerS * 1000 + 200; // the server timed the card out a moment ago…
    at((e) => e.decideOffer("d1", a.id, "decline")); // …and then the Decline arrives
    expect(db.offers[a.id].status).toBe("declined");
    now += (CFG.timers.retryS + 1) * 1000;
    expect(at((e) => e.heartbeat("d1", near(1))).offer).toBeNull();
    expect(at((e) => e.getRide("rider", ride.id)).expiresAt).toBe(ride.dispatchStartedAt + CFG.timers.expiryS * 1000);
  });

  it("lets a driver who goes online review declined and missed requests again", () => {
    const ride = request();
    const a = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", a.id, "decline"));
    expect(at((e) => e.heartbeat("d1", near(1)))).toMatchObject({ offer: null, nearbyRequests: 1 });
    at((e) => e.setOnline("d1", true)); // already online: the same session, the Decline holds
    expect(at((e) => e.heartbeat("d1", near(1))).offer).toBeNull();
    at((e) => e.setOnline("d1", false));
    expect(online("d1", near(1)).offer).toMatchObject({ id: a.id, rideId: ride.id, offeredAt: now });
    expect(at((e) => e.getRide("rider", ride.id)).notifiedCount).toBe(1); // not a new notification
    // A driver who cancelled after accepting is never offered that ride again.
    at((e) => e.decideOffer("d1", a.id, "accept"));
    at((e) => e.cancelRide("d1", ride.id, "other"));
    at((e) => e.setOnline("d1", false));
    expect(online("d1", near(1))).toMatchObject({ offer: null, nearbyRequests: 0 });
    expect(at((e) => e.refreshOffers("d1", near(1))).offer).toBeNull();
    expect(online("d2", near(1))).toMatchObject({ offer: { rideId: ride.id }, nearbyRequests: 1 });
  });

  it("brings back every pending request nearby on Show requests, declined or lapsed, and counts them", () => {
    const r1 = request("rider");
    now += 1000;
    const r2 = request("rider2");
    const s = online("d1", near(1));
    expect(s).toMatchObject({ offer: { rideId: r1.id }, queuedOffers: 1, nearbyRequests: 2 });
    at((e) => e.decideOffer("d1", s.offer!.id, "decline")); // r1 declined → r2 on screen
    expect(at((e) => e.myState("d1"))).toMatchObject({ offer: { rideId: r2.id }, nearbyRequests: null }); // no position, no count
    now += CFG.timers.offerS * 1000;
    expect(at((e) => e.heartbeat("d1", near(1)))).toMatchObject({ offer: null, nearbyRequests: 2 }); // r2 lapsed
    const back = at((e) => e.refreshOffers("d1", near(1)));
    expect(back).toMatchObject({ offer: { rideId: r1.id, offeredAt: now }, queuedOffers: 1, nearbyRequests: 2 });
    expect(at((e) => e.getRide("rider", r1.id)).notifiedCount).toBe(1);
    expect(at((e) => e.getRide("rider2", r2.id)).notifiedCount).toBe(1);
    // Out of range: nothing to show, nothing counted.
    expect(online("far", near(12))).toMatchObject({ offer: null, nearbyRequests: 0 });
    expect(at((e) => e.refreshOffers("far", near(12)))).toMatchObject({ offer: null, nearbyRequests: 0 });
    // Guards: offline, bad position, during a trip.
    expect(code(() => at((e) => e.refreshOffers("d2", near(1))))).toBe("not_online");
    expect(code(() => at((e) => e.refreshOffers("d1", { lat: 120, lng: 0 })))).toBe("bad_input");
    at((e) => e.decideOffer("d1", back.offer!.id, "accept"));
    expect(code(() => at((e) => e.refreshOffers("d1", near(1))))).toBe("active_trip");
    expect(at((e) => e.heartbeat("d1", near(1))).nearbyRequests).toBeNull(); // on a trip: no count
  });

  it("after Show requests, offers the brought-back requests oldest first, like the SQL", () => {
    user("r3", "Iza");
    const r1 = request("rider");
    now += 1000;
    const r2 = request("rider2");
    now += 1000;
    const r3 = request("r3");
    now += 1000;
    const s2 = online("d2", near(1)); // R1 on screen, R2 and R3 queued
    at((e) => e.decideOffer("d2", s2.offer!.id, "decline"));
    now += 1000;
    expect(at((e) => e.decideOffer("d2", e.myState("d2").offer!.id, "accept"))).toBe("won"); // d2 takes R2
    now += 1000;
    expect(online("d1", near(1)).offer?.rideId).toBe(r1.id); // d1: cards for R1 and R3
    now += 1000;
    at((e) => e.cancelRide("d2", r2.id, "other")); // R2 re-dispatched: d1's card for it is created last
    now += 1000;
    at((e) => e.heartbeat("d1", near(1)));
    for (let o = at((e) => e.myState("d1")).offer; o; o = at((e) => e.myState("d1")).offer) {
      at((e) => e.decideOffer("d1", o!.id, "decline"));
    }
    const seen: string[] = [];
    for (let s = at((e) => e.refreshOffers("d1", near(1))); s.offer; s = at((e) => e.myState("d1"))) {
      seen.push(s.offer.rideId);
      at((e) => e.decideOffer("d1", s.offer!.id, "decline"));
    }
    expect(seen).toEqual([r1.id, r2.id, r3.id]);
  });

  it("keeps a decision made on a withdrawn card final", () => {
    request();
    const a = online("d1", near(1)).offer!;
    now += 13_000;
    at((e) => e.sweep()); // silent > 12 s → withdrawn
    at((e) => e.decideOffer("d1", a.id, "decline")); // tapped while the phone was offline
    expect(db.offers[a.id].status).toBe("declined");
    expect(at((e) => e.heartbeat("d1", near(1))).offer).toBeNull();
  });

  it("counts driver actions as signs of life, so completing after a signal gap keeps the driver online", () => {
    const ride = request();
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    at((e) => e.advance("d1", ride.id, "arrived"));
    at((e) => e.advance("d1", ride.id, "in_progress"));
    now += 90_000; // no heartbeat during the trip (tunnel); in_progress waits (§12)
    at((e) => e.advance("d1", ride.id, "completed", 4));
    at((e) => e.sweep());
    expect(db.drivers.d1.online).toBe(true);
  });

  it("sets an idle driver offline after 60 s of silence but keeps a driver on a trip", () => {
    online("d1", near(1));
    const ride = request();
    const o = online("d2", near(1)).offer!;
    at((e) => e.decideOffer("d2", o.id, "accept"));
    at((e) => e.advance("d2", ride.id, "arrived"));
    at((e) => e.advance("d2", ride.id, "in_progress"));
    now += 61_000;
    at((e) => e.sweep());
    expect(db.drivers.d1.online).toBe(false); // idle → offline
    expect(db.drivers.d2.online).toBe(true); // in_progress → waits for the driver (§12)
  });

  it("lets a user whose driver tab died ride instead of refusing with online_as_driver", () => {
    online("d1", near(1));
    now += 13_000;
    const r = at((e) => e.requestRide("d1", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3.42, estMin: 8.6, fareIsEstimate: false }));
    expect(r.status).toBe("requested");
    expect(db.drivers.d1.online).toBe(false);
  });

  it("bumps the dispatch round on re-dispatch so the live channel changes", () => {
    const ride = request();
    expect(ride.round).toBe(1);
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    at((e) => e.cancelRide("d1", ride.id, "other"));
    expect(at((e) => e.getRide("rider", ride.id)).round).toBe(2);
  });
});

describe("master profiles (shared rider link, fixed fare)", () => {
  const MASTERS = [
    { id: "master", token: "tok-master-0123456789", nickname: "Master Rider", icon: null, fixedFare: 18 },
    { id: "roman", token: "tok-roman-0123456789", nickname: "Roman", icon: "taycan-ct-green", fixedFare: 18 }
  ];
  const M = <T>(fn: (e: Engine) => T): T => fn(new Engine(db, { ...CFG, masters: MASTERS }, now));
  const trip = (estKm: number, estMin: number) => ({ pickup: PICKUP, dropoff: DROPOFF, estKm, estMin, fareIsEstimate: true });

  it("turns any device into the shared profile: no invite, no nickname, rider only, every ride at the fixed fare", () => {
    expect(code(() => M((e) => e.joinMaster("m1", "wrong-token", "dev-m1", "pl")))).toBe("bad_link");
    const p = M((e) => e.joinMaster("m1", " tok-roman-0123456789 ", "dev-m1", "pl"));
    expect(p).toMatchObject({ nickname: "Roman", language: "pl", masterId: "roman", icon: "taycan-ct-green", fixedFare: 18 });
    expect(M((e) => e.isMember("m1", "dev-m1"))).toBe(true);
    // A second phone with the same link is the same profile; its nickname cannot be changed.
    M((e) => e.joinMaster("m2", "tok-roman-0123456789", "dev-m2", "en"));
    expect(M((e) => e.saveProfile("m2", "Somebody", "pl"))).toMatchObject({ nickname: "Roman", language: "pl" });
    expect(code(() => M((e) => e.setOnline("m2", true)))).toBe("rider_only");
    // 30 km / 45 min would cost 102.50 on the tariff: a master profile pays 18, never "estimate".
    const ride = M((e) => e.requestRide("m1", trip(30, 45)));
    expect(ride).toMatchObject({ fare: 18, fareIsEstimate: false, rider: { nickname: "Roman", icon: "taycan-ct-green" } });
    const offer = M((e) => {
      e.setOnline("d1", true);
      return e.heartbeat("d1", near(1));
    }).offer!;
    expect(offer).toMatchObject({ rideId: ride.id, fare: 18, rider: { nickname: "Roman", icon: "taycan-ct-green" } });
    // Everybody else keeps the tariff.
    expect(M((e) => e.requestRide("rider", trip(10, 20))).fare).toBe(40);
    expect(M((e) => e.getProfile("rider"))).toMatchObject({ masterId: null, icon: null, fixedFare: null });
    expect(M((e) => e.joinMaster("m3", "tok-master-0123456789", "dev-m3", "en"))).toMatchObject({ nickname: "Master Rider", icon: null, fixedFare: 18 });
  });

  it("rate-limits wrong links, refuses a driver mid-trip or a rider with an open request, asks before replacing a profile", () => {
    for (let i = 0; i < 10; i++) code(() => M((e) => e.joinMaster("x", "nope", "dev-x", "en")));
    expect(code(() => M((e) => e.joinMaster("x", "tok-master-0123456789", "dev-x", "en")))).toBe("rate_limited");
    request();
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    expect(code(() => M((e) => e.joinMaster("d1", "tok-master-0123456789", "dev-d1", "en", true)))).toBe("active_trip");
    expect(code(() => M((e) => e.joinMaster("rider", "tok-master-0123456789", "dev-r", "en", true)))).toBe("active_ride");
    // An idle online driver with a profile of their own: only after an explicit yes.
    online("d2", near(2));
    expect(code(() => M((e) => e.joinMaster("d2", "tok-master-0123456789", "dev-d2", "en")))).toBe("has_profile");
    expect(db.users.d2.nickname).toBe("D2");
    expect(M((e) => e.joinMaster("d2", "tok-master-0123456789", "dev-d2", "en", true))).toMatchObject({ nickname: "Master Rider", masterId: "master" });
    expect(db.drivers.d2.online).toBe(false);
    expect(code(() => M((e) => e.saveVehicle("d2", { make: "Kia", model: "Ceed", colour: "Red", plate: "WX 1", seats: 4 })))).toBe("rider_only");
    // Re-opening the same link is no replacement; switching to another master is.
    expect(M((e) => e.joinMaster("d2", "tok-master-0123456789", "dev-d2", "en")).masterId).toBe("master");
    expect(code(() => M((e) => e.joinMaster("d2", "tok-roman-0123456789", "dev-d2", "en")))).toBe("has_profile");
    M((e) => e.deleteProfile("d2"));
    expect(db.users.d2).toMatchObject({ nickname: "Deleted user", deleted: true, masterId: null });
  });

  it("gives each master profile one role: Toria rides from her default places, Roman drives his preset car", () => {
    const ROLES = [
      {
        id: "toria", token: "tok-toria-0123456789", nickname: "Toria", icon: null, fixedFare: 18, role: "rider" as const,
        pickup: { lat: 52.2504843, lng: 20.8253459, label: "Warszawsa 269, Stare Babice" },
        dropoff: { lat: 52.2663135, lng: 20.814317, label: "Husarska 16, Lipków" }
      },
      {
        id: "roman", token: "tok-roman-0123456789", nickname: "Roman", icon: "taycan-ct-green", fixedFare: 18, role: "driver" as const,
        vehicle: { make: "Porsche", model: "Taycan Cross Turismo", colour: "Green", seats: 4 }
      },
      {
        id: "plated", token: "tok-plated-0123456789", nickname: "Plated", icon: null, fixedFare: null, role: "driver" as const,
        vehicle: { make: "Kia", model: "Ceed", colour: "Red", seats: 4, plate: "wx 777" }
      }
    ];
    const R = <T>(fn: (e: Engine) => T): T => fn(new Engine(db, { ...CFG, masters: ROLES }, now));
    expect(R((e) => e.joinMaster("t1", "tok-toria-0123456789", "dev-t1", "pl"))).toMatchObject({
      nickname: "Toria", masterRole: "rider", fixedFare: 18, masterVehicle: null,
      defaultPickup: { label: "Warszawsa 269, Stare Babice" }, defaultDropoff: { label: "Husarska 16, Lipków" }
    });
    // Roman: driver only — no fixed fare, no default places; the preset car without a plate.
    expect(R((e) => e.joinMaster("r1", "tok-roman-0123456789", "dev-r1", "pl"))).toMatchObject({
      nickname: "Roman", masterRole: "driver", icon: "taycan-ct-green", fixedFare: null, defaultPickup: null,
      masterVehicle: { make: "Porsche", model: "Taycan Cross Turismo", colour: "Green", seats: 4 }
    });
    expect(code(() => R((e) => e.requestRide("r1", trip(5, 10))))).toBe("driver_only");
    expect(code(() => R((e) => e.setOnline("r1", true)))).toBe("no_vehicle"); // the phone adds the plate once
    R((e) => e.saveVehicle("r1", { make: "Porsche", model: "Taycan Cross Turismo", colour: "Green", plate: "wx 5555", seats: 4 }));
    // Toria rides at the fixed fare; Roman takes it and she sees his icon, car and plate.
    const ride = R((e) => e.requestRide("t1", trip(30, 45)));
    expect(ride.fare).toBe(18);
    const o = R((e) => {
      e.setOnline("r1", true);
      return e.heartbeat("r1", near(1));
    }).offer!;
    expect(o.rider.nickname).toBe("Toria");
    R((e) => e.decideOffer("r1", o.id, "accept"));
    expect(R((e) => e.getRide("t1", ride.id)).driver).toMatchObject({ nickname: "Roman", icon: "taycan-ct-green", vehicle: { plate: "WX 5555" } });
    // A driver profile with a complete preset car needs no form at all.
    R((e) => e.joinMaster("r2", "tok-plated-0123456789", "dev-r2", "en"));
    expect(R((e) => e.getVehicle("r2"))).toMatchObject({ plate: "WX 777" });
  });

  it("switching a master off ends link-only access; invite members stay rider-only at the tariff", () => {
    M((e) => e.joinMaster("m5", "tok-roman-0123456789", "dev-m5", "en"));
    // d3 entered the invite code before, then opened the link (confirmed).
    M((e) => e.joinMaster("d3", "tok-roman-0123456789", "dev-d3", "en", true));
    const off = <T>(fn: (e: Engine) => T): T =>
      fn(new Engine(db, { ...CFG, masters: MASTERS.map((m) => (m.id === "roman" ? { ...m, active: false } : m)) }, now));
    expect(off((e) => e.isMember("m5"))).toBe(false);
    expect(code(() => off((e) => e.myState("m5")))).toBe("not_member");
    expect(code(() => off((e) => e.joinMaster("m6", "tok-roman-0123456789", "dev-m6", "en")))).toBe("bad_link");
    expect(off((e) => e.getProfile("d3"))).toMatchObject({ nickname: "Roman", masterId: "roman", icon: null, fixedFare: null });
    expect(off((e) => e.saveProfile("d3", "Mallory", "en")).nickname).toBe("Roman");
    expect(code(() => off((e) => e.setOnline("d3", true)))).toBe("rider_only");
    expect(off((e) => e.requestRide("d3", trip(10, 20))).fare).toBe(40);
    // Switched on again: the link phones are back.
    expect(M((e) => e.isMember("m5"))).toBe(true);
  });
});

describe("rides booked in advance", () => {
  const MIN = 60_000;
  const book = (uid = "rider", inMin = 120, extra: Partial<{ estKm: number; estMin: number }> = {}) =>
    at((e) => e.bookRide(uid, { pickup: PICKUP, dropoff: DROPOFF, estKm: 3.42, estMin: 8.6, fareIsEstimate: false, ...extra, scheduledFor: now + inMin * MIN }));

  it("books for later within the window, lists it apart from history, and lets the rider cancel", () => {
    expect(code(() => book("rider", 10))).toBe("bad_time"); // < 30 min ahead
    expect(code(() => book("rider", 31 * 24 * 60))).toBe("bad_time"); // > 30 days
    const b = book();
    expect(b).toMatchObject({ status: "scheduled", scheduledFor: now + 120 * MIN, fare: 18, driver: null, role: "rider" });
    expect(at((e) => e.bookings("rider")).map((r) => r.id)).toEqual([b.id]);
    expect(at((e) => e.myState("rider"))).toMatchObject({ ride: null, bookings: 1 });
    expect(at((e) => e.history("rider"))).toEqual([]);
    expect(request().status).toBe("requested"); // a ride right now is still possible
    for (let i = 0; i < 4; i++) book("rider", 180 + i * 60);
    expect(code(() => book("rider", 600))).toBe("too_many");
    at((e) => e.cancelRide("rider", b.id));
    expect(db.rides[b.id]).toMatchObject({ status: "cancelled", cancelledBy: "rider" });
    expect(db.users.rider.riderCancels).toBe(0); // more than an hour ahead: no mark
  });

  it("lets drivers browse and take a booking in advance; it starts with that driver 30 min before", () => {
    const b = book();
    online("d2", near(2));
    const open = at((e) => e.openBookings("d1", near(1)));
    expect(open).toMatchObject([{ ride: { id: b.id, rider: { nickname: "Ola" } }, distanceKm: 1 }]);
    expect(at((e) => e.myState("d1")).openBookings).toBe(1);
    expect(at((e) => e.claimBooking("d1", b.id))).toBe("won");
    expect(at((e) => e.myState("d1"))).toMatchObject({ bookings: 0, driverBookings: 1, hasProfile: true });
    expect(at((e) => e.myState("rider"))).toMatchObject({ bookings: 1, driverBookings: 0 });
    expect(code(() => at((e) => e.claimBooking("d2", b.id)))).toBe("taken");
    const b2 = book("rider2", 150); // within 8.6 + 30 min of the first: overlaps for d1
    expect(code(() => at((e) => e.claimBooking("d1", b2.id)))).toBe("overlap");
    expect(at((e) => e.bookings("rider"))[0].driver).toMatchObject({ nickname: "D1", vehicle: { plate: "WX D1" } });
    expect(at((e) => e.bookings("d1"))[0]).toMatchObject({ id: b.id, role: "driver" });
    // 31 min before: still booked; 30 min before: accepted, the driver on duty though their app is closed.
    now = b.scheduledFor! - 31 * MIN;
    expect(at((e) => e.getRide("rider", b.id)).status).toBe("scheduled");
    now = b.scheduledFor! - 30 * MIN;
    expect(at((e) => e.myState("d1")).ride).toMatchObject({ id: b.id, status: "accepted" });
    expect(db.drivers.d1.online).toBe(true);
    expect(at((e) => e.myState("rider")).ride).toMatchObject({ id: b.id, status: "accepted", driver: { nickname: "D1" } });
    // The driver may stay silent until 15 min after the booked time, then it goes to someone else.
    now = b.scheduledFor! + 14 * MIN;
    expect(at((e) => e.getRide("rider", b.id)).status).toBe("accepted");
    now = b.scheduledFor! + 16 * MIN;
    expect(at((e) => e.getRide("rider", b.id))).toMatchObject({ status: "requested", driver: null });
  });

  it("counts the no-show wait from the booked time when the driver comes early", () => {
    const b = book();
    at((e) => e.claimBooking("d1", b.id));
    now = b.scheduledFor! - 30 * MIN;
    at((e) => e.heartbeat("d1", near(1))); // started
    now = b.scheduledFor! - 20 * MIN;
    at((e) => e.advance("d1", b.id, "arrived")); // 20 min early
    now = b.scheduledFor! - 10 * MIN; // 10 min after arriving, still before the booked time
    expect(code(() => at((e) => e.cancelRide("d1", b.id, "no_show")))).toBe("too_early");
    now = b.scheduledFor! + 5 * MIN;
    at((e) => e.cancelRide("d1", b.id, "no_show"));
    expect(db.rides[b.id]).toMatchObject({ status: "cancelled", cancelReason: "no_show" });
  });

  it("opens an unclaimed booking to normal dispatch 20 min before and expires it 15 min after its time", () => {
    const b = book();
    now = b.scheduledFor! - 21 * MIN;
    expect(at((e) => e.getRide("rider", b.id)).status).toBe("scheduled");
    now = b.scheduledFor! - 20 * MIN;
    const s = online("d2", near(2));
    expect(s.offer?.rideId).toBe(b.id);
    expect(at((e) => e.getRide("rider", b.id)).expiresAt).toBe(b.scheduledFor! + 15 * MIN);
    now = b.scheduledFor! + 15 * MIN;
    expect(at((e) => e.getRide("rider", b.id)).status).toBe("expired");
  });

  it("waits while the taking driver is on another trip, then hands the booking to normal dispatch", () => {
    const b = book();
    at((e) => e.claimBooking("d1", b.id));
    now = b.scheduledFor! - 40 * MIN;
    request("rider2");
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept")); // d1 busy with rider2
    now = b.scheduledFor! - 30 * MIN;
    at((e) => e.heartbeat("d1", near(1)));
    expect(db.rides[b.id].status).toBe("scheduled");
    now = b.scheduledFor! + 16 * MIN;
    at((e) => e.heartbeat("d1", near(1)));
    expect(db.rides[b.id]).toMatchObject({ status: "requested", driverId: null });
  });

  it("ends bookings of removed users, waits while a person is busy in either role, caps new bookings", () => {
    const b = book();
    at((e) => e.claimBooking("d1", b.id));
    delete db.users.d1; // the operator removed the driver
    now = b.scheduledFor! - 30 * MIN;
    at((e) => e.sweep());
    expect(db.rides[b.id]).toMatchObject({ status: "requested", driverId: null });
    const b2 = book("rider2", 120);
    delete db.users.rider2;
    now = b2.scheduledFor! - 20 * MIN;
    at((e) => e.sweep());
    expect(db.rides[b2.id]).toMatchObject({ status: "cancelled", cancelReason: "user_gone" });
    // A driver with an open request as a rider is busy: the booking they took waits.
    user("r9", "Renia");
    const b3 = book("r9", 120);
    at((e) => e.claimBooking("d2", b3.id));
    db.drivers.d2 = { online: false, lastSeen: now };
    at((e) => e.requestRide("d2", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3, estMin: 8, fareIsEstimate: false }));
    now = b3.scheduledFor! - 30 * MIN;
    at((e) => e.sweep());
    expect(db.rides[b3.id].status).toBe("scheduled");
    // Car-less users see no bookings to take; at most 10 new bookings a day.
    expect(code(() => at((e) => e.openBookings("rider", null)))).toBe("no_vehicle");
    expect(at((e) => e.myState("rider")).openBookings).toBe(0);
    user("r8", "Rysia");
    for (let i = 0; i < 10; i++) at((e) => e.cancelRide("r8", book("r8", 200 + i).id));
    expect(code(() => book("r8", 400))).toBe("too_many");
  });

  it("lets a driver give a booking back (late counts), and keeps one-role master profiles apart", () => {
    const b = book();
    at((e) => e.claimBooking("d1", b.id));
    at((e) => e.releaseBooking("d1", b.id));
    expect(db.users.d1.driverCancels).toBe(0);
    at((e) => e.claimBooking("d1", b.id));
    now = b.scheduledFor! - 50 * MIN;
    at((e) => e.cancelRide("d1", b.id)); // the driver's cancel = give back
    expect(db.users.d1.driverCancels).toBe(1);
    expect(db.rides[b.id]).toMatchObject({ status: "scheduled", driverId: null });
    const M = [
      { id: "toria", token: "tok-toria-0123456789", nickname: "Toria", icon: null, fixedFare: 18, role: "rider" as const },
      { id: "roman", token: "tok-roman-0123456789", nickname: "Roman", icon: null, fixedFare: null, role: "driver" as const }
    ];
    const E = <T>(fn: (e: Engine) => T): T => fn(new Engine(db, { ...CFG, masters: M }, now));
    E((e) => e.joinMaster("t1", "tok-toria-0123456789", "dev-t1", "en"));
    E((e) => e.joinMaster("r1", "tok-roman-0123456789", "dev-r1", "en"));
    expect(code(() => E((e) => e.openBookings("t1", null)))).toBe("rider_only");
    expect(E((e) => e.myState("t1")).openBookings).toBe(0);
    expect(code(() => E((e) => e.bookRide("r1", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3, estMin: 8, fareIsEstimate: false, scheduledFor: now + 120 * MIN })))).toBe("driver_only");
    expect(E((e) => e.bookRide("t1", { pickup: PICKUP, dropoff: DROPOFF, estKm: 30, estMin: 45, fareIsEstimate: true, scheduledFor: now + 120 * MIN }))).toMatchObject({ fare: 18, fareIsEstimate: false });
  });
});

describe("notifications (who hears what)", () => {
  const MIN = 60_000;
  const ev = (fn: (e: Engine) => unknown): string[] => {
    const e = new Engine(db, CFG, now);
    fn(e);
    return e.effects.push.map((p) => `${p.kind}>${p.userId}`);
  };

  it("tells the right person at each step of a booking and of a ride", () => {
    let id = "";
    const trip = { pickup: PICKUP, dropoff: DROPOFF, estKm: 3.42, estMin: 8.6, fareIsEstimate: false };
    expect(ev((e) => (id = e.bookRide("rider", { ...trip, scheduledFor: now + 120 * MIN }).id))).toEqual([
      "booking_new>d1",
      "booking_new>d2",
      "booking_new>d3",
      "booking_new>far"
    ]);
    expect(ev((e) => e.claimBooking("d1", id))).toEqual(["booking_taken>rider"]);
    expect(ev((e) => e.releaseBooking("d1", id))).toEqual(["booking_released>rider"]);
    ev((e) => e.claimBooking("d2", id));
    const t = db.rides[id].scheduledFor!;
    now = t - 30 * MIN;
    const start = new Engine(db, CFG, now);
    start.sweep();
    expect(start.effects.push.map((p) => `${p.kind}>${p.userId}`)).toEqual(["time_to_go>d2", "driver_coming>rider"]);
    expect(start.effects.push[0].params).toMatchObject({ at: t, pickup: "Centrum", rider: "Ola" });
    expect(ev((e) => e.advance("d2", id, "arrived"))).toEqual(["driver_arrived>rider"]);
    // A ride right now: accepting tells the rider.
    request("rider2");
    const o = online("d3", near(3)).offer!;
    expect(ev((e) => e.decideOffer("d3", o.id, "accept"))).toEqual(["driver_coming>rider2"]);
    // The rider cancels a taken booking: its driver hears it; an untaken one opening: its rider.
    user("x", "Xena");
    const b2 = at((e) => e.bookRide("x", { ...trip, scheduledFor: now + 300 * MIN }));
    at((e) => e.claimBooking("d1", b2.id));
    expect(ev((e) => e.cancelRide("x", b2.id))).toEqual(["booking_cancelled>d1"]);
    const b3 = at((e) => e.bookRide("x", { ...trip, scheduledFor: now + 400 * MIN }));
    now = b3.scheduledFor! - 20 * MIN;
    expect(ev((e) => e.sweep())).toContain("booking_open>x");
  });
});

describe("driver standby (iOS gives web apps no background time)", () => {
  const trip = { pickup: PICKUP, dropoff: DROPOFF, estKm: 3.42, estMin: 8.6, fareIsEstimate: false };
  const ev = (fn: (e: Engine) => unknown, cfg = CFG): string[] => {
    const e = new Engine(db, cfg, now);
    fn(e);
    return e.effects.push.map((p) => `${p.kind}>${p.userId}`);
  };

  it("notifies an online driver whose app went quiet about each new request, until they go offline", () => {
    online("d1", near(1));
    online("d2", near(2));
    at((e) => e.setOnline("d2", false)); // explicit offline: no standby
    now += 2 * 60_000; // d1 locked the phone: set offline after 60 s, still on standby
    at((e) => e.sweep());
    expect(db.drivers.d1.online).toBe(false);
    expect(at((e) => e.myState("d1")).standby).toBe(true);
    online("d3", near(3)); // app in front: the offer card shows it, no notification
    expect(ev((e) => e.requestRide("rider", trip))).toEqual(["request_new>d1"]);
    now += 5 * 3600_000; // standby lasts 4 h
    expect(ev((e) => e.requestRide("rider2", trip))).toEqual([]);
    expect(at((e) => e.myState("d1")).standby).toBe(false);
  });

  it("is off with standbyHours 0", () => {
    const off = { ...CFG, standbyHours: 0 };
    new Engine(db, off, now).setOnline("d1", true);
    now += 2 * 60_000;
    expect(ev((e) => e.requestRide("rider", trip), off)).toEqual([]);
  });
});

describe("moving a profile into the app (iOS Home Screen apps have their own storage)", () => {
  it("moves profile, history, ratings and vehicle to the app once; the browser starts fresh", () => {
    const ride = request();
    const o = online("d1", near(1)).offer!;
    at((e) => e.decideOffer("d1", o.id, "accept"));
    for (const to of ["arrived", "in_progress", "completed"] as const) at((e) => e.advance("d1", ride.id, to, 3));
    at((e) => e.rate("rider", ride.id, 5, ""));
    at((e) => e.rate("d1", ride.id, 4, ""));
    at((e) => e.setOnline("d1", false));
    const { code, expiresAt } = at((e) => e.createTransfer("d1"));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(expiresAt).toBe(now + 30 * 60_000);
    // The app is a new account that has not even entered the invite code.
    expect(code_(() => at((e) => e.redeemTransfer("app", "WRONG-CODE", "dev-app")))).toBe("bad_transfer");
    const p = at((e) => e.redeemTransfer("app", code.toLowerCase().replace("-", " "), "dev-app"));
    expect(p).toMatchObject({ userId: "app", nickname: "D1", rating: { count: 1 } });
    expect(at((e) => e.isMember("app", "dev-app"))).toBe(true);
    expect(at((e) => e.getVehicle("app"))?.plate).toBe("WX D1");
    expect(at((e) => e.history("app"))[0]).toMatchObject({ id: ride.id, role: "driver", status: "completed" });
    expect(at((e) => e.getRide("rider", ride.id)).driver?.nickname).toBe("D1");
    expect(at((e) => e.getProfile("d1"))).toBeNull();
    expect(at((e) => e.isMember("d1"))).toBe(false);
    expect(code_(() => at((e) => e.redeemTransfer("app2", code, "dev-app2")))).toBe("bad_transfer"); // once only
    // Expired codes do not work.
    const late = at((e) => e.createTransfer("rider")).code;
    now += 31 * 60_000;
    expect(code_(() => at((e) => e.redeemTransfer("app3", late, "dev-app3")))).toBe("bad_transfer");
  });

  it("asks before merging into a profile already in the app, refuses during a ride, rate-limits guesses", () => {
    const { code } = at((e) => e.createTransfer("rider"));
    expect(code_(() => at((e) => e.redeemTransfer("rider2", code, "dev-r2")))).toBe("has_profile");
    request("rider2");
    expect(code_(() => at((e) => e.redeemTransfer("rider2", code, "dev-r2", true)))).toBe("active_ride");
    at((e) => e.cancelRide("rider2", Object.values(db.rides)[0].id));
    expect(at((e) => e.redeemTransfer("rider2", code, "dev-r2", true))).toMatchObject({ userId: "rider2", nickname: "Ola" });
    for (let i = 0; i < 10; i++) code_(() => at((e) => e.redeemTransfer("x", "AAAA-AAAA", "dev-x")));
    const next = at((e) => e.createTransfer("rider2")).code;
    expect(code_(() => at((e) => e.redeemTransfer("x", next, "dev-x")))).toBe("rate_limited");
  });

  it("refuses a code of a phone whose master link was replaced; merges clashing cards and ratings", () => {
    const M = [{ id: "mv", token: "tok-mv-0123456789ab", nickname: "Mover", icon: null, fixedFare: null, role: "rider" as const }];
    const E = <T>(fn: (e: Engine) => T, masters = M): T => fn(new Engine(db, { ...CFG, masters }, now));
    E((e) => e.joinMaster("lk", "tok-mv-0123456789ab", "dev-lk", "en"));
    const { code } = E((e) => e.createTransfer("lk"));
    expect(code_(() => E((e) => e.redeemTransfer("app", code, "dev-app"), []))).toBe("bad_transfer");
    // d1 (browser) and d2 (the app) both got a card for one ride and both rated one ride.
    const ride = request();
    online("d1", near(1));
    online("d2", near(2));
    db.ratings.push({ rideId: "rx", fromUser: "d1", toUser: "rider", stars: 5, comment: "", createdAt: now });
    db.ratings.push({ rideId: "rx", fromUser: "d2", toUser: "rider", stars: 4, comment: "", createdAt: now });
    at((e) => e.setOnline("d1", false));
    at((e) => e.setOnline("d2", false));
    const c2 = at((e) => e.createTransfer("d1")).code;
    at((e) => e.redeemTransfer("d2", c2, "dev-d2", true));
    expect(Object.values(db.offers).filter((o) => o.rideId === ride.id && o.driverId === "d2")).toHaveLength(1);
    expect(db.ratings.filter((g) => g.rideId === "rx")).toEqual([expect.objectContaining({ fromUser: "d2", stars: 4 })]);
  });

  it("keeps a master profile's link membership when it moves into the app", () => {
    const M = [{ id: "toria", token: "tok-toria-0123456789", nickname: "Toria", icon: null, fixedFare: 18, role: "rider" as const }];
    const E = <T>(fn: (e: Engine) => T): T => fn(new Engine(db, { ...CFG, masters: M }, now));
    E((e) => e.joinMaster("t1", "tok-toria-0123456789", "dev-t1", "en"));
    const { code } = E((e) => e.createTransfer("t1"));
    expect(E((e) => e.redeemTransfer("t2", code, "dev-t2"))).toMatchObject({ nickname: "Toria", masterId: "toria", fixedFare: 18 });
    expect(E((e) => e.isMember("t2", "dev-t2"))).toBe(true);
    expect(db.members.t2).toBeUndefined(); // still only through the link: switching it off ends access
    expect(new Engine(db, { ...CFG, masters: M.map((m) => ({ ...m, active: false })) }, now).isMember("t2")).toBe(false);
  });
});

describe("guards and privacy (FR-005, FR-007, FR-043, FR-044)", () => {
  it("requires the invite code, then only a nickname", () => {
    expect(code(() => at((e) => e.myState("stranger")))).toBe("not_member");
    expect(code(() => at((e) => e.join("stranger", "nope", "dev")))).toBe("bad_invite");
    at((e) => e.join("stranger", " pilot ", "dev"));
    expect(at((e) => e.isMember("stranger", "dev"))).toBe(true);
    expect(code(() => at((e) => e.saveProfile("stranger", "A", "en")))).toBe("bad_nickname");
    expect(code(() => at((e) => e.requestRide("stranger", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3, estMin: 8, fareIsEstimate: false })))).toBe("no_profile");
  });

  it("refuses requests from online drivers and going online during a ride", () => {
    online("d1", near(1));
    expect(code(() => at((e) => e.requestRide("d1", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3, estMin: 8, fareIsEstimate: false })))).toBe("online_as_driver");
    request("rider");
    at((e) => e.saveVehicle("rider", { make: "A", model: "B", colour: "C", plate: "XY", seats: 2 }));
    expect(code(() => at((e) => e.setOnline("rider", true)))).toBe("active_ride");
  });

  it("refuses trips outside the area or longer than 50 km and never trusts a too-short route", () => {
    const far = { ...destination(PICKUP, 0, 60), label: "far" };
    expect(code(() => at((e) => e.requestRide("rider", { pickup: PICKUP, dropoff: far, estKm: 10, estMin: 10, fareIsEstimate: false })))).toBe("too_far");
    const e2 = new Engine(db, { ...CFG, serviceArea: { lat: 50, lng: 19, radiusKm: 20 } }, now);
    expect(code(() => e2.requestRide("rider", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3, estMin: 8, fareIsEstimate: false }))).toBe("outside_area");
    const r = at((e) => e.requestRide("rider", { pickup: PICKUP, dropoff: DROPOFF, estKm: 0.5, estMin: 8, fareIsEstimate: false }));
    expect(r.estKm).toBeGreaterThanOrEqual(3);
  });

  it("hides the vehicle until assignment and stores no position trail", () => {
    const ride = request();
    expect(at((e) => e.getRide("rider", ride.id)).driver).toBeNull();
    const o = online("d1", near(1)).offer!;
    expect(JSON.stringify(o)).not.toMatch(/plate|vehicle/);
    at((e) => e.decideOffer("d1", o.id, "accept"));
    const stored = JSON.stringify(db);
    const pos = near(1);
    expect(stored).not.toContain(String(pos.lat).slice(0, 8)); // the driver's position was never stored
    expect(Object.keys(db.drivers.d1).sort()).toEqual(["lastSeen", "online", "standbyUntil"]);
    expect(code(() => at((e) => e.getRide("d3", ride.id)))).toBe("not_found");
  });

  it("lists the last 50 rides newest first and excludes cancelled rides from earnings", () => {
    for (let i = 0; i < 55; i++) {
      const r = request();
      at((e) => e.cancelRide("rider", r.id));
      now += 1000;
    }
    const h = at((e) => e.history("rider"));
    expect(h).toHaveLength(50);
    expect(h[0].requestedAt).toBeGreaterThan(h[49].requestedAt);
    expect(at((e) => e.earnings("d1")).todayTotal).toBe(0);
  });

  it("anonymises a deleted profile", () => {
    const ride = request();
    at((e) => e.cancelRide("rider", ride.id));
    at((e) => e.deleteProfile("rider"));
    expect(at((e) => e.getProfile("rider"))).toBeNull();
    expect(db.users.rider.nickname).toBe("Deleted user");
  });
});
