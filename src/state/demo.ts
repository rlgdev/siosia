// Demo-mode helpers: the robot fleet singleton (mock backend only) and a data reset.

import { useEffect, useRef } from "react";
import type { RobotFleet } from "../backend/mock/robots";
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
    const count = Number(new URLSearchParams(location.search).get("robots") ?? "2");
    const f = new RobotFleet({ ...cfg.deployment, inviteCode: cfg.mockInviteCode }, center, Math.min(4, Math.max(0, count)));
    const ok = count > 0 && (await f.start());
    fleet = ok ? f : null;
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
