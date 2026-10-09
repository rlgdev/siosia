// Address search via Nominatim (US5, FR-033, D-03): explicit action only (never per keystroke),
// ≤ 1 request per second per device, results cached for the session, max 5 results.

import { RateGate } from "../core/throttle";
import type { LatLng, Place } from "../core/types";

let baseUrl = "https://nominatim.openstreetmap.org";
const gate = new RateGate(1000);
const cache = new Map<string, Place[]>();
const reverseCache = new Map<string, string>();

export function setGeocodeUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, "");
}

export class GeocodeError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shortLabel(displayName: string): string {
  const parts = displayName.split(",").map((s) => s.trim());
  return parts.slice(0, 3).join(", ");
}

export async function searchAddress(query: string, lang: string, near: LatLng | null): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 4) return [];
  const k = `${lang}|${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ""}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const wait = gate.reserve(Date.now());
  if (wait > 0) await sleep(wait);
  const params = new URLSearchParams({ format: "jsonv2", q, limit: "5", "accept-language": lang, addressdetails: "0" });
  if (near) {
    const d = 0.5; // prefer (not restrict to) results around the user, ~50 km box
    params.set("viewbox", `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }
  try {
    const res = await fetch(`${baseUrl}/search?${params}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new GeocodeError(`HTTP ${res.status}`);
    const rows = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    const out = rows.slice(0, 5).map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), label: shortLabel(r.display_name) }));
    cache.set(k, out);
    return out;
  } catch (e) {
    throw e instanceof GeocodeError ? e : new GeocodeError(String(e));
  }
}

/** Label for a dropped pin (one request per explicit pin drop, rate-limited and cached). */
export async function reverseLabel(p: LatLng, lang: string): Promise<string | null> {
  const k = `${lang}|${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  const hit = reverseCache.get(k);
  if (hit) return hit;
  const wait = gate.reserve(Date.now());
  if (wait > 3000) return null; // the user is dropping pins fast; keep the coordinate label
  if (wait > 0) await sleep(wait);
  try {
    const params = new URLSearchParams({ format: "jsonv2", lat: String(p.lat), lon: String(p.lng), zoom: "18", "accept-language": lang });
    const res = await fetch(`${baseUrl}/reverse?${params}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const row = (await res.json()) as { display_name?: string };
    if (!row.display_name) return null;
    const label = shortLabel(row.display_name);
    reverseCache.set(k, label);
    return label;
  } catch {
    return null;
  }
}
