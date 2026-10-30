// Siosia server rules in TypeScript.
//
// This is the reference implementation of the server-side logic (spec §5 lifecycle, §6 dispatch,
// §7 guards). The mock backend runs it in the browser over localStorage; the Supabase backend runs
// the SQL twin in supabase/migrations/0001_siosia.sql. Unit and integration tests target this file,
// so any rule change must be made in BOTH places.
//
// Dispatch model ("ping + pull"): a new or re-dispatched request pings every online driver over
// realtime WITHOUT data; each driver's device answers with a heartbeat carrying its current coarse
// position as a parameter; the server creates an offer when that driver is eligible (§6). Driver
// positions are therefore never stored (FR-043) — they exist only as call arguments.

import type { PushKind, PushParams } from "../../supabase/functions/_shared/push-text";
import { DEFAULT_CONFIG, SERVER } from "./defaults";
import { computeFare } from "./fare";
import { haversineKm, isValidLatLng } from "./geo";
import { isActive } from "./lifecycle";
import { summarizeRatings } from "./rating";
import { addDays, addWeeksWallClock, localDate, localMidnight, weekOf } from "./time";
import {
  ServerError,
  type AppointmentStatus,
  type AppointmentView,
  type AttachedKid,
  type AttachedRide,
  type AttachedStatus,
  type CatalogEntry,
  type CatalogItem,
  type CatalogProvider,
  type ChatMessage,
  type ContractInput,
  type ContractRate,
  type ContractStatus,
  type ContractView,
  type CostSummary,
  type FamilyInvite,
  type NotificationItem,
  type FamilyView,
  type ReportLine,
  type ReportSide,
  type DueLine,
  type SettlementView,
  type WeeklyReport,
  type ChatRoom,
  type ChatThread,
  type SessionFeed,
  type SessionUpdate,
  type UpdateInput,
  type HistoryItem,
  type Kid,
  type KidInput,
  type Leg,
  type PartyRole,
  type Planned,
  type PublicParty,
  type PublicProvider,
  type RideTemplateInput,
  type ServiceRequestInput,
  type BookingInput,
  type DeploymentConfig,
  type DriverCancelReason,
  type Earnings,
  type LatLng,
  type Lang,
  type MyState,
  type OfferStatus,
  type OfferView,
  type OpenBooking,
  type Place,
  type Profile,
  type RatingSummary,
  type RideRequestInput,
  type RideStatus,
  type RideView,
  type CancelledBy,
  type Vehicle,
  type ViewerRole,
  type ServerErrorCode,
  type WhoAmI
} from "./types";

export interface UserRow {
  id: string;
  nickname: string;
  language: Lang;
  createdAt: number;
  riderCancels: number;
  driverCancels: number;
  lateCancels: number;
  deleted: boolean;
  /** Shared master profile this user joined through its link (rider only). */
  masterId?: string | null;
  /** 2.0: random id others see (never the user id), offered entries, My place. */
  publicId?: string;
  offers?: string[];
  home?: Place | null;
  /** 2.3: the photo's object path (never a URL — V46); null = none. */
  photoPath?: string | null;
  /** 2.9 (V72): when this phone last fetched its state (at most once a minute) — picks a master's phone in use. */
  seenAt?: number | null;
  /** 2.12 (FR-327): merged into this account — frozen (account_merged), its phone signs in. */
  mergedInto?: string | null;
}

/**
 * A master profile: a shared identity opened by a dedicated link. Every device that opens the link
 * becomes this profile (nickname, icon) in one role — a rider profile rides only, every ride at
 * `fixedFare`, starting from `pickup` / `dropoff`; a driver profile drives only, with `vehicle`.
 * (Supabase keeps these in master_profiles with only a hash of the token.)
 */
export interface MasterProfile {
  id: string;
  token: string;
  nickname: string;
  icon: string | null;
  fixedFare: number | null;
  /** Switched off: the link stops working, phones that joined only through it lose access. */
  active?: boolean;
  /** Default "rider". */
  role?: "rider" | "driver";
  pickup?: Place | null;
  dropoff?: Place | null;
  vehicle?: (Omit<Vehicle, "plate"> & { plate?: string }) | null;
  /** 2.0: catalog entries every phone on this profile offers (null = none besides rides). */
  offers?: string[] | null;
  /** 2.12 (FR-328): false = the link lets no new phone in; the profile and its phones stay. Default true. */
  joinable?: boolean;
}

/** Master profiles of the in-browser demo (links: …?backend=mock#master=demo-master / demo-roman). */
export const DEMO_MASTERS: MasterProfile[] = [
  {
    id: "master",
    token: "demo-master",
    nickname: "Toria",
    icon: null,
    fixedFare: 18,
    role: "rider",
    pickup: { lat: 52.2504843, lng: 20.8253459, label: "Warszawsa 269, Stare Babice" },
    dropoff: { lat: 52.2663135, lng: 20.814317, label: "Husarska 16, Lipków" }
  },
  {
    id: "roman",
    token: "demo-roman",
    nickname: "Roman",
    icon: "taycan-ct-green",
    fixedFare: null,
    role: "driver",
    vehicle: { make: "Porsche", model: "Taycan Cross Turismo", colour: "Zielony", seats: 4 }
  }
];

export interface DriverRow {
  online: boolean;
  lastSeen: number;
  /** Standby: new requests are notified until then, even after the app went quiet. */
  standbyUntil?: number | null;
}

export interface RideRow {
  id: string;
  riderId: string;
  driverId: string | null;
  status: RideStatus;
  pickup: Place;
  dropoff: Place;
  estKm: number;
  estMin: number;
  fare: number;
  currency: string;
  fareIsEstimate: boolean;
  actualKm: number | null;
  actualMin: number | null;
  requestedAt: number;
  dispatchStartedAt: number;
  acceptedAt: number | null;
  departedAt?: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  cancelledBy: CancelledBy | null;
  cancelReason: string | null;
  paid: boolean;
  collected: boolean;
  notifiedCount: number;
  redispatchCount: number;
  round: number;
  /** Drivers who cancelled this ride; they never get it again (§6). */
  excluded: string[];
  /** Booked pickup time for a ride booked in advance (status "scheduled" until it starts). */
  scheduledFor?: number | null;
  /** 2.0: part of an appointment (leg there / back); made by a series template; last summary. */
  appointmentId?: string | null;
  leg?: Leg | null;
  autoBooked?: boolean;
  apptSummary?: AttachedStatus | null;
  /** 2.9 (FR-315): the rider's tip to the driver, and when. */
  tip?: number | null;
  tipAt?: number | null;
  /** 2.11 (FR-323): paid by a dobry Pancio — when, which, and how much it came to then. */
  settledAt?: number | null;
  settlementId?: string | null;
  settledAmount?: number | null;
}

/** 2.0: an appointment (one occurrence of a series, or a single one). */
export interface ApptRow {
  id: string;
  clientId: string;
  /** 2.1: null = an open request nobody has taken yet (V34). */
  providerId: string | null;
  serviceId: string;
  status: AppointmentStatus;
  startsAt: number;
  durationMin: number;
  place: Place | null;
  note: string;
  price: number | null;
  currency: string;
  requestedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  cancelledBy: "client" | "provider" | "system" | null;
  cancelReason: string | null;
  /** Reminder slots already sent. */
  reminded: number[];
  seriesId: string | null;
  seq: number | null;
  /** 2.5 (FR-240): the client's heading-home notice — when they said so and when they expect to be there. */
  comingAt?: number | null;
  etaAt?: number | null;
  /** 2.6 (FR-262, FR-270–272): the rate per hour the price came from, its contract, the provider's
   *  correction of the time, and whether the summary was announced. */
  rate?: number | null;
  contractId?: string | null;
  actualMin?: number | null;
  summarySent?: boolean;
  /** 2.9 (FR-314): the client side's tip to the provider — how much, who gave it, when. */
  tip?: number | null;
  tipBy?: string | null;
  tipAt?: number | null;
  /** 2.11 (FR-323): paid by a dobry Pancio — when, which, and how much it came to then. */
  settledAt?: number | null;
  settlementId?: string | null;
  settledAmount?: number | null;
}

export interface StoredTemplate {
  passenger: PartyRole;
  leg: Leg;
  pickup: Place;
  dropoff: Place;
  offsetMin: number;
  estKm: number;
  estMin: number;
  fareIsEstimate: boolean;
}

/** 2.0: a repeating request; its occurrences are ApptRows with seriesId and seq. */
export interface SeriesRow {
  id: string;
  clientId: string;
  /** 2.1: null while the series is an open request. */
  providerId: string | null;
  serviceId: string;
  rule: "weekly" | "biweekly";
  firstStart: number;
  durationMin: number;
  count: number;
  until: number;
  place: Place | null;
  note: string;
  price: number | null;
  currency: string;
  status: "requested" | "answered" | "cancelled" | "expired";
  rideTemplates: StoredTemplate[];
  templatesAt: number | null;
  requestedAt: number;
  answeredAt: number | null;
}

export interface OfferRow {
  id: string;
  rideId: string;
  driverId: string;
  round: number;
  status: OfferStatus;
  createdAt: number;
  offeredAt: number | null;
  decidedAt: number | null;
  driverDistanceKm: number;
}

export interface RatingRow {
  /** Exactly one of rideId / appointmentId. */
  rideId?: string;
  appointmentId?: string;
  fromUser: string;
  toUser: string;
  stars: number;
  comment: string;
  createdAt: number;
}

/** 2.3: a kid's profile — an owner-only row (FR-200); the photo is an object path, never a URL. */
export interface KidRow {
  id: string;
  ownerId: string;
  name: string;
  photoPath: string | null;
  bornYear: number | null;
  note: string;
  createdAt: number;
}

/** 2.3: the provider's rating of a kid attached to a done appointment (one per appointment and kid). */
export interface KidRatingRow {
  appointmentId: string;
  kidId: string;
  fromUser: string;
  stars: number;
  comment: string;
  createdAt: number;
}

/** 2.3: a chat message; the room is ride:<id> or appt:<id> (FR-220). */
export interface MessageRow {
  id: string;
  room: ChatRoom;
  sender: string;
  text: string;
  sentAt: number;
  readAt: number | null;
}

/** 2.5 (FR-230): a session update (Supabase: appointment_updates). */
export interface UpdateRow {
  id: string;
  appointmentId: string;
  author: string;
  /** The kid it is about (null = everyone) — the row, and the name as it was when posted. */
  kidId: string | null;
  kidName: string | null;
  text: string;
  photoPath: string | null;
  createdAt: number;
}

/** 2.6 (FR-250): a family (Supabase: families; its people in family_members). */
export interface FamilyRow {
  id: string;
  createdAt: number;
}

/** 2.6 (FR-250): an invitation into a family. */
export interface FamilyInviteRow {
  id: string;
  familyId: string;
  fromUser: string;
  toUser: string;
  status: "pending" | "joined" | "declined" | "withdrawn" | "expired";
  createdAt: number;
  answeredAt: number | null;
}

/** 2.6 (FR-260): rates per hour agreed between a family and a provider. */
export interface ContractRow {
  id: string;
  familyId: string;
  providerId: string;
  version: number;
  status: ContractStatus;
  rates: ContractRate[];
  note: string;
  currency: string;
  proposedBy: string;
  /** Which side proposed (the proposer may leave the family later). */
  proposedSide: "family" | "provider";
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  endedBy: string | null;
}

export interface DbState {
  version: 1;
  seq: number;
  users: Record<string, UserRow>;
  vehicles: Record<string, Vehicle>;
  drivers: Record<string, DriverRow>;
  /** user id → device ids that entered the invite code (FR-007). */
  members: Record<string, string[]>;
  /** user id → device id → master profile, for devices that joined through a master link. */
  linkMembers?: Record<string, Record<string, string>>;
  rides: Record<string, RideRow>;
  offers: Record<string, OfferRow>;
  ratings: RatingRow[];
  inviteFails: Record<string, number[]>;
  /** "Move to the app" codes (normalised, no dash) → owner and expiry. Supabase keeps a hash. */
  transfers?: Record<string, { userId: string; expiresAt: number }>;
  /** 2.0 */
  appointments?: Record<string, ApptRow>;
  series?: Record<string, SeriesRow>;
  /** 2.3 (optional: demo databases saved before 2.3 lack them) */
  kids?: Record<string, KidRow>;
  /** appointment id → the client's kids attached to it (FR-201). */
  appointmentKids?: Record<string, string[]>;
  kidRatings?: KidRatingRow[];
  messages?: MessageRow[];
  /** The demo's "bucket": object path → data URL (Supabase keeps the object in Storage). */
  photos?: Record<string, string>;
  /** user id → room → when they last had that thread open and visible (FR-222; Supabase: chat_presence). */
  chatPresence?: Record<string, Record<string, number>>;
  /** 2.5 (optional: demo databases saved before 2.5 lack it) */
  updates?: UpdateRow[];
  /** 2.6 (optional: demo databases saved before 2.6 lack them) */
  families?: Record<string, FamilyRow>;
  /** user id → their family (a member is in at most one). */
  familyMembers?: Record<string, { familyId: string; joinedAt: number }>;
  familyInvites?: FamilyInviteRow[];
  contracts?: Record<string, ContractRow>;
  /** The Monday ("YYYY-MM-DD") whose weekly_report notifications went out (Supabase: app_config.report_week). */
  reportWeek?: string | null;
  /** 2.7 (V66): users who joined with the test invite code — the sandbox (Supabase: memberships.sandbox). */
  sandbox?: Record<string, boolean>;
  /** 2.8 (V69): personal invite links by token (Supabase keeps a SHA-256 of the token). */
  memberInvites?: Record<string, MemberInviteRow>;
  /** 2.9 (V73): every notification a member got (but chat messages), for the bell. */
  notifications?: NotificationRow[];
  /** 2.11 (FR-322–324): reminders to pay and dobry Pancios (Supabase: settlements). */
  settlements?: SettlementRow[];
}

/**
 * 2.11 (FR-322–324, V78–V80): a reminder to pay ("remind") or a dobry Pancio ("settle") from one side
 * to another. Sides are keys: "f:<family>" or "p:<master profile, else the user>". `amount` is the
 * net as the presser's side saw it (above 0: the other side owed them); `withUser` is the person on
 * the other side it went to.
 */
export interface SettlementRow {
  id: string;
  kind: "remind" | "settle";
  byUser: string;
  withUser: string;
  fromParty: string;
  toParty: string;
  amount: number;
  itemCount: number;
  createdAt: number;
  comment: string | null;
  commentBy: string | null;
  commentAt: number | null;
}

/** 2.11: one unpaid appointment or ride, seen from my side (V78). */
interface Owing {
  /** The person on the other side, and their side's key. */
  other: string;
  side: string;
  theyOwe: boolean;
  rides: boolean;
  amount: number;
  at: number;
  item: ApptRow | RideRow;
}

/** 2.9 (FR-311): a kept notification (Supabase: notifications). */
export interface NotificationRow {
  id: string;
  userId: string;
  kind: PushKind;
  params: PushParams;
  rideId: string | null;
  appointmentId: string | null;
  createdAt: number;
  readAt: number | null;
}

/** 2.8 (FR-301): a personal link into Siosia, made by a member; works once within 14 days. */
export interface MemberInviteRow {
  fromUser: string;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  usedAt: number | null;
  /** The family invitation that follows the newcomer's first profile went out. */
  familySent: boolean;
}

/** Transfer codes: 8 characters without look-alikes (no I, O, 0, 1), shown as XXXX-XXXX. */
export const TRANSFER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const normalizeTransfer = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function emptyDb(): DbState {
  return {
    version: 1,
    seq: 0,
    users: {},
    vehicles: {},
    drivers: {},
    members: {},
    rides: {},
    offers: {},
    ratings: [],
    inviteFails: {},
    appointments: {},
    series: {},
    kids: {},
    appointmentKids: {},
    kidRatings: [],
    messages: [],
    photos: {},
    chatPresence: {},
    updates: [],
    families: {},
    familyMembers: {},
    familyInvites: [],
    contracts: {},
    reportWeek: null
  };
}

export interface EngineConfig extends DeploymentConfig {
  /** Plain invite code for the mock backend; null = no invite needed. (Supabase stores only a hash.) */
  inviteCode: string | null;
  /** 2.7 (V66): the test invite code — who joins with it is in the sandbox; null/absent = none. */
  testInviteCode?: string | null;
  /** Master profiles and their link tokens (mock only; Supabase stores token hashes). */
  masters?: MasterProfile[];
}

/** A notification for one user (Supabase: push_outbox → Web Push; demo: shown by the browser). */
export interface PushEvent {
  userId: string;
  kind: PushKind;
  rideId: string | null;
  /** 2.0: appointment notifications are tagged with the appointment. */
  appointmentId?: string | null;
  params: PushParams;
}

/** 2.3: a chat message for one party's live thread (→ "chat" on topic user:<id>, Supabase: siosia_notify). */
export interface ChatDelivery {
  userId: string;
  room: ChatRoom;
  message: ChatMessage;
}

/** 2.3: a chat room as the server sees it: its two parties, whether sending is still allowed, and what it belongs to (the push tag). */
interface RoomInfo {
  parties: string[];
  open: boolean;
  rideId: string | null;
  appointmentId: string | null;
}

export interface Effects {
  /** Users whose state changed (→ realtime "changed" on topic user:<id>). */
  notify: Set<string>;
  /** A request opened or re-opened (→ data-less "ping" on topic "drivers"). */
  pingDrivers: boolean;
  /** Notifications to send (only users who turned them on get them). */
  push: PushEvent[];
  /** 2.3: messages to deliver live, one per party (the sender's other tabs included). */
  chat: ChatDelivery[];
}

export const normalizeInvite = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

const NICK_RE = /^.{2,20}$/u;
/** A car paint as #rrggbb (any case in, stored lower case; twin of the check in siosia_set_car_colour). */
const PAINT_RE = /^#[0-9a-f]{6}$/i;
/** 2.3 limits (twins of the checks in the SQL kid, photo and chat functions). */
const KIDS_MAX = 8;
const KID_NAME_MAX = 30;
const KID_NOTE_MAX = 200;
const KID_BORN_MIN = 1900;
const CHAT_TEXT_MAX = 500;
/** At most 30 messages per room per sender per 10 minutes (FR-225). */
const CHAT_RATE_N = 30;
const CHAT_RATE_MS = 10 * 60_000;
/** Sending stays open this long after the ride / appointment ended (FR-223). */
const CHAT_AFTER_END_MS = 24 * 3600_000;
/**
 * Someone seen in a room this recently has the thread open (the app stamps it on opening and every
 * 20 s while visible) and gets no notification for it (FR-222; twin of the 45 s in siosia_send_message).
 */
const CHAT_PRESENCE_MS = 45_000;
/** A photo as uploaded: a JPEG data URL; the app resizes to ≤ 150 KB, base64 adds a third (FR-210). */
const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;
const PHOTO_MAX_CHARS = 220_000;
/** 2.5 (FR-230, FR-240, V54, V56): the feed opens 30 min before the start and closes 7 days after the
 *  end; the heading-home notice is for the live session (until 2 h after the end); 60 updates per
 *  author per appointment per hour; at most 600 minutes away (twins of siosia_feed_open and co.). */
const FEED_BEFORE_MS = 30 * 60_000;
const FEED_AFTER_MS = 7 * 24 * 3600_000;
const FEED_RATE_N = 60;
const FEED_RATE_MS = 3600_000;
const COMING_AFTER_MS = 2 * 3600_000;
const COMING_MAX_MIN = 600;
/** A heading-home notice repeated within this long rings no second time (the screen still updates). */
const COMING_PUSH_GAP_MS = 60_000;
/** 2.6 (FR-250–282) limits, twins of the SQL checks: family size, invitation life, contract lines and
 *  rates, the time correction window and range, how far back a report goes, when the weekly push goes. */
const FAMILY_MAX = 6;
const INVITE_MS = 7 * 86_400_000;
const CONTRACT_LINES_MAX = 12;
const RATE_MAX = 10_000;
const NOTE_MAX = 200;
const ACTUAL_MIN = 15;
const ACTUAL_MAX = 1440;
const REPORT_WEEKS = 52;
/** 2.8 (V69): invite links — 14 days, at most 10 open per member (twins of siosia_create_member_invite). */
const MEMBER_INVITE_MS = 14 * 86_400_000;
const MEMBER_INVITES_MAX = 10;
/** 2.9 (V73): the bell keeps 60 days, at most 200 per member, and lists the newest 50. */
const NOTIF_KEEP_MS = 60 * 86_400_000;
const NOTIF_MAX = 200;
const NOTIF_LIST = 50;
const REPORT_HOUR = 8;
/** 2.11 (V79, V80): one reminder per side and 12 hours; settlements listed for 90 days, 10 at most;
 *  a comment once, 1–280 characters, within 30 days. */
const REMIND_MS = 12 * 3600_000;
const SETTLE_LIST_MS = 90 * 86_400_000;
const SETTLE_LIST = 10;
const COMMENT_MAX = 280;
const COMMENT_MS = 30 * 86_400_000;
/** Money to the cent (twin of round(x::numeric, 2)). */
const round2 = (x: number) => Math.round(x * 100) / 100;
/** 2.9 (V74): a tip is 1–1000 after an appointment (within 7 days of its end), 1–500 after a ride. */
const TIP_APPT_MAX = 1000;
const TIP_RIDE_MAX = 500;
const TIP_APPT_MS = 7 * 86_400_000;
const tipAmount = (amount: number, max: number): number => {
  const v = typeof amount === "number" && Number.isFinite(amount) ? round2(amount) : NaN;
  if (!(v >= 1 && v <= max)) throw new ServerError("bad_input");
  return v;
};
/** Trims the whitespace a keyboard produces, the same set as the SQL btrim(…, E' \t\n\r\f' || chr(11)) (V19). */
const trimWs = (s: string): string => s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");

export class Engine {
  readonly effects: Effects = { notify: new Set(), pingDrivers: false, push: [], chat: [] };
  private readonly cfg: EngineConfig;

  constructor(
    private readonly db: DbState,
    cfg: Partial<EngineConfig>,
    private readonly now: number
  ) {
    this.cfg = { ...DEFAULT_CONFIG, inviteCode: null, masters: [], ...cfg };
  }

  // ---------- identity ----------

  isMember(uid: string, deviceId?: string): boolean {
    if (this.cfg.inviteCode === null) return true;
    const devices = this.db.members[uid] ?? [];
    if (deviceId ? devices.includes(deviceId) : devices.length > 0) return true;
    // A master link counts only while that master profile is switched on.
    const links = Object.entries(this.db.linkMembers?.[uid] ?? {}).filter(([, m]) => this.masterDef(m)?.active !== false && !!this.masterDef(m));
    return deviceId ? links.some(([d]) => d === deviceId) : links.length > 0;
  }

