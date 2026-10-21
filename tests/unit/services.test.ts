// Routing fallback (FR-031/032), the mock backend through the Backend interface with its realtime
// bus (FR-070), presence expiry of a killed tab (FR-042), and i18n completeness (FR-073, NFR-11).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { destination } from "../../src/core/geo";
import { MockBackend } from "../../src/backend/mock/index";
import { MockBus } from "../../src/backend/mock/bus";
import { RobotSiosia } from "../../src/backend/mock/siosiaRobot";
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

  it("runs a 2.0 request → accept round trip through the Backend interface, with notifications", async () => {
    resetMockDb();
    const bus = new MockBus("test-bus-" + Math.random());
    const cfg = { ...DEFAULT_CONFIG, inviteCode: null };
    const client = new MockBackend("c1", cfg, { bus, sweep: false });
    const siosia = new MockBackend("s1", cfg, { bus, sweep: false });
    await client.saveProfile("Toria", "en");
    await siosia.saveProfile("Siosia", "pl");
    await siosia.setOffers(["childcare"]);
    expect((await client.getConfig()).services.map((e) => e.id)).toEqual(["ride", "learning", "childcare"]);
    const entry = (await client.catalog()).find((e) => e.id === "childcare")!;
    expect(entry.providers.map((p) => p.nickname)).toEqual(["Siosia"]);
    const heard = new Promise<{ kind: string; appointmentId?: string | null; params: { service?: string } }>((resolve) => siosia.onPush((m) => resolve(m)));
    const a = await client.requestService({
      serviceId: "childcare",
      providerId: entry.providers[0].publicId!,
      startsAt: Date.now() + 26 * 3600_000,
      durationMin: 180,
      place: { ...A, label: "Dom" },
      note: ""
    });
    const push = await heard;
    expect(push).toMatchObject({ kind: "appt_new", appointmentId: a.id, params: { service: "Opieka nad dziećmi" } }); // her language
    const changed = vi.fn();
    client.onMyChanges(changed);
    expect(await siosia.answerAppointment(a.id, "accept")).toMatchObject({ status: "accepted", role: "provider" });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect((await client.planned()).appointments).toEqual([expect.objectContaining({ id: a.id, status: "accepted" })]);
    expect(await client.myState()).toMatchObject({ planned: 1, nextPlanned: { kind: "appointment", title: "Childcare" } });
    client.dispose();
    siosia.dispose();
  });

  it("runs a 2.1 open request → taken by another member round trip, with notifications to everyone", async () => {
    resetMockDb();
    const bus = new MockBus("test-bus-" + Math.random());
    const cfg = { ...DEFAULT_CONFIG, inviteCode: null };
    const client = new MockBackend("c1", cfg, { bus, sweep: false });
    const ewa = new MockBackend("e1", cfg, { bus, sweep: false });
    const adam = new MockBackend("a1", cfg, { bus, sweep: false });
    await client.saveProfile("Toria", "en");
    await ewa.saveProfile("Ewa", "pl");
    await adam.saveProfile("Adam", "en");
    // Nobody offers childcare: the request goes to anyone in the group.
    expect((await client.catalog()).find((e) => e.id === "childcare")!.providers).toEqual([]);
    const heard = (api: MockBackend) =>
      new Promise<{ kind: string; appointmentId?: string | null; params: { service?: string; open?: boolean } }>((resolve) => api.onPush((m) => resolve(m)));
    const toEwa = heard(ewa);
    const toAdam = heard(adam);
    const adamChanged = vi.fn();
    adam.onMyChanges(adamChanged);
    const a = await client.requestService({ serviceId: "childcare", providerId: null, startsAt: Date.now() + 26 * 3600_000, durationMin: 180, place: { ...A, label: "Dom" }, note: "" });
    expect(a).toMatchObject({ role: "client", open: true, provider: null });
    expect(await toEwa).toMatchObject({ kind: "appt_open", appointmentId: a.id, params: { service: "Opieka nad dziećmi", open: true } }); // her language
    expect(await toAdam).toMatchObject({ kind: "appt_open", appointmentId: a.id, params: { service: "Childcare" } });
    await vi.waitFor(() => expect(adamChanged).toHaveBeenCalled()); // his list and badge update
    expect(await adam.myState()).toMatchObject({ openRequests: 1, planned: 0 });
    expect((await ewa.planned()).open).toEqual([expect.objectContaining({ id: a.id, role: "candidate", provider: null })]);

    const clientChanged = vi.fn();
    client.onMyChanges(clientChanged);
    const told = heard(client);
    adamChanged.mockClear();
    expect(await ewa.takeRequest(a.id)).toMatchObject({ status: "accepted", role: "provider", provider: { nickname: "Ewa" } });
    expect(await told).toMatchObject({ kind: "appt_accepted", appointmentId: a.id });
    await vi.waitFor(() => expect(clientChanged).toHaveBeenCalled());
    await vi.waitFor(() => expect(adamChanged).toHaveBeenCalled()); // gone from his list
    await expect(adam.takeRequest(a.id)).rejects.toMatchObject({ code: "taken" });
    expect(await adam.myState()).toMatchObject({ openRequests: 0 });
    expect((await client.planned()).appointments).toEqual([expect.objectContaining({ id: a.id, status: "accepted", open: false, provider: expect.objectContaining({ nickname: "Ewa" }) })]);
    // 2.1: the car colour through the same interface.
    await adam.saveVehicle({ make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4 });
    expect(await adam.setCarColour("Czerwony", "#C0392B")).toMatchObject({ colour: "Czerwony", paint: "#c0392b" });
    await expect(client.setCarColour("Red", "#c0392b")).rejects.toMatchObject({ code: "no_vehicle" });
    client.dispose();
    ewa.dispose();
    adam.dispose();
  });

  it("demo: the robot Siosia takes an open request for her services after 15 s, so a human can be first (2.1)", async () => {
    resetMockDb();
    resetRoutingState();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline"); // the straight-line route fallback
      })
    );
    try {
      const music = { ...DEFAULT_SERVICES[1], id: "music", name: { en: "Music", pl: "Muzyka" } };
      const cfg = { ...DEFAULT_CONFIG, services: [...DEFAULT_SERVICES, music], inviteCode: null };
      const robot = new RobotSiosia(cfg, { ...destination(A, 210, 1.2), label: "Siosia" });
      await robot.init();
      const client = new MockBackend("c1", cfg, { sweep: false });
      await client.saveProfile("Toria", "en");
      const q = (ms: number) => Math.ceil(ms / 900_000) * 900_000;
      const ask = (serviceId: string, startsAt: number) =>
        client.requestService({ serviceId, providerId: null, startsAt, durationMin: 120, place: { ...A, label: "Dom" }, note: "" });
      const a = await ask("childcare", q(Date.now() + 3 * 3600_000));
      const lesson = await ask("music", q(Date.now() + 5 * 3600_000)); // not one of hers
      const t0 = Date.now();
      await robot.tick(t0);
      await robot.tick(t0 + 2000); // a request addressed to her would be answered by now…
      expect((await client.getAppointment(a.id)).status).toBe("requested");
      await robot.tick(t0 + 10_000);
      expect((await client.getAppointment(a.id)).open).toBe(true); // …an open one waits for a human
      await robot.tick(t0 + 15_000);
      const taken = await client.getAppointment(a.id);
      expect(taken).toMatchObject({ status: "accepted", open: false, provider: expect.objectContaining({ nickname: "Siosia" }) });
      expect(taken.rides).toEqual([expect.objectContaining({ leg: "there", passenger: "provider", mine: false, status: "pending" })]);
      await robot.tick(t0 + 60_000);
      expect(await client.getAppointment(lesson.id)).toMatchObject({ status: "requested", open: true, provider: null });

      // Taken by a human first: she leaves it be.
      const ewa = new MockBackend("e1", cfg, { sweep: false });
      await ewa.saveProfile("Ewa", "en");
      const b = await ask("learning", q(Date.now() + 7 * 3600_000));
      const t1 = Date.now();
      await robot.tick(t1);
      await ewa.takeRequest(b.id);
      await robot.tick(t1 + 20_000);
      expect(await client.getAppointment(b.id)).toMatchObject({ status: "accepted", provider: expect.objectContaining({ nickname: "Ewa" }) });
      robot.stop();
      client.dispose();
      ewa.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("demo: the robot Siosia offers learning and childcare, accepts within 5 s and books a ride there (FR-151)", async () => {
    resetMockDb();
    resetRoutingState();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline"); // the straight-line route fallback
      })
    );
    try {
      const cfg = { ...DEFAULT_CONFIG, inviteCode: null };
      const robot = new RobotSiosia(cfg, { ...destination(A, 210, 1.2), label: "Siosia" });
      await robot.init();
      const client = new MockBackend("c1", cfg, { sweep: false });
      await client.saveProfile("Toria", "en");
      const cat = await client.catalog();
      expect(cat.find((e) => e.id === "learning")!.providers.map((p) => p.nickname)).toEqual(["Siosia"]);
      const providerId = cat.find((e) => e.id === "childcare")!.providers[0].publicId!;
      const q = (ms: number) => Math.ceil(ms / 900_000) * 900_000;
      const ask = (startsAt: number, repeat?: { every: 1; count: number }) =>
        client.requestService({ serviceId: "childcare", providerId, startsAt, durationMin: 120, place: { ...A, label: "Dom" }, note: "", repeat });

      const a = await ask(q(Date.now() + 3 * 3600_000));
      const t0 = Date.now();
      await robot.tick(t0); // she reads it first
      expect((await client.getAppointment(a.id)).status).toBe("requested");
      await robot.tick(t0 + 2000);
      const accepted = await client.getAppointment(a.id);
      expect(accepted.status).toBe("accepted");
      expect(accepted.rides).toEqual([expect.objectContaining({ leg: "there", passenger: "provider", mine: false, status: "pending" })]);
      expect(accepted.rides[0].scheduledFor!).toBeLessThan(accepted.startsAt);

      // Under an hour ahead: accepted, no ride.
      const soon = await ask(q(Date.now() + 35 * 60_000)); // 35–50 min ahead
      await robot.tick(Date.now());
      await robot.tick(Date.now() + 2000);
      const s = await client.getAppointment(soon.id);
      expect(s.status).toBe("accepted");
      expect(s.rides).toEqual([]);

      // A weekly series: one ride template for every date.
      const first = await ask(q(Date.now() + 2 * 86_400_000), { every: 1, count: 3 });
      await robot.tick(Date.now());
      await robot.tick(Date.now() + 2000);
      const series = await client.getAppointment(first.id);
      expect(series.status).toBe("accepted");
      expect(series.series!.rideTemplates).toEqual([expect.objectContaining({ leg: "there", passenger: "provider", mine: false })]);
      robot.stop();
      client.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
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
  it("has a message for every key the app uses, every server error code and every status word (FR-152)", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(f) && !path.includes(join("src", "i18n"))) files.push(path);
      }
    };
    walk("src");
    const namespaces = new Set(Object.keys(en).map((k) => k.split(".")[0]));
    const missing: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf-8").matchAll(/["'`]([a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9.]*)["'`]/g)) {
        const key = m[1];
        if (namespaces.has(key.split(".")[0]) && !(key in en)) missing.push(`${f}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
    const types = readFileSync("src/core/types.ts", "utf-8");
    const codes = [...types.slice(types.indexOf("export type ServerErrorCode")).split(";")[0].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(40);
    for (const c of codes) expect(en, `err.${c}`).toHaveProperty([`err.${c}`]);
    for (const st of ["requested", "accepted", "declined", "cancelled", "expired", "done"]) expect(en).toHaveProperty([`appt.status.${st}`]);
    for (const leg of ["there", "back"]) expect(en).toHaveProperty([`appt.leg.${leg}`]);
    for (const by of ["client", "provider", "system"]) expect(en).toHaveProperty([`appt.cancelledBy.${by}`]);
    for (const st of ["scheduled", "requested", "accepted", "arrived", "in_progress", "completed", "cancelled", "expired"]) expect(en).toHaveProperty([`status.${st}`]);
  });
  it("interpolates variables", () => {
    expect(translator("en")("search.notified", { n: 3 })).toBe("Drivers notified: 3");
    expect(translator("pl")("search.notified", { n: 3 })).toBe("Powiadomieni kierowcy: 3");
  });
});

