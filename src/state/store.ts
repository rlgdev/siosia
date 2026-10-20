// AppStore: boot sequence (config → backend → reachability → session → invite → nickname), the
// user's live server state (MyState) kept fresh by realtime events plus a polling backstop, the
// server clock offset (countdowns use server time — §12 clock skew) and UI navigation state.

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
export type Panel = "profile" | "history" | "vehicle" | "earnings" | "bookings" | null;

export interface AppSnapshot {
  phase: Phase;
  cfg: AppConfig | null;
  deployment: DeploymentConfig | null;
  uid: string | null;
  profile: Profile | null;
  vehicle: Vehicle | null;
  lang: Lang;
  mode: Mode | null;
  panel: Panel;
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
  mode: null,
  panel: null,
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
      window.addEventListener("popstate", () => {
        if (this.snap.panel) this.patch({ panel: null });
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
      if (token) await this.openMaster(token, uid, false);
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
  private async openMaster(token: string, uid: string, replace: boolean): Promise<void> {
    try {
      const p = await this.api.joinMaster(token, deviceId(), this.snap.lang, replace);
      clearMasterToken();
      writePref(`mode.${uid}`, p.masterRole === "driver" ? "drive" : "ride");
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
    await this.openMaster(token, this.snap.uid, true);
    if (this.snap.linkNotice === "joined") await this.afterMember();
  }

  /**
   * Takes over a profile on this app/phone: a move code from another app (the iOS Home Screen app
   * has its own storage), or a pasted profile link (…#master=…).
   */
  async redeemCode(input: string): Promise<void> {
    const link = /(?:^|[#&?])master=([A-Za-z0-9_-]{16,128})/.exec(input.trim());
    if (link && this.snap.uid) {
      await this.openMaster(link[1], this.snap.uid, false);
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
    writePref(`mode.${this.snap.uid}`, null);
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
    this.patch({ mode: this.initialMode(), phase: "ready" });
  }

  /**
   * Mode on launch (§3: per device). A ?mode= link preselects once and is then removed from the URL,
   * so a reload mid-trip reopens the mode this device was actually using (remembered per user).
   */
  private initialMode(): Mode | null {
    const key = `mode.${this.snap.uid}`;
    let mode: Mode | null = readPref<Mode | null>(key, null);
    // A master profile has one role: it always opens in that mode.
    const role = this.snap.profile?.masterRole ?? null;
    if (role) mode = role === "driver" ? "drive" : "ride";
    if (typeof location !== "undefined") {
      const url = new URL(location.href);
      const fromUrl = url.searchParams.get("mode");
      if ((fromUrl === "ride" || fromUrl === "drive") && !role) mode = fromUrl;
      if (url.searchParams.has("mode")) {
        url.searchParams.delete("mode");
        history.replaceState(history.state, "", url);
      }
    }
    writePref(key, mode);
    return mode;
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

  /** The chosen mode is remembered per user on this device (§3: mode is per device session). */
  setMode(mode: Mode | null): void {
    const role = this.snap.profile?.masterRole ?? null;
    if (role && mode !== null && mode !== (role === "driver" ? "drive" : "ride")) return; // one-role profile
    writePref(`mode.${this.snap.uid}`, mode);
    this.patch({ mode, panel: null });
  }

  openPanel(panel: Panel): void {
    if (panel && !this.snap.panel && typeof history !== "undefined") history.pushState({ panel }, "");
    this.patch({ panel });
  }

  closePanel(): void {
    if (this.snap.panel && typeof history !== "undefined" && history.state?.panel) history.back();
    else this.patch({ panel: null });
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
    writePref(`mode.${this.snap.uid}`, null);
    // The live listeners would now only get not_member errors.
    this.dispose();
    // Deleting also removes this device's membership, so a gated deployment asks for the invite
    // code again (join → afterMember → nickname); an open demo goes straight to the nickname.
    const member = await this.api.isMember(deviceId()).catch(() => false);
    this.patch({ profile: null, vehicle: null, mode: null, panel: null, my: null, phase: member ? "nickname" : "invite" });
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
    // The screen follows the active ride: a booking that starts while this phone is in the other
    // mode (or on Home) must not stay invisible.
    if (my.ride) {
      const want: Mode = my.ride.role === "driver" ? "drive" : "ride";
      if (this.snap.mode !== want) {
        writePref(`mode.${this.snap.uid}`, want);
        this.patch({ mode: want });
      }
    }
  }

  private losing = false;

  /** This account lost its profile or membership (moved to another app or phone, deleted, link replaced). */
  private async lostProfile(): Promise<void> {
    if (this.losing || this.snap.phase !== "ready") return;
    this.losing = true;
    try {
      this.dispose();
      writePref(`mode.${this.snap.uid}`, null);
      this.patch({ profile: null, vehicle: null, mode: null, panel: null, my: null, linkNotice: "moved_away" });
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
