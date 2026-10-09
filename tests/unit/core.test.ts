// Unit tests for the pure rules (spec §11 "Unit"): fare (FR-050), lifecycle (§5), geo + fallback
// (FR-032), position throttling (FR-021), rating rule (FR-061).

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import { computeFare, roundToHalf } from "../../src/core/fare";
import {
  FALLBACK_FACTOR,
  bearingDeg,
  coarse,
  destination,
  distanceToPolylineM,
  haversineKm,
  remainingKm,
  straightLineEstimate
} from "../../src/core/geo";
import { TRANSITIONS, canTransition, driverShares, isActive, isTerminal, riderCanCancel, riderMayShare } from "../../src/core/lifecycle";
import { summarizeRatings } from "../../src/core/rating";
import { PositionThrottle, RateGate } from "../../src/core/throttle";
import type { RideStatus } from "../../src/core/types";

const T = DEFAULT_CONFIG.tariff;

describe("fare (FR-050)", () => {
  it("uses base + per km + per min with the spec defaults", () => {
    expect(T).toEqual({ base: 5, perKm: 2.5, perMin: 0.5, minimum: 10, currency: "PLN" });
    expect(computeFare(T, 3.21, 9.4)).toBe(17.5); // 17.725 → 17.50
    expect(computeFare(T, 10, 20)).toBe(40);
  });
  it("rounds to the nearest 0.50", () => {
    expect(roundToHalf(12.24)).toBe(12);
    expect(roundToHalf(12.25)).toBe(12.5);
    expect(roundToHalf(12.74)).toBe(12.5);
    expect(roundToHalf(12.75)).toBe(13);
    expect(computeFare(T, 1.0, 0.5)).toBe(10); // 7.75 → minimum
    expect(computeFare(T, 2.0, 1.5)).toBe(11); // 10.75 → 11.00
  });
  it("never goes below the minimum and ignores negative inputs", () => {
    expect(computeFare(T, 0.1, 1)).toBe(10);
    expect(computeFare(T, -5, -5)).toBe(10);
  });
});

describe("lifecycle (§5)", () => {
  const all: RideStatus[] = ["requested", "accepted", "arrived", "in_progress", "completed", "cancelled", "expired"];
  it("allows exactly the transitions of the state diagram", () => {
    const legal = new Set(TRANSITIONS.map((t) => `${t.from}>${t.to}`));
    expect(legal).toEqual(
      new Set([
        "requested>accepted",
        "requested>expired",
        "requested>cancelled",
        "accepted>arrived",
        "accepted>requested",
        "accepted>cancelled",
        "arrived>in_progress",
        "arrived>cancelled",
        "arrived>requested",
        "in_progress>completed"
      ])
    );
    for (const from of all) for (const to of all) expect(canTransition(from, to)).toBe(legal.has(`${from}>${to}`));
  });
  it("never leaves a terminal status and never skips a step", () => {
    for (const t of ["completed", "cancelled", "expired"] as RideStatus[]) for (const to of all) expect(canTransition(t, to)).toBe(false);
    expect(canTransition("requested", "in_progress")).toBe(false);
    expect(canTransition("accepted", "completed")).toBe(false);
    expect(canTransition("in_progress", "arrived")).toBe(false);
  });
  it("assigns each transition to the right actor", () => {
    expect(canTransition("requested", "accepted", "driver")).toBe(true);
    expect(canTransition("requested", "accepted", "rider")).toBe(false);
    expect(canTransition("requested", "expired", "system")).toBe(true);
    expect(canTransition("in_progress", "completed", "rider")).toBe(false);
  });
  it("derives cancel and sharing permissions", () => {
    expect(all.filter(riderCanCancel)).toEqual(["requested", "accepted", "arrived"]);
    expect(all.filter(riderMayShare)).toEqual(["requested", "accepted", "arrived"]);
    expect(all.filter(driverShares)).toEqual(["accepted", "arrived", "in_progress"]);
    expect(all.filter(isActive)).toEqual(["requested", "accepted", "arrived", "in_progress"]);
    expect(all.filter(isTerminal)).toEqual(["completed", "cancelled", "expired"]);
  });
});

