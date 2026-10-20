// Demo-mode helpers: the robot fleet singleton (mock backend only) and a data reset.

import { useEffect, useRef } from "react";
import type { RobotFleet } from "../backend/mock/robots";
import type { RobotSiosia } from "../backend/mock/siosiaRobot";
import { destination } from "../core/geo";
import type { LatLng } from "../core/types";
import { readPref } from "../services/device";
import { useApp } from "./store";

let fleet: RobotFleet | null = null;
let starting: Promise<RobotFleet | null> | null = null;

export const robotsEnabled = () => readPref<boolean>("robots", true);

async function ensureFleet(center: LatLng, cfg: ReturnType<typeof useApp>["cfg"]): Promise<RobotFleet | null> {
  if (fleet) return fleet;
  if (starting) return starting;
  if (!cfg) return null;
  starting = (async () => {
    const { RobotFleet } = await import("../backend/mock/robots");
    const count = Math.min(4, Math.max(0, Number(new URLSearchParams(location.search).get("robots") ?? "2") || 0));
    if (count > 0) {
      const f = new RobotFleet({ ...cfg.deployment, inviteCode: cfg.mockInviteCode }, center, count);
      f.start(); // runs now, or as soon as the tab currently running the robots closes
      fleet = f;
    }
    starting = null;
    return fleet;
  })();
  return starting;
}

/** Runs the robot fleet near `center` while mounted (mock backend + robots enabled only). */
export function useRobots(center: LatLng | null, enabled: boolean): void {
  const app = useApp();
  const active = enabled && app.cfg?.backend === "mock" && robotsEnabled();
  const cfgRef = useRef(app.cfg);
  cfgRef.current = app.cfg;
  const lat = center ? Math.round(center.lat * 200) / 200 : null;
  const lng = center ? Math.round(center.lng * 200) / 200 : null;
  useEffect(() => {
    if (!active || lat === null || lng === null) return;
    void ensureFleet({ lat, lng }, cfgRef.current).then((f) => f?.setCenter({ lat, lng }));
  }, [active, lat, lng]);
}

export async function stopRobots(): Promise<void> {
  const f = fleet ?? (starting ? await starting : null);
  fleet = null;
  await f?.stop();
  siosia?.stop();
  siosia = null;
  siosiaLock?.abort();
}

let siosia: RobotSiosia | null = null;
let siosiaLock: AbortController | null = null;

/**
 * The robot Siosia (FR-151) of the demo: runs in exactly one tab of this browser while the app is
 * ready on the mock backend (robots on, and not turned off with ?siosia=0). Another tab waits and
 * takes over when that tab closes.
 */
export function useRobotSiosia(): void {
  const app = useApp();
  const cfg = app.cfg;
  const active = app.phase === "ready" && cfg?.backend === "mock" && robotsEnabled() && new URLSearchParams(location.search).get("siosia") !== "0";
  useEffect(() => {
    if (!active || !cfg || siosiaLock) return;
    const abort = typeof AbortController !== "undefined" ? new AbortController() : null;
    siosiaLock = abort;
    const run = async () => {
      const { RobotSiosia } = await import("../backend/mock/siosiaRobot");
      const home = { ...destination(cfg.fallbackCenter, 210, 1.2), label: "Siosia" };
      siosia = new RobotSiosia({ ...cfg.deployment, inviteCode: cfg.mockInviteCode }, home);
      await siosia.start();
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) void run();
    else
      void locks
        .request("siosia-robot-siosia", { signal: abort?.signal }, async () => {
          await run();
          await new Promise<void>((release) => abort?.signal.addEventListener("abort", () => release()));
        })
        .catch(() => {
          /* aborted */
        });
  }, [active, cfg]);
}

export async function resetDemo(): Promise<void> {
  await stopRobots();
  const { resetMockDb } = await import("../backend/mock/store");
  resetMockDb();
  try {
    sessionStorage.clear();
    for (const k of Object.keys(localStorage)) if (k.startsWith("siosia.mode") || k.startsWith("siosia.dismissed")) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  location.reload();
}
