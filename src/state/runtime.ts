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
import type { DriverPos, LatLng, RideView, RiderPos } from "../core/types";
import { ServerError } from "../core/types";
import { chime, keepScreenOn, unlockAudio } from "../services/device";
import { geo, useGeo, type GeoFix } from "../services/geolocation";
import { getRoute, type RouteResult } from "../services/routing";
import { sharing } from "./sharing";
import { useApp, useStore } from "./store";

// ---------------------------------------------------------------------------------------------
// Live position sender shared by both sides
// ---------------------------------------------------------------------------------------------

/**
 * Throttles new fixes to every 3 s or 25 m (FR-021), keeps a stationary device alive at least every
 * 5 s (FR-034), and resends immediately when the other party (re)joins the channel — otherwise a
 * parked driver would never appear on a rider's map that subscribed after the first fix.
 */
function liveSender(emit: (f: GeoFix, heading: number | null) => void) {
  const throttle = new PositionThrottle(CADENCE.livePosMs, CADENCE.livePosM);
  let lastSent = 0;
  let prev: GeoFix | null = null;
  let latest: GeoFix | null = null;
  let heading: number | null = null;
  const send = (f: GeoFix, force: boolean) => {
    if (f.heading !== null) heading = f.heading;
    else if (prev && haversineM(prev, f) > 3) heading = bearingDeg(prev, f);
    prev = f;
    latest = f;
    const now = Date.now();
    if (force) {
      if (now - lastSent < 1000) return;
      throttle.reset();
      throttle.offer(f, now);
    } else if (!throttle.offer(f, now)) return;
    lastSent = now;
    emit(f, heading === null ? null : Math.round(heading));
  };
  return {
    onFix: (f: GeoFix) => send(f, false),
    resend: () => {
      if (latest) send(latest, true);
    },
    tick: () => {
      if (latest && Date.now() - lastSent >= CADENCE.keepAliveMs) send(latest, true);
    }
  };
}

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
  goOnline: () => Promise<void>;
  goOffline: () => Promise<void>;
}

function tripKey(id: string) {
  return `siosia.trip.${id}`;
}

