import type { RideStatus, Role } from "./types";

/**
 * Ride lifecycle (spec §5). Every transition is validated here (mock backend) and in the SQL
 * functions (Supabase), so a stale client can never move a ride backwards or skip a step.
 */
export type Transition =
  | { from: "scheduled"; to: "accepted"; by: "system"; action: "start_booking" }
  | { from: "scheduled"; to: "requested"; by: "system"; action: "open_booking" }
  | { from: "scheduled"; to: "cancelled"; by: "rider"; action: "cancel" }
  | { from: "scheduled"; to: "expired"; by: "system"; action: "expire" }
  | { from: "requested"; to: "accepted"; by: "driver"; action: "accept" }
  | { from: "requested"; to: "expired"; by: "system"; action: "expire" }
  | { from: "requested"; to: "cancelled"; by: "rider"; action: "cancel" }
  | { from: "accepted"; to: "arrived"; by: "driver"; action: "arrive" }
  | { from: "accepted"; to: "requested"; by: "driver"; action: "driver_cancel" }
  | { from: "accepted"; to: "cancelled"; by: "rider"; action: "cancel" }
  | { from: "arrived"; to: "in_progress"; by: "driver"; action: "start" }
  | { from: "arrived"; to: "cancelled"; by: "rider"; action: "cancel" }
  | { from: "arrived"; to: "cancelled"; by: "driver"; action: "no_show" }
  | { from: "arrived"; to: "requested"; by: "driver"; action: "driver_cancel" }
  | { from: "in_progress"; to: "completed"; by: "driver"; action: "complete" };

export type Action = Transition["action"];

export const TRANSITIONS: readonly Transition[] = [
  { from: "scheduled", to: "accepted", by: "system", action: "start_booking" },
  { from: "scheduled", to: "requested", by: "system", action: "open_booking" },
  { from: "scheduled", to: "cancelled", by: "rider", action: "cancel" },
  { from: "scheduled", to: "expired", by: "system", action: "expire" },
  { from: "requested", to: "accepted", by: "driver", action: "accept" },
  { from: "requested", to: "expired", by: "system", action: "expire" },
  { from: "requested", to: "cancelled", by: "rider", action: "cancel" },
  { from: "accepted", to: "arrived", by: "driver", action: "arrive" },
  { from: "accepted", to: "requested", by: "driver", action: "driver_cancel" },
  { from: "accepted", to: "cancelled", by: "rider", action: "cancel" },
  { from: "arrived", to: "in_progress", by: "driver", action: "start" },
  { from: "arrived", to: "cancelled", by: "rider", action: "cancel" },
  { from: "arrived", to: "cancelled", by: "driver", action: "no_show" },
  { from: "arrived", to: "requested", by: "driver", action: "driver_cancel" },
  { from: "in_progress", to: "completed", by: "driver", action: "complete" }
];

export function findTransition(from: RideStatus, action: Action, by: Role | "system"): Transition | null {
  return TRANSITIONS.find((t) => t.from === from && t.action === action && t.by === by) ?? null;
}

export function canTransition(from: RideStatus, to: RideStatus, by?: Role | "system"): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && (by === undefined || t.by === by));
}

export const isActive = (s: RideStatus) =>
  s === "requested" || s === "accepted" || s === "arrived" || s === "in_progress";

export const isTerminal = (s: RideStatus) => s === "completed" || s === "cancelled" || s === "expired";

/** Rider may cancel while requested, accepted or arrived (FR-016). */
export const riderCanCancel = (s: RideStatus) => s === "requested" || s === "accepted" || s === "arrived";

/** Rider live position may be sent in these statuses (FR-040); it always stops at in_progress. */
export const riderMayShare = (s: RideStatus) => s === "requested" || s === "accepted" || s === "arrived";

/** Driver live position goes to the rider in these statuses. */
export const driverShares = (s: RideStatus) => s === "accepted" || s === "arrived" || s === "in_progress";
