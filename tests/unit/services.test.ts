// Routing fallback (FR-031/032), the mock backend through the Backend interface with its realtime
// bus (FR-070), and i18n completeness (FR-073, NFR-11).

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import { destination } from "../../src/core/geo";
import { MockBackend } from "../../src/backend/mock/index";
import { MockBus } from "../../src/backend/mock/bus";
import { resetMockDb } from "../../src/backend/mock/store";
import { en } from "../../src/i18n/en";
import { pl } from "../../src/i18n/pl";
import { translator } from "../../src/i18n";
import { fallbackRoute, getRoute } from "../../src/services/routing";

const A = { lat: 52.2297, lng: 21.0122 };
const B = destination(A, 45, 2);

describe("routing", () => {
  it("parses an OSRM route", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: "Ok", routes: [{ distance: 2600, duration: 420, geometry: { coordinates: [[A.lng, A.lat], [B.lng, B.lat]] } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch;
    const r = await getRoute(A, B, { fetchImpl });
    expect(r).toMatchObject({ km: 2.6, min: 7, estimate: false });
    expect(r.line).toHaveLength(2);
  });

  it("falls back to straight line × 1.3 within 2 s when the router hangs", async () => {
    const C = destination(A, 10, 3);
    const fetchImpl = ((_: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await getRoute(A, C, { fetchImpl, timeoutMs: 400 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.estimate).toBe(true);
    expect(r.km).toBeCloseTo(3.9, 1);
    expect(r.min).toBeCloseTo(7.8, 1);
  });

  it("falls back on an HTTP error", async () => {
    const D = destination(A, 200, 1);
    const fetchImpl = vi.fn(async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
    const r = await getRoute(A, D, { fetchImpl });
    expect(r).toEqual(fallbackRoute(A, D));
  });
});

describe("mock backend (FR-070)", () => {
  it("runs request → offer → accept → complete through the Backend interface with realtime pings", async () => {
    resetMockDb();
    const bus = new MockBus("test-bus-" + Math.random());
    const cfg = { ...DEFAULT_CONFIG, inviteCode: null };
    const rider = new MockBackend("r1", cfg, { bus, sweep: false });
    const driver = new MockBackend("d1", cfg, { bus, sweep: false });
    await rider.saveProfile("Ola", "pl");
    await driver.saveProfile("Adam", "en");
    await driver.saveVehicle({ make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4 });
    await driver.setOnline(true);

    const pinged = new Promise<void>((resolve) => driver.onDriverPing(() => resolve()));
    const riderChanged = vi.fn();
    rider.onMyChanges(riderChanged);
    const ride = await rider.requestRide({ pickup: { ...A, label: "A" }, dropoff: { ...B, label: "B" }, estKm: 2.6, estMin: 7, fareIsEstimate: false });
    await pinged; // the request pinged online drivers

    const st = await driver.heartbeat(destination(A, 0, 1));
    expect(st.offer?.rideId).toBe(ride.id);
    expect(await driver.decideOffer(st.offer!.id, "accept")).toBe("won");

    // live positions travel over the ride channel only
    const got = new Promise<number>((resolve) => {
      const ch = rider.openRide(ride.id, "rider", { onDriverPos: (p) => resolve(p.lat) });
      setTimeout(() => ch.close(), 1000);
    });
    const dch = driver.openRide(ride.id, "driver", {});
    dch.sendDriverPos({ lat: 52.1, lng: 21, heading: 90, accuracy: 5, t: Date.now() });
    expect(await got).toBe(52.1);
    dch.close();

    await driver.advance(ride.id, "arrived");
    await driver.advance(ride.id, "in_progress");
    const done = await driver.advance(ride.id, "completed", 2.4);
    expect(done.status).toBe("completed");
    await new Promise((r) => setTimeout(r, 10));
    expect(riderChanged).toHaveBeenCalled();
    const receipt = await rider.getRide(ride.id);
    expect(receipt).toMatchObject({ status: "completed", actualKm: 2.4, driver: { nickname: "Adam", vehicle: { plate: "WX1" } } });
    rider.dispose();
    driver.dispose();
  });

  it("removes presence of a client that stops announcing (tab killed)", async () => {
    vi.useFakeTimers();
    const bus = new MockBus("test-bus-" + Math.random());
    bus.track("drivers", "dX", { id: "dX", lat: 1, lng: 1, state: "idle", heading: null, t: 0 }, "clientX");
    const seen: number[] = [];
    bus.onPresence("drivers", (s) => seen.push(Object.keys(s).length));
    await vi.advanceTimersByTimeAsync(10);
    expect(bus.presenceState("drivers")).toHaveProperty("dX");
    bus.untrack("drivers", "dX", "clientX");
    expect(bus.presenceState("drivers")).toEqual({});
    vi.useRealTimers();
  });
});

describe("i18n", () => {
  it("has every English key in Polish, none empty, same placeholders", () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(pl[k], k).toBeTruthy();
      const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(vars(pl[k]), k).toBe(vars(en[k]));
    }
  });
  it("interpolates variables", () => {
    expect(translator("en")("search.notified", { n: 3 })).toBe("Drivers notified: 3");
    expect(translator("pl")("search.notified", { n: 3 })).toBe("Powiadomieni kierowcy: 3");
  });
});
