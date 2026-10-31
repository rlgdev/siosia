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
  /** 2.8 (FR-304): "yolo" = a special event of the YOLO section; absent/null = a regular entry. */
  section?: "yolo" | null;
  /** 2.8 (FR-305): the entry it takes after — who offers that one offers this, its contract rate prices it. */
  base?: string | null;
  /** 2.8 (FR-306): the yearly day ("MM-DD") a YOLO event sorts by; null = any time. */
  date?: string | null;
  /** 2.8: when it is, in words ("31 Oct", "Any time"). */
  when?: LocalText | null;
}

/** A person as other users see them in 2.0 lists: never the auth user id (FR-143). */
export interface PublicProvider extends PublicParty {
  publicId: string | null;
}

export interface CatalogItem extends CatalogEntry {
  /** Who offers it (not the viewer); empty for the ride entry. */
  providers: CatalogProvider[];
}

/** 2.6 (FR-262): a provider in the catalog, with the viewer's family's contract rate for this entry. */
export interface CatalogProvider extends PublicProvider {
  /** Per hour, from an active contract between the viewer's family and this provider; null = none. */
  contractRate?: number | null;
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
/** 2.1: the viewer's side of an appointment; "candidate" = a member who could take an open request.
 *  2.6 (FR-254): "family" = a member of the family of one of the parties (read-only). */
export type ViewerRole = PartyRole | "candidate" | "family";
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
  /**
   * 2.3: the client's kids attached to this appointment — full cards for the client and the
   * provider, an empty list with `kidCount` for a candidate (FR-202).
   */
  kids: AttachedKid[];
  kidCount: number;
  /** Unread chat messages in this appointment's room (accepted appointments). */
  unread: number;
  /** 2.5 (FR-230–233): how many session updates the feed holds (the two parties; a candidate 0). */
  updateCount: number;
  /** 2.5: posting to the feed is allowed right now (30 min before the start … 7 days after the end). */
  feedOpen: boolean;
  /** 2.5 (FR-240–241): the client said they are heading home — when, and when they expect to be there. */
  coming: { at: number; etaAt: number } | null;
  /** 2.6 (FR-270): the rate per hour the price came from (contract or price list); null = fixed or none. */
  rate: number | null;
  /** 2.6 (FR-262): the contract that set the price, if any. */
  contractId: string | null;
  /** 2.13: the price is the client's custom payment (kept as set: no contract reprices it). */
  customPrice: boolean;
  /** 2.6 (FR-272): the provider's correction of the time, in minutes; null = as booked. */
  actualMin: number | null;
  /** 2.6 (FR-270): what it cost — done appointments only (parties and family). */
  cost: CostSummary | null;
  /** 2.9 (FR-314): the client side's tip to the provider (parties and families). */
  tip: { amount: number; by: string; at: number } | null;
  /** 2.6 (FR-254): role "family" — whose appointment this is (that member's side and nickname). */
  family: { side: PartyRole; member: string } | null;
}

/** 2.6 (FR-270): the summary of a done appointment. */
export interface CostSummary {
  /** The time counted: the provider's correction, else the booked duration. */
  minutes: number;
  rate: number | null;
  /** null = no price agreed. */
  total: number | null;
  currency: string;
  source: "contract" | "catalog" | "fixed" | "custom" | "none";
  corrected: boolean;
}

/** 2.9 (FR-311): one kept notification; the app words it with pushText and opens pushUrl. */
export interface NotificationItem {
  id: string;
  kind: import("../../supabase/functions/_shared/push-text").PushKind;
  params: import("../../supabase/functions/_shared/push-text").PushParams;
  rideId: string | null;
  appointmentId: string | null;
  createdAt: number;
  read: boolean;
}

// ---------- 2.6: family, contracts, weekly reports ----------

export interface FamilyMember extends PublicProvider {
  me: boolean;
  joinedAt: number;
}

export interface FamilyInvite {
  id: string;
  from: PublicProvider;
  to: PublicProvider;
  createdAt: number;
  expiresAt: number;
}

/** My family (FR-250–252): id null = none yet; invites I (or my family) sent and those waiting for me. */
export interface FamilyView {
  id: string | null;
  members: FamilyMember[];
  invites: FamilyInvite[];
  incoming: FamilyInvite[];
}

export interface ContractRate {
  serviceId: string;
  perHour: number;
}

export type ContractStatus = "proposed" | "active" | "declined" | "withdrawn" | "ended" | "replaced";

