// AppStore: boot sequence (config → backend → reachability → deployment → session → sign-in (2.12)
// → invite → nickname), the
// user's live server state (MyState) kept fresh by realtime events plus a polling backstop, the
// server clock offset (countdowns use server time — §12 clock skew) and UI navigation state.
//
// Navigation (2.0, FR-080–084): a screen stack rooted at S1 Home. Siosia (catalog), Planned and
// History open from S1; Ride (R1…) and Drive (D1…) from the catalog. The screen follows an active
// ride or an online driver (V1); nothing else is remembered between launches. The browser history
// mirrors it: [S1] or [S1, screen], plus one entry per open panel (a panel opened from inside
// another — the chat from C3 — is a second one, so ← returns to C3) — so ← (a step back) always
// lands on the app's own S1, never outside the app.

import { createContext, useContext, useSyncExternalStore } from "react";
import { createBackend } from "../backend";
import type { Backend, PushMessage } from "../backend/types";
import { pushText, pushUrl } from "../../supabase/functions/_shared/push-text";
import { dropPushSubscription, showLocal } from "../services/push";
import { clearGoogleStart, markGoogleStart, takeAuthReturn, type GoogleError } from "../services/authReturn";
import { loadConfig, type AppConfig } from "../config";
import { CADENCE } from "../core/defaults";
import type { ChatRoom, DeploymentConfig, Lang, Mode, MyState, NotificationItem, Profile, Vehicle, WhoAmI } from "../core/types";
import { ServerError } from "../core/types";
import { browserLang } from "../i18n";
import { setGeocodeUrl } from "../services/geocode";
import { setRoutingUrl } from "../services/routing";
import { deviceId, readPref, unsupportedFeatures, writePref } from "../services/device";
import { applyTheme, readThemePref, saveThemePref, type ThemePref } from "../services/theme";

export type Phase = "loading" | "unsupported" | "unavailable" | "signin" | "invite" | "nickname" | "ready";
/** 2.12: why the sign-in screen shows (said on it), null = a first sign-in. */
export type SignInNotice = "sign_in_required" | "account_merged" | "session_lost" | "google_failed";
/** Outcome of opening a master-profile link, shown once. */
export type LinkNotice =
  | "joined"
  // 2.8: came in by someone's invite link
  | "invited"
  | "moved"
  | "moved_away"
  | "bad_link"
  | "bad_transfer"
  | "rate_limited"
  | "active_trip"
  | "active_ride"
  | "link_failed"
  // 2.12: this phone's old account joined the signed-in one; Google did not finish (signed in already)
  | "merged"
  | "google_failed";
