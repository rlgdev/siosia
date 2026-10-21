// SupabaseBackend — the real multi-device backend (D-02). All writes go through SECURITY DEFINER
// SQL functions (supabase/migrations/0001_siosia.sql) that enforce the lifecycle, the atomic claim
// and the access rules; tables are not readable or writable directly. Realtime uses PRIVATE
// channels authorised by policies on realtime.messages. Only the publishable key reaches the browser.

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CONFIG } from "../../core/defaults";
import {
  ServerError,
  type AppointmentView,
  type BookingInput,
  type CatalogItem,
  type DeploymentConfig,
  type HistoryItem,
  type Leg,
  type Place,
  type Planned,
  type RideTemplateInput,
  type ServiceRequestInput,
  type DriverPos,
  type DriverPresence,
  type Earnings,
  type Lang,
  type LatLng,
  type MyState,
  type OpenBooking,
  type Profile,
  type RideRequestInput,
  type RideView,
  type RiderPos,
  type Role,
  type ServerErrorCode,
  type SharingStop,
  type Vehicle
} from "../../core/types";
import type {
  AccountInfo,
  Backend,
  DriverPresenceHandle,
  OfferDecision,
  RideChannel,
  RideChannelHandlers,
  Unsub
} from "../types";

type RpcResult<T> = { ok?: T; error?: ServerErrorCode };
type ChannelOpts = Parameters<SupabaseClient["channel"]>[1];

const redirectTo = () => window.location.origin + window.location.pathname;
const randomKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const PING_TIMEOUT_MS = 5000;
const REBUILD_DELAY_MS = 2000;

// A database not upgraded to 2.1 yet (the migration is re-run on release) leaves out the 2.1
// fields: no open requests, no paint.
const withOpen = (a: AppointmentView): AppointmentView => ({ ...a, open: a.open ?? false });
const withOpenCount = (s: MyState): MyState => ({ ...s, openRequests: s.openRequests ?? 0 });
const withPaint = (v: Vehicle): Vehicle => ({ ...v, paint: v.paint ?? null });

/** Maps GoTrue errors to messages the user can act on (instead of a generic "unavailable"). */
function authError(e: { status?: number; code?: string; message: string }): ServerError {
  const code = e.code ?? "";
  if (e.status === 429 || /rate_limit/.test(code)) return new ServerError("rate_limited", e.message);
  if (["email_exists", "user_already_exists", "identity_already_exists"].includes(code)) return new ServerError("email_in_use", e.message);
  if (["otp_disabled", "user_not_found", "signup_disabled"].includes(code)) return new ServerError("no_account", e.message);
  if (["provider_disabled", "manual_linking_disabled", "email_provider_disabled"].includes(code) || /provider is not enabled/i.test(e.message))
    return new ServerError("not_enabled", e.message);
  if (e.status && e.status >= 400 && e.status < 500) return new ServerError("bad_input", e.message);
  return new ServerError("unavailable", e.message);
}

/**
 * A private channel that is rebuilt when the SERVER closes it (e.g. after a failed token refresh).
 * Our own close never triggers a rebuild. `setup` attaches listeners to each new instance.
 */
function resilientChannel(
  sb: SupabaseClient,
  topic: string,
  opts: ChannelOpts,
  setup: (ch: RealtimeChannel) => void,
  onSubscribed?: (ch: RealtimeChannel) => void
): { current: () => RealtimeChannel; close: () => void } {
  let closedByUs = false;
  let ch: RealtimeChannel;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const build = () => {
    const mine = sb.channel(topic, opts);
    ch = mine;
    setup(mine);
    mine.subscribe((status) => {
      if (closedByUs || ch !== mine) return;
      if (status === "SUBSCRIBED") onSubscribed?.(mine);
      if (status === "CLOSED") timer = setTimeout(() => !closedByUs && build(), REBUILD_DELAY_MS);
    });
  };
  build();
  return {
    current: () => ch,
    close: () => {
      closedByUs = true;
      if (timer) clearTimeout(timer);
      void ch.untrack().catch(() => {});
      void sb.removeChannel(ch);
    }
  };
}

export class SupabaseBackend implements Backend {
  readonly kind = "supabase" as const;
  readonly needsInvite = true;
  private readonly sb: SupabaseClient;
  private uid = "";
  private drivers: DriversChannel | null = null;

