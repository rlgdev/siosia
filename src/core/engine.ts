// Siosia server rules in TypeScript.
//
// This is the reference implementation of the server-side logic (spec §5 lifecycle, §6 dispatch,
// §7 guards). The mock backend runs it in the browser over localStorage; the Supabase backend runs
// the SQL twin in supabase/migrations/0001_siosia.sql. Unit and integration tests target this file,
// so any rule change must be made in BOTH places.
//
// Dispatch model ("ping + pull"): a new or re-dispatched request pings every online driver over
// realtime WITHOUT data; each driver's device answers with a heartbeat carrying its current coarse
// position as a parameter; the server creates an offer when that driver is eligible (§6). Driver
// positions are therefore never stored (FR-043) — they exist only as call arguments.

import type { PushKind, PushParams } from "../../supabase/functions/_shared/push-text";
import { DEFAULT_CONFIG, SERVER } from "./defaults";
import { computeFare } from "./fare";
import { haversineKm, isValidLatLng } from "./geo";
import { isActive } from "./lifecycle";
import { summarizeRatings } from "./rating";
import { addWeeksWallClock, localDate } from "./time";
import {
  ServerError,
  type AppointmentStatus,
  type AppointmentView,
  type AttachedRide,
  type AttachedStatus,
  type CatalogEntry,
  type CatalogItem,
  type HistoryItem,
  type Leg,
  type PartyRole,
  type Planned,
  type PublicProvider,
  type RideTemplateInput,
  type ServiceRequestInput,
  type BookingInput,
  type DeploymentConfig,
  type DriverCancelReason,
  type Earnings,
  type LatLng,
  type Lang,
  type MyState,
  type OfferStatus,
  type OfferView,
  type OpenBooking,
  type Place,
  type Profile,
  type RatingSummary,
  type RideRequestInput,
  type RideStatus,
  type RideView,
  type CancelledBy,
  type Vehicle
} from "./types";

export interface UserRow {
  id: string;
  nickname: string;
  language: Lang;
  createdAt: number;
  riderCancels: number;
  driverCancels: number;
  lateCancels: number;
  deleted: boolean;
  /** Shared master profile this user joined through its link (rider only). */
  masterId?: string | null;
  /** 2.0: random id others see (never the user id), offered entries, My place. */
  publicId?: string;
  offers?: string[];
  home?: Place | null;
}

/**
 * A master profile: a shared identity opened by a dedicated link. Every device that opens the link
 * becomes this profile (nickname, icon) in one role — a rider profile rides only, every ride at
 * `fixedFare`, starting from `pickup` / `dropoff`; a driver profile drives only, with `vehicle`.
 * (Supabase keeps these in master_profiles with only a hash of the token.)
 */
export interface MasterProfile {
  id: string;
  token: string;
  nickname: string;
  icon: string | null;
  fixedFare: number | null;
  /** Switched off: the link stops working, phones that joined only through it lose access. */
  active?: boolean;
  /** Default "rider". */
  role?: "rider" | "driver";
  pickup?: Place | null;
  dropoff?: Place | null;
  vehicle?: (Omit<Vehicle, "plate"> & { plate?: string }) | null;
  /** 2.0: catalog entries every phone on this profile offers (null = none besides rides). */
  offers?: string[] | null;
}

/** Master profiles of the in-browser demo (links: …?backend=mock#master=demo-master / demo-roman). */
export const DEMO_MASTERS: MasterProfile[] = [
  {
    id: "master",
    token: "demo-master",
    nickname: "Toria",
    icon: null,
    fixedFare: 18,
    role: "rider",
    pickup: { lat: 52.2504843, lng: 20.8253459, label: "Warszawsa 269, Stare Babice" },
    dropoff: { lat: 52.2663135, lng: 20.814317, label: "Husarska 16, Lipków" }
  },
  {
    id: "roman",
    token: "demo-roman",
    nickname: "Roman",
    icon: "taycan-ct-green",
    fixedFare: null,
    role: "driver",
    vehicle: { make: "Porsche", model: "Taycan Cross Turismo", colour: "Zielony", seats: 4 }
  }
];

export interface DriverRow {
  online: boolean;
  lastSeen: number;
  /** Standby: new requests are notified until then, even after the app went quiet. */
  standbyUntil?: number | null;
}

export interface RideRow {
  id: string;
  riderId: string;
  driverId: string | null;
  status: RideStatus;
  pickup: Place;
  dropoff: Place;
  estKm: number;
  estMin: number;
  fare: number;
  currency: string;
  fareIsEstimate: boolean;
  actualKm: number | null;
  actualMin: number | null;
  requestedAt: number;
  dispatchStartedAt: number;
  acceptedAt: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  cancelledBy: CancelledBy | null;
  cancelReason: string | null;
  paid: boolean;
  collected: boolean;
  notifiedCount: number;
  redispatchCount: number;
  round: number;
  /** Drivers who cancelled this ride; they never get it again (§6). */
  excluded: string[];
  /** Booked pickup time for a ride booked in advance (status "scheduled" until it starts). */
  scheduledFor?: number | null;
  /** 2.0: part of an appointment (leg there / back); made by a series template; last summary. */
  appointmentId?: string | null;
  leg?: Leg | null;
  autoBooked?: boolean;
  apptSummary?: AttachedStatus | null;
}

/** 2.0: an appointment (one occurrence of a series, or a single one). */
export interface ApptRow {
  id: string;
  clientId: string;
  providerId: string;
  serviceId: string;
  status: AppointmentStatus;
  startsAt: number;
  durationMin: number;
  place: Place | null;
  note: string;
  price: number | null;
  currency: string;
  requestedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  cancelledBy: "client" | "provider" | "system" | null;
  cancelReason: string | null;
  /** Reminder slots already sent. */
  reminded: number[];
  seriesId: string | null;
  seq: number | null;
}

export interface StoredTemplate {
  passenger: PartyRole;
  leg: Leg;
  pickup: Place;
  dropoff: Place;
  offsetMin: number;
  estKm: number;
  estMin: number;
  fareIsEstimate: boolean;
}

/** 2.0: a repeating request; its occurrences are ApptRows with seriesId and seq. */
export interface SeriesRow {
  id: string;
  clientId: string;
  providerId: string;
  serviceId: string;
  rule: "weekly" | "biweekly";
  firstStart: number;
  durationMin: number;
  count: number;
  until: number;
  place: Place | null;
  note: string;
  price: number | null;
  currency: string;
  status: "requested" | "answered" | "cancelled" | "expired";
  rideTemplates: StoredTemplate[];
  templatesAt: number | null;
  requestedAt: number;
  answeredAt: number | null;
}

export interface OfferRow {
  id: string;
  rideId: string;
  driverId: string;
  round: number;
  status: OfferStatus;
  createdAt: number;
  offeredAt: number | null;
  decidedAt: number | null;
  driverDistanceKm: number;
}

export interface RatingRow {
  /** Exactly one of rideId / appointmentId. */
  rideId?: string;
  appointmentId?: string;
  fromUser: string;
  toUser: string;
  stars: number;
  comment: string;
  createdAt: number;
}

export interface DbState {
  version: 1;
  seq: number;
  users: Record<string, UserRow>;
  vehicles: Record<string, Vehicle>;
  drivers: Record<string, DriverRow>;
  /** user id → device ids that entered the invite code (FR-007). */
  members: Record<string, string[]>;
  /** user id → device id → master profile, for devices that joined through a master link. */
  linkMembers?: Record<string, Record<string, string>>;
  rides: Record<string, RideRow>;
  offers: Record<string, OfferRow>;
  ratings: RatingRow[];
  inviteFails: Record<string, number[]>;
  /** "Move to the app" codes (normalised, no dash) → owner and expiry. Supabase keeps a hash. */
  transfers?: Record<string, { userId: string; expiresAt: number }>;
  /** 2.0 */
  appointments?: Record<string, ApptRow>;
  series?: Record<string, SeriesRow>;
}

/** Transfer codes: 8 characters without look-alikes (no I, O, 0, 1), shown as XXXX-XXXX. */
export const TRANSFER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const normalizeTransfer = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function emptyDb(): DbState {
  return { version: 1, seq: 0, users: {}, vehicles: {}, drivers: {}, members: {}, rides: {}, offers: {}, ratings: [], inviteFails: {}, appointments: {}, series: {} };
}

export interface EngineConfig extends DeploymentConfig {
  /** Plain invite code for the mock backend; null = no invite needed. (Supabase stores only a hash.) */
  inviteCode: string | null;
  /** Master profiles and their link tokens (mock only; Supabase stores token hashes). */
  masters?: MasterProfile[];
}

/** A notification for one user (Supabase: push_outbox → Web Push; demo: shown by the browser). */
export interface PushEvent {
  userId: string;
  kind: PushKind;
  rideId: string | null;
  /** 2.0: appointment notifications are tagged with the appointment. */
  appointmentId?: string | null;
  params: PushParams;
}

export interface Effects {
  /** Users whose state changed (→ realtime "changed" on topic user:<id>). */
  notify: Set<string>;
  /** A request opened or re-opened (→ data-less "ping" on topic "drivers"). */
  pingDrivers: boolean;
  /** Notifications to send (only users who turned them on get them). */
  push: PushEvent[];
}

export const normalizeInvite = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

const NICK_RE = /^.{2,20}$/u;

export class Engine {
  readonly effects: Effects = { notify: new Set(), pingDrivers: false, push: [] };
  private readonly cfg: EngineConfig;

  constructor(
    private readonly db: DbState,
    cfg: Partial<EngineConfig>,
    private readonly now: number
  ) {
    this.cfg = { ...DEFAULT_CONFIG, inviteCode: null, masters: [], ...cfg };
  }

  // ---------- identity ----------

  isMember(uid: string, deviceId?: string): boolean {
    if (this.cfg.inviteCode === null) return true;
    const devices = this.db.members[uid] ?? [];
    if (deviceId ? devices.includes(deviceId) : devices.length > 0) return true;
    // A master link counts only while that master profile is switched on.
    const links = Object.entries(this.db.linkMembers?.[uid] ?? {}).filter(([, m]) => this.masterDef(m)?.active !== false && !!this.masterDef(m));
    return deviceId ? links.some(([d]) => d === deviceId) : links.length > 0;
  }

