import type { LatLng } from "./types";

const R_KM = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in km. Mirrored by public.siosia_km() in SQL. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const haversineM = (a: LatLng, b: LatLng) => haversineKm(a, b) * 1000;

/** Initial bearing a → b in degrees (0 = north, clockwise). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point `km` away from `a` along `bearing` degrees. */
export function destination(a: LatLng, bearing: number, km: number): LatLng {
  const d = km / R_KM;
  const br = toRad(bearing);
  const lat1 = toRad(a.lat);
  const lng1 = toRad(a.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/** Straight-line fallback (FR-032): distance × 1.3 at 30 km/h. */
export const FALLBACK_FACTOR = 1.3;
export const FALLBACK_SPEED_KMH = 30;

export function straightLineEstimate(a: LatLng, b: LatLng): { km: number; min: number } {
  const km = haversineKm(a, b) * FALLBACK_FACTOR;
  return { km, min: (km / FALLBACK_SPEED_KMH) * 60 };
}

/** Coarse position for presence and matching: rounded to ~100 m (3 decimals of latitude ≈ 111 m). */
export function coarse(p: LatLng): LatLng {
  return { lat: Math.round(p.lat * 1000) / 1000, lng: Math.round(p.lng * 1000) / 1000 };
}

export function isValidLatLng(p: LatLng | null | undefined): p is LatLng {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

/** Distance in metres from point p to segment a–b (equirectangular approximation; fine at city scale). */
export function pointToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = Math.cos(toRad(p.lat)) * 111_320;
  const ky = 110_540;
  const ax = (a.lng - p.lng) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.sqrt(x * x + y * y);
}

/** Smallest distance in metres from p to a polyline, and the index of the nearest segment. */
export function distanceToPolylineM(p: LatLng, line: LatLng[]): { m: number; index: number } {
  if (line.length === 0) return { m: Infinity, index: 0 };
  if (line.length === 1) return { m: haversineM(p, line[0]), index: 0 };
  let best = Infinity;
  let index = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const d = pointToSegmentM(p, line[i], line[i + 1]);
    if (d < best) {
      best = d;
      index = i;
    }
  }
  return { m: best, index };
}

/** Length of a polyline in km from segment `fromIndex` (starting at point p) to the end. */
export function remainingKm(p: LatLng, line: LatLng[], fromIndex: number): number {
  if (line.length === 0) return 0;
  let km = haversineKm(p, line[Math.min(fromIndex + 1, line.length - 1)]);
  for (let i = fromIndex + 1; i < line.length - 1; i++) km += haversineKm(line[i], line[i + 1]);
  return km;
}

export function polylineKm(line: LatLng[]): number {
  let km = 0;
  for (let i = 0; i < line.length - 1; i++) km += haversineKm(line[i], line[i + 1]);
  return km;
}