  constructor(url: string, key: string) {
    this.sb = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "siosia.auth" },
      realtime: { params: { eventsPerSecond: 10 } }
    });
  }

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) throw new ServerError("unavailable", error.message);
    const res = data as RpcResult<T> | null;
    if (res && typeof res === "object" && "error" in res && res.error) throw new ServerError(res.error);
    return (res && typeof res === "object" && "ok" in res ? res.ok : res) as T;
  }

  async start(): Promise<string> {
    const { data } = await this.sb.auth.getSession();
    let session = data.session;
    if (!session) {
      const { data: signIn, error } = await this.sb.auth.signInAnonymously();
      if (error || !signIn.session) throw new ServerError("unavailable", error?.message ?? "Anonymous sign-in failed");
      session = signIn.session;
    }
    this.uid = session.user.id;
    await this.sb.realtime.setAuth(session.access_token);
    this.sb.auth.onAuthStateChange((_evt, s) => {
      const next = s?.user?.id ?? null;
      // Another tab signed in as someone else, or signed out: everything here belongs to the old
      // user (profile, mode, channels), so start over rather than act on a stale identity.
      if (next !== this.uid) {
        if (typeof location !== "undefined") location.reload();
        return;
      }
      if (s?.access_token) void this.sb.realtime.setAuth(s.access_token);
    });
    return this.uid;
  }

  /** D-04: reachability within 5 s, whatever the client does first (e.g. a token refresh). */
  async ping(): Promise<void> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new ServerError("unavailable", "timeout"));
      }, PING_TIMEOUT_MS);
    });
    const call = (async () => {
      const { error } = await this.sb.rpc("siosia_config").abortSignal(ctrl.signal);
      if (error) throw new ServerError("unavailable", error.message);
    })();
    try {
      await Promise.race([call, deadline]);
    } catch (e) {
      throw e instanceof ServerError ? e : new ServerError("unavailable", String(e));
    } finally {
      if (timer) clearTimeout(timer);
      call.catch(() => {});
    }
  }

  async getConfig() {
    const c = await this.rpc<DeploymentConfig>("siosia_config");
    // A database not upgraded to 2.0 yet: the catalog falls back to rides only.
    return {
      ...c,
      booking: { ...DEFAULT_CONFIG.booking, ...(c.booking ?? {}) },
      services: c.services ?? DEFAULT_CONFIG.services.filter((e) => e.kind === "ride"),
      appointment: c.appointment ?? DEFAULT_CONFIG.appointment,
      calendarUrl: c.calendarUrl ?? null
    };
  }
  isMember(deviceId: string) {
    return this.rpc<boolean>("siosia_is_member", { p_device: deviceId });
  }
  async join(code: string, deviceId: string) {
    await this.rpc("siosia_join", { p_code: code, p_device: deviceId });
  }
  bookRide(input: BookingInput) {
    const args: Record<string, unknown> = {
      p_pickup: input.pickup,
      p_dropoff: input.dropoff,
      p_est_km: input.estKm,
      p_est_min: input.estMin,
      p_fare_is_estimate: input.fareIsEstimate,
      p_scheduled_for: new Date(input.scheduledFor).toISOString()
    };
    // 2.0 overload (appointment + leg); the v1 signature stays for plain bookings.
    if (input.appointmentId) Object.assign(args, { p_appointment: input.appointmentId, p_leg: input.leg ?? null });
    return this.rpc<RideView>("siosia_book_ride", args);
  }
  bookings() {
    return this.rpc<RideView[]>("siosia_bookings");
  }
  openBookings(pos: LatLng | null) {
    return this.rpc<OpenBooking[]>("siosia_open_bookings", { p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
  }
  claimBooking(rideId: string) {
    return this.rpc<"won">("siosia_claim_booking", { p_ride: rideId });
  }
  async releaseBooking(rideId: string) {
    await this.rpc("siosia_release_booking", { p_ride: rideId });
  }
  async savePush(sub: { endpoint: string; p256dh: string; auth: string }) {
    await this.rpc("siosia_save_push", { p_endpoint: sub.endpoint, p_p256dh: sub.p256dh, p_auth: sub.auth });
  }
  async deletePush(endpoint: string) {
    await this.rpc("siosia_delete_push", { p_endpoint: endpoint });
  }
  createTransfer() {
    return this.rpc<{ code: string; expiresAt: number }>("siosia_create_transfer");
  }
  redeemTransfer(code: string, deviceId: string, replace = false) {
    return this.rpc<Profile>("siosia_redeem_transfer", { p_code: code, p_device: deviceId, p_replace: replace });
  }
  joinMaster(token: string, deviceId: string, language: Lang, replace = false) {
    return this.rpc<Profile>("siosia_join_master", { p_token: token, p_device: deviceId, p_language: language, p_replace: replace });
  }
  getProfile() {
    return this.rpc<Profile | null>("siosia_get_profile");
  }
  saveProfile(nickname: string, language: Lang) {
    return this.rpc<Profile>("siosia_save_profile", { p_nickname: nickname, p_language: language });
  }
  async getVehicle() {
    const v = await this.rpc<Vehicle | null>("siosia_get_vehicle");
    return v && withPaint(v);
  }
  async saveVehicle(v: Vehicle) {
    // The paint stays as it is (set with setCarColour).
    const saved = await this.rpc<Vehicle>("siosia_save_vehicle", {
      p_make: v.make,
      p_model: v.model,
      p_colour: v.colour,
      p_plate: v.plate,
      p_seats: v.seats
    });
    return withPaint(saved);
  }
  async setCarColour(colour: string, paint: string) {
    return withPaint(await this.rpc<Vehicle>("siosia_set_car_colour", { p_colour: colour, p_paint: paint }));
  }
  async deleteProfile() {
    await this.rpc("siosia_delete_profile");
  }
  async myState() {
    return withOpenCount(await this.rpc<MyState>("siosia_my_state"));
  }
  getRide(rideId: string) {
    return this.rpc<RideView>("siosia_get_ride", { p_ride: rideId });
  }
  history() {
    return this.rpc<RideView[]>("siosia_history");
  }
  earnings() {
    return this.rpc<Earnings>("siosia_earnings");
  }
  requestRide(input: RideRequestInput) {
    return this.rpc<RideView>("siosia_request_ride", {
      p_pickup: input.pickup,
      p_dropoff: input.dropoff,
      p_est_km: input.estKm,
      p_est_min: input.estMin,
      p_fare_is_estimate: input.fareIsEstimate
    });
  }
  async cancelRide(rideId: string, reason?: string) {
    await this.rpc("siosia_cancel_ride", { p_ride: rideId, p_reason: reason ?? null });
  }
  async setOnline(online: boolean) {
    await this.rpc("siosia_set_online", { p_online: online });
    // Realtime authorisation is evaluated on join: re-join "drivers" so presence tracking is allowed.
    if (online) this.drivers?.rebuild();
  }
  async heartbeat(pos: LatLng | null) {
    return withOpenCount(await this.rpc<MyState>("siosia_heartbeat", { p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null }));
  }
  async refreshOffers(pos: LatLng) {
    return withOpenCount(await this.rpc<MyState>("siosia_refresh_offers", { p_lat: pos.lat, p_lng: pos.lng }));
  }
  decideOffer(offerId: string, decision: OfferDecision) {
    return this.rpc<"won" | "ok">("siosia_decide_offer", { p_offer: offerId, p_decision: decision });
  }
  advance(rideId: string, to: "arrived" | "in_progress" | "completed", actualKm?: number) {
    return this.rpc<RideView>("siosia_advance", { p_ride: rideId, p_to: to, p_actual_km: actualKm ?? null });
  }
  async markPaid(rideId: string) {
    await this.rpc("siosia_mark_paid", { p_ride: rideId });
  }
  async markCollected(rideId: string) {
    await this.rpc("siosia_mark_collected", { p_ride: rideId });
  }
  async rate(rideId: string, stars: number, comment: string) {
    await this.rpc("siosia_rate", { p_ride: rideId, p_stars: stars, p_comment: comment });
  }

  // ---------- 2.0 ----------

  catalog() {
    return this.rpc<CatalogItem[]>("siosia_catalog");
  }
  requestService(input: ServiceRequestInput) {
    return this.rpc<AppointmentView>("siosia_request_service", {
      p_service: input.serviceId,
      // null = an open request to anyone in the group (2.1)
      p_provider: input.providerId ?? null,
      p_starts_at: new Date(input.startsAt).toISOString(),
      p_duration: input.durationMin,
      p_place: input.place,
      p_note: input.note,
      p_repeat: input.repeat ?? null
    });
  }
  takeRequest(id: string) {
    return this.rpc<AppointmentView>("siosia_take_request", { p_id: id });
  }
  answerAppointment(id: string, decision: "accept" | "decline") {
    return this.rpc<AppointmentView>("siosia_answer_appointment", { p_id: id, p_decision: decision });
  }
  async cancelAppointment(id: string, reason?: string | null, scope: "one" | "series" = "one") {
    await this.rpc("siosia_cancel_appointment", { p_id: id, p_reason: reason ?? null, p_scope: scope });
  }
  getAppointment(id: string) {
    return this.rpc<AppointmentView>("siosia_get_appointment", { p_id: id });
  }
  setRideTemplate(seriesId: string, template: RideTemplateInput) {
    return this.rpc<AppointmentView>("siosia_set_ride_template", { p_series: seriesId, p_template: template });
  }
  async dropRideTemplate(seriesId: string, leg: Leg) {
    await this.rpc("siosia_drop_ride_template", { p_series: seriesId, p_leg: leg });
  }
  async planned() {
    const p = await this.rpc<Planned>("siosia_planned");
    return { ...p, appointments: p.appointments.map(withOpen), open: (p.open ?? []).map(withOpen) };
  }
  timeline() {
    return this.rpc<HistoryItem[]>("siosia_timeline");
  }
  setOffers(ids: string[]) {
    return this.rpc<Profile>("siosia_set_offers", { p_ids: ids });
  }
  saveHome(place: Place | null) {
    return this.rpc<Profile>("siosia_save_home", { p_place: place });
  }
  async rateAppointment(id: string, stars: number, comment: string) {
    await this.rpc("siosia_rate_appointment", { p_id: id, p_stars: stars, p_comment: comment });
  }

  // ---------- realtime ----------

  onMyChanges(cb: () => void): Unsub {
    const ch = resilientChannel(
      this.sb,
      `user:${this.uid}`,
      { config: { private: true } },
      (c) => void c.on("broadcast", { event: "changed" }, () => cb()),
      () => cb() // (re)subscribed: events may have been missed meanwhile
    );
    return () => ch.close();
  }

  private driversChannel(): DriversChannel {
    if (!this.drivers) this.drivers = new DriversChannel(this.sb);
    return this.drivers;
  }

  onDriverPing(cb: () => void): Unsub {
    return this.driversChannel().addPing(cb);
  }

  watchDrivers(cb: (drivers: DriverPresence[]) => void): Unsub {
    return this.driversChannel().addPresence(cb);
  }

  /** A fresh random presence key per handle (= per idle period), never the user id. */
  driverPresence(): DriverPresenceHandle {
    const dc = this.driversChannel();
    const key = dc.newSession();
    return {
      track: (p) => dc.track({ ...p, id: key }),
      untrack: () => dc.track(null),
      close: () => dc.track(null)
    };
  }

  openRide(ride: { id: string; round: number }, role: Role, h: RideChannelHandlers): RideChannel {
    const peer = role === "rider" ? "driver" : "rider";
    let lastPeer: boolean | null = null;
    const handle = resilientChannel(
      this.sb,
      `ride:${ride.id}:${ride.round}`,
      { config: { private: true, presence: { key: role }, broadcast: { self: false } } },
      (ch) => {
        ch.on("broadcast", { event: "driver_pos" }, ({ payload }) => h.onDriverPos?.(payload as DriverPos))
          .on("broadcast", { event: "rider_pos" }, ({ payload }) => h.onRiderPos?.(payload as RiderPos))
          .on("broadcast", { event: "sharing_stop" }, ({ payload }) => h.onSharingStop?.(payload as SharingStop))
          .on("presence", { event: "sync" }, () => {
            const present = peer in ch.presenceState();
            if (present !== lastPeer) {
              lastPeer = present;
              h.onPeer?.(present);
            }
          });
      },
      (ch) => void ch.track({ role, t: Date.now() })
    );
    const send = (event: string, payload: unknown) => void handle.current().send({ type: "broadcast", event, payload });
    return {
      sendDriverPos: (p) => send("driver_pos", p),
      sendRiderPos: (p) => send("rider_pos", p),
      sendSharingStop: (p) => send("sharing_stop", p),
      close: () => handle.close()
    };
  }

  // ---------- accounts (US8) ----------

  async account(): Promise<AccountInfo> {
    const { data } = await this.sb.auth.getUser();
    const u = data.user;
    return {
      isAnonymous: u?.is_anonymous ?? true,
      email: u?.email ?? null,
      providers: (u?.identities ?? []).map((i) => i.provider)
    };
  }

  async linkEmail(email: string) {
    const { error } = await this.sb.auth.updateUser({ email }, { emailRedirectTo: redirectTo() });
    if (error) throw authError(error);
  }

  async signInWithEmail(email: string) {
    const { error } = await this.sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo() }
    });
    if (error) throw authError(error);
  }

  async linkGoogle() {
    const { error } = await this.sb.auth.linkIdentity({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) throw authError(error);
  }

  async signInWithGoogle() {
    const { error } = await this.sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) throw authError(error);
  }

  async signOut() {
    await this.sb.auth.signOut();
  }
}

