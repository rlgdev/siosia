// Runtime hooks that turn server state into device behaviour:
//   useDriverRuntime — online loop: heartbeat (matching), presence (nearby cars), wake lock,
//                      live position to the rider, distance actually driven (FR-020/021/035).
//   useRiderRuntime  — live position to the driver while allowed (FR-040), driver marker feed.
//   useLiveRoute     — route + ETA that re-routes on > 100 m deviation, ≤ 1 per 10 s (FR-031).
// Every stream stops on offline / cancel / complete / unmount, and announces sharing_stop (FR-042).

import { useCallback, useEffect, useRef, useState } from "react";
import type { RideChannel } from "../backend/types";
import { CADENCE } from "../core/defaults";
import { bearingDeg, coarse, distanceToPolylineM, haversineKm, haversineM, remainingKm } from "../core/geo";
import { driverShares, riderMayShare } from "../core/lifecycle";
import { PositionThrottle } from "../core/throttle";
import type { DriverPos, LatLng, MyState, RideView, RiderPos } from "../core/types";
import { ServerError } from "../core/types";
import { chime, unlockAudio } from "../services/device";
import { screenWake, useScreenWake } from "../services/wakeLock";
import { geo, useGeo, type GeoFix } from "../services/geolocation";
import { getRoute, type RouteResult } from "../services/routing";
import { sharing } from "./sharing";
import { useApp, useStore } from "./store";

/** The rider's live marker (on the driver's map) disappears this long after its last update (FR-034). */
const PEER_GONE_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// Live position sender shared by both sides
// ---------------------------------------------------------------------------------------------

/**
 * New fixes go out at most every 3 s or 25 m (FR-021); a stationary device still refreshes the
 * other side every 5 s (FR-034); and when the other party (re)joins the channel the latest fix is
 * resent at once — otherwise a parked driver would not appear on a rider's map that subscribed
 * after the first fix. Peer joins are rare (presence changes only), so the resend is never limited.
 */
/** A booked ride's car counts as "set off" once it is this far from where the ride began. */
export const DEPART_M = 150;
/** Fixes coarser than this (indoor Wi-Fi / cell fixes) say nothing about the car moving. */
export const DEPART_ACCURACY_M = 50;
/** After a failed depart call, the next try waits this long (not one call per fix). */
export const DEPART_RETRY_MS = 20_000;

/**
 * Has the car moved DEPART_M from `origin`, beyond what both fixes' accuracy could explain? Pure,
 * so the rule is unit-tested; a coarse fix never counts, as origin or as the moved fix.
 */
export function hasDeparted(origin: GeoFix | null, f: GeoFix): boolean {
  if (!origin || f.accuracy > DEPART_ACCURACY_M || origin.accuracy > DEPART_ACCURACY_M) return false;
  return haversineM(origin, f) - origin.accuracy - f.accuracy >= DEPART_M;
}

function liveSender(emit: (f: GeoFix, heading: number | null) => void) {
  const throttle = new PositionThrottle(CADENCE.livePosMs, CADENCE.livePosM);
  let lastSent = 0;
  let prev: GeoFix | null = null;
  let latest: GeoFix | null = null;
  let heading: number | null = null;
  const send = (f: GeoFix, mode: "fix" | "keepalive" | "resend") => {
    if (f.heading !== null) heading = f.heading;
    else if (prev && haversineM(prev, f) > 3) heading = bearingDeg(prev, f);
    prev = f;
    latest = f;
    const now = Date.now();
    if (mode === "fix") {
      if (!throttle.offer(f, now)) return;
    } else {
      if (mode === "keepalive" && now - lastSent < CADENCE.keepAliveMs) return;
      throttle.reset();
      throttle.offer(f, now);
    }
    lastSent = now;
    emit(f, heading === null ? null : Math.round(heading));
  };
  return {
    onFix: (f: GeoFix) => send(f, "fix"),
    resend: () => {
      if (latest) send(latest, "resend");
    },
    tick: () => {
      if (latest) send(latest, "keepalive");
    }
  };
}

