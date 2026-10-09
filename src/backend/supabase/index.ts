// SupabaseBackend — the real multi-device backend (D-02). All writes go through SECURITY DEFINER
// SQL functions (supabase/migrations/0001_siosia.sql) that enforce the lifecycle, the atomic claim
// and the access rules; tables are additionally protected by RLS. Realtime uses PRIVATE channels
// authorised by policies on realtime.messages. Only the publishable key ever reaches the browser.

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import {
  ServerError,
  type DeploymentConfig,
  type DriverPos,
  type DriverPresence,
  type Earnings,
  type Lang,
  type LatLng,
  type MyState,
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

const redirectTo = () => window.location.origin + window.location.pathname;

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
      if (s?.access_token) void this.sb.realtime.setAuth(s.access_token);
    });
    return this.uid;
  }

  async ping(): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const { error } = await this.sb.rpc("siosia_config").abortSignal(ctrl.signal);
      if (error) throw new ServerError("unavailable", error.message);
    } catch (e) {
      throw e instanceof ServerError ? e : new ServerError("unavailable", String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  getConfig() {
    return this.rpc<DeploymentConfig>("siosia_config");
  }
  isMember(deviceId: string) {
    return this.rpc<boolean>("siosia_is_member", { p_device: deviceId });
  }
  async join(code: string, deviceId: string) {
    await this.rpc("siosia_join", { p_code: code, p_device: deviceId });
  }
  getProfile() {
    return this.rpc<Profile | null>("siosia_get_profile");
  }
  saveProfile(nickname: string, language: Lang) {
    return this.rpc<Profile>("siosia_save_profile", { p_nickname: nickname, p_language: language });
  }
  getVehicle() {
    return this.rpc<Vehicle | null>("siosia_get_vehicle");
  }
  saveVehicle(v: Vehicle) {
    return this.rpc<Vehicle>("siosia_save_vehicle", {
      p_make: v.make,
      p_model: v.model,
      p_colour: v.colour,
      p_plate: v.plate,
      p_seats: v.seats
    });
  }
  async deleteProfile() {
    await this.rpc("siosia_delete_profile");
  }
  myState() {
    return this.rpc<MyState>("siosia_my_state");
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
    if (online) this.drivers?.rejoin();
  }
  heartbeat(pos: LatLng | null) {
    return this.rpc<MyState>("siosia_heartbeat", { p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
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

  // ---------- realtime ----------

  onMyChanges(cb: () => void): Unsub {
    const ch = this.sb
      .channel(`user:${this.uid}`, { config: { private: true } })
      .on("broadcast", { event: "changed" }, () => cb())
      .subscribe((status) => {
        // After a reconnect we may have missed events: refetch.
        if (status === "SUBSCRIBED") cb();
      });
    return () => void this.sb.removeChannel(ch);
  }

  private driversChannel(): DriversChannel {
    if (!this.drivers) this.drivers = new DriversChannel(this.sb, () => this.uid);
    return this.drivers;
  }

  onDriverPing(cb: () => void): Unsub {
    return this.driversChannel().addPing(cb);
  }

  watchDrivers(cb: (drivers: DriverPresence[]) => void): Unsub {
    return this.driversChannel().addPresence(cb);
  }

  driverPresence(): DriverPresenceHandle {
    const dc = this.driversChannel();
    return {
      track: (p) => dc.track(p),
      untrack: () => dc.track(null),
      close: () => dc.track(null)
    };
  }

  openRide(rideId: string, role: Role, h: RideChannelHandlers): RideChannel {
    const peer = role === "rider" ? "driver" : "rider";
    let lastPeer: boolean | null = null;
    const ch: RealtimeChannel = this.sb.channel(`ride:${rideId}`, {
      config: { private: true, presence: { key: role }, broadcast: { self: false } }
    });
    ch.on("broadcast", { event: "driver_pos" }, ({ payload }) => h.onDriverPos?.(payload as DriverPos))
      .on("broadcast", { event: "rider_pos" }, ({ payload }) => h.onRiderPos?.(payload as RiderPos))
      .on("broadcast", { event: "sharing_stop" }, ({ payload }) => h.onSharingStop?.(payload as SharingStop))
      .on("presence", { event: "sync" }, () => {
        const present = peer in ch.presenceState();
        if (present !== lastPeer) {
          lastPeer = present;
          h.onPeer?.(present);
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void ch.track({ role, t: Date.now() });
      });
    const send = (event: string, payload: unknown) => void ch.send({ type: "broadcast", event, payload });
    return {
      sendDriverPos: (p) => send("driver_pos", p),
      sendRiderPos: (p) => send("rider_pos", p),
      sendSharingStop: (p) => send("sharing_stop", p),
      close: () => {
        void ch.untrack();
        void this.sb.removeChannel(ch);
      }
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
    if (error) throw new ServerError("unavailable", error.message);
  }

  async signInWithEmail(email: string) {
    const { error } = await this.sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo() }
    });
    if (error) throw new ServerError("unavailable", error.message);
  }

  async linkGoogle() {
    const { error } = await this.sb.auth.linkIdentity({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) throw new ServerError("unavailable", error.message);
  }

  async signInWithGoogle() {
    const { error } = await this.sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) throw new ServerError("unavailable", error.message);
  }

  async signOut() {
    await this.sb.auth.signOut();
  }
}

/** One shared "drivers" channel per client: pings, nearby-car presence and the driver's own presence. */
class DriversChannel {
  private ch: RealtimeChannel | null = null;
  private readonly pings = new Set<() => void>();
  private readonly watchers = new Set<(d: DriverPresence[]) => void>();
  private tracked: DriverPresence | null = null;
  private joined = false;

  constructor(
    private readonly sb: SupabaseClient,
    private readonly uid: () => string
  ) {}

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

  track(p: DriverPresence | null): void {
    this.tracked = p;
    if (p) {
      this.ensure();
      if (this.joined) void this.ch?.track(p);
    } else {
      if (this.joined) void this.ch?.untrack();
      this.maybeRelease();
    }
  }

  rejoin(): void {
    if (!this.ch) return;
    const old = this.ch;
    this.ch = null;
    this.joined = false;
    void this.sb.removeChannel(old).then(() => this.ensure());
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
    if (this.ch) return;
    const ch = this.sb.channel("drivers", { config: { private: true, presence: { key: this.uid() } } });
    this.ch = ch;
    ch.on("broadcast", { event: "ping" }, () => this.pings.forEach((cb) => cb()))
      .on("presence", { event: "sync" }, () => {
        const list = this.list();
        this.watchers.forEach((cb) => cb(list));
      })
      .subscribe((status) => {
        if (this.ch !== ch) return;
        this.joined = status === "SUBSCRIBED";
        if (this.joined && this.tracked) void ch.track(this.tracked);
      });
  }

  private maybeRelease(): void {
    if (this.ch && this.pings.size === 0 && this.watchers.size === 0 && !this.tracked) {
      const ch = this.ch;
      this.ch = null;
      this.joined = false;
      void this.sb.removeChannel(ch);
    }
  }
}