/** A contract as one of its sides sees it (FR-260–264). */
export interface ContractView {
  id: string;
  version: number;
  status: ContractStatus;
  /** The viewer's side. */
  side: "family" | "provider";
  provider: PublicProvider;
  /** The family's members by nickname. */
  family: string[];
  /** Whom new rates would be proposed to: the provider, or (for the provider) the family's first member; null = nobody left. */
  to: string | null;
  rates: ContractRate[];
  note: string;
  currency: string;
  /** Proposed by the viewer's side. */
  proposedByMe: boolean;
  /** Waiting for the viewer's side to accept or decline. */
  canAnswer: boolean;
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
}

export interface ContractInput {
  /** The other side: a provider (as "family") or a member I serve (as "provider"), by public id. */
  to: string;
  as: "family" | "provider";
  rates: ContractRate[];
  note?: string;
}

/** One line of a weekly report: the other side, a service, how many, how long, how much. */
export interface ReportLine {
  who: string;
  serviceId: string;
  count: number;
  minutes: number;
  total: number;
  /** 2.11 (FR-321): the part of it not paid yet (between different sides only). */
  due: number;
}

export interface ReportSide {
  total: number;
  services: ReportLine[];
  servicesTotal: number;
  rides: { count: number; total: number; due: number };
  /** 2.9 (FR-316): tips given (spent) or received (earned) — part of the total. */
  tips: number;
}

/** 2.6 (FR-280–281): one week, Monday to Sunday in the deployment's timezone. */
export interface WeeklyReport {
  /** The Monday, "YYYY-MM-DD". */
  week: string;
  weekStart: number;
  weekEnd: number;
  scope: "me" | "family";
  /** The viewer is in a family with someone else (the Family switch shows). */
  hasFamily: boolean;
  currency: string;
  spent: ReportSide;
  earned: ReportSide;
  net: number;
  /** Family scope: one line per current member. */
  members: { nickname: string; spent: number; earned: number }[] | null;
  /** 2.11 (FR-321): what is still to pay between my side and each other side — of every week shown. */
  due: DueLine[];
  /** 2.11 (FR-324): my side's settlements of the last 90 days, newest first (10 at most). */
  settlements: SettlementView[];
}

/** 2.11: money one way between two sides — for services (with their tips) and for rides (with theirs). */
export interface DueSplit {
  services: number;
  rides: number;
}

/**
 * 2.11 (FR-321, V78): between my side (my family, else me on all my phones) and another side — the
 * unpaid done appointments and completed rides from the oldest week a report shows.
 */
export interface DueLine {
  /** A public id on that side: the reminder and dobry Pancio go there. */
  party: string;
  /** That side's names ("Roman, Anna" for a family). */
  who: string;
  theyOwe: DueSplit;
  weOwe: DueSplit;
  /** What they owe us minus what we owe them: above 0 they pay, below 0 we pay. */
  net: number;
  count: number;
  /** The oldest unpaid one (ms). */
  since: number;
  /** My side's last reminder to them (ms), if any. */
  remindedAt: number | null;
}

/** 2.11 (FR-323, FR-324): one dobry Pancio, as my side sees it. */
export interface SettlementView {
  id: string;
  at: number;
  /** Who pressed it; whether that was my side. */
  by: string;
  mine: boolean;
  /** The other side's names. */
  who: string;
  /** "in": they paid us; "out": we paid them; "even": the two ways cancelled out. */
  direction: "in" | "out" | "even";
  amount: number;
  count: number;
  comment: { text: string; by: string; at: number } | null;
  /** The side that got the notification may comment once, within 30 days. */
  canComment: boolean;
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
  /** 2.3: the client's kids to attach (ids of their own kids); a series: to every occurrence. */
  kidIds?: string[];
  startsAt: number;
  durationMin: number;
  place: Place | null;
  note: string;
  repeat?: RepeatInput;
  /**
   * 2.13: a custom payment the client sets for each occurrence (a total, not per hour) instead of
   * the rate (contract or price list; a YOLO event: the Childcare rate). null/absent = the rate.
   */
  customPrice?: number | null;
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
  /**
   * 2.12 (FR-326, FR-329): "anonymous" = a phone may still start with an anonymous session (the
   * migration window); "accounts" = only a signed-in account (email code or Google) may use Siosia.
   * The demo is always "anonymous" — it never shows a sign-in screen.
   */
  authMode?: AuthMode;
  /** 2.12: "Send me a code" is offered (the operator switches it on once the mail sender works). */
  emailSignIn?: boolean;
  /** 2.12: where "Continue with Google" is offered (standalone = the installed Home Screen app). */
  googleSignIn?: GoogleSignIn;
  /** 2.12 (FR-329): "invite" = the invite code or a #join= link makes a member; "open" = every signed-in account. */
  membershipMode?: MembershipMode;
}

export type AuthMode = "anonymous" | "accounts";
export type GoogleSignIn = "off" | "no_standalone" | "no_ios" | "on";
export type MembershipMode = "invite" | "open";