/** Clears a peer's live position when it goes silent or leaves the channel (FR-034, US4). */
function usePeerExpiry(present: boolean | null, seenAt: number | null, clear: () => void): void {
  const clearRef = useRef(clear);
  clearRef.current = clear;
  // Left the channel (tab killed, connection lost): gone within 10 s.
  useEffect(() => {
    if (present !== false) return;
    const id = setTimeout(() => clearRef.current(), PEER_GONE_MS - 2000);
    return () => clearTimeout(id);
  }, [present]);
  // Silent while still "present" (presence leave can lag behind on mobile networks).
  useEffect(() => {
    if (seenAt === null) return;
    const id = setInterval(() => {
      if (Date.now() - seenAt > PEER_GONE_MS) clearRef.current();
    }, 1000);
    return () => clearInterval(id);
  }, [seenAt]);
}

const rideKeyOf = (r: RideView | null) => (r ? `${r.id}:${r.round}` : null);

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

export interface DriverRuntime {
  online: boolean;
  fix: GeoFix | null;
  geoStatus: string;
  wakeOk: boolean;
  riderPos: RiderPos | null;
  riderStopped: boolean;
  riderPresent: boolean | null;
  tripKm: number;
  /** The server set this driver offline (silent too long) without the driver asking for it. */
  autoOffline: boolean;
  /** Pending requests within the dispatch radius (from the last heartbeat); null = unknown yet. */
  nearbyRequests: number | null;
  /** "Show requests": re-offer every pending request nearby, including earlier declines. */
  refreshOffers: () => Promise<MyState | null>;
  goOnline: () => Promise<void>;
  goOffline: () => Promise<void>;
}

function tripKey(id: string) {
  return `siosia.trip.${id}`;
}

/** Asks for location permission explicitly (FR-020) and resolves with a fresh fix. */
function firstFix(timeoutMs = 15_000): Promise<GeoFix> {
  const current = geo.getState().fix;
  if (current && (geo.isSimulated() || Date.now() - current.t < 30_000)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("geo_unavailable"));
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          heading: p.coords.heading !== null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
          speed: p.coords.speed,
          t: p.timestamp || Date.now()
        }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? "geo_denied" : "geo_unavailable")),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10_000 }
    );
  });
}