describe("config.example.json (FR-150)", () => {
  it("carries the 2.0 deployment settings exactly as the defaults: catalog, bookings, appointments", async () => {
    const { readFileSync } = await import("node:fs");
    const { buildConfig } = await import("../../src/config");
    const { DEFAULT_SERVICES } = await import("../../src/core/defaults");
    const file = JSON.parse(readFileSync("config.example.json", "utf-8"));
    const cfg = buildConfig(file, "");
    expect(cfg.deployment.services).toEqual(DEFAULT_SERVICES);
    expect(cfg.deployment.booking).toEqual(DEFAULT_CONFIG.booking);
    expect(cfg.deployment.appointment).toEqual(DEFAULT_CONFIG.appointment);
    expect(cfg.deployment.calendarUrl).toBeNull();
  });
});

describe("in-app guide (FR-153)", () => {
  it("describes 2.0 in English and Polish with the app's own words", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync("public/guide.html", "utf-8");
    const [enPart, plPart] = html.split('<section data-lang="pl">');
    for (const k of ["start.planned", "start.history", "catalog.addCar", "catalog.goOnline", "request.send", "profile.offersTitle", "appt.needThere"] as const) {
      expect(enPart, k).toContain(en[k]);
      expect(plPart, k).toContain(pl[k]);
    }
    for (const word of ["Learning", "Childcare", "a day</strong> and <strong>two hours", "This one", "All remaining"]) expect(enPart).toContain(word);
    for (const word of ["Nauka", "Opieka nad dziećmi", "dzień</strong> i <strong>dwie godziny", "Tylko ten", "Wszystkie pozostałe"]) expect(plPart).toContain(word);
  });
});
