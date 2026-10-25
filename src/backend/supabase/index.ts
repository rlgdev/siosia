// SupabaseBackend — the real multi-device backend (D-02). All writes go through SECURITY DEFINER
// SQL functions (supabase/migrations/0001_siosia.sql) that enforce the lifecycle, the atomic claim
// and the access rules; tables are not readable or writable directly. Realtime uses PRIVATE
// channels authorised by policies on realtime.messages. Only the publishable key reaches the browser.
// 2.3: photos live in the private bucket "photos"; the functions return an object's PATH only to a
// viewer allowed to see it, and this adapter turns every path into a signed URL (≤ 1 h) before the
// UI sees the result (FR-212). Chat rides on the user channel: a "changed" event refetches the thread.

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CONFIG } from "../../core/defaults";
import {
  ACTIVE_STATUSES,
  ServerError,
  type AppointmentView,
  type BookingInput,
  type CatalogItem,
  type ChatMessage,
  type ChatRoom,
  type ChatThread,
  type ContractInput,
  type ContractView,
  type DeploymentConfig,
  type FamilyView,
  type PublicProvider,
  type WeeklyReport,
  type HistoryItem,
  type Kid,
  type KidInput,
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
  type SessionFeed,
  type SessionUpdate,
  type SharingStop,
  type UpdateInput,
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
const PHOTOS_BUCKET = "photos";
/** A signed photo URL lives an hour (FR-212); one is reused for 50 minutes, then signed again. */
const SIGNED_URL_S = 3600;
const SIGNED_CACHE_MS = 50 * 60_000;

// A database not upgraded to 2.1 / 2.3 yet (the migration is re-run on release) leaves out the
// newer fields: no open requests, no paint, no kids or chat counts, no photo.
const withOpen = (a: AppointmentView): AppointmentView => ({
  ...a,
  open: a.open ?? false,
  kids: a.kids ?? [],
  kidCount: a.kidCount ?? 0,
  unread: a.unread ?? 0,
  // 2.6 fields (a server still on 2.5 sends none)
  rate: a.rate ?? null,
  contractId: a.contractId ?? null,
  actualMin: a.actualMin ?? null,
  cost: a.cost ?? null,
  family: a.family ?? null
});
const withOpenCount = (s: MyState): MyState => ({ ...s, openRequests: s.openRequests ?? 0, unreadChats: s.unreadChats ?? 0 });
const withPaint = (v: Vehicle): Vehicle => ({ ...v, paint: v.paint ?? null });
const withPhoto = (p: Profile): Profile => ({ ...p, photo: p.photo ?? null });

/** Every `photoPath` in a result — the server puts one only where this viewer may see that photo (V46). */
function photoPaths(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) photoPaths(x, out);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "photoPath" && typeof x === "string") out.add(x);
      else photoPaths(x, out);
    }
  }
}

