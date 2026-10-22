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
  /** Open bookings per rider (2.0: 12, room for a series' rides). */
  maxOpen: number;
}

// ---------------------------------------------------------------------------------------------
// 2.0: the service catalog and appointments (siosia-spec-v2.0.md §4–§12)
// ---------------------------------------------------------------------------------------------

export interface LocalText {
  en: string;
  pl: string;
}

/** One catalog entry (deployment configuration). Exactly one has kind "ride" (id "ride"). */
export interface CatalogEntry {
  id: string;
  kind: "ride" | "time";
  name: LocalText;
  description: LocalText;
  /** An emoji or a profile-icon id. */
  icon: string;
  /** Minutes; "time" entries only. */
  duration: { default: number; min: number; max: number; step: number } | null;
  /** Shown and frozen on the appointment; never charged. */
  price: null | { perHour: number } | { fixed: number };
  needsPlace: boolean;
  enabled: boolean;
}

/** A person as other users see them in 2.0 lists: never the auth user id (FR-143). */
export interface PublicProvider extends PublicParty {
  publicId: string | null;
}

export interface CatalogItem extends CatalogEntry {
  /** Who offers it (not the viewer); empty for the ride entry. */
  providers: PublicProvider[];
}

export interface AppointmentSettings {
  /** Reminder slots, minutes before the start (default 1440 and 120). */
  reminderMin: number[];
  seriesMaxDays: number;
  seriesMaxCount: number;
}

export type AppointmentStatus = "requested" | "accepted" | "declined" | "cancelled" | "expired" | "done";
export type Leg = "there" | "back";
export type PartyRole = "client" | "provider";
/** 2.1: the viewer's side of an appointment; "candidate" = a member who could take an open request. */
export type ViewerRole = PartyRole | "candidate";
/** An attached ride as the appointment sees it (§7 rule 7). */
export type AttachedStatus = "pending" | "confirmed" | "done" | "failed";

export interface CalendarLinks {
  /** Google Calendar event template (built in the client). */
  google: string | null;
  /** The viewer's .ics link (null without the calendar function; the demo builds the file itself). */
  ics: string | null;
}

export interface AttachedRide {
  rideId: string;
  leg: Leg;
  passenger: PartyRole;
  /** The viewer is the passenger (pickup, dropoff and fare are shown only then — FR-114). */
  mine: boolean;
  scheduledFor: number | null;
  status: AttachedStatus;
  driver: { nickname: string; icon?: string | null } | null;
  pickup?: Place;
  dropoff?: Place;
  fare?: number;
  currency?: string;
}

export interface RideTemplate {
  passenger: PartyRole;
  leg: Leg;
  /** From the start ("there", negative) or from the end ("back"). */
  offsetMin: number;
  mine: boolean;
  pickup?: Place;
  dropoff?: Place;
  estKm?: number;
  estMin?: number;
  fareIsEstimate?: boolean;
}

export interface SeriesView {
  id: string;
  rule: "weekly" | "biweekly";
  /** This occurrence's number (1…count). */
  seq: number;
  count: number;
  /** Start of the last occurrence. */
  until: number;
  status: "requested" | "answered" | "cancelled" | "expired";
  /** Future occurrences still requested or accepted. */
  remaining: number;
  /** Starts of the occurrences declined on answer (clashes). */
  declined: number[];
  /** Starts of declined or cancelled occurrences (calendar exclusions). */
  gaps: number[];
  /** Every occurrence's start, in order. */
  starts: number[];
  rideTemplates: RideTemplate[];
  ics: string | null;
}

export interface AppointmentView {
  id: string;
  status: AppointmentStatus;
  /** The viewer's side (a candidate sees an open request someone else made). */
  role: ViewerRole;
  /**
   * 2.1: an open request — sent to anyone in the group, nobody has taken it yet (provider null).
   * Only while requested; taking it makes the taker the provider and accepts it.
   */
  open: boolean;
  serviceId: string;
  /** The entry's name and icon (also for disabled entries). */
  service: { name: LocalText; icon: string } | null;
  /** Wall-clock start as picked (ms). */
  startsAt: number;
  durationMin: number;
  endsAt: number;
  place: Place | null;
  note: string;
  price: number | null;
  currency: string;
  client: PublicProvider;
  /** null while the request is open (nobody took it yet). */
  provider: PublicProvider | null;
  requestedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  cancelledBy: "client" | "provider" | "system" | null;
  cancelReason: string | null;
  rides: AttachedRide[];
  /** Reminder slots already sent. */
  reminders: number[];
  myRating: number | null;
  series: SeriesView | null;
  calendar: CalendarLinks;
}

