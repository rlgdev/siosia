// AppStore: boot sequence (config → backend → reachability → session → invite → nickname), the
// user's live server state (MyState) kept fresh by realtime events plus a polling backstop, the
// server clock offset (countdowns use server time — §12 clock skew) and UI navigation state.

import { createContext, useContext, useSyncExternalStore } from "react";
import { createBackend } from "../backend";
import type { Backend } from "../backend/types";
import { loadConfig, type AppConfig } from "../config";
import { CADENCE } from "../core/defaults";
import type { DeploymentConfig, Lang, Mode, MyState, Profile, Vehicle } from "../core/types";
import { ServerError } from "../core/types";
import { browserLang } from "../i18n";
import { setGeocodeUrl } from "../services/geocode";
import { setRoutingUrl } from "../services/routing";
import { deviceId, readPref, unsupportedFeatures, writePref } from "../services/device";

export type Phase = "loading" | "unsupported" | "unavailable" | "invite" | "nickname" | "ready";
export type Panel = "profile" | "history" | "vehicle" | "earnings" | null;

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
  bootError: null
};

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
      if (!(await api.isMember(deviceId()))) {
        this.patch({ phase: "invite" });
        return;
      }
      await this.afterMember();
    } catch (e) {
      this.patch({ phase: "unavailable", bootError: e instanceof Error ? e.message : String(e) });
    }
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
    if (typeof location !== "undefined") {
      const url = new URL(location.href);
      const fromUrl = url.searchParams.get("mode");
      if (fromUrl === "ride" || fromUrl === "drive") mode = fromUrl;
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
    if (this.pollTimer) clearInterval(this.pollTimer);
    // Backstop for missed realtime events; also runs the server-side expiry check on read (§6.7).
    this.pollTimer = setInterval(() => {
      const my = this.snap.my;
      const busy = !!my && (!!my.ride || !!my.offer);
      if (busy && !this.snap.my?.driverOnline) void this.refresh().catch(() => {});
    }, CADENCE.pollActiveMs);
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
