// One shared, ref-counted geolocation watch (FR-030: high accuracy). Screens subscribe while they
// need positions; the watch stops as soon as nobody needs it (NFR-08 battery).

import { useEffect, useSyncExternalStore } from "react";

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  t: number;
}

export type GeoStatus = "idle" | "pending" | "ok" | "denied" | "unavailable";

export interface GeoState {
  status: GeoStatus;
  fix: GeoFix | null;
}

type Listener = () => void;

class GeoService {
  private state: GeoState = { status: "idle", fix: null };
  private readonly listeners = new Set<Listener>();
  private readonly fixListeners = new Set<(f: GeoFix) => void>();
  private watchId: number | null = null;
  private users = 0;
  /** Test/demo hook: when set, positions come from here instead of the browser. */
  private simulated = false;

  getState = (): GeoState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  onFix(cb: (f: GeoFix) => void): () => void {
    this.fixListeners.add(cb);
    return () => this.fixListeners.delete(cb);
  }

  acquire(): () => void {
    this.users++;
    if (this.users === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users--;
      if (this.users === 0) this.stop();
    };
  }

  /** Feeds a fresh real fix (e.g. from an explicit getCurrentPosition) into the shared state. */
  seed(fix: GeoFix): void {
    if (this.simulated) return;
    this.set({ status: "ok", fix });
  }

  /** True when positions come from ?sim= or tests instead of the device. */
  isSimulated = (): boolean => this.simulated;

  /** Injects a fix (used by ?sim= and by tests). */
  push(fix: GeoFix): void {
    this.simulated = true;
    this.set({ status: "ok", fix });
  }

  private set(next: GeoState): void {
    this.state = next;
    this.listeners.forEach((l) => l());
    if (next.fix && next.status === "ok") this.fixListeners.forEach((cb) => cb(next.fix!));
  }

  private start(): void {
    if (this.simulated) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      this.set({ status: "unavailable", fix: null });
      return;
    }
    if (this.state.status !== "ok") this.set({ ...this.state, status: "pending" });
    this.watchId = navigator.geolocation.watchPosition(
      (p) =>
        this.set({
          status: "ok",
          fix: {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: p.coords.accuracy,
            heading: p.coords.heading !== null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
            speed: p.coords.speed,
            t: p.timestamp || Date.now()
          }
        }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) this.set({ status: "denied", fix: null });
        else if (!this.state.fix) this.set({ status: "unavailable", fix: null });
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 }
    );
  }

  private stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    // A fix kept from a stopped watch is stale: never let it be used as "current" later.
    if (!this.simulated && this.state.fix) this.set({ status: "idle", fix: null });
  }
}

export const geo = new GeoService();

// Demo aid: ?sim=lat,lng gives this tab a fixed simulated position (desktop browsers without GPS).
if (typeof location !== "undefined") {
  const sim = new URLSearchParams(location.search).get("sim");
  const m = sim?.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (m) geo.push({ lat: Number(m[1]), lng: Number(m[2]), accuracy: 10, heading: null, speed: null, t: Date.now() });
}

/** Subscribes to the device position while `active` is true. */
export function useGeo(active: boolean): GeoState {
  useEffect(() => (active ? geo.acquire() : undefined), [active]);
  return useSyncExternalStore(geo.subscribe, geo.getState, geo.getState);
}
