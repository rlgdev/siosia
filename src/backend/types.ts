// Backend abstraction (spec D-02): every data and realtime access goes through this interface so the
// in-browser mock (FR-070) and the real Supabase backend are interchangeable.
//
// Realtime topics (both backends):
//   user:<uid>  "changed"  — server → that user: something about my rides/offers changed; refetch.
//   drivers     "ping"     — server → online drivers: a request opened; send a heartbeat now.
//   drivers     presence   — online drivers' coarse position (~100 m) for the nearby-cars view.
//   ride:<id>:<round> broadcast — driver_pos / rider_pos / sharing_stop between the two parties.
//   ride:<id>:<round> presence  — whether the other party is connected. A new round (re-dispatch)
//                                 means a new topic, so a removed driver hears nothing more.
// Live positions only ever travel over realtime and are never stored (FR-043).

import type { PushKind, PushParams } from "../../supabase/functions/_shared/push-text";
import type {
  AppointmentView,
  BookingInput,
  CatalogItem,
  DeploymentConfig,
  HistoryItem,
  Leg,
  Place,
  Planned,
  RideTemplateInput,
  ServiceRequestInput,
  DriverPos,
  DriverPresence,
  Earnings,
  Lang,
  LatLng,
  MyState,
  OpenBooking,
  Profile,
  RideRequestInput,
  RideView,
  RiderPos,
  Role,
  SharingStop,
  Vehicle
} from "../core/types";

export type BackendKind = "mock" | "supabase";

/** A notification event for this user (demo backend; Supabase sends real Web Push instead). */
export interface PushMessage {
  kind: PushKind;
  rideId: string | null;
  /** 2.0: appointment notifications (tag source). */
  appointmentId?: string | null;
  params: PushParams;
}
export type Unsub = () => void;

export interface RideChannelHandlers {
  onDriverPos?: (p: DriverPos) => void;
  onRiderPos?: (p: RiderPos) => void;
  onSharingStop?: (p: SharingStop) => void;
  /** The other party connected (true) or disconnected (false). */
  onPeer?: (present: boolean) => void;
}

export interface RideChannel {
  sendDriverPos(p: DriverPos): void;
  sendRiderPos(p: RiderPos): void;
  sendSharingStop(p: SharingStop): void;
  close(): void;
}

export interface DriverPresenceHandle {
  /** The backend sets `id` to this handle's random presence key. */
  track(p: Omit<DriverPresence, "id">): void;
  untrack(): void;
  close(): void;
}

export interface AccountInfo {
  isAnonymous: boolean;
  email: string | null;
  providers: string[];
}

export type OfferDecision = "accept" | "decline" | "timeout";

export interface Backend {
  readonly kind: BackendKind;
  /** Whether this deployment requires an invite code (FR-007). */
  readonly needsInvite: boolean;

  /** Ensures a session (anonymous on first launch, FR-002); returns the user id. */
  start(): Promise<string>;
  /** Throws when the backend cannot be reached within 5 s (D-04). */
  ping(): Promise<void>;
  getConfig(): Promise<DeploymentConfig>;

  isMember(deviceId: string): Promise<boolean>;
  join(code: string, deviceId: string): Promise<void>;
  /**
   * Opens a shared master profile from its link token (replaces the invite code). Fails with
   * has_profile when this account already has another profile, unless `replace` (user confirmed).
   */
  joinMaster(token: string, deviceId: string, language: Lang, replace?: boolean): Promise<Profile>;
  /** A one-time code (30 min) that moves this profile to another app or phone. */
  createTransfer(): Promise<{ code: string; expiresAt: number }>;
  /** Takes over the profile behind a move code; has_profile unless `replace` (user confirmed). */
  redeemTransfer(code: string, deviceId: string, replace?: boolean): Promise<Profile>;

  getProfile(): Promise<Profile | null>;
  saveProfile(nickname: string, language: Lang): Promise<Profile>;
  getVehicle(): Promise<Vehicle | null>;
  saveVehicle(v: Vehicle): Promise<Vehicle>;
  deleteProfile(): Promise<void>;

  myState(): Promise<MyState>;
  getRide(rideId: string): Promise<RideView>;
  history(): Promise<RideView[]>;
  earnings(): Promise<Earnings>;

