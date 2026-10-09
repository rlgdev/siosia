// @vitest-environment node
// OPT-IN live test of the real SupabaseBackend adapter against a deployed project (spec §11
// "Backend rules … on demand"). Skipped unless these are set:
//   SIOSIA_LIVE_URL, SIOSIA_LIVE_KEY (publishable), SIOSIA_LIVE_INVITE
// It creates two throwaway anonymous users and runs the loop through the same class the app uses:
// presence, pings, offers, atomic accept, user-topic events, the ride channel with peer presence.

import { describe, expect, it } from "vitest";
import { SupabaseBackend } from "../../src/backend/supabase/index";
import type { DriverPos, DriverPresence } from "../../src/core/types";

const URL = process.env.SIOSIA_LIVE_URL ?? "";
const KEY = process.env.SIOSIA_LIVE_KEY ?? "";
const INVITE = process.env.SIOSIA_LIVE_INVITE ?? "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 10_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return Date.now() - t0;
    await sleep(50);
  }
  throw new Error(`timed out after ${ms} ms`);
}

const PICKUP = { lat: 51.5072, lng: -0.1276, label: "Live pickup" };
const DROPOFF = { lat: 51.5155, lng: -0.0922, label: "Live dropoff" };

describe.skipIf(!URL || !KEY || !INVITE)("SupabaseBackend against the live project", () => {
  it("runs the ride loop through the adapter with realtime", async () => {
    const rider = new SupabaseBackend(URL, KEY);
    const driver = new SupabaseBackend(URL, KEY);
    await rider.ping();
    const riderId = await rider.start();
    const driverId = await driver.start();
    expect(riderId).not.toBe(driverId);

    expect(await rider.isMember("live-rider")).toBe(false);
    await rider.join(INVITE, "live-rider");
    await driver.join(INVITE, "live-driver");
    expect(await rider.isMember("live-rider")).toBe(true);
    const cfg = await rider.getConfig();
    expect(cfg.timers.offerS).toBe(20);
    await rider.saveProfile("Live Rider", "en");
    await driver.saveProfile("Live Driver", "pl");
    await driver.saveVehicle({ make: "Live", model: "Car", colour: "Blue", plate: "LIVE01", seats: 4 });

    // Rider watches nearby cars; driver goes online and tracks presence (re-join after online).
    const seen: DriverPresence[][] = [];
    const unwatch = rider.watchDrivers((l) => seen.push(l));
    await driver.setOnline(true);
    const pings: number[] = [];
    const unping = driver.onDriverPing(() => pings.push(Date.now()));
    const presence = driver.driverPresence();
    presence.track({ id: driverId, lat: 51.509, lng: -0.13, state: "idle", heading: 90, t: Date.now() });
    const presenceMs = await waitFor(() => seen.some((l) => l.some((d) => d.id === driverId)), 15_000);

    const riderEvents: number[] = [];
    const driverEvents: number[] = [];
    const offR = rider.onMyChanges(() => riderEvents.push(Date.now()));
    const offD = driver.onMyChanges(() => driverEvents.push(Date.now()));
    await sleep(2000); // let the user topics join

    const ride = await rider.requestRide({ pickup: PICKUP, dropoff: DROPOFF, estKm: 3.1, estMin: 11, fareIsEstimate: false });
    expect(ride).toMatchObject({ status: "requested", driver: null, role: "rider" });
    const pingMs = await waitFor(() => pings.length > 0);

    const st = await driver.heartbeat({ lat: 51.509, lng: -0.13 });
    expect(st.offer?.rideId).toBe(ride.id);
    expect(JSON.stringify(st.offer)).not.toContain("LIVE01");
    const before = riderEvents.length;
    expect(await driver.decideOffer(st.offer!.id, "accept")).toBe("won");
    const eventMs = await waitFor(() => riderEvents.length > before);
    const mine = await rider.myState();
    expect(mine.ride).toMatchObject({ id: ride.id, status: "accepted", driver: { nickname: "Live Driver", vehicle: { plate: "LIVE01" } } });

    // Ride channel: peer presence both ways, driver position to rider.
    const positions: DriverPos[] = [];
    let riderSawDriver = false;
    let driverSawRider = false;
    const rch = rider.openRide(ride.id, "rider", { onDriverPos: (p) => positions.push(p), onPeer: (p) => (riderSawDriver ||= p) });
    const dch = driver.openRide(ride.id, "driver", { onPeer: (p) => (driverSawRider ||= p) });
    await waitFor(() => riderSawDriver && driverSawRider, 15_000);
    dch.sendDriverPos({ lat: 51.508, lng: -0.129, heading: 45, accuracy: 6, t: Date.now() });
    const posMs = await waitFor(() => positions.length > 0);
    expect(positions[0]).toMatchObject({ lat: 51.508, heading: 45 });

    await driver.advance(ride.id, "arrived");
    await driver.advance(ride.id, "in_progress");
    const done = await driver.advance(ride.id, "completed", 3.3);
    expect(done).toMatchObject({ status: "completed", actualKm: 3.3, fare: ride.fare });
    await rider.markPaid(ride.id);
    await rider.rate(ride.id, 5, "live test");
    await driver.markCollected(ride.id);
    await driver.rate(ride.id, 5, "");
    expect((await rider.history())[0]).toMatchObject({ id: ride.id, paid: true, myRating: 5 });
    expect((await driver.earnings()).todayCount).toBeGreaterThanOrEqual(1);

    rch.close();
    dch.close();
    presence.close();
    unping();
    unwatch();
    offR();
    offD();
    await driver.setOnline(false);
    console.log(`live: presence ${presenceMs} ms · ping ${pingMs} ms · accept event ${eventMs} ms · position ${posMs} ms · driver events ${driverEvents.length}`);
  }, 90_000);
});
