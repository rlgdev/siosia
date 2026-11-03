// Small device helpers: offer chime, maps hand-off, device id, platform checks. (Wake lock: wakeLock.ts.)

import type { LatLng } from "../core/types";

// ---------- chime + vibration (FR-022) ----------

let audio: AudioContext | null = null;

/** Call from a user gesture (e.g. "Go online") so later chimes are allowed to play. */
export function unlockAudio(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!audio && Ctx) audio = new Ctx();
    void audio?.resume();
  } catch {
    audio = null;
  }
}

export function chime(): void {
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    /* not supported */
  }
  if (!audio) return;
  const now = audio.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.3, now + i * 0.18 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.25);
    osc.connect(gain).connect(audio!.destination);
    osc.start(now + i * 0.18);
    osc.stop(now + i * 0.18 + 0.3);
  });
}

// ---------- maps hand-off (FR-024, Rubber + Apple Maps on iOS) ----------

export const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Opened from the Home Screen (installed app) rather than in a browser tab. */
export const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true);

/**
 * Directions in the Google Maps app on every phone (FR-181; the operator's choice of 2026-10-22,
 * Apple Maps was used on iPhone before): the universal link opens the app when installed, else
 * Google Maps on the web.
 */
export function navigationUrl(to: LatLng, mode: "driving" | "walking" = "driving"): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}&travelmode=${mode}`;
}

// ---------- identity of this device (FR-007) ----------

export function deviceId(): string {
  const KEY = "siosia.device";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "d-volatile";
  }
}

// ---------- browser support (NFR-09) ----------

export function unsupportedFeatures(): string[] {
  const missing: string[] = [];
  if (typeof navigator === "undefined") return missing;
  if (!("geolocation" in navigator)) missing.push("geolocation");
  if (typeof fetch === "undefined") missing.push("fetch");
  if (typeof WebSocket === "undefined") missing.push("websocket");
  return missing;
}

// ---------- small persisted preferences ----------

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`siosia.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(`siosia.${key}`);
    else localStorage.setItem(`siosia.${key}`, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

// ---------- 2.12.3: saving a file — a photo to the gallery, an .ics to the calendar ----------

/**
 * Hands a file to the phone: on iPhone / iPad the share sheet ("Save Image" puts a photo in Photos,
 * "Add to Calendar" an .ics), elsewhere a download (Android lists a downloaded picture in its
 * gallery). Call it straight from the tap — the share sheet needs that tap (iOS honours it ~5 s).
 * Resolves "shared" | "downloaded" | "cancelled" (the person closed the sheet).
 */
export async function saveFile(file: File): Promise<"shared" | "downloaded" | "cancelled"> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (isIOS() && typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return "shared";
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return "cancelled";
      // Another refusal (e.g. the tap's permission lapsed): the download below still works.
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}

/** A data: URL's bytes, decoded at once (no fetch: the tap's permission to share stays intact). */
function dataUrlBytes(url: string): { bytes: Uint8Array; type: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const type = m[1] || "application/octet-stream";
  if (!m[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), type };
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type };
}

/**
 * A photo as a file to save: the demo's data: URL decoded, a signed Storage URL fetched (no
 * cookies; an expired or removed one is an error). Every Siosia photo is a JPEG.
 */
export async function photoFile(url: string, name: string): Promise<File> {
  const data = url.startsWith("data:") ? dataUrlBytes(url) : null;
  if (data) return new File([data.bytes], name, { type: data.type || "image/jpeg" });
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`photo ${res.status}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "image/jpeg" });
}

/** "siosia-2026-10-31-1430.jpg": the moment the photo was posted, in local time. */
export function photoName(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `siosia-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.jpg`;
}
