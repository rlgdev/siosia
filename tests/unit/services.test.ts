// Routing fallback (FR-031/032), the mock backend through the Backend interface with its realtime
// bus (FR-070), presence expiry of a killed tab (FR-042), and i18n completeness (FR-073, NFR-11).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import { destination } from "../../src/core/geo";
import { MockBackend } from "../../src/backend/mock/index";
import { MockBus } from "../../src/backend/mock/bus";
import { resetMockDb } from "../../src/backend/mock/store";
import { en } from "../../src/i18n/en";
import { pl } from "../../src/i18n/pl";
import { translator } from "../../src/i18n";
import { fallbackRoute, getRoute, resetRoutingState } from "../../src/services/routing";

const A = { lat: 52.2297, lng: 21.0122 };
const B = destination(A, 45, 2);

describe("routing", () => {
  beforeEach(() => resetRoutingState());

  it("parses an OSRM route", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: "Ok", routes: [{ distance: 2600, duration: 420, geometry: { coordinates: [[A.lng, A.lat], [B.lng, B.lat]] } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch;
    const r = await getRoute(A, B, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ km: 2.6, min: 7, estimate: false });
    expect(r.line).toHaveLength(2);
  });

  it("aborts a hanging router and falls back to straight line × 1.3 within the 2 s budget", async () => {
    const C = destination(A, 10, 3);
    let aborted = false;
    const fetchImpl = vi.fn(
      (_: string, init?: RequestInit) =>
        new Promise((_r, reject) =>
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          })
        )
    ) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await getRoute(A, C, { fetchImpl, timeoutMs: 400 });
    const took = Date.now() - t0;
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the request really went out…
    expect(aborted).toBe(true); // …and was cut off by our own deadline
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1500);
    expect(r.estimate).toBe(true);
    expect(r.km).toBeCloseTo(3.9, 1);
    expect(r.min).toBeCloseTo(7.8, 1);
  });

  it("falls back on an HTTP error", async () => {
    const D = destination(A, 200, 1);
    const fetchImpl = vi.fn(async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
    const r = await getRoute(A, D, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    const ride = await rider.requestRide({ pickup: { ...A, label: "A" }, dropoff: { ...B, label: "B" }, estKm: 2.6, estMin: 7, fareIsEstimate: false });
    await pinged; // the request pinged online drivers

    const st = await driver.heartbeat(destination(A, 0, 1));
    expect(st.offer?.rideId).toBe(ride.id);
    const riderChanged = vi.fn();
    rider.onMyChanges(riderChanged);
    expect(await driver.decideOffer(st.offer!.id, "accept")).toBe("won");
    await vi.waitFor(() => expect(riderChanged).toHaveBeenCalled()); // acceptance reached the rider

    // Live positions travel over the per-assignment ride channel only.
    const assignment = { id: ride.id, round: (await rider.getRide(ride.id)).round };
    const got = new Promise<number>((resolve) => {
      const ch = rider.openRide(assignment, "rider", { onDriverPos: (p) => resolve(p.lat) });
      setTimeout(() => ch.close(), 1000);
    });
    const stale = vi.fn();
    const old = rider.openRide({ id: ride.id, round: assignment.round + 1 }, "rider", { onDriverPos: stale });
    const dch = driver.openRide(assignment, "driver", {});
    dch.sendDriverPos({ lat: 52.1, lng: 21, heading: 90, accuracy: 5, t: Date.now() });
    expect(await got).toBe(52.1);
    expect(stale).not.toHaveBeenCalled(); // another round's channel hears nothing
    dch.close();
    old.close();

    await driver.advance(ride.id, "arrived");
    await driver.advance(ride.id, "in_progress");
    const done = await driver.advance(ride.id, "completed", 2.4);
    expect(done.status).toBe("completed");
    const receipt = await rider.getRide(ride.id);
    expect(receipt).toMatchObject({ status: "completed", actualKm: 2.4, driver: { nickname: "Adam", vehicle: { plate: "WX1" } } });
    rider.dispose();
    driver.dispose();
  });

  it("publishes driver presence under a random key, never the user id", () => {
    const bus = new MockBus("test-bus-" + Math.random());
    const driver = new MockBackend("driver-uid", { ...DEFAULT_CONFIG, inviteCode: null }, { bus, sweep: false });
    const h1 = driver.driverPresence();
    h1.track({ lat: 1, lng: 1, state: "idle", heading: null, t: 0 });
    const [key1] = Object.keys(bus.presenceState("drivers"));
    expect(key1).not.toBe("driver-uid");
    expect((bus.presenceState("drivers")[key1] as { id: string }).id).toBe(key1);
    h1.close();
    const h2 = driver.driverPresence();
    h2.track({ lat: 1, lng: 1, state: "idle", heading: null, t: 0 });
    const [key2] = Object.keys(bus.presenceState("drivers"));
    expect(key2).not.toBe(key1); // a new idle period cannot be linked to the previous one
    h2.close();
    driver.dispose();
  });
});

describe("presence expiry across tabs (FR-042)", () => {
  afterEach(() => vi.useRealTimers());

  it("drops a tab's presence within the TTL when the tab dies without saying goodbye", async () => {
    vi.useFakeTimers();
    const name = "test-ttl-" + Math.random();
    const dying = new MockBus(name);
    const watcher = new MockBus(name);
    const seen: number[] = [];
    watcher.onPresence("drivers", (s) => seen.push(Object.keys(s).length));
    dying.track("drivers", "k1", { id: "k1", lat: 1, lng: 1, state: "idle", heading: null, t: 0 }, "client-a");
    await vi.waitFor(() => expect(watcher.presenceState("drivers")).toHaveProperty("k1"));
    // The tab is killed: no untrack and no more announcements (its timer is gone with it).
    (dying as unknown as { localTracks: Map<string, unknown> }).localTracks.clear();
    await vi.advanceTimersByTimeAsync(9000);
    expect(watcher.presenceState("drivers")).toEqual({});
    expect(seen.at(-1)).toBe(0);
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
