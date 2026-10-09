// Robot drivers for demo mode (FR-070). Each robot is a separate mock user that uses the very same
// Backend interface as a human driver: goes online, answers pings with heartbeats, accepts offers
// (two robots racing exercises the atomic claim), drives the route, advances the statuses, rates.

import { CADENCE } from "../../core/defaults";
import type { EngineConfig } from "../../core/engine";
import { bearingDeg, coarse, destination, haversineM } from "../../core/geo";
import { PositionThrottle } from "../../core/throttle";
import { ServerError, type LatLng, type MyState, type RideView } from "../../core/types";
import { getRoute } from "../../services/routing";
import type { DriverPresenceHandle, RideChannel } from "../types";
import { MockBackend } from "./index";

const NAMES = ["Robo Ania", "Robo Bartek", "Robo Celina", "Robo Darek"];
const CARS = [
  { make: "Toyota", model: "Corolla", colour: "White", plate: "RB 1001", seats: 4 },
  { make: "Skoda", model: "Octavia", colour: "Grey", plate: "RB 2002", seats: 4 },
  { make: "Kia", model: "Ceed", colour: "Blue", plate: "RB 3003", seats: 4 },
  { make: "Dacia", model: "Logan", colour: "Red", plate: "RB 4004", seats: 4 }
];

const TICK_MS = 1000;
/** Idle robots drift back when they wander further than this from the demo centre. */
const HOME_RADIUS_M = 1500;

class Robot {
  readonly api: MockBackend;
  pos: LatLng;
  heading = 0;
  private route: LatLng[] = [];
  /** Key (ride:round:status) the current route was computed for; "" = none yet. */
  private routeFor = "";
  /** Bumped on teleport so a route computed from the old position is discarded. */
  private routeGen = 0;
  private my: MyState | null = null;
  private channel: { key: string; ch: RideChannel } | null = null;
  private presence: DriverPresenceHandle | null = null;
  private presThrottle = new PositionThrottle(CADENCE.presenceMs, CADENCE.presenceM);
  private posThrottle = new PositionThrottle(CADENCE.livePosMs, CADENCE.livePosM);
  private lastBeat = 0;
  private lastRepair = 0;
  private deciding: string | null = null;
  private waitUntil = 0;
  private tripKm = 0;
  private finishing = false;
  private readonly unsubPing: () => void;
  private busy = false;

  constructor(
    readonly index: number,
    private readonly cfg: EngineConfig,
    start: LatLng,
    private readonly speedMs: number
  ) {
    this.api = new MockBackend(`robot-${index + 1}`, cfg, { sweep: false });
    this.pos = start;
    this.unsubPing = this.api.onDriverPing(() => void this.beat(true));
  }

  /** Join, profile, vehicle, online — also used to recover after a demo reset or a lost session. */
  async init(): Promise<void> {
    if (this.cfg.inviteCode) await this.api.join(this.cfg.inviteCode, `robot-device-${this.index}`).catch(() => {});
    await this.api.saveProfile(NAMES[this.index % NAMES.length], "en").catch(() => {});
    await this.api.saveVehicle(CARS[this.index % CARS.length]).catch(() => {});
    await this.api.setOnline(true).catch(() => {});
    await this.beat(true);
  }

  async stop(): Promise<void> {
    this.unsubPing();
    this.closeChannel();
    this.presence?.close();
    this.presence = null;
    await this.api.setOnline(false).catch(() => {});
    this.api.dispose();
  }

  /** Moves an idle robot near a new demo centre. A robot on a trip is never teleported. */
  teleport(p: LatLng): void {
    if (this.my?.ride) return;
    this.pos = p;
    this.route = [];
    this.routeFor = "";
    this.routeGen++;
    this.presThrottle.reset();
  }

