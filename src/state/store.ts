// AppStore: boot sequence (config → backend → reachability → session → invite → nickname), the
// user's live server state (MyState) kept fresh by realtime events plus a polling backstop, the
// server clock offset (countdowns use server time — §12 clock skew) and UI navigation state.
//
// Navigation (2.0, FR-080–084): a screen stack rooted at S1 Home. Siosia (catalog), Planned and
// History open from S1; Ride (R1…) and Drive (D1…) from the catalog. The screen follows an active
// ride or an online driver (V1); nothing else is remembered between launches.

import { createContext, useContext, useSyncExternalStore } from "react";
import { createBackend } from "../backend";
import type { Backend, PushMessage } from "../backend/types";
import { pushText } from "../../supabase/functions/_shared/push-text";
import { showLocal } from "../services/push";
import { loadConfig, type AppConfig } from "../config";
import { CADENCE } from "../core/defaults";
import type { DeploymentConfig, Lang, Mode, MyState, Profile, Vehicle } from "../core/types";
import { ServerError } from "../core/types";
import { browserLang } from "../i18n";
import { setGeocodeUrl } from "../services/geocode";
import { setRoutingUrl } from "../services/routing";
import { deviceId, readPref, unsupportedFeatures, writePref } from "../services/device";

export type Phase = "loading" | "unsupported" | "unavailable" | "invite" | "nickname" | "ready";
/** Outcome of opening a master-profile link, shown once. */
export type LinkNotice =
  | "joined"
  | "moved"
  | "moved_away"
  | "bad_link"
  | "bad_transfer"
  | "rate_limited"
  | "active_trip"
  | "active_ride"
  | "link_failed";
export type Panel = "profile" | "history" | "vehicle" | "earnings" | "bookings" | "request" | "appointment" | null;
/** S1 Home, C1 Catalog ("Siosia"), P1 Planned, H1 History, the v1 rider (R) and driver (D) screens. */
export type Screen = "home" | "catalog" | "planned" | "history" | "ride" | "drive";
const modeOf = (s: Screen): Mode | null => (s === "ride" ? "ride" : s === "drive" ? "drive" : null);

export interface AppSnapshot {
  phase: Phase;
  cfg: AppConfig | null;
  deployment: DeploymentConfig | null;
  uid: string | null;
  profile: Profile | null;
  vehicle: Vehicle | null;
  lang: Lang;
  screen: Screen;
  /** The v1 mode of the screen (ride / drive), null elsewhere. */
  mode: Mode | null;
  panel: Panel;
  /** What the panel shows: the catalog entry of C2, the appointment of C3. */
  panelArg: string | null;
  /** A driver who is online tried to leave D1: ask before going offline. */
  leaveDrive: boolean;
  my: MyState | null;
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
  /** A notification shown inside the app while it is in front (demo backend). */
  pushToast: { title: string; body: string } | null;
}