  requestRide(input: RideRequestInput): Promise<RideView>;
  /** Rides booked in advance. */
  bookRide(input: BookingInput): Promise<RideView>;
  bookings(): Promise<RideView[]>;
  openBookings(pos: LatLng | null): Promise<OpenBooking[]>;
  claimBooking(rideId: string): Promise<"won">;
  releaseBooking(rideId: string): Promise<void>;
  cancelRide(rideId: string, reason?: string): Promise<void>;

  setOnline(online: boolean): Promise<void>;
  heartbeat(pos: LatLng | null): Promise<MyState>;
  /** "Show requests": re-offer every pending request near `pos`, including earlier declines. */
  refreshOffers(pos: LatLng): Promise<MyState>;
  decideOffer(offerId: string, decision: OfferDecision): Promise<"won" | "ok">;
  advance(rideId: string, to: "arrived" | "in_progress" | "completed", actualKm?: number): Promise<RideView>;
  /**
   * 2.2: the driver's phone noticed the car moving towards the pickup of an accepted ride; the rider
   * is told once ("{driver} set off"). Idempotent; a no-op outside status accepted.
   */
  depart(rideId: string): Promise<RideView>;

  markPaid(rideId: string): Promise<void>;
  markCollected(rideId: string): Promise<void>;
  rate(rideId: string, stars: number, comment: string): Promise<void>;

  // ---------- 2.0: the service catalog and appointments ----------

  /** The enabled catalog with who offers each entry (public ids), without me. */
  catalog(): Promise<CatalogItem[]>;
  /** Send request (one provider, or open to anyone when providerId is null; optionally a series). */
  requestService(input: ServiceRequestInput): Promise<AppointmentView>;
  /**
   * 2.1: take someone's open request — the caller becomes the provider and it is accepted (a series
   * as a whole, clashing dates declined). Fails with taken when someone was faster, overlap when it
   * clashes with the caller's own schedule, forbidden for one's own request.
   */
  takeRequest(id: string): Promise<AppointmentView>;
  /** 2.1: the car's colour (name in the driver's words, shown to riders) and paint for the car icon. */
  setCarColour(colour: string, paint: string): Promise<Vehicle>;
  /** Provider: accept or decline (a series is answered as a whole). */
  answerAppointment(id: string, decision: "accept" | "decline"): Promise<AppointmentView>;
  /** Either party; a series: this one or all remaining. */
  cancelAppointment(id: string, reason?: string | null, scope?: "one" | "series"): Promise<void>;
  getAppointment(id: string): Promise<AppointmentView>;
  /** A series' repeating ride (the caller is the passenger); bookings within the horizon at once. */
  setRideTemplate(seriesId: string, template: RideTemplateInput): Promise<AppointmentView>;
  dropRideTemplate(seriesId: string, leg: Leg): Promise<void>;
  /** Everything upcoming in both roles (P1). */
  planned(): Promise<Planned>;
  /** Finished appointments and rides, newest first (H1). */
  timeline(): Promise<HistoryItem[]>;
  setOffers(ids: string[]): Promise<Profile>;
  saveHome(place: Place | null): Promise<Profile>;
  rateAppointment(id: string, stars: number, comment: string): Promise<void>;

  onMyChanges(cb: () => void): Unsub;
  /** Web Push subscription of this device (notifications). */
  savePush(sub: { endpoint: string; p256dh: string; auth: string }): Promise<void>;
  deletePush(endpoint: string): Promise<void>;
  /** Demo backend only: notification events for this user, shown by the page. */
  onPush?(cb: (m: PushMessage) => void): Unsub;
  onDriverPing(cb: () => void): Unsub;
  watchDrivers(cb: (drivers: DriverPresence[]) => void): Unsub;
  driverPresence(): DriverPresenceHandle;
  /** Live channel of one assignment: topic ride:<id>:<round>. */
  openRide(ride: { id: string; round: number }, role: Role, handlers: RideChannelHandlers): RideChannel;

  // Optional account linking (US8) — only the Supabase backend implements these.
  account?(): Promise<AccountInfo>;
  linkEmail?(email: string): Promise<void>;
  signInWithEmail?(email: string): Promise<void>;
  linkGoogle?(): Promise<void>;
  signInWithGoogle?(): Promise<void>;
  signOut?(): Promise<void>;
}
