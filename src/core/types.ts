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
  | "scheduled"
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
  /** How long a request stays open without acceptance, seconds (default 1200 = 20 min). */
  expiryS: number;
  /**
   * A card a driver let lapse (no answer within offerS) is offered to them again after this many
   * seconds while the request is still open (default 120; 0 = never). A Decline holds until the
   * driver goes online again or taps Show requests.
   */
  retryS: number;
  /** Wait at pickup before No-show is allowed, seconds (default 300). */
  noShowS: number;
}

export interface ServiceArea extends LatLng {
  radiusKm: number;
}

/** Deployment configuration (spec §9 "Deployment config"); the invite hash never reaches the client. */
/** Rides booked in advance (minutes / days). */
export interface BookingSettings {
  /** Earliest booking: this many minutes from now. */
  minLeadMin: number;
  /** Latest booking: this many days ahead. */
  maxDays: number;
  /** A claimed booking starts (the driver sets off) this many minutes before its time. */
  leadMin: number;
  /** An unclaimed booking opens to normal dispatch this many minutes before its time. */
  openMin: number;
}

export interface DeploymentConfig {
  tariff: Tariff;
  timers: Timers;
  booking: BookingSettings;
  /** null = no restriction. */
  serviceArea: ServiceArea | null;
  dispatchRadiusKm: number;
  maxTripKm: number;
  timezone: string;
  /**
   * Driver standby, hours: after the app goes quiet (phone locked, app closed) an online driver
   * still gets a notification for each new request this long. 0 = off.
   */
  standbyHours: number;
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
  /** Set when this device uses a shared master profile (opened from its link). */
  masterId: string | null;
  /** The master profile's one role: a rider profile cannot drive, a driver profile cannot ride. */
  masterRole: "rider" | "driver" | null;
  /** Rider master profiles: where a new ride starts and ends unless the rider changes it. */
  defaultPickup: Place | null;
  defaultDropoff: Place | null;
  /** Driver master profiles: the preset vehicle (plate may be missing — then each phone adds it). */
  masterVehicle: (Omit<Vehicle, "plate"> & { plate?: string }) | null;
  /** Profile icon id (see components/profileIcons.ts), from the master profile; null = none. */
  icon: string | null;
  /** Every ride of a master profile costs exactly this (deployment currency); null = tariff. */
  fixedFare: number | null;
}

export interface PublicParty {
  nickname: string;
  rating: RatingSummary;
  /** Profile icon id, shown next to the nickname (master profiles only). */
  icon?: string | null;
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
  /** When the request expires if still unaccepted (server clock; follows the current config). */
  expiresAt: number;
  /** Booked pickup time (wall-clock ms, as picked) for a ride booked in advance; null = right away. */
  scheduledFor: number | null;
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
  /**
   * Open requests within the dispatch radius of the position sent with this call (driver heartbeat
   * or "Show requests"); null when the call carried no position (e.g. a plain state refresh).
   */
  nearbyRequests: number | null;
  /** Latest completed ride from the last 2 h that this user has not rated yet. */
  pendingReceipt: RideView | null;
  /** My upcoming bookings as rider. */
  bookings: number;
  /** Upcoming bookings I took as driver. */
  driverBookings: number;
  /** False once this account lost its profile (moved to another app/phone, deleted). */
  hasProfile: boolean;
  /** Driver standby is on: new requests are notified even with the app closed. */
  standby: boolean;
  /** Bookings without a driver that this user could take (0 for rider-only profiles). */
  openBookings: number;
}

/** A ride booked for later. */
export interface BookingInput extends RideRequestInput {
  /** Pickup time (wall-clock ms, as picked). */
  scheduledFor: number;
}

/** A booking a driver can take, with the distance from where the driver is now (if known). */
export interface OpenBooking {
  ride: RideView;
  distanceKm: number | null;
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
  | "bad_link"
  | "bad_transfer"
  | "has_profile"
  | "bad_time"
  | "too_many"
  | "overlap"
  | "rider_only"
  | "driver_only"
  | "unavailable";

export class ServerError extends Error {
  readonly code: ServerErrorCode;
  constructor(code: ServerErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ServerError";
  }
}
