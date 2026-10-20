// The demo's robot Siosia (FR-151): a provider offering Learning and Childcare who accepts a
// request within 5 s and, when the start is at least 1 h ahead and has a place, books a ride
// there from her place (on a series: a ride template for every date). She uses the very same
// Backend interface as a human provider, so one tab can play the whole loop; a second tab can
// still play the provider (the client then picks who to ask).

import { destination, haversineM } from "../../core/geo";
import { derivedPickup } from "../../core/time";
import { ServerError, type AppointmentView, type Place } from "../../core/types";
import type { EngineConfig } from "../../core/engine";
import { getRoute } from "../../services/routing";
import { MockBackend } from "./index";

const TICK_MS = 1000;
/** She reads the request for a moment before answering (within the 5 s promise). */
const THINK_MS = 1500;
const RIDE_IF_AHEAD_MS = 3600_000;
/** A demo played in another town: she moves near the first place she is asked to. */
const MOVE_IF_FURTHER_M = 25_000;

export class RobotSiosia {
  readonly api: MockBackend;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, number>();
  private busy = false;
  private stopped = false;
  private lastRepair = 0;

  constructor(
    private readonly cfg: EngineConfig,
    private home: Place
  ) {
    this.api = new MockBackend("robot-siosia", cfg, { sweep: false });
  }

  /** Join, profile, offers, My place — also after a demo reset wiped her. */
  async init(): Promise<void> {
    if (this.cfg.inviteCode) await this.api.join(this.cfg.inviteCode, "robot-siosia-device").catch(() => {});
    await this.api.saveProfile("Siosia", "en").catch(() => {});
    await this.api.setOffers(["learning", "childcare"]).catch(() => {});
    await this.api.saveHome(this.home).catch(() => {});
  }

  async start(): Promise<void> {
    await this.init();
    if (this.stopped) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const planned = await this.api.planned();
      for (const a of planned.appointments) {
        if (a.role !== "provider" || a.status !== "requested") continue;
        const first = this.seen.get(a.id) ?? now;
        this.seen.set(a.id, first);
        if (now - first >= THINK_MS) await this.accept(a);
      }
    } catch (e) {
      if (e instanceof ServerError && (e.code === "no_profile" || e.code === "not_member") && Date.now() - this.lastRepair > 10_000) {
        this.lastRepair = Date.now();
        await this.init();
      }
    } finally {
      this.busy = false;
    }
  }

  private async accept(a: AppointmentView): Promise<void> {
    this.seen.delete(a.id);
    const accepted = await this.api.answerAppointment(a.id, "accept").catch(() => null);
    if (!accepted || accepted.status !== "accepted" || !a.place || a.startsAt - Date.now() < RIDE_IF_AHEAD_MS) return;
    if (haversineM(this.home, a.place) > MOVE_IF_FURTHER_M) {
      this.home = { ...destination(a.place, 210, 1.5), label: this.home.label };
      await this.api.saveHome(this.home).catch(() => {});
    }
    const route = await getRoute(this.home, a.place);
    const at = derivedPickup(a, "there", route.min);
    const ride = { pickup: this.home, dropoff: a.place, estKm: route.km, estMin: route.min, fareIsEstimate: route.estimate };
    // A ride that would be too soon is simply not booked (FR-112); she then goes on her own.
    if (a.series) await this.api.setRideTemplate(a.series.id, { ...ride, leg: "there", offsetMin: Math.round((at - a.startsAt) / 60_000) }).catch(() => {});
    else await this.api.bookRide({ ...ride, scheduledFor: at, appointmentId: a.id, leg: "there" }).catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.api.dispose();
  }
}