/** 2.12 (V81): who this session is to Siosia — what the app shows next (sign in, invite, the app). */
export interface WhoAmI {
  member: boolean;
  hasProfile: boolean;
  /** An anonymous Supabase session (always false in the demo). */
  anonymous: boolean;
  /** An anonymous session while the deployment asks for accounts: show the sign-in screen. */
  signInRequired: boolean;
  /** This account was merged into another (its public id): the phone must sign in. */
  mergedInto: string | null;
  /** My live profile's public id (null without one). */
  publicId: string | null;
  sandbox: boolean;
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
  /** 2.3: my photo as a signed URL (≤ 1 h), or null. */
  photo: string | null;
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
  /** 2.3: a signed URL of this person's photo (≤ 1 h) for a viewer allowed to see them; null = none. */
  photo?: string | null;
}

// ---------- 2.3: kids, photos, chat ----------

/** A kid as its owner sees it (S2 → My kids). */
export interface Kid {
  id: string;
  name: string;
  /** Signed URL (≤ 1 h) or null. */
  photo: string | null;
  bornYear: number | null;
  note: string;
  rating: RatingSummary;
  /** Every rating this kid got, newest first (owner only). */
  ratings: KidRatingView[];
  /** 2.6 (FR-253): who added the kid (a family's kids are shared), and whether that is me. */
  ownerNickname: string;
  mine: boolean;
}

export interface KidInput {
  name: string;
  bornYear: number | null;
  note: string;
}

export interface KidRatingView {
  appointmentId: string;
  /** The provider who rated, by nickname. */
  by: string;
  stars: number;
  comment: string;
  at: number;
}

/** A kid as the provider of an appointment sees it (FR-202). */
export interface AttachedKid {
  id: string;
  name: string;
  photo: string | null;
  /** Age in years from the year of birth, or null. */
  age: number | null;
  note: string;
  rating: RatingSummary;
  /** The viewer's own rating of this kid for this appointment, once given. */
  myRating: number | null;
}

/** A chat room: a ride with its driver, or an accepted appointment. */
export type ChatRoom = `ride:${string}` | `appt:${string}`;

export interface ChatMessage {
  id: string;
  room: ChatRoom;
  /** True when the viewer sent it. */
  mine: boolean;
  text: string;
  sentAt: number;
  /** When the other party read it (own messages), or when I read it. */
  readAt: number | null;
}

export interface ChatThread {
  room: ChatRoom;
  /** The other party, as the viewer may see them. */
  other: PublicParty;
  messages: ChatMessage[];
  /** Sending still allowed (live, or within 24 h after the end). */
  open: boolean;
  unread: number;
}

/** Unread counts per room the viewer belongs to (badges). */
export type ChatUnread = Record<string, number>;

/** 2.5 (FR-230): one session update as a party sees it. */
export interface SessionUpdate {
  id: string;
  appointmentId: string;
  author: PublicParty;
  /** True when the viewer posted it. */
  mine: boolean;
  /** The kid it is about (null = everyone); the name as it was when posted. */
  kid: { id: string | null; name: string } | null;
  text: string;
  /** A signed URL (demo: a data URL), or null. */
  photo: string | null;
  createdAt: number;
}

/** 2.5: the feed of one appointment (FR-231). */
export interface SessionFeed {
  appointmentId: string;
  /** Posting still allowed (30 min before the start … 7 days after the end, accepted or done). */
  open: boolean;
  items: SessionUpdate[];
}

/** 2.5: what a party posts — a text (may be empty with a photo) about one attached kid or everyone. */
export interface UpdateInput {
  text: string;
  kidId: string | null;
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
  /** 2.3: unread chat messages in this ride's room (once a driver is assigned). */
  unread?: number;
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
  /** 2.9 (FR-315): the rider's tip to the driver (the two parties). */
  tip?: number | null;
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
  /** 2.3: unread chat messages across my rooms. */
  unreadChats: number;
  /** 2.6: family invitations to me and contract proposals waiting for my side's answer. */
  familyPending: number;
  /** 2.9 (FR-312): unread notifications (the bell's badge). */
  unreadNotifications: number;
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
  | "bad_repeat"
  // 2.6
  | "in_family"
  | "family_full"
  // 2.9
  | "already_tipped"
  // 2.12 accounts
  | "sign_in_required"
  | "account_merged"
  | "already_merged"
  | "other_realm"
  | "two_families"
  | "two_masters"
  | "merge_conflict"
  | "bad_code"
  | "email_not_allowed"
  | "sign_in_instead"
  | "use_merge"
  | "code_wait";

export class ServerError extends Error {
  readonly code: ServerErrorCode;
  constructor(code: ServerErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ServerError";
  }
}