export function useDriverRuntime(): DriverRuntime {
  const store = useStore();
  const app = useApp();
  const api = store.api;
  const online = !!app.my?.driverOnline;
  const ride = app.my?.ride && app.my.ride.role === "driver" ? app.my.ride : null;
  const offerId = app.my?.offer?.id ?? null;
  const { status: geoStatus, fix } = useGeo(online || !!ride);
  // The screen stays on while online (FR-020); warn when this phone can't or won't keep it on, or
  // is still waiting for the tap iOS needs first.
  const wake = useScreenWake();
  const wakeOk = wake.supported && !wake.refused && !wake.waiting;
  const [riderPos, setRiderPos] = useState<RiderPos | null>(null);
  const [riderSeenAt, setRiderSeenAt] = useState<number | null>(null);
  const [riderStopped, setRiderStopped] = useState(false);
  const [riderPresent, setRiderPresent] = useState<boolean | null>(null);
  const [tripKm, setTripKm] = useState(0);
  const [autoOffline, setAutoOffline] = useState(false);
  const [nearbyRequests, setNearbyRequests] = useState<number | null>(null);
  useEffect(() => {
    if (!online) setNearbyRequests(null);
  }, [online]);
  const offlineByUser = useRef(false);
  const wasOnline = useRef(online);
  useEffect(() => {
    // §12: a driver whose screen locked for over a minute comes back offline — say why.
    if (wasOnline.current && !online && !offlineByUser.current) setAutoOffline(true);
    if (online) {
      setAutoOffline(false);
      offlineByUser.current = false;
    }
    wasOnline.current = online;
  }, [online]);

  const idleRef = useRef(!ride);
  idleRef.current = !ride;
  const fixRef = useRef<GeoFix | null>(fix);
  fixRef.current = fix;
  const lastBeat = useRef(0);
  const beating = useRef(false);
  const pendingBeat = useRef(false);
  /** Whether the last heartbeat carried a position (matching needs one). */
  const lastBeatHadPos = useRef(false);
  /** Bumped by Show requests: a heartbeat answer that was in flight meanwhile is older — drop it. */
  const refreshGen = useRef(0);
  /** Count from a server answer: a number when it carried a position; otherwise unknown (or kept on a trip). */
  const takeNearby = useCallback((my: MyState, idleNoFix: boolean) => {
    if (typeof my.nearbyRequests === "number") setNearbyRequests(my.nearbyRequests);
    else if (idleNoFix) setNearbyRequests(null);
  }, []);

  /**
   * Heartbeat (matching + liveness). Periodic beats are floored at 1 s; forced beats (dispatch
   * pings, first fix, going online) always run — if one is already in flight, one more runs right
   * after it, so a ping is never lost (US3-1: offers within 1 s).
   */
  const beatRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const beat = useCallback(
    async (force = false) => {
      if (beating.current) {
        if (force) pendingBeat.current = true;
        return;
      }
      if (!force && Date.now() - lastBeat.current < 1000) return;
      beating.current = true;
      lastBeat.current = Date.now();
      const t0 = Date.now();
      try {
        const f = fixRef.current;
        lastBeatHadPos.current = !!f;
        const gen = refreshGen.current;
        const my = await api.heartbeat(idleRef.current && f ? coarse(f) : null);
        if (gen !== refreshGen.current) return; // a Show requests answer is newer
        store.applyMy(my, t0);
        takeNearby(my, idleRef.current && !f);
      } catch {
        /* transient; the next beat retries */
      } finally {
        beating.current = false;
        if (pendingBeat.current) {
          pendingBeat.current = false;
          setTimeout(() => void beatRef.current(true), 0);
        }
      }
    },
    [api, store, takeNearby]
  );
  beatRef.current = beat;

  const goOnline = useCallback(async () => {
    unlockAudio();
    // Ask for the screen lock now, inside the tap: iOS honours a tap for 5 s only, and the location
    // fix plus the server round trips can take longer (the online effect below keeps it after that).
    void screenWake.want("online", true);
    try {
      let f: GeoFix;
      try {
        f = await firstFix();
      } catch (e) {
        throw new ServerError("not_online", (e as Error).message);
      }
      await api.setOnline(true);
      // Use the fresh position right away (the shared watch may not have delivered yet).
      geo.seed(f);
      await store.refresh();
    } catch (e) {
      if (!store.get().my?.driverOnline) void screenWake.want("online", false);
      throw e;
    }
  }, [api, store]);

  const refreshOffers = useCallback(async (): Promise<MyState | null> => {
    const f = fixRef.current;
    if (!f) return null;
    const t0 = Date.now();
    refreshGen.current++;
    const my = await api.refreshOffers(coarse(f));
    store.applyMy(my, t0);
    takeNearby(my, false);
    return my;
  }, [api, store, takeNearby]);

  // Standby: the server kept this driver "on call" while the app was closed. Opening the app (for
  // example from a "new request" notification) brings them back online at once.
  const standby = !!app.my?.standby;
  const resumeTried = useRef(false);
  useEffect(() => {
    if (online) {
      resumeTried.current = false;
      return;
    }
    if (!standby || resumeTried.current || offlineByUser.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    resumeTried.current = true;
    void goOnline().catch(() => {});
  }, [online, standby, goOnline]);

  const goOffline = useCallback(async () => {
    offlineByUser.current = true;
    try {
      await api.setOnline(false);
    } catch (e) {
      offlineByUser.current = false;
      throw e;
    }
    await store.refresh();
  }, [api, store]);

  // Wake lock + S4 entry while online (FR-020, FR-041). During a trip the server refuses to go
  // offline (FR-028); the banner shows that refusal instead of failing silently.
  useEffect(() => {
    if (!online) return;
    void screenWake.want("online", true);
    sharing.set("driver", {
      role: "driver",
      stop: async () => {
        try {
          await goOffline();
        } catch (e) {
          store.requestRefresh();
          throw e;
        }
      }
    });
    return () => {
      void screenWake.want("online", false);
      sharing.set("driver", null);
    };
  }, [online, goOffline, store]);

  // Heartbeat loop + data-less pings (ping → pull offers immediately).
  useEffect(() => {
    if (!online) return;
    void beat(true);
    const id = setInterval(() => void beat(), CADENCE.heartbeatMs);
    const unsubPing = api.onDriverPing(() => void beat(true));
    return () => {
      clearInterval(id);
      unsubPing();
    };
  }, [online, api, beat]);

  // First fix after going online → beat right away so nearby requests are pulled (unless the
  // going-online beat already carried a position).
  const hasFix = !!fix;
  useEffect(() => {
    if (online && hasFix && !lastBeatHadPos.current) void beat(true);
  }, [online, hasFix, beat]);

  // Nearby-cars presence while online and idle: coarse, every 30 s or 200 m (FR-021). Each idle
  // period gets a fresh random presence key, so riders cannot follow one driver over time.
  const presThrottle = useRef(new PositionThrottle(CADENCE.presenceMs, CADENCE.presenceM));
  const idle = !ride;
  useEffect(() => {
    if (!online || !idle) return;
    const handle = api.driverPresence();
    presThrottle.current.reset();
    let last: LatLng | null = null;
    const send = (f: GeoFix) => {
      if (!presThrottle.current.offer(f, Date.now())) return;
      const heading = f.heading ?? (last ? bearingDeg(last, f) : null);
      last = f;
      handle.track({ ...coarse(f), state: "idle", heading: heading === null ? null : Math.round(heading), t: Date.now() });
    };
    if (fixRef.current) send(fixRef.current);
    const off = geo.onFix(send);
    return () => {
      off();
      handle.close();
    };
  }, [online, idle, api]);

  // Offer chime (FR-022).
  useEffect(() => {
    if (offerId) chime();
  }, [offerId]);

  // Live trip channel, one per assignment (ride id + dispatch round): driver_pos → rider;
  // rider_pos ← rider (FR-034/040). A re-dispatched ride gets a new channel.
  const rideKey = rideKeyOf(ride);
  const rideRef = useRef(ride);
  rideRef.current = ride;
  const rideStatus = ride?.status ?? null;
  const channel = useRef<RideChannel | null>(null);
  const resend = useRef<(() => void) | null>(null);
  const clearRider = useCallback(() => {
    setRiderPos(null);
    setRiderSeenAt(null);
  }, []);
  useEffect(() => {
    const r = rideRef.current;
    if (!rideKey || !r) return;
    clearRider();
    setRiderStopped(false);
    setRiderPresent(null);
    const ch = api.openRide({ id: r.id, round: r.round }, "driver", {
      onRiderPos: (p) => {
        setRiderPos(p);
        setRiderSeenAt(Date.now());
        setRiderStopped(false);
      },
      onSharingStop: () => {
        clearRider();
        setRiderStopped(true);
      },
      onPeer: (present) => {
        setRiderPresent(present);
        if (present) resend.current?.();
      }
    });
    channel.current = ch;
    return () => {
      ch.sendSharingStop({ from: "driver" });
      ch.close();
      channel.current = null;
      clearRider();
    };
  }, [rideKey, api, clearRider]);

  usePeerExpiry(riderPresent, riderSeenAt, clearRider);

  // Send own position to the rider every 3 s or 25 m (keep-alive 5 s) while accepted/arrived/in_progress.
  useEffect(() => {
    if (!rideKey || !rideStatus || !driverShares(rideStatus)) return;
    const sender = liveSender((f, heading) =>
      channel.current?.sendDriverPos({ lat: f.lat, lng: f.lng, heading, accuracy: Math.round(f.accuracy), t: Date.now() })
    );
    resend.current = sender.resend;
    if (fixRef.current) sender.onFix(fixRef.current);
    const off = geo.onFix(sender.onFix);
    const keep = setInterval(sender.tick, 1000);
    return () => {
      off();
      clearInterval(keep);
      resend.current = null;
    };
  }, [rideKey, rideStatus]);

  // 2.2 (FR-180): a booked ride starts while the driver may still be at home. Once the car has
  // moved DEPART_M from where this ride began on this phone, the rider is told it set off. The
  // server ignores repeats, so a reload simply measures again from the new first fix.
  const departed = ride?.departedAt ?? null;
  const scheduled = ride?.scheduledFor ?? null;
  useEffect(() => {
    if (!rideKey || rideStatus !== "accepted" || departed || scheduled === null) return;
    // The origin is the first accurate fix (a coarse one would put "home" hundreds of metres off).
    const first = fixRef.current;
    let origin: GeoFix | null = first && first.accuracy <= DEPART_ACCURACY_M ? first : null;
    let sent = false;
    let failedAt = 0;
    const check = (f: GeoFix) => {
      if (sent || Date.now() - failedAt < DEPART_RETRY_MS) return;
      if (!origin) {
        if (f.accuracy <= DEPART_ACCURACY_M) origin = f;
        return;
      }
      if (!hasDeparted(origin, f)) return;
      sent = true;
      void api.depart(ride!.id).catch(() => {
        // Not reached (offline, or the server refused): try again later, not on every fix.
        sent = false;
        failedAt = Date.now();
      });
    };
    const off = geo.onFix(check);
    return off;
    // The ride and its status are what matter; fixes arrive through geo.onFix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideKey, rideStatus, departed, scheduled]);

  // Rider sharing stops at in_progress: drop their pin (FR-023).
  useEffect(() => {
    if (rideStatus === "in_progress") clearRider();
  }, [rideStatus, clearRider]);

  // Distance actually driven during the trip segment (FR-035): totals only, never a trail.
  const rideId = ride?.id ?? null;
  useEffect(() => {
    if (!rideId || rideStatus !== "in_progress") return;
    let km = Number(sessionStorage.getItem(tripKey(rideId)) ?? "0") || 0;
    setTripKm(km);
    let last: GeoFix | null = null;
    return geo.onFix((f) => {
      if (f.accuracy > 50) return;
      if (last) {
        const d = haversineM(last, f);
        const dt = Math.max(1, (f.t - last.t) / 1000);
        if (d < 5 || d / dt > 70) return; // jitter or a GPS jump
        km += d / 1000;
        setTripKm(km);
        try {
          sessionStorage.setItem(tripKey(rideId), km.toFixed(3));
        } catch {
          /* ignore */
        }
      }
      last = f;
    });
  }, [rideId, rideStatus]);

  return { online, fix, geoStatus, wakeOk, riderPos, riderStopped, riderPresent, tripKm, autoOffline, nearbyRequests, refreshOffers, goOnline, goOffline };
}

export function clearTripKm(rideId: string): void {
  try {
    sessionStorage.removeItem(tripKey(rideId));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// Rider
// ---------------------------------------------------------------------------------------------

export interface RiderRuntime {
  driverPos: DriverPos | null;
  /** Local time the last driver position arrived. */
  driverSeenAt: number | null;
  driverPresent: boolean | null;
  sharingOn: boolean;
  setSharingOn: (on: boolean) => void;
  fix: GeoFix | null;
}

export function useRiderRuntime(ride: RideView | null): RiderRuntime {
  const store = useStore();
  const api = store.api;
  const rideId = ride?.id ?? null;
  const status = ride?.status ?? null;
  const live = status === "accepted" || status === "arrived" || status === "in_progress";
  const rideKey = live ? rideKeyOf(ride) : null;
  const rideRef = useRef(ride);
  rideRef.current = ride;
  const { fix } = useGeo(!!ride);
  const [driverPos, setDriverPos] = useState<DriverPos | null>(null);
  const [driverSeenAt, setDriverSeenAt] = useState<number | null>(null);
  const [driverPresent, setDriverPresent] = useState<boolean | null>(null);
  const [sharingOn, setSharingOnState] = useState(true);
  const channel = useRef<RideChannel | null>(null);
  const resend = useRef<(() => void) | null>(null);
  const fixRef = useRef(fix);
  fixRef.current = fix;

  useEffect(() => {
    setSharingOnState(true);
  }, [rideId]);

  const clearDriver = useCallback(() => {
    setDriverPos(null);
    setDriverSeenAt(null);
  }, []);

  useEffect(() => {
    const r = rideRef.current;
    if (!rideKey || !r) return;
    const ch = api.openRide({ id: r.id, round: r.round }, "rider", {
      onDriverPos: (p) => {
        setDriverPos(p);
        setDriverSeenAt(Date.now());
      },
      onSharingStop: clearDriver,
      onPeer: (present) => {
        setDriverPresent(present);
        if (present) resend.current?.();
      }
    });
    channel.current = ch;
    return () => {
      ch.sendSharingStop({ from: "rider" });
      ch.close();
      channel.current = null;
      clearDriver();
      setDriverPresent(null);
    };
  }, [rideKey, api, clearDriver]);

  // A driver who goes silent or leaves the channel keeps a greyed "last seen" marker (§12 "driver's
  // screen locks"): on an iPhone a locked screen or Maps in front drops the connection exactly like
  // a closed app, and the ride is still on. Only an explicit stop (onSharingStop) or the ride ending
  // removes it.

  // Send own position while a driver is assigned and sharing is on; stops at in_progress (FR-040).
  const hasFix = !!fix;
  const sends = !!rideKey && !!status && riderMayShare(status) && status !== "requested" && sharingOn && hasFix;
  useEffect(() => {
    if (!sends) return;
    const sender = liveSender((f) => channel.current?.sendRiderPos({ lat: f.lat, lng: f.lng, accuracy: Math.round(f.accuracy), t: Date.now() }));
    resend.current = sender.resend;
    if (fixRef.current) sender.onFix(fixRef.current);
    const off = geo.onFix(sender.onFix);
    const keep = setInterval(sender.tick, 1000);
    sharing.set("rider", {
      role: "rider",
      stop: () => {
        setSharingOnState(false);
        channel.current?.sendSharingStop({ from: "rider" });
      }
    });
    return () => {
      off();
      clearInterval(keep);
      resend.current = null;
      sharing.set("rider", null);
    };
  }, [sends]);

  // Announce the stop when sharing ends because the trip started.
  useEffect(() => {
    if (status === "in_progress") channel.current?.sendSharingStop({ from: "rider" });
  }, [status]);

  const setSharingOn = useCallback((on: boolean) => {
    setSharingOnState(on);
    if (!on) channel.current?.sendSharingStop({ from: "rider" });
  }, []);

  return { driverPos, driverSeenAt, driverPresent, sharingOn, setSharingOn, fix };
}

// ---------------------------------------------------------------------------------------------
// Live route + ETA
// ---------------------------------------------------------------------------------------------

export interface LiveRoute {
  line: LatLng[] | null;
  /** Remaining distance and minutes from `from` to `to`. */
  km: number | null;
  min: number | null;
  estimate: boolean;
}

/**
 * Route from a moving point to a target. Fetches once per target, then re-routes only when the
 * moving point leaves the line by more than 100 m, at most every 10 s (FR-031, D-03).
 */
export function useLiveRoute(from: LatLng | null, to: LatLng | null): LiveRoute {
  const [route, setRoute] = useState<{ key: string; r: RouteResult } | null>(null);
  const lastFetch = useRef(0);
  const targetKey = to ? `${to.lat.toFixed(5)},${to.lng.toFixed(5)}` : "";
  const currentKey = useRef(targetKey);
  currentKey.current = targetKey;
  const fetching = useRef(false);
  const [retry, setRetry] = useState(0);
  const hasFrom = !!from;
  const current = route && route.key === targetKey ? route.r : null;

  useEffect(() => {
    lastFetch.current = 0;
  }, [targetKey]);

  const fromLat = from?.lat;
  const fromLng = from?.lng;
  useEffect(() => {
    if (!hasFrom || !to || fromLat === undefined || fromLng === undefined || fetching.current) return;
    const p = { lat: fromLat, lng: fromLng };
    const now = Date.now();
    const off = current ? distanceToPolylineM(p, current.line).m : Infinity;
    const due = !current || (off > CADENCE.routeDeviationM && now - lastFetch.current >= CADENCE.routeTripRefreshMs);
    if (!due) return;
    const key = targetKey;
    fetching.current = true;
    lastFetch.current = now;
    void getRoute(p, to).then((r) => {
      fetching.current = false;
      // A late answer for a previous target must not replace the current one; fetch again instead.
      if (key === currentKey.current) setRoute({ key, r });
      else setRetry((n) => n + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLat, fromLng, targetKey, current, hasFrom, retry]);

  if (!from || !to) return { line: null, km: null, min: null, estimate: false };
  if (!current) {
    const km = haversineKm(from, to);
    return { line: null, km, min: (km / 30) * 60, estimate: true };
  }
  const { index } = distanceToPolylineM(from, current.line);
  const rem = remainingKm(from, current.line, index);
  const kmh = current.min > 0 ? (current.km / current.min) * 60 : 30;
  return { line: [from, ...current.line.slice(index + 1)], km: rem, min: (rem / Math.max(5, kmh)) * 60, estimate: current.estimate };
}