/** Asks for location permission explicitly (FR-020) and resolves with a first fix. */
function firstFix(timeoutMs = 15_000): Promise<GeoFix> {
  const current = geo.getState().fix;
  if (current && (geo.isSimulated() || Date.now() - current.t < 30_000)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("geo_unavailable"));
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, t: Date.now() }),
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
  const [wakeOk, setWakeOk] = useState(true);
  const [riderPos, setRiderPos] = useState<RiderPos | null>(null);
  const [riderStopped, setRiderStopped] = useState(false);
  const [riderPresent, setRiderPresent] = useState<boolean | null>(null);
  const [tripKm, setTripKm] = useState(0);

  const idleRef = useRef(!ride);
  idleRef.current = !ride;
  const fixRef = useRef<GeoFix | null>(fix);
  fixRef.current = fix;
  const lastBeat = useRef(0);
  const beating = useRef(false);

  const beat = useCallback(async () => {
    if (beating.current || Date.now() - lastBeat.current < 1000) return;
    beating.current = true;
    lastBeat.current = Date.now();
    const t0 = Date.now();
    try {
      const f = fixRef.current;
      const my = await api.heartbeat(idleRef.current && f ? coarse(f) : null);
      store.applyMy(my, t0);
    } catch {
      /* transient; next beat retries */
    } finally {
      beating.current = false;
    }
  }, [api, store]);

  const goOnline = useCallback(async () => {
    unlockAudio();
    try {
      await firstFix();
    } catch (e) {
      throw new ServerError("not_online", (e as Error).message);
    }
    await api.setOnline(true);
    await store.refresh();
  }, [api, store]);

  const goOffline = useCallback(async () => {
    await api.setOnline(false);
    await store.refresh();
  }, [api, store]);

  // Wake lock + S4 entry while online (FR-020, FR-041).
  useEffect(() => {
    if (!online) return;
    void keepScreenOn(true).then(setWakeOk);
    sharing.set("driver", { role: "driver", stop: () => void goOffline().catch(() => store.requestRefresh()) });
    return () => {
      void keepScreenOn(false);
      sharing.set("driver", null);
    };
  }, [online, goOffline, store]);

  // Heartbeat loop + data-less pings (ping → pull offers immediately).
  useEffect(() => {
    if (!online) return;
    void beat();
    const id = setInterval(() => void beat(), CADENCE.heartbeatMs);
    const unsubPing = api.onDriverPing(() => void beat());
    return () => {
      clearInterval(id);
      unsubPing();
    };
  }, [online, api, beat]);

  // First fix after going online → beat right away so nearby requests are pulled.
  const hasFix = !!fix;
  useEffect(() => {
    if (online && hasFix) void beat();
  }, [online, hasFix, beat]);

  // Nearby-cars presence while online and idle: coarse, every 30 s or 200 m (FR-021).
  const presence = useRef<ReturnType<typeof api.driverPresence> | null>(null);
  const presThrottle = useRef(new PositionThrottle(CADENCE.presenceMs, CADENCE.presenceM));
  const idle = !ride;
  useEffect(() => {
    if (!online || !idle) return;
    const handle = api.driverPresence();
    presence.current = handle;
    presThrottle.current.reset();
    const uid = app.uid ?? "";
    let last: LatLng | null = null;
    const send = (f: GeoFix) => {
      if (!presThrottle.current.offer(f, Date.now())) return;
      const heading = f.heading ?? (last ? bearingDeg(last, f) : null);
      last = f;
      handle.track({ id: uid, ...coarse(f), state: "idle", heading: heading === null ? null : Math.round(heading), t: Date.now() });
    };
    if (fixRef.current) send(fixRef.current);
    const off = geo.onFix(send);
    return () => {
      off();
      handle.untrack();
      handle.close();
      presence.current = null;
    };
  }, [online, idle, api, app.uid]);

  // Offer chime (FR-022).
  useEffect(() => {
    if (offerId) chime();
  }, [offerId]);

  // Live trip channel: driver_pos → rider; rider_pos ← rider (FR-034/040).
  const rideId = ride?.id ?? null;
  const rideStatus = ride?.status ?? null;
  const channel = useRef<RideChannel | null>(null);
  const resend = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!rideId) return;
    setRiderPos(null);
    setRiderStopped(false);
    setRiderPresent(null);
    const ch = api.openRide(rideId, "driver", {
      onRiderPos: (p) => {
        setRiderPos(p);
        setRiderStopped(false);
      },
      onSharingStop: () => {
        setRiderPos(null);
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
      setRiderPos(null);
    };
  }, [rideId, api]);

  // Send own position to the rider every 3 s or 25 m (keep-alive 5 s) while accepted/arrived/in_progress.
  useEffect(() => {
    if (!rideId || !rideStatus || !driverShares(rideStatus)) return;
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
  }, [rideId, rideStatus]);

  // Rider sharing stops at in_progress: drop their pin (FR-023).
  useEffect(() => {
    if (rideStatus === "in_progress") setRiderPos(null);
  }, [rideStatus]);

  // Distance actually driven during the trip segment (FR-035): totals only, never a trail.
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

  return { online, fix, geoStatus, wakeOk, riderPos, riderStopped, riderPresent, tripKm, goOnline, goOffline };
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

  useEffect(() => {
    if (!rideId || !live) return;
    const ch = api.openRide(rideId, "rider", {
      onDriverPos: (p) => {
        setDriverPos(p);
        setDriverSeenAt(Date.now());
      },
      onSharingStop: () => {
        setDriverPos(null);
        setDriverSeenAt(null);
      },
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
      setDriverPos(null);
      setDriverSeenAt(null);
      setDriverPresent(null);
    };
  }, [rideId, live, api]);

  // Driver gone (tab killed) → remove the live marker (FR-034: within 10 s).
  useEffect(() => {
    if (driverPresent !== false) return;
    const id = setTimeout(() => setDriverPos(null), 8000);
    return () => clearTimeout(id);
  }, [driverPresent]);

  // Send own position while a driver is assigned and sharing is on; stops at in_progress (FR-040).
  const hasFix = !!fix;
  const sends = !!rideId && !!status && riderMayShare(status) && status !== "requested" && sharingOn && hasFix;
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
  const [route, setRoute] = useState<RouteResult | null>(null);
  const lastFetch = useRef(0);
  const targetKey = to ? `${to.lat.toFixed(5)},${to.lng.toFixed(5)}` : "";
  const fetching = useRef(false);
  const hasFrom = !!from;

  useEffect(() => {
    setRoute(null);
    lastFetch.current = 0;
  }, [targetKey]);

  const fromLat = from?.lat;
  const fromLng = from?.lng;
  useEffect(() => {
    if (!hasFrom || !to || fromLat === undefined || fromLng === undefined || fetching.current) return;
    const p = { lat: fromLat, lng: fromLng };
    const now = Date.now();
    const off = route ? distanceToPolylineM(p, route.line).m : Infinity;
    const due = !route || (off > CADENCE.routeDeviationM && now - lastFetch.current >= CADENCE.routeTripRefreshMs);
    if (!due) return;
    fetching.current = true;
    lastFetch.current = now;
    void getRoute(p, to).then((r) => {
      fetching.current = false;
      setRoute(r);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLat, fromLng, targetKey, route, hasFrom]);

  if (!from || !to) return { line: null, km: null, min: null, estimate: false };
  if (!route) {
    const km = haversineKm(from, to);
    return { line: null, km, min: (km / 30) * 60, estimate: true };
  }
  const { index } = distanceToPolylineM(from, route.line);
  const rem = remainingKm(from, route.line, index);
  const kmh = route.min > 0 ? (route.km / route.min) * 60 : 30;
  return { line: [from, ...route.line.slice(index + 1)], km: rem, min: (rem / Math.max(5, kmh)) * 60, estimate: route.estimate };
}
