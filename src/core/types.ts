// Shared domain types. These are the shapes the UI sees, whichever backend is active.
// Times are epoch milliseconds from the SERVER clock (see MyState.serverNow).

export type Lang = "en" | "pl";
export type Mode = "ride" | "drive";
export type Role = "rider" | "driver";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place extends LatLng {
  label: string;
}

export type RideStatus =
  | "requested"
  | "accepted"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "expired";

export const ACTIVE_STATUSES: readonly RideStatus[] = ["requested", "accepted", "arrived", "in_progress"];
export const TERMINAL_STATUSES: readonly RideStatus[] = ["completed", "cancelled", "expired"];

export type OfferStatus = "queued" | "offered" | "declined" | "timed_out" | "withdrawn" | "won";
export type CancelledBy = "rider" | "driver" | "system";

export type DriverCancelReason = "no_show" | "wrong_pickup" | "vehicle_problem" | "other";

export interface Tariff {
  base: number;
  perKm: number;
  perMin: number;
  minimum: number;
  currency: string;
}

export interface Timers {
  /** Offer card countdown, seconds (default 20). */
  offerS: number;
  /** Request expiry without acceptance, seconds (default 180). */
  expiryS: number;
  /** Wait at pickup before No-show is allowed, seconds (default 300). */
  noShowS: number;
}

export interface ServiceArea extends LatLng {
  radiusKm: number;
}

/** Deployment configuration (spec §9 "Deployment config"); the invite hash never reaches the client. */
export interface DeploymentConfig {
  tariff: Tariff;
  timers: Timers;
  /** null = no restriction. */
  serviceArea: ServiceArea | null;
  dispatchRadiusKm: number;
  maxTripKm: number;
  timezone: string;
  operatorContact: string;
}

export interface RatingSummary {
  /** Mean of the last 20 ratings received; null = "New" (fewer than 3). */
  mean: number | null;
  count: number;
}

export interface Vehicle {
  make: string;
  model: string;
  colour: string;
  plate: string;
  seats: number;
}

/** Rider profile = basic info only (nickname + language). Drivers add a Vehicle. */
export interface Profile {
  userId: string;
  nickname: string;
  language: Lang;
  riderCancels: number;
  driverCancels: number;
  lateCancels: number;
  rating: RatingSummary;
}

export interface PublicParty {
  nickname: string;
  rating: RatingSummary;
}

export interface PublicDriver extends PublicParty {
  /** Only present once the driver is assigned to the viewer's ride (FR-044). */
  vehicle: Vehicle | null;
}

export interface RideView {
  id: string;
  status: RideStatus;
  /** The viewer's role in this ride. */
  role: Role;
  pickup: Place;
  dropoff: Place;
  estKm: number;
  estMin: number;
  fare: number;
  currency: string;
  /** True when the fare was frozen on the straight-line fallback (FR-032). */
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
  /** Dispatch round; the live channel is per (ride, round) so a removed driver loses access. */
  round: number;
  rider: PublicParty;
  driver: PublicDriver | null;
  /** Stars the viewer gave in this ride, if any. */
  myRating: number | null;
}

export interface OfferView {
  id: string;
  rideId: string;
  status: OfferStatus;
  offeredAt: number;
  driverDistanceKm: number;
  pickup: Place;
  dropoff: Place;
  estKm: number;
  estMin: number;
  fare: number;
  currency: string;
  fareIsEstimate: boolean;
  rider: PublicParty;
}

export interface MyState {
  serverNow: number;
  /** Active ride (requested … in_progress) in either role. */
  ride: RideView | null;
  /** The single offer card currently shown to this driver (spec §6 rule 5). */
  offer: OfferView | null;
  queuedOffers: number;
  driverOnline: boolean;
  hasVehicle: boolean;
  /** Latest completed ride from the last 2 h that this user has not rated yet. */
  pendingReceipt: RideView | null;
}

export interface Earnings {
  todayTotal: number;
  todayCount: number;
  monthTotal: number;
  monthCount: number;
  currency: string;
}

export interface RideRequestInput {
  pickup: Place;
  dropoff: Place;
  estKm: number;
  estMin: number;
  fareIsEstimate: boolean;
}

/** Ephemeral realtime payloads (never persisted — FR-043). */
export interface DriverPos extends LatLng {
  heading: number | null;
  accuracy: number;
  t: number;
}

export interface RiderPos extends LatLng {
  accuracy: number;
  t: number;
}

export interface SharingStop {
  from: Role;
}

/**
 * Driver presence on the shared "drivers" channel: coarse position only (~100 m). `id` is a random
 * key per idle period — never the user id — so a rider cannot follow one driver over time.
 */
export interface DriverPresence extends LatLng {
  id: string;
  state: "idle" | "busy";
  heading: number | null;
  t: number;
}

/** Error codes returned by the server functions (both backends use the same codes). */
export type ServerErrorCode =
  | "not_member"
  | "no_profile"
  | "bad_nickname"
  | "bad_vehicle"
  | "bad_invite"
  | "rate_limited"
  | "active_ride"
  | "online_as_driver"
  | "no_vehicle"
  | "active_trip"
  | "outside_area"
  | "too_far"
  | "bad_input"
  | "not_found"
  | "forbidden"
  | "illegal_transition"
  | "taken"
  | "offer_expired"
  | "not_online"
  | "too_early"
  | "window_closed"
  | "already_rated"
  | "email_in_use"
  | "no_account"
  | "not_enabled"
  | "unavailable";

export class ServerError extends Error {
  readonly code: ServerErrorCode;
  constructor(code: ServerErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ServerError";
  }
}
