// Keeps the screen on (Screen Wake Lock) while Siosia is on screen and something wants it: a driver
// who is online (FR-020) or the "Keep the screen on" checkbox (this phone's choice, remembered).
// While the screen stays on the app is never paused, so the live position, requests and countdowns
// keep running. The phone drops the lock whenever Siosia leaves the screen; it is taken again when
// Siosia comes back. iOS grants the first lock of each launch only from a tap (WebKit needs a
// user activation), so after a launch or reload the next tap anywhere takes it — the top bar asks
// for one meanwhile. Nothing keeps a web app running after the user switches to another app or
// locks the phone: iOS pauses it then.

import { useSyncExternalStore } from "react";
import { isIOS, isStandalone, readPref, writePref } from "./device";

export type WakeReason = "online" | "checkbox";

export interface WakeState {
  /** This phone can keep the screen on for Siosia. */
  supported: boolean;
  /** "Keep the screen on" is ticked on this phone. */
  checked: boolean;
  /** A driver is online: the screen stays on whatever the checkbox says (FR-020). */
  forced: boolean;
  /** The lock is held right now. */
  held: boolean;
  /** Wanted, but the phone will only allow it after a tap (first lock since Siosia started). */
  waiting: boolean;
  /** The phone refused even right after a tap: the screen may turn off. */
  refused: boolean;
}

const PREF = "keepScreenOn";
/** Taps and keys that count as the user's own action (a wake lock may need one). */
const TAP_EVENTS = ["touchend", "click", "keydown"] as const;
/** A lock the phone takes back sooner than this is not re-taken on its own (no request loop). */
const MIN_HELD_MS = 2000;

/** iOS version from the user agent ("OS 18_3" → [18, 3]); null when it does not say. */
export function iosVersion(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): [number, number] | null {
  const m = /\bOS (\d+)_(\d+)/.exec(ua);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Whether a wake lock works here. Home Screen apps on iOS before 18.4 have the API, but the lock
 * does nothing there (WebKit bug 254545), so those count as unsupported. iOS 26+ reports a frozen
 * "OS 18_6"/"18_7" (still ≥ 18.4); iPads report no iOS version, so the Cookie Store API (also new
 * in 18.4) tells instead.
 */
export function wakeLockWorks(): boolean {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return false;
  if (isIOS() && isStandalone()) {
    const v = iosVersion();
    if (v ? v[0] < 18 || (v[0] === 18 && v[1] < 4) : !("cookieStore" in window)) return false;
  }
  return true;
}

export class ScreenWake {
  private sentinel: WakeLockSentinel | null = null;
  private heldSince = 0;
  private pending: Promise<boolean> | null = null;
  private readonly reasons = new Set<WakeReason>();
  private readonly listeners = new Set<() => void>();
  private tapArmed = false;
  private refused = false;
  private state: WakeState;

  constructor() {
    if (readPref<boolean>(PREF, false)) this.reasons.add("checkbox");
    this.state = this.snapshot();
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", this.onShown);
    window.addEventListener("pageshow", this.onShown);
    if (this.reasons.size) void this.acquire(false);
  }

  getState = (): WakeState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** The checkbox. Call it from the tap itself: the phone may only allow the lock then. */
  setChecked(on: boolean): Promise<boolean> {
    writePref(PREF, on || null);
    return this.update("checkbox", on, true);
  }

  /** A tap on the "tap to keep the screen on" hint (any tap would do). */
  retry(): Promise<boolean> {
    return this.reasons.size ? this.acquire(true) : Promise.resolve(false);
  }

  /** Adds or removes a reason to keep the screen on; resolves with whether the lock is held. */
  want(reason: WakeReason, on: boolean): Promise<boolean> {
    return this.update(reason, on, false);
  }

  private update(reason: WakeReason, on: boolean, fromTap: boolean): Promise<boolean> {
    if (on) this.reasons.add(reason);
    else this.reasons.delete(reason);
    if (!this.reasons.size) {
      this.release();
      return Promise.resolve(true);
    }
    const held = this.acquire(fromTap);
    this.emit();
    return held;
  }

  private acquire(fromTap: boolean): Promise<boolean> {
    if (this.sentinel) return Promise.resolve(true);
    if (this.pending) return this.pending;
    if (!wakeLockWorks() || document.visibilityState !== "visible") return Promise.resolve(false);
    // The request starts synchronously, inside the tap that called us (if any).
    this.pending = (async () => {
      try {
        const s = await navigator.wakeLock.request("screen");
        if (!this.reasons.size || this.sentinel) {
          void s.release().catch(() => {});
          return !!this.sentinel;
        }
        this.sentinel = s;
        this.heldSince = Date.now();
        this.refused = false;
        this.disarmTap();
        s.addEventListener("release", () => this.onReleased(s));
        return true;
      } catch {
        // Without a tap iOS says no: try again on the next one. A no to a tap means the phone
        // won't (for now) — further taps still retry.
        if (fromTap) this.refused = true;
        this.armTap();
        return false;
      } finally {
        this.pending = null;
        this.emit();
      }
    })();
    return this.pending;
  }

  private release(): void {
    const s = this.sentinel;
    this.sentinel = null;
    this.refused = false;
    this.disarmTap();
    if (s) void s.release().catch(() => {});
    this.emit();
  }

  /** The phone dropped the lock: Siosia left the screen, or the phone took it back while visible. */
  private onReleased(s: WakeLockSentinel): void {
    if (this.sentinel !== s) return;
    this.sentinel = null;
    this.emit();
    if (!this.reasons.size || document.visibilityState !== "visible") return;
    if (Date.now() - this.heldSince >= MIN_HELD_MS) void this.acquire(false);
    else {
      this.armTap();
      this.emit();
    }
  }

  private readonly onShown = (): void => {
    if (this.reasons.size && !this.sentinel && document.visibilityState === "visible") void this.acquire(false);
  };

  private readonly onTap = (): void => {
    if (!this.reasons.size || this.sentinel) this.disarmTap();
    else void this.acquire(true);
  };

  private armTap(): void {
    if (this.tapArmed || typeof document === "undefined") return;
    this.tapArmed = true;
    for (const e of TAP_EVENTS) document.addEventListener(e, this.onTap, { capture: true, passive: true });
  }

  private disarmTap(): void {
    if (!this.tapArmed) return;
    this.tapArmed = false;
    for (const e of TAP_EVENTS) document.removeEventListener(e, this.onTap, { capture: true });
  }

  private snapshot(): WakeState {
    const supported = wakeLockWorks();
    return {
      supported,
      checked: this.reasons.has("checkbox"),
      forced: this.reasons.has("online"),
      held: !!this.sentinel,
      waiting: supported && this.reasons.size > 0 && !this.sentinel && this.tapArmed && !this.refused,
      refused: this.refused
    };
  }

  private emit(): void {
    const next = this.snapshot();
    const cur = this.state;
    if (
      next.supported === cur.supported &&
      next.checked === cur.checked &&
      next.forced === cur.forced &&
      next.held === cur.held &&
      next.waiting === cur.waiting &&
      next.refused === cur.refused
    )
      return;
    this.state = next;
    this.listeners.forEach((l) => l());
  }
}

export const screenWake = new ScreenWake();

export const useScreenWake = () => useSyncExternalStore(screenWake.subscribe, screenWake.getState, screenWake.getState);
