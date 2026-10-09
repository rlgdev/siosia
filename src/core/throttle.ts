import { haversineM } from "./geo";
import type { LatLng } from "./types";

/**
 * Position throttle (FR-021): lets a fix through when at least `minMs` has passed since the last
 * one that was sent, or the device has moved at least `minM` metres from it — whichever first,
 * but never more often than `floorMs` (protects the realtime budget from noisy GPS).
 */
export class PositionThrottle {
  private last: { p: LatLng; t: number } | null = null;

  constructor(
    private readonly minMs: number,
    private readonly minM: number,
    private readonly floorMs = 1000
  ) {}

  shouldSend(p: LatLng, now: number): boolean {
    if (!this.last) return true;
    const dt = now - this.last.t;
    if (dt < this.floorMs) return false;
    if (dt >= this.minMs) return true;
    return haversineM(this.last.p, p) >= this.minM;
  }

  /** Returns true and records the fix if it should be sent. */
  offer(p: LatLng, now: number): boolean {
    if (!this.shouldSend(p, now)) return false;
    this.last = { p, t: now };
    return true;
  }

  reset(): void {
    this.last = null;
  }
}

/** Minimum-gap limiter for external services (≤ 1 request per `gapMs`). */
export class RateGate {
  private nextAt = 0;
  constructor(private readonly gapMs: number) {}

  /** Milliseconds to wait before the next call is allowed (and reserves that slot). */
  reserve(now: number): number {
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gapMs;
    return at - now;
  }
}
