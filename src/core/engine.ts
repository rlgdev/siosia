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

import { DEFAULT_CONFIG, SERVER } from "./defaults";
import { computeFare } from "./fare";
import { haversineKm, isValidLatLng } from "./geo";
import { isActive } from "./lifecycle";
import { summarizeRatings } from "./rating";
import {
  ServerError,
  type DeploymentConfig,
  type DriverCancelReason,
  type Earnings,
  type LatLng,
  type Lang,
  type MyState,
  type OfferStatus,
  type OfferView,
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
  rideId: string;
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
}

/** Transfer codes: 8 characters without look-alikes (no I, O, 0, 1), shown as XXXX-XXXX. */
export const TRANSFER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const normalizeTransfer = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function emptyDb(): DbState {
  return { version: 1, seq: 0, users: {}, vehicles: {}, drivers: {}, members: {}, rides: {}, offers: {}, ratings: [], inviteFails: {} };
}

export interface EngineConfig extends DeploymentConfig {
  /** Plain invite code for the mock backend; null = no invite needed. (Supabase stores only a hash.) */
  inviteCode: string | null;
  /** Master profiles and their link tokens (mock only; Supabase stores token hashes). */
  masters?: MasterProfile[];
}

export interface Effects {
  /** Users whose state changed (→ realtime "changed" on topic user:<id>). */
  notify: Set<string>;
  /** A request opened or re-opened (→ data-less "ping" on topic "drivers"). */
  pingDrivers: boolean;
}

export const normalizeInvite = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

const NICK_RE = /^.{2,20}$/u;

export class Engine {
  readonly effects: Effects = { notify: new Set(), pingDrivers: false };
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
      : { id: uid, nickname: m.nickname, language: language === "pl" ? "pl" : "en", createdAt: this.now, riderCancels: 0, driverCancels: 0, lateCancels: 0, deleted: false, masterId: m.id };
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
    if (!old || !this.db.users[old] || this.db.users[old].deleted) {
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
      masterVehicle: (this.masterOf(uid)?.role === "driver" && this.masterOf(uid)?.vehicle) || null
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
      : { id: uid, nickname: nick, language: lang, createdAt: this.now, riderCancels: 0, driverCancels: 0, lateCancels: 0, deleted: false };
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
    this.goOffline(uid);
    delete this.db.vehicles[uid];
    delete this.db.members[uid];
    if (this.db.linkMembers) delete this.db.linkMembers[uid];
    this.db.users[uid] = { ...u, nickname: "Deleted user", deleted: true, masterId: null };
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
      pendingReceipt: this.pendingReceipt(uid)
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
      .filter((r) => r.riderId === uid || r.driverId === uid)
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
      excluded: []
    };
    this.db.rides[ride.id] = ride;
    this.effects.pingDrivers = true;
    this.effects.notify.add(uid);
    return this.rideView(ride, uid);
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
    if (r.status === "requested" || r.status === "accepted" || r.status === "arrived") {
      if (u) {
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
    if (r.status === "arrived" && reason === "no_show") {
      if (r.arrivedAt === null || this.now < r.arrivedAt + this.cfg.timers.noShowS * 1000)
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
      this.db.drivers[uid] = { online: true, lastSeen: this.now };
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
    if (to === "arrived") r.arrivedAt = this.now;
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
    const { offerS, expiryS } = this.cfg.timers;
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
      if (r.status === "requested" && this.now >= r.dispatchStartedAt + expiryS * 1000) {
        this.endRide(r, "expired", "system", null);
      } else if ((r.status === "accepted" || r.status === "arrived") && r.driverId) {
        const d = this.db.drivers[r.driverId];
        if (!d || this.now - d.lastSeen > SERVER.driverLostS * 1000) {
          const lost = r.driverId;
          if (d) d.online = false;
          this.redispatch(r, "driver_lost");
          this.effects.notify.add(lost);
        }
      }
    }
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

  private goOffline(uid: string): void {
    const d = this.db.drivers[uid];
    if (d) d.online = false;
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
  }

  private notifyRide(r: RideRow): void {
    this.effects.notify.add(r.riderId);
    if (r.driverId) this.effects.notify.add(r.driverId);
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
      expiresAt: r.dispatchStartedAt + this.cfg.timers.expiryS * 1000,
      rider: this.party(r.riderId),
      driver: r.driverId ? { ...this.party(r.driverId), vehicle: this.db.vehicles[r.driverId] ?? null } : null,
      myRating: mine ? mine.stars : null
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

function cleanPlace(p: Place): Place {
  return { lat: p.lat, lng: p.lng, label: String(p.label ?? "").slice(0, 120) };
}