/**
 * One shared "drivers" channel per client: pings, nearby-car presence and the driver's own presence.
 * realtime-js reuses a channel object per topic, so every re-creation (new presence key, fresh
 * authorisation after going online, server close) is serialised and waits for the old one to go.
 */
class DriversChannel {
  private ch: RealtimeChannel | null = null;
  /** Presence key the current channel was joined with (fixed by realtime-js at creation). */
  private chKey = "";
  private readonly pings = new Set<() => void>();
  private readonly watchers = new Set<(d: DriverPresence[]) => void>();
  private tracked: DriverPresence | null = null;
  private joined = false;
  private key = randomKey();
  private chain: Promise<void> = Promise.resolve();
  private readonly ours = new WeakSet<RealtimeChannel>();

  constructor(private readonly sb: SupabaseClient) {}

  addPing(cb: () => void): Unsub {
    this.pings.add(cb);
    this.ensure();
    return () => {
      this.pings.delete(cb);
      this.maybeRelease();
    };
  }

  addPresence(cb: (d: DriverPresence[]) => void): Unsub {
    this.watchers.add(cb);
    this.ensure();
    cb(this.list());
    return () => {
      this.watchers.delete(cb);
      this.maybeRelease();
    };
  }

  /** Starts a new presence identity (random key) — the channel is re-created with it. */
  newSession(): string {
    this.key = randomKey();
    this.tracked = null;
    this.rebuild();
    return this.key;
  }