  private async beat(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastBeat < CADENCE.heartbeatMs) return;
    this.lastBeat = now;
    const idle = !this.my?.ride;
    try {
      this.my = await this.api.heartbeat(idle ? coarse(this.pos) : null);
      // The server set us offline (e.g. the demo tab slept for a minute): come back online.
      if (!this.my.driverOnline && !this.my.ride) await this.repair(false);
    } catch (e) {
      // Profile or membership wiped (demo reset in another tab): set ourselves up again.
      if (e instanceof ServerError && (e.code === "no_profile" || e.code === "not_member")) await this.repair(true);
    }
  }

  private async repair(full: boolean): Promise<void> {
    if (Date.now() - this.lastRepair < 10_000) return;
    this.lastRepair = Date.now();
    if (full) await this.init();
    else await this.api.setOnline(true).catch(() => {});
  }

  async tick(center: LatLng): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.beat();
      const ride = this.my?.ride && this.my.ride.role === "driver" ? this.my.ride : null;
      if (!ride) {
        this.closeChannel();
        this.finishing = false;
        await this.handleOffer();
        this.cruise(center);
        if (!this.my?.driverOnline) {
          this.presence?.close();
          this.presence = null;
          return;
        }
        // A new presence identity per idle period, like a human driver's client.
        if (!this.presence) {
          this.presence = this.api.driverPresence();
          this.presThrottle.reset();
        }
        if (this.presThrottle.offer(this.pos, Date.now()))
          this.presence.track({ ...coarse(this.pos), state: "idle", heading: Math.round(this.heading), t: Date.now() });
        return;
      }
      this.presence?.close();
      this.presence = null;
      await this.drive(ride);
    } finally {
      this.busy = false;
    }
  }

  private async handleOffer(): Promise<void> {
    const offer = this.my?.offer;
    if (!offer) {
      this.deciding = null;
      return;
    }
    const key = `${offer.id}:${offer.offeredAt}`; // a re-activated card is a new decision
    if (this.deciding === key) return;
    this.deciding = key;
    const delay = 1500 + Math.random() * 2500;
    setTimeout(async () => {
      try {
        await this.api.decideOffer(offer.id, "accept");
      } catch {
        /* taken by another driver */
      }
      await this.beat(true);
    }, delay);
  }

  /** Slow random walk while idle, steering back home when it wandered off. */
  private cruise(center: LatLng): void {
    const away = haversineM(this.pos, center) > HOME_RADIUS_M;
    if (away) this.heading = bearingDeg(this.pos, center);
    else if (Math.random() < 0.1) this.heading = (this.heading + (Math.random() - 0.5) * 90 + 360) % 360;
    this.pos = destination(this.pos, this.heading, away ? 0.02 : 0.006);
  }

  private async drive(ride: RideView): Promise<void> {
    const channelKey = `${ride.id}:${ride.round}`;
    if (!this.channel || this.channel.key !== channelKey) {
      this.closeChannel();
      this.channel = { key: channelKey, ch: this.api.openRide({ id: ride.id, round: ride.round }, "driver", {}) };
      this.posThrottle.reset();
      this.tripKm = 0;
    }
    const now = Date.now();
    if (now < this.waitUntil) return this.sendPos();
    const target = ride.status === "in_progress" ? ride.dropoff : ride.pickup;
    const key = `${channelKey}:${ride.status}`;
    if (this.routeFor !== key) {
      const gen = this.routeGen;
      const r = await getRoute(this.pos, target, { timeoutMs: 2000 });
      if (gen !== this.routeGen) return; // teleported meanwhile: recompute next tick
      this.route = [...r.line.slice(1)];
      this.routeFor = key;
    }
    if (ride.status === "arrived") {
      await this.api.advance(ride.id, "in_progress").catch(() => {});
      this.waitUntil = now + 1500;
      await this.beat(true);
      return;
    }
    // Move along the route.
    let budget = (this.speedMs * TICK_MS) / 1000;
    while (budget > 0 && this.route.length) {
      const next = this.route[0];
      const d = haversineM(this.pos, next);
      if (d < 0.5) {
        this.route.shift();
        continue;
      }
      this.heading = bearingDeg(this.pos, next);
      const step = Math.min(d, budget);
      const moved = destination(this.pos, this.heading, step / 1000);
      if (ride.status === "in_progress") this.tripKm += step / 1000;
      this.pos = moved;
      budget -= step;
      if (step >= d) this.route.shift();
    }
    this.sendPos();
    // Arrive only at the target: a route that ends short of it (road snapping) is finished in a
    // straight line rather than counted as arrival.
    if (haversineM(this.pos, target) < 60 && (!this.route.length || haversineM(this.pos, target) < 15)) {
      if (ride.status === "accepted") {
        await this.api.advance(ride.id, "arrived").catch(() => {});
        this.waitUntil = Date.now() + 4000;
      } else if (ride.status === "in_progress" && !this.finishing) {
        this.finishing = true;
        await this.api.advance(ride.id, "completed", this.tripKm).catch(() => {});
        await this.api.markCollected(ride.id).catch(() => {});
        await this.api.rate(ride.id, 5, "").catch(() => {});
      }
      await this.beat(true);
    } else if (!this.route.length) {
      this.route = [target];
    }
  }

  private sendPos(): void {
    if (!this.channel) return;
    if (this.posThrottle.offer(this.pos, Date.now()))
      this.channel.ch.sendDriverPos({ lat: this.pos.lat, lng: this.pos.lng, heading: Math.round(this.heading), accuracy: 5, t: Date.now() });
  }

  private closeChannel(): void {
    if (!this.channel) return;
    this.channel.ch.sendSharingStop({ from: "driver" });
    this.channel.ch.close();
    this.channel = null;
    this.routeFor = "";
  }
}

export class RobotFleet {
  private robots: Robot[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private center: LatLng;
  private releaseLock: (() => void) | null = null;
  private readonly abort = typeof AbortController !== "undefined" ? new AbortController() : null;
  private stopped = false;
  running = false;

  constructor(
    private readonly cfg: EngineConfig,
    center: LatLng,
    private readonly count = 2,
    private readonly speedMs = 25
  ) {
    this.center = center;
  }

  /**
   * Runs the fleet in exactly one tab of this browser. If another tab runs it, this one waits for
   * the lock and takes over when that tab closes (so robots never vanish mid-trip for good).
   */
  start(): void {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) {
      void this.run();
      return;
    }
    void locks
      .request("siosia-robots", { signal: this.abort?.signal }, async () => {
        if (this.stopped) return;
        const held = new Promise<void>((release) => (this.releaseLock = release));
        await this.run();
        if (this.stopped) return; // stopped while starting: let the lock go
        await held;
      })
      .catch(() => {
        /* aborted by stop() */
      });
  }

  private async run(): Promise<void> {
    this.running = true;
    for (let i = 0; i < this.count && !this.stopped; i++) {
      const start = destination(this.center, (360 / this.count) * i + 30, 0.4 + Math.random() * 0.6);
      const r = new Robot(i, this.cfg, start, this.speedMs);
      this.robots.push(r);
      await r.init();
    }
    if (this.stopped) return;
    this.timer = setInterval(() => this.robots.forEach((r) => void r.tick(this.center)), TICK_MS);
  }

  setCenter(p: LatLng): void {
    this.center = p;
    for (const r of this.robots) {
      if (haversineM(r.pos, p) > 6000) r.teleport(destination(p, Math.random() * 360, 0.4 + Math.random() * 0.6));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all(this.robots.map((r) => r.stop()));
    this.robots = [];
    this.running = false;
    this.releaseLock?.();
    this.releaseLock = null;
  }
}
