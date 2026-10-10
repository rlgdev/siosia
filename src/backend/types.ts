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

import type {
  DeploymentConfig,
  DriverPos,
  DriverPresence,
  Earnings,
  Lang,
  LatLng,
  MyState,
  Profile,
  RideRequestInput,
  RideView,
  RiderPos,
  Role,
  SharingStop,
  Vehicle
} from "../core/types";

export type BackendKind = "mock" | "supabase";
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
  cancelRide(rideId: string, reason?: string): Promise<void>;

  setOnline(online: boolean): Promise<void>;
  heartbeat(pos: LatLng | null): Promise<MyState>;
  /** "Show requests": re-offer every pending request near `pos`, including earlier declines. */
  refreshOffers(pos: LatLng): Promise<MyState>;
  decideOffer(offerId: string, decision: OfferDecision): Promise<"won" | "ok">;
  advance(rideId: string, to: "arrived" | "in_progress" | "completed", actualKm?: number): Promise<RideView>;

  markPaid(rideId: string): Promise<void>;
  markCollected(rideId: string): Promise<void>;
  rate(rideId: string, stars: number, comment: string): Promise<void>;

  onMyChanges(cb: () => void): Unsub;
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