  /** True when the joined channel carries the current key — never publish a new identity on an old one. */
  private canPublish(): boolean {
    return this.joined && !!this.ch && this.chKey === this.key;
  }

  track(p: DriverPresence | null): void {
    this.tracked = p;
    if (p) {
      this.ensure();
      // Otherwise the payload is published by the SUBSCRIBED handler of the re-created channel.
      if (this.canPublish()) void this.ch?.track(p);
    } else {
      if (this.joined) void this.ch?.untrack();
      this.maybeRelease();
    }
  }

  /** Re-creates the channel (fresh authorisation and current presence key). */
  rebuild(): void {
    this.chain = this.chain.then(async () => {
      const old = this.ch;
      this.ch = null;
      this.joined = false;
      if (old) {
        this.ours.add(old);
        await this.sb.removeChannel(old).catch(() => "error");
      }
      if (this.needed()) this.create();
    });
  }

  private needed(): boolean {
    return this.pings.size > 0 || this.watchers.size > 0 || this.tracked !== null;
  }

  private list(): DriverPresence[] {
    if (!this.ch) return [];
    const state = this.ch.presenceState<DriverPresence>();
    const out: DriverPresence[] = [];
    for (const metas of Object.values(state)) {
      const m = metas[metas.length - 1];
      if (m) out.push(m as unknown as DriverPresence);
    }
    return out;
  }