  join(uid: string, code: string, deviceId: string): void {
    if (this.cfg.inviteCode === null) return;
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    if (normalizeInvite(code) !== normalizeInvite(this.cfg.inviteCode)) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_invite");
    }
    const devices = this.db.members[uid] ?? [];
    if (!devices.includes(deviceId)) this.db.members[uid] = [...devices, deviceId];
  }

  /**
   * Opens a master profile from its link: this device's user becomes that profile (nickname, icon,
   * fixed fare, rider only). The link replaces the invite code. Wrong tokens count as failed
   * invite attempts (same rate limit).
   */
  joinMaster(uid: string, token: string, deviceId: string, language: Lang, replace = false): Profile {
    if (!deviceId || deviceId.length > 80) throw new ServerError("bad_input");
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    const m = (this.cfg.masters ?? []).find((x) => x.token === token.trim() && x.active !== false);
    if (!m) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_link");
    }
    this.sweep();
    if (this.activeDriverRideOf(uid)) throw new ServerError("active_trip");
    const active = this.activeRideOf(uid);
    if (active && active.riderId === uid) throw new ServerError("active_ride");
    // Replacing another profile on this account needs the user's explicit confirmation.
    const existing = this.db.users[uid];
    if (!replace && existing && !existing.deleted && (existing.masterId ?? null) !== m.id) throw new ServerError("has_profile");
    this.goOffline(uid);
    if (!(this.db.members[uid] ?? []).includes(deviceId)) {
      const links = (this.db.linkMembers ??= {});
      links[uid] = { ...(links[uid] ?? {}), [deviceId]: m.id };
    }
    this.db.users[uid] = existing
      ? { ...existing, nickname: m.nickname, masterId: m.id, deleted: false }
      : { id: uid, nickname: m.nickname, language: language === "pl" ? "pl" : "en", createdAt: this.now, riderCancels: 0, driverCancels: 0, lateCancels: 0, deleted: false, masterId: m.id, publicId: randomPublicId() };
    // A driver profile with a complete vehicle (plate included) puts it on this account.
    const v = m.role === "driver" ? m.vehicle : null;
    if (v?.plate) this.db.vehicles[uid] = { ...v, plate: v.plate.toUpperCase() };
    this.effects.notify.add(uid);
    return this.getProfile(uid)!;
  }

  private masterDef(id: string | null | undefined): MasterProfile | null {
    return id ? (this.cfg.masters ?? []).find((m) => m.id === id) ?? null : null;
  }

  // ---------- moving a profile to another app / phone (iOS Home Screen apps have own storage) ----------

  /** A one-time code that lets another app or phone take over this profile (30 min). */
  createTransfer(uid: string): { code: string; expiresAt: number } {
    this.requireUser(uid);
    const all = (this.db.transfers ??= {});
    for (const [k, t] of Object.entries(all)) if (t.userId === uid || t.expiresAt <= this.now) delete all[k];
    let raw = "";
    for (let i = 0; i < 8; i++) raw += TRANSFER_ALPHABET[Math.floor(Math.random() * TRANSFER_ALPHABET.length)];
    const expiresAt = this.now + SERVER.transferS * 1000;
    all[raw] = { userId: uid, expiresAt };
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /**
   * Redeems a code on this app/phone: its profile, vehicle, history, ratings and master link move
   * to this account (the old app starts fresh). Another profile here is merged into it only after
   * the user confirms (`replace`). Wrong codes count as failed invite attempts.
   */
  redeemTransfer(uid: string, code: string, deviceId: string, replace = false): Profile {
    if (!deviceId || deviceId.length > 80) throw new ServerError("bad_input");
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    const key = normalizeTransfer(code);
    const t = this.db.transfers?.[key];
    const old = t && t.expiresAt > this.now ? t.userId : null;
    if (!old || !this.db.users[old] || this.db.users[old].deleted || !this.isMember(old)) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_transfer");
    }
    if (old === uid) {
      delete this.db.transfers![key];
      return this.getProfile(uid)!;
    }
    this.sweep();
    if (this.activeRideOf(old) || this.activeRideOf(uid)) throw new ServerError("active_ride");
    const mine = this.db.users[uid];
    if (!replace && mine && !mine.deleted) throw new ServerError("has_profile");
    this.goOffline(old);
    this.goOffline(uid);
    for (const r of Object.values(this.db.rides)) {
      if (r.riderId === old) r.riderId = uid;
      if (r.driverId === old) r.driverId = uid;
      r.excluded = r.excluded.map((x) => (x === old ? uid : x));
    }
    for (const a of [...Object.values(this.db.appointments ?? {}), ...Object.values(this.db.series ?? {})]) {
      if (a.clientId === old) a.clientId = uid;
      if (a.providerId === old) a.providerId = uid;
    }
    // Both accounts may hold a card for the same ride, or have rated the same ride: keep the new one.
    for (const [k, o] of Object.entries(this.db.offers))
      if (o.driverId === old && Object.values(this.db.offers).some((n) => n.driverId === uid && n.rideId === o.rideId && n.round === o.round))
        delete this.db.offers[k];
    this.db.ratings = this.db.ratings.filter((g) => !(g.fromUser === old && this.db.ratings.some((n) => n.fromUser === uid && ratingKey(n) === ratingKey(g))));
    for (const o of Object.values(this.db.offers)) if (o.driverId === old) o.driverId = uid;
    for (const g of this.db.ratings) {
      if (g.fromUser === old) g.fromUser = uid;
      if (g.toUser === old) g.toUser = uid;
    }
    this.db.users[uid] = { ...this.db.users[old], id: uid };
    delete this.db.users[old];
    if (this.db.vehicles[old]) {
      this.db.vehicles[uid] = this.db.vehicles[old];
      delete this.db.vehicles[old];
    }
    delete this.db.drivers[old];
    // This device becomes a member the way the old account was: invite code first, else its link.
    const viaLink = Object.values(this.db.linkMembers?.[old] ?? {})[0] ?? null;
    if ((this.db.members[old] ?? []).length > 0 || !viaLink) {
      const devices = this.db.members[uid] ?? [];
      if (!devices.includes(deviceId)) this.db.members[uid] = [...devices, deviceId];
    } else {
      const links = (this.db.linkMembers ??= {});
      links[uid] = { ...(links[uid] ?? {}), [deviceId]: viaLink };
    }
    delete this.db.members[old];
    if (this.db.linkMembers) delete this.db.linkMembers[old];
    for (const [k, x] of Object.entries(this.db.transfers ?? {})) if (x.userId === old) delete this.db.transfers![k];
    this.effects.notify.add(old);
    this.effects.notify.add(uid);
    return this.getProfile(uid)!;
  }

  /** The master profile this user rides as, while it is switched on (fixed fare, icon). */
  private masterOf(uid: string): MasterProfile | null {
    const m = this.masterDef(this.linkedMaster(uid));
    return m && m.active !== false ? m : null;
  }

  /** The active rider master profile of this user (fixed fare, default places). */
  private riderMaster(uid: string): MasterProfile | null {
    const m = this.masterOf(uid);
    return m && (m.role ?? "rider") === "rider" ? m : null;
  }

  /** Role of the master profile this user joined, switched on or not. */
  private linkedRole(uid: string): "rider" | "driver" | null {
    const id = this.linkedMaster(uid);
    return id ? this.masterDef(id)?.role ?? "rider" : null;
  }

  /** The master profile this user joined (one role, nickname locked), switched on or not. */
  private linkedMaster(uid: string): string | null {
    const u = this.db.users[uid];
    return u && !u.deleted ? u.masterId ?? null : null;
  }

  private requireMember(uid: string): void {
    if (!this.isMember(uid)) throw new ServerError("not_member");
  }

  private requireUser(uid: string): UserRow {
    this.requireMember(uid);
    const u = this.db.users[uid];
    if (!u || u.deleted) throw new ServerError("no_profile");
    return u;
  }

  getProfile(uid: string): Profile | null {
    const u = this.db.users[uid];
    if (!u || u.deleted) return null;
    return {
      userId: u.id,
      nickname: u.nickname,
      language: u.language,
      riderCancels: u.riderCancels,
      driverCancels: u.driverCancels,
      lateCancels: u.lateCancels,
      rating: this.rating(uid),
      masterId: this.linkedMaster(uid),
      masterRole: this.linkedRole(uid),
      icon: this.masterOf(uid)?.icon ?? null,
      fixedFare: this.riderMaster(uid)?.fixedFare ?? null,
      defaultPickup: this.riderMaster(uid)?.pickup ?? null,
      defaultDropoff: this.riderMaster(uid)?.dropoff ?? null,
      masterVehicle: (this.masterOf(uid)?.role === "driver" && this.masterOf(uid)?.vehicle) || null,
      publicId: this.publicIdOf(uid),
      offers: this.offersOf(uid),
      offersPreset: !!this.linkedMaster(uid),
      home: u.home ?? this.riderMaster(uid)?.pickup ?? null
    };
  }

  saveProfile(uid: string, nickname: string, language: Lang): Profile {
    this.requireMember(uid);
    // A master profile's nickname is set by the operator; only the language changes here.
    const linked = this.linkedMaster(uid);
    const nick = linked ? this.masterDef(linked)?.nickname ?? this.db.users[uid].nickname : nickname.trim();
    if (!NICK_RE.test(nick)) throw new ServerError("bad_nickname");
    const lang: Lang = language === "pl" ? "pl" : "en";
    const existing = this.db.users[uid];
    this.db.users[uid] = existing
      ? { ...existing, nickname: nick, language: lang, deleted: false }
      : { id: uid, nickname: nick, language: lang, createdAt: this.now, riderCancels: 0, driverCancels: 0, lateCancels: 0, deleted: false, publicId: randomPublicId() };
    return this.getProfile(uid)!;
  }

  getVehicle(uid: string): Vehicle | null {
    return this.db.vehicles[uid] ?? null;
  }

  saveVehicle(uid: string, v: Vehicle): Vehicle {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
    const clean: Vehicle = {
      make: v.make.trim(),
      model: v.model.trim(),
      colour: v.colour.trim(),
      plate: v.plate.trim().toUpperCase(),
      seats: Math.round(v.seats)
    };
    const ok =
      clean.make.length >= 1 && clean.make.length <= 30 &&
      clean.model.length >= 1 && clean.model.length <= 30 &&
      clean.colour.length >= 1 && clean.colour.length <= 20 &&
      clean.plate.length >= 2 && clean.plate.length <= 12 &&
      clean.seats >= 1 && clean.seats <= 6;
    if (!ok) throw new ServerError("bad_vehicle");
    this.db.vehicles[uid] = clean;
    return clean;
  }

  /** Delete = anonymise rides (nickname → "Deleted user"), drop the vehicle (§9 retention). */
  deleteProfile(uid: string): void {
    const u = this.requireUser(uid);
    if (this.activeRideOf(uid)) throw new ServerError("active_ride");
    // 2.0 (FR-142): upcoming appointments in either role end (user_gone), their rides follow, and
    // the other party is told once per appointment or series.
    const upcoming = Object.values(this.db.appointments ?? {})
      .filter((a) => (a.clientId === uid || a.providerId === uid) && (a.status === "requested" || a.status === "accepted"))
      .sort((x, y) => x.startsAt - y.startsAt);
    for (const a of upcoming) {
      a.status = "cancelled";
      a.endedAt = this.now;
      a.cancelledBy = "system";
      a.cancelReason = "user_gone";
      this.notifyAppt(a);
    }
    this.cascadeRides(upcoming.map((a) => a.id));
    const told = new Set<string>();
    for (const a of upcoming) {
      const key = a.seriesId ?? a.id;
      if (told.has(key)) continue;
      told.add(key);
      this.pushAppt(a.clientId === uid ? a.providerId : a.clientId, "appt_cancelled", a, {
        who: u.nickname,
        ...(a.seriesId ? { from: a.startsAt, left: upcoming.filter((x) => x.seriesId === a.seriesId).length } : {})
      });
    }
    for (const s of Object.values(this.db.series ?? {}))
      if ((s.clientId === uid || s.providerId === uid) && (s.status === "requested" || s.status === "answered")) s.status = "cancelled";
    for (const r of Object.values(this.db.rides)) {
      if (r.status !== "scheduled") continue;
      if (r.riderId === uid) {
        if (r.driverId) this.pushTo(r.driverId, "booking_cancelled", r, { pickup: r.pickup.label });
        this.endRide(r, "cancelled", "rider", null);
      } else if (r.driverId === uid) {
        r.driverId = null;
        this.effects.notify.add(r.riderId);
        this.pushTo(r.riderId, "booking_released", r, {});
      }
    }
    this.goOffline(uid);
    delete this.db.vehicles[uid];
    delete this.db.members[uid];
    if (this.db.linkMembers) delete this.db.linkMembers[uid];
    this.db.users[uid] = { ...u, nickname: "Deleted user", deleted: true, masterId: null, offers: [], home: null };
  }

  // ---------- reads ----------

  myState(uid: string, pos: LatLng | null = null): MyState {
    this.requireMember(uid);
    this.sweep();
    const ride = this.activeRideOf(uid);
    const offerRow = Object.values(this.db.offers).find((o) => o.driverId === uid && o.status === "offered") ?? null;
    const queued = Object.values(this.db.offers).filter((o) => o.driverId === uid && o.status === "queued").length;
    const driver = this.db.drivers[uid];
    return {
      serverNow: this.now,
      ride: ride ? this.rideView(ride, uid) : null,
      offer: offerRow ? this.offerView(offerRow) : null,
      queuedOffers: queued,
      driverOnline: !!driver?.online,
      hasVehicle: !!this.db.vehicles[uid],
      nearbyRequests: pos && isValidLatLng(pos) ? this.countNearby(uid, pos) : null,
      pendingReceipt: this.pendingReceipt(uid),
      bookings: Object.values(this.db.rides).filter((r) => r.status === "scheduled" && r.riderId === uid).length,
      driverBookings: Object.values(this.db.rides).filter((r) => r.status === "scheduled" && r.driverId === uid).length,
      hasProfile: !!this.db.users[uid] && !this.db.users[uid].deleted,
      standby: !!driver?.standbyUntil && driver.standbyUntil > this.now,
      openBookings:
        this.linkedRole(uid) === "rider" || !this.db.vehicles[uid] ? 0 : Object.values(this.db.rides).filter((r) => this.claimable(r, uid)).length,
      ...this.plannedSummary(uid)
    };
  }

  /** 2.0 (V22): requests waiting for my answer (a series once), upcoming items, the next one. */
  private plannedSummary(uid: string): Pick<MyState, "toAnswer" | "planned" | "nextPlanned"> {
    const appts = Object.values(this.db.appointments ?? {}).filter(
      (a) => (a.clientId === uid || a.providerId === uid) && (a.status === "requested" || a.status === "accepted") && this.endOf(a) > this.now
    );
    const rides = Object.values(this.db.rides).filter(
      (r) => (r.riderId === uid || r.driverId === uid) && (r.status === "scheduled" || isActive(r.status)) && !(r.appointmentId && r.riderId === uid)
    );
    const lang = this.db.users[uid]?.language ?? "en";
    const next = [
      ...appts.map((a) => ({ kind: "appointment" as const, at: a.startsAt, serviceId: a.serviceId })),
      ...rides.filter((r) => r.status === "scheduled").map((r) => ({ kind: "ride" as const, at: r.scheduledFor ?? r.requestedAt, serviceId: "ride" }))
    ].sort((x, y) => x.at - y.at)[0];
    return {
      toAnswer: new Set(
        Object.values(this.db.appointments ?? {})
          .filter((a) => a.providerId === uid && a.status === "requested" && a.startsAt > this.now)
          .map((a) => a.seriesId ?? a.id)
      ).size,
      planned: appts.length + rides.length,
      nextPlanned: next ? { ...next, title: this.serviceName(next.serviceId, lang) } : null
    };
  }

  getRide(uid: string, rideId: string): RideView {
    this.requireMember(uid);
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r || (r.riderId !== uid && r.driverId !== uid)) throw new ServerError("not_found");
    return this.rideView(r, uid);
  }

  history(uid: string): RideView[] {
    this.requireMember(uid);
    return Object.values(this.db.rides)
      .filter((r) => (r.riderId === uid || r.driverId === uid) && r.status !== "scheduled")
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .slice(0, SERVER.historyLimit)
      .map((r) => this.rideView(r, uid));
  }

  /** FR-063: completed rides only, in the deployment's timezone. */
  earnings(uid: string): Earnings {
    this.requireMember(uid);
    const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: this.cfg.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
    const today = dayKey(this.now);
    const month = today.slice(0, 7);
    let todayTotal = 0, todayCount = 0, monthTotal = 0, monthCount = 0;
    for (const r of Object.values(this.db.rides)) {
      if (r.driverId !== uid || r.status !== "completed" || r.endedAt === null) continue;
      const k = dayKey(r.endedAt);
      if (k.slice(0, 7) === month) {
        monthTotal += r.fare;
        monthCount++;
        if (k === today) {
          todayTotal += r.fare;
          todayCount++;
        }
      }
    }
    return { todayTotal, todayCount, monthTotal, monthCount, currency: this.cfg.tariff.currency };
  }

  // ---------- rider ----------

  requestRide(uid: string, input: RideRequestInput): RideView {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "driver") throw new ServerError("driver_only");
    this.sweep();
    if (this.activeRideOf(uid)) throw new ServerError("active_ride");
    const asDriver = this.db.drivers[uid];
    if (asDriver?.online) {
      // FR-005 applies to a live driver session; a driver tab that died (silent > 12 s, no trip)
      // must not block this user from riding, so that stale session is closed instead.
      if (this.now - asDriver.lastSeen > SERVER.driverStaleS * 1000) this.goOffline(uid);
      else throw new ServerError("online_as_driver");
    }
    const ride = this.newRide(uid, input);
    this.db.rides[ride.id] = ride;
    this.effects.pingDrivers = true;
    this.effects.notify.add(uid);
    this.pushStandby(ride);
    return this.rideView(ride, uid);
  }

  /** A validated new ride (now or booked): never shorter than the straight line, fare frozen. */
  private newRide(uid: string, input: RideRequestInput): RideRow {
    const { pickup, dropoff } = input;
    if (!isValidLatLng(pickup) || !isValidLatLng(dropoff)) throw new ServerError("bad_input");
    if (!Number.isFinite(input.estKm) || !Number.isFinite(input.estMin) || input.estKm <= 0 || input.estMin < 0)
      throw new ServerError("bad_input");
    const area = this.cfg.serviceArea;
    if (area && haversineKm(area, pickup) > area.radiusKm) throw new ServerError("outside_area");
    // The server never trusts a route shorter than the straight line.
    const straight = haversineKm(pickup, dropoff);
    const estKm = Math.max(input.estKm, straight);
    if (estKm > this.cfg.maxTripKm) throw new ServerError("too_far");
    const estMin = Math.max(1, input.estMin);
    // A master profile rides at its fixed fare, whatever the route.
    const fixed = this.riderMaster(uid)?.fixedFare ?? null;
    const ride: RideRow = {
      id: this.nextId("r"),
      riderId: uid,
      driverId: null,
      status: "requested",
      pickup: cleanPlace(pickup),
      dropoff: cleanPlace(dropoff),
      estKm: round1(estKm),
      estMin: Math.round(estMin),
      fare: fixed ?? computeFare(this.cfg.tariff, estKm, estMin),
      currency: this.cfg.tariff.currency,
      fareIsEstimate: fixed === null && !!input.fareIsEstimate,
      actualKm: null,
      actualMin: null,
      requestedAt: this.now,
      dispatchStartedAt: this.now,
      acceptedAt: null,
      arrivedAt: null,
      startedAt: null,
      endedAt: null,
      cancelledBy: null,
      cancelReason: null,
      paid: false,
      collected: false,
      notifiedCount: 0,
      redispatchCount: 0,
      round: 1,
      excluded: [],
      scheduledFor: null
    };
    return ride;
  }

  // ---------- bookings (rides booked in advance) ----------

  /** Books a ride for later (30 min … 30 days ahead by default); the fare is frozen now. */
  bookRide(uid: string, input: BookingInput): RideView {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "driver") throw new ServerError("driver_only");
    this.sweep();
    return this.bookFor(uid, input, input.appointmentId ?? null, input.leg ?? null, false);
  }

  /**
   * A booked ride, optionally as part of an appointment (V9): the passenger is a party, the
   * appointment accepted, the leg free, "there" before the start and "back" at or after it. A
   * series template's bookings do not count against the daily limit. (SQL: siosia_book_for.)
   */
  private bookFor(uid: string, input: BookingInput, appointmentId: string | null, leg: Leg | null, template: boolean): RideView {
    if (this.linkedRole(uid) === "driver") throw new ServerError("driver_only");
    const ride = this.newRide(uid, input);
    const { minLeadMin, maxDays, maxOpen } = this.cfg.booking;
    const t = input.scheduledFor;
    if (!Number.isFinite(t) || t < this.now + minLeadMin * 60_000 || t > this.now + maxDays * 86_400_000) throw new ServerError("bad_time");
    let a: ApptRow | null = null;
    if (appointmentId) {
      a = this.db.appointments?.[appointmentId] ?? null;
      if (!a || (a.clientId !== uid && a.providerId !== uid)) throw new ServerError("not_found");
      if (a.status !== "accepted") throw new ServerError("not_accepted");
      if (leg !== "there" && leg !== "back") throw new ServerError("bad_leg");
      if ((leg === "there" && t >= a.startsAt) || (leg === "back" && t < a.startsAt)) throw new ServerError("bad_time");
      const appt = a;
      if (Object.values(this.db.rides).some((r) => r.appointmentId === appt.id && r.riderId === uid && r.leg === leg && r.status !== "cancelled" && r.status !== "expired"))
        throw new ServerError("ride_exists");
    } else if (leg) throw new ServerError("bad_leg");
    const mine = Object.values(this.db.rides).filter((r) => r.riderId === uid);
    // At most booking.maxOpen open, and 10 new bookings a day (each one notifies drivers).
    if (
      mine.filter((r) => r.status === "scheduled").length >= (maxOpen ?? 12) ||
      (!template && mine.filter((r) => r.scheduledFor != null && !r.autoBooked && r.requestedAt > this.now - 86_400_000).length >= SERVER.maxBookingsPerDay)
    )
      throw new ServerError("too_many");
    ride.status = "scheduled";
    ride.scheduledFor = t;
    ride.dispatchStartedAt = t;
    ride.appointmentId = a?.id ?? null;
    ride.leg = a ? leg : null;
    ride.autoBooked = template;
    ride.apptSummary = a ? "pending" : null;
    this.db.rides[ride.id] = ride;
    this.effects.notify.add(uid);
    // Everyone who can take it hears about it (Supabase: only those with notifications on).
    for (const d of Object.keys(this.db.vehicles))
      if (d !== uid && this.db.users[d] && !this.db.users[d].deleted && this.linkedRole(d) !== "rider" && this.isMember(d))
        this.pushTo(d, "booking_new", ride, { pickup: ride.pickup.label, dropoff: ride.dropoff.label });
    if (a) {
      this.notifyAppt(a);
      // The other party hears that a ride was added (a series template tells once, when it is set).
      if (!template)
        this.pushAppt(a.clientId === uid ? a.providerId : a.clientId, "appt_ride_added", a, { leg: leg ?? undefined, time: t, who: this.db.users[uid]?.nickname ?? "" });
    }
    return this.rideView(ride, uid);
  }

  /** My upcoming bookings, as rider or as the driver who took them, soonest first. */
  bookings(uid: string): RideView[] {
    this.requireMember(uid);
    this.sweep();
    return Object.values(this.db.rides)
      .filter((r) => r.status === "scheduled" && (r.riderId === uid || r.driverId === uid))
      .sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0))
      .map((r) => this.rideView(r, uid));
  }

  /** Bookings without a driver that this driver could take, soonest first. */
  openBookings(uid: string, pos: LatLng | null): OpenBooking[] {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
    if (!this.db.vehicles[uid]) throw new ServerError("no_vehicle");
    this.sweep();
    return Object.values(this.db.rides)
      .filter((r) => this.claimable(r, uid))
      .sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0))
      .map((r) => ({ ride: this.rideView(r, uid), distanceKm: pos && isValidLatLng(pos) ? round1(haversineKm(pos, r.pickup)) : null }));
  }

  private claimable(r: RideRow, uid: string): boolean {
    return r.status === "scheduled" && !r.driverId && r.riderId !== uid && !r.excluded.includes(uid);
  }

  /** A driver takes a booking in advance (atomic: one driver wins); no two overlapping ones. */
  claimBooking(uid: string, rideId: string): "won" {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
    if (!this.db.vehicles[uid]) throw new ServerError("no_vehicle");
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r || r.riderId === uid || r.excluded.includes(uid)) throw new ServerError("not_found");
    if (r.status !== "scheduled" || r.driverId) throw new ServerError("taken");
    const clash = Object.values(this.db.rides).some(
      (x) =>
        x.status === "scheduled" &&
        x.driverId === uid &&
        Math.abs((x.scheduledFor ?? 0) - (r.scheduledFor ?? 0)) < (Math.max(x.estMin, r.estMin) + 30) * 60_000
    );
    if (clash) throw new ServerError("overlap");
    r.driverId = uid;
    this.notifyRide(r);
    this.pushTo(r.riderId, "booking_taken", r, { driver: this.db.users[uid].nickname });
    return "won";
  }

  /** The driver gives a booking back (close to its time this counts as a driver cancellation). */
  releaseBooking(uid: string, rideId: string): void {
    this.requireUser(uid);
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r || r.driverId !== uid) throw new ServerError("not_found");
    if (r.status !== "scheduled") throw new ServerError("illegal_transition");
    if ((r.scheduledFor ?? 0) - this.now < SERVER.lateBookingChangeS * 1000) this.db.users[uid].driverCancels++;
    r.driverId = null;
    this.effects.notify.add(uid);
    this.effects.notify.add(r.riderId);
    this.pushTo(r.riderId, "booking_released", r, {});
    this.attachedChanged(r);
  }

  cancelRide(uid: string, rideId: string, reason?: string): void {
    this.requireUser(uid);
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r) throw new ServerError("not_found");
    if (r.riderId === uid) return this.riderCancel(r);
    if (r.driverId === uid) return this.driverCancel(r, (reason ?? "other") as DriverCancelReason);
    throw new ServerError("forbidden");
  }

  private riderCancel(r: RideRow): void {
    const u = this.db.users[r.riderId];
    if (r.status === "scheduled") {
      if (u && (r.scheduledFor ?? 0) - this.now < SERVER.lateBookingChangeS * 1000) u.riderCancels++;
      if (r.driverId) this.pushTo(r.driverId, "booking_cancelled", r, { pickup: r.pickup.label });
      this.endRide(r, "cancelled", "rider", null);
      return;
    }
    if (r.status === "requested" || r.status === "accepted" || r.status === "arrived") {
      // Not held against the rider once Siosia gave up on their driver (silent for 15 min).
      const driverLost = r.status === "requested" && r.cancelReason === "driver_lost";
      if (u && !driverLost) {
        u.riderCancels++;
        if (r.status === "arrived") u.lateCancels++;
      }
      this.endRide(r, "cancelled", "rider", r.status === "arrived" ? "late_cancel" : null);
      return;
    }
    throw new ServerError("illegal_transition");
  }

  private driverCancel(r: RideRow, reason: DriverCancelReason): void {
    const driverId = r.driverId!;
    if (r.status === "scheduled") return this.releaseBooking(driverId, r.id);
    if (r.status === "arrived" && reason === "no_show") {
      // A booked ride waits from the booked time, even if the driver came early.
      if (r.arrivedAt === null || this.now < Math.max(r.arrivedAt, r.scheduledFor ?? 0) + this.cfg.timers.noShowS * 1000)
        throw new ServerError("too_early");
      this.endRide(r, "cancelled", "driver", "no_show");
      return;
    }
    if (r.status === "accepted" || r.status === "arrived") {
      const d = this.db.users[driverId];
      if (d) d.driverCancels++;
      this.redispatch(r, reason);
      return;
    }
    throw new ServerError("illegal_transition");
  }

  // ---------- driver ----------

  setOnline(uid: string, online: boolean): void {
    this.requireUser(uid);
    this.sweep();
    if (online) {
      if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
      if (!this.db.vehicles[uid]) throw new ServerError("no_vehicle");
      const active = this.activeRideOf(uid);
      if (active && active.riderId === uid) throw new ServerError("active_ride");
      const fresh = !this.db.drivers[uid]?.online;
      this.db.drivers[uid] = { online: true, lastSeen: this.now, standbyUntil: this.standbyUntil() };
      // A new online session reviews every pending request nearby again — including ones this
      // driver declined or let lapse earlier.
      if (fresh) this.clearDecisions(uid);
    } else {
      const active = this.activeRideOf(uid);
      if (active && active.driverId === uid) throw new ServerError("active_trip");
      this.goOffline(uid);
    }
    this.effects.notify.add(uid);
  }

  /**
   * Driver heartbeat while online: refreshes liveness, runs the sweep and — when the driver is
   * idle and sends a position — pulls offers for open requests within the dispatch radius.
   * The position is used for this computation only and is never stored.
   */
  heartbeat(uid: string, pos: LatLng | null): MyState {
    this.requireUser(uid);
    const d = this.db.drivers[uid];
    let idlePos: LatLng | null = null;
    if (d?.online) {
      d.lastSeen = this.now;
      d.standbyUntil = this.standbyUntil();
      this.sweep();
      if (pos && isValidLatLng(pos) && !this.activeRideOf(uid)) {
        idlePos = pos;
        this.pullOffers(uid, pos);
      }
    }
    return this.myState(uid, idlePos);
  }

  /**
   * "Show requests": the driver asks to see every pending request nearby again. Earlier Declines
   * and lapsed cards on open requests are cleared, then all requests in range are offered (one
   * card at a time, the rest queued). Drivers who cancelled a ride after accepting stay excluded.
   */
  refreshOffers(uid: string, pos: LatLng): MyState {
    this.requireUser(uid);
    if (!isValidLatLng(pos)) throw new ServerError("bad_input");
    const d = this.db.drivers[uid];
    if (!d?.online) throw new ServerError("not_online");
    d.lastSeen = this.now;
    this.sweep();
    if (this.activeDriverRideOf(uid)) throw new ServerError("active_trip");
    this.clearDecisions(uid);
    this.pullOffers(uid, pos);
    this.effects.notify.add(uid);
    return this.myState(uid, pos);
  }

  decideOffer(uid: string, offerId: string, decision: "accept" | "decline" | "timeout"): "won" | "ok" {
    this.requireUser(uid);
    this.touchDriver(uid);
    this.sweep();
    const o = this.db.offers[offerId];
    if (!o || o.driverId !== uid) throw new ServerError("not_found");
    const r = this.db.rides[o.rideId];
    if (decision === "accept") {
      if (o.status !== "offered") {
        throw new ServerError(r && r.status !== "requested" && r.driverId !== uid ? "taken" : "offer_expired");
      }
      if (!this.db.drivers[uid]?.online) throw new ServerError("not_online");
      if (this.activeRideOf(uid)) throw new ServerError("active_trip");
      // Atomic claim: only while the ride is still "requested" (SQL: UPDATE … WHERE status = 'requested').
      if (!r || r.status !== "requested" || r.round !== o.round) {
        this.closeOffer(o, "withdrawn");
        throw new ServerError("taken");
      }
      r.status = "accepted";
      r.driverId = uid;
      r.acceptedAt = this.now;
      this.closeOffer(o, "won");
      this.withdrawRideOffers(r.id);
      // The driver is busy now: their other cards go away (those rides stay open for others).
      for (const other of Object.values(this.db.offers))
        if (other.driverId === uid && (other.status === "offered" || other.status === "queued")) this.closeOffer(other, "withdrawn");
      this.notifyRide(r);
      this.pushTo(r.riderId, "driver_coming", r, { driver: this.db.users[uid].nickname });
      return "won";
    }
    if (o.status === "offered" || o.status === "queued") {
      if (decision === "timeout" && o.status === "offered" && o.offeredAt !== null && this.now < o.offeredAt + (this.cfg.timers.offerS - 1) * 1000)
        return "ok"; // early client timer; the server clock decides
      this.closeOffer(o, decision === "decline" ? "declined" : "timed_out");
      this.effects.notify.add(r?.riderId ?? uid);
    } else if (o.status === "withdrawn" || (o.status === "timed_out" && decision === "decline")) {
      // Decided after the card left the screen server-side (phone briefly offline, or a Decline
      // landing just after the countdown): a Decline is recorded as such; a timeout is like any
      // lapsed card and comes back after retryS.
      o.status = decision === "decline" ? "declined" : "timed_out";
      o.decidedAt = this.now;
    }
    return "ok";
  }

  advance(uid: string, rideId: string, to: "arrived" | "in_progress" | "completed", actualKm?: number): RideView {
    this.requireUser(uid);
    this.touchDriver(uid);
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r) throw new ServerError("not_found");
    if (r.driverId !== uid) throw new ServerError("forbidden");
    const legal =
      (r.status === "accepted" && to === "arrived") ||
      (r.status === "arrived" && to === "in_progress") ||
      (r.status === "in_progress" && to === "completed");
    if (!legal) throw new ServerError("illegal_transition");
    r.status = to;
    if (to === "arrived") {
      r.arrivedAt = this.now;
      this.pushTo(r.riderId, "driver_arrived", r, { driver: this.db.users[uid].nickname });
    }
    if (to === "in_progress") r.startedAt = this.now;
    if (to === "completed") {
      r.endedAt = this.now;
      const km = Number.isFinite(actualKm) ? Math.min(Math.max(actualKm ?? 0, 0), 1000) : 0;
      r.actualKm = round1(km);
      r.actualMin = round1((this.now - (r.startedAt ?? this.now)) / 60000);
    }
    this.notifyRide(r);
    return this.rideView(r, uid);
  }

  // ---------- after the ride ----------

  markPaid(uid: string, rideId: string): void {
    const r = this.afterRide(uid, rideId);
    if (r.riderId !== uid) throw new ServerError("forbidden");
    r.paid = true;
    this.notifyRide(r);
  }

  markCollected(uid: string, rideId: string): void {
    const r = this.afterRide(uid, rideId);
    if (r.driverId !== uid) throw new ServerError("forbidden");
    r.collected = true;
    this.notifyRide(r);
  }

  rate(uid: string, rideId: string, stars: number, comment: string): void {
    const r = this.afterRide(uid, rideId);
    const to = r.riderId === uid ? r.driverId : r.driverId === uid ? r.riderId : null;
    if (!to) throw new ServerError("forbidden");
    const s = Math.round(stars);
    if (s < 1 || s > 5) throw new ServerError("bad_input");
    if (this.db.ratings.some((x) => x.rideId === rideId && x.fromUser === uid)) throw new ServerError("already_rated");
    this.db.ratings.push({ rideId, fromUser: uid, toUser: to, stars: s, comment: comment.trim().slice(0, 140), createdAt: this.now });
    this.notifyRide(r);
  }

  private afterRide(uid: string, rideId: string): RideRow {
    this.requireUser(uid);
    const r = this.db.rides[rideId];
    if (!r || (r.riderId !== uid && r.driverId !== uid)) throw new ServerError("not_found");
    if (r.status !== "completed") throw new ServerError("illegal_transition");
    if (r.endedAt !== null && this.now > r.endedAt + SERVER.afterRideWindowS * 1000) throw new ServerError("window_closed");
    return r;
  }

  // ---------- system ----------

  /** Timeouts, expiry, lost drivers. Runs on every call ("expiry check on read") and on a timer. */
  sweep(): void {
    const { offerS } = this.cfg.timers;
    this.sweepAppointments();
    this.sweepBookings();
    for (const o of Object.values(this.db.offers)) {
      if (o.status === "offered" && o.offeredAt !== null && this.now >= o.offeredAt + offerS * 1000) this.closeOffer(o, "timed_out");
    }
    for (const [uid, d] of Object.entries(this.db.drivers)) {
      if (!d.online) continue;
      const silentMs = this.now - d.lastSeen;
      // Silent > 12 s (tab killed, phone offline): the driver loses their cards at once…
      if (silentMs > SERVER.driverStaleS * 1000) {
        for (const o of Object.values(this.db.offers))
          if (o.driverId === uid && (o.status === "offered" || o.status === "queued")) this.closeOffer(o, "withdrawn");
      }
      // …and an idle driver silent for 60 s is set offline (a short screen lock is tolerated).
      if (silentMs > SERVER.driverLostS * 1000 && !this.activeDriverRideOf(uid)) {
        d.online = false;
        this.effects.notify.add(uid);
      }
    }
    for (const r of Object.values(this.db.rides)) {
      if (r.status === "requested" && this.now >= this.expiresAt(r)) {
        this.endRide(r, "expired", "system", null);
      } else if ((r.status === "accepted" || r.status === "arrived") && r.driverId) {
        // A booked ride gives its driver until 15 min after the booked time to show up.
        if (r.scheduledFor != null && this.now < r.scheduledFor + SERVER.bookingLateS * 1000) continue;
        const d = this.db.drivers[r.driverId];
        // Silent for minutes is normal on an iPhone (screen locked, Maps in front): wait longer.
        if (!d || this.now - d.lastSeen > SERVER.rideDriverLostS * 1000) {
          const lost = r.driverId;
          if (d) d.online = false;
          this.redispatch(r, "driver_lost");
          this.effects.notify.add(lost);
        }
      }
    }
  }

  /**
   * Bookings: a claimed one starts (driver on the way) `leadMin` before its time; an unclaimed one
   * opens to normal dispatch `openMin` before. Either waits while its people are busy and gives up
   * 15 minutes after the booked time.
   */
  private sweepBookings(): void {
    const { leadMin, openMin } = this.cfg.booking;
    const lateMs = SERVER.bookingLateS * 1000;
    for (const r of Object.values(this.db.rides)) {
      if (r.status !== "scheduled" || r.scheduledFor == null) continue;
      const t = r.scheduledFor;
      if (this.now < t - (r.driverId ? leadMin : openMin) * 60_000) continue;
      // A booking whose rider no longer exists ends; one whose driver is gone loses its driver.
      const rider = this.db.users[r.riderId];
      if (!rider || rider.deleted) {
        this.endRide(r, "cancelled", "system", "user_gone");
        continue;
      }
      if (r.driverId && (!this.db.users[r.driverId] || this.db.users[r.driverId].deleted)) r.driverId = null;
      // Busy = any active ride in either role (a rider who is driving someone is busy too).
      const riderBusy = !!this.activeRideOf(r.riderId);
      if (r.driverId && !riderBusy && !this.activeRideOf(r.driverId)) this.startBooking(r);
      else if (!r.driverId && !riderBusy) this.openBooking(r);
      else if (this.now > t + lateMs) {
        if (riderBusy) this.endRide(r, "expired", "system", null);
        else this.openBooking(r);
      }
    }
  }

  /** Claimed booking: the ride is now accepted and the driver on duty (even before their app opens). */
  private startBooking(r: RideRow): void {
    const driverId = r.driverId!;
    r.status = "accepted";
    r.acceptedAt = this.now;
    r.dispatchStartedAt = this.now;
    this.db.drivers[driverId] = { online: true, lastSeen: this.now, standbyUntil: this.standbyUntil() };
    for (const o of Object.values(this.db.offers))
      if (o.driverId === driverId && (o.status === "offered" || o.status === "queued")) this.closeOffer(o, "withdrawn");
    this.notifyRide(r);
    this.pushTo(driverId, "time_to_go", r, { pickup: r.pickup.label, rider: this.db.users[r.riderId]?.nickname ?? "" });
    this.pushTo(r.riderId, "driver_coming", r, { driver: this.db.users[driverId]?.nickname ?? "" });
  }

  /** Unclaimed (or its driver still busy): the booking becomes a normal request. */
  private openBooking(r: RideRow): void {
    const had = r.driverId;
    r.status = "requested";
    r.driverId = null;
    r.dispatchStartedAt = this.now;
    r.notifiedCount = 0;
    this.effects.pingDrivers = true;
    this.effects.notify.add(r.riderId);
    if (had) this.effects.notify.add(had);
    this.pushTo(r.riderId, "booking_open", r, {});
    this.pushStandby(r);
  }

  private standbyUntil(): number | null {
    return this.cfg.standbyHours > 0 ? this.now + this.cfg.standbyHours * 3600_000 : null;
  }

  /** Drivers on standby whose app is not in front (phone locked, app closed) hear about a new request. */
  private pushStandby(r: RideRow): void {
    for (const [d, row] of Object.entries(this.db.drivers)) {
      if (!row.standbyUntil || row.standbyUntil <= this.now) continue;
      if (row.online && this.now - row.lastSeen < SERVER.activeAppS * 1000) continue; // the offer card shows it
      const u = this.db.users[d];
      if (!u || u.deleted || d === r.riderId || r.excluded.includes(d) || !this.db.vehicles[d]) continue;
      if (this.linkedRole(d) === "rider" || this.activeRideOf(d)) continue;
      this.pushTo(d, "request_new", r, { pickup: r.pickup.label });
    }
  }

  private pushTo(userId: string, kind: PushKind, r: RideRow, params: PushParams): void {
    if (!this.isMember(userId)) return;
    this.effects.push.push({ userId, kind, rideId: r.id, params: { at: r.scheduledFor ?? null, ...params } });
  }

  /** When an open request expires; a booked one waits at least until 15 min after its time. */
  private expiresAt(r: RideRow): number {
    const base = r.dispatchStartedAt + this.cfg.timers.expiryS * 1000;
    return r.scheduledFor != null ? Math.max(base, r.scheduledFor + SERVER.bookingLateS * 1000) : base;
  }

  // ---------- 2.0: catalog, offers, My place ----------

  /** The enabled catalog with who offers each "time" entry (public ids only), without the viewer. */
  catalog(uid: string): CatalogItem[] {
    this.requireMember(uid);
    return this.cfg.services
      .filter((e) => e.enabled)
      .map((e) => ({
        ...e,
        providers:
          e.kind !== "time"
            ? []
            : Object.values(this.db.users)
                .filter((u) => !u.deleted && u.id !== uid && this.isMember(u.id) && this.offersOf(u.id).includes(e.id))
                .sort((a, b) => a.nickname.localeCompare(b.nickname))
                .map((u) => this.publicParty(u.id))
      }));
  }

  /** Services I offer (FR-093): enabled "time" entries; a master profile's preset cannot change. */
  setOffers(uid: string, ids: string[]): Profile {
    const u = this.requireUser(uid);
    if (this.linkedMaster(uid)) throw new ServerError("forbidden");
    for (const id of ids) {
      const e = this.service(id);
      if (!e || e.kind !== "time" || !e.enabled) throw new ServerError("bad_service");
    }
    u.offers = [...new Set(ids)];
    this.effects.notify.add(uid);
    return this.getProfile(uid)!;
  }

  /** My place (FR-140); null clears it. */
  saveHome(uid: string, place: Place | null): Profile {
    const u = this.requireUser(uid);
    if (place !== null && (!isValidLatLng(place) || !String(place.label ?? "").trim())) throw new ServerError("bad_input");
    u.home = place === null ? null : cleanPlace(place);
    return this.getProfile(uid)!;
  }

  // ---------- 2.0: appointments ----------

  /** Send request (V3, V4, V23): optionally a weekly / every-2-weeks series. */
  requestService(uid: string, input: ServiceRequestInput): AppointmentView {
    this.requireUser(uid);
    this.sweep();
    const e = this.service(input.serviceId);
    if (!e || e.kind !== "time" || !e.enabled || !e.duration) throw new ServerError("bad_service");
    const provider = Object.values(this.db.users).find((u) => !u.deleted && u.publicId === input.providerId);
    if (!provider || provider.id === uid || !this.isMember(provider.id)) throw new ServerError("no_provider");
    if (!this.offersOf(provider.id).includes(e.id)) throw new ServerError("not_offered");
    const { minLeadMin, maxDays } = this.cfg.booking;
    const t0 = input.startsAt;
    if (!Number.isFinite(t0) || t0 < this.now + minLeadMin * 60_000 || t0 > this.now + maxDays * 86_400_000) throw new ServerError("bad_time");
    const d = Math.round(input.durationMin);
    if (!Number.isFinite(input.durationMin) || d < e.duration.min || d > e.duration.max || (d - e.duration.min) % e.duration.step !== 0)
      throw new ServerError("bad_duration");
    const note = String(input.note ?? "").trim();
    const place = input.place ?? null;
    if ((place === null && e.needsPlace) || (place !== null && (!isValidLatLng(place) || !String(place.label ?? "").trim())) || note.length > 200)
      throw new ServerError("bad_input");
    const price = e.price && "perHour" in e.price ? Math.round(((e.price.perHour * d) / 60) * 100) / 100 : e.price && "fixed" in e.price ? e.price.fixed : null;
    // The occurrences: one, or a series at the same wall-clock time every 1 or 2 weeks.
    const tz = this.cfg.timezone;
    const { seriesMaxCount, seriesMaxDays } = this.cfg.appointment;
    let starts = [t0];
    const rep = input.repeat;
    if (rep) {
      if (rep.every !== 1 && rep.every !== 2) throw new ServerError("bad_repeat");
      starts = [];
      if (typeof rep.count === "number") {
        if (rep.count < 2 || rep.count > seriesMaxCount) throw new ServerError("bad_repeat");
        for (let k = 0; k < rep.count; k++) starts.push(addWeeksWallClock(t0, k * rep.every, tz));
      } else if (typeof rep.until === "number") {
        const last = localDate(rep.until, tz);
        for (let k = 0; k <= seriesMaxCount; k++) {
          const t = addWeeksWallClock(t0, k * rep.every, tz);
          if (localDate(t, tz) > last) break;
          starts.push(t);
        }
        if (starts.length < 2 || starts.length > seriesMaxCount) throw new ServerError("bad_repeat");
      } else throw new ServerError("bad_repeat");
      if (starts[starts.length - 1] > this.now + seriesMaxDays * 86_400_000) throw new ServerError("bad_repeat");
    }
    // Limits: ≤ 10 open single appointments, ≤ 3 open series, ≤ 20 new a day (a series counts once).
    const appts = Object.values(this.db.appointments ?? {});
    if (starts.length === 1) {
      if (appts.filter((a) => a.clientId === uid && !a.seriesId && (a.status === "requested" || a.status === "accepted") && a.startsAt > this.now).length >= SERVER.maxOpenAppointments)
        throw new ServerError("too_many");
    } else if (
      Object.values(this.db.series ?? {}).filter(
        (s) =>
          s.clientId === uid &&
          (s.status === "requested" || s.status === "answered") &&
          appts.some((a) => a.seriesId === s.id && (a.status === "requested" || a.status === "accepted") && a.startsAt > this.now)
      ).length >= SERVER.maxOpenSeries
    )
      throw new ServerError("too_many");
    const dayAgo = this.now - 86_400_000;
    if (
      appts.filter((a) => a.clientId === uid && !a.seriesId && a.requestedAt > dayAgo).length +
        Object.values(this.db.series ?? {}).filter((s) => s.clientId === uid && s.requestedAt > dayAgo).length >=
      SERVER.maxRequestsPerDay
    )
      throw new ServerError("too_many");
    const base = {
      clientId: uid,
      providerId: provider.id,
      serviceId: e.id,
      durationMin: d,
      place: place ? cleanPlace(place) : null,
      note,
      price,
      currency: this.cfg.tariff.currency
    };
    let series: SeriesRow | null = null;
    if (starts.length > 1) {
      series = {
        ...base,
        id: this.nextId("s"),
        rule: rep!.every === 1 ? "weekly" : "biweekly",
        firstStart: starts[0],
        count: starts.length,
        until: starts[starts.length - 1],
        status: "requested",
        rideTemplates: [],
        templatesAt: null,
        requestedAt: this.now,
        answeredAt: null
      };
      (this.db.series ??= {})[series.id] = series;
    }
    let first: ApptRow | null = null;
    starts.forEach((t, i) => {
      const a: ApptRow = {
        ...base,
        id: this.nextId("a"),
        status: "requested",
        startsAt: t,
        requestedAt: this.now,
        answeredAt: null,
        endedAt: null,
        cancelledBy: null,
        cancelReason: null,
        reminded: [],
        seriesId: series?.id ?? null,
        seq: series ? i + 1 : null
      };
      (this.db.appointments ??= {})[a.id] = a;
      first ??= a;
    });
    this.notifyAppt(first!);
    this.pushAppt(provider.id, "appt_new", first!, this.seriesParams(series));
    return this.apptView(first!, uid);
  }

  /** Accept / Decline (V5, V24): a series is answered as a whole; Accept declines the clashes. */
  answerAppointment(uid: string, id: string, decision: "accept" | "decline"): AppointmentView {
    this.requireUser(uid);
    if (decision !== "accept" && decision !== "decline") throw new ServerError("bad_input");
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || a.providerId !== uid) throw new ServerError("not_found");
    if (a.status !== "requested") throw new ServerError("illegal_transition");
    if (!a.seriesId) {
      if (decision === "accept") {
        if (this.providerBusy(uid, a.startsAt, a.durationMin, a.id)) throw new ServerError("overlap");
        a.status = "accepted";
        a.answeredAt = this.now;
        this.pushAppt(a.clientId, "appt_accepted", a, {});
      } else {
        a.status = "declined";
        a.answeredAt = this.now;
        a.endedAt = this.now;
        this.pushAppt(a.clientId, "appt_declined", a, {});
      }
    } else {
      const s = this.db.series![a.seriesId];
      const declined: number[] = [];
      let accepted = 0;
      for (const o of this.occurrences(a.seriesId).filter((x) => x.status === "requested")) {
        o.answeredAt = this.now;
        if (decision === "accept" && !this.providerBusy(uid, o.startsAt, o.durationMin, o.id)) {
          o.status = "accepted";
          accepted++;
        } else {
          o.status = "declined";
          o.endedAt = this.now;
          if (decision === "accept") declined.push(o.startsAt);
        }
      }
      s.status = "answered";
      s.answeredAt = this.now;
      this.pushAppt(a.clientId, accepted > 0 ? "appt_accepted" : "appt_declined", a, { ...this.seriesParams(s), accepted, declined });
    }
    this.notifyAppt(a);
    return this.apptView(a, uid);
  }

  /** Cancel (FR-102, V25): this one or all remaining; rides follow; the other party is told once. */
  cancelAppointment(uid: string, id: string, reason?: string | null, scope: "one" | "series" = "one"): void {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || (a.clientId !== uid && a.providerId !== uid)) throw new ServerError("not_found");
    const who = a.clientId === uid ? "client" : "provider";
    const allowed = (x: ApptRow) => x.status === "accepted" || (x.status === "requested" && who === "client");
    const series = scope === "series" && !!a.seriesId;
    let targets: ApptRow[];
    if (series) {
      targets = this.occurrences(a.seriesId!).filter((x) => x.startsAt > this.now && allowed(x));
      if (!targets.length) throw new ServerError("illegal_transition");
    } else {
      if (this.now >= a.startsAt || !allowed(a)) throw new ServerError("illegal_transition");
      targets = [a];
    }
    const why = String(reason ?? "").trim().slice(0, 60) || null;
    for (const x of targets) {
      x.status = "cancelled";
      x.endedAt = this.now;
      x.cancelledBy = who;
      x.cancelReason = why;
      this.notifyAppt(x);
    }
    this.cascadeRides(targets.map((x) => x.id));
    if (a.seriesId && !this.occurrences(a.seriesId).some((x) => (x.status === "requested" || x.status === "accepted") && x.startsAt > this.now)) {
      const s = this.db.series![a.seriesId];
      if (s.status === "requested" || s.status === "answered") s.status = "cancelled";
    }
    this.pushAppt(who === "client" ? a.providerId : a.clientId, "appt_cancelled", a, {
      who: this.db.users[uid]?.nickname ?? "",
      ...(series ? { from: targets[0].startsAt, left: targets.length } : {})
    });
  }

  getAppointment(uid: string, id: string): AppointmentView {
    this.requireMember(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || (a.clientId !== uid && a.providerId !== uid)) throw new ServerError("not_found");
    return this.apptView(a, uid);
  }

  /** A series ride template (V26): the caller is the passenger; bookings within the horizon at once. */
  setRideTemplate(uid: string, seriesId: string, t: RideTemplateInput): AppointmentView {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "driver") throw new ServerError("driver_only");
    this.sweep();
    const s = this.db.series?.[seriesId];
    if (!s || (s.clientId !== uid && s.providerId !== uid)) throw new ServerError("not_found");
    if (s.status !== "answered" || !this.occurrences(s.id).some((x) => x.status === "accepted")) throw new ServerError("not_accepted");
    if (t.leg !== "there" && t.leg !== "back") throw new ServerError("bad_leg");
    if (
      !Number.isFinite(t.offsetMin) ||
      !Number.isFinite(t.estKm) ||
      !Number.isFinite(t.estMin) ||
      t.estKm <= 0 ||
      t.estMin < 0 ||
      !t.pickup ||
      !t.dropoff ||
      !isValidLatLng(t.pickup) ||
      !isValidLatLng(t.dropoff) ||
      !String(t.pickup.label ?? "").trim() ||
      !String(t.dropoff.label ?? "").trim()
    )
      throw new ServerError("bad_input");
    const off = Math.trunc(t.offsetMin);
    if ((t.leg === "there" && (off < -1440 || off > -1)) || (t.leg === "back" && (off < -s.durationMin || off > 1440))) throw new ServerError("bad_time");
    const role: PartyRole = s.clientId === uid ? "client" : "provider";
    s.rideTemplates = [
      ...s.rideTemplates.filter((x) => !(x.passenger === role && x.leg === t.leg)),
      { passenger: role, leg: t.leg, pickup: cleanPlace(t.pickup), dropoff: cleanPlace(t.dropoff), offsetMin: off, estKm: t.estKm, estMin: t.estMin, fareIsEstimate: !!t.fareIsEstimate }
    ];
    this.materialize(s.id);
    const occ = this.occurrences(s.id);
    const a = occ.find((x) => (x.status === "requested" || x.status === "accepted") && x.startsAt > this.now) ?? occ[occ.length - 1];
    this.pushAppt(role === "client" ? s.providerId : s.clientId, "appt_ride_added", a, {
      ...this.seriesParams(s),
      leg: t.leg,
      who: this.db.users[uid]?.nickname ?? "",
      repeat: true
    });
    this.notifyAppt(a);
    return this.apptView(a, uid);
  }

  /** No more rides for this series (the caller's template for a leg); existing bookings stay. */
  dropRideTemplate(uid: string, seriesId: string, leg: Leg): void {
    this.requireUser(uid);
    const s = this.db.series?.[seriesId];
    if (!s || (s.clientId !== uid && s.providerId !== uid)) throw new ServerError("not_found");
    const role: PartyRole = s.clientId === uid ? "client" : "provider";
    s.rideTemplates = s.rideTemplates.filter((x) => !(x.passenger === role && x.leg === leg));
    this.effects.notify.add(s.clientId);
    this.effects.notify.add(s.providerId);
  }

  /** Planned (V17): upcoming appointments and rides of both roles. */
  planned(uid: string): Planned {
    this.requireMember(uid);
    this.sweep();
    return {
      appointments: Object.values(this.db.appointments ?? {})
        .filter((a) => (a.clientId === uid || a.providerId === uid) && (a.status === "requested" || a.status === "accepted") && this.endOf(a) > this.now)
        .sort((x, y) => x.startsAt - y.startsAt)
        .map((a) => this.apptView(a, uid)),
      rides: Object.values(this.db.rides)
        .filter((r) => (r.riderId === uid || r.driverId === uid) && (r.status === "scheduled" || isActive(r.status)))
        .sort((x, y) => (x.scheduledFor ?? x.requestedAt) - (y.scheduledFor ?? y.requestedAt))
        .map((r) => this.rideView(r, uid))
    };
  }

  /** History (FR-133): finished appointments and rides, the last 50 of each, newest first. */
  timeline(uid: string): HistoryItem[] {
    this.requireMember(uid);
    const appts: HistoryItem[] = Object.values(this.db.appointments ?? {})
      .filter((a) => (a.clientId === uid || a.providerId === uid) && ["done", "declined", "cancelled", "expired"].includes(a.status))
      .sort((x, y) => y.startsAt - x.startsAt)
      .slice(0, SERVER.historyLimit)
      .map((a) => ({ kind: "appointment", at: a.startsAt, appointment: this.apptView(a, uid) }));
    const rides: HistoryItem[] = Object.values(this.db.rides)
      .filter((r) => (r.riderId === uid || r.driverId === uid) && (r.status === "completed" || r.status === "cancelled" || r.status === "expired"))
      .sort((x, y) => (y.scheduledFor ?? y.requestedAt) - (x.scheduledFor ?? x.requestedAt))
      .slice(0, SERVER.historyLimit)
      .map((r) => ({ kind: "ride", at: r.scheduledFor ?? r.requestedAt, ride: this.rideView(r, uid) }));
    return [...appts, ...rides].sort((x, y) => y.at - x.at);
  }

  /** Rate a done appointment once within 24 h (FR-106). */
  rateAppointment(uid: string, id: string, stars: number, comment: string): void {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || (a.clientId !== uid && a.providerId !== uid)) throw new ServerError("not_found");
    if (a.status !== "done") throw new ServerError("illegal_transition");
    if (this.now > (a.endedAt ?? this.endOf(a)) + SERVER.apptRatingWindowS * 1000) throw new ServerError("window_closed");
    const s = Math.round(stars);
    if (!Number.isFinite(stars) || s < 1 || s > 5) throw new ServerError("bad_input");
    if (this.db.ratings.some((x) => x.appointmentId === id && x.fromUser === uid)) throw new ServerError("already_rated");
    this.db.ratings.push({ appointmentId: id, fromUser: uid, toUser: a.clientId === uid ? a.providerId : a.clientId, stars: s, comment: String(comment ?? "").trim().slice(0, 140), createdAt: this.now });
    this.notifyAppt(a);
  }

  // ---------- 2.0: internals ----------

  private service(id: string): CatalogEntry | null {
    return this.cfg.services.find((e) => e.id === id) ?? null;
  }

  private serviceName(id: string, lang: Lang): string {
    const e = this.service(id);
    return e ? e.name[lang] || e.name.en : id;
  }

  /** What a person offers: a master profile's preset, otherwise their own toggles. */
  private offersOf(uid: string): string[] {
    const linked = this.linkedMaster(uid);
    if (linked) return this.masterDef(linked)?.offers ?? [];
    return this.db.users[uid]?.offers ?? [];
  }

  /** The random public id (made once, on first use). */
  private publicIdOf(uid: string): string | null {
    const u = this.db.users[uid];
    if (!u || u.deleted) return null;
    if (!u.publicId) u.publicId = randomPublicId();
    return u.publicId;
  }

  private publicParty(uid: string): PublicProvider {
    return { ...this.party(uid), publicId: this.publicIdOf(uid) };
  }

  private occurrences(seriesId: string): ApptRow[] {
    return Object.values(this.db.appointments ?? {})
      .filter((a) => a.seriesId === seriesId)
      .sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
  }

  private endOf(a: { startsAt: number; durationMin: number }): number {
    return a.startsAt + a.durationMin * 60_000;
  }

  /** The provider is busy then: an accepted appointment or a booked ride taken as driver overlaps. */
  private providerBusy(uid: string, start: number, min: number, except: string): boolean {
    const end = start + min * 60_000;
    return (
      Object.values(this.db.appointments ?? {}).some((x) => x.providerId === uid && x.status === "accepted" && x.id !== except && x.startsAt < end && start < this.endOf(x)) ||
      Object.values(this.db.rides).some(
        (r) =>
          r.driverId === uid &&
          r.scheduledFor != null &&
          (r.status === "scheduled" || r.status === "accepted" || r.status === "arrived" || r.status === "in_progress") &&
          r.scheduledFor < end &&
          start < r.scheduledFor + Math.max(r.estMin, 1) * 60_000
      )
    );
  }

  /** Cancelled appointments cancel their rides not under way yet; drivers who took one are told. */
  private cascadeRides(ids: string[]): void {
    for (const r of Object.values(this.db.rides)) {
      if (!r.appointmentId || !ids.includes(r.appointmentId)) continue;
      if (!(r.status === "scheduled" || r.status === "requested" || r.status === "accepted" || r.status === "arrived")) continue;
      if (r.driverId) this.pushTo(r.driverId, "booking_cancelled", r, { pickup: r.pickup.label });
      this.endRide(r, "cancelled", "system", "appointment_cancelled");
    }
  }

  /** Bookings from a series' ride templates for occurrences within the booking horizon (V26). */
  private materialize(seriesId: string): void {
    const s = this.db.series?.[seriesId];
    if (!s) return;
    const { minLeadMin, maxDays } = this.cfg.booking;
    for (const t of s.rideTemplates) {
      const user = t.passenger === "client" ? s.clientId : s.providerId;
      for (const a of this.occurrences(s.id).filter((x) => x.status === "accepted" && x.startsAt > this.now)) {
        const at = (t.leg === "there" ? a.startsAt : this.endOf(a)) + t.offsetMin * 60_000;
        if (at < this.now + minLeadMin * 60_000 || at > this.now + maxDays * 86_400_000) continue;
        if (Object.values(this.db.rides).some((r) => r.appointmentId === a.id && r.riderId === user && r.leg === t.leg)) continue;
        try {
          this.bookFor(user, { pickup: t.pickup, dropoff: t.dropoff, estKm: t.estKm, estMin: t.estMin, fareIsEstimate: t.fareIsEstimate, scheduledFor: at }, a.id, t.leg, true);
        } catch {
          /* no room (open bookings) or no longer allowed: the next run tries again */
        }
      }
    }
    s.templatesAt = this.now;
  }

  /** Appointments of the sweep: expiry, done, reminders, template rides (V6, V7, V24, V26). */
  private sweepAppointments(): void {
    const all = this.db.appointments;
    if (!all) return;
    // An unanswered series expires as a whole when its first occurrence starts (one notification).
    for (const s of Object.values(this.db.series ?? {})) {
      if (s.status !== "requested" || s.firstStart > this.now) continue;
      const occ = this.occurrences(s.id);
      for (const a of occ)
        if (a.status === "requested") {
          a.status = "expired";
          a.endedAt = this.now;
          this.notifyAppt(a);
        }
      s.status = "expired";
      if (occ[0]) this.pushAppt(s.clientId, "appt_expired", occ[0], this.seriesParams(s));
    }
    for (const a of Object.values(all)) {
      if (a.status === "requested" && !a.seriesId && a.startsAt <= this.now) {
        a.status = "expired";
        a.endedAt = this.now;
        this.notifyAppt(a);
        this.pushAppt(a.clientId, "appt_expired", a, {});
      } else if (a.status === "accepted" && this.endOf(a) <= this.now) {
        a.status = "done";
        a.endedAt = this.endOf(a);
        this.notifyAppt(a);
      }
    }
    // Reminders: once per slot for both parties; none for a moment that had passed at the request.
    for (const a of Object.values(all)) {
      if ((a.status !== "requested" && a.status !== "accepted") || a.startsAt <= this.now) continue;
      for (const slot of this.cfg.appointment.reminderMin) {
        const moment = a.startsAt - slot * 60_000;
        if (this.now < moment || a.requestedAt > moment || a.reminded.includes(slot)) continue;
        a.reminded.push(slot);
        this.pushAppt(a.clientId, "appt_reminder", a, this.reminderParams(a, slot, "client"));
        this.pushAppt(a.providerId, "appt_reminder", a, this.reminderParams(a, slot, "provider"));
      }
    }
    // Series rides: occurrences that came within the booking horizon (once a day per series).
    for (const s of Object.values(this.db.series ?? {}))
      if (s.status === "answered" && s.rideTemplates.length && (s.templatesAt === null || s.templatesAt < this.now - 86_400_000)) this.materialize(s.id);
  }

  private reminderParams(a: ApptRow, slot: number, role: PartyRole): Partial<PushParams> {
    return {
      lead: slot,
      role,
      other: this.db.users[role === "client" ? a.providerId : a.clientId]?.nickname ?? "",
      status: a.status === "accepted" ? "confirmed" : role === "client" ? "waiting" : "answer",
      rides: this.attached(a, null).map((x) => ({ leg: x.leg, status: x.status, driver: x.driver?.nickname ?? null }))
    };
  }

  private seriesParams(s: SeriesRow | null): Partial<PushParams> {
    return s ? { rule: s.rule, count: s.count, first: s.firstStart, last: s.until } : {};
  }

  /** An appointment notification in the recipient's language (service name included). */
  private pushAppt(userId: string, kind: PushKind, a: ApptRow, extra: Partial<PushParams>): void {
    if (!this.isMember(userId)) return;
    const lang = this.db.users[userId]?.language ?? "en";
    this.effects.push.push({
      userId,
      kind,
      rideId: null,
      appointmentId: a.id,
      params: {
        serviceId: a.serviceId,
        service: this.serviceName(a.serviceId, lang),
        at: a.startsAt,
        end: this.endOf(a),
        client: this.db.users[a.clientId]?.nickname ?? "",
        provider: this.db.users[a.providerId]?.nickname ?? "",
        place: a.place?.label ?? "",
        ...extra
      }
    });
  }

  private notifyAppt(a: ApptRow): void {
    this.effects.notify.add(a.clientId);
    this.effects.notify.add(a.providerId);
  }

  /** A ride that is part of an appointment changed: both parties refetch; news reaches the other party (V12). */
  private attachedChanged(r: RideRow): void {
    if (!r.appointmentId) return;
    const a = this.db.appointments?.[r.appointmentId];
    if (!a) return;
    this.notifyAppt(a);
    const before = r.apptSummary ?? null;
    const now = rideSummary(r);
    r.apptSummary = now;
    if (!(before === "pending" || before === "confirmed") || now === before || !(now === "pending" || now === "confirmed" || now === "failed")) return;
    const kind: PushKind = now === "confirmed" ? "appt_ride_taken" : now === "pending" ? "appt_ride_lost" : "appt_ride_failed";
    const params = { leg: r.leg ?? undefined, time: r.scheduledFor ?? null, driver: r.driverId ? this.db.users[r.driverId]?.nickname ?? "" : "" };
    this.pushAppt(r.riderId === a.clientId ? a.providerId : a.clientId, kind, a, params);
    if (now === "failed") this.pushAppt(r.riderId, kind, a, params);
  }

  /** The rides of an appointment as the viewer may see them (FR-114): latest per passenger and leg. */
  private attached(a: ApptRow, viewer: string | null): AttachedRide[] {
    const latest = new Map<string, RideRow>();
    for (const r of Object.values(this.db.rides)) {
      if (r.appointmentId !== a.id || !r.leg || rideSummary(r) === null) continue;
      const key = `${r.riderId}:${r.leg}`;
      const cur = latest.get(key);
      if (!cur || cur.requestedAt <= r.requestedAt) latest.set(key, r);
    }
    return [...latest.values()]
      .sort((x, y) => (x.scheduledFor ?? 0) - (y.scheduledFor ?? 0))
      .map((r) => ({
        rideId: r.id,
        leg: r.leg!,
        passenger: r.riderId === a.clientId ? "client" : "provider",
        mine: r.riderId === viewer,
        scheduledFor: r.scheduledFor ?? null,
        status: rideSummary(r)!,
        driver: r.driverId ? { nickname: this.db.users[r.driverId]?.nickname ?? "Deleted user", icon: this.masterOf(r.driverId)?.icon ?? null } : null,
        ...(r.riderId === viewer ? { pickup: { ...r.pickup }, dropoff: { ...r.dropoff }, fare: r.fare, currency: r.currency } : {})
      }));
  }

  private apptView(a: ApptRow, viewer: string): AppointmentView {
    const e = this.service(a.serviceId);
    const s = a.seriesId ? this.db.series?.[a.seriesId] ?? null : null;
    const role: PartyRole = a.clientId === viewer ? "client" : "provider";
    const occ = s ? this.occurrences(s.id) : [];
    return {
      id: a.id,
      status: a.status,
      role,
      serviceId: a.serviceId,
      service: e ? { name: { ...e.name }, icon: e.icon } : null,
      startsAt: a.startsAt,
      durationMin: a.durationMin,
      endsAt: this.endOf(a),
      place: a.place ? { ...a.place } : null,
      note: a.note,
      price: a.price,
      currency: a.currency,
      client: this.publicParty(a.clientId),
      provider: this.publicParty(a.providerId),
      requestedAt: a.requestedAt,
      answeredAt: a.answeredAt,
      endedAt: a.endedAt,
      cancelledBy: a.cancelledBy,
      cancelReason: a.cancelReason,
      rides: this.attached(a, viewer),
      reminders: [...a.reminded],
      myRating: this.db.ratings.find((x) => x.appointmentId === a.id && x.fromUser === viewer)?.stars ?? null,
      series: s
        ? {
            id: s.id,
            rule: s.rule,
            seq: a.seq ?? 1,
            count: s.count,
            until: s.until,
            status: s.status,
            remaining: occ.filter((x) => (x.status === "requested" || x.status === "accepted") && x.startsAt > this.now).length,
            declined: occ.filter((x) => x.status === "declined").map((x) => x.startsAt).sort((x, y) => x - y),
            gaps: occ.filter((x) => x.status === "declined" || x.status === "cancelled").map((x) => x.startsAt).sort((x, y) => x - y),
            starts: occ.map((x) => x.startsAt),
            rideTemplates: s.rideTemplates.map((t) =>
              t.passenger === role ? { ...t, pickup: { ...t.pickup }, dropoff: { ...t.dropoff }, mine: true } : { passenger: t.passenger, leg: t.leg, offsetMin: t.offsetMin, mine: false }
            ),
            ics: null
          }
        : null,
      calendar: { google: null, ics: null }
    };
  }

  // ---------- internals ----------

  private activeRideOf(uid: string): RideRow | null {
    return Object.values(this.db.rides).find((r) => isActive(r.status) && (r.riderId === uid || r.driverId === uid)) ?? null;
  }

  /** Any driver action proves the session is alive (not only heartbeats). */
  private touchDriver(uid: string): void {
    const d = this.db.drivers[uid];
    if (d?.online) d.lastSeen = this.now;
  }

  private activeDriverRideOf(uid: string): RideRow | null {
    return Object.values(this.db.rides).find((r) => r.driverId === uid && (r.status === "accepted" || r.status === "arrived" || r.status === "in_progress")) ?? null;
  }

  /** Explicitly offline (not the silent-app sweep): standby ends too. */
  private goOffline(uid: string): void {
    const d = this.db.drivers[uid];
    if (d) {
      d.online = false;
      d.standbyUntil = null;
    }
    for (const o of Object.values(this.db.offers))
      if (o.driverId === uid && (o.status === "offered" || o.status === "queued")) this.closeOffer(o, "withdrawn");
  }

  private pullOffers(uid: string, pos: LatLng): void {
    const open = Object.values(this.db.rides)
      .filter((r) => r.status === "requested" && r.riderId !== uid && !r.excluded.includes(uid))
      .sort((a, b) => a.requestedAt - b.requestedAt);
    for (const r of open) {
      // A card withdrawn for driver-side reasons (went offline, went silent, won another ride) is
      // offered again once the driver is eligible (§6 rule 4). A card the driver let lapse comes back
      // after the retry window (requests stay open long); a Decline holds until clearDecisions.
      const existing = Object.values(this.db.offers).find((o) => o.rideId === r.id && o.driverId === uid && o.round === r.round);
      if (existing && !this.reofferable(existing)) continue;
      const dist = haversineKm(pos, r.pickup);
      if (dist > this.cfg.dispatchRadiusKm) continue;
      const holding = Object.values(this.db.offers).some((o) => o.driverId === uid && o.status === "offered");
      if (existing) {
        existing.status = holding ? "queued" : "offered";
        existing.createdAt = this.now;
        existing.offeredAt = holding ? null : this.now;
        existing.decidedAt = null;
        existing.driverDistanceKm = round1(dist);
        this.effects.notify.add(uid);
        continue;
      }
      const o: OfferRow = {
        id: this.nextId("o"),
        rideId: r.id,
        driverId: uid,
        round: r.round,
        status: holding ? "queued" : "offered",
        createdAt: this.now,
        offeredAt: holding ? null : this.now,
        decidedAt: null,
        driverDistanceKm: round1(dist)
      };
      this.db.offers[o.id] = o;
      r.notifiedCount++;
      this.effects.notify.add(uid);
      this.effects.notify.add(r.riderId);
    }
  }

  /** Declined / lapsed cards on still-open requests become offerable again (same round). */
  private clearDecisions(uid: string): void {
    for (const o of Object.values(this.db.offers)) {
      if (o.driverId !== uid || (o.status !== "declined" && o.status !== "timed_out")) continue;
      const r = this.db.rides[o.rideId];
      if (r && r.status === "requested" && r.round === o.round) {
        o.status = "withdrawn";
        o.decidedAt = this.now;
      }
    }
  }

  /** Open requests this driver could be offered, within the dispatch radius of `pos`. */
  private countNearby(uid: string, pos: LatLng): number {
    return Object.values(this.db.rides).filter(
      (r) => r.status === "requested" && r.riderId !== uid && !r.excluded.includes(uid) && haversineKm(pos, r.pickup) <= this.cfg.dispatchRadiusKm
    ).length;
  }

  private reofferable(o: OfferRow): boolean {
    if (o.status === "withdrawn") return true;
    const retryS = this.cfg.timers.retryS;
    return o.status === "timed_out" && retryS > 0 && o.decidedAt !== null && this.now >= o.decidedAt + retryS * 1000;
  }

  /** Close an offer and, if the driver now holds no card, promote their oldest queued one. */
  private closeOffer(o: OfferRow, status: OfferStatus): void {
    const wasOffered = o.status === "offered";
    o.status = status;
    o.decidedAt = this.now;
    this.effects.notify.add(o.driverId);
    if (wasOffered) this.promote(o.driverId);
  }

  private requestedAtOf(o: OfferRow): number {
    return this.db.rides[o.rideId]?.requestedAt ?? 0;
  }

  private promote(driverId: string): void {
    if (Object.values(this.db.offers).some((o) => o.driverId === driverId && o.status === "offered")) return;
    const queued = Object.values(this.db.offers)
      .filter((o) => o.driverId === driverId && o.status === "queued")
      // Cards (re)activated in one call share createdAt; SQL orders them by request time then.
      .sort((a, b) => a.createdAt - b.createdAt || this.requestedAtOf(a) - this.requestedAtOf(b));
    for (const q of queued) {
      const r = this.db.rides[q.rideId];
      if (r && r.status === "requested" && r.round === q.round) {
        q.status = "offered";
        q.offeredAt = this.now;
        this.effects.notify.add(driverId);
        return;
      }
      q.status = "withdrawn";
      q.decidedAt = this.now;
    }
  }

  private withdrawRideOffers(rideId: string): void {
    for (const o of Object.values(this.db.offers))
      if (o.rideId === rideId && (o.status === "offered" || o.status === "queued")) this.closeOffer(o, "withdrawn");
  }

  private endRide(r: RideRow, status: "cancelled" | "expired", by: CancelledBy, reason: string | null): void {
    r.status = status;
    r.endedAt = this.now;
    r.cancelledBy = by;
    r.cancelReason = reason;
    this.withdrawRideOffers(r.id);
    this.notifyRide(r);
  }

  /** accepted/arrived → requested without this driver; expiry restarts; fare unchanged (FR-051). */
  private redispatch(r: RideRow, reason: string): void {
    const driverId = r.driverId;
    this.effects.notify.add(r.riderId);
    if (driverId) {
      this.effects.notify.add(driverId);
      if (!r.excluded.includes(driverId)) r.excluded.push(driverId);
    }
    r.status = "requested";
    r.driverId = null;
    r.acceptedAt = null;
    r.arrivedAt = null;
    r.round++;
    r.redispatchCount++;
    r.dispatchStartedAt = this.now;
    r.notifiedCount = 0;
    r.cancelReason = reason;
    this.effects.pingDrivers = true;
    this.pushStandby(r);
    this.attachedChanged(r);
  }

  private notifyRide(r: RideRow): void {
    this.effects.notify.add(r.riderId);
    if (r.driverId) this.effects.notify.add(r.driverId);
    this.attachedChanged(r);
  }

  private pendingReceipt(uid: string): RideView | null {
    const rated = new Set(this.db.ratings.filter((x) => x.fromUser === uid).map((x) => x.rideId));
    const r = Object.values(this.db.rides)
      .filter(
        (x) =>
          x.status === "completed" &&
          (x.riderId === uid || x.driverId === uid) &&
          x.endedAt !== null &&
          this.now - x.endedAt < SERVER.pendingReceiptS * 1000 &&
          !rated.has(x.id)
      )
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
    return r ? this.rideView(r, uid) : null;
  }

  private rating(uid: string): RatingSummary {
    const stars = this.db.ratings
      .filter((x) => x.toUser === uid)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((x) => x.stars);
    return summarizeRatings(stars);
  }

  private party(uid: string) {
    const u = this.db.users[uid];
    return { nickname: u ? u.nickname : "Deleted user", rating: this.rating(uid), icon: this.masterOf(uid)?.icon ?? null };
  }

  /** FR-044: the vehicle/plate is visible to the rider only once a driver is assigned. */
  private rideView(r: RideRow, viewer: string): RideView {
    const role = r.riderId === viewer ? "rider" : "driver";
    const mine = this.db.ratings.find((x) => x.rideId === r.id && x.fromUser === viewer);
    return {
      id: r.id,
      status: r.status,
      role,
      pickup: { ...r.pickup },
      dropoff: { ...r.dropoff },
      estKm: r.estKm,
      estMin: r.estMin,
      fare: r.fare,
      currency: r.currency,
      fareIsEstimate: r.fareIsEstimate,
      actualKm: r.actualKm,
      actualMin: r.actualMin,
      requestedAt: r.requestedAt,
      dispatchStartedAt: r.dispatchStartedAt,
      acceptedAt: r.acceptedAt,
      arrivedAt: r.arrivedAt,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      cancelledBy: r.cancelledBy,
      cancelReason: r.cancelReason,
      paid: r.paid,
      collected: r.collected,
      notifiedCount: r.notifiedCount,
      redispatchCount: r.redispatchCount,
      round: r.round,
      expiresAt: this.expiresAt(r),
      scheduledFor: r.scheduledFor ?? null,
      rider: this.party(r.riderId),
      driver: r.driverId ? { ...this.party(r.driverId), vehicle: this.db.vehicles[r.driverId] ?? null } : null,
      myRating: mine ? mine.stars : null,
      // The appointment and leg are the rider's business only (FR-114).
      appointmentId: role === "rider" ? r.appointmentId ?? null : null,
      leg: role === "rider" ? r.leg ?? null : null,
      calendar: { google: null, ics: null }
    };
  }

  private offerView(o: OfferRow): OfferView {
    const r = this.db.rides[o.rideId];
    return {
      id: o.id,
      rideId: o.rideId,
      status: o.status,
      offeredAt: o.offeredAt ?? o.createdAt,
      driverDistanceKm: o.driverDistanceKm,
      pickup: { ...r.pickup },
      dropoff: { ...r.dropoff },
      estKm: r.estKm,
      estMin: r.estMin,
      fare: r.fare,
      currency: r.currency,
      fareIsEstimate: r.fareIsEstimate,
      rider: this.party(r.riderId)
    };
  }

  private nextId(prefix: string): string {
    this.db.seq++;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}${this.db.seq.toString(36)}${rand}`;
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** How an attached ride stands for its appointment (§7 rule 7); null = not shown (twin of siosia_ride_summary). */
export function rideSummary(r: Pick<RideRow, "status" | "driverId" | "cancelledBy" | "cancelReason">): AttachedStatus | null {
  if (r.status === "cancelled" && (r.cancelledBy === "rider" || r.cancelReason === "appointment_cancelled")) return null;
  if ((r.status === "scheduled" && !r.driverId) || r.status === "requested") return "pending";
  if (r.status === "scheduled" || r.status === "accepted" || r.status === "arrived" || r.status === "in_progress") return "confirmed";
  if (r.status === "completed") return "done";
  return "failed";
}

const ratingKey = (g: RatingRow) => (g.rideId ? `r:${g.rideId}` : `a:${g.appointmentId}`);

/** 12 URL-safe random characters (twin of the SQL default for profiles.public_id). */
function randomPublicId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 12; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => alphabet[b & 63]).join("");
}

function cleanPlace(p: Place): Place {
  return { lat: p.lat, lng: p.lng, label: String(p.label ?? "").slice(0, 120) };
}
