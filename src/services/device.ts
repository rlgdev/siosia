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

export function navigationUrl(to: LatLng, mode: "driving" | "walking" = "driving"): string {
  if (isIOS()) return `https://maps.apple.com/?daddr=${to.lat},${to.lng}&dirflg=${mode === "walking" ? "w" : "d"}`;
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