  private ensure(): void {
    this.chain = this.chain.then(() => {
      if (!this.ch && this.needed()) this.create();
    });
  }

  private create(): void {
    const ch = this.sb.channel("drivers", { config: { private: true, presence: { key: this.key } } });
    this.ch = ch;
    this.chKey = this.key;
    ch.on("broadcast", { event: "ping" }, () => this.pings.forEach((cb) => cb()))
      .on("presence", { event: "sync" }, () => {
        const list = this.list();
        this.watchers.forEach((cb) => cb(list));
      })
      .subscribe((status) => {
        if (this.ch !== ch) return;
        this.joined = status === "SUBSCRIBED";
        if (this.joined) {
          if (this.tracked && this.chKey === this.key) void ch.track(this.tracked);
          // Broadcasts are not stored: a dispatch ping sent while the channel was (re)joining is
          // lost, so answer as if pinged — the heartbeat pulls any request opened meanwhile.
          this.pings.forEach((cb) => cb());
        }
        if (status === "CLOSED" && !this.ours.has(ch)) {
          // Closed by the server: rebuild unless nobody needs it any more.
          this.ch = null;
          setTimeout(() => this.ensure(), REBUILD_DELAY_MS);
        }
      });
  }

  private maybeRelease(): void {
    this.chain = this.chain.then(async () => {
      if (this.ch && !this.needed()) {
        const ch = this.ch;
        this.ch = null;
        this.joined = false;
        this.ours.add(ch);
        await this.sb.removeChannel(ch).catch(() => "error");
      }
    });
  }
}
