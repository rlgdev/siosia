// Road routing via an OSRM-compatible server (FR-031), with the straight-line fallback (FR-032)
// when it does not answer within 2 s. Policy (D-03): ≤ 1 request per second per device.

import { CADENCE } from "../core/defaults";
import { straightLineEstimate } from "../core/geo";
import { RateGate } from "../core/throttle";
import type { LatLng } from "../core/types";

export interface RouteResult {
  km: number;
  min: number;
  line: LatLng[];
  /** True when this is the straight-line fallback (no road route). */
  estimate: boolean;
}

let baseUrl = "https://router.project-osrm.org";
const gate = new RateGate(CADENCE.routeMinGapMs);
const cache = new Map<string, RouteResult>();

export function setRoutingUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, "");
}

const key = (a: LatLng, b: LatLng) => `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;

export function fallbackRoute(a: LatLng, b: LatLng): RouteResult {
  const { km, min } = straightLineEstimate(a, b);
  return { km, min, line: [a, b], estimate: true };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Road route a → b. Never throws: falls back to the straight-line estimate. */
export async function getRoute(a: LatLng, b: LatLng, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<RouteResult> {
  const k = key(a, b);
  const hit = cache.get(k);
  if (hit) return hit;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const started = Date.now();
  const wait = gate.reserve(started);
  // The 2 s budget includes waiting for our own rate-limit slot.
  if (wait >= timeoutMs) return fallbackRoute(a, b);
  if (wait > 0) await sleep(wait);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(200, timeoutMs - (Date.now() - started)));
  try {
    const url = `${baseUrl}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: ctrl.signal });
    if (!res.ok) return fallbackRoute(a, b);
    const json = (await res.json()) as {
      code?: string;
      routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
    };
    const r = json.routes?.[0];
    if (json.code !== "Ok" || !r) return fallbackRoute(a, b);
    const out: RouteResult = {
      km: r.distance / 1000,
      min: r.duration / 60,
      line: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      estimate: false
    };
    if (cache.size > 200) cache.clear();
    cache.set(k, out);
    return out;
  } catch {
    return fallbackRoute(a, b);
  } finally {
    clearTimeout(timer);
  }
}
