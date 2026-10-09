// Robot drivers for demo mode (FR-070). Each robot is a separate mock user that uses the very same
// Backend interface as a human driver: goes online, answers pings with heartbeats, accepts offers
// (two robots racing exercises the atomic claim), drives the route, advances the statuses, rates.

import { CADENCE } from "../../core/defaults";
import type { EngineConfig } from "../../core/engine";
import { bearingDeg, coarse, destination, haversineM } from "../../core/geo";
import { PositionThrottle } from "../../core/throttle";
import type { LatLng, MyState, RideView } from "../../core/types";
import { getRoute } from "../../services/routing";
import type { RideChannel } from "../types";
import { MockBackend } from "./index";

const NAMES = ["Robo Ania", "Robo Bartek", "Robo Celina", "Robo Darek"];
const CARS = [
  { make: "Toyota", model: "Corolla", colour: "White", plate: "RB 1001", seats: 4 },
  { make: "Skoda", model: "Octavia", colour: "Grey", plate: "RB 2002", seats: 4 },
  { make: "Kia", model: "Ceed", colour: "Blue", plate: "RB 3003", seats: 4 },
  { make: "Dacia", model: "Logan", colour: "Red", plate: "RB 4004", seats: 4 }
];

const TICK_MS = 1000;

class Robot {
  readonly api: MockBackend;
  pos: LatLng;
  heading = 0;
  private route: LatLng[] = [];
  private routeFor = "";
  private my: MyState | null = null;
  private channel: { rideId: string; ch: RideChannel } | null = null;
  private presence;
  private presThrottle = new PositionThrottle(CADENCE.presenceMs, CADENCE.presenceM);
  private posThrottle = new PositionThrottle(CADENCE.livePosMs, CADENCE.livePosM);
  private lastBeat = 0;
  private deciding: string | null = null;
  private waitUntil = 0;
  private tripKm = 0;
  private finishing = false;
  private unsubPing: () => void;
  private busy = false;

  constructor(
    readonly index: number,
    cfg: EngineConfig,
    start: LatLng,
    private readonly speedMs: number
  ) {
    this.api = new MockBackend(`robot-${index + 1}`, cfg, { sweep: false });
    this.pos = start;
    this.presence = this.api.driverPresence();
    this.unsubPing = this.api.onDriverPing(() => void this.beat(true));
  }

  async init(inviteCode: string | null): Promise<void> {
    if (inviteCode) await this.api.join(inviteCode, `robot-device-${this.index}`).catch(() => {});
    await this.api.saveProfile(NAMES[this.index % NAMES.length], "en");
    await this.api.saveVehicle(CARS[this.index % CARS.length]);
    const st = await this.api.myState();
    if (st.ride && st.ride.role === "driver") {
      // A previous robot session left a trip open; finish it gracefully.
      this.my = st;
    }
    await this.api.setOnline(true).catch(() => {});
    await this.beat(true);
  }

  async stop(): Promise<void> {
    this.unsubPing();
    this.closeChannel();
    this.presence.close();
    await this.api.setOnline(false).catch(() => {});
    this.api.dispose();
  }

  teleport(p: LatLng): void {
    this.pos = p;
    this.route = [];
    this.presThrottle.reset();
  }

  private async beat(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastBeat < CADENCE.heartbeatMs) return;
    this.lastBeat = now;
    const idle = !this.my?.ride;
    try {
      this.my = await this.api.heartbeat(idle ? coarse(this.pos) : null);
    } catch {
      /* ignore */
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.beat();
      const ride = this.my?.ride && this.my.ride.role === "driver" ? this.my.ride : null;
      if (!ride) {
        this.closeChannel();
        this.finishing = false;
        await this.handleOffer();
        this.cruise();
        if (this.presThrottle.offer(this.pos, Date.now()))
          this.presence.track({ id: this.api.uid, ...coarse(this.pos), state: "idle", heading: Math.round(this.heading), t: Date.now() });
        return;
      }
      this.presence.untrack();
      this.presThrottle.reset();
      await this.drive(ride);
    } finally {
      this.busy = false;
    }
  }

  private async handleOffer(): Promise<void> {
    const offer = this.my?.offer;
    if (!offer || this.deciding === offer.id) return;
    this.deciding = offer.id;
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

  private cruise(): void {
    // Slow random walk while idle.
    if (Math.random() < 0.1) this.heading = (this.heading + (Math.random() - 0.5) * 90 + 360) % 360;
    this.pos = destination(this.pos, this.heading, 0.006);
  }

  private async drive(ride: RideView): Promise<void> {
    if (!this.channel || this.channel.rideId !== ride.id) {
      this.closeChannel();
      this.channel = { rideId: ride.id, ch: this.api.openRide(ride.id, "driver", {}) };
      this.posThrottle.reset();
      this.tripKm = 0;
    }
    const now = Date.now();
    if (now < this.waitUntil) return this.sendPos();
    const target = ride.status === "in_progress" ? ride.dropoff : ride.pickup;
    const key = `${ride.id}:${ride.status}`;
    if (this.routeFor !== key) {
      this.routeFor = key;
      const r = await getRoute(this.pos, target, { timeoutMs: 2000 });
      this.route = [...r.line.slice(1)];
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
    if (!this.route.length || haversineM(this.pos, target) < 15) {
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
  running = false;

  constructor(
    private readonly cfg: EngineConfig,
    center: LatLng,
    private readonly count = 2,
    private readonly speedMs = 25
  ) {
    this.center = center;
  }

  /** Starts the fleet unless another tab of this browser already runs it. */
  async start(): Promise<boolean> {
    if (this.running) return true;
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      const got = await new Promise<boolean>((resolve) => {
        void locks.request("siosia-robots", { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          resolve(true);
          return new Promise<void>((release) => (this.releaseLock = release));
        });
      });
      if (!got) return false;
    }
    this.running = true;
    for (let i = 0; i < this.count; i++) {
      const start = destination(this.center, (360 / this.count) * i + 30, 0.4 + Math.random() * 0.6);
      const r = new Robot(i, this.cfg, start, this.speedMs);
      this.robots.push(r);
      await r.init(this.cfg.inviteCode);
    }
    this.timer = setInterval(() => this.robots.forEach((r) => void r.tick()), TICK_MS);
    return true;
  }

  setCenter(p: LatLng): void {
    this.center = p;
    for (const r of this.robots) {
      if (haversineM(r.pos, p) > 6000) r.teleport(destination(p, Math.random() * 360, 0.4 + Math.random() * 0.6));
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all(this.robots.map((r) => r.stop()));
    this.robots = [];
    this.running = false;
    this.releaseLock?.();
    this.releaseLock = null;
  }
}