  join(uid: string, code: string, deviceId: string): void {
    this.refuseMerged(uid);
    if (this.cfg.inviteCode === null) return;
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    // 2.7 (V66): the test code admits too, into the sandbox (once in it, an account stays there).
    const test = !!this.cfg.testInviteCode && normalizeInvite(code) === normalizeInvite(this.cfg.testInviteCode);
    if (!test && normalizeInvite(code) !== normalizeInvite(this.cfg.inviteCode)) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_invite");
    }
    const devices = this.db.members[uid] ?? [];
    if (!devices.includes(deviceId) && this.deviceRoom(uid, deviceId)) this.db.members[uid] = [...devices, deviceId];
    if (test) (this.db.sandbox ??= {})[uid] = true;
  }

  /** 2.7 (V66): a test account (joined with the test invite code). */
  private sandboxOf(uid: string | null): boolean {
    return !!uid && !!this.db.sandbox?.[uid];
  }

  /**
   * 2.7 (V67): a master profile's phones are one person in the member list and the catalog — its
   * newest account stands for it, and its own other phones do not list it (twin of siosia_listed).
   */
  private listed(uid: string, viewer: string): boolean {
    const m = this.linkedMaster(uid);
    if (!m) return true;
    if (this.linkedMaster(viewer) === m) return false;
    // 2.9 (V72): the phone seen most recently (else the newest) stands for the master profile.
    const u = this.db.users[uid];
    const key = (x: UserRow) => [x.seenAt ?? x.createdAt, x.createdAt] as const;
    const [s0, c0] = key(u);
    return !Object.values(this.db.users).some((o) => {
      if (o.id === uid || o.deleted || o.masterId !== m || !this.isMember(o.id) || !this.sameRealm(viewer, o.id)) return false;
      const [s, c] = key(o);
      return s > s0 || (s === s0 && (c > c0 || (c === c0 && o.id > uid)));
    });
  }

  /** 2.9 (V72): the phones of one master profile are one person (contracts, family invitations). */
  private samePerson(a: string | null, b: string | null): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const m = this.linkedMaster(a);
    return !!m && m === this.linkedMaster(b);
  }

  /** 2.9 (V72): every phone (account) of this person — the master profile's members, else just them. */
  private personAccounts(uid: string): string[] {
    const m = this.linkedMaster(uid);
    if (!m) return [uid];
    const all = Object.values(this.db.users)
      .filter((u) => !u.deleted && u.masterId === m && this.isMember(u.id))
      .map((u) => u.id);
    return all.includes(uid) ? all : [uid, ...all];
  }

  /** 2.7 (V66): two accounts that may find and reach each other — both real or both test. */
  private sameRealm(a: string | null, b: string | null): boolean {
    return this.sandboxOf(a) === this.sandboxOf(b);
  }

  /**
   * Opens a master profile from its link: this device's user becomes that profile (nickname, icon,
   * fixed fare, rider only). The link replaces the invite code. Wrong tokens count as failed
   * invite attempts (same rate limit).
   */
  joinMaster(uid: string, token: string, deviceId: string, language: Lang, replace = false): Profile & { noop?: boolean } {
    this.refuseMerged(uid);
    if (!deviceId || deviceId.length > 80) throw new ServerError("bad_input");
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    const m = (this.cfg.masters ?? []).find((x) => x.token === token.trim() && x.active !== false);
    if (!m) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_link");
    }
    // 2.12 (FR-328): a closed link — a phone already on the profile changes nothing; anyone else gets
    // bad_link, never counted as a failed attempt (an old bookmark must not lock anyone out).
    if (m.joinable === false) {
      const me = this.db.users[uid];
      if (me && !me.deleted && me.masterId === m.id) return { ...this.getProfile(uid)!, noop: true };
      throw new ServerError("bad_link");
    }
    this.sweep();
    if (this.activeDriverRideOf(uid)) throw new ServerError("active_trip");
    const active = this.activeRideOf(uid);
    if (active && active.riderId === uid) throw new ServerError("active_ride");
    // Replacing another profile on this account needs the user's explicit confirmation.
    const existing = this.db.users[uid];
    if (!replace && existing && !existing.deleted && (existing.masterId ?? null) !== m.id) throw new ServerError("has_profile");
    this.goOffline(uid);
    if (!(this.db.members[uid] ?? []).includes(deviceId) && this.deviceRoom(uid, deviceId)) {
      const links = (this.db.linkMembers ??= {});
      links[uid] = { ...(links[uid] ?? {}), [deviceId]: m.id };
    }
    this.db.users[uid] = existing
      ? { ...existing, nickname: m.nickname, masterId: m.id, deleted: false }
      : { id: uid, nickname: m.nickname, language: language === "pl" ? "pl" : "en", createdAt: this.now, riderCancels: 0, driverCancels: 0, lateCancels: 0, deleted: false, masterId: m.id, publicId: randomPublicId() };
    // A driver profile with a complete vehicle (plate included) puts it on this account (a paint
    // chosen earlier stays, as in siosia_apply_master_vehicle).
    const v = m.role === "driver" ? m.vehicle : null;
    if (v?.plate) this.db.vehicles[uid] = { ...v, plate: v.plate.toUpperCase(), paint: this.db.vehicles[uid]?.paint ?? null };
    this.effects.notify.add(uid);
    return this.getProfile(uid)!;
  }

  private masterDef(id: string | null | undefined): MasterProfile | null {
    return id ? (this.cfg.masters ?? []).find((m) => m.id === id) ?? null : null;
  }

  // ---------- moving a profile to another app / phone (iOS Home Screen apps have own storage) ----------

  /** A one-time code that lets another app or phone take over this profile (30 min). */
  createTransfer(uid: string): { code: string; expiresAt: number } {
    this.requireUser(uid);
    const all = (this.db.transfers ??= {});
    for (const [k, t] of Object.entries(all)) if (t.userId === uid || t.expiresAt <= this.now) delete all[k];
    let raw = "";
    for (let i = 0; i < 8; i++) raw += TRANSFER_ALPHABET[Math.floor(Math.random() * TRANSFER_ALPHABET.length)];
    const expiresAt = this.now + SERVER.transferS * 1000;
    all[raw] = { userId: uid, expiresAt };
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /**
   * Redeems a code on this app/phone: its profile, vehicle, history, ratings and master link move
   * to this account (the old app starts fresh). Another profile here is merged into it only after
   * the user confirms (`replace`). Wrong codes count as failed invite attempts.
   */
  redeemTransfer(uid: string, code: string, deviceId: string, replace = false): Profile {
    this.refuseMerged(uid);
    if (!deviceId || deviceId.length > 80) throw new ServerError("bad_input");
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    const key = normalizeTransfer(code);
    const t = this.db.transfers?.[key];
    const old = t && t.expiresAt > this.now ? t.userId : null;
    if (!old || !this.db.users[old] || this.db.users[old].deleted || !this.isMember(old)) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_transfer");
    }
    // 2.12 (V86): an account others were merged into never moves by a move code — that phone signs in;
    // and one others were merged into never takes a move code — it merges instead (keeps both).
    const mergedInto = (x: string) => Object.values(this.db.users).some((u) => u.mergedInto === x);
    if (old !== uid && mergedInto(old)) throw new ServerError("sign_in_instead");
    if (old === uid) {
      delete this.db.transfers![key];
      return this.getProfile(uid)!;
    }
    if (mergedInto(uid)) throw new ServerError("use_merge");
    this.sweep();
    if (this.activeRideOf(old) || this.activeRideOf(uid)) throw new ServerError("active_ride");
    const mine = this.db.users[uid];
    if (!replace && mine && !mine.deleted) throw new ServerError("has_profile");
    this.goOffline(old);
    this.goOffline(uid);
    for (const r of Object.values(this.db.rides)) {
      if (r.riderId === old) r.riderId = uid;
      if (r.driverId === old) r.driverId = uid;
      r.excluded = r.excluded.map((x) => (x === old ? uid : x));
    }
    for (const a of [...Object.values(this.db.appointments ?? {}), ...Object.values(this.db.series ?? {})]) {
      if (a.clientId === old) a.clientId = uid;
      if (a.providerId === old) a.providerId = uid;
      if ("tipBy" in a && a.tipBy === old) a.tipBy = uid; // 2.9
    }
    // Both accounts may hold a card for the same ride, or have rated the same ride: keep the new one.
    for (const [k, o] of Object.entries(this.db.offers))
      if (o.driverId === old && Object.values(this.db.offers).some((n) => n.driverId === uid && n.rideId === o.rideId && n.round === o.round))
        delete this.db.offers[k];
    this.db.ratings = this.db.ratings.filter((g) => !(g.fromUser === old && this.db.ratings.some((n) => n.fromUser === uid && ratingKey(n) === ratingKey(g))));
    for (const o of Object.values(this.db.offers)) if (o.driverId === old) o.driverId = uid;
    for (const g of this.db.ratings) {
      if (g.fromUser === old) g.fromUser = uid;
      if (g.toUser === old) g.toUser = uid;
    }
    // 2.3 (V49): the kid ratings given, the messages sent and the chat presence move too and, like
    // rides and ratings, a replaced profile's own rows of those merge (its presence yields to the
    // newer stamp). The kids move too, but a replaced profile is a deleted one (FR-200): its own
    // kids go first, photos included, and the providers who expect them hear (deleteKid). The photos
    // follow their rows — the paths hold no user id — and the old account's photo comes with its
    // user row, so a photo of the replaced profile is dropped.
    for (const k of Object.values(this.db.kids ?? {})) if (k.ownerId === uid) this.deleteKid(k);
    for (const k of Object.values(this.db.kids ?? {})) if (k.ownerId === old) k.ownerId = uid;
    for (const g of this.db.kidRatings ?? []) if (g.fromUser === old) g.fromUser = uid;
    for (const m of this.db.messages ?? []) if (m.sender === old) m.sender = uid;
    for (const u of this.db.updates ?? []) if (u.author === old) u.author = uid; // 2.5 (FR-235)
    // 2.6: a replaced profile leaves its family first (as a deleted one would); then the family,
    // the invitations and the contracts follow the account.
    if (mine && !mine.deleted) this.dropFromFamilies(uid);
    const fm = this.db.familyMembers;
    if (fm?.[old]) {
      fm[uid] = fm[old];
      delete fm[old];
    }
    for (const i of this.db.familyInvites ?? []) {
      if (i.fromUser === old) i.fromUser = uid;
      if (i.toUser === old) i.toUser = uid;
    }
    for (const c of Object.values(this.db.contracts ?? {})) {
      if (c.providerId === old) c.providerId = uid;
      if (c.proposedBy === old) c.proposedBy = uid;
      if (c.endedBy === old) c.endedBy = uid;
    }
    // 2.11: the settlements follow the account (a person's side is keyed by the user without a master)
    for (const s of this.db.settlements ?? []) {
      if (s.byUser === old) s.byUser = uid;
      if (s.withUser === old) s.withUser = uid;
      if (s.commentBy === old) s.commentBy = uid;
      if (s.fromParty === `p:${old}`) s.fromParty = `p:${uid}`;
      if (s.toParty === `p:${old}`) s.toParty = `p:${uid}`;
    }
    const pres = this.db.chatPresence;
    if (pres?.[old]) {
      pres[uid] = { ...pres[old], ...(pres[uid] ?? {}) };
      delete pres[old];
    }
    if (mine?.photoPath && mine.photoPath !== this.db.users[old].photoPath) delete this.db.photos?.[mine.photoPath];
    this.db.users[uid] = { ...this.db.users[old], id: uid };
    delete this.db.users[old];
    if (this.db.vehicles[old]) {
      this.db.vehicles[uid] = this.db.vehicles[old];
      delete this.db.vehicles[old];
    }
    delete this.db.drivers[old];
    // This device becomes a member the way the old account was: invite code first, else its link.
    const viaLink = Object.values(this.db.linkMembers?.[old] ?? {})[0] ?? null;
    if ((this.db.members[old] ?? []).length > 0 || !viaLink) {
      const devices = this.db.members[uid] ?? [];
      if (!devices.includes(deviceId)) this.db.members[uid] = [...devices, deviceId];
    } else {
      const links = (this.db.linkMembers ??= {});
      links[uid] = { ...(links[uid] ?? {}), [deviceId]: viaLink };
    }
    delete this.db.members[old];
    if (this.db.linkMembers) delete this.db.linkMembers[old];
    // 2.7 (V66): a test account stays one on the new phone.
    if (this.db.sandbox?.[old]) {
      this.db.sandbox[uid] = true;
      delete this.db.sandbox[old];
    }
    for (const [k, x] of Object.entries(this.db.transfers ?? {})) if (x.userId === old) delete this.db.transfers![k];
    // 2.9: the bell follows the account (whatever this phone had before goes).
    if (this.db.notifications?.length) {
      this.db.notifications = this.db.notifications.filter((n) => n.userId !== uid);
      for (const n of this.db.notifications) if (n.userId === old) n.userId = uid;
    }
    // 2.8: the invite links made and used follow the account.
    for (const i of Object.values(this.db.memberInvites ?? {})) {
      if (i.fromUser === old) i.fromUser = uid;
      if (i.usedBy === old) i.usedBy = uid;
    }
    this.effects.notify.add(old);
    this.effects.notify.add(uid);
    return this.getProfile(uid)!;
  }

  // ---------- 2.12 accounts: one account per person on every phone (FR-326–FR-331) ----------

  /**
   * Who this session is to Siosia (V81, twin of siosia_whoami): routes the phone to the app, the
   * invite code or sign-in. A member's phone is recorded as one of its devices (the way it became a
   * member: the invite code first, else its master link). membershipMode "open": every account is a
   * member. The engine knows no anonymous sessions — anonymous / signInRequired are always false.
   */
  whoami(uid: string, deviceId: string): WhoAmI {
    if (!deviceId || deviceId.length > 80) throw new ServerError("bad_input");
    const u = this.db.users[uid];
    const into = u?.mergedInto ? (this.db.users[u.mergedInto]?.publicId ?? "?") : null;
    let member = false;
    if (!into) {
      if (this.cfg.membershipMode === "open" && !this.isMember(uid) && this.deviceRoom(uid, deviceId)) this.addDevice(uid, deviceId, null);
      member = this.isMember(uid);
      if (member && this.hasMembership(uid) && this.deviceRoom(uid, deviceId)) this.recordDevice(uid, deviceId);
    }
    return {
      member,
      hasProfile: !!u && !u.deleted,
      anonymous: false,
      signInRequired: false,
      mergedInto: into,
      publicId: u && !u.deleted ? this.publicIdOf(uid) : null,
      sandbox: this.sandboxOf(uid)
    };
  }

  /** At most 20 phones are recorded per person (a device id is the caller's to choose). */
  private deviceRoom(uid: string, deviceId: string): boolean {
    const direct = this.db.members[uid] ?? [];
    const links = this.db.linkMembers?.[uid] ?? {};
    return direct.includes(deviceId) || deviceId in links || direct.length + Object.keys(links).length < 20;
  }

  /** Any membership row at all, switched-off master links included (twin of exists … memberships). */
  private hasMembership(uid: string): boolean {
    return (this.db.members[uid] ?? []).length > 0 || Object.keys(this.db.linkMembers?.[uid] ?? {}).length > 0;
  }

  private addDevice(uid: string, deviceId: string, viaMaster: string | null): void {
    if (viaMaster === null) {
      const devices = this.db.members[uid] ?? [];
      if (!devices.includes(deviceId)) this.db.members[uid] = [...devices, deviceId];
    } else if (!(this.db.members[uid] ?? []).includes(deviceId)) {
      const links = (this.db.linkMembers ??= {});
      links[uid] = { [deviceId]: viaMaster, ...(links[uid] ?? {}) };
    }
  }

  /** A member's phone joins its devices the way the account is a member (the invite code first). */
  private recordDevice(uid: string, deviceId: string): void {
    if ((this.db.members[uid] ?? []).length > 0) this.addDevice(uid, deviceId, null);
    else {
      const via = Object.values(this.db.linkMembers?.[uid] ?? {})[0];
      if (via) this.addDevice(uid, deviceId, via);
    }
  }

  /**
   * The phone signed in (FR-327, twin of siosia_absorb): the account it used before handed itself
   * over with a transfer code and is merged into this one. Wrong codes count as failed attempts.
   */
  absorb(uid: string, code: string, deviceId: string, samePhone = true): Profile | null {
    if (this.db.users[uid]?.mergedInto) throw new ServerError("account_merged");
    if (!deviceId || deviceId.length > 80) throw new ServerError("bad_input");
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    const key = normalizeTransfer(code);
    const t = this.db.transfers?.[key];
    const old = t && t.expiresAt > this.now ? t.userId : null;
    if (!old) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_transfer");
    }
    if (old === uid) {
      delete this.db.transfers![key];
      return this.getProfile(uid);
    }
    this.mergeAccounts(old, uid, samePhone ? "absorb" : "manual");
    delete this.db.transfers?.[key];
    if (this.isMember(uid) && this.hasMembership(uid) && this.deviceRoom(uid, deviceId)) this.recordDevice(uid, deviceId);
    return this.getProfile(uid);
  }

  /** Whose account a typed code is, before "Merge another account here" (twin of siosia_absorb_preview). */
  absorbPreview(uid: string, code: string): { nickname: string; publicId: string | null; family: boolean; master: boolean } {
    if (this.db.users[uid]?.mergedInto) throw new ServerError("account_merged");
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    const t = this.db.transfers?.[normalizeTransfer(code)];
    const p = t && t.expiresAt > this.now ? this.db.users[t.userId] : undefined;
    if (!p || p.deleted) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_transfer");
    }
    if (p.id === uid) throw new ServerError("bad_input");
    const blocked = this.mergeBlocker(p.id, uid, "manual");
    if (blocked) throw new ServerError(blocked);
    return { nickname: p.nickname, publicId: this.publicIdOf(p.id), family: !!this.db.familyMembers?.[p.id], master: !!p.masterId };
  }

  /**
   * Merges account `from` into `into` (FR-327, V82; twin of siosia_merge_accounts). Nothing of either
   * is thrown away: `into` without a profile takes `from`'s whole profile ("move"); with one it keeps
   * it, takes what it lacks, and `from` stays as a deleted, merged-away row ("merge"). Kids, the bell,
   * memberships come along; unique duplicates are resolved; two families, two master profiles or a
   * clashing ride leg refuse before anything changes. "absorb" needs `from` to be a member in
   * `into`'s realm (or `into` without any membership); "operator" skips both checks.
   */
  /** What stops merging `from` into `into`, before anything changes (twin of siosia_merge_blocker). */
  private mergeBlocker(from: string, into: string, mode: "absorb" | "manual" | "operator"): ServerErrorCode | null {
    const f = this.db.users[from];
    if (!f || f.deleted) return f?.mergedInto ? "already_merged" : "bad_transfer";
    if (mode !== "operator" && !this.isMember(from)) return "bad_transfer";
    const t = this.db.users[into];
    if (t?.mergedInto) return "account_merged";
    if (mode !== "operator" && !this.sameRealm(from, into) && this.hasMembership(into)) return "other_realm";
    if (this.activeRideOf(from) || this.activeRideOf(into)) return "active_ride";
    const fm = this.db.familyMembers ?? {};
    const ff = fm[from]?.familyId ?? null;
    const tf = fm[into]?.familyId ?? null;
    if (ff && tf && ff !== tf) return "two_families";
    if (t && !t.deleted && f.masterId && t.masterId && f.masterId !== t.masterId) return "two_masters";
    const live = (r: RideRow) => r.status !== "cancelled" && r.status !== "expired";
    const rides = Object.values(this.db.rides);
    if (rides.some((a) => a.riderId === from && a.appointmentId && live(a) && rides.some((b) => b.riderId === into && b.appointmentId === a.appointmentId && b.leg === a.leg && live(b))))
      return "merge_conflict";
    return null;
  }

  mergeAccounts(from: string, into: string, mode: "absorb" | "manual" | "operator"): "move" | "merge" {
    if (!from || !into || from === into) throw new ServerError("bad_input");
    this.sweep();
    const blocked = this.mergeBlocker(from, into, mode);
    if (blocked) throw new ServerError(blocked);
    const f = this.db.users[from];
    const t = this.db.users[into];
    const move = !t || t.deleted;
    const fm = (this.db.familyMembers ??= {});
    const ff = fm[from]?.familyId ?? null;
    const tf = fm[into]?.familyId ?? null;
    const rides = Object.values(this.db.rides);

    this.goOffline(from);
    this.goOffline(into);
    for (const r of rides) {
      if (r.riderId === from) r.riderId = into;
      if (r.driverId === from) r.driverId = into;
      r.excluded = r.excluded.map((x) => (x === from ? into : x));
    }
    for (const a of [...Object.values(this.db.appointments ?? {}), ...Object.values(this.db.series ?? {})]) {
      if (a.clientId === from) a.clientId = into;
      if (a.providerId === from) a.providerId = into;
      if ("tipBy" in a && a.tipBy === from) a.tipBy = into;
    }
    for (const [k, o] of Object.entries(this.db.offers))
      if (o.driverId === from && Object.values(this.db.offers).some((n) => n.driverId === into && n.rideId === o.rideId && n.round === o.round))
        delete this.db.offers[k];
    for (const o of Object.values(this.db.offers)) if (o.driverId === from) o.driverId = into;
    this.db.ratings = this.db.ratings.filter((g) => !(g.fromUser === from && this.db.ratings.some((n) => n.fromUser === into && ratingKey(n) === ratingKey(g))));
    for (const g of this.db.ratings) {
      if (g.fromUser === from) g.fromUser = into;
      if (g.toUser === from) g.toUser = into;
    }
    for (const k of Object.values(this.db.kids ?? {})) if (k.ownerId === from) k.ownerId = into;
    for (const g of this.db.kidRatings ?? []) if (g.fromUser === from) g.fromUser = into;
    for (const m of this.db.messages ?? []) if (m.sender === from) m.sender = into;
    for (const u of this.db.updates ?? []) if (u.author === from) u.author = into;
    // The family seat moves (both in the same family: one seat stays) — never by leaving.
    if (ff) {
      if (!tf) fm[into] = fm[from];
      delete fm[from];
    }
    const myFamily = fm[into]?.familyId ?? null;
    const invites = this.db.familyInvites ?? [];
    this.db.familyInvites = invites.filter(
      (i) =>
        !(
          i.toUser === from &&
          i.status === "pending" &&
          (i.familyId === myFamily || invites.some((j) => j.toUser === into && j.familyId === i.familyId && j.status === "pending"))
        )
    );
    for (const i of this.db.familyInvites) {
      if (i.fromUser === from) i.fromUser = into;
      if (i.toUser === from) i.toUser = into;
    }
    const contracts = Object.values(this.db.contracts ?? {});
    for (const c of contracts) {
      if (c.providerId !== from || (c.status !== "active" && c.status !== "proposed")) continue;
      if (contracts.some((d) => d.providerId === into && d.familyId === c.familyId && d.status === c.status)) {
        c.status = c.status === "active" ? "replaced" : "withdrawn";
        c.endedAt = this.now;
      }
    }
    for (const c of contracts) {
      if (c.providerId === from) c.providerId = into;
      if (c.proposedBy === from) c.proposedBy = into;
      if (c.endedBy === from) c.endedBy = into;
    }
    for (const i of Object.values(this.db.memberInvites ?? {})) {
      if (i.fromUser === from) i.fromUser = into;
      if (i.usedBy === from) i.usedBy = into;
    }
    for (const n of this.db.notifications ?? []) if (n.userId === from) n.userId = into;
    for (const s of this.db.settlements ?? []) {
      if (s.byUser === from) s.byUser = into;
      if (s.withUser === from) s.withUser = into;
      if (s.commentBy === from) s.commentBy = into;
    }
    const pres = this.db.chatPresence;
    if (pres?.[from]) {
      pres[into] = { ...pres[from], ...(pres[into] ?? {}) };
      delete pres[from];
    }
    if (move) {
      this.db.users[into] = { ...f, id: into };
      // The old account keeps a merged-away row (a new public id): its phone is sent to sign in.
      this.db.users[from] = { id: from, nickname: "Merged", language: f.language, createdAt: this.now, riderCancels: 0, driverCancels: 0, lateCancels: 0, deleted: true, mergedInto: into, publicId: randomPublicId(), offers: [] };
    } else {
      const x = t!;
      const adoptMaster = !x.masterId && !!f.masterId;
      this.db.users[into] = {
        ...x,
        photoPath: x.photoPath ?? f.photoPath ?? null,
        home: x.home ?? f.home ?? null,
        offers: (x.offers ?? []).length ? x.offers : f.offers ?? [],
        masterId: x.masterId ?? f.masterId ?? null,
        nickname: adoptMaster ? f.nickname : x.nickname,
        createdAt: Math.min(x.createdAt, f.createdAt),
        riderCancels: x.riderCancels + f.riderCancels,
        driverCancels: x.driverCancels + f.driverCancels,
        lateCancels: x.lateCancels + f.lateCancels
      };
      if (f.photoPath && f.photoPath !== this.db.users[into].photoPath) delete this.db.photos?.[f.photoPath];
      this.db.users[from] = { ...f, deleted: true, mergedInto: into, masterId: null, photoPath: null, offers: [], home: null };
    }
    for (const u of Object.values(this.db.users)) if (u.mergedInto === from) u.mergedInto = into;
    // 2.11 sides: every key that stood for either account becomes the survivor's side.
    const key = `p:${this.linkedMaster(into) ?? into}`;
    const old = new Set([`p:${from}`, `p:${into}`]);
    for (const s of this.db.settlements ?? []) {
      if (old.has(s.fromParty)) s.fromParty = key;
      if (old.has(s.toParty)) s.toParty = key;
    }
    if (this.db.vehicles[from]) {
      if (!this.db.vehicles[into]) this.db.vehicles[into] = this.db.vehicles[from];
      delete this.db.vehicles[from];
    }
    delete this.db.drivers[from];
    // Every phone of `from` becomes a phone of `into`, the way it was a member (V66: realm kept).
    const theirs: [string, string | null][] = [
      ...(this.db.members[from] ?? []).map((d): [string, string | null] => [d, null]),
      ...Object.entries(this.db.linkMembers?.[from] ?? {})
    ];
    const room = Math.max(1, 20 - ((this.db.members[into] ?? []).length + Object.keys(this.db.linkMembers?.[into] ?? {}).length));
    for (const [d, m] of theirs.slice(0, room)) this.addDevice(into, d, m);
    delete this.db.members[from];
    if (this.db.linkMembers) delete this.db.linkMembers[from];
    if (this.db.sandbox?.[from]) {
      this.db.sandbox[into] = true;
      delete this.db.sandbox[from];
    }
    for (const [k, x] of Object.entries(this.db.transfers ?? {})) if (x.userId === from) delete this.db.transfers![k];
    this.effects.notify.add(from);
    this.effects.notify.add(into);
    return move ? "move" : "merge";
  }

  /** The master profile this user rides as, while it is switched on (fixed fare, icon). */
  private masterOf(uid: string): MasterProfile | null {
    const m = this.masterDef(this.linkedMaster(uid));
    return m && m.active !== false ? m : null;
  }

  /** The active rider master profile of this user (fixed fare, default places). */
  private riderMaster(uid: string): MasterProfile | null {
    const m = this.masterOf(uid);
    return m && (m.role ?? "rider") === "rider" ? m : null;
  }

  /** Role of the master profile this user joined, switched on or not. */
  private linkedRole(uid: string): "rider" | "driver" | null {
    const id = this.linkedMaster(uid);
    return id ? this.masterDef(id)?.role ?? "rider" : null;
  }

  /** The master profile this user joined (one role, nickname locked), switched on or not. */
  private linkedMaster(uid: string): string | null {
    const u = this.db.users[uid];
    return u && !u.deleted ? u.masterId ?? null : null;
  }

  private requireMember(uid: string): void {
    // 2.12 (V85): a merged-away account is frozen (twin of siosia_guard)
    if (this.db.users[uid]?.mergedInto) throw new ServerError("account_merged");
    if (!this.isMember(uid)) throw new ServerError("not_member");
  }

  /** 2.12 (V86): a merged-away account is not brought back by a code or a link — its phone signs in. */
  private refuseMerged(uid: string): void {
    if (this.db.users[uid]?.mergedInto) throw new ServerError("already_merged");
  }

  private requireUser(uid: string): UserRow {
    this.requireMember(uid);
    const u = this.db.users[uid];
    if (!u || u.deleted) throw new ServerError("no_profile");
    return u;
  }

  getProfile(uid: string): Profile | null {
    const u = this.db.users[uid];
    if (!u || u.deleted) return null;
    return {
      userId: u.id,
      nickname: u.nickname,
      language: u.language,
      riderCancels: u.riderCancels,
      driverCancels: u.driverCancels,
      lateCancels: u.lateCancels,
      rating: this.rating(uid),
      masterId: this.linkedMaster(uid),
      masterRole: this.linkedRole(uid),
      icon: this.masterOf(uid)?.icon ?? null,
      fixedFare: this.riderMaster(uid)?.fixedFare ?? null,
      defaultPickup: this.riderMaster(uid)?.pickup ?? null,
      defaultDropoff: this.riderMaster(uid)?.dropoff ?? null,
      masterVehicle: (this.masterOf(uid)?.role === "driver" && this.masterOf(uid)?.vehicle) || null,
      publicId: this.publicIdOf(uid),
      photo: this.signedUrl(u.photoPath),
      offers: this.offersOf(uid),
      offersPreset: !!this.linkedMaster(uid),
      home: u.home ?? this.riderMaster(uid)?.pickup ?? null
    };
  }

  saveProfile(uid: string, nickname: string, language: Lang): Profile {
    this.requireMember(uid);
    // A master profile's nickname is set by the operator; only the language changes here.
    const linked = this.linkedMaster(uid);
    const nick = linked ? this.masterDef(linked)?.nickname ?? this.db.users[uid].nickname : nickname.trim();
    if (!NICK_RE.test(nick)) throw new ServerError("bad_nickname");
    const lang: Lang = language === "pl" ? "pl" : "en";
    const existing = this.db.users[uid];
    this.db.users[uid] = existing
      ? { ...existing, nickname: nick, language: lang, deleted: false }
      : { id: uid, nickname: nick, language: lang, createdAt: this.now, riderCancels: 0, driverCancels: 0, lateCancels: 0, deleted: false, publicId: randomPublicId() };
    this.linkFamilyInvites(uid); // 2.8 (FR-302): who invited me by link asks me into their family
    return this.getProfile(uid)!;
  }

  /** 2.8 (FR-301, V69): a personal link into Siosia — the app shares `<site>#join=<token>`. */
  createMemberInvite(uid: string): { token: string; expiresAt: number } {
    this.requireUser(uid);
    const all = (this.db.memberInvites ??= {});
    if (Object.values(all).filter((i) => i.fromUser === uid && !i.usedBy && i.expiresAt > this.now).length >= MEMBER_INVITES_MAX) throw new ServerError("too_many");
    const token = randomToken();
    all[token] = { fromUser: uid, createdAt: this.now, expiresAt: this.now + MEMBER_INVITE_MS, usedBy: null, usedAt: null, familySent: false };
    return { token, expiresAt: all[token].expiresAt };
  }

  /**
   * 2.8 (FR-302, V69): opening a link admits this phone like the invite code — into the inviter's
   * realm (V66) — and spends the link; a member who opens one gets the family invitation at once.
   * A wrong, used or expired link counts as a failed invite attempt.
   */
  joinWithLink(uid: string, token: string, deviceId: string): void {
    this.refuseMerged(uid);
    if (!deviceId || deviceId.length > 80) throw new ServerError("bad_input");
    const fails = (this.db.inviteFails[uid] ?? []).filter((t) => this.now - t < 3600_000);
    if (fails.length >= 10) throw new ServerError("rate_limited");
    const i = typeof token === "string" ? this.db.memberInvites?.[token] : undefined;
    const from = i ? this.db.users[i.fromUser] : undefined;
    if (!i || i.usedBy || i.expiresAt <= this.now || !from || from.deleted || !this.isMember(from.id)) {
      this.db.inviteFails[uid] = [...fails, this.now];
      throw new ServerError("bad_link");
    }
    i.usedBy = uid;
    i.usedAt = this.now;
    if (!this.isMember(uid)) {
      const devices = this.db.members[uid] ?? [];
      if (!devices.includes(deviceId) && this.deviceRoom(uid, deviceId)) this.db.members[uid] = [...devices, deviceId];
      if (this.sandboxOf(i.fromUser)) (this.db.sandbox ??= {})[uid] = true;
    }
    this.linkFamilyInvites(uid);
  }

  /** The family invitations owed to someone who joined by link, once they have a profile (silently none when not allowed). */
  private linkFamilyInvites(uid: string): void {
    const u = this.db.users[uid];
    const pid = u && !u.deleted ? this.publicIdOf(uid) : null;
    if (!pid) return;
    for (const i of Object.values(this.db.memberInvites ?? {})) {
      if (i.usedBy !== uid || i.familySent) continue;
      i.familySent = true;
      try {
        this.inviteToFamily(i.fromUser, pid);
      } catch {
        // in a family already, a full family, a gone inviter: no invitation (V69)
      }
    }
  }

  getVehicle(uid: string): Vehicle | null {
    return this.vehicleOf(uid);
  }

  /** The vehicle as everyone sees it (siosia_vehicle_json): paint null until one is chosen. */
  private vehicleOf(uid: string): Vehicle | null {
    const v = this.db.vehicles[uid];
    return v ? { ...v, paint: v.paint ?? null } : null;
  }

  saveVehicle(uid: string, v: Vehicle): Vehicle {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
    const clean: Vehicle = {
      make: v.make.trim(),
      model: v.model.trim(),
      colour: v.colour.trim(),
      plate: v.plate.trim().toUpperCase(),
      seats: Math.round(v.seats)
    };
    const ok =
      clean.make.length >= 1 && clean.make.length <= 30 &&
      clean.model.length >= 1 && clean.model.length <= 30 &&
      clean.colour.length >= 1 && clean.colour.length <= 20 &&
      clean.plate.length >= 2 && clean.plate.length <= 12 &&
      clean.seats >= 1 && clean.seats <= 6;
    if (!ok) throw new ServerError("bad_vehicle");
    // The paint is chosen with the car icon (setCarColour); editing the car keeps it.
    this.db.vehicles[uid] = { ...clean, paint: this.db.vehicles[uid]?.paint ?? null };
    return this.vehicleOf(uid)!;
  }

  /** 2.1 (V38, FR-170): the car's colour name (in the driver's words) and the paint of the car icon. */
  setCarColour(uid: string, colour: string, paint: string): Vehicle {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
    const v = this.db.vehicles[uid];
    if (!v) throw new ServerError("no_vehicle");
    const name = String(colour ?? "").trim();
    const hex = String(paint ?? "");
    if (name.length < 1 || name.length > 20 || !PAINT_RE.test(hex)) throw new ServerError("bad_vehicle");
    v.colour = name;
    v.paint = hex.toLowerCase();
    this.effects.notify.add(uid);
    return this.vehicleOf(uid)!;
  }

  /** Delete = anonymise rides (nickname → "Deleted user"), drop the vehicle (§9 retention). */
  deleteProfile(uid: string): void {
    const u = this.requireUser(uid);
    if (this.activeRideOf(uid)) throw new ServerError("active_ride");
    // 2.0 (FR-142): upcoming appointments in either role end (user_gone), their rides follow, and
    // the other party is told once per appointment or series.
    const upcoming = Object.values(this.db.appointments ?? {})
      .filter((a) => (a.clientId === uid || a.providerId === uid) && (a.status === "requested" || a.status === "accepted"))
      .sort((x, y) => x.startsAt - y.startsAt);
    for (const a of upcoming) {
      a.status = "cancelled";
      a.endedAt = this.now;
      a.cancelledBy = "system";
      a.cancelReason = "user_gone";
      this.notifyAppt(a);
    }
    this.cascadeRides(upcoming.map((a) => a.id));
    // 2.1: open requests of this client leave everyone's "You could help" list (no provider to tell).
    if (upcoming.some((a) => a.providerId === null)) this.notifyMembers();
    const told = new Set<string>();
    for (const a of upcoming) {
      const key = a.seriesId ?? a.id;
      if (told.has(key)) continue;
      told.add(key);
      this.pushAppt(a.clientId === uid ? a.providerId : a.clientId, "appt_cancelled", a, {
        who: u.nickname,
        ...(a.seriesId ? { from: a.startsAt, left: upcoming.filter((x) => x.seriesId === a.seriesId).length } : {})
      });
    }
    for (const s of Object.values(this.db.series ?? {}))
      if ((s.clientId === uid || s.providerId === uid) && (s.status === "requested" || s.status === "answered")) s.status = "cancelled";
    for (const r of Object.values(this.db.rides)) {
      if (r.status !== "scheduled") continue;
      if (r.riderId === uid) {
        if (r.driverId) this.pushTo(r.driverId, "booking_cancelled", r, { pickup: r.pickup.label });
        this.endRide(r, "cancelled", "rider", null);
      } else if (r.driverId === uid) {
        r.driverId = null;
        this.effects.notify.add(r.riderId);
        this.pushTo(r.riderId, "booking_released", r, {});
      }
    }
    // 2.6 (FR-252, FR-263): I leave my family; my contracts as a provider end; my invitations go.
    this.dropFromFamilies(uid);
    this.goOffline(uid);
    delete this.db.vehicles[uid];
    delete this.db.members[uid];
    if (this.db.linkMembers) delete this.db.linkMembers[uid];
    delete this.db.sandbox?.[uid]; // 2.7: with the memberships
    if (this.db.notifications?.length) this.db.notifications = this.db.notifications.filter((n) => n.userId !== uid); // 2.9
    // 2.3 (FR-200, V49): the kids go with the profile — their photos and ratings too — and so do my
    // photo, the messages I sent and my chat presence.
    for (const k of this.kidsOf(uid)) this.deleteKid(k);
    if (u.photoPath) delete this.db.photos?.[u.photoPath];
    if (this.db.messages?.length) this.db.messages = this.db.messages.filter((m) => m.sender !== uid);
    // 2.5 (FR-235): my session updates and their photos.
    for (const x of (this.db.updates ?? []).filter((u) => u.author === uid)) if (x.photoPath) delete this.db.photos?.[x.photoPath];
    if (this.db.updates?.length) this.db.updates = this.db.updates.filter((u) => u.author !== uid);
    delete this.db.chatPresence?.[uid];
    this.db.users[uid] = { ...u, nickname: "Deleted user", deleted: true, masterId: null, offers: [], home: null, photoPath: null };
  }

  // ---------- reads ----------

  myState(uid: string, pos: LatLng | null = null): MyState {
    this.requireMember(uid);
    this.sweep();
    // 2.9 (V72): this phone is in use (at most once a minute; twin of siosia_my_state).
    const me = this.db.users[uid];
    if (me && !me.deleted && (me.seenAt == null || this.now - me.seenAt >= 60_000)) me.seenAt = this.now;
    const ride = this.activeRideOf(uid);
    const offerRow = Object.values(this.db.offers).find((o) => o.driverId === uid && o.status === "offered") ?? null;
    const queued = Object.values(this.db.offers).filter((o) => o.driverId === uid && o.status === "queued").length;
    const driver = this.db.drivers[uid];
    return {
      serverNow: this.now,
      ride: ride ? this.rideView(ride, uid) : null,
      offer: offerRow ? this.offerView(offerRow) : null,
      queuedOffers: queued,
      driverOnline: !!driver?.online,
      hasVehicle: !!this.db.vehicles[uid],
      nearbyRequests: pos && isValidLatLng(pos) ? this.countNearby(uid, pos) : null,
      pendingReceipt: this.pendingReceipt(uid),
      bookings: Object.values(this.db.rides).filter((r) => r.status === "scheduled" && r.riderId === uid).length,
      driverBookings: Object.values(this.db.rides).filter((r) => r.status === "scheduled" && r.driverId === uid).length,
      hasProfile: !!this.db.users[uid] && !this.db.users[uid].deleted,
      standby: !!driver?.standbyUntil && driver.standbyUntil > this.now,
      openBookings:
        this.linkedRole(uid) === "rider" || !this.db.vehicles[uid] ? 0 : Object.values(this.db.rides).filter((r) => this.claimable(r, uid)).length,
      unreadChats: this.unreadChats(uid),
      familyPending: this.familyPending(uid),
      unreadNotifications: (this.db.notifications ?? []).filter((n) => n.userId === uid && n.readAt === null && n.createdAt > this.now - NOTIF_KEEP_MS).length,
      ...this.plannedSummary(uid)
    };
  }

  /** 2.0 (V22): requests waiting for my answer (a series once), upcoming items, the next one. */
  private plannedSummary(uid: string): Pick<MyState, "toAnswer" | "openRequests" | "planned" | "nextPlanned"> {
    const appts = Object.values(this.db.appointments ?? {}).filter(
      (a) => (a.clientId === uid || a.providerId === uid) && (a.status === "requested" || a.status === "accepted") && this.endOf(a) > this.now
    );
    const rides = Object.values(this.db.rides).filter(
      (r) => (r.riderId === uid || r.driverId === uid) && (r.status === "scheduled" || isActive(r.status)) && !(r.appointmentId && r.riderId === uid)
    );
    const lang = this.db.users[uid]?.language ?? "en";
    const next = [
      ...appts.map((a) => ({ kind: "appointment" as const, at: a.startsAt, serviceId: a.serviceId })),
      ...rides.filter((r) => r.status === "scheduled").map((r) => ({ kind: "ride" as const, at: r.scheduledFor ?? r.requestedAt, serviceId: "ride" }))
    ].sort((x, y) => x.at - y.at)[0];
    return {
      toAnswer: new Set(
        Object.values(this.db.appointments ?? {})
          .filter((a) => a.providerId === uid && a.status === "requested" && a.startsAt > this.now)
          .map((a) => a.seriesId ?? a.id)
      ).size,
      openRequests: this.openFor(uid).length,
      planned: appts.length + rides.length,
      nextPlanned: next ? { ...next, title: this.serviceName(next.serviceId, lang) } : null
    };
  }

  getRide(uid: string, rideId: string): RideView {
    this.requireMember(uid);
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r || (r.riderId !== uid && r.driverId !== uid)) throw new ServerError("not_found");
    return this.rideView(r, uid);
  }

  history(uid: string): RideView[] {
    this.requireMember(uid);
    return Object.values(this.db.rides)
      .filter((r) => (r.riderId === uid || r.driverId === uid) && r.status !== "scheduled")
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .slice(0, SERVER.historyLimit)
      .map((r) => this.rideView(r, uid));
  }

  /** FR-063: completed rides only, in the deployment's timezone. */
  earnings(uid: string): Earnings {
    this.requireMember(uid);
    const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: this.cfg.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
    const today = dayKey(this.now);
    const month = today.slice(0, 7);
    let todayTotal = 0, todayCount = 0, monthTotal = 0, monthCount = 0;
    for (const r of Object.values(this.db.rides)) {
      if (r.driverId !== uid || r.status !== "completed" || r.endedAt === null) continue;
      const k = dayKey(r.endedAt);
      if (k.slice(0, 7) === month) {
        monthTotal += r.fare;
        monthCount++;
        if (k === today) {
          todayTotal += r.fare;
          todayCount++;
        }
      }
    }
    return { todayTotal, todayCount, monthTotal, monthCount, currency: this.cfg.tariff.currency };
  }

  // ---------- rider ----------

  requestRide(uid: string, input: RideRequestInput): RideView {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "driver") throw new ServerError("driver_only");
    this.sweep();
    if (this.activeRideOf(uid)) throw new ServerError("active_ride");
    const asDriver = this.db.drivers[uid];
    if (asDriver?.online) {
      // FR-005 applies to a live driver session; a driver tab that died (silent > 12 s, no trip)
      // must not block this user from riding, so that stale session is closed instead.
      if (this.now - asDriver.lastSeen > SERVER.driverStaleS * 1000) this.goOffline(uid);
      else throw new ServerError("online_as_driver");
    }
    const ride = this.newRide(uid, input);
    this.db.rides[ride.id] = ride;
    this.effects.pingDrivers = true;
    this.effects.notify.add(uid);
    this.pushStandby(ride);
    return this.rideView(ride, uid);
  }

  /** A validated new ride (now or booked): never shorter than the straight line, fare frozen. */
  private newRide(uid: string, input: RideRequestInput): RideRow {
    const { pickup, dropoff } = input;
    if (!isValidLatLng(pickup) || !isValidLatLng(dropoff)) throw new ServerError("bad_input");
    // A day at most: in SQL a bigger one overflows est_min / the fare (and, booked by a series
    // template, would fail every sweep).
    if (!Number.isFinite(input.estKm) || !Number.isFinite(input.estMin) || input.estKm <= 0 || input.estMin < 0 || input.estMin > MAX_EST_MIN)
      throw new ServerError("bad_input");
    const area = this.cfg.serviceArea;
    if (area && haversineKm(area, pickup) > area.radiusKm) throw new ServerError("outside_area");
    // The server never trusts a route shorter than the straight line.
    const straight = haversineKm(pickup, dropoff);
    const estKm = Math.max(input.estKm, straight);
    if (estKm > this.cfg.maxTripKm) throw new ServerError("too_far");
    const estMin = Math.max(1, input.estMin);
    // A master profile rides at its fixed fare, whatever the route.
    const fixed = this.riderMaster(uid)?.fixedFare ?? null;
    const ride: RideRow = {
      id: this.nextId("r"),
      riderId: uid,
      driverId: null,
      status: "requested",
      pickup: cleanPlace(pickup),
      dropoff: cleanPlace(dropoff),
      estKm: round1(estKm),
      estMin: Math.round(estMin),
      fare: fixed ?? computeFare(this.cfg.tariff, estKm, estMin),
      currency: this.cfg.tariff.currency,
      fareIsEstimate: fixed === null && !!input.fareIsEstimate,
      actualKm: null,
      actualMin: null,
      requestedAt: this.now,
      dispatchStartedAt: this.now,
      acceptedAt: null,
      arrivedAt: null,
      startedAt: null,
      endedAt: null,
      cancelledBy: null,
      cancelReason: null,
      paid: false,
      collected: false,
      notifiedCount: 0,
      redispatchCount: 0,
      round: 1,
      excluded: [],
      scheduledFor: null
    };
    return ride;
  }

  // ---------- bookings (rides booked in advance) ----------

  /** Books a ride for later (30 min … 30 days ahead by default); the fare is frozen now. */
  bookRide(uid: string, input: BookingInput): RideView {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "driver") throw new ServerError("driver_only");
    this.sweep();
    return this.bookFor(uid, input, input.appointmentId ?? null, input.leg ?? null, false);
  }

  /**
   * A booked ride, optionally as part of an appointment (V9): the passenger is a party, the
   * appointment accepted, the leg free, "there" before the start and "back" at or after it. A
   * series template's bookings do not count against the daily limit. (SQL: siosia_book_for.)
   */
  private bookFor(uid: string, input: BookingInput, appointmentId: string | null, leg: Leg | null, template: boolean): RideView {
    if (this.linkedRole(uid) === "driver") throw new ServerError("driver_only");
    const ride = this.newRide(uid, input);
    const { minLeadMin, maxDays, maxOpen } = this.cfg.booking;
    const t = input.scheduledFor;
    if (!Number.isFinite(t) || t < this.now + minLeadMin * 60_000 || t > this.now + maxDays * 86_400_000) throw new ServerError("bad_time");
    let a: ApptRow | null = null;
    if (appointmentId) {
      a = this.db.appointments?.[appointmentId] ?? null;
      if (!a || (a.clientId !== uid && a.providerId !== uid)) throw new ServerError("not_found");
      if (a.status !== "accepted") throw new ServerError("not_accepted");
      if (leg !== "there" && leg !== "back") throw new ServerError("bad_leg");
      if ((leg === "there" && t >= a.startsAt) || (leg === "back" && t < a.startsAt)) throw new ServerError("bad_time");
      const appt = a;
      if (Object.values(this.db.rides).some((r) => r.appointmentId === appt.id && r.riderId === uid && r.leg === leg && r.status !== "cancelled" && r.status !== "expired"))
        throw new ServerError("ride_exists");
    } else if (leg) throw new ServerError("bad_leg");
    const mine = Object.values(this.db.rides).filter((r) => r.riderId === uid);
    // At most booking.maxOpen open, and 10 new bookings a day (each one notifies drivers).
    if (
      mine.filter((r) => r.status === "scheduled").length >= (maxOpen ?? 12) ||
      (!template && mine.filter((r) => r.scheduledFor != null && !r.autoBooked && r.requestedAt > this.now - 86_400_000).length >= SERVER.maxBookingsPerDay)
    )
      throw new ServerError("too_many");
    ride.status = "scheduled";
    ride.scheduledFor = t;
    ride.dispatchStartedAt = t;
    ride.appointmentId = a?.id ?? null;
    ride.leg = a ? leg : null;
    ride.autoBooked = template;
    ride.apptSummary = a ? "pending" : null;
    this.db.rides[ride.id] = ride;
    this.effects.notify.add(uid);
    // Everyone who can take it hears about it (Supabase: only those with notifications on).
    for (const d of Object.keys(this.db.vehicles))
      if (d !== uid && this.db.users[d] && !this.db.users[d].deleted && this.linkedRole(d) !== "rider" && this.isMember(d) && this.sameRealm(uid, d))
        this.pushTo(d, "booking_new", ride, { pickup: ride.pickup.label, dropoff: ride.dropoff.label });
    if (a) {
      this.notifyAppt(a);
      // The other party hears that a ride was added (a series template tells once, when it is set).
      if (!template)
        this.pushAppt(a.clientId === uid ? a.providerId : a.clientId, "appt_ride_added", a, { leg: leg ?? undefined, time: t, who: this.db.users[uid]?.nickname ?? "" });
    }
    return this.rideView(ride, uid);
  }

  /** My upcoming bookings, as rider or as the driver who took them, soonest first. */
  bookings(uid: string): RideView[] {
    this.requireMember(uid);
    this.sweep();
    return Object.values(this.db.rides)
      .filter((r) => r.status === "scheduled" && (r.riderId === uid || r.driverId === uid))
      .sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0))
      .map((r) => this.rideView(r, uid));
  }

  /** Bookings without a driver that this driver could take, soonest first. */
  openBookings(uid: string, pos: LatLng | null): OpenBooking[] {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
    if (!this.db.vehicles[uid]) throw new ServerError("no_vehicle");
    this.sweep();
    return Object.values(this.db.rides)
      .filter((r) => this.claimable(r, uid))
      .sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0))
      .map((r) => ({ ride: this.rideView(r, uid), distanceKm: pos && isValidLatLng(pos) ? round1(haversineKm(pos, r.pickup)) : null }));
  }

  private claimable(r: RideRow, uid: string): boolean {
    return r.status === "scheduled" && !r.driverId && r.riderId !== uid && !r.excluded.includes(uid) && this.sameRealm(uid, r.riderId);
  }

  /** A driver takes a booking in advance (atomic: one driver wins); no two overlapping ones. */
  claimBooking(uid: string, rideId: string): "won" {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
    if (!this.db.vehicles[uid]) throw new ServerError("no_vehicle");
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r || r.riderId === uid || r.excluded.includes(uid) || !this.sameRealm(uid, r.riderId)) throw new ServerError("not_found");
    if (r.status !== "scheduled" || r.driverId) throw new ServerError("taken");
    const clash = Object.values(this.db.rides).some(
      (x) =>
        x.status === "scheduled" &&
        x.driverId === uid &&
        Math.abs((x.scheduledFor ?? 0) - (r.scheduledFor ?? 0)) < (Math.max(x.estMin, r.estMin) + 30) * 60_000
    );
    if (clash) throw new ServerError("overlap");
    this.resetRoom(r);
    r.driverId = uid;
    this.notifyRide(r);
    this.pushTo(r.riderId, "booking_taken", r, { driver: this.db.users[uid].nickname });
    return "won";
  }

  /** The driver gives a booking back (close to its time this counts as a driver cancellation). */
  releaseBooking(uid: string, rideId: string): void {
    this.requireUser(uid);
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r || r.driverId !== uid) throw new ServerError("not_found");
    if (r.status !== "scheduled") throw new ServerError("illegal_transition");
    if ((r.scheduledFor ?? 0) - this.now < SERVER.lateBookingChangeS * 1000) this.db.users[uid].driverCancels++;
    r.driverId = null;
    this.effects.notify.add(uid);
    this.effects.notify.add(r.riderId);
    this.pushTo(r.riderId, "booking_released", r, {});
    this.attachedChanged(r);
  }

  cancelRide(uid: string, rideId: string, reason?: string): void {
    this.requireUser(uid);
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r) throw new ServerError("not_found");
    if (r.riderId === uid) return this.riderCancel(r);
    if (r.driverId === uid) return this.driverCancel(r, (reason ?? "other") as DriverCancelReason);
    throw new ServerError("forbidden");
  }

  private riderCancel(r: RideRow): void {
    const u = this.db.users[r.riderId];
    if (r.status === "scheduled") {
      if (u && (r.scheduledFor ?? 0) - this.now < SERVER.lateBookingChangeS * 1000) u.riderCancels++;
      if (r.driverId) this.pushTo(r.driverId, "booking_cancelled", r, { pickup: r.pickup.label });
      this.endRide(r, "cancelled", "rider", null);
      return;
    }
    if (r.status === "requested" || r.status === "accepted" || r.status === "arrived") {
      // Not held against the rider once Siosia gave up on their driver (silent for 15 min).
      const driverLost = r.status === "requested" && r.cancelReason === "driver_lost";
      if (u && !driverLost) {
        u.riderCancels++;
        if (r.status === "arrived") u.lateCancels++;
      }
      this.endRide(r, "cancelled", "rider", r.status === "arrived" ? "late_cancel" : null);
      return;
    }
    throw new ServerError("illegal_transition");
  }

  private driverCancel(r: RideRow, reason: DriverCancelReason): void {
    const driverId = r.driverId!;
    if (r.status === "scheduled") return this.releaseBooking(driverId, r.id);
    if (r.status === "arrived" && reason === "no_show") {
      // A booked ride waits from the booked time, even if the driver came early.
      if (r.arrivedAt === null || this.now < Math.max(r.arrivedAt, r.scheduledFor ?? 0) + this.cfg.timers.noShowS * 1000)
        throw new ServerError("too_early");
      this.endRide(r, "cancelled", "driver", "no_show");
      return;
    }
    if (r.status === "accepted" || r.status === "arrived") {
      const d = this.db.users[driverId];
      if (d) d.driverCancels++;
      this.redispatch(r, reason);
      return;
    }
    throw new ServerError("illegal_transition");
  }

  // ---------- driver ----------

  setOnline(uid: string, online: boolean): void {
    this.requireUser(uid);
    this.sweep();
    if (online) {
      if (this.linkedRole(uid) === "rider") throw new ServerError("rider_only");
      if (!this.db.vehicles[uid]) throw new ServerError("no_vehicle");
      const active = this.activeRideOf(uid);
      if (active && active.riderId === uid) throw new ServerError("active_ride");
      const fresh = !this.db.drivers[uid]?.online;
      this.db.drivers[uid] = { online: true, lastSeen: this.now, standbyUntil: this.standbyUntil() };
      // A new online session reviews every pending request nearby again — including ones this
      // driver declined or let lapse earlier.
      if (fresh) this.clearDecisions(uid);
    } else {
      const active = this.activeRideOf(uid);
      if (active && active.driverId === uid) throw new ServerError("active_trip");
      this.goOffline(uid);
    }
    this.effects.notify.add(uid);
  }

  /**
   * Driver heartbeat while online: refreshes liveness, runs the sweep and — when the driver is
   * idle and sends a position — pulls offers for open requests within the dispatch radius.
   * The position is used for this computation only and is never stored.
   */
  heartbeat(uid: string, pos: LatLng | null): MyState {
    this.requireUser(uid);
    const d = this.db.drivers[uid];
    let idlePos: LatLng | null = null;
    if (d?.online) {
      d.lastSeen = this.now;
      d.standbyUntil = this.standbyUntil();
      this.sweep();
      if (pos && isValidLatLng(pos) && !this.activeRideOf(uid)) {
        idlePos = pos;
        this.pullOffers(uid, pos);
      }
    }
    return this.myState(uid, idlePos);
  }

  /**
   * "Show requests": the driver asks to see every pending request nearby again. Earlier Declines
   * and lapsed cards on open requests are cleared, then all requests in range are offered (one
   * card at a time, the rest queued). Drivers who cancelled a ride after accepting stay excluded.
   */
  refreshOffers(uid: string, pos: LatLng): MyState {
    this.requireUser(uid);
    if (!isValidLatLng(pos)) throw new ServerError("bad_input");
    const d = this.db.drivers[uid];
    if (!d?.online) throw new ServerError("not_online");
    d.lastSeen = this.now;
    this.sweep();
    if (this.activeDriverRideOf(uid)) throw new ServerError("active_trip");
    this.clearDecisions(uid);
    this.pullOffers(uid, pos);
    this.effects.notify.add(uid);
    return this.myState(uid, pos);
  }

  decideOffer(uid: string, offerId: string, decision: "accept" | "decline" | "timeout"): "won" | "ok" {
    this.requireUser(uid);
    this.touchDriver(uid);
    this.sweep();
    const o = this.db.offers[offerId];
    if (!o || o.driverId !== uid) throw new ServerError("not_found");
    const r = this.db.rides[o.rideId];
    if (decision === "accept") {
      if (o.status !== "offered") {
        throw new ServerError(r && r.status !== "requested" && r.driverId !== uid ? "taken" : "offer_expired");
      }
      if (!this.db.drivers[uid]?.online) throw new ServerError("not_online");
      if (this.activeRideOf(uid)) throw new ServerError("active_trip");
      // Atomic claim: only while the ride is still "requested" (SQL: UPDATE … WHERE status = 'requested').
      if (!r || r.status !== "requested" || r.round !== o.round) {
        this.closeOffer(o, "withdrawn");
        throw new ServerError("taken");
      }
      this.resetRoom(r);
      r.status = "accepted";
      r.driverId = uid;
      r.acceptedAt = this.now;
      this.closeOffer(o, "won");
      this.withdrawRideOffers(r.id);
      // The driver is busy now: their other cards go away (those rides stay open for others).
      for (const other of Object.values(this.db.offers))
        if (other.driverId === uid && (other.status === "offered" || other.status === "queued")) this.closeOffer(other, "withdrawn");
      this.notifyRide(r);
      this.pushTo(r.riderId, "driver_coming", r, { driver: this.db.users[uid].nickname });
      return "won";
    }
    if (o.status === "offered" || o.status === "queued") {
      if (decision === "timeout" && o.status === "offered" && o.offeredAt !== null && this.now < o.offeredAt + (this.cfg.timers.offerS - 1) * 1000)
        return "ok"; // early client timer; the server clock decides
      this.closeOffer(o, decision === "decline" ? "declined" : "timed_out");
      this.effects.notify.add(r?.riderId ?? uid);
    } else if (o.status === "withdrawn" || (o.status === "timed_out" && decision === "decline")) {
      // Decided after the card left the screen server-side (phone briefly offline, or a Decline
      // landing just after the countdown): a Decline is recorded as such; a timeout is like any
      // lapsed card and comes back after retryS.
      o.status = decision === "decline" ? "declined" : "timed_out";
      o.decidedAt = this.now;
    }
    return "ok";
  }

  /**
   * 2.2: the driver's phone saw the car move towards the pickup (FR-180). Told once, while the
   * ride is accepted; later calls and other statuses change nothing (the phone may repeat it).
   */
  depart(uid: string, rideId: string): RideView {
    this.requireUser(uid);
    this.touchDriver(uid);
    const r = this.db.rides[rideId];
    if (!r) throw new ServerError("not_found");
    if (r.driverId !== uid) throw new ServerError("forbidden");
    if (r.status === "accepted" && !r.departedAt) {
      r.departedAt = this.now;
      this.notifyRide(r);
      this.pushTo(r.riderId, "driver_departed", r, { driver: this.db.users[uid].nickname });
    }
    return this.rideView(r, uid);
  }

  advance(uid: string, rideId: string, to: "arrived" | "in_progress" | "completed", actualKm?: number): RideView {
    this.requireUser(uid);
    this.touchDriver(uid);
    this.sweep();
    const r = this.db.rides[rideId];
    if (!r) throw new ServerError("not_found");
    if (r.driverId !== uid) throw new ServerError("forbidden");
    const legal =
      (r.status === "accepted" && to === "arrived") ||
      (r.status === "arrived" && to === "in_progress") ||
      (r.status === "in_progress" && to === "completed");
    if (!legal) throw new ServerError("illegal_transition");
    r.status = to;
    if (to === "arrived") {
      r.arrivedAt = this.now;
      this.pushTo(r.riderId, "driver_arrived", r, { driver: this.db.users[uid].nickname });
    }
    if (to === "in_progress") r.startedAt = this.now;
    if (to === "completed") {
      r.endedAt = this.now;
      const km = Number.isFinite(actualKm) ? Math.min(Math.max(actualKm ?? 0, 0), 1000) : 0;
      r.actualKm = round1(km);
      r.actualMin = round1((this.now - (r.startedAt ?? this.now)) / 60000);
    }
    this.notifyRide(r);
    return this.rideView(r, uid);
  }

  // ---------- after the ride ----------

  markPaid(uid: string, rideId: string): void {
    const r = this.afterRide(uid, rideId);
    if (r.riderId !== uid) throw new ServerError("forbidden");
    r.paid = true;
    this.notifyRide(r);
  }

  markCollected(uid: string, rideId: string): void {
    const r = this.afterRide(uid, rideId);
    if (r.driverId !== uid) throw new ServerError("forbidden");
    r.collected = true;
    this.notifyRide(r);
  }

  rate(uid: string, rideId: string, stars: number, comment: string): void {
    const r = this.afterRide(uid, rideId);
    const to = r.riderId === uid ? r.driverId : r.driverId === uid ? r.riderId : null;
    if (!to) throw new ServerError("forbidden");
    const s = Math.round(stars);
    if (s < 1 || s > 5) throw new ServerError("bad_input");
    if (this.db.ratings.some((x) => x.rideId === rideId && x.fromUser === uid)) throw new ServerError("already_rated");
    this.db.ratings.push({ rideId, fromUser: uid, toUser: to, stars: s, comment: comment.trim().slice(0, 140), createdAt: this.now });
    this.notifyRide(r);
  }

  /** 2.9 (FR-315, V74): the rider thanks the driver with a tip — once, within the after-ride window. */
  tipRide(uid: string, rideId: string, amount: number): RideView {
    const r = this.afterRide(uid, rideId);
    if (r.riderId !== uid || !r.driverId) throw new ServerError("forbidden");
    const v = tipAmount(amount, TIP_RIDE_MAX);
    if (r.tip != null) throw new ServerError("already_tipped");
    r.tip = v;
    r.tipAt = this.now;
    this.pushTo(r.driverId, "ride_tip", r, { sender: this.nick(uid), total: v, currency: r.currency, pickup: r.pickup.label });
    this.notifyRide(r);
    return this.rideView(r, uid);
  }

  private afterRide(uid: string, rideId: string): RideRow {
    this.requireUser(uid);
    const r = this.db.rides[rideId];
    if (!r || (r.riderId !== uid && r.driverId !== uid)) throw new ServerError("not_found");
    if (r.status !== "completed") throw new ServerError("illegal_transition");
    if (r.endedAt !== null && this.now > r.endedAt + SERVER.afterRideWindowS * 1000) throw new ServerError("window_closed");
    return r;
  }

  // ---------- system ----------

  /** Timeouts, expiry, lost drivers. Runs on every call ("expiry check on read") and on a timer. */
  sweep(): void {
    const { offerS } = this.cfg.timers;
    this.sweepAppointments();
    this.sweepFamily();
    this.sweepBookings();
    for (const o of Object.values(this.db.offers)) {
      if (o.status === "offered" && o.offeredAt !== null && this.now >= o.offeredAt + offerS * 1000) this.closeOffer(o, "timed_out");
    }
    for (const [uid, d] of Object.entries(this.db.drivers)) {
      if (!d.online) continue;
      const silentMs = this.now - d.lastSeen;
      // Silent > 12 s (tab killed, phone offline): the driver loses their cards at once…
      if (silentMs > SERVER.driverStaleS * 1000) {
        for (const o of Object.values(this.db.offers))
          if (o.driverId === uid && (o.status === "offered" || o.status === "queued")) this.closeOffer(o, "withdrawn");
      }
      // …and an idle driver silent for 60 s is set offline (a short screen lock is tolerated).
      if (silentMs > SERVER.driverLostS * 1000 && !this.activeDriverRideOf(uid)) {
        d.online = false;
        this.effects.notify.add(uid);
      }
    }
    for (const r of Object.values(this.db.rides)) {
      if (r.status === "requested" && this.now >= this.expiresAt(r)) {
        this.endRide(r, "expired", "system", null);
      } else if ((r.status === "accepted" || r.status === "arrived") && r.driverId) {
        // A booked ride gives its driver until 15 min after the booked time to show up.
        if (r.scheduledFor != null && this.now < r.scheduledFor + SERVER.bookingLateS * 1000) continue;
        const d = this.db.drivers[r.driverId];
        // Silent for minutes is normal on an iPhone (screen locked, Maps in front): wait longer.
        if (!d || this.now - d.lastSeen > SERVER.rideDriverLostS * 1000) {
          const lost = r.driverId;
          if (d) d.online = false;
          this.redispatch(r, "driver_lost");
          this.effects.notify.add(lost);
        }
      }
    }
  }

  /**
   * Bookings: a claimed one starts (driver on the way) `leadMin` before its time; an unclaimed one
   * opens to normal dispatch `openMin` before. Either waits while its people are busy and gives up
   * 15 minutes after the booked time.
   */
  private sweepBookings(): void {
    const { leadMin, openMin } = this.cfg.booking;
    const lateMs = SERVER.bookingLateS * 1000;
    for (const r of Object.values(this.db.rides)) {
      if (r.status !== "scheduled" || r.scheduledFor == null) continue;
      const t = r.scheduledFor;
      if (this.now < t - (r.driverId ? leadMin : openMin) * 60_000) continue;
      // A booking whose rider no longer exists ends; one whose driver is gone loses its driver.
      const rider = this.db.users[r.riderId];
      if (!rider || rider.deleted) {
        this.endRide(r, "cancelled", "system", "user_gone");
        continue;
      }
      if (r.driverId && (!this.db.users[r.driverId] || this.db.users[r.driverId].deleted)) r.driverId = null;
      // Busy = any active ride in either role (a rider who is driving someone is busy too).
      const riderBusy = !!this.activeRideOf(r.riderId);
      if (r.driverId && !riderBusy && !this.activeRideOf(r.driverId)) this.startBooking(r);
      else if (!r.driverId && !riderBusy) this.openBooking(r);
      else if (this.now > t + lateMs) {
        if (riderBusy) this.endRide(r, "expired", "system", null);
        else this.openBooking(r);
      }
    }
  }

  /** Claimed booking: the ride is now accepted and the driver on duty (even before their app opens). */
  private startBooking(r: RideRow): void {
    const driverId = r.driverId!;
    r.status = "accepted";
    r.acceptedAt = this.now;
    r.dispatchStartedAt = this.now;
    this.db.drivers[driverId] = { online: true, lastSeen: this.now, standbyUntil: this.standbyUntil() };
    for (const o of Object.values(this.db.offers))
      if (o.driverId === driverId && (o.status === "offered" || o.status === "queued")) this.closeOffer(o, "withdrawn");
    this.notifyRide(r);
    this.pushTo(driverId, "time_to_go", r, { pickup: r.pickup.label, rider: this.db.users[r.riderId]?.nickname ?? "" });
    this.pushTo(r.riderId, "driver_coming", r, { driver: this.db.users[driverId]?.nickname ?? "" });
  }

  /** Unclaimed (or its driver still busy): the booking becomes a normal request. */
  private openBooking(r: RideRow): void {
    const had = r.driverId;
    r.status = "requested";
    r.driverId = null;
    r.dispatchStartedAt = this.now;
    r.notifiedCount = 0;
    this.effects.pingDrivers = true;
    this.effects.notify.add(r.riderId);
    if (had) this.effects.notify.add(had);
    this.pushTo(r.riderId, "booking_open", r, {});
    this.pushStandby(r);
  }

  private standbyUntil(): number | null {
    return this.cfg.standbyHours > 0 ? this.now + this.cfg.standbyHours * 3600_000 : null;
  }

  /** Drivers on standby whose app is not in front (phone locked, app closed) hear about a new request. */
  private pushStandby(r: RideRow): void {
    for (const [d, row] of Object.entries(this.db.drivers)) {
      if (!row.standbyUntil || row.standbyUntil <= this.now) continue;
      if (row.online && this.now - row.lastSeen < SERVER.activeAppS * 1000) continue; // the offer card shows it
      const u = this.db.users[d];
      if (!u || u.deleted || d === r.riderId || r.excluded.includes(d) || !this.db.vehicles[d] || !this.sameRealm(d, r.riderId)) continue;
      if (this.linkedRole(d) === "rider" || this.activeRideOf(d)) continue;
      this.pushTo(d, "request_new", r, { pickup: r.pickup.label });
    }
  }

  private pushTo(userId: string, kind: PushKind, r: RideRow, params: PushParams): void {
    if (!this.isMember(userId)) return;
    this.deliver({ userId, kind, rideId: r.id, params: { at: r.scheduledFor ?? null, ...params } });
  }

  /** A notification out (push) and kept for the bell (2.9, V73); the bell refreshes live. */
  private deliver(ev: PushEvent): void {
    this.effects.push.push(ev);
    const all = (this.db.notifications ??= []);
    all.push({
      id: this.nextId("n"),
      userId: ev.userId,
      kind: ev.kind,
      params: ev.params,
      rideId: ev.rideId,
      appointmentId: ev.appointmentId ?? null,
      createdAt: this.now,
      readAt: null
    });
    const mine = all.filter((n) => n.userId === ev.userId);
    if (mine.length > NOTIF_MAX) {
      const drop = new Set(mine.slice(0, mine.length - NOTIF_MAX));
      this.db.notifications = all.filter((n) => !drop.has(n));
    }
    this.effects.notify.add(ev.userId);
  }

  /** 2.9 (FR-312): my notifications, newest first (the last 60 days, at most 50), and how many are unread. */
  notifications(uid: string): { items: NotificationItem[]; unread: number } {
    this.requireUser(uid);
    const mine = (this.db.notifications ?? []).filter((n) => n.userId === uid && n.createdAt > this.now - NOTIF_KEEP_MS);
    return {
      items: mine
        .slice()
        .reverse()
        .slice(0, NOTIF_LIST)
        .map((n) => ({ id: n.id, kind: n.kind, params: n.params, rideId: n.rideId, appointmentId: n.appointmentId, createdAt: n.createdAt, read: n.readAt !== null })),
      unread: mine.filter((n) => n.readAt === null).length
    };
  }

  /** 2.9 (FR-312): opening the bell marks everything read. */
  readNotifications(uid: string): void {
    this.requireUser(uid);
    for (const n of this.db.notifications ?? []) if (n.userId === uid && n.readAt === null) n.readAt = this.now;
    this.effects.notify.add(uid);
  }

  /** When an open request expires; a booked one waits at least until 15 min after its time. */
  private expiresAt(r: RideRow): number {
    const base = r.dispatchStartedAt + this.cfg.timers.expiryS * 1000;
    return r.scheduledFor != null ? Math.max(base, r.scheduledFor + SERVER.bookingLateS * 1000) : base;
  }

  // ---------- 2.0: catalog, offers, My place ----------

  /** The enabled catalog with who offers each "time" entry (public ids only), without the viewer. */
  catalog(uid: string): CatalogItem[] {
    this.requireMember(uid);
    return this.cfg.services
      .filter((e) => e.enabled)
      .map((e) => ({
        ...e,
        providers:
          e.kind !== "time"
            ? []
            : Object.values(this.db.users)
                // 2.8 (V68, V70): who offers it (or its base), or has a contract for it with my family
                .filter(
                  (u) =>
                    !u.deleted &&
                    u.id !== uid &&
                    this.isMember(u.id) &&
                    this.sameRealm(uid, u.id) &&
                    this.listed(u.id, uid) &&
                    (this.offersService(u.id, e) || this.contractRate(uid, u.id, e.id) !== null)
                )
                .sort((a, b) => a.nickname.localeCompare(b.nickname))
                // Whoever browses the catalog may see the providers' photos (FR-211).
                .map((u): CatalogProvider => ({ ...this.publicParty(u.id, true), contractRate: this.contractRate(uid, u.id, e.id)?.perHour ?? null }))
      }));
  }

  /** Services I offer (FR-093): enabled "time" entries; a master profile's preset cannot change. */
  setOffers(uid: string, ids: string[]): Profile {
    const u = this.requireUser(uid);
    if (this.linkedMaster(uid)) throw new ServerError("forbidden");
    for (const id of ids) {
      const e = this.service(id);
      if (!e || e.kind !== "time" || !e.enabled) throw new ServerError("bad_service");
    }
    u.offers = [...new Set(ids)];
    this.effects.notify.add(uid);
    return this.getProfile(uid)!;
  }

  /** My place (FR-140); null clears it. */
  saveHome(uid: string, place: Place | null): Profile {
    const u = this.requireUser(uid);
    if (place !== null && (!isValidLatLng(place) || !String(place.label ?? "").trim())) throw new ServerError("bad_input");
    u.home = place === null ? null : cleanPlace(place);
    return this.getProfile(uid)!;
  }

  // ---------- 2.0: appointments ----------

  /**
   * Send request (V3, V4, V23): optionally a weekly / every-2-weeks series. 2.1 (V34): without a
   * provider it is an open request to every other member — the same rules, minus the provider's.
   */
  requestService(uid: string, input: ServiceRequestInput): AppointmentView {
    this.requireUser(uid);
    this.sweep();
    const e = this.service(input.serviceId);
    if (!e || e.kind !== "time" || !e.enabled || !e.duration) throw new ServerError("bad_service");
    const open = input.providerId == null;
    const provider = open ? null : Object.values(this.db.users).find((u) => !u.deleted && u.publicId === input.providerId);
    if (!open) {
      if (!provider || provider.id === uid || !this.isMember(provider.id) || !this.sameRealm(uid, provider.id)) throw new ServerError("no_provider");
      // 2.8 (V68, V70): offered (itself or its base), or on a contract between my family and them.
      if (!this.offersService(provider.id, e) && !this.contractRate(uid, provider.id, e.id)) throw new ServerError("not_offered");
    }
    const { minLeadMin, maxDays } = this.cfg.booking;
    const t0 = input.startsAt;
    if (!Number.isFinite(t0) || t0 < this.now + minLeadMin * 60_000 || t0 > this.now + maxDays * 86_400_000) throw new ServerError("bad_time");
    const d = Math.round(input.durationMin);
    if (!Number.isFinite(input.durationMin) || d < e.duration.min || d > e.duration.max || (d - e.duration.min) % e.duration.step !== 0)
      throw new ServerError("bad_duration");
    const note = String(input.note ?? "").trim();
    const place = input.place ?? null;
    if ((place === null && e.needsPlace) || (place !== null && (!isValidLatLng(place) || !String(place.label ?? "").trim())) || note.length > 200)
      throw new ServerError("bad_input");
    // 2.3 (FR-201): the client's own kids come along, on every occurrence of a series.
    const kidIds = input.kidIds == null ? [] : this.ownKidIds(uid, input.kidIds);
    // 2.6 (FR-262, V62): an active contract between my family and the provider sets the rate.
    const { rate, price, contractId } = this.priceFor(e, uid, provider?.id ?? null, d);
    // The occurrences: one, or a series at the same wall-clock time every 1 or 2 weeks.
    const tz = this.cfg.timezone;
    const { seriesMaxCount, seriesMaxDays } = this.cfg.appointment;
    let starts = [t0];
    const rep = input.repeat;
    if (rep) {
      if (rep.every !== 1 && rep.every !== 2) throw new ServerError("bad_repeat");
      starts = [];
      if (typeof rep.count === "number") {
        if (rep.count < 2 || rep.count > seriesMaxCount) throw new ServerError("bad_repeat");
        for (let k = 0; k < rep.count; k++) starts.push(addWeeksWallClock(t0, k * rep.every, tz));
      } else if (typeof rep.until === "number") {
        const last = localDate(rep.until, tz);
        for (let k = 0; k <= seriesMaxCount; k++) {
          const t = addWeeksWallClock(t0, k * rep.every, tz);
          if (localDate(t, tz) > last) break;
          starts.push(t);
        }
        if (starts.length < 2 || starts.length > seriesMaxCount) throw new ServerError("bad_repeat");
      } else throw new ServerError("bad_repeat");
      if (starts[starts.length - 1] > this.now + seriesMaxDays * 86_400_000) throw new ServerError("bad_repeat");
    }
    // Limits: ≤ 10 open single appointments, ≤ 3 open series, ≤ 20 new a day (a series counts once).
    const appts = Object.values(this.db.appointments ?? {});
    if (starts.length === 1) {
      if (appts.filter((a) => a.clientId === uid && !a.seriesId && (a.status === "requested" || a.status === "accepted") && a.startsAt > this.now).length >= SERVER.maxOpenAppointments)
        throw new ServerError("too_many");
    } else if (
      Object.values(this.db.series ?? {}).filter(
        (s) =>
          s.clientId === uid &&
          (s.status === "requested" || s.status === "answered") &&
          appts.some((a) => a.seriesId === s.id && (a.status === "requested" || a.status === "accepted") && a.startsAt > this.now)
      ).length >= SERVER.maxOpenSeries
    )
      throw new ServerError("too_many");
    const dayAgo = this.now - 86_400_000;
    if (
      appts.filter((a) => a.clientId === uid && !a.seriesId && a.requestedAt > dayAgo).length +
        Object.values(this.db.series ?? {}).filter((s) => s.clientId === uid && s.requestedAt > dayAgo).length >=
      SERVER.maxRequestsPerDay
    )
      throw new ServerError("too_many");
    const base = {
      clientId: uid,
      providerId: provider?.id ?? null,
      serviceId: e.id,
      durationMin: d,
      place: place ? cleanPlace(place) : null,
      note,
      price,
      currency: this.cfg.tariff.currency
    };
    let series: SeriesRow | null = null;
    const priced = { rate, contractId, actualMin: null, summarySent: false };
    if (starts.length > 1) {
      series = {
        ...base,
        id: this.nextId("s"),
        rule: rep!.every === 1 ? "weekly" : "biweekly",
        firstStart: starts[0],
        count: starts.length,
        until: starts[starts.length - 1],
        status: "requested",
        rideTemplates: [],
        templatesAt: null,
        requestedAt: this.now,
        answeredAt: null
      };
      (this.db.series ??= {})[series.id] = series;
    }
    let first: ApptRow | null = null;
    starts.forEach((t, i) => {
      const a: ApptRow = {
        ...base,
        id: this.nextId("a"),
        status: "requested",
        startsAt: t,
        requestedAt: this.now,
        answeredAt: null,
        endedAt: null,
        cancelledBy: null,
        cancelReason: null,
        reminded: [],
        seriesId: series?.id ?? null,
        seq: series ? i + 1 : null,
        ...priced
      };
      (this.db.appointments ??= {})[a.id] = a;
      if (kidIds.length) (this.db.appointmentKids ??= {})[a.id] = [...kidIds];
      first ??= a;
    });
    this.notifyAppt(first!);
    if (provider) this.pushAppt(provider.id, "appt_new", first!, this.seriesParams(series));
    else {
      // V36: every other member hears once (a series as its first date); their lists and badges update.
      for (const m of this.members(uid)) if (this.sameRealm(uid, m)) this.pushAppt(m, "appt_open", first!, { ...this.seriesParams(series), open: true });
      this.notifyMembers();
    }
    return this.apptView(first!, uid);
  }

  /** Accept / Decline (V5, V24): a series is answered as a whole; Accept declines the clashes. */
  answerAppointment(uid: string, id: string, decision: "accept" | "decline"): AppointmentView {
    this.requireUser(uid);
    if (decision !== "accept" && decision !== "decline") throw new ServerError("bad_input");
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || a.providerId !== uid) throw new ServerError("not_found");
    if (a.status !== "requested") throw new ServerError("illegal_transition");
    this.settle(uid, a, decision);
    this.notifyAppt(a);
    return this.apptView(a, uid);
  }

  /**
   * 2.1 "I can do it" (V35, FR-163): the caller becomes the provider of someone's open request and
   * it is accepted at once — the first taker wins; a series is taken as a whole (its clashing dates
   * declined, as on Accept); a single request that clashes with the caller's schedule stays open,
   * and so does a series none of whose open dates the caller is free for (nothing to accept).
   */
  takeRequest(uid: string, id: string): AppointmentView {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || !this.sameRealm(uid, a.clientId)) throw new ServerError("not_found");
    // 2.6 (FR-254): my family's open request is ours, not one to take.
    if (a.clientId === uid || this.sameFamily(uid, a.clientId)) throw new ServerError("forbidden");
    if (a.providerId !== null) throw new ServerError("taken");
    if (a.status !== "requested" || a.startsAt <= this.now) throw new ServerError("illegal_transition");
    // Before the claim (twin of siosia_take_request): nothing is changed or told when it clashes —
    // a single request the caller is busy for, or a series none of whose open dates the caller is
    // free for (every date declined would be no take at all).
    const free = (o: ApptRow) => !this.providerBusy(uid, o.startsAt, o.durationMin, o.id);
    const open = a.seriesId ? this.occurrences(a.seriesId).filter((o) => o.providerId === null && o.status === "requested") : [a];
    if (!open.some(free)) throw new ServerError("overlap");
    // The claim (SQL: UPDATE … WHERE provider_id IS NULL AND status = 'requested'), then the Accept.
    if (a.seriesId) {
      this.db.series![a.seriesId].providerId = uid;
      for (const o of this.occurrences(a.seriesId)) if (o.providerId === null && o.status === "requested") o.providerId = uid;
    } else a.providerId = uid;
    this.settle(uid, a, "accept");
    // 2.6 (FR-262): the taker's contract with the client's family reprices what was accepted.
    const e = this.service(a.serviceId);
    const p = e ? this.priceFor(e, a.clientId, uid, a.durationMin) : null;
    if (p?.contractId) {
      for (const o of a.seriesId ? this.occurrences(a.seriesId) : [a])
        if (o.providerId === uid && o.status === "accepted") Object.assign(o, { rate: p.rate, contractId: p.contractId, price: round2((p.rate! * o.durationMin) / 60) });
      if (a.seriesId) this.db.series![a.seriesId].price = p.price;
    }
    this.notifyMembers();
    return this.apptView(a, uid);
  }

  /** The provider's answer to a requested appointment (a series as a whole; Accept declines the clashes). */
  private settle(uid: string, a: ApptRow, decision: "accept" | "decline"): void {
    if (!a.seriesId) {
      if (decision === "accept") {
        if (this.providerBusy(uid, a.startsAt, a.durationMin, a.id)) throw new ServerError("overlap");
        a.status = "accepted";
        a.answeredAt = this.now;
        this.pushAppt(a.clientId, "appt_accepted", a, {});
      } else {
        a.status = "declined";
        a.answeredAt = this.now;
        a.endedAt = this.now;
        this.pushAppt(a.clientId, "appt_declined", a, {});
      }
    } else {
      const s = this.db.series![a.seriesId];
      const declined: number[] = [];
      let accepted = 0;
      for (const o of this.occurrences(a.seriesId).filter((x) => x.status === "requested")) {
        o.answeredAt = this.now;
        if (decision === "accept" && !this.providerBusy(uid, o.startsAt, o.durationMin, o.id)) {
          o.status = "accepted";
          accepted++;
        } else {
          o.status = "declined";
          o.endedAt = this.now;
          if (decision === "accept") declined.push(o.startsAt);
        }
      }
      s.status = "answered";
      s.answeredAt = this.now;
      this.pushAppt(a.clientId, accepted > 0 ? "appt_accepted" : "appt_declined", a, { ...this.seriesParams(s), accepted, declined });
    }
  }

  /** Cancel (FR-102, V25): this one or all remaining; rides follow; the other party is told once. */
  cancelAppointment(uid: string, id: string, reason?: string | null, scope: "one" | "series" = "one"): void {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || (a.clientId !== uid && a.providerId !== uid)) throw new ServerError("not_found");
    const who = a.clientId === uid ? "client" : "provider";
    const allowed = (x: ApptRow) => x.status === "accepted" || (x.status === "requested" && who === "client");
    const series = scope === "series" && !!a.seriesId;
    let targets: ApptRow[];
    if (series) {
      targets = this.occurrences(a.seriesId!).filter((x) => x.startsAt > this.now && allowed(x));
      if (!targets.length) throw new ServerError("illegal_transition");
    } else {
      if (this.now >= a.startsAt || !allowed(a)) throw new ServerError("illegal_transition");
      targets = [a];
    }
    const why = String(reason ?? "").trim().slice(0, 60) || null;
    for (const x of targets) {
      x.status = "cancelled";
      x.endedAt = this.now;
      x.cancelledBy = who;
      x.cancelReason = why;
      this.notifyAppt(x);
    }
    // 2.1: a withdrawn open request leaves everyone's "You could help" list (nobody else is told).
    if (targets.some((x) => x.providerId === null)) this.notifyMembers();
    this.cascadeRides(targets.map((x) => x.id));
    if (a.seriesId && !this.occurrences(a.seriesId).some((x) => (x.status === "requested" || x.status === "accepted") && x.startsAt > this.now)) {
      const s = this.db.series![a.seriesId];
      if (s.status === "requested" || s.status === "answered") s.status = "cancelled";
    }
    this.pushAppt(who === "client" ? a.providerId : a.clientId, "appt_cancelled", a, {
      who: this.db.users[uid]?.nickname ?? "",
      ...(series ? { from: targets[0].startsAt, left: targets.length } : {})
    });
  }

  getAppointment(uid: string, id: string): AppointmentView {
    this.requireMember(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    // 2.1: an open request also opens for a member who could take it (candidate view, V34); 2.6: my family's too.
    if (!a || (!this.sees(uid, a) && !this.takeable(a, uid))) throw new ServerError("not_found");
    return this.apptView(a, uid);
  }

  /** A series ride template (V26): the caller is the passenger; bookings within the horizon at once. */
  setRideTemplate(uid: string, seriesId: string, t: RideTemplateInput): AppointmentView {
    this.requireUser(uid);
    if (this.linkedRole(uid) === "driver") throw new ServerError("driver_only");
    this.sweep();
    const s = this.db.series?.[seriesId];
    if (!s || (s.clientId !== uid && s.providerId !== uid)) throw new ServerError("not_found");
    if (s.status !== "answered" || !this.occurrences(s.id).some((x) => x.status === "accepted")) throw new ServerError("not_accepted");
    if (t.leg !== "there" && t.leg !== "back") throw new ServerError("bad_leg");
    // Bounded like a booking (bookFor): what the sweep books later must be bookable there. The
    // estimates are kept to 3 decimals (as in SQL), and a trip that rounds to 0 km is none.
    if (
      !Number.isFinite(t.offsetMin) ||
      !Number.isFinite(t.estKm) ||
      !Number.isFinite(t.estMin) ||
      round3(t.estKm) <= 0 ||
      t.estMin < 0 ||
      t.estMin > MAX_EST_MIN ||
      !t.pickup ||
      !t.dropoff ||
      !isValidLatLng(t.pickup) ||
      !isValidLatLng(t.dropoff) ||
      !String(t.pickup.label ?? "").trim() ||
      !String(t.dropoff.label ?? "").trim()
    )
      throw new ServerError("bad_input");
    // Over the longest trip is too far, as for a booking (not a bad template).
    if (t.estKm > this.cfg.maxTripKm) throw new ServerError("too_far");
    const off = Math.trunc(t.offsetMin);
    if ((t.leg === "there" && (off < -1440 || off > -1)) || (t.leg === "back" && (off < -s.durationMin || off > 1440))) throw new ServerError("bad_time");
    const role: PartyRole = s.clientId === uid ? "client" : "provider";
    // Stored clean: only the known keys (cleanPlace drops anything else in the places).
    const tpl: StoredTemplate = {
      passenger: role,
      leg: t.leg,
      pickup: cleanPlace(t.pickup),
      dropoff: cleanPlace(t.dropoff),
      offsetMin: off,
      estKm: round3(t.estKm),
      estMin: round3(t.estMin),
      fareIsEstimate: t.fareIsEstimate === true
    };
    // The same template again changes nothing and tells nobody (a party cannot flood the other).
    const same = s.rideTemplates.some((x) => x.passenger === role && x.leg === t.leg && sameTemplate(x, tpl));
    if (!same) s.rideTemplates = [...s.rideTemplates.filter((x) => !(x.passenger === role && x.leg === t.leg)), tpl];
    this.materialize(s.id);
    const occ = this.occurrences(s.id);
    const a = occ.find((x) => (x.status === "requested" || x.status === "accepted") && x.startsAt > this.now) ?? occ[occ.length - 1];
    if (!same)
      this.pushAppt(role === "client" ? s.providerId : s.clientId, "appt_ride_added", a, {
        ...this.seriesParams(s),
        leg: t.leg,
        who: this.db.users[uid]?.nickname ?? "",
        repeat: true
      });
    this.notifyAppt(a);
    return this.apptView(a, uid);
  }

  /** No more rides for this series (the caller's template for a leg); existing bookings stay. */
  dropRideTemplate(uid: string, seriesId: string, leg: Leg): void {
    this.requireUser(uid);
    const s = this.db.series?.[seriesId];
    if (!s || (s.clientId !== uid && s.providerId !== uid)) throw new ServerError("not_found");
    const role: PartyRole = s.clientId === uid ? "client" : "provider";
    s.rideTemplates = s.rideTemplates.filter((x) => !(x.passenger === role && x.leg === leg));
    this.notifyAppt(s);
  }

  /** Planned (V17): upcoming appointments and rides of both roles; 2.1: others' open requests (V34). */
  planned(uid: string): Planned {
    this.requireMember(uid);
    this.sweep();
    return {
      appointments: Object.values(this.db.appointments ?? {})
        .filter((a) => this.sees(uid, a) && (a.status === "requested" || a.status === "accepted") && this.endOf(a) > this.now)
        .sort((x, y) => x.startsAt - y.startsAt)
        .map((a) => this.apptView(a, uid)),
      rides: Object.values(this.db.rides)
        .filter((r) => (r.riderId === uid || r.driverId === uid) && (r.status === "scheduled" || isActive(r.status)))
        .sort((x, y) => (x.scheduledFor ?? x.requestedAt) - (y.scheduledFor ?? y.requestedAt))
        .map((r) => this.rideView(r, uid)),
      open: this.openFor(uid).map((a) => this.apptView(a, uid))
    };
  }

  /** History (FR-133): finished appointments and rides, the last 50 of each, newest first. */
  timeline(uid: string): HistoryItem[] {
    this.requireMember(uid);
    const appts: HistoryItem[] = Object.values(this.db.appointments ?? {})
      .filter((a) => this.sees(uid, a) && ["done", "declined", "cancelled", "expired"].includes(a.status))
      .sort((x, y) => y.startsAt - x.startsAt)
      .slice(0, SERVER.historyLimit)
      .map((a) => ({ kind: "appointment", at: a.startsAt, appointment: this.apptView(a, uid) }));
    const rides: HistoryItem[] = Object.values(this.db.rides)
      .filter((r) => (r.riderId === uid || r.driverId === uid) && (r.status === "completed" || r.status === "cancelled" || r.status === "expired"))
      .sort((x, y) => (y.scheduledFor ?? y.requestedAt) - (x.scheduledFor ?? x.requestedAt))
      .slice(0, SERVER.historyLimit)
      .map((r) => ({ kind: "ride", at: r.scheduledFor ?? r.requestedAt, ride: this.rideView(r, uid) }));
    return [...appts, ...rides].sort((x, y) => y.at - x.at);
  }

  /** Rate a done appointment once within 24 h (FR-106). */
  rateAppointment(uid: string, id: string, stars: number, comment: string): void {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || (a.clientId !== uid && a.providerId !== uid)) throw new ServerError("not_found");
    if (a.status !== "done") throw new ServerError("illegal_transition");
    if (this.now > (a.endedAt ?? this.endOf(a)) + SERVER.apptRatingWindowS * 1000) throw new ServerError("window_closed");
    const s = Math.round(stars);
    if (!Number.isFinite(stars) || s < 1 || s > 5) throw new ServerError("bad_input");
    if (this.db.ratings.some((x) => x.appointmentId === id && x.fromUser === uid)) throw new ServerError("already_rated");
    // Done means accepted, so there is a provider (an open request never gets here).
    const to = a.clientId === uid ? a.providerId : a.clientId;
    if (!to) throw new ServerError("illegal_transition");
    this.db.ratings.push({ appointmentId: id, fromUser: uid, toUser: to, stars: s, comment: String(comment ?? "").trim().slice(0, 140), createdAt: this.now });
    this.notifyAppt(a);
  }

  // ---------- 2.3: kids (FR-200–204, V44, V45) ----------

  /** My family's kids (2.6, FR-253: every member's) with every rating they got (S2 → My kids), oldest first. */
  kids(uid: string): Kid[] {
    this.requireUser(uid);
    return this.familyKids(uid).map((k) => this.kidView(k, uid));
  }

  addKid(uid: string, input: KidInput): Kid {
    this.requireUser(uid);
    const clean = this.cleanKid(input);
    if (this.kidsOf(uid).length >= KIDS_MAX) throw new ServerError("too_many");
    const k: KidRow = { id: this.nextId("k"), ownerId: uid, photoPath: null, createdAt: this.now, ...clean };
    (this.db.kids ??= {})[k.id] = k;
    this.notifyHousehold(uid);
    return this.kidView(k, uid);
  }

  updateKid(uid: string, id: string, input: KidInput): Kid {
    const k = this.ownKid(uid, id);
    Object.assign(k, this.cleanKid(input));
    this.kidChanged(k);
    return this.kidView(k, uid);
  }

  /** Removes one of my family's kids: its photo, ratings and attachments go with it (FR-204, FR-253). */
  removeKid(uid: string, id: string): void {
    this.deleteKid(this.ownKid(uid, id));
    this.notifyHousehold(uid);
  }

  /** The client attaches (replaces) their own kids on an appointment, until it ends (FR-201). */
  setAppointmentKids(uid: string, id: string, kidIds: string[]): AppointmentView {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a) throw new ServerError("not_found");
    if (a.clientId !== uid) throw new ServerError("forbidden");
    // Ended = done, declined, cancelled or expired (an accepted one past its end is done by the sweep).
    if (a.status !== "requested" && a.status !== "accepted") throw new ServerError("illegal_transition");
    (this.db.appointmentKids ??= {})[a.id] = this.ownKidIds(uid, kidIds);
    this.notifyAppt(a);
    return this.apptView(a, uid);
  }

  /**
   * The provider rates an attached kid once, within 24 h after a done appointment (FR-203). The
   * owner's own rating (FR-060) is a different table and stays untouched.
   */
  rateKid(uid: string, appointmentId: string, kidId: string, stars: number, comment: string): void {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[appointmentId];
    if (!a || (a.clientId !== uid && a.providerId !== uid)) throw new ServerError("not_found");
    if (a.clientId === uid) throw new ServerError("forbidden");
    if (!this.kidsIn(a.id).some((k) => k.id === kidId)) throw new ServerError("not_found");
    if (a.status !== "done") throw new ServerError("illegal_transition");
    if (this.now > (a.endedAt ?? this.endOf(a)) + SERVER.apptRatingWindowS * 1000) throw new ServerError("window_closed");
    const s = Math.round(stars);
    if (!Number.isFinite(stars) || s < 1 || s > 5) throw new ServerError("bad_input");
    const all = (this.db.kidRatings ??= []);
    if (all.some((g) => g.appointmentId === a.id && g.kidId === kidId)) throw new ServerError("already_rated");
    all.push({ appointmentId: a.id, kidId, fromUser: uid, stars: s, comment: String(comment ?? "").trim().slice(0, 140), createdAt: this.now });
    this.notifyAppt(a);
  }

  private kidsOf(uid: string): KidRow[] {
    return Object.values(this.db.kids ?? {})
      .filter((k) => k.ownerId === uid)
      .sort((x, y) => x.createdAt - y.createdAt);
  }

  /** 2.6 (FR-253): the kids of everyone in my family (mine alone without one), oldest first. */
  private familyKids(uid: string): KidRow[] {
    const people = new Set(this.household(uid));
    return Object.values(this.db.kids ?? {})
      .filter((k) => people.has(k.ownerId))
      .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
  }

  /** One of the caller's family's kids (not_found for anyone else's). */
  private ownKid(uid: string, id: string): KidRow {
    this.requireUser(uid);
    const k = this.db.kids?.[id];
    if (!k || !this.household(uid).includes(k.ownerId)) throw new ServerError("not_found");
    return k;
  }

  /** A kid as stored: name 1–30 trimmed, year of birth 1900…this year or null, note ≤ 200 trimmed. */
  private cleanKid(input: KidInput): Pick<KidRow, "name" | "bornYear" | "note"> {
    const name = String(input?.name ?? "").trim();
    const note = String(input?.note ?? "").trim();
    const born = input?.bornYear ?? null;
    if (name.length < 1 || name.length > KID_NAME_MAX || note.length > KID_NOTE_MAX) throw new ServerError("bad_input");
    if (born !== null && (!Number.isInteger(born) || born < KID_BORN_MIN || born > this.year())) throw new ServerError("bad_input");
    return { name, bornYear: born, note };
  }

  /** The caller's family's kids, each once (bad_input for anyone else's, an unknown one, or not a list). */
  private ownKidIds(uid: string, kidIds: unknown): string[] {
    if (!Array.isArray(kidIds)) throw new ServerError("bad_input");
    const ids = [...new Set(kidIds)];
    const people = this.household(uid);
    for (const id of ids) if (typeof id !== "string" || !people.includes(this.db.kids?.[id]?.ownerId ?? "")) throw new ServerError("bad_input");
    return ids as string[];
  }

  /** The kids attached to an appointment (a removed kid is gone from it). */
  private kidsIn(appointmentId: string): KidRow[] {
    return (this.db.appointmentKids?.[appointmentId] ?? []).map((id) => this.db.kids?.[id]).filter((k): k is KidRow => !!k);
  }

  /** Its photo, ratings and attachments go with a kid; providers still expecting it refetch. */
  private deleteKid(k: KidRow): void {
    this.kidChanged(k); // while the attachments still say who expects the kid
    if (k.photoPath) delete this.db.photos?.[k.photoPath];
    this.db.kidRatings = (this.db.kidRatings ?? []).filter((g) => g.kidId !== k.id);
    for (const [aid, ids] of Object.entries(this.db.appointmentKids ?? {})) if (ids.includes(k.id)) this.db.appointmentKids![aid] = ids.filter((x) => x !== k.id);
    // 2.5: an update about the kid keeps the name, not the row (appointment_updates.kid_id → null).
    for (const u of this.db.updates ?? []) if (u.kidId === k.id) u.kidId = null;
    delete this.db.kids![k.id];
  }

  /** The owner's family's tabs and the providers of upcoming appointments the kid is attached to refetch. */
  private kidChanged(k: KidRow): void {
    this.notifyHousehold(k.ownerId);
    for (const a of Object.values(this.db.appointments ?? {}))
      if (a.providerId && (a.status === "requested" || a.status === "accepted") && (this.db.appointmentKids?.[a.id] ?? []).includes(k.id)) this.effects.notify.add(a.providerId);
  }

  /** A kid's ratings, newest first. */
  private kidRatingsOf(kidId: string): KidRatingRow[] {
    return (this.db.kidRatings ?? []).filter((g) => g.kidId === kidId).sort((x, y) => y.createdAt - x.createdAt);
  }

  /** A kid's summary (FR-203): the mean of all its ratings to one decimal; null without any. */
  private kidSummary(ratings: KidRatingRow[]): RatingSummary {
    const count = ratings.length;
    return { mean: count ? round1(ratings.reduce((s, g) => s + g.stars, 0) / count) : null, count };
  }

  /** A kid as its owner's family sees it: every rating with who gave it, who added it. */
  private kidView(k: KidRow, viewer: string): Kid {
    const got = this.kidRatingsOf(k.id);
    return {
      ownerNickname: this.nick(k.ownerId) || "Deleted user",
      mine: k.ownerId === viewer,
      id: k.id,
      name: k.name,
      photo: this.signedUrl(k.photoPath),
      bornYear: k.bornYear,
      note: k.note,
      rating: this.kidSummary(got),
      ratings: got.map((g) => ({ appointmentId: g.appointmentId, by: this.nick(g.fromUser), stars: g.stars, comment: g.comment, at: g.createdAt }))
    };
  }

  /** The attached kids as a party of the appointment sees them (FR-202), with the viewer's own rating. */
  private attachedKids(a: ApptRow, viewer: string): AttachedKid[] {
    return this.kidsIn(a.id).map((k) => {
      const got = this.kidRatingsOf(k.id);
      return {
        id: k.id,
        name: k.name,
        photo: this.signedUrl(k.photoPath),
        age: k.bornYear === null ? null : this.year() - k.bornYear,
        note: k.note,
        rating: this.kidSummary(got),
        myRating: got.find((g) => g.appointmentId === a.id && g.fromUser === viewer)?.stars ?? null
      };
    });
  }

  /** This year (UTC, like extract(year from now()) on the server). */
  private year(): number {
    return new Date(this.now).getUTCFullYear();
  }

  // ---------- 2.3: photos (FR-210–212, V46) ----------

  /**
   * Stores a photo (a JPEG the app already resized) for my profile or one of my kids, keeping only
   * its object path in the row; null clears it; replacing deletes the old object. Returns the
   * signed URL — in the demo the stored data URL itself (Supabase signs the object for ≤ 1 h).
   */
  setPhoto(uid: string, target: { kind: "profile" } | { kind: "kid"; id: string }, dataUrl: string | null): string | null {
    const u = this.requireUser(uid);
    const kid = target?.kind === "kid" ? this.ownKid(uid, target.id) : null;
    const row: { photoPath?: string | null } | null = target?.kind === "profile" ? u : kid;
    if (!row) throw new ServerError("bad_input");
    if (dataUrl !== null && (typeof dataUrl !== "string" || dataUrl.length > PHOTO_MAX_CHARS || !PHOTO_RE.test(dataUrl))) throw new ServerError("bad_input");
    const photos = (this.db.photos ??= {});
    if (row.photoPath) delete photos[row.photoPath];
    row.photoPath = null;
    if (dataUrl !== null) {
      const path = `${target.kind === "profile" ? "profiles" : "kids"}/${this.nextId("ph")}.jpg`;
      photos[path] = dataUrl;
      row.photoPath = path;
    }
    // A kid's card changed: the providers expecting the kid refetch too (as siosia_set_photo does).
    if (kid) this.kidChanged(kid);
    else this.effects.notify.add(uid);
    return this.signedUrl(row.photoPath);
  }

  /** The demo's "signed URL" of an object path: the stored data URL; null without a photo. */
  private signedUrl(path: string | null | undefined): string | null {
    return (path && this.db.photos?.[path]) || null;
  }

  // ---------- 2.3: chat (FR-220–225, V47, V48) ----------

  /**
   * A room's thread as one of its parties sees it; `markRead` — the thread is open and visible —
   * sets readAt on the other's messages (FR-224) and stamps the reader's presence in the room, so
   * no notification reaches them for what they are looking at (FR-222; the app re-stamps every 20 s).
   */
  chat(uid: string, room: ChatRoom, markRead = false): ChatThread {
    this.requireUser(uid);
    this.sweep();
    const info = this.room(room, uid);
    const other = info.parties.find((p) => p !== uid)!;
    const msgs = this.messagesIn(room);
    if (markRead) {
      const pres = (this.db.chatPresence ??= {});
      pres[uid] = { ...(pres[uid] ?? {}), [room]: this.now };
      let changed = false;
      for (const m of msgs) {
        if (m.sender === uid || m.readAt !== null) continue;
        m.readAt = this.now;
        changed = true;
      }
      // The sender sees the read marks; the reader's other tabs drop the badge.
      if (changed) {
        this.effects.notify.add(other);
        this.effects.notify.add(uid);
      }
    }
    return {
      room,
      other: this.party(other, true),
      messages: msgs.map((m) => this.messageView(m, uid)),
      open: info.open,
      unread: msgs.filter((m) => m.sender !== uid && m.readAt === null).length
    };
  }

  /** Sends to the other party of a room I belong to (FR-223, FR-225): stored, delivered live, pushed once. */
  sendMessage(uid: string, room: ChatRoom, text: string): ChatMessage {
    this.requireUser(uid);
    this.sweep();
    const info = this.room(room, uid);
    if (!info.open) throw new ServerError("illegal_transition");
    const clean = trimWs(String(text ?? ""));
    if (clean.length < 1 || clean.length > CHAT_TEXT_MAX) throw new ServerError("bad_input");
    const all = (this.db.messages ??= []);
    if (all.filter((m) => m.room === room && m.sender === uid && m.sentAt > this.now - CHAT_RATE_MS).length >= CHAT_RATE_N) throw new ServerError("too_many");
    const m: MessageRow = { id: this.nextId("m"), room, sender: uid, text: clean, sentAt: this.now, readAt: null };
    all.push(m);
    for (const p of info.parties) {
      this.effects.notify.add(p);
      this.effects.chat.push({ userId: p, room, message: this.messageView(m, p) });
    }
    // No phone while driving (FR-222): a driver on a trip is not told; the message waits in the
    // thread. Someone looking at the thread right now sees it land live and is not told either.
    // The notification carries the whole text; push-text cuts it to the first words.
    const other = info.parties.find((p) => p !== uid)!;
    if (this.isMember(other) && !this.driving(other) && !this.inRoom(other, room))
      this.effects.push.push({
        userId: other,
        kind: "chat_message",
        rideId: info.rideId,
        appointmentId: info.appointmentId,
        params: { sender: this.nick(uid), text: clean, room, messageId: m.id }
      });
    return this.messageView(m, uid);
  }

  // ---------- 2.5: session updates and heading home (FR-230–242, V54–V56) ----------

  /** From 30 min before the start until 7 days after the end, on an accepted or done appointment (V54). */
  private feedOpen(a: ApptRow): boolean {
    return (a.status === "accepted" || a.status === "done") && this.now >= a.startsAt - FEED_BEFORE_MS && this.now <= (a.endedAt ?? this.endOf(a)) + FEED_AFTER_MS;
  }

  /** The appointment behind a feed, for one of its two parties or (2.6) their family — not_found for anyone else (an open request has no feed yet). */
  private feedAppt(uid: string, id: string): ApptRow {
    const a = this.db.appointments?.[id];
    if (!a || !a.providerId || !this.sees(uid, a)) throw new ServerError("not_found");
    return a;
  }

  private updateView(u: UpdateRow, viewer: string): SessionUpdate {
    return {
      id: u.id,
      appointmentId: u.appointmentId,
      author: this.party(u.author, true),
      mine: u.author === viewer,
      kid: u.kidName === null ? null : { id: u.kidId, name: u.kidName },
      text: u.text,
      photo: this.signedUrl(u.photoPath),
      createdAt: u.createdAt
    };
  }

  /** The feed as one of its parties sees it (FR-231); `seen` — it is in front — stamps my presence (V55). */
  updates(uid: string, appointmentId: string, seen = false): SessionFeed {
    this.requireUser(uid);
    this.sweep();
    const a = this.feedAppt(uid, appointmentId);
    if (seen) {
      const pres = (this.db.chatPresence ??= {});
      pres[uid] = { ...(pres[uid] ?? {}), [`feed:${a.id}`]: this.now };
    }
    return {
      appointmentId: a.id,
      open: this.feedOpen(a),
      items: (this.db.updates ?? [])
        .filter((u) => u.appointmentId === a.id)
        .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1))
        .map((u) => this.updateView(u, uid))
    };
  }

  /**
   * Posts an update (FR-230, FR-232): a text and/or a photo (a JPEG data URL here; Supabase takes the
   * uploaded object's path), about one attached kid or everyone. Stored; both parties refetch; one
   * notification to the other party unless they have the feed in front or are driving (V55).
   */
  postUpdate(uid: string, appointmentId: string, input: UpdateInput, photo: string | null = null): SessionUpdate {
    this.requireUser(uid);
    this.sweep();
    const a = this.feedAppt(uid, appointmentId);
    // 2.6 (FR-255): of a party's family only the client's posts (the parent's side).
    if (a.clientId !== uid && a.providerId !== uid && !this.sameFamily(uid, a.clientId)) throw new ServerError("forbidden");
    if (!this.feedOpen(a)) throw new ServerError("illegal_transition");
    const text = trimWs(String(input?.text ?? ""));
    if (text.length > CHAT_TEXT_MAX || (text === "" && photo === null)) throw new ServerError("bad_input");
    if (photo !== null && (typeof photo !== "string" || photo.length > PHOTO_MAX_CHARS || !PHOTO_RE.test(photo))) throw new ServerError("bad_input");
    const kidId = input?.kidId ?? null;
    let kidName: string | null = null;
    if (kidId !== null) {
      const k = this.kidsIn(a.id).find((x) => x.id === kidId);
      if (!k) throw new ServerError("bad_input");
      kidName = k.name;
    }
    const all = (this.db.updates ??= []);
    if (all.filter((u) => u.appointmentId === a.id && u.author === uid && u.createdAt > this.now - FEED_RATE_MS).length >= FEED_RATE_N) throw new ServerError("too_many");
    let photoPath: string | null = null;
    if (photo !== null) {
      photoPath = `updates/${this.nextId("ph")}.jpg`;
      (this.db.photos ??= {})[photoPath] = photo;
    }
    const u: UpdateRow = { id: this.nextId("u"), appointmentId: a.id, author: uid, kidId, kidName, text, photoPath, createdAt: this.now };
    all.push(u);
    this.notifyAppt(a);
    // 2.6 (V60): everyone on the parent's side and the provider, but the author.
    for (const other of new Set([a.clientId, ...this.kin(a.clientId), a.providerId!]))
      if (other !== uid && this.isMember(other) && !this.driving(other) && !this.inRoom(other, `feed:${a.id}`))
        this.pushAppt(other, "session_update", a, { sender: this.nick(uid), text, kid: kidName, photo: photoPath !== null, updateId: u.id });
    return this.updateView(u, uid);
  }

  /** Removes my own update, its photo too (FR-231), while the feed is open — the same window as posting (V54). */
  deleteUpdate(uid: string, id: string): void {
    this.requireUser(uid);
    const all = this.db.updates ?? [];
    const u = all.find((x) => x.id === id && x.author === uid);
    if (!u) throw new ServerError("not_found");
    const a = this.db.appointments?.[u.appointmentId];
    if (!a || !this.feedOpen(a)) throw new ServerError("illegal_transition");
    this.db.updates = all.filter((x) => x !== u);
    if (u.photoPath) delete this.db.photos?.[u.photoPath];
    this.notifyAppt(a);
  }

  /**
   * The client is heading home (FR-240–242): about `minutes` away (computed on the phone — no
   * position comes here, FR-043), while the session is live; repeating replaces the estimate. One
   * client_coming notification to the provider.
   */
  comingHome(uid: string, appointmentId: string, minutes: number): AppointmentView {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[appointmentId];
    if (!a || a.clientId !== uid) throw new ServerError("not_found");
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > COMING_MAX_MIN) throw new ServerError("bad_input");
    if ((a.status !== "accepted" && a.status !== "done") || !a.providerId || this.now < a.startsAt - FEED_BEFORE_MS || this.now > this.endOf(a) + COMING_AFTER_MS)
      throw new ServerError("illegal_transition");
    const prev = a.comingAt ?? null;
    a.comingAt = this.now;
    a.etaAt = this.now + minutes * 60_000;
    this.notifyAppt(a);
    // A notice repeated within a minute replaces the previous one on screen but rings no second time.
    if (prev === null || prev < this.now - COMING_PUSH_GAP_MS) this.pushAppt(a.providerId, "client_coming", a, { minutes, etaAt: a.etaAt });
    return this.apptView(a, uid);
  }

  /** Seen in the room within the presence window: the thread is open on their screen (FR-222). */
  private inRoom(uid: string, room: string): boolean {
    const seen = this.db.chatPresence?.[uid]?.[room];
    return seen !== undefined && this.now - seen < CHAT_PRESENCE_MS;
  }

  /** A room's two parties, whether sending is still allowed, and the ride / appointment for the tag; null = no such room. */
  private roomOf(room: string): RoomInfo | null {
    const parts = String(room ?? "").split(":");
    if (parts.length !== 2) return null;
    const [kind, id] = parts;
    if (kind === "ride") {
      // Opens with the driver (FR-220); a re-dispatched ride has none until the next one accepts,
      // and its old driver is no party any more (FR-223).
      const r = this.db.rides[id];
      if (!r || !r.driverId) return null;
      return { parties: [r.riderId, r.driverId], open: this.stillOpen(r.endedAt), rideId: r.id, appointmentId: null };
    }
    if (kind === "appt") {
      // Opens on acceptance: an answered one with a provider that was not declined (answeredAt
      // is set on accept and decline only; a withdrawn or expired request was never answered).
      const a = this.db.appointments?.[id];
      if (!a || !a.providerId || a.answeredAt === null || a.status === "declined" || a.status === "expired") return null;
      return { parties: [a.clientId, a.providerId], open: this.stillOpen(a.endedAt), rideId: null, appointmentId: a.id };
    }
    return null;
  }

  /** The room for one of its parties (not_found for anyone else, or when there is no such room). */
  private room(room: string, uid: string): RoomInfo {
    const info = this.roomOf(room);
    if (!info || !info.parties.includes(uid)) throw new ServerError("not_found");
    return info;
  }

  /** Live, or within 24 h after the end (FR-223). */
  private stillOpen(endedAt: number | null | undefined): boolean {
    return endedAt == null || this.now <= endedAt + CHAT_AFTER_END_MS;
  }

  /**
   * A ride gets a (new) driver: its thread starts afresh, so the words exchanged with a driver who
   * cancelled or gave the booking back reach nobody else (FR-223). Nothing to do on a first driver.
   */
  private resetRoom(r: RideRow): void {
    if (this.db.messages?.length) this.db.messages = this.db.messages.filter((m) => m.room !== `ride:${r.id}`);
  }

  /** The driver of a ride under way right now (FR-222). */
  private driving(uid: string): boolean {
    return Object.values(this.db.rides).some((r) => r.driverId === uid && r.status === "in_progress");
  }

  /** A room's messages, oldest first. */
  private messagesIn(room: string): MessageRow[] {
    return (this.db.messages ?? []).filter((m) => m.room === room).sort((x, y) => x.sentAt - y.sentAt);
  }

  private messageView(m: MessageRow, viewer: string): ChatMessage {
    return { id: m.id, room: m.room, mine: m.sender === viewer, text: m.text, sentAt: m.sentAt, readAt: m.readAt };
  }

  /** The other party's messages in a room the viewer has not read yet. */
  private unreadIn(room: string, viewer: string): number {
    return (this.db.messages ?? []).filter((m) => m.room === room && m.sender !== viewer && m.readAt === null).length;
  }

  /** 2.3: unread messages across every room I am a party to (the badge). */
  private unreadChats(uid: string): number {
    let n = 0;
    for (const r of Object.values(this.db.rides)) if (r.driverId && (r.riderId === uid || r.driverId === uid)) n += this.unreadIn(`ride:${r.id}`, uid);
    for (const a of Object.values(this.db.appointments ?? {})) if ((a.clientId === uid || a.providerId === uid) && this.roomOf(`appt:${a.id}`)) n += this.unreadIn(`appt:${a.id}`, uid);
    return n;
  }

  // ---------- 2.0: internals ----------

  private service(id: string): CatalogEntry | null {
    return this.cfg.services.find((e) => e.id === id) ?? null;
  }

  private serviceName(id: string, lang: Lang): string {
    const e = this.service(id);
    return e ? e.name[lang] || e.name.en : id;
  }

  /** What a person offers: a master profile's preset, otherwise their own toggles. */
  private offersOf(uid: string): string[] {
    const linked = this.linkedMaster(uid);
    if (linked) return this.masterDef(linked)?.offers ?? [];
    return this.db.users[uid]?.offers ?? [];
  }

  /** The random public id (made once, on first use). */
  private publicIdOf(uid: string): string | null {
    const u = this.db.users[uid];
    if (!u || u.deleted) return null;
    if (!u.publicId) u.publicId = randomPublicId();
    return u.publicId;
  }

  private publicParty(uid: string, showPhoto: boolean): PublicProvider {
    return { ...this.party(uid, showPhoto), publicId: this.publicIdOf(uid) };
  }

  /** 2.1: every member with a profile but `except` — who sees an open request (V34). */
  private members(except: string | null): string[] {
    return Object.values(this.db.users)
      .filter((u) => !u.deleted && u.id !== except && this.isMember(u.id))
      .map((u) => u.id);
  }

  /** 2.1: an open request changed: everyone's list and badge update (V36). */
  private notifyMembers(): void {
    for (const m of this.members(null)) this.effects.notify.add(m);
  }

  /** 2.1: an open request of someone else, still waiting, and the viewer has a profile. 2.6: not my family's. */
  private takeable(a: ApptRow, uid: string): boolean {
    const u = this.db.users[uid];
    return (
      a.providerId === null && a.status === "requested" && a.startsAt > this.now && a.clientId !== uid && !this.sameFamily(uid, a.clientId) && this.sameRealm(uid, a.clientId) && !!u && !u.deleted
    );
  }

  /** 2.1 (V34, FR-161): the open requests this user could take, soonest first, a series once (its first open date). */
  private openFor(uid: string): ApptRow[] {
    const seen = new Set<string>();
    return Object.values(this.db.appointments ?? {})
      .filter((a) => this.takeable(a, uid))
      .sort((x, y) => x.startsAt - y.startsAt)
      .filter((a) => {
        const key = a.seriesId ?? a.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  private occurrences(seriesId: string): ApptRow[] {
    return Object.values(this.db.appointments ?? {})
      .filter((a) => a.seriesId === seriesId)
      .sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
  }

  private endOf(a: { startsAt: number; durationMin: number }): number {
    return a.startsAt + a.durationMin * 60_000;
  }

  /** The provider is busy then: an accepted appointment or a booked ride taken as driver overlaps. */
  private providerBusy(uid: string, start: number, min: number, except: string): boolean {
    const end = start + min * 60_000;
    return (
      Object.values(this.db.appointments ?? {}).some((x) => x.providerId === uid && x.status === "accepted" && x.id !== except && x.startsAt < end && start < this.endOf(x)) ||
      Object.values(this.db.rides).some(
        (r) =>
          r.driverId === uid &&
          r.scheduledFor != null &&
          (r.status === "scheduled" || r.status === "accepted" || r.status === "arrived" || r.status === "in_progress") &&
          r.scheduledFor < end &&
          start < r.scheduledFor + Math.max(r.estMin, 1) * 60_000
      )
    );
  }

  /** Cancelled appointments cancel their rides not under way yet; drivers who took one are told. */
  private cascadeRides(ids: string[]): void {
    for (const r of Object.values(this.db.rides)) {
      if (!r.appointmentId || !ids.includes(r.appointmentId)) continue;
      if (!(r.status === "scheduled" || r.status === "requested" || r.status === "accepted" || r.status === "arrived")) continue;
      if (r.driverId) this.pushTo(r.driverId, "booking_cancelled", r, { pickup: r.pickup.label });
      this.endRide(r, "cancelled", "system", "appointment_cancelled");
    }
  }

  /** Bookings from a series' ride templates for occurrences within the booking horizon (V26). */
  private materialize(seriesId: string): void {
    const s = this.db.series?.[seriesId];
    if (!s) return;
    const { minLeadMin, maxDays } = this.cfg.booking;
    for (const t of Array.isArray(s.rideTemplates) ? s.rideTemplates : []) {
      // A bad template (or booking) must never stop the sweep, which runs inside every call.
      try {
        const user = t.passenger === "client" ? s.clientId : s.providerId;
        if (!user) continue;
        for (const a of this.occurrences(s.id).filter((x) => x.status === "accepted" && x.startsAt > this.now)) {
          const at = (t.leg === "there" ? a.startsAt : this.endOf(a)) + t.offsetMin * 60_000;
          if (at < this.now + minLeadMin * 60_000 || at > this.now + maxDays * 86_400_000) continue;
          if (Object.values(this.db.rides).some((r) => r.appointmentId === a.id && r.riderId === user && r.leg === t.leg)) continue;
          try {
            this.bookFor(user, { pickup: t.pickup, dropoff: t.dropoff, estKm: t.estKm, estMin: t.estMin, fareIsEstimate: t.fareIsEstimate, scheduledFor: at }, a.id, t.leg, true);
          } catch {
            /* no room (open bookings) or no longer allowed: the next run tries again */
          }
        }
      } catch {
        /* a malformed template: skipped */
      }
    }
    s.templatesAt = this.now;
  }

  /** Appointments of the sweep: expiry, done, reminders, template rides (V6, V7, V24, V26). */
  private sweepAppointments(): void {
    const all = this.db.appointments;
    if (!all) return;
    // An unanswered series expires as a whole when its first occurrence starts (one notification).
    for (const s of Object.values(this.db.series ?? {})) {
      if (s.status !== "requested" || s.firstStart > this.now) continue;
      const occ = this.occurrences(s.id);
      for (const a of occ)
        if (a.status === "requested") {
          a.status = "expired";
          a.endedAt = this.now;
          this.notifyAppt(a);
        }
      s.status = "expired";
      // 2.1 (V37): an open one is "Nobody took it" for the client, and leaves everyone's list.
      if (occ[0]) this.pushAppt(s.clientId, "appt_expired", occ[0], { ...this.seriesParams(s), ...(s.providerId === null ? { open: true } : {}) });
      if (s.providerId === null) this.notifyMembers();
    }
    for (const a of Object.values(all)) {
      if (a.status === "requested" && !a.seriesId && a.startsAt <= this.now) {
        a.status = "expired";
        a.endedAt = this.now;
        this.notifyAppt(a);
        this.pushAppt(a.clientId, "appt_expired", a, a.providerId === null ? { open: true } : {});
        if (a.providerId === null) this.notifyMembers();
      } else if (a.status === "accepted" && this.endOf(a) <= this.now) {
        a.status = "done";
        a.endedAt = this.endOf(a);
        this.notifyAppt(a);
        this.announceCost(a, false);
      }
    }
    // Reminders: once per slot for both parties; none for a moment that had passed at the request.
    // An open request has only its client (V37).
    for (const a of Object.values(all)) {
      if ((a.status !== "requested" && a.status !== "accepted") || a.startsAt <= this.now) continue;
      for (const slot of this.cfg.appointment.reminderMin) {
        const moment = a.startsAt - slot * 60_000;
        if (this.now < moment || a.requestedAt > moment || a.reminded.includes(slot)) continue;
        a.reminded.push(slot);
        this.pushAppt(a.clientId, "appt_reminder", a, this.reminderParams(a, slot, "client"));
        if (a.providerId) this.pushAppt(a.providerId, "appt_reminder", a, this.reminderParams(a, slot, "provider"));
      }
    }
    // Series rides: occurrences that came within the booking horizon (once a day per series). One
    // broken series is skipped (and still counts as this day's run), never the whole sweep.
    for (const s of Object.values(this.db.series ?? {}))
      if (s.status === "answered" && s.rideTemplates?.length && (s.templatesAt === null || s.templatesAt < this.now - 86_400_000)) {
        try {
          this.materialize(s.id);
        } catch {
          s.templatesAt = this.now;
        }
      }
  }

  private reminderParams(a: ApptRow, slot: number, role: PartyRole): Partial<PushParams> {
    return {
      lead: slot,
      role,
      other: this.nick(role === "client" ? a.providerId : a.clientId),
      status: a.status === "accepted" ? "confirmed" : a.providerId === null ? "open" : role === "client" ? "waiting" : "answer",
      rides: this.attached(a, null).map((x) => ({ leg: x.leg, status: x.status, driver: x.driver?.nickname ?? null }))
    };
  }

  private seriesParams(s: SeriesRow | null): Partial<PushParams> {
    return s ? { rule: s.rule, count: s.count, first: s.firstStart, last: s.until } : {};
  }

  /** An appointment notification in the recipient's language (service name included). */
  private pushAppt(userId: string | null, kind: PushKind, a: ApptRow, extra: Partial<PushParams>): void {
    // An open request has no provider to tell (2.1).
    if (!userId || !this.isMember(userId)) return;
    const lang = this.db.users[userId]?.language ?? "en";
    this.deliver({
      userId,
      kind,
      rideId: null,
      appointmentId: a.id,
      params: {
        serviceId: a.serviceId,
        service: this.serviceName(a.serviceId, lang),
        at: a.startsAt,
        end: this.endOf(a),
        client: this.nick(a.clientId),
        provider: this.nick(a.providerId),
        place: a.place?.label ?? "",
        // 2.3 (FR-202): the provider hears who comes ("with Zosia and Kuba"); the client knows their own kids.
        ...(userId === a.providerId && this.kidsIn(a.id).length ? { kids: this.kidsIn(a.id).map((k) => k.name) } : {}),
        ...extra
      }
    });
  }

  /** A nickname for a notification; "" for nobody (twin of siosia_nick). */
  private nick(uid: string | null): string {
    return (uid && this.db.users[uid]?.nickname) || "";
  }

  private notifyAppt(a: { clientId: string; providerId: string | null }): void {
    // 2.6 (FR-256): the families of both parties see it too.
    this.notifyHousehold(a.clientId);
    if (a.providerId) this.notifyHousehold(a.providerId);
  }

  /** A ride that is part of an appointment changed: both parties refetch; news reaches the other party (V12). */
  private attachedChanged(r: RideRow): void {
    if (!r.appointmentId) return;
    const a = this.db.appointments?.[r.appointmentId];
    if (!a) return;
    this.notifyAppt(a);
    const before = r.apptSummary ?? null;
    const now = rideSummary(r);
    r.apptSummary = now;
    if (!(before === "pending" || before === "confirmed") || now === before || !(now === "pending" || now === "confirmed" || now === "failed")) return;
    const kind: PushKind = now === "confirmed" ? "appt_ride_taken" : now === "pending" ? "appt_ride_lost" : "appt_ride_failed";
    const params = { leg: r.leg ?? undefined, time: r.scheduledFor ?? null, driver: r.driverId ? this.db.users[r.driverId]?.nickname ?? "" : "" };
    this.pushAppt(r.riderId === a.clientId ? a.providerId : a.clientId, kind, a, params);
    if (now === "failed") this.pushAppt(r.riderId, kind, a, params);
  }

  /** The rides of an appointment as the viewer may see them (FR-114): latest per passenger and leg. */
  private attached(a: ApptRow, viewer: string | null): AttachedRide[] {
    const latest = new Map<string, RideRow>();
    for (const r of Object.values(this.db.rides)) {
      if (r.appointmentId !== a.id || !r.leg || rideSummary(r) === null) continue;
      const key = `${r.riderId}:${r.leg}`;
      const cur = latest.get(key);
      if (!cur || cur.requestedAt <= r.requestedAt) latest.set(key, r);
    }
    return [...latest.values()]
      .sort((x, y) => (x.scheduledFor ?? 0) - (y.scheduledFor ?? 0))
      .map((r) => ({
        rideId: r.id,
        leg: r.leg!,
        passenger: r.riderId === a.clientId ? "client" : "provider",
        mine: r.riderId === viewer,
        scheduledFor: r.scheduledFor ?? null,
        status: rideSummary(r)!,
        driver: r.driverId ? { nickname: this.db.users[r.driverId]?.nickname ?? "Deleted user", icon: this.masterOf(r.driverId)?.icon ?? null } : null,
        ...(r.riderId === viewer ? { pickup: { ...r.pickup }, dropoff: { ...r.dropoff }, fare: r.fare, currency: r.currency } : {})
      }));
  }

  /**
   * AppointmentView for one of its parties, or (2.1, V34) for a candidate of an open request: what
   * the request says and who asks — no rides, reminders, ratings, templates or calendar links.
   */
  private apptView(a: ApptRow, viewer: string): AppointmentView {
    const e = this.service(a.serviceId);
    const s = a.seriesId ? this.db.series?.[a.seriesId] ?? null : null;
    const role: ViewerRole =
      a.clientId === viewer ? "client" : a.providerId === viewer ? "provider" : this.sees(viewer, a) ? "family" : "candidate";
    const candidate = role === "candidate";
    const family = role === "family";
    const kinSide: PartyRole = this.sameFamily(viewer, a.clientId) ? "client" : "provider";
    const occ = s ? this.occurrences(s.id) : [];
    return {
      id: a.id,
      status: a.status,
      role,
      open: a.providerId === null && a.status === "requested",
      serviceId: a.serviceId,
      service: e ? { name: { ...e.name }, icon: e.icon } : null,
      startsAt: a.startsAt,
      durationMin: a.durationMin,
      endsAt: this.endOf(a),
      place: a.place ? { ...a.place } : null,
      note: a.note,
      price: a.price,
      currency: a.currency,
      // The parties see each other's photo; a candidate is not a party yet (FR-212).
      client: this.publicParty(a.clientId, !candidate),
      provider: a.providerId ? this.publicParty(a.providerId, !candidate) : null,
      requestedAt: a.requestedAt,
      answeredAt: a.answeredAt,
      endedAt: a.endedAt,
      cancelledBy: a.cancelledBy,
      cancelReason: a.cancelReason,
      rides: candidate ? [] : this.attached(a, viewer),
      reminders: candidate ? [] : [...a.reminded],
      myRating: candidate || family ? null : this.db.ratings.find((x) => x.appointmentId === a.id && x.fromUser === viewer)?.stars ?? null,
      // 2.3 (FR-202): the kids' cards for the two parties; a candidate sees how many ("2 kids").
      kids: candidate ? [] : this.attachedKids(a, viewer),
      kidCount: this.kidsIn(a.id).length,
      unread: candidate || family || !this.roomOf(`appt:${a.id}`) ? 0 : this.unreadIn(`appt:${a.id}`, viewer),
      // 2.5 (FR-230–234, FR-241): the feed's size and state and the heading-home notice — parties only (V54).
      updateCount: candidate ? 0 : (this.db.updates ?? []).filter((u) => u.appointmentId === a.id).length,
      feedOpen: !candidate && this.feedOpen(a),
      coming:
        !candidate && a.comingAt != null && (a.status === "accepted" || a.status === "done") && this.now <= this.endOf(a) + COMING_AFTER_MS
          ? { at: a.comingAt, etaAt: a.etaAt ?? a.comingAt }
          : null,
      // 2.6 (FR-262, FR-270–272): where the price came from and, once done, what it cost.
      rate: a.rate ?? null,
      contractId: candidate ? null : a.contractId ?? null,
      actualMin: a.actualMin ?? null,
      cost: candidate ? null : this.costOf(a),
      // 2.9 (FR-314): the tip — the parties and their families see it.
      tip: !candidate && a.tip != null ? { amount: a.tip, by: this.nick(a.tipBy ?? null), at: a.tipAt ?? a.endedAt ?? a.startsAt } : null,
      family: family ? { side: kinSide, member: this.nick(kinSide === "client" ? a.clientId : a.providerId) } : null,
      series: s
        ? {
            id: s.id,
            rule: s.rule,
            seq: a.seq ?? 1,
            count: s.count,
            until: s.until,
            status: s.status,
            remaining: occ.filter((x) => (x.status === "requested" || x.status === "accepted") && x.startsAt > this.now).length,
            declined: occ.filter((x) => x.status === "declined").map((x) => x.startsAt).sort((x, y) => x - y),
            gaps: occ.filter((x) => x.status === "declined" || x.status === "cancelled").map((x) => x.startsAt).sort((x, y) => x - y),
            starts: occ.map((x) => x.startsAt),
            // 2.6: the family sees no templates (siosia_series_json: parties only).
            rideTemplates: candidate || family
              ? []
              : s.rideTemplates.map((t) =>
                  t.passenger === role ? { ...t, pickup: { ...t.pickup }, dropoff: { ...t.dropoff }, mine: true } : { passenger: t.passenger, leg: t.leg, offsetMin: t.offsetMin, mine: false }
                ),
            ics: null
          }
        : null,
      calendar: { google: null, ics: null }
    };
  }

  // ---------- 2.6: family (FR-250–256, V58–V60) ----------

  /** My family: its people, the invitations it sent that still wait, and those waiting for me. */
  family(uid: string): FamilyView {
    this.requireUser(uid);
    this.sweep();
    const fid = this.familyOf(uid);
    const invite = (i: FamilyInviteRow): FamilyInvite => ({
      id: i.id,
      from: this.publicParty(i.fromUser, true),
      to: this.publicParty(i.toUser, true),
      createdAt: i.createdAt,
      expiresAt: i.createdAt + INVITE_MS
    });
    const pending = (this.db.familyInvites ?? []).filter((i) => i.status === "pending").sort((x, y) => x.createdAt - y.createdAt);
    return {
      id: fid,
      members: fid
        ? this.familyPeople(fid).map((m) => ({ ...this.publicParty(m, true), me: m === uid, joinedAt: this.db.familyMembers![m].joinedAt }))
        : [],
      invites: fid ? pending.filter((i) => i.familyId === fid).map(invite) : [],
      incoming: pending.filter((i) => this.samePerson(i.toUser, uid)).map(invite)
    };
  }

  /** The members I could invite or contract with: everyone else with a profile, by nickname. */
  memberList(uid: string): PublicProvider[] {
    this.requireUser(uid);
    return this.members(uid)
      .filter((m) => this.sameRealm(uid, m) && this.listed(m, uid))
      .sort((a, b) => this.nick(a).localeCompare(this.nick(b)))
      .map((m) => this.publicParty(m, true));
  }

  /** Invites a member into my family (FR-250); without a family, one is made with me. */
  inviteToFamily(uid: string, publicId: string): FamilyView {
    this.requireUser(uid);
    this.sweep();
    const to = this.userByPublicId(publicId);
    if (!to || to === uid || !this.sameRealm(uid, to)) throw new ServerError("not_found");
    if (this.sameFamily(uid, to)) throw new ServerError("in_family");
    let fid = this.familyOf(uid);
    if (fid && this.familyPeople(fid).length >= FAMILY_MAX) throw new ServerError("family_full");
    const invites = (this.db.familyInvites ??= []);
    if (fid && invites.some((i) => i.familyId === fid && this.samePerson(i.toUser, to) && i.status === "pending")) return this.family(uid);
    fid ??= this.newFamily(uid);
    invites.push({ id: this.nextId("fi"), familyId: fid, fromUser: uid, toUser: to, status: "pending", createdAt: this.now, answeredAt: null });
    for (const p of this.personAccounts(to)) {
      this.pushPlain(p, "family_invite", { sender: this.nick(uid) });
      this.effects.notify.add(p);
    }
    this.notifyHousehold(uid);
    return this.family(uid);
  }

  /** Join or decline an invitation (FR-250, FR-251): a family of me alone merges into the new one. */
  answerInvite(uid: string, id: string, decision: "join" | "decline"): FamilyView {
    this.requireUser(uid);
    if (decision !== "join" && decision !== "decline") throw new ServerError("bad_input");
    this.sweep();
    const inv = (this.db.familyInvites ?? []).find((i) => i.id === id && this.samePerson(i.toUser, uid));
    if (!inv) throw new ServerError("not_found");
    if (inv.status !== "pending" || !this.db.families?.[inv.familyId]) throw new ServerError("illegal_transition");
    if (decision === "decline") {
      inv.status = "declined";
      inv.answeredAt = this.now;
      for (const m of this.familyPeople(inv.familyId)) this.effects.notify.add(m);
      this.effects.notify.add(uid);
      return this.family(uid);
    }
    const mine = this.familyOf(uid);
    if (mine === inv.familyId) throw new ServerError("in_family");
    if (mine && this.familyPeople(mine).length > 1) throw new ServerError("in_family");
    const people = this.familyPeople(inv.familyId);
    if (people.length >= FAMILY_MAX) throw new ServerError("family_full");
    if (mine) {
      // My family of one merges in (FR-251): its contracts come along unless the new family already
      // has one with that provider; a contract with someone of the new family ends (no contract within a family).
      for (const c of Object.values(this.db.contracts ?? {})) {
        if (c.familyId !== mine) continue;
        const clash =
          people.some((p) => this.samePerson(p, c.providerId)) ||
          Object.values(this.db.contracts ?? {}).some(
            (x) => x.familyId === inv.familyId && this.samePerson(x.providerId, c.providerId) && (x.status === "active" || x.status === "proposed")
          );
        if (clash && (c.status === "active" || c.status === "proposed")) this.closeContract(c, c.status === "active" ? "ended" : "withdrawn", null);
        c.familyId = inv.familyId;
      }
      for (const i of this.db.familyInvites ?? []) if (i.familyId === mine && i.status === "pending") i.status = "withdrawn";
      delete this.db.families![mine];
    }
    // I join: a contract the new family has with me as its provider ends.
    for (const c of Object.values(this.db.contracts ?? {}))
      if (c.familyId === inv.familyId && this.samePerson(c.providerId, uid) && (c.status === "active" || c.status === "proposed"))
        this.closeContract(c, c.status === "active" ? "ended" : "withdrawn", null);
    (this.db.familyMembers ??= {})[uid] = { familyId: inv.familyId, joinedAt: this.now };
    inv.status = "joined";
    inv.answeredAt = this.now;
    // Other invitations to me lapse: I am in a family now.
    for (const i of this.db.familyInvites ?? []) if (this.samePerson(i.toUser, uid) && i.status === "pending") i.status = "declined";
    for (const m of people) this.pushPlain(m, "family_joined", { sender: this.nick(uid) });
    this.notifyHousehold(uid);
    return this.family(uid);
  }

  /** The family takes back an invitation that still waits. */
  withdrawInvite(uid: string, id: string): FamilyView {
    this.requireUser(uid);
    const fid = this.familyOf(uid);
    const inv = (this.db.familyInvites ?? []).find((i) => i.id === id && i.familyId === fid && fid !== null);
    if (!inv) throw new ServerError("not_found");
    if (inv.status !== "pending") throw new ServerError("illegal_transition");
    inv.status = "withdrawn";
    inv.answeredAt = this.now;
    this.notifyHousehold(uid);
    this.effects.notify.add(inv.toUser);
    return this.family(uid);
  }

  /** I leave my family (FR-252); my kids leave with me; a family nobody is left in goes, its contracts end. */
  leaveFamily(uid: string): FamilyView {
    this.requireUser(uid);
    if (!this.familyOf(uid)) throw new ServerError("not_found");
    this.leave(uid);
    return this.family(uid);
  }

  /** 2.6: invitations to me and contract proposals my side should answer (S1 notice). */
  private familyPending(uid: string): number {
    const invites = (this.db.familyInvites ?? []).filter((i) => this.samePerson(i.toUser, uid) && i.status === "pending" && this.now < i.createdAt + INVITE_MS).length;
    const contracts = Object.values(this.db.contracts ?? {}).filter((c) => c.status === "proposed" && this.answers(uid, c)).length;
    return invites + contracts;
  }

  /** Lapsed invitations (7 days) expire; one row's trouble never stops the sweep (V30). */
  private sweepFamily(): void {
    for (const i of this.db.familyInvites ?? [])
      if (i.status === "pending" && this.now >= i.createdAt + INVITE_MS) {
        i.status = "expired";
        i.answeredAt = this.now;
        this.effects.notify.add(i.toUser);
      }
    try {
      this.sweepReports();
    } catch {
      // V65: the weekly notifications never break the sweep.
    }
  }

  private familyOf(uid: string | null): string | null {
    return (uid && this.db.familyMembers?.[uid]?.familyId) || null;
  }

  /** A family's people, first joined first. */
  private familyPeople(fid: string): string[] {
    return Object.entries(this.db.familyMembers ?? {})
      .filter(([, m]) => m.familyId === fid)
      .sort(([a, x], [b, y]) => x.joinedAt - y.joinedAt || (a < b ? -1 : 1))
      .map(([u]) => u);
  }

  /** Me and everyone in my family. */
  private household(uid: string): string[] {
    const fid = this.familyOf(uid);
    return fid ? this.familyPeople(fid) : [uid];
  }

  /** Everyone in my family but me. */
  private kin(uid: string): string[] {
    return this.household(uid).filter((m) => m !== uid);
  }

  private sameFamily(a: string | null, b: string | null): boolean {
    return !!a && !!b && a !== b && this.familyOf(a) !== null && this.familyOf(a) === this.familyOf(b);
  }

  private notifyHousehold(uid: string): void {
    for (const m of this.household(uid)) this.effects.notify.add(m);
  }

  /** A party of the appointment, or (FR-254) in the family of one; an open request's candidates are not. */
  private sees(uid: string, a: ApptRow): boolean {
    return a.clientId === uid || a.providerId === uid || this.sameFamily(uid, a.clientId) || this.sameFamily(uid, a.providerId);
  }

  private userByPublicId(publicId: string): string | null {
    const u = Object.values(this.db.users).find((x) => !x.deleted && typeof publicId === "string" && x.publicId === publicId);
    return u && this.isMember(u.id) ? u.id : null;
  }

  private newFamily(uid: string): string {
    const id = this.nextId("f");
    (this.db.families ??= {})[id] = { id, createdAt: this.now };
    (this.db.familyMembers ??= {})[uid] = { familyId: id, joinedAt: this.now };
    return id;
  }

  /** Takes me out of my family; an empty family goes, its open invitations and contracts with it. */
  private leave(uid: string): void {
    const fid = this.familyOf(uid);
    if (!fid) return;
    const before = this.familyPeople(fid);
    delete this.db.familyMembers![uid];
    for (const m of before) this.effects.notify.add(m);
    if (before.length > 1) return;
    for (const i of this.db.familyInvites ?? [])
      if (i.familyId === fid && i.status === "pending") {
        i.status = "withdrawn";
        this.effects.notify.add(i.toUser);
      }
    for (const c of Object.values(this.db.contracts ?? {}))
      if (c.familyId === fid && (c.status === "active" || c.status === "proposed")) {
        const was = c.status;
        this.closeContract(c, was === "active" ? "ended" : "withdrawn", uid);
        if (was === "active") for (const p of this.personAccounts(c.providerId)) this.pushPlain(p, "contract_ended", { sender: this.nick(uid) });
      }
    delete this.db.families?.[fid];
  }

  /** A deleted (or replaced) profile: out of its family, its contracts as a provider end, its invitations go. */
  private dropFromFamilies(uid: string): void {
    // 2.9 (V72): another phone of the same master profile takes over what was addressed to this one.
    const sibling = this.personAccounts(uid).find((p) => p !== uid) ?? null;
    for (const i of this.db.familyInvites ?? [])
      if (i.status === "pending" && i.toUser === uid && sibling) i.toUser = sibling;
      else if (i.status === "pending" && (i.toUser === uid || i.fromUser === uid)) {
        i.status = i.toUser === uid ? "declined" : "withdrawn";
        i.answeredAt = this.now;
        this.effects.notify.add(i.toUser);
      }
    for (const c of Object.values(this.db.contracts ?? {}))
      if (c.providerId === uid && sibling) c.providerId = sibling;
      else if (c.providerId === uid && (c.status === "active" || c.status === "proposed")) {
        const was = c.status;
        this.closeContract(c, was === "active" ? "ended" : "withdrawn", uid);
        if (was === "active") for (const m of this.familyPeople(c.familyId)) this.pushPlain(m, "contract_ended", { sender: this.nick(uid) });
      }
    this.leave(uid);
  }

  /** A notification about the family or a contract (no ride, no appointment; opens the Family panel). */
  private pushPlain(userId: string | null, kind: PushKind, params: Partial<PushParams>): void {
    if (!userId || !this.isMember(userId)) return;
    this.deliver({ userId, kind, rideId: null, appointmentId: null, params: params as PushParams });
  }

  // ---------- 2.6: contracts (FR-260–264, V61, V62) ----------

  /** My family's contracts and mine as a provider: waiting, active, then the last 10 others. */
  contracts(uid: string): ContractView[] {
    this.requireUser(uid);
    const fid = this.familyOf(uid);
    const mine = Object.values(this.db.contracts ?? {}).filter((c) => this.samePerson(c.providerId, uid) || (fid !== null && c.familyId === fid));
    const live = mine.filter((c) => c.status === "proposed" || c.status === "active").sort((x, y) => (x.status === y.status ? y.createdAt - x.createdAt : x.status === "proposed" ? -1 : 1));
    const past = mine
      .filter((c) => c.status !== "proposed" && c.status !== "active")
      .sort((x, y) => (y.endedAt ?? y.answeredAt ?? y.createdAt) - (x.endedAt ?? x.answeredAt ?? x.createdAt) || y.version - x.version)
      .slice(0, 10);
    return [...live, ...past].map((c) => this.contractView(c, uid));
  }

  /** Proposes rates to the other side (FR-260, FR-261); a newer proposal replaces a waiting one. */
  proposeContract(uid: string, input: ContractInput): ContractView {
    this.requireUser(uid);
    this.sweep();
    if (!input || (input.as !== "family" && input.as !== "provider")) throw new ServerError("bad_input");
    const other = this.userByPublicId(input.to);
    if (!other || other === uid || !this.sameRealm(uid, other)) throw new ServerError("not_found");
    if (this.sameFamily(uid, other)) throw new ServerError("forbidden");
    const providerId = input.as === "family" ? other : uid;
    const client = input.as === "family" ? uid : other;
    const note = trimWs(String(input.note ?? ""));
    if (note.length > NOTE_MAX) throw new ServerError("bad_input");
    const rates = this.cleanRates(input.rates);
    const fid = this.familyOf(client) ?? this.newFamily(client);
    const all = (this.db.contracts ??= {});
    for (const c of Object.values(all)) if (c.familyId === fid && this.samePerson(c.providerId, providerId) && c.status === "proposed") this.closeContract(c, "withdrawn", uid);
    const version = Math.max(0, ...Object.values(all).filter((c) => c.familyId === fid && this.samePerson(c.providerId, providerId)).map((c) => c.version)) + 1;
    const c: ContractRow = {
      id: this.nextId("c"),
      familyId: fid,
      providerId,
      version,
      status: "proposed",
      rates,
      note,
      currency: this.cfg.tariff.currency,
      proposedBy: uid,
      proposedSide: input.as,
      createdAt: this.now,
      answeredAt: null,
      endedAt: null,
      endedBy: null
    };
    all[c.id] = c;
    for (const m of this.otherSide(c)) this.pushPlain(m, "contract_proposed", { sender: this.nick(uid) });
    this.notifyContract(c);
    return this.contractView(c, uid);
  }

  /** The other side accepts (binding; an active one is replaced) or declines (FR-261). */
  answerContract(uid: string, id: string, decision: "accept" | "decline"): ContractView {
    this.requireUser(uid);
    if (decision !== "accept" && decision !== "decline") throw new ServerError("bad_input");
    const c = this.contractFor(uid, id);
    if (c.status !== "proposed") throw new ServerError("illegal_transition");
    if (!this.answers(uid, c)) throw new ServerError("forbidden");
    if (decision === "accept") {
      for (const x of Object.values(this.db.contracts ?? {}))
        if (x !== c && x.familyId === c.familyId && this.samePerson(x.providerId, c.providerId) && x.status === "active") this.closeContract(x, "replaced", uid);
      c.status = "active";
    } else c.status = "declined";
    c.answeredAt = this.now;
    for (const m of this.proposingSide(c)) this.pushPlain(m, decision === "accept" ? "contract_accepted" : "contract_declined", { sender: this.nick(uid) });
    this.notifyContract(c);
    return this.contractView(c, uid);
  }

  /** The proposing side takes back a proposal that still waits. */
  withdrawContract(uid: string, id: string): void {
    this.requireUser(uid);
    const c = this.contractFor(uid, id);
    if (c.status !== "proposed") throw new ServerError("illegal_transition");
    if (this.answers(uid, c)) throw new ServerError("forbidden");
    this.closeContract(c, "withdrawn", uid);
    this.notifyContract(c);
  }

  /** Either side ends an active contract (FR-263); appointments keep their frozen prices. */
  endContract(uid: string, id: string): void {
    this.requireUser(uid);
    const c = this.contractFor(uid, id);
    if (c.status !== "active") throw new ServerError("illegal_transition");
    this.closeContract(c, "ended", uid);
    const others = this.samePerson(c.providerId, uid) ? this.familyPeople(c.familyId) : this.personAccounts(c.providerId);
    for (const m of others) this.pushPlain(m, "contract_ended", { sender: this.nick(uid) });
    this.notifyContract(c);
  }

  /**
   * 2.10 (FR-319, V76): an active contract also prices the done appointments since `from` (today or
   * up to a year back) between its family and its provider, for the services it has a rate for (or
   * their base). Either side may; the other side hears how many changed.
   */
  applyContractToPast(uid: string, id: string, from: string): { count: number } {
    this.requireUser(uid);
    this.sweep();
    const c = this.contractFor(uid, id);
    if (c.status !== "active") throw new ServerError("illegal_transition");
    const tz = this.cfg.timezone;
    const today = localDate(this.now, tz);
    if (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from) || localDate(localMidnight(from, tz) + 12 * 3600_000, tz) !== from) throw new ServerError("bad_input");
    if (from > today || from < addDays(today, -365)) throw new ServerError("bad_input");
    const start = localMidnight(from, tz);
    let count = 0;
    for (const a of Object.values(this.db.appointments ?? {})) {
      if (a.status !== "done" || a.startsAt < start || a.startsAt >= this.now) continue;
      if (this.familyOf(a.clientId) !== c.familyId || !this.samePerson(a.providerId, c.providerId)) continue;
      const base = this.service(a.serviceId)?.base ?? null;
      const line = c.rates.find((r) => r.serviceId === a.serviceId) ?? (base ? c.rates.find((r) => r.serviceId === base) : undefined);
      if (!line) continue;
      if (a.rate !== line.perHour || a.contractId !== c.id) count++;
      a.rate = line.perHour;
      a.contractId = c.id;
      a.price = round2((line.perHour * a.durationMin) / 60);
      this.notifyAppt(a);
    }
    if (count > 0)
      for (const m of this.samePerson(c.providerId, uid) ? this.familyPeople(c.familyId) : this.personAccounts(c.providerId))
        this.pushPlain(m, "contract_applied", { sender: this.nick(uid), count, since: from });
    this.notifyContract(c);
    return { count };
  }

  /** A contract one of whose sides I am on (not_found otherwise). */
  private contractFor(uid: string, id: string): ContractRow {
    const c = this.db.contracts?.[id];
    if (!c || (!this.samePerson(c.providerId, uid) && c.familyId !== this.familyOf(uid))) throw new ServerError("not_found");
    return c;
  }

  /** I am on the side that answers this proposal. */
  private answers(uid: string, c: ContractRow): boolean {
    return c.proposedSide === "family" ? this.samePerson(c.providerId, uid) : c.familyId === this.familyOf(uid) && !this.samePerson(c.providerId, uid);
  }

  private proposingSide(c: ContractRow): string[] {
    return c.proposedSide === "family" ? this.familyPeople(c.familyId) : this.personAccounts(c.providerId);
  }

  private otherSide(c: ContractRow): string[] {
    return c.proposedSide === "family" ? this.personAccounts(c.providerId) : this.familyPeople(c.familyId);
  }

  private closeContract(c: ContractRow, status: ContractStatus, by: string | null): void {
    c.status = status;
    c.endedAt = this.now;
    c.endedBy = by;
  }

  private notifyContract(c: ContractRow): void {
    for (const p of this.personAccounts(c.providerId)) this.effects.notify.add(p);
    for (const m of this.familyPeople(c.familyId)) this.effects.notify.add(m);
  }

  /** 1–12 lines, each a different enabled time entry (2.8: offered or not), 0–10 000 per hour to the cent (V61, V68). */
  private cleanRates(rates: unknown): ContractRate[] {
    if (!Array.isArray(rates) || rates.length < 1 || rates.length > CONTRACT_LINES_MAX) throw new ServerError("bad_input");
    const seen = new Set<string>();
    return rates.map((r) => {
      const id = (r as ContractRate)?.serviceId;
      const perHour = (r as ContractRate)?.perHour;
      if (typeof id !== "string" || seen.has(id) || typeof perHour !== "number" || !Number.isFinite(perHour) || perHour < 0 || perHour > RATE_MAX || round2(perHour) !== perHour)
        throw new ServerError("bad_input");
      seen.add(id);
      // 2.8 (V68): any enabled service — a contract is how a person who lists nothing takes one on.
      const e = this.service(id);
      if (!e || e.kind !== "time" || !e.enabled) throw new ServerError("not_offered");
      return { serviceId: id, perHour };
    });
  }

  private contractView(c: ContractRow, viewer: string): ContractView {
    const side = this.samePerson(c.providerId, viewer) ? "provider" : "family";
    return {
      id: c.id,
      version: c.version,
      status: c.status,
      side,
      provider: this.publicParty(c.providerId, true),
      family: this.familyPeople(c.familyId).map((m) => this.nick(m)),
      to: side === "family" ? this.publicIdOf(c.providerId) : this.publicIdOf(this.familyPeople(c.familyId)[0] ?? ""),
      rates: c.rates.map((r) => ({ ...r })),
      note: c.note,
      currency: c.currency,
      proposedByMe: c.proposedSide === side,
      canAnswer: c.status === "proposed" && this.answers(viewer, c),
      createdAt: c.createdAt,
      answeredAt: c.answeredAt,
      endedAt: c.endedAt
    };
  }

  /**
   * The active contract line between the client's family and the provider for a service — 2.8
   * (FR-305): else the line of its base (a YOLO event takes the Childcare rate) — if any.
   */
  private contractRate(client: string, provider: string | null, serviceId: string): { contractId: string; perHour: number } | null {
    const fid = this.familyOf(client);
    if (!fid || !provider) return null;
    const c = Object.values(this.db.contracts ?? {}).find((x) => x.familyId === fid && this.samePerson(x.providerId, provider) && x.status === "active");
    const base = this.service(serviceId)?.base ?? null;
    const line = c?.rates.find((r) => r.serviceId === serviceId) ?? (base ? c?.rates.find((r) => r.serviceId === base) : undefined);
    return c && line ? { contractId: c.id, perHour: line.perHour } : null;
  }

  /** 2.8 (V70): a person offers an entry when they offer it or the entry it takes after (twin of siosia_offers_service). */
  private offersService(uid: string, e: CatalogEntry): boolean {
    const offers = this.offersOf(uid);
    return offers.includes(e.id) || (!!e.base && offers.includes(e.base));
  }

  /** The price a request freezes (V62): a contract's rate, else the price list's per hour or fixed price. */
  private priceFor(e: CatalogEntry, client: string, provider: string | null, minutes: number): { rate: number | null; price: number | null; contractId: string | null } {
    const c = this.contractRate(client, provider, e.id);
    if (c) return { rate: c.perHour, price: round2((c.perHour * minutes) / 60), contractId: c.contractId };
    if (e.price && "perHour" in e.price) return { rate: e.price.perHour, price: round2((e.price.perHour * minutes) / 60), contractId: null };
    return { rate: null, price: e.price && "fixed" in e.price ? e.price.fixed : null, contractId: null };
  }

  // ---------- 2.6: cost summary (FR-270–273, V63) ----------

  /** What a done appointment cost: rate × the time counted, or its fixed price; null before it is done. */
  private costOf(a: ApptRow): CostSummary | null {
    if (a.status !== "done") return null;
    const minutes = a.actualMin ?? a.durationMin;
    const rate = a.rate ?? null;
    const total = rate !== null ? round2((rate * minutes) / 60) : a.price;
    return {
      minutes,
      rate,
      total,
      currency: a.currency,
      source: a.contractId ? "contract" : rate !== null ? "catalog" : a.price !== null ? "fixed" : "none",
      corrected: a.actualMin != null
    };
  }

  /** The summary notification (FR-271): once when done, again on a correction (client side only). */
  private announceCost(a: ApptRow, corrected: boolean): void {
    const cost = this.costOf(a);
    if (!cost || cost.total === null || (!corrected && a.summarySent)) return;
    a.summarySent = true;
    const to = corrected ? [a.clientId, ...this.kin(a.clientId)] : [a.clientId, ...this.kin(a.clientId), a.providerId];
    for (const m of new Set(to)) this.pushAppt(m, "appt_summary", a, { minutes: cost.minutes, total: cost.total, currency: cost.currency, corrected });
  }

  /** The provider corrects the time within 24 h after the end (FR-272); the booked time clears it. */
  /**
   * 2.9 (FR-314, V74): the client — or someone in the client's family — thanks the provider with a
   * tip after a done appointment: once, within 7 days of its end.
   */
  tipAppointment(uid: string, id: string, amount: number): AppointmentView {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || !(a.clientId === uid || this.sameFamily(uid, a.clientId)) || a.providerId === uid) throw new ServerError("not_found");
    if (a.status !== "done" || !a.providerId) throw new ServerError("illegal_transition");
    if (this.now > (a.endedAt ?? this.endOf(a)) + TIP_APPT_MS) throw new ServerError("window_closed");
    const v = tipAmount(amount, TIP_APPT_MAX);
    if (a.tip != null) throw new ServerError("already_tipped");
    a.tip = v;
    a.tipBy = uid;
    a.tipAt = this.now;
    this.pushAppt(a.providerId, "appt_tip", a, { sender: this.nick(uid), total: v, currency: a.currency });
    this.notifyAppt(a);
    return this.apptView(a, uid);
  }

  setActualTime(uid: string, id: string, minutes: number): AppointmentView {
    this.requireUser(uid);
    this.sweep();
    const a = this.db.appointments?.[id];
    if (!a || !this.sees(uid, a)) throw new ServerError("not_found");
    if (a.providerId !== uid) throw new ServerError("forbidden");
    if (a.status !== "done") throw new ServerError("illegal_transition");
    if (this.now > (a.endedAt ?? this.endOf(a)) + SERVER.apptRatingWindowS * 1000) throw new ServerError("window_closed");
    if (!Number.isInteger(minutes) || minutes < ACTUAL_MIN || minutes > ACTUAL_MAX || minutes % 15 !== 0) throw new ServerError("bad_input");
    a.actualMin = minutes === a.durationMin ? null : minutes;
    this.notifyAppt(a);
    this.announceCost(a, true);
    return this.apptView(a, uid);
  }

  // ---------- 2.6: weekly reports (FR-280–284, V64, V65) ----------

  /** One week's spent and earned (`week` = any day of it, null = this week); "family" sums my family. */
  report(uid: string, week: string | null, scope: "me" | "family"): WeeklyReport {
    this.requireUser(uid);
    this.sweep();
    const tz = this.cfg.timezone;
    const current = weekOf(this.now, tz);
    if (week !== null && (typeof week !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(week) || Number.isNaN(Date.parse(week)))) throw new ServerError("bad_input");
    const monday = week === null ? current : weekOf(localMidnight(week, tz) + 12 * 3600_000, tz);
    if (monday > current || monday < addDays(current, -7 * REPORT_WEEKS)) throw new ServerError("bad_input");
    if (scope !== "me" && scope !== "family") throw new ServerError("bad_input");
    const hasFamily = this.kin(uid).length > 0;
    const people = scope === "family" && hasFamily ? this.household(uid) : [uid];
    const r = this.weekReport(people, monday);
    return {
      ...r,
      scope: scope === "family" && hasFamily ? "family" : "me",
      hasFamily,
      members: scope === "family" && hasFamily ? people.map((m) => {
        const one = this.weekReport([m], monday);
        return { nickname: this.nick(m), spent: one.spent.total, earned: one.earned.total };
      }) : null,
      due: this.dueLines(uid),
      settlements: this.settlementViews(uid)
    };
  }

  private weekReport(people: string[], monday: string): Omit<WeeklyReport, "scope" | "hasFamily" | "members" | "due" | "settlements"> {
    const tz = this.cfg.timezone;
    const start = localMidnight(monday, tz);
    const end = localMidnight(addDays(monday, 7), tz);
    const inWeek = (t: number | null) => t !== null && t >= start && t < end;
    const who = new Set(people);
    const appts = Object.values(this.db.appointments ?? {}).filter((a) => a.status === "done" && inWeek(a.startsAt));
    const rides = Object.values(this.db.rides).filter((r) => r.status === "completed" && inWeek(r.endedAt));
    const side = (mine: (a: ApptRow) => boolean, other: (a: ApptRow) => string | null, rideMine: (r: RideRow) => boolean): ReportSide => {
      const lines = new Map<string, ReportLine>();
      for (const a of appts.filter(mine)) {
        const name = this.nick(other(a)) || "Deleted user";
        const key = `${name}\u0000${a.serviceId}`;
        const l = lines.get(key) ?? { who: name, serviceId: a.serviceId, count: 0, minutes: 0, total: 0, due: 0 };
        const cost = this.costOf(a)!;
        l.count++;
        l.minutes += cost.minutes;
        l.total = round2(l.total + (cost.total ?? 0));
        // 2.11 (FR-321): what of it is still to pay
        if (this.apptOwing(a)) l.due = round2(l.due + Math.max(0, Math.min(this.apptDue(a), cost.total ?? 0)));
        lines.set(key, l);
      }
      const services = [...lines.values()].sort((x, y) => y.total - x.total || x.who.localeCompare(y.who) || (x.serviceId < y.serviceId ? -1 : 1));
      const servicesTotal = round2(services.reduce((s, l) => s + l.total, 0));
      const rs = rides.filter(rideMine);
      const ridesTotal = round2(rs.reduce((s, r) => s + r.fare, 0));
      // 2.9 (FR-316): tips count in the week of their appointment or ride.
      const tips = round2(appts.filter(mine).reduce((s, a) => s + (a.tip ?? 0), 0) + rs.reduce((s, r) => s + (r.tip ?? 0), 0));
      const ridesDue = round2(rs.filter((r) => this.rideOwing(r)).reduce((s, r) => s + Math.max(0, Math.min(this.rideDue(r), r.fare)), 0));
      return { total: round2(servicesTotal + ridesTotal + tips), services, servicesTotal, rides: { count: rs.length, total: ridesTotal, due: ridesDue }, tips };
    };
    const spent = side((a) => who.has(a.clientId), (a) => a.providerId, (r) => who.has(r.riderId));
    const earned = side((a) => !!a.providerId && who.has(a.providerId), (a) => a.clientId, (r) => !!r.driverId && who.has(r.driverId));
    return { week: monday, weekStart: start, weekEnd: end, currency: this.cfg.tariff.currency, spent, earned, net: round2(earned.total - spent.total) };
  }

  // ---------- 2.11: settling up (FR-321–325, V78–V80) ----------

  /**
   * 2.11 (V78): the family of a person — this phone's, else the one another phone of the same master
   * profile is in (joined first), so one person's phones are always one side.
   */
  private partyFamily(uid: string): string | null {
    const own = this.familyOf(uid);
    if (own) return own;
    const fm = this.db.familyMembers ?? {};
    const best = this.personAccounts(uid)
      .filter((p) => fm[p])
      .sort((a, b) => fm[a].joinedAt - fm[b].joinedAt || (a < b ? -1 : 1))[0];
    return best ? fm[best].familyId : null;
  }

  /** 2.11 (V78): who pays and gets paid — a family, else one person (every phone of a master profile). */
  private partyOf(uid: string): string {
    const fid = this.partyFamily(uid);
    return fid ? `f:${fid}` : `p:${this.linkedMaster(uid) ?? uid}`;
  }

  /** Everyone on someone's side: their family's people with all their phones, else all their phones. */
  private partyPeople(uid: string): string[] {
    const fid = this.partyFamily(uid);
    return fid ? [...new Set(this.familyPeople(fid).flatMap((m) => this.personAccounts(m)))] : this.personAccounts(uid);
  }

  /** A side's names: a family's members, else the person's nickname. */
  private partyName(uid: string): string {
    const fid = this.partyFamily(uid);
    const names = (fid ? this.familyPeople(fid) : [uid]).map((m) => this.nick(m)).filter(Boolean);
    return [...new Set(names)].join(", ") || "Deleted user";
  }

  /** What may still be due starts with the oldest week a report shows (V78). */
  private dueFrom(): number {
    const tz = this.cfg.timezone;
    return localMidnight(addDays(weekOf(this.now, tz), -7 * REPORT_WEEKS), tz);
  }

  /** Both people still here, in one realm (V66), on different sides. */
  private apart(a: string | null, b: string | null): boolean {
    const live = (u: string | null): u is string => !!u && !!this.db.users[u] && !this.db.users[u].deleted;
    return live(a) && live(b) && this.sameRealm(a, b) && this.partyOf(a) !== this.partyOf(b);
  }

  /** A done appointment's cost and tip. */
  private apptAmount(a: ApptRow): number {
    return round2((this.costOf(a)?.total ?? 0) + (a.tip ?? 0));
  }

  /** What of it is still to pay: all of it, or what changed since a dobry Pancio (a later tip, a
   *  corrected time, a contract applied — below 0 when it went down). */
  private apptDue(a: ApptRow): number {
    return round2(this.apptAmount(a) - (a.settledAmount ?? 0));
  }

  private rideAmount(r: RideRow): number {
    return round2(r.fare + (r.tip ?? 0));
  }

  private rideDue(r: RideRow): number {
    return round2(this.rideAmount(r) - (r.settledAmount ?? 0));
  }

  /** A done appointment still to pay (V78): something left to pay, between two sides. */
  private apptOwing(a: ApptRow): boolean {
    return a.status === "done" && a.startsAt >= this.dueFrom() && this.apptDue(a) !== 0 && this.apart(a.clientId, a.providerId);
  }

  /** A completed ride still to pay (V78): fare and tip, nobody marked it paid or collected, something left. */
  private rideOwing(r: RideRow): boolean {
    return (
      r.status === "completed" && r.endedAt !== null && r.endedAt >= this.dueFrom() && !r.paid && !r.collected && this.rideDue(r) !== 0 &&
      this.apart(r.riderId, r.driverId)
    );
  }

  /** Everything still to pay between my side and another (`them`, a side key; null: every other side). */
  private owingWith(uid: string, them: string | null): Owing[] {
    const me = this.partyOf(uid);
    const out: Owing[] = [];
    const add = (debtor: string, creditor: string, item: Owing["item"], rides: boolean, amount: number, at: number) => {
      const d = this.partyOf(debtor);
      const c = this.partyOf(creditor);
      if (d !== me && c !== me) return;
      const side = d === me ? c : d;
      if (them === null || side === them) out.push({ other: d === me ? creditor : debtor, side, theyOwe: c === me, rides, amount, at, item });
    };
    for (const a of Object.values(this.db.appointments ?? {}))
      if (this.apptOwing(a)) add(a.clientId, a.providerId!, a, false, this.apptDue(a), a.startsAt);
    for (const r of Object.values(this.db.rides))
      if (this.rideOwing(r)) add(r.riderId, r.driverId!, r, true, this.rideDue(r), r.endedAt!);
    return out;
  }

  /** 2.11 (FR-321): one line per other side — who, both ways, the net, since when, my last reminder. */
  private dueLines(uid: string): DueLine[] {
    const me = this.partyOf(uid);
    const groups = new Map<string, Owing[]>();
    for (const it of this.owingWith(uid, null)) groups.set(it.side, [...(groups.get(it.side) ?? []), it]);
    const lines: DueLine[] = [];
    for (const [side, items] of groups) {
      // The newest one's other person stands for that side — someone a reminder and dobry Pancio
      // reach (a member in my realm): else another of that side; none, no line.
      const newest = items.reduce((x, y) => (y.at > x.at ? y : x));
      const reach = (u: string) => this.isMember(u) && this.sameRealm(uid, u) && !this.db.users[u]?.deleted;
      const byAge = [...items].sort((x, y) => y.at - x.at);
      const rep = byAge.find((i) => reach(i.other))?.other ?? this.partyPeople(newest.other).filter(reach).sort()[0];
      if (!rep) continue;
      const sum = (they: boolean, rides: boolean) => round2(items.filter((i) => i.theyOwe === they && i.rides === rides).reduce((s, i) => s + i.amount, 0));
      const theyOwe = { services: sum(true, false), rides: sum(true, true) };
      const weOwe = { services: sum(false, false), rides: sum(false, true) };
      const reminded = (this.db.settlements ?? []).filter((s) => s.kind === "remind" && s.fromParty === me && s.toParty === side).map((s) => s.createdAt);
      lines.push({
        party: this.publicIdOf(rep) ?? "",
        who: this.partyName(rep),
        theyOwe,
        weOwe,
        net: round2(theyOwe.services + theyOwe.rides - weOwe.services - weOwe.rides),
        count: items.length,
        since: Math.min(...items.map((i) => i.at)),
        remindedAt: reminded.length ? Math.max(...reminded) : null
      });
    }
    return lines.sort((x, y) => x.since - y.since || (x.party < y.party ? -1 : 1));
  }

  /** The other side, from a public id there: a member of my realm on another side (not_found / forbidden). */
  private otherParty(uid: string, party: string): string {
    const other = this.userByPublicId(party);
    if (!other || !this.sameRealm(uid, other)) throw new ServerError("not_found");
    if (this.partyOf(other) === this.partyOf(uid)) throw new ServerError("forbidden");
    return other;
  }

  private newSettlement(kind: SettlementRow["kind"], uid: string, other: string, amount: number, itemCount: number): SettlementRow {
    const s: SettlementRow = {
      id: this.nextId("s"),
      kind,
      byUser: uid,
      withUser: other,
      fromParty: this.partyOf(uid),
      toParty: this.partyOf(other),
      amount,
      itemCount,
      createdAt: this.now,
      comment: null,
      commentBy: null,
      commentAt: null
    };
    (this.db.settlements ??= []).push(s);
    return s;
  }

  /** 2.11 (FR-322, V79): ask the other side to pay what they owe us, net — once per 12 hours. */
  remindPayment(uid: string, party: string): { net: number } {
    this.requireUser(uid);
    this.sweep();
    const other = this.otherParty(uid, party);
    const me = this.partyOf(uid);
    const them = this.partyOf(other);
    const items = this.owingWith(uid, them);
    const net = round2(items.reduce((s, i) => s + (i.theyOwe ? i.amount : -i.amount), 0));
    if (net <= 0) throw new ServerError("illegal_transition");
    if ((this.db.settlements ?? []).some((s) => s.kind === "remind" && s.fromParty === me && s.toParty === them && this.now < s.createdAt + REMIND_MS))
      throw new ServerError("rate_limited");
    this.newSettlement("remind", uid, other, net, items.length);
    const since = localDate(Math.min(...items.map((i) => i.at)), this.cfg.timezone);
    for (const m of this.partyPeople(other)) this.pushPlain(m, "pay_remind", { sender: this.nick(uid), total: net, currency: this.cfg.tariff.currency, since });
    for (const m of this.partyPeople(uid)) this.effects.notify.add(m);
    return { net };
  }

  /**
   * 2.11 (FR-323, V79): dobry Pancio — everything still to pay between my side and theirs, both ways,
   * is paid now, so the balance is zero. Either side may press it; the other side hears it.
   */
  settleUp(uid: string, party: string): { count: number; net: number } {
    this.requireUser(uid);
    this.sweep();
    const other = this.otherParty(uid, party);
    const items = this.owingWith(uid, this.partyOf(other));
    if (!items.length) throw new ServerError("illegal_transition");
    const net = round2(items.reduce((s, i) => s + (i.theyOwe ? i.amount : -i.amount), 0));
    const s = this.newSettlement("settle", uid, other, net, items.length);
    for (const { item } of items) {
      item.settledAt = this.now;
      item.settlementId = s.id;
      if ("riderId" in item) {
        item.settledAmount = this.rideAmount(item);
        this.notifyRide(item);
      } else {
        item.settledAmount = this.apptAmount(item);
        this.notifyAppt(item);
      }
    }
    const status = net > 0 ? "received" : net < 0 ? "paid" : "even";
    for (const m of this.partyPeople(other))
      this.pushPlain(m, "pay_settled", { sender: this.nick(uid), total: Math.abs(net), currency: this.cfg.tariff.currency, count: items.length, status });
    for (const m of this.partyPeople(uid)) this.effects.notify.add(m);
    return { count: items.length, net };
  }

  /** 2.11 (FR-324, V80): the side that got a dobry Pancio answers it — once, 1–280 characters, 30 days. */
  commentSettlement(uid: string, id: string, text: string): SettlementView {
    this.requireUser(uid);
    this.sweep();
    const s = (this.db.settlements ?? []).find((x) => x.id === id && x.kind === "settle" && x.toParty === this.partyOf(uid));
    if (!s) throw new ServerError("not_found");
    if (s.comment !== null) throw new ServerError("illegal_transition");
    if (this.now >= s.createdAt + COMMENT_MS) throw new ServerError("window_closed");
    const clean = trimWs(String(text ?? ""));
    if (!clean || clean.length > COMMENT_MAX) throw new ServerError("bad_input");
    s.comment = clean;
    s.commentBy = uid;
    s.commentAt = this.now;
    // The side that pressed it, as it was then (not where its presser is now).
    for (const u of Object.values(this.db.users))
      if (!u.deleted && this.partyOf(u.id) === s.fromParty) this.pushPlain(u.id, "pay_comment", { sender: this.nick(uid), text: clean });
    for (const m of this.partyPeople(uid)) this.effects.notify.add(m);
    return this.settlementView(s, uid);
  }

  private settlementView(s: SettlementRow, uid: string): SettlementView {
    const mine = s.fromParty === this.partyOf(uid);
    const signed = mine ? s.amount : -s.amount;
    return {
      id: s.id,
      at: s.createdAt,
      by: this.nick(s.byUser) || "Deleted user",
      mine,
      who: this.partyName(mine ? s.withUser : s.byUser),
      direction: signed > 0 ? "in" : signed < 0 ? "out" : "even",
      amount: Math.abs(s.amount),
      count: s.itemCount,
      comment: s.comment !== null ? { text: s.comment, by: this.nick(s.commentBy) || "Deleted user", at: s.commentAt ?? s.createdAt } : null,
      canComment: !mine && s.comment === null && this.now < s.createdAt + COMMENT_MS
    };
  }

  /** My side's dobry Pancios of the last 90 days, newest first. */
  private settlementViews(uid: string): SettlementView[] {
    const me = this.partyOf(uid);
    return (this.db.settlements ?? [])
      .filter((s) => s.kind === "settle" && (s.fromParty === me || s.toParty === me) && s.createdAt >= this.now - SETTLE_LIST_MS)
      .sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? 1 : -1))
      .slice(0, SETTLE_LIST)
      .map((s) => this.settlementView(s, uid));
  }

  /** Monday from 08:00: last week's report to everyone who had anything in it, once (V65). */
  private sweepReports(): void {
    const tz = this.cfg.timezone;
    const monday = weekOf(this.now, tz);
    // A new database starts its reports next Monday, none for the weeks before (as the migration does).
    if (this.db.reportWeek == null) {
      this.db.reportWeek = monday;
      return;
    }
    if (this.db.reportWeek === monday || this.now < localMidnight(monday, tz) + REPORT_HOUR * 3600_000) return;
    this.db.reportWeek = monday;
    const last = addDays(monday, -7);
    for (const m of this.members(null)) {
      try {
        const r = this.weekReport([m], last);
        if (!r.spent.services.length && !r.spent.rides.count && !r.earned.services.length && !r.earned.rides.count) continue;
        this.pushPlain(m, "weekly_report", { spent: r.spent.total, earned: r.earned.total, currency: r.currency, week: last });
      } catch {
        // one person's report never stops the others' (V30)
      }
    }
  }

  // ---------- internals ----------

  private activeRideOf(uid: string): RideRow | null {
    return Object.values(this.db.rides).find((r) => isActive(r.status) && (r.riderId === uid || r.driverId === uid)) ?? null;
  }

  /** Any driver action proves the session is alive (not only heartbeats). */
  private touchDriver(uid: string): void {
    const d = this.db.drivers[uid];
    if (d?.online) d.lastSeen = this.now;
  }

  private activeDriverRideOf(uid: string): RideRow | null {
    return Object.values(this.db.rides).find((r) => r.driverId === uid && (r.status === "accepted" || r.status === "arrived" || r.status === "in_progress")) ?? null;
  }

  /** Explicitly offline (not the silent-app sweep): standby ends too. */
  private goOffline(uid: string): void {
    const d = this.db.drivers[uid];
    if (d) {
      d.online = false;
      d.standbyUntil = null;
    }
    for (const o of Object.values(this.db.offers))
      if (o.driverId === uid && (o.status === "offered" || o.status === "queued")) this.closeOffer(o, "withdrawn");
  }

  private pullOffers(uid: string, pos: LatLng): void {
    const open = Object.values(this.db.rides)
      .filter((r) => r.status === "requested" && r.riderId !== uid && !r.excluded.includes(uid) && this.sameRealm(uid, r.riderId))
      .sort((a, b) => a.requestedAt - b.requestedAt);
    for (const r of open) {
      // A card withdrawn for driver-side reasons (went offline, went silent, won another ride) is
      // offered again once the driver is eligible (§6 rule 4). A card the driver let lapse comes back
      // after the retry window (requests stay open long); a Decline holds until clearDecisions.
      const existing = Object.values(this.db.offers).find((o) => o.rideId === r.id && o.driverId === uid && o.round === r.round);
      if (existing && !this.reofferable(existing)) continue;
      const dist = haversineKm(pos, r.pickup);
      if (dist > this.cfg.dispatchRadiusKm) continue;
      const holding = Object.values(this.db.offers).some((o) => o.driverId === uid && o.status === "offered");
      if (existing) {
        existing.status = holding ? "queued" : "offered";
        existing.createdAt = this.now;
        existing.offeredAt = holding ? null : this.now;
        existing.decidedAt = null;
        existing.driverDistanceKm = round1(dist);
        this.effects.notify.add(uid);
        continue;
      }
      const o: OfferRow = {
        id: this.nextId("o"),
        rideId: r.id,
        driverId: uid,
        round: r.round,
        status: holding ? "queued" : "offered",
        createdAt: this.now,
        offeredAt: holding ? null : this.now,
        decidedAt: null,
        driverDistanceKm: round1(dist)
      };
      this.db.offers[o.id] = o;
      r.notifiedCount++;
      this.effects.notify.add(uid);
      this.effects.notify.add(r.riderId);
    }
  }

  /** Declined / lapsed cards on still-open requests become offerable again (same round). */
  private clearDecisions(uid: string): void {
    for (const o of Object.values(this.db.offers)) {
      if (o.driverId !== uid || (o.status !== "declined" && o.status !== "timed_out")) continue;
      const r = this.db.rides[o.rideId];
      if (r && r.status === "requested" && r.round === o.round) {
        o.status = "withdrawn";
        o.decidedAt = this.now;
      }
    }
  }

  /** Open requests this driver could be offered, within the dispatch radius of `pos`. */
  private countNearby(uid: string, pos: LatLng): number {
    return Object.values(this.db.rides).filter(
      (r) => r.status === "requested" && r.riderId !== uid && !r.excluded.includes(uid) && this.sameRealm(uid, r.riderId) && haversineKm(pos, r.pickup) <= this.cfg.dispatchRadiusKm
    ).length;
  }

  private reofferable(o: OfferRow): boolean {
    if (o.status === "withdrawn") return true;
    const retryS = this.cfg.timers.retryS;
    return o.status === "timed_out" && retryS > 0 && o.decidedAt !== null && this.now >= o.decidedAt + retryS * 1000;
  }

  /** Close an offer and, if the driver now holds no card, promote their oldest queued one. */
  private closeOffer(o: OfferRow, status: OfferStatus): void {
    const wasOffered = o.status === "offered";
    o.status = status;
    o.decidedAt = this.now;
    this.effects.notify.add(o.driverId);
    if (wasOffered) this.promote(o.driverId);
  }

  private requestedAtOf(o: OfferRow): number {
    return this.db.rides[o.rideId]?.requestedAt ?? 0;
  }

  private promote(driverId: string): void {
    if (Object.values(this.db.offers).some((o) => o.driverId === driverId && o.status === "offered")) return;
    const queued = Object.values(this.db.offers)
      .filter((o) => o.driverId === driverId && o.status === "queued")
      // Cards (re)activated in one call share createdAt; SQL orders them by request time then.
      .sort((a, b) => a.createdAt - b.createdAt || this.requestedAtOf(a) - this.requestedAtOf(b));
    for (const q of queued) {
      const r = this.db.rides[q.rideId];
      if (r && r.status === "requested" && r.round === q.round) {
        q.status = "offered";
        q.offeredAt = this.now;
        this.effects.notify.add(driverId);
        return;
      }
      q.status = "withdrawn";
      q.decidedAt = this.now;
    }
  }

  private withdrawRideOffers(rideId: string): void {
    for (const o of Object.values(this.db.offers))
      if (o.rideId === rideId && (o.status === "offered" || o.status === "queued")) this.closeOffer(o, "withdrawn");
  }

  private endRide(r: RideRow, status: "cancelled" | "expired", by: CancelledBy, reason: string | null): void {
    r.status = status;
    r.endedAt = this.now;
    r.cancelledBy = by;
    r.cancelReason = reason;
    this.withdrawRideOffers(r.id);
    this.notifyRide(r);
  }

  /** accepted/arrived → requested without this driver; expiry restarts; fare unchanged (FR-051). */
  private redispatch(r: RideRow, reason: string): void {
    const driverId = r.driverId;
    this.effects.notify.add(r.riderId);
    if (driverId) {
      this.effects.notify.add(driverId);
      if (!r.excluded.includes(driverId)) r.excluded.push(driverId);
    }
    r.status = "requested";
    r.driverId = null;
    r.acceptedAt = null;
    r.departedAt = null; // the next driver sets off afresh
    r.arrivedAt = null;
    r.round++;
    r.redispatchCount++;
    r.dispatchStartedAt = this.now;
    r.notifiedCount = 0;
    r.cancelReason = reason;
    this.effects.pingDrivers = true;
    this.pushStandby(r);
    this.attachedChanged(r);
  }

  private notifyRide(r: RideRow): void {
    this.effects.notify.add(r.riderId);
    if (r.driverId) this.effects.notify.add(r.driverId);
    this.attachedChanged(r);
  }

  private pendingReceipt(uid: string): RideView | null {
    const rated = new Set(this.db.ratings.filter((x) => x.fromUser === uid).map((x) => x.rideId));
    const r = Object.values(this.db.rides)
      .filter(
        (x) =>
          x.status === "completed" &&
          (x.riderId === uid || x.driverId === uid) &&
          x.endedAt !== null &&
          this.now - x.endedAt < SERVER.pendingReceiptS * 1000 &&
          !rated.has(x.id)
      )
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
    return r ? this.rideView(r, uid) : null;
  }

  private rating(uid: string): RatingSummary {
    const stars = this.db.ratings
      .filter((x) => x.toUser === uid)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((x) => x.stars);
    return summarizeRatings(stars);
  }

  /**
   * A person as others see them (siosia_party): 2.1 adds the paint of their car (null when none);
   * 2.3 their photo, but only for a viewer allowed to see them — the other party of their ride or
   * appointment, a catalog viewer, a chat partner (FR-212). Null otherwise, as without a photo.
   */
  private party(uid: string, showPhoto: boolean): PublicParty {
    const u = this.db.users[uid];
    return {
      nickname: u ? u.nickname : "Deleted user",
      rating: this.rating(uid),
      icon: this.masterOf(uid)?.icon ?? null,
      paint: this.db.vehicles[uid]?.paint ?? null,
      photo: showPhoto && u && !u.deleted ? this.signedUrl(u.photoPath) : null
    };
  }

  /** FR-044: the vehicle/plate is visible to the rider only once a driver is assigned. */
  private rideView(r: RideRow, viewer: string): RideView {
    const role = r.riderId === viewer ? "rider" : "driver";
    const mine = this.db.ratings.find((x) => x.rideId === r.id && x.fromUser === viewer);
    // Photos for the two parties only — a driver browsing open bookings is not one yet (FR-212).
    const isParty = r.riderId === viewer || r.driverId === viewer;
    return {
      id: r.id,
      status: r.status,
      role,
      pickup: { ...r.pickup },
      dropoff: { ...r.dropoff },
      estKm: r.estKm,
      estMin: r.estMin,
      fare: r.fare,
      currency: r.currency,
      fareIsEstimate: r.fareIsEstimate,
      actualKm: r.actualKm,
      actualMin: r.actualMin,
      requestedAt: r.requestedAt,
      dispatchStartedAt: r.dispatchStartedAt,
      acceptedAt: r.acceptedAt,
      departedAt: r.departedAt ?? null,
      arrivedAt: r.arrivedAt,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      cancelledBy: r.cancelledBy,
      cancelReason: r.cancelReason,
      paid: r.paid,
      collected: r.collected,
      notifiedCount: r.notifiedCount,
      redispatchCount: r.redispatchCount,
      round: r.round,
      expiresAt: this.expiresAt(r),
      scheduledFor: r.scheduledFor ?? null,
      rider: this.party(r.riderId, isParty),
      driver: r.driverId ? { ...this.party(r.driverId, isParty), vehicle: this.vehicleOf(r.driverId) } : null,
      // 2.3: the room opens with a driver (FR-220); nothing for anyone but the two parties.
      unread: r.driverId && isParty ? this.unreadIn(`ride:${r.id}`, viewer) : 0,
      myRating: mine ? mine.stars : null,
      // 2.9 (FR-315): the tip, for the two parties.
      tip: isParty ? r.tip ?? null : null,
      // The appointment and leg are the rider's business only (FR-114).
      appointmentId: role === "rider" ? r.appointmentId ?? null : null,
      leg: role === "rider" ? r.leg ?? null : null,
      calendar: { google: null, ics: null }
    };
  }

  private offerView(o: OfferRow): OfferView {
    const r = this.db.rides[o.rideId];
    return {
      id: o.id,
      rideId: o.rideId,
      status: o.status,
      offeredAt: o.offeredAt ?? o.createdAt,
      driverDistanceKm: o.driverDistanceKm,
      pickup: { ...r.pickup },
      dropoff: { ...r.dropoff },
      estKm: r.estKm,
      estMin: r.estMin,
      fare: r.fare,
      currency: r.currency,
      fareIsEstimate: r.fareIsEstimate,
      // The offer card shows who asks, not their photo: the driver is no party yet (FR-212).
      rider: this.party(r.riderId, false)
    };
  }

  private nextId(prefix: string): string {
    this.db.seq++;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}${this.db.seq.toString(36)}${rand}`;
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;
/** A template's estimates as stored (twin of round(…, 3) in siosia_set_ride_template). */
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The longest ride estimate accepted, in minutes (twin of the 1440 in siosia_book_for). */
const MAX_EST_MIN = 1440;

/** How an attached ride stands for its appointment (§7 rule 7); null = not shown (twin of siosia_ride_summary). */
export function rideSummary(r: Pick<RideRow, "status" | "driverId" | "cancelledBy" | "cancelReason">): AttachedStatus | null {
  if (r.status === "cancelled" && (r.cancelledBy === "rider" || r.cancelReason === "appointment_cancelled")) return null;
  if ((r.status === "scheduled" && !r.driverId) || r.status === "requested") return "pending";
  if (r.status === "scheduled" || r.status === "accepted" || r.status === "arrived" || r.status === "in_progress") return "confirmed";
  if (r.status === "completed") return "done";
  return "failed";
}

const ratingKey = (g: RatingRow) => (g.rideId ? `r:${g.rideId}` : `a:${g.appointmentId}`);

/** 2.8: an invite link's token — 24 URL-safe random characters (twin of siosia_create_member_invite). */
function randomToken(): string {
  return randomPublicId() + randomPublicId();
}

/** 12 URL-safe random characters (twin of the SQL default for profiles.public_id). */
function randomPublicId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 12; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => alphabet[b & 63]).join("");
}

/**
 * A place as stored: just {lat, lng, label}, the label trimmed and cut to 120 (twin of
 * siosia_clean_place and the rides' labels). Any non-blank label is valid; a geocoded one can be long.
 */
function cleanPlace(p: Place): Place {
  return { lat: p.lat, lng: p.lng, label: String(p.label ?? "").trim().slice(0, 120) };
}

const samePlace = (a: Place, b: Place) => a.lat === b.lat && a.lng === b.lng && a.label === b.label;

/** Two stored templates are the same (twin of the jsonb equality in siosia_set_ride_template). */
function sameTemplate(a: StoredTemplate, b: StoredTemplate): boolean {
  return (
    a.passenger === b.passenger &&
    a.leg === b.leg &&
    samePlace(a.pickup, b.pickup) &&
    samePlace(a.dropoff, b.dropoff) &&
    a.offsetMin === b.offsetMin &&
    a.estKm === b.estKm &&
    a.estMin === b.estMin &&
    a.fareIsEstimate === b.fareIsEstimate
  );
}
