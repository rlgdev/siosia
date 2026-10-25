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
  ChatMessage,
  ChatRoom,
  ChatThread,
  ContractInput,
  ContractView,
  FamilyView,
  Kid,
  KidInput,
  SessionFeed,
  SessionUpdate,
  UpdateInput,
  WeeklyReport,
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
  PublicProvider,
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

  // ---------- 2.3: kids, photos, chat ----------

  /** My kids (S2 → My kids), with their ratings. */
  kids(): Promise<Kid[]>;
  addKid(input: KidInput): Promise<Kid>;
  updateKid(id: string, input: KidInput): Promise<Kid>;
  removeKid(id: string): Promise<void>;
  /** The client attaches (replaces) the kids of an appointment; a series occurrence: that one. */
  setAppointmentKids(id: string, kidIds: string[]): Promise<AppointmentView>;
  /** The provider rates an attached kid once after the appointment is done (24 h). */
  rateKid(appointmentId: string, kidId: string, stars: number, comment: string): Promise<void>;
  /** A photo (already resized by the app) for my profile or one of my kids; null clears it. */
  setPhoto(target: { kind: "profile" } | { kind: "kid"; id: string }, jpeg: Blob | null): Promise<string | null>;
  /** A room's thread as the viewer sees it; marks it read when `markRead`. */
  chat(room: ChatRoom, markRead?: boolean): Promise<ChatThread>;
  sendMessage(room: ChatRoom, text: string): Promise<ChatMessage>;
  /** Live messages of a room (both directions) while subscribed. */
  onMessage(room: ChatRoom, cb: (m: ChatMessage) => void): Unsub;
  /** 2.5 (FR-230–233): the session feed of an appointment I am a party of; `seen` stamps my presence in it. */
  updates(appointmentId: string, seen?: boolean): Promise<SessionFeed>;
  /** Posts a text and/or a photo (already resized by the app), about one attached kid or everyone. */
  postUpdate(appointmentId: string, input: UpdateInput, jpeg?: Blob | null): Promise<SessionUpdate>;
  /** Removes my own update (its photo goes too). */
  deleteUpdate(id: string): Promise<void>;
  /** 2.5 (FR-240): the client is heading home, about this many minutes away (computed on the phone). */
  comingHome(appointmentId: string, minutes: number): Promise<AppointmentView>;

  // ---------- 2.6: family, contracts, cost, weekly reports ----------

  /** My family: its people, the invitations it sent, those waiting for me (FR-250–252). */
  family(): Promise<FamilyView>;
  /** Everyone else with a profile (to invite, or to propose a contract to). */
  members(): Promise<PublicProvider[]>;
  inviteToFamily(publicId: string): Promise<FamilyView>;
  answerInvite(id: string, decision: "join" | "decline"): Promise<FamilyView>;
  withdrawInvite(id: string): Promise<FamilyView>;
  leaveFamily(): Promise<FamilyView>;
  /** My family's contracts and mine as a provider (FR-264). */
  contracts(): Promise<ContractView[]>;
  proposeContract(input: ContractInput): Promise<ContractView>;
  answerContract(id: string, decision: "accept" | "decline"): Promise<ContractView>;
  withdrawContract(id: string): Promise<void>;
  endContract(id: string): Promise<void>;
  /** The provider corrects the time of a done appointment within 24 h (FR-272). */
  setActualTime(appointmentId: string, minutes: number): Promise<AppointmentView>;
  /** One week's spent and earned (`week` = any day "YYYY-MM-DD", null = this week). */
  report(week: string | null, scope: "me" | "family"): Promise<WeeklyReport>;

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
