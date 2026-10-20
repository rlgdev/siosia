import type { DeploymentConfig } from "./types";

/**
 * Defaults (FR-050 tariff, §5 timers, §6 dispatch radius, Q3 max trip, Q6 tariff). The request
 * expiry is 20 min instead of the spec's 3 min (operator decision, 2026-10-10); with requests open
 * that long, a driver who missed a card gets it again after 2 min.
 */
export const DEFAULT_CONFIG: DeploymentConfig = {
  tariff: { base: 5, perKm: 2.5, perMin: 0.5, minimum: 10, currency: "PLN" },
  timers: { offerS: 20, expiryS: 1200, noShowS: 300, retryS: 120 },
  booking: { minLeadMin: 30, maxDays: 30, leadMin: 30, openMin: 20 },
  serviceArea: null,
  dispatchRadiusKm: 8,
  maxTripKm: 50,
  timezone: "Europe/Warsaw",
  standbyHours: 4,
  operatorContact: ""
};

/** Internal server constants (not deployment config). Mirrored in supabase/migrations. */
export const SERVER = {
  /** A driver whose heartbeat is older than this gets no offers and loses open ones. */
  driverStaleS: 12,
  /** An idle driver silent this long is set offline; on a ride, the driver counts as silent. */
  driverLostS: 60,
  /**
   * An accepted/arrived ride whose driver is silent this long is re-dispatched (§12 says 60 s).
   * An iPhone pauses Siosia whenever its screen locks or another app (Maps) is in front, so a
   * driver on the way to the pickup is often silent for minutes.
   */
  rideDriverLostS: 15 * 60,
  /** Receipt actions (paid, collected, rating) allowed this long after completion. */
  afterRideWindowS: 24 * 3600,
  /** pendingReceipt shows completed rides that ended within this window. */
  pendingReceiptS: 2 * 3600,
  historyLimit: 50,
  /** A "move to the app" code works this long, once. */
  transferS: 30 * 60,
  /** A booking whose people are still busy gives up this long after its time. */
  bookingLateS: 15 * 60,
  /** A driver who heartbeated this recently has the app in front (no standby notification). */
  activeAppS: 6,
  /** Open bookings per rider. */
  maxBookings: 5,
  /** New bookings per rider per day (each one notifies drivers). */
  maxBookingsPerDay: 10,
  /** Cancelling / releasing a booking closer than this to its time counts as a cancellation. */
  lateBookingChangeS: 60 * 60,
  ratingWindow: 20,
  ratingMinCount: 3
} as const;

/** Client cadences (FR-021, FR-018, D-03). */
export const CADENCE = {
  /** Live position to the other party / matching: at most every 3 s or 25 m. */
  livePosMs: 3000,
  livePosM: 25,
  /** A stationary device still refreshes the other party at least this often (FR-034). */
  keepAliveMs: 5000,
  /** Nearby-cars presence: at most every 30 s or 200 m. */
  presenceMs: 30_000,
  presenceM: 200,
  /** Driver heartbeat to the matching service while online. */
  heartbeatMs: 4000,
  /** Rider state poll while a ride is active (backs up realtime events, runs expiry on read). */
  pollActiveMs: 5000,
  /** Routing: ≤ 1 request/s per device, ≤ 1 route refresh per 10 s during a trip. */
  routeMinGapMs: 1000,
  routeTripRefreshMs: 10_000,
  /** Re-route when the car deviates by more than this from the route line. */
  routeDeviationM: 100,
  /** Marker turns to "last seen" after this long without updates. */
  staleMarkerMs: 10_000
} as const;