const INITIAL: AppSnapshot = {
  phase: "loading",
  cfg: null,
  deployment: null,
  uid: null,
  profile: null,
  vehicle: null,
  lang: readPref<Lang | null>("lang", null) ?? browserLang(),
  screen: "home",
  mode: null,
  panel: null,
  panelArg: null,
  leaveDrive: false,
  my: null,
  clockOffset: 0,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  missing: [],
  bootError: null,
  linkNotice: null,
  masterConfirm: null,
  moveConfirm: null,
  pushToast: null
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

function clearMasterToken(): void {
  try {
    sessionStorage.removeItem(MASTER_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class AppStore {
  private snap: AppSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  backend: Backend | null = null;
  private unsubs: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;

  constructor(private readonly factory: (cfg: AppConfig) => Promise<Backend> = createBackend) {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.patch({ online: true });
        this.requestRefresh();
      });
      window.addEventListener("offline", () => this.patch({ online: false }));
      window.addEventListener("popstate", (ev: PopStateEvent) => {
        if (this.snap.panel) {
          this.patch({ panel: null, panelArg: null });
          return;
        }
        const target = ((ev.state as { screen?: Screen } | null)?.screen ?? "home") as Screen;
        const pin = this.pinned();
        if (pin && target !== pin) {
          // An active ride or an online driver keeps its screen (V1); offer to go offline.
          history.pushState({ screen: pin }, "");
          if (pin === "drive" && this.snap.my?.driverOnline && !this.snap.my.ride) this.patch({ leaveDrive: true });
          return;
        }
        this.patch({ screen: target, mode: modeOf(target) });
      });
      // A notification tapped while the app is open (the service worker posts its link).
      navigator.serviceWorker?.addEventListener?.("message", (ev: MessageEvent) => {
        const d = ev.data as { type?: string; url?: string } | null;
        if (d?.type === "siosia-open" && d.url) this.openFromUrl(d.url);
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.snap.phase === "ready") this.requestRefresh();
      });
      // A master link opened in a tab that already runs the app (only the #hash changed).
      window.addEventListener("hashchange", () => {
        if (/(^#|&)master=/.test(location.hash)) location.reload();
      });
    }
  }

  get = (): AppSnapshot => this.snap;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private patch(p: Partial<AppSnapshot>): void {
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
    const cfg = cfgOverride ?? this.snap.cfg ?? (await loadConfig());
    setRoutingUrl(cfg.map.routingUrl);
    setGeocodeUrl(cfg.map.geocodeUrl);
    this.patch({ cfg });
    try {
      if (!this.backend) this.backend = await this.factory(cfg);
      const api = this.backend;
      await api.ping();
      const uid = await api.start();
      const deployment = await api.getConfig();
      this.patch({ uid, deployment });
      if (token) await this.openMaster(token, false);
      if (!(await api.isMember(deviceId()))) {
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
      await this.api.joinMaster(token, deviceId(), this.snap.lang, replace);
      clearMasterToken();
      this.patch({ linkNotice: "joined", masterConfirm: null });
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
    const screen = this.initialScreen();
    this.patch({ screen, mode: modeOf(screen), phase: "ready" });
    if (screen !== "home" && typeof history !== "undefined") history.replaceState({ screen }, "");
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
      }
      if (url.searchParams.has("mode") || url.searchParams.has("open")) {
        url.searchParams.delete("mode");
        url.searchParams.delete("open");
        history.replaceState(history.state, "", url);
      }
    }
    return screen;
  }

  /**
   * Go to a screen. From S1 a new history entry (browser back returns to S1); between sub-screens
   * the entry is replaced; going home walks back. A held screen (V1) stays.
   */
  go(screen: Screen): void {
    if (!this.allowed(screen)) return;
    const from = this.snap.screen;
    if (screen === from) {
      if (this.snap.panel) this.closePanel();
      return;
    }
    const pin = this.pinned();
    if (pin && screen !== pin) {
      if (pin === "drive" && this.snap.my?.driverOnline && !this.snap.my.ride) this.patch({ leaveDrive: true });
      return;
    }
    if (typeof history !== "undefined") {
      if (screen === "home") {
        if ((history.state as { screen?: Screen } | null)?.screen === from) {
          history.back(); // popstate sets home
          return;
        }
      } else if (from === "home") history.pushState({ screen }, "");
      else history.replaceState({ screen }, "");
    }
    this.patch({ screen, mode: modeOf(screen), panel: null, panelArg: null });
  }

  /** A button inside a panel opens a screen: the panel's history entry becomes that screen. */
  goFromPanel(screen: Screen): void {
    if (!this.allowed(screen)) return;
    const pin = this.pinned();
    if (pin && screen !== pin) return;
    if (typeof history !== "undefined" && (history.state as { panel?: Panel } | null)?.panel) {
      if (screen === "home") history.back();
      else history.replaceState({ screen }, "");
    }
    this.patch({ screen, mode: modeOf(screen), panel: null, panelArg: null });
  }

  /** Back to S1 from any screen (the ← in the top bar). */
  home(): void {
    this.go("home");
  }

  /** A link inside the app (notification tap): ./?open=planned and friends. */
  openFromUrl(href: string): void {
    try {
      const open = new URL(href, typeof location !== "undefined" ? location.href : "http://x/").searchParams.get("open");
      if (open === "siosia") this.go("catalog");
      else if (open === "planned" || open === "history") this.go(open);
    } catch {
      /* not a link of ours */
    }
  }

  /** The online driver confirmed leaving D1: go offline, then S1. */
  async leaveDriveConfirmed(): Promise<void> {
    this.patch({ leaveDrive: false });
    await this.api.setOnline(false);
    await this.refresh();
    this.go("home");
  }

  cancelLeaveDrive(): void {
    this.patch({ leaveDrive: false });
  }

  async join(code: string): Promise<void> {
    await this.api.join(code, deviceId());
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

  /** v1 compatibility: the ride / drive screens (null = S1). */
  setMode(mode: Mode | null): void {
    this.go(mode === "ride" ? "ride" : mode === "drive" ? "drive" : "home");
  }

  openPanel(panel: Panel, arg: string | null = null): void {
    if (panel && !this.snap.panel && typeof history !== "undefined") history.pushState({ panel, screen: this.snap.screen }, "");
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
    const text = pushText(m.kind, m.params, this.snap.lang, this.snap.deployment?.timezone ?? "Europe/Warsaw", m.appointmentId ?? m.rideId);
    if (typeof document !== "undefined" && document.visibilityState === "visible") this.patch({ pushToast: { title: text.title, body: text.body } });
    else await showLocal(text.title, text.body, text.tag);
  }

  clearPushToast(): void {
    if (this.snap.pushToast) this.patch({ pushToast: null });
  }

  /** Coalesces bursts of realtime events into one fetch. */
  requestRefresh(delay = 120): void {
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
          this.applyMy(my, t0);
        } while (this.refreshAgain);
      } catch (e) {
        if (e instanceof ServerError && (e.code === "not_member" || e.code === "no_profile")) void this.lostProfile();
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Accepts a MyState from any call (heartbeat returns one too). */
  applyMy(my: MyState, sentAt = Date.now()): void {
    const now = Date.now();
    const rtt = now - sentAt;
    const offset = my.serverNow - (sentAt + rtt / 2);
    // Smooth the offset so a single slow response doesn't make countdowns jump.
    const clockOffset = this.snap.my ? this.snap.clockOffset * 0.7 + offset * 0.3 : offset;
    this.patch({ my, clockOffset });
    if (this.snap.phase !== "ready") return;
    if (my.hasProfile === false) {
      void this.lostProfile();
      return;
    }
    // The screen follows the active ride (V1): a booking that starts while this phone shows
    // another screen must not stay invisible; an offer card shows on D1.
    const want: Screen | null = my.ride ? (my.ride.role === "driver" ? "drive" : "ride") : my.offer ? "drive" : null;
    if (want && this.snap.screen !== want) {
      if (typeof history !== "undefined") {
        if (this.snap.screen === "home") history.pushState({ screen: want }, "");
        else history.replaceState({ screen: want }, "");
      }
      this.patch({ screen: want, mode: modeOf(want), panel: null, panelArg: null });
    }
  }

  private losing = false;

  /** This account lost its profile or membership (moved to another app or phone, deleted, link replaced). */
  private async lostProfile(): Promise<void> {
    if (this.losing || this.snap.phase !== "ready") return;
    this.losing = true;
    try {
      this.dispose();
      this.patch({ profile: null, vehicle: null, screen: "home", mode: null, panel: null, panelArg: null, my: null, linkNotice: "moved_away" });
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