/** 2.3: "chat" shows one room's thread (panelArg = the room). */
/** 2.6: "family" = Family & contracts; "report" = the weekly report (panelArg = its Monday, or null). */
export type Panel = "profile" | "history" | "vehicle" | "bookings" | "request" | "appointment" | "chat" | "family" | "report" | "yolo" | null;
/** A chat room as a link or a notification names it: ride:<id> | appt:<id>, nothing else (FR-220). */
export const chatRoomOf = (s: string | null | undefined): ChatRoom | null => (s && /^(ride|appt):[\w-]+$/.test(s) ? (s as ChatRoom) : null);
/** 2.5: an appointment id as a link or a notification names it (./?appointment=<id>), nothing else. */
export const appointmentIdOf = (s: string | null | undefined): string | null => (s && /^[\w-]+$/.test(s) ? s : null);
/** 2.6: a report's week from a link ("YYYY-MM-DD"), else null (this week). */
export const reportWeekOf = (s: string | null | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
/** S1 Home, C1 Catalog ("Siosia"), P1 Planned, H1 History, the v1 rider (R) and driver (D) screens. */
export type Screen = "home" | "catalog" | "planned" | "history" | "ride" | "drive";
const modeOf = (s: Screen): Mode | null => (s === "ride" ? "ride" : s === "drive" ? "drive" : null);
/**
 * What this app keeps in a history entry: the screen, and the panel open over it with its argument
 * and how many panel entries sit on the screen's (1 = the first panel, 2 = a panel over a panel).
 */
type NavState = { screen?: Screen; panel?: Panel; arg?: string | null; depth?: number } | null;
/** A signed photo URL lives an hour (FR-212): a profile older than this is fetched again (C16). */
export const PROFILE_MAX_AGE_MS = 50 * 60_000;

export interface AppSnapshot {
  phase: Phase;
  cfg: AppConfig | null;
  deployment: DeploymentConfig | null;
  uid: string | null;
  profile: Profile | null;
  vehicle: Vehicle | null;
  lang: Lang;
  /** Appearance (2.4, V50): this phone's choice. */
  theme: ThemePref;
  screen: Screen;
  /** The v1 mode of the screen (ride / drive), null elsewhere. */
  mode: Mode | null;
  panel: Panel;
  /** What the panel shows: the catalog entry of C2, the appointment of C3. */
  panelArg: string | null;
  /** A driver who is online tried to leave D1 for this screen: ask before going offline. */
  leaveDrive: Screen | null;
  my: MyState | null;
  /**
   * Counts refreshes of my state (a change event, the app back in front, after an action) — not an
   * online driver's heartbeat every 4 s. Lists fetched from the server reload on it (useListsKey).
   */
  changes: number;
  /** serverNow − Date.now(), ms. */
  clockOffset: number;
  online: boolean;
  missing: string[];
  bootError: string | null;
  linkNotice: LinkNotice | null;
  /** A master link waiting for the user to confirm replacing their profile on this phone. */
  masterConfirm: string | null;
  /** A move code waiting for the user to confirm merging it into the profile already here. */
  moveConfirm: string | null;
  /** A notification shown inside the app while it is in front (demo backend); a tap opens `url`. */
  pushToast: { title: string; body: string; url: string | null } | null;
  /** 2.12 (V81): who this session is (anonymous, member, merged away), from siosia_whoami at boot. */
  who: WhoAmI | null;
  signInNotice: SignInNotice | null;
  /** What the notice names: the account this phone was merged into, Google's reason. */
  signInDetail: string | null;
  /**
   * 2.12 (FR-327): this phone's old account was not joined to the signed-in one — reason = the
   * error (Try again while the code lives), null = it was parked for another sign-in (skipped).
   */
  absorbIssue: { publicId: string | null; reason: string | null; retry: boolean } | null;
}

const INITIAL: AppSnapshot = {
  phase: "loading",
  cfg: null,
  deployment: null,
  uid: null,
  profile: null,
  vehicle: null,
  lang: readPref<Lang | null>("lang", null) ?? browserLang(),
  theme: readThemePref(),
  screen: "home",
  mode: null,
  panel: null,
  panelArg: null,
  leaveDrive: null,
  my: null,
  changes: 0,
  clockOffset: 0,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  missing: [],
  bootError: null,
  linkNotice: null,
  masterConfirm: null,
  moveConfirm: null,
  pushToast: null,
  who: null,
  signInNotice: null,
  signInDetail: null,
  absorbIssue: null
};

const MASTER_KEY = "siosia.masterToken";

/**
 * A master-profile link (…/#master=<token>) is read once and removed from the address bar (so it
 * is not bookmarked or shared by accident); the token waits in this tab until it has been used.
 */
function takeMasterToken(): string | null {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fromUrl = params.get("master")?.trim() ?? null;
  if (params.has("master")) {
    params.delete("master");
    const rest = params.toString();
    history.replaceState(history.state, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
  }
  try {
    if (fromUrl) sessionStorage.setItem(MASTER_KEY, fromUrl);
    return sessionStorage.getItem(MASTER_KEY) || null;
  } catch {
    return fromUrl || null;
  }
}

const JOIN_KEY = "siosia.joinToken";

/** 2.8 (FR-302): an invite link (…/#join=<token>), read once and kept in this tab until used, like a master link. */
function takeJoinToken(): string | null {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fromUrl = params.get("join")?.trim() ?? null;
  if (params.has("join")) {
    params.delete("join");
    const rest = params.toString();
    history.replaceState(history.state, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
  }
  try {
    if (fromUrl) sessionStorage.setItem(JOIN_KEY, fromUrl);
    return sessionStorage.getItem(JOIN_KEY) || null;
  } catch {
    return fromUrl || null;
  }
}

function clearJoinToken(): void {
  try {
    sessionStorage.removeItem(JOIN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** 2.8: the token of an invite link pasted on the invite screen. */
export const joinTokenOf = (input: string): string | null => /(?:^|[#&?])join=([A-Za-z0-9_-]{16,64})/.exec(input.trim())?.[1] ?? null;

function clearMasterToken(): void {
  try {
    sessionStorage.removeItem(MASTER_KEY);
  } catch {
    /* storage unavailable */
  }
}

// ---------- 2.12: signing in and taking this phone's old account along ----------

export { captureAuthReturn } from "../services/authReturn";

/**
 * This phone's anonymous account, parked before signing in (a transfer code, its 30 minutes): the
 * signed-in account takes it in after the reload — only when the sign-in is the one it was parked
 * for (the email typed, or Google in the same page load), so a shared phone never hands one
 * person's account to another (FR-327).
 */
interface ParkedAbsorb {
  code: string;
  exp: number;
  oldPublicId: string | null;
  /** The email typed (lower case); null = Google. */
  forEmail: string | null;
  /** The sign-in was checked to be the one it was parked for (a retry needs no new check). */
  bound: boolean;
}
const ABSORB_KEY = "siosia.absorb";

export function readAbsorb(): ParkedAbsorb | null {
  try {
    const raw = localStorage.getItem(ABSORB_KEY);
    return raw ? (JSON.parse(raw) as ParkedAbsorb) : null;
  } catch {
    return null;
  }
}

function writeAbsorb(p: ParkedAbsorb): void {
  try {
    localStorage.setItem(ABSORB_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the operator merges the old account by its public id */
  }
}

function clearAbsorb(): void {
  try {
    localStorage.removeItem(ABSORB_KEY);
  } catch {
    /* storage unavailable */
  }
}

const SENT_KEY = "siosia.signinEmail";
const SENT_MS = 30 * 60_000;

/** The address a sign-in code went to from this phone in the last 30 minutes (the code step survives a relaunch). */
export function readSentEmail(): string | null {
  return readSent()?.email ?? null;
}

/** …and when (Resend waits a minute from then, across a relaunch too). */
export function readSent(): { email: string; at: number } | null {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    const s = raw ? (JSON.parse(raw) as { email?: string; at?: number }) : null;
    return s?.email && s.at && Date.now() - s.at < SENT_MS ? { email: s.email, at: s.at } : null;
  } catch {
    return null;
  }
}

export function keepSentEmail(email: string | null): void {
  try {
    if (email) localStorage.setItem(SENT_KEY, JSON.stringify({ email, at: Date.now() }));
    else localStorage.removeItem(SENT_KEY);
  } catch {
    /* storage unavailable: the code step lasts until a reload */
  }
}

/** The words for a Google round trip that did not finish (a fixed reason, never Google's text). */
function googleErrorKey(error: GoogleError, intent: "signin" | "link" | null, d: DeploymentConfig): string {
  const base = error === "cancelled" ? "signin.googleCancelled" : error === "in_use" ? "signin.googleInUse" : "signin.googleFailed";
  return intent !== "link" && d.emailSignIn ? `${base}|signin.useEmail` : base;
}

/**
 * One take-over at a time per phone (two tabs of the app share the parked code). A tab that waits
 * more than 15 s gives up (null): the next boot tries again.
 */
async function exclusive<T>(fn: () => Promise<T>): Promise<T | null> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks) return fn();
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15_000) : undefined;
  try {
    return (await locks.request("siosia.absorb", signal ? { signal } : {}, fn)) as T;
  } catch (e) {
    if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) return null;
    throw e;
  }
}

/** Errors that a later try cannot fix: the parked code is dropped. */
const ABSORB_FINAL = new Set([
  "bad_transfer", "already_merged", "account_merged", "other_realm", "two_masters", "two_families",
  "merge_conflict", "sign_in_required", "bad_input", "not_found"
]);

export class AppStore {
  // This phone's appearance choice is read per store (V50): a store made after a change sees it.
  private snap: AppSnapshot = { ...INITIAL, theme: readThemePref() };
  private readonly listeners = new Set<() => void>();
  backend: Backend | null = null;
  private unsubs: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  /** navigate() stepped back over a panel's entry: the entry it lands on becomes this screen. */
  private afterPop: Screen | null = null;
  /** A chat notification opened the app (./?chat=<room>): that room opens once the screen is up. */
  private launchChat: ChatRoom | null = null;
  /** 2.5: ./?appointment=<id> at launch (a session update or heading-home notice tapped while the app was closed). */
  private launchAppointment: string | null = null;
  /** 2.6: ./?open=family or ./?open=report[&week=] opened the app: that panel, once the screen is up. */
  private launchPanel: { panel: "family" | "report"; arg: string | null } | null = null;
  /** When the profile in the snapshot was fetched: its photo URL expires (C16). */
  private profileAt = Date.now();

  constructor(private readonly factory: (cfg: AppConfig) => Promise<Backend> = createBackend) {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.patch({ online: true });
        this.requestRefresh();
      });
      window.addEventListener("offline", () => this.patch({ online: false }));
      window.addEventListener("popstate", (ev: PopStateEvent) => {
        if (this.afterPop) {
          // The screen is already shown (navigate); only the history entry is left to update.
          history.replaceState({ screen: this.afterPop }, "");
          this.afterPop = null;
          return;
        }
        const st = ev.state as NavState;
        if (this.snap.panel) {
          // ← from a panel: back to the panel under it (C3 from its chat), else to the screen.
          this.patch(st?.panel ? { panel: st.panel, panelArg: st.arg ?? null } : { panel: null, panelArg: null });
          return;
        }
        const target = (st?.screen ?? "home") as Screen;
        const pin = this.pinned();
        if (pin && target !== pin) {
          // An active ride or an online driver keeps its screen (V1); offer to go offline.
          history.pushState({ screen: pin }, "");
          if (pin === "drive" && this.snap.my?.driverOnline && !this.snap.my.ride) this.patch({ leaveDrive: target });
          return;
        }
        this.patch({ screen: target, mode: modeOf(target) });
      });
      // The service worker's messages: a notification tapped while the app is open (its link); its
      // question whether this window shows a chat room, answered on the port it sent (FR-222, V48: a
      // thread in front gets no notification); a message handed over instead of one (refresh).
      navigator.serviceWorker?.addEventListener?.("message", (ev: MessageEvent) => {
        const d = ev.data as { type?: string; url?: string; room?: string } | null;
        if (d?.type === "siosia-open" && d.url) this.openFromUrl(d.url);
        else if (d?.type === "siosia-chat-open?") {
          const open =
            document.visibilityState === "visible" && this.snap.phase === "ready" && this.snap.panel === "chat" && this.snap.panelArg === d.room;
          ev.ports?.[0]?.postMessage({ open });
        } else if (d?.type === "siosia-chat-message") this.requestRefresh();
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.snap.phase === "ready") this.requestRefresh();
      });
      // A master link opened in a tab that already runs the app (only the #hash changed).
      window.addEventListener("hashchange", () => {
        if (/(^#|&)(master|join)=/.test(location.hash)) location.reload();
      });
    }
  }

  get = (): AppSnapshot => this.snap;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private patch(p: Partial<AppSnapshot>): void {
    if (p.profile && p.profile !== this.snap.profile) this.profileAt = Date.now();
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((l) => l());
  }

  get api(): Backend {
    if (!this.backend) throw new ServerError("unavailable");
    return this.backend;
  }

  serverNow = (): number => Date.now() + this.snap.clockOffset;

  // ---------- boot ----------

  async boot(cfgOverride?: AppConfig): Promise<void> {
    this.patch({ phase: "loading", bootError: null });
    const missing = unsupportedFeatures();
    if (missing.length) {
      this.patch({ phase: "unsupported", missing });
      return;
    }
    // Take a master link out of the address bar at once (it waits in this tab until it is used).
    const token = takeMasterToken();
    const joinToken = takeJoinToken();
    const cfg = cfgOverride ?? this.snap.cfg ?? (await loadConfig());
    setRoutingUrl(cfg.map.routingUrl);
    setGeocodeUrl(cfg.map.geocodeUrl);
    this.patch({ cfg });
    try {
      if (!this.backend) this.backend = await this.factory(cfg);
      const api = this.backend;
      await api.ping();
      // 2.12: how this deployment signs people in comes first (siosia_config needs no session).
      const deployment = await api.getConfig();
      this.patch({ deployment });
      const { uid, sessionLost } = await api.start({ anonymousOk: deployment.authMode !== "accounts" });
      this.patch({ uid });
      // After start(): supabase-js has taken the session from a Google return this tab started.
      const authReturn = takeAuthReturn();
      const googleError = authReturn.error ? googleErrorKey(authReturn.error, authReturn.intent, deployment) : null;
      // Google came back: the parked old account is bound to this sign-in now, before anything can fail.
      const parked = readAbsorb();
      if (authReturn.google && parked && parked.forEmail === null && !parked.bound) writeAbsorb({ ...parked, bound: true });
      // Google did not sign this phone in: nothing to take along for that attempt.
      if (authReturn.error && authReturn.intent === "signin") clearAbsorb();
      if (!uid) {
        this.toSignIn(googleError ? "google_failed" : sessionLost ? "session_lost" : null, googleError);
        return;
      }
      let who = await api.whoami(deviceId());
      this.patch({ who });
      // A merged-away account, or an anonymous one once accounts are required: sign in (V85, V86).
      if (who.mergedInto) {
        this.toSignIn("account_merged", who.mergedInto);
        return;
      }
      if (who.signInRequired) {
        this.toSignIn("sign_in_required", null);
        return;
      }
      if (googleError) this.patch({ linkNotice: "google_failed", signInDetail: googleError });
      if (token) await this.openMaster(token, false);
      if (joinToken) await this.openJoinLink(joinToken);
      const absorbed = await this.absorbParked();
      if (token || joinToken || absorbed) {
        who = await api.whoami(deviceId());
        this.patch({ who });
      }
      if (!who.member) {
        this.patch({ phase: "invite" });
        return;
      }
      await this.afterMember();
    } catch (e) {
      this.patch({ phase: "unavailable", bootError: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Joins the master profile behind a link — once: on a failure the user simply opens the link
   * again. Another profile on this account is only replaced after the user confirms; until they
   * answer, the token stays in this tab, so a reload (or an app update) asks again.
   */
  private async openMaster(token: string, replace: boolean): Promise<void> {
    try {
      const p = await this.api.joinMaster(token, deviceId(), this.snap.lang, replace);
      clearMasterToken();
      // 2.12 (FR-328): a closed link opened by a phone already on it (an old bookmark): nothing to say.
      this.patch({ linkNotice: p.noop ? this.snap.linkNotice : "joined", masterConfirm: null });
    } catch (e) {
      const code = e instanceof ServerError ? e.code : null;
      if (code === "has_profile") {
        this.patch({ masterConfirm: token });
        return;
      }
      clearMasterToken();
      if (code === "bad_link" || code === "rate_limited" || code === "active_trip" || code === "active_ride") this.patch({ linkNotice: code });
      else this.patch({ linkNotice: "link_failed" });
    }
  }

  // ---------- 2.12 accounts (FR-326, FR-327) ----------

  private toSignIn(notice: SignInNotice | null, detail: string | null): void {
    this.patch({ phase: "signin", signInNotice: notice, signInDetail: detail });
  }

  /** The invite screen's "I have an account": the sign-in screen (the anonymous session stays until then). */
  showSignIn(): void {
    this.toSignIn(null, null);
  }

  /** Whether the sign-in screen may step back to the invite code (a session that is not frozen). */
  canSkipSignIn(): boolean {
    const s = this.snap;
    if (!s.uid || s.who?.mergedInto || s.signInNotice === "account_merged" || s.signInNotice === "sign_in_required") return false;
    return s.who?.anonymous === false || s.deployment?.authMode !== "accounts";
  }

  /** Back from the sign-in screen to the invite code. */
  skipSignIn(): void {
    if (this.canSkipSignIn()) this.patch({ phase: "invite", signInNotice: null });
  }

  /**
   * Before signing in: this phone's anonymous account (with a profile) hands itself over with a
   * transfer code, parked here for the signed-in account to take in after the reload.
   */
  private async prepareAbsorb(forEmail: string | null): Promise<void> {
    const who = this.snap.who;
    clearAbsorb(); // a sign-in never inherits what an earlier attempt parked
    if (!who?.anonymous || !(who.hasProfile || this.snap.profile)) return;
    try {
      const t = await this.api.createTransfer();
      writeAbsorb({ code: t.code, exp: t.expiresAt, oldPublicId: this.snap.profile?.publicId ?? who.publicId ?? null, forEmail, bound: false });
    } catch {
      // not a member any more: nothing to take along
    }
  }

  /** Emails a 6-digit code (FR-326). */
  async sendCode(email: string): Promise<void> {
    const e = email.trim().toLowerCase();
    await this.prepareAbsorb(e);
    await this.api.sendCode!(e);
  }

  /** Signs in with the code; the page reloads as the signed-in account (and takes the old one in). */
  async verifyCode(email: string, code: string): Promise<void> {
    await this.api.verifyCode!(email.trim().toLowerCase(), code);
    keepSentEmail(null);
  }

  async signInWithGoogle(): Promise<void> {
    await this.prepareAbsorb(null);
    markGoogleStart("signin");
    try {
      await this.api.signInWithGoogle!();
    } catch (e) {
      clearGoogleStart();
      throw e;
    }
  }

  async linkGoogle(): Promise<void> {
    markGoogleStart("link");
    try {
      await this.api.linkGoogle!();
    } catch (e) {
      clearGoogleStart();
      throw e;
    }
  }

  /** This phone only: its notifications for the account stop, the other phones stay signed in. */
  async signOut(): Promise<void> {
    clearAbsorb();
    keepSentEmail(null);
    await dropPushSubscription(this.api).catch(() => {});
    await this.api.signOut!();
    // The session change reloads the page; this is the backstop.
    setTimeout(() => {
      if (typeof location !== "undefined") location.reload();
    }, 1500);
  }

  /**
   * Takes in the parked old account once this phone is signed in to the account it was parked for.
   * True when it was joined. A sign-in it was not parked for drops it (and says so).
   */
  private async absorbParked(): Promise<boolean> {
    const who = this.snap.who;
    if (!who || who.anonymous) return false; // still the old session: the sign-in is not done yet
    const before = readAbsorb();
    if (!before) return false;
    const done = await exclusive(async () => {
      const p = readAbsorb(); // read under the lock: another tab may have used it
      if (!p) return true; // it did: membership may have changed, the boot asks again
      if (p.exp <= Date.now()) {
        clearAbsorb();
        return false;
      }
      if (!p.bound) {
        // Google is bound at its return (boot); an email code by the session's own address, read locally.
        const email = p.forEmail ? await (this.api.sessionEmail?.() ?? Promise.resolve(null)).catch(() => undefined) : null;
        if (email === undefined) {
          this.patch({ absorbIssue: { publicId: p.oldPublicId, reason: "unavailable", retry: true } });
          return false;
        }
        if (!p.forEmail || email !== p.forEmail) {
          clearAbsorb();
          this.patch({ absorbIssue: { publicId: p.oldPublicId, reason: null, retry: false } });
          return false;
        }
        writeAbsorb({ ...p, bound: true });
      }
      try {
        await this.api.absorb(p.code, deviceId(), true);
        clearAbsorb();
        this.patch({ linkNotice: "merged", absorbIssue: null });
        return true;
      } catch (e) {
        const reason = e instanceof ServerError ? e.code : "unavailable";
        const final = ABSORB_FINAL.has(reason);
        if (final) clearAbsorb();
        this.patch({ absorbIssue: { publicId: p.oldPublicId, reason, retry: !final } });
        return false;
      }
    });
    return done ?? false;
  }

  /** "Try again" on a failed take-over (the code lives 30 minutes): boots again, which retries it. */
  async retryAbsorb(): Promise<void> {
    const p = readAbsorb();
    if (!p || p.exp <= Date.now()) {
      clearAbsorb();
      this.patch({ absorbIssue: { publicId: this.snap.absorbIssue?.publicId ?? p?.oldPublicId ?? null, reason: "bad_transfer", retry: false } });
      return;
    }
    this.patch({ absorbIssue: null });
    this.dispose();
    await this.boot();
  }

  dismissAbsorbIssue(): void {
    if (this.snap.absorbIssue) this.patch({ absorbIssue: null });
  }

  /** Account → "Merge another account here": whose account the code is, for the person to confirm. */
  previewMerge(code: string) {
    return this.api.absorbPreview(code.trim());
  }

  /** …then the merge (FR-327): its push does not follow (that account's phones sign in again). */
  async mergeAccount(code: string): Promise<void> {
    await this.api.absorb(code.trim(), deviceId(), false);
    await this.reloadProfile();
    await this.refresh();
  }

  /** 2.8 (FR-302): joins with someone's invite link — once: on a failure the user asks for a new one. */
  private async openJoinLink(token: string): Promise<void> {
    try {
      await this.api.joinWithLink(token, deviceId());
      this.patch({ linkNotice: "invited" });
    } catch (e) {
      const code = e instanceof ServerError ? e.code : null;
      this.patch({ linkNotice: code === "bad_link" || code === "rate_limited" ? code : "link_failed" });
    } finally {
      clearJoinToken();
    }
  }

  /** The user agreed to use the master profile from the link instead of their profile here. */
  async confirmMaster(): Promise<void> {
    const token = this.snap.masterConfirm;
    if (!token || !this.snap.uid) return;
    this.patch({ masterConfirm: null });
    await this.openMaster(token, true);
    if (this.snap.linkNotice === "joined") await this.afterMember();
  }

  /**
   * Takes over a profile on this app/phone: a move code from another app (the iOS Home Screen app
   * has its own storage), or a pasted profile link (…#master=…).
   */
  async redeemCode(input: string): Promise<void> {
    const link = /(?:^|[#&?])master=([A-Za-z0-9_-]{16,128})/.exec(input.trim());
    if (link && this.snap.uid) {
      await this.openMaster(link[1], false);
      if (this.snap.linkNotice === "joined") await this.afterMember();
      return;
    }
    try {
      await this.api.redeemTransfer(input, deviceId(), false);
    } catch (e) {
      if (e instanceof ServerError && e.code === "has_profile") {
        this.patch({ moveConfirm: input });
        return;
      }
      throw e;
    }
    await this.afterMoved();
  }

  async confirmMove(): Promise<void> {
    const code = this.snap.moveConfirm;
    if (!code) return;
    this.patch({ moveConfirm: null });
    try {
      await this.api.redeemTransfer(code, deviceId(), true);
    } catch (e) {
      const c = e instanceof ServerError ? e.code : null;
      this.patch({ linkNotice: c === "active_ride" || c === "bad_transfer" || c === "rate_limited" ? c : "link_failed" });
      return;
    }
    await this.afterMoved();
  }

  cancelMove(): void {
    this.patch({ moveConfirm: null });
  }

  private async afterMoved(): Promise<void> {
    this.patch({ linkNotice: "moved" });
    await this.afterMember();
  }

  cancelMaster(): void {
    clearMasterToken();
    this.patch({ masterConfirm: null });
  }

  clearLinkNotice(): void {
    if (this.snap.linkNotice) this.patch({ linkNotice: null });
  }

  private async afterMember(): Promise<void> {
    const api = this.api;
    const profile = await api.getProfile();
    if (!profile) {
      this.patch({ phase: "nickname" });
      return;
    }
    const vehicle = await api.getVehicle();
    this.patch({ profile, vehicle, lang: profile.language });
    this.listen();
    await this.refresh();
    this.land(this.initialScreen());
    // A chat notification tapped while the app was closed: the thread over the screen it opened.
    const room = this.launchChat;
    this.launchChat = null;
    if (room) this.openPanel("chat", room);
    // 2.5: a session update or a heading-home notice tapped while the app was closed (V55).
    const appointment = this.launchAppointment;
    this.launchAppointment = null;
    if (appointment && !room) this.openPanel("appointment", appointment);
    const panel = this.launchPanel;
    this.launchPanel = null;
    if (panel && !room && !appointment) this.openPanel(panel.panel, panel.arg);
  }

  /**
   * Shows the first screen. Launched on an entry that is not the app's (a new window, a
   * notification's ./?open=planned, the first launch, a 1.x entry), that entry becomes S1 and the
   * screen goes on top, so ← finds S1 (otherwise a step back would leave the app, or do nothing in
   * an installed app). A reload of the app's own entry steps from it as a navigation does: it is S1
   * or sits right on S1 already, and making it S1 again left one more S1 under D1 on every reload.
   * Already running (a profile link or move code accepted): a normal navigation.
   */
  private land(screen: Screen): void {
    if (this.snap.phase === "ready") {
      this.navigate(screen);
      return;
    }
    if (typeof history !== "undefined") {
      if ((history.state as NavState)?.screen) this.step(screen);
      else {
        history.replaceState({ screen: "home" }, "");
        if (screen !== "home") history.pushState({ screen }, "");
      }
    }
    this.patch({ screen, mode: modeOf(screen), panel: null, panelArg: null, phase: "ready" });
  }

  /** May this profile use the ride (R) or drive (D) screens? A master profile has one role (FR-085). */
  private allowed(screen: Screen): boolean {
    const role = this.snap.profile?.masterRole ?? null;
    if (screen === "ride") return role !== "driver";
    if (screen === "drive") return role !== "rider";
    return true;
  }

  /** The screen an active ride, an offer card or an online driver holds (V1), or null. */
  private pinned(): Screen | null {
    const my = this.snap.my;
    if (!my) return null;
    if (my.ride) return my.ride.role === "driver" ? "drive" : "ride";
    if (my.offer || my.driverOnline) return "drive";
    return null;
  }

  /**
   * Launch (FR-082, FR-084): S1, unless a ride or an online driver holds a screen; a ?mode= or
   * ?open= link opens that screen once and is removed from the address bar. No mode is remembered.
   */
  private initialScreen(): Screen {
    // The 1.x "last mode" preference is gone for good.
    if (this.snap.uid) writePref(`mode.${this.snap.uid}`, null);
    // A driver on standby (app went quiet while online) reopens on D1, which brings them back online.
    let screen: Screen = this.pinned() ?? (this.snap.my?.standby && this.allowed("drive") ? "drive" : "home");
    if (typeof location !== "undefined") {
      const url = new URL(location.href);
      const mode = url.searchParams.get("mode");
      const open = url.searchParams.get("open");
      if (screen === "home") {
        if ((mode === "ride" || mode === "drive") && this.allowed(mode)) screen = mode;
        else if (open === "siosia") screen = "catalog";
        else if (open === "planned" || open === "history") screen = open;
        // 2.6: the weekly report sits over H1, Family & contracts over S1.
        else if (open === "report") screen = "history";
      }
      this.launchPanel =
        open === "family" ? { panel: "family", arg: null } : open === "report" ? { panel: "report", arg: reportWeekOf(url.searchParams.get("week")) } : null;
      // ./?chat=<room> (2.3): the thread opens as a panel over whatever screen applies;
      // ./?appointment=<id> (2.5): C3 of that appointment, the same way.
      this.launchChat = chatRoomOf(url.searchParams.get("chat"));
      this.launchAppointment = appointmentIdOf(url.searchParams.get("appointment"));
      if (url.searchParams.has("mode") || url.searchParams.has("open") || url.searchParams.has("chat") || url.searchParams.has("appointment")) {
        url.searchParams.delete("week");
        url.searchParams.delete("mode");
        url.searchParams.delete("open");
        url.searchParams.delete("chat");
        url.searchParams.delete("appointment");
        history.replaceState(history.state, "", url);
      }
    }
    return screen;
  }

  /** Go to a screen (FR-082). A held screen (V1) stays; an online driver is asked first (C11). */
  go(screen: Screen): void {
    if (!this.allowed(screen)) return;
    if (screen === this.snap.screen) {
      if (this.snap.panel) this.closePanel();
      return;
    }
    const pin = this.pinned();
    if (pin && screen !== pin) {
      // Remember where they were going: after going offline they get there, not to S1.
      if (pin === "drive" && this.snap.my?.driverOnline && !this.snap.my.ride) this.patch({ leaveDrive: screen });
      return;
    }
    this.navigate(screen);
  }

  /** A button inside a panel opens a screen: the panel closes and the history is [S1, screen]. */
  goFromPanel(screen: Screen): void {
    if (!this.allowed(screen)) return;
    const pin = this.pinned();
    if (pin && screen !== pin) return;
    this.navigate(screen);
  }

  /** Shows `target`, the history following it (step). */
  private navigate(target: Screen): void {
    if (typeof history !== "undefined") this.step(target);
    // At once (the popstate of a step back only confirms it).
    this.patch({ screen: target, mode: modeOf(target), panel: null, panelArg: null });
  }

  /**
   * Moves the history to `target` keeping it at [S1] or [S1, target]: from S1 a new entry, between
   * sub-screens the entry is replaced, S1 is a step back. The panels' entries are dropped on the
   * way, else ← from the new screen would step back to the screen under the panel (C2 → C3 → Planned).
   */
  private step(target: Screen): void {
    const st = history.state as NavState;
    if (st?.panel) {
      const below = st.screen ?? "home";
      const depth = st.depth ?? 1;
      if (target === below) history.go(-depth);
      else if (target === "home") history.go(-(depth + 1));
      else if (below === "home" && depth === 1) history.replaceState({ screen: target }, "");
      else {
        // [S1, screen, panel…]: back over the panels, then that screen's entry becomes the target;
        // [S1, panel, panel…]: back to the first panel's entry, which becomes the target's.
        this.afterPop = target;
        history.go(below === "home" ? -(depth - 1) : -depth);
      }
    } else if (target === "home") {
      // A screen's entry always sits right on S1's (land), so S1 is one step back.
      if (st?.screen && st.screen !== "home") history.back();
      else history.replaceState({ screen: "home" }, "");
    } else if ((st?.screen ?? "home") === "home") history.pushState({ screen: target }, "");
    else history.replaceState({ screen: target }, "");
  }

  /** Back to S1 from any screen (the ← in the top bar). */
  home(): void {
    this.go("home");
  }

  /** A link inside the app (notification tap): ./?open=planned and friends; ./?chat=<room> opens that thread. */
  openFromUrl(href: string): void {
    try {
      const params = new URL(href, typeof location !== "undefined" ? location.href : "http://x/").searchParams;
      const room = chatRoomOf(params.get("chat"));
      // A panel over the current screen: an online driver keeps D1 and still reads the message.
      if (room) {
        this.openPanel("chat", room);
        return;
      }
      // 2.5: a session update or a heading-home notice opens its appointment (C3) the same way.
      const appointment = appointmentIdOf(params.get("appointment"));
      if (appointment) {
        this.openPanel("appointment", appointment);
        return;
      }
      const open = params.get("open");
      if (open === "siosia") this.go("catalog");
      else if (open === "planned" || open === "history") this.go(open);
      // 2.6: Family & contracts over the current screen; the weekly report over H1.
      else if (open === "family") this.openPanel("family");
      else if (open === "report") {
        if (this.snap.screen !== "history" && !this.pinned()) this.go("history");
        this.openPanel("report", reportWeekOf(params.get("week")));
      }
    } catch {
      /* not a link of ours */
    }
  }

  /**
   * 2.9 (FR-312): a notification in the bell opens what it is about, as its push would; one about a
   * ride ("./") shows the ride in progress, else History, where the past ones are.
   */
  openNotification(n: NotificationItem): void {
    const url = pushUrl(n.kind, n.params, n.appointmentId);
    if (url !== "./") {
      this.openFromUrl(url);
      return;
    }
    const pin = this.pinned();
    this.go(pin ?? "history");
  }

  /** The online driver confirmed leaving D1: go offline, then where they were going (S1, or e.g. Planned from a notification). */
  async leaveDriveConfirmed(): Promise<void> {
    const target = this.snap.leaveDrive ?? "home";
    this.patch({ leaveDrive: null });
    await this.api.setOnline(false);
    await this.refresh();
    this.go(target);
  }

  cancelLeaveDrive(): void {
    this.patch({ leaveDrive: null });
  }

  async join(code: string): Promise<void> {
    // 2.8: an invite link pasted where the code goes works as well.
    const link = joinTokenOf(code);
    if (link) await this.api.joinWithLink(link, deviceId());
    else await this.api.join(code, deviceId());
    await this.afterMember();
  }

  async saveNickname(nickname: string): Promise<void> {
    const profile = await this.api.saveProfile(nickname, this.snap.lang);
    this.patch({ profile });
    if (this.snap.phase === "nickname") await this.afterMember();
  }

  async setLang(lang: Lang): Promise<void> {
    writePref("lang", lang);
    this.patch({ lang });
    if (this.snap.profile) {
      const profile = await this.api.saveProfile(this.snap.profile.nickname, lang).catch(() => null);
      if (profile) this.patch({ profile });
    }
  }

  /** Appearance (2.4, V50): this phone's choice, kept here only (never on the server). */
  setTheme(theme: ThemePref): void {
    saveThemePref(theme);
    applyTheme(theme);
    this.patch({ theme });
  }

  /** v1 compatibility: the ride / drive screens (null = S1). */
  setMode(mode: Mode | null): void {
    this.go(mode === "ride" ? "ride" : mode === "drive" ? "drive" : "home");
  }

  /**
   * Opens a panel over the screen — or over the open panel (the chat from C3, the vehicle form from
   * S2): one history entry per panel, so ← / X from the chat lands on C3, not on the screen (C15).
   * The same panel with the same argument adds nothing.
   */
  openPanel(panel: Panel, arg: string | null = null): void {
    if (panel && typeof history !== "undefined" && (panel !== this.snap.panel || arg !== this.snap.panelArg)) {
      const st = history.state as NavState;
      const depth = (st?.panel ? st.depth ?? 1 : 0) + 1;
      history.pushState({ panel, arg, screen: this.snap.screen, depth }, "");
    }
    this.patch({ panel, panelArg: arg });
  }

  closePanel(): void {
    if (this.snap.panel && typeof history !== "undefined" && history.state?.panel) history.back();
    else this.patch({ panel: null, panelArg: null });
  }

  async saveVehicle(v: Vehicle): Promise<Vehicle> {
    const vehicle = await this.api.saveVehicle(v);
    this.patch({ vehicle });
    await this.refresh();
    return vehicle;
  }

  /**
   * 2.1 (FR-170): the car's colour name (in the driver's words) and paint, from the car icon. The
   * vehicle is replaced at once, so every car icon of this user redraws in the new paint.
   */
  async setCarColour(colour: string, paint: string): Promise<Vehicle> {
    const saved = await this.api.setCarColour(colour, paint);
    const vehicle: Vehicle = { ...saved, paint: saved.paint === undefined ? paint.toLowerCase() : saved.paint };
    this.patch({ vehicle });
    return vehicle;
  }

  async reloadProfile(): Promise<void> {
    const profile = await this.api.getProfile();
    if (profile) this.patch({ profile });
  }

  async deleteProfile(): Promise<void> {
    await this.api.deleteProfile();
    // The live listeners would now only get not_member errors.
    this.dispose();
    // Deleting also removes this device's membership, so a gated deployment asks for the invite
    // code again (join → afterMember → nickname); an open demo goes straight to the nickname.
    const member = await this.api.isMember(deviceId()).catch(() => false);
    this.patch({ profile: null, vehicle: null, screen: "home", mode: null, panel: null, panelArg: null, my: null, phase: member ? "nickname" : "invite" });
  }

  // ---------- live state ----------

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [this.api.onMyChanges(() => this.requestRefresh())];
    if (this.api.onPush) this.unsubs.push(this.api.onPush((m) => void this.showPush(m)));
    if (this.pollTimer) clearInterval(this.pollTimer);
    // Backstop for missed realtime events; also runs the server-side expiry check on read (§6.7).
    this.pollTimer = setInterval(() => {
      const my = this.snap.my;
      const busy = !!my && (!!my.ride || !!my.offer);
      if (busy && !this.snap.my?.driverOnline) void this.refresh().catch(() => {});
    }, CADENCE.pollActiveMs);
  }

  /** Demo backend: a notification event — a banner in the app, or a system one in the background. */
  private async showPush(m: PushMessage): Promise<void> {
    const room = m.kind === "chat_message" ? chatRoomOf(m.params.room) : null;
    const inFront = typeof document !== "undefined" && document.visibilityState === "visible";
    // A message in the thread the user is looking at needs no banner (FR-222).
    if (room && inFront && this.snap.panel === "chat" && this.snap.panelArg === room) return;
    const text = pushText(m.kind, m.params, this.snap.lang, this.snap.deployment?.timezone ?? "Europe/Warsaw", m.appointmentId ?? m.rideId);
    // As push-dispatch opens them (2.9: one pushUrl for the push, the banner and the bell).
    const target = room ? `./?chat=${encodeURIComponent(room)}` : pushUrl(m.kind, m.params, m.appointmentId);
    const url = target === "./" ? null : target;
    if (inFront) this.patch({ pushToast: { title: text.title, body: text.body, url } });
    else await showLocal(text.title, text.body, text.tag);
  }

  clearPushToast(): void {
    if (this.snap.pushToast) this.patch({ pushToast: null });
  }

  /**
   * Coalesces bursts of realtime events into one fetch. Also the moment to renew a profile fetched
   * long ago: its photo URL is signed for an hour, and a PWA stays open for days (C16).
   */
  requestRefresh(delay = 120): void {
    if (this.snap.profile && this.snap.phase === "ready" && Date.now() - this.profileAt > PROFILE_MAX_AGE_MS) {
      this.profileAt = Date.now(); // once per expiry, whatever the reload does
      void this.reloadProfile().catch(() => {});
    }
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => {});
    }, delay);
  }

  async refresh(): Promise<void> {
    if (!this.backend || !this.snap.uid) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.refreshAgain = false;
          const t0 = Date.now();
          const my = await this.api.myState();
          this.applyMy(my, t0, true);
        } while (this.refreshAgain);
      } catch (e) {
        if (e instanceof ServerError && (e.code === "not_member" || e.code === "no_profile")) void this.lostProfile();
        // 2.12 (V85, V86): merged away, or accounts now required — boot again, which asks to sign in
        else if (e instanceof ServerError && (e.code === "sign_in_required" || e.code === "account_merged")) void this.lostProfile(true);
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Accepts a MyState from any call (heartbeat returns one too); `refreshed`: from refresh(). */
  applyMy(my: MyState, sentAt = Date.now(), refreshed = false): void {
    const now = Date.now();
    const rtt = now - sentAt;
    const offset = my.serverNow - (sentAt + rtt / 2);
    // Smooth the offset so a single slow response doesn't make countdowns jump.
    const clockOffset = this.snap.my ? this.snap.clockOffset * 0.7 + offset * 0.3 : offset;
    this.patch(refreshed ? { my, clockOffset, changes: this.snap.changes + 1 } : { my, clockOffset });
    if (this.snap.phase !== "ready") return;
    if (my.hasProfile === false) {
      void this.lostProfile();
      return;
    }
    // The screen follows the active ride (V1): a booking that starts while this phone shows
    // another screen must not stay invisible; an offer card shows on D1.
    const want: Screen | null = my.ride ? (my.ride.role === "driver" ? "drive" : "ride") : my.offer ? "drive" : null;
    if (want && this.snap.screen !== want) this.navigate(want);
  }

  private losing = false;

  /**
   * This account lost its profile or membership (moved to another app or phone, deleted, link
   * replaced). `quiet`: it must sign in (2.12) — the sign-in screen says why, no "moved away" toast.
   */
  private async lostProfile(quiet = false): Promise<void> {
    if (this.losing || this.snap.phase !== "ready") return;
    this.losing = true;
    try {
      this.dispose();
      this.patch({
        profile: null, vehicle: null, screen: "home", mode: null, panel: null, panelArg: null, my: null,
        linkNotice: quiet ? this.snap.linkNotice : "moved_away"
      });
      await this.boot();
    } finally {
      this.losing = false;
    }
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

export const StoreContext = createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error("StoreContext missing");
  return s;
}

export function useApp(): AppSnapshot {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

/**
 * Changes when lists fetched from the server (History, Planned, C3, bookings) may be out of date:
 * a refresh of my state or a change in what it counts. Not every new MyState: an online driver's
 * heartbeat brings one every 4 s, and reloading on each refetched the lists all the time.
 */
export function useListsKey(): string {
  const app = useApp();
  const my = app.my;
  return [app.changes, my?.ride?.id, my?.ride?.status, my?.pendingReceipt?.id, my?.toAnswer, my?.openRequests, my?.planned, my?.bookings, my?.driverBookings, my?.openBookings, my?.unreadChats, my?.familyPending].join(
    "|"
  );
}
