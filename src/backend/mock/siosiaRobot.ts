// The demo's robot Siosia (FR-151): a provider offering Learning and Childcare who accepts a
// request within 5 s and, when the start is at least 1 h ahead and has a place, books a ride
// there from her place (on a series: a ride template for every date). 2.1: she also takes an open
// request for those services ("I can do it"), but only after 15 s, so a human in another tab sees
// it first and can take it. 2.3: she answers a chat once per room, a few seconds after the first
// message, and attaches no kids. She uses the very same Backend interface as a human provider, so
// one tab can play the whole loop; a second tab can still play the provider (the client then picks
// who to ask, or asks anyone).

import { destination, haversineM } from "../../core/geo";
import { derivedPickup } from "../../core/time";
import { ServerError, type AppointmentView, type ChatRoom, type Place } from "../../core/types";
import type { EngineConfig } from "../../core/engine";
import { getRoute } from "../../services/routing";
import { MockBackend } from "./index";

const TICK_MS = 1000;
/** She reads the request for a moment before answering (within the 5 s promise). */
const THINK_MS = 1500;
/** An open request waits this long for a human before she takes it (2.1). */
const TAKE_MS = 15_000;
/** A chat is answered this long after its first unread message (2.3). */
const REPLY_MS = 3000;
const REPLY = { en: "Thanks, I will be there on time 🙂", pl: "Dzięki, będę na czas 🙂" };
/**
 * The other party's language is not hers to see (Backend shows nicknames only), so she reads it off
 * their words: Polish letters or everyday Polish words → Polish, else English.
 */
const PL_RE = /[ąćęłńóśźż]|\b(dzięki|dziękuję|cześć|proszę|dobrze|jutro|dzisiaj|będę|jestem|czy|witam|hej)\b/i;
const OFFERS = ["learning", "childcare"];
const RIDE_IF_AHEAD_MS = 3600_000;
/** A demo played in another town: she moves near the first place she is asked to. */
const MOVE_IF_FURTHER_M = 25_000;

export class RobotSiosia {
  readonly api: MockBackend;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, number>();
  /** Open requests she could not take (taken by someone, or a clash): left alone from then on. */
  private passed = new Set<string>();
  /** Rooms with something unread, and since when (she answers after REPLY_MS). */
  private unreadSince = new Map<ChatRoom, number>();
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
    await this.api.setOffers(OFFERS).catch(() => {});
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
      const listed = new Set<string>();
      const due = (a: AppointmentView, wait: number) => {
        listed.add(a.id);
        const first = this.seen.get(a.id) ?? now;
        this.seen.set(a.id, first);
        return now - first >= wait;
      };
      for (const a of planned.appointments) {
        if (a.role !== "provider" || a.status !== "requested") continue;
        if (due(a, THINK_MS)) await this.accept(a);
      }
      for (const a of planned.open) {
        if (!a.open || !OFFERS.includes(a.serviceId) || this.passed.has(a.id)) continue;
        if (due(a, TAKE_MS)) await this.take(a);
      }
      // Requests that left her lists (taken by someone else, withdrawn) are forgotten.
      for (const id of this.seen.keys()) if (!listed.has(id)) this.seen.delete(id);
      // 2.3: rooms with unread messages (her appointments, and rides she booked) get one answer each.
      const rooms: ChatRoom[] = [
        ...planned.appointments.filter((a) => a.status === "accepted" && a.unread > 0).map((a) => `appt:${a.id}` as const),
        ...planned.rides.filter((r) => (r.unread ?? 0) > 0).map((r) => `ride:${r.id}` as const)
      ];
      for (const room of rooms) {
        const since = this.unreadSince.get(room) ?? now;
        this.unreadSince.set(room, since);
        if (now - since >= REPLY_MS) await this.reply(room);
      }
      for (const room of this.unreadSince.keys()) if (!rooms.includes(room)) this.unreadSince.delete(room);
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
    await this.rideThere(a, await this.api.answerAppointment(a.id, "accept").catch(() => null));
  }

  /** "I can do it": someone faster, or a clash with her schedule, and she leaves it be. */
  private async take(a: AppointmentView): Promise<void> {
    this.seen.delete(a.id);
    const taken = await this.api.takeRequest(a.id).catch(() => null);
    if (!taken) this.passed.add(a.id);
    await this.rideThere(a, taken);
  }

  /** After a Yes: a ride there from her place (a series: a template for every date). */
  private async rideThere(a: AppointmentView, accepted: AppointmentView | null): Promise<void> {
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

  /**
   * One answer per room, in the other party's language as far as their words show it. Reading the
   * thread marks it read (they see the marks); a room she already answered in only gets read.
   */
  private async reply(room: ChatRoom): Promise<void> {
    this.unreadSince.delete(room);
    const thread = await this.api.chat(room, true).catch(() => null);
    if (!thread || !thread.open || thread.messages.some((m) => m.mine)) return;
    const theirs = thread.messages.filter((m) => !m.mine).map((m) => m.text).join(" ");
    await this.api.sendMessage(room, PL_RE.test(theirs) ? REPLY.pl : REPLY.en).catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.api.dispose();
  }
}