/** Replaces each `photoPath` with `photo` — the signed URL, or null — so no path reaches the UI. */
function placePhotos(v: unknown, urls: Map<string, string>): void {
  if (Array.isArray(v)) {
    for (const x of v) placePhotos(x, urls);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("photoPath" in o) {
      const p = o.photoPath;
      delete o.photoPath;
      o.photo = typeof p === "string" ? (urls.get(p) ?? null) : null;
    }
    for (const x of Object.values(o)) placePhotos(x, urls);
  }
}

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
  private user: UserChannel | null = null;
  /** Signed photo URLs by object path, reused until shortly before they expire. */
  private readonly signed = new Map<string, { url: string; until: number }>();
  /**
   * My profile's public id: the folder my photo objects live in (profile/<publicId>/…). Never the
   * auth uid — a signed URL is shown to the other party, who must not learn it (C17).
   */
  private publicId: string | null = null;
  /** Open chat threads (onMessage): the ids each has delivered, so a message is emitted once. */
  private readonly chatSubs = new Set<{ room: string; seen: Set<string> }>();

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
    return this.withPhotos((res && typeof res === "object" && "ok" in res ? res.ok : res) as T);
  }

  /** Every profile the server returns: its photo field, and its public id (the photo folder). */
  private profile(p: Profile): Profile;
  private profile(p: Profile | null): Profile | null;
  private profile(p: Profile | null): Profile | null {
    if (!p) return null;
    this.publicId = p.publicId ?? null;
    return withPhoto(p);
  }

  /** The folder of my photo objects: the profile's public id, fetched once when no profile passed yet. */
  private async photoFolder(): Promise<string> {
    if (!this.publicId) this.profile(await this.rpc<Profile | null>("siosia_get_profile"));
    if (!this.publicId) throw new ServerError("no_profile");
    return this.publicId;
  }

  /** Signs every photo path of a result (one Storage call for all of them) — see placePhotos. */
  private async withPhotos<T>(value: T): Promise<T> {
    const paths = new Set<string>();
    photoPaths(value, paths);
    if (paths.size) placePhotos(value, await this.signPhotos([...paths]));
    return value;
  }

  private async signPhotos(paths: string[]): Promise<Map<string, string>> {
    const now = Date.now();
    const urls = new Map<string, string>();
    const todo: string[] = [];
    for (const p of paths) {
      const c = this.signed.get(p);
      if (c && c.until > now) urls.set(p, c.url);
      else todo.push(p);
    }
    if (todo.length) {
      try {
        const { data } = await this.sb.storage.from(PHOTOS_BUCKET).createSignedUrls(todo, SIGNED_URL_S);
        for (const d of data ?? []) {
          if (d.path && d.signedUrl) {
            urls.set(d.path, d.signedUrl);
            this.signed.set(d.path, { url: d.signedUrl, until: now + SIGNED_CACHE_MS });
          }
        }
      } catch {
        // No URL: the icon stands in for the photo until the next fetch.
      }
    }
    return urls;
  }

  /** Removes photo objects this account no longer needs (best effort: a leftover is unreadable anyway). */
  private async removePhotos(paths: string[]): Promise<void> {
    for (const p of paths) this.signed.delete(p);
    try {
      await this.sb.storage.from(PHOTOS_BUCKET).remove(paths);
    } catch {
      // The row's path moved on already; the object is dead to every reader.
    }
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
  async redeemTransfer(code: string, deviceId: string, replace = false) {
    return this.profile(await this.rpc<Profile>("siosia_redeem_transfer", { p_code: code, p_device: deviceId, p_replace: replace }));
  }
  async joinMaster(token: string, deviceId: string, language: Lang, replace = false) {
    return this.profile(await this.rpc<Profile>("siosia_join_master", { p_token: token, p_device: deviceId, p_language: language, p_replace: replace }));
  }
  async getProfile() {
    return this.profile(await this.rpc<Profile | null>("siosia_get_profile"));
  }
  async saveProfile(nickname: string, language: Lang) {
    return this.profile(await this.rpc<Profile>("siosia_save_profile", { p_nickname: nickname, p_language: language }));
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
    // The function refuses a deletion during an active ride (active_ride): ask the server first, so
    // a refused deletion leaves the photos as they are (C2). Then the photo objects go, through the
    // Storage API (that removes the files); the function then deletes the kids and drops any object
    // row left (FR-200) — the backstop for a leftover. An older database has no paths.
    const my = await this.myState();
    if (my.ride && ACTIVE_STATUSES.includes(my.ride.status)) throw new ServerError("active_ride");
    const paths = await this.rpc<string[]>("siosia_my_photo_paths").catch(() => [] as string[]);
    if (paths.length) await this.removePhotos(paths);
    await this.rpc("siosia_delete_profile");
    this.publicId = null;
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
  depart(rideId: string) {
    return this.rpc<RideView>("siosia_depart", { p_ride: rideId });
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
  async requestService(input: ServiceRequestInput) {
    const args: Record<string, unknown> = {
      p_service: input.serviceId,
      // null = an open request to anyone in the group (2.1)
      p_provider: input.providerId ?? null,
      p_starts_at: new Date(input.startsAt).toISOString(),
      p_duration: input.durationMin,
      p_place: input.place,
      p_note: input.note,
      p_repeat: input.repeat ?? null
    };
    // 2.3 overload (kids to attach); the 2.0 signature stays for a request without them.
    if (input.kidIds && input.kidIds.length) args.p_kids = input.kidIds;
    return withOpen(await this.rpc<AppointmentView>("siosia_request_service", args));
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
  async getAppointment(id: string) {
    return withOpen(await this.rpc<AppointmentView>("siosia_get_appointment", { p_id: id }));
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
  async timeline() {
    const items = await this.rpc<HistoryItem[]>("siosia_timeline");
    return items.map((h) => (h.kind === "appointment" ? { ...h, appointment: withOpen(h.appointment) } : h));
  }
  async setOffers(ids: string[]) {
    return this.profile(await this.rpc<Profile>("siosia_set_offers", { p_ids: ids }));
  }
  async saveHome(place: Place | null) {
    return this.profile(await this.rpc<Profile>("siosia_save_home", { p_place: place }));
  }
  async rateAppointment(id: string, stars: number, comment: string) {
    await this.rpc("siosia_rate_appointment", { p_id: id, p_stars: stars, p_comment: comment });
  }

  // ---------- 2.3: kids, photos, chat ----------

  kids() {
    return this.rpc<Kid[]>("siosia_kids");
  }
  addKid(input: KidInput) {
    return this.rpc<Kid>("siosia_add_kid", { p_kid: input });
  }
  updateKid(id: string, input: KidInput) {
    return this.rpc<Kid>("siosia_update_kid", { p_id: id, p_kid: input });
  }
  async removeKid(id: string) {
    // Clear the photo while the kid row still exists: the delete policy needs the row to allow the
    // object's removal (B9). The server then drops the object row itself as a backstop.
    await this.setPhoto({ kind: "kid", id }, null);
    await this.rpc<string | null>("siosia_remove_kid", { p_id: id });
  }
  async setAppointmentKids(id: string, kidIds: string[]) {
    return withOpen(await this.rpc<AppointmentView>("siosia_set_appointment_kids", { p_id: id, p_kids: kidIds }));
  }
  async rateKid(appointmentId: string, kidId: string, stars: number, comment: string) {
    await this.rpc("siosia_rate_kid", { p_id: appointmentId, p_kid: kidId, p_stars: stars, p_comment: comment });
  }
  /**
   * Uploads the (already resized) JPEG under a fresh random name in my own folder — keyed on the
   * profile's PUBLIC id, profile/<publicId>/<random>.jpg or kid/<publicId>/<kidId>/<random>.jpg,
   * since the signed URL of the object is shown to the other party and must not carry the auth uid
   * (C17; the upload policy and siosia_set_photo check the folder is mine) — then stores its path on
   * the row; the old object is removed. null clears.
   */
  async setPhoto(target: { kind: "profile" } | { kind: "kid"; id: string }, jpeg: Blob | null) {
    const kidId = target.kind === "kid" ? target.id : null;
    let path: string | null = null;
    if (jpeg) {
      const folder = await this.photoFolder();
      path = target.kind === "profile" ? `profile/${folder}/${randomKey()}.jpg` : `kid/${folder}/${kidId}/${randomKey()}.jpg`;
      const { error } = await this.sb.storage.from(PHOTOS_BUCKET).upload(path, jpeg, { upsert: true, contentType: "image/jpeg" });
      if (error) throw new ServerError("unavailable", error.message);
    }
    let old: string | null;
    try {
      old = await this.rpc<string | null>("siosia_set_photo", { p_kind: target.kind, p_kid: kidId, p_path: path });
    } catch (e) {
      if (path) void this.removePhotos([path]); // the row never pointed at it
      throw e;
    }
    if (old && old !== path) await this.removePhotos([old]);
    return path ? ((await this.signPhotos([path])).get(path) ?? null) : null;
  }
  chat(room: ChatRoom, markRead = false) {
    return this.rpc<ChatThread>("siosia_chat", { p_room: room, p_mark_read: markRead });
  }
  // ---------- 2.5: session updates and heading home ----------

  updates(appointmentId: string, seen = false) {
    return this.rpc<SessionFeed>("siosia_updates", { p_appt: appointmentId, p_seen: seen });
  }
  /** The photo goes to the bucket first, under my folder for this appointment; the row points at it. */
  async postUpdate(appointmentId: string, input: UpdateInput, jpeg: Blob | null = null) {
    let path: string | null = null;
    if (jpeg) {
      const folder = await this.photoFolder();
      path = `update/${folder}/${appointmentId}/${randomKey()}.jpg`;
      const { error } = await this.sb.storage.from(PHOTOS_BUCKET).upload(path, jpeg, { upsert: true, contentType: "image/jpeg" });
      if (error) throw new ServerError("unavailable", error.message);
    }
    try {
      return await this.rpc<SessionUpdate>("siosia_post_update", { p_appt: appointmentId, p_text: input.text, p_kid: input.kidId, p_photo: path });
    } catch (e) {
      if (path) void this.removePhotos([path]); // no row points at it
      throw e;
    }
  }
  async deleteUpdate(id: string) {
    const old = await this.rpc<string | null>("siosia_delete_update", { p_id: id });
    if (old) await this.removePhotos([old]);
  }
  comingHome(appointmentId: string, minutes: number) {
    return this.rpc<AppointmentView>("siosia_coming_home", { p_appt: appointmentId, p_minutes: minutes });
  }

  // ---------- 2.6: family, contracts, cost, weekly reports ----------

  family() {
    return this.rpc<FamilyView>("siosia_family");
  }
  members() {
    return this.rpc<PublicProvider[]>("siosia_members");
  }
  inviteToFamily(publicId: string) {
    return this.rpc<FamilyView>("siosia_family_invite", { p_public: publicId });
  }
  answerInvite(id: string, decision: "join" | "decline") {
    return this.rpc<FamilyView>("siosia_family_answer", { p_id: id, p_decision: decision });
  }
  withdrawInvite(id: string) {
    return this.rpc<FamilyView>("siosia_family_withdraw", { p_id: id });
  }
  leaveFamily() {
    return this.rpc<FamilyView>("siosia_family_leave");
  }
  contracts() {
    return this.rpc<ContractView[]>("siosia_contracts");
  }
  proposeContract(input: ContractInput) {
    return this.rpc<ContractView>("siosia_propose_contract", { p_to: input.to, p_as: input.as, p_rates: input.rates, p_note: input.note ?? "" });
  }
  answerContract(id: string, decision: "accept" | "decline") {
    return this.rpc<ContractView>("siosia_answer_contract", { p_id: id, p_decision: decision });
  }
  async withdrawContract(id: string) {
    await this.rpc("siosia_withdraw_contract", { p_id: id });
  }
  async endContract(id: string) {
    await this.rpc("siosia_end_contract", { p_id: id });
  }
  async setActualTime(appointmentId: string, minutes: number) {
    return withOpen(await this.rpc<AppointmentView>("siosia_set_actual", { p_id: appointmentId, p_minutes: minutes }));
  }
  report(week: string | null, scope: "me" | "family") {
    return this.rpc<WeeklyReport>("siosia_report", { p_week: week, p_scope: scope });
  }

  async sendMessage(room: ChatRoom, text: string) {
    const m = await this.rpc<ChatMessage>("siosia_send_message", { p_room: room, p_text: text });
    // The caller shows it from this result; the live feed on this device skips it.
    for (const s of this.chatSubs) if (s.room === room) s.seen.add(m.id);
    return m;
  }
  /**
   * Live messages of a room: every "changed" on my user channel (the server sends one to both
   * parties on a send) refetches the thread and emits the messages not delivered before. The first
   * fetch only learns what is already there — the caller loaded the thread with chat().
   */
  onMessage(room: ChatRoom, cb: (m: ChatMessage) => void): Unsub {
    const sub = { room, seen: new Set<string>() };
    this.chatSubs.add(sub);
    let primed = false;
    let chain = Promise.resolve();
    const pull = () => {
      chain = chain.then(async () => {
        const emit = primed;
        primed = true;
        try {
          const t = await this.rpc<ChatThread>("siosia_chat", { p_room: room, p_mark_read: false });
          for (const m of t.messages) {
            if (sub.seen.has(m.id)) continue;
            sub.seen.add(m.id);
            if (emit) cb(m);
          }
        } catch {
          // The next change tries again; the thread itself is reloaded by the screen.
        }
      });
    };
    const off = this.userChannel().add(pull);
    return () => {
      off();
      this.chatSubs.delete(sub);
    };
  }

  // ---------- realtime ----------

  private userChannel(): UserChannel {
    if (!this.user) this.user = new UserChannel(this.sb, `user:${this.uid}`);
    return this.user;
  }

  onMyChanges(cb: () => void): Unsub {
    return this.userChannel().add(cb);
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
 * The one private "user:<uid>" channel of this client — realtime-js keeps one channel object per
 * topic, so a second subscription to it would take over the first. Its "changed" events reach every
 * listener: the app's refetch (onMyChanges) and each open chat thread (onMessage). Built with the
 * first listener, closed with the last.
 */
class UserChannel {
  private handle: ReturnType<typeof resilientChannel> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly sb: SupabaseClient,
    private readonly topic: string
  ) {}

  add(cb: () => void): Unsub {
    this.listeners.add(cb);
    if (this.handle) {
      cb(); // joins a live channel: catch up once, as a fresh subscription would
    } else {
      this.handle = resilientChannel(
        this.sb,
        this.topic,
        { config: { private: true } },
        (c) => void c.on("broadcast", { event: "changed" }, () => this.fire()),
        () => this.fire() // (re)subscribed: events may have been missed meanwhile
      );
    }
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0 && this.handle) {
        this.handle.close();
        this.handle = null;
      }
    };
  }

  private fire(): void {
    for (const cb of [...this.listeners]) cb();
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