export interface RepeatInput {
  /** Every week (1) or every 2 weeks (2). */
  every: 1 | 2;
  count?: number;
  /** Last date (ms; occurrences on or before that local date). */
  until?: number;
}

export interface ServiceRequestInput {
  serviceId: string;
  /** The provider's public id; null = an open request to anyone in the group (2.1). */
  providerId: string | null;
  startsAt: number;
  durationMin: number;
  place: Place | null;
  note: string;
  repeat?: RepeatInput;
}

export interface RideTemplateInput {
  leg: Leg;
  pickup: Place;
  dropoff: Place;
  offsetMin: number;
  estKm: number;
  estMin: number;
  fareIsEstimate: boolean;
}

/** Everything upcoming in both roles (P1). */
export interface Planned {
  appointments: AppointmentView[];
  rides: RideView[];
  /**
   * 2.1: open requests of other members this user could take (role "candidate"), soonest first;
   * a series appears once, as its first open date.
   */
  open: AppointmentView[];
}

export type HistoryItem = { kind: "appointment"; at: number; appointment: AppointmentView } | { kind: "ride"; at: number; ride: RideView };

export interface NextPlanned {
  kind: "appointment" | "ride";
  at: number;
  /** The service's name in the user's language. */
  title: string;
  serviceId: string;
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
  /** Web Push public key made by the server's push sender (null until it first ran). */
  vapidPublicKey?: string | null;
  /** 2.0: the enabled catalog entries. */
  services: CatalogEntry[];
  appointment: AppointmentSettings;
  /** The calendar Edge Function (null = Google Calendar only; the demo builds .ics itself). */
  calendarUrl: string | null;
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
  /** 2.1: the paint as #rrggbb (chosen with the car icon); the car icon is drawn in it. */
  paint?: string | null;
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
  /** 2.0: what others see instead of the user id. */
  publicId: string | null;
  /** Catalog entries (kind "time") this person offers. */
  offers: string[];
  /** A master profile presets the offers (the toggles are hidden). */
  offersPreset: boolean;
  /** My place: the default appointment place and ride pickup. */
  home: Place | null;
}

export interface PublicParty {
  nickname: string;
  rating: RatingSummary;
  /** Profile icon id, shown next to the nickname (master profiles only). */
  icon?: string | null;
  /** 2.1: the paint of this person's car (#rrggbb), so a car icon is drawn in it everywhere. */
  paint?: string | null;
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
  /** 2.2: when the driver's car first moved towards a booked pickup (the rider is told). */
  departedAt: number | null;
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
  /** 2.0: the appointment this ride belongs to — only for its rider (a driver sees a plain booking). */
  appointmentId?: string | null;
  leg?: Leg | null;
  calendar?: CalendarLinks;
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
  /** 2.0: requests waiting for my answer (a series counts once). */
  toAnswer: number;
  /** 2.1: open requests of others I could take (a series counts once). */
  openRequests: number;
  /** Upcoming items in both roles. */
  planned: number;
  nextPlanned: NextPlanned | null;
}

/** A ride booked for later. */
export interface BookingInput extends RideRequestInput {
  /** Pickup time (wall-clock ms, as picked). */
  scheduledFor: number;
  /** 2.0: as part of an appointment (the caller is the passenger). */
  appointmentId?: string | null;
  leg?: Leg | null;
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
  | "unavailable"
  | "bad_service"
  | "not_offered"
  | "no_provider"
  | "bad_duration"
  | "not_accepted"
  | "bad_leg"
  | "ride_exists"
  | "bad_repeat";

export class ServerError extends Error {
  readonly code: ServerErrorCode;
  constructor(code: ServerErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ServerError";
  }
}
