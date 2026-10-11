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
    expect(Object.keys(db.drivers.d1).sort()).toEqual(["lastSeen", "online"]);
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