describe("geo (FR-032, matching)", () => {
  const warsaw = { lat: 52.2297, lng: 21.0122 };
  const krakow = { lat: 50.0647, lng: 19.945 };
  it("computes great-circle distances", () => {
    expect(haversineKm(warsaw, krakow)).toBeCloseTo(252, 0);
    expect(haversineKm(warsaw, warsaw)).toBe(0);
  });
  it("falls back to straight line × 1.3 at 30 km/h", () => {
    const b = destination(warsaw, 90, 10);
    const est = straightLineEstimate(warsaw, b);
    expect(FALLBACK_FACTOR).toBe(1.3);
    expect(est.km).toBeCloseTo(13, 1);
    expect(est.min).toBeCloseTo(26, 0);
  });
  it("rounds presence positions to ~100 m", () => {
    const c = coarse({ lat: 52.229712, lng: 21.012288 });
    expect(c).toEqual({ lat: 52.23, lng: 21.012 });
    expect(haversineKm(c, { lat: 52.229712, lng: 21.012288 })).toBeLessThan(0.1);
  });
  it("measures deviation from a route and the remaining length", () => {
    const a = warsaw;
    const b = destination(a, 0, 1);
    const c = destination(b, 90, 1);
    const line = [a, b, c];
    const off = destination(destination(a, 0, 0.5), 90, 0.15);
    const d = distanceToPolylineM(off, line);
    expect(d.index).toBe(0);
    expect(d.m).toBeGreaterThan(140);
    expect(d.m).toBeLessThan(160);
    expect(remainingKm(destination(a, 0, 0.5), line, 0)).toBeCloseTo(1.5, 1);
    expect(bearingDeg(a, b)).toBeCloseTo(0, 0);
  });
});

describe("position throttling (FR-021)", () => {
  const p0 = { lat: 52.2297, lng: 21.0122 };
  it("sends at most every 3 s unless the device moved 25 m", () => {
    const th = new PositionThrottle(3000, 25);
    expect(th.offer(p0, 0)).toBe(true);
    expect(th.offer(destination(p0, 0, 0.01), 1500)).toBe(false); // 10 m, 1.5 s
    expect(th.offer(destination(p0, 0, 0.03), 1600)).toBe(true); // 30 m
    expect(th.offer(destination(p0, 0, 0.031), 4000)).toBe(false); // 2.4 s since last, 1 m
    expect(th.offer(destination(p0, 0, 0.031), 4700)).toBe(true); // ≥ 3 s
  });
  it("never sends more than once per second even when GPS jumps", () => {
    const th = new PositionThrottle(3000, 25);
    th.offer(p0, 0);
    expect(th.offer(destination(p0, 0, 1), 500)).toBe(false);
    expect(th.offer(destination(p0, 0, 1), 1000)).toBe(true);
  });
  it("uses 30 s / 200 m for the nearby-cars presence", () => {
    const th = new PositionThrottle(30_000, 200);
    th.offer(p0, 0);
    expect(th.offer(destination(p0, 90, 0.15), 20_000)).toBe(false);
    expect(th.offer(destination(p0, 90, 0.25), 21_000)).toBe(true);
  });
  it("rate-gates external services to one call per second", () => {
    const g = new RateGate(1000);
    expect(g.reserve(0)).toBe(0);
    expect(g.reserve(100)).toBe(900);
    expect(g.reserve(200)).toBe(1800);
    expect(g.reserve(5000)).toBe(0);
  });
});

describe("ratings (FR-061)", () => {
  it("shows New with fewer than 3 ratings", () => {
    expect(summarizeRatings([])).toEqual({ mean: null, count: 0 });
    expect(summarizeRatings([5, 4])).toEqual({ mean: null, count: 2 });
  });
  it("averages the last 20 ratings, newest first", () => {
    expect(summarizeRatings([5, 4, 3])).toEqual({ mean: 4, count: 3 });
    const newest20 = Array(20).fill(5);
    expect(summarizeRatings([...newest20, 1, 1, 1])).toEqual({ mean: 5, count: 23 });
  });
});
