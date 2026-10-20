// App configuration (FR-076, D-06): build-time env vars, then an optional runtime `config.json`
// next to index.html, then URL overrides. Only publishable values live here — never a secret.

import { DEFAULT_CONFIG } from "./core/defaults";
import type { DeploymentConfig, LatLng } from "./core/types";

export interface MapEndpoints {
  tileUrl: string;
  tileAttribution: string;
  tileMaxZoom: number;
  routingUrl: string;
  geocodeUrl: string;
}

export interface AppConfig {
  backend: "mock" | "supabase";
  supabaseUrl: string;
  supabaseKey: string;
  operatorContact: string;
  /** Whether the "Try demo mode" escape hatch is offered when the backend is down. */
  demoAllowed: boolean;
  /** Invite code for the MOCK backend only (null = demo needs no code). */
  mockInviteCode: string | null;
  /** Map centre when GPS is unavailable. */
  fallbackCenter: LatLng;
  map: MapEndpoints;
  /** Deployment config for the mock backend (Supabase reads its own from the database). */
  deployment: DeploymentConfig;
  /** Web Push public key (VAPID). Empty = notifications not set up. Public by design. */
  vapidPublicKey: string;
}

type RuntimeFile = Partial<Omit<AppConfig, "map" | "deployment">> & {
  map?: Partial<MapEndpoints>;
  deployment?: Partial<DeploymentConfig>;
};

const env = import.meta.env;

export const DEFAULT_MAP: MapEndpoints = {
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Routing <a href="https://project-osrm.org/">OSRM</a> · Search <a href="https://nominatim.org/">Nominatim</a>',
  tileMaxZoom: 19,
  routingUrl: "https://router.project-osrm.org",
  geocodeUrl: "https://nominatim.openstreetmap.org"
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function buildConfig(file: RuntimeFile | null, search: string): AppConfig {
  const params = new URLSearchParams(search);
  const supabaseUrl = str(file?.supabaseUrl) || str(env.VITE_SUPABASE_URL);
  const supabaseKey = str(file?.supabaseKey) || str(env.VITE_SUPABASE_PUBLISHABLE_KEY);
  const forced = str(params.get("backend")) || str(file?.backend) || str(env.VITE_BACKEND);
  let backend: AppConfig["backend"] = supabaseUrl && supabaseKey ? "supabase" : "mock";
  if (forced === "mock") backend = "mock";
  if (forced === "supabase" && supabaseUrl && supabaseKey) backend = "supabase";
  const dep = file?.deployment ?? {};
  return {
    backend,
    supabaseUrl,
    supabaseKey,
    operatorContact: str(file?.operatorContact) || str(env.VITE_OPERATOR_CONTACT),
    demoAllowed: file?.demoAllowed ?? true,
    mockInviteCode: file?.mockInviteCode ?? null,
    fallbackCenter: file?.fallbackCenter ?? { lat: 52.2297, lng: 21.0122 },
    map: { ...DEFAULT_MAP, ...(file?.map ?? {}) },
    vapidPublicKey: str(file?.vapidPublicKey) || str(env.VITE_VAPID_PUBLIC_KEY),
    deployment: {
      ...DEFAULT_CONFIG,
      ...dep,
      tariff: { ...DEFAULT_CONFIG.tariff, ...(dep.tariff ?? {}) },
      timers: { ...DEFAULT_CONFIG.timers, ...(dep.timers ?? {}) },
      booking: { ...DEFAULT_CONFIG.booking, ...(dep.booking ?? {}) },
      appointment: { ...DEFAULT_CONFIG.appointment, ...(dep.appointment ?? {}) },
      services: dep.services ?? DEFAULT_CONFIG.services,
      calendarUrl: dep.calendarUrl ?? null,
      operatorContact: str(file?.operatorContact) || str(env.VITE_OPERATOR_CONTACT)
    }
  };
}

export async function loadConfig(): Promise<AppConfig> {
  let file: RuntimeFile | null = null;
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) file = (await res.json()) as RuntimeFile;
  } catch {
    /* optional file */
  }
  return buildConfig(file, typeof location !== "undefined" ? location.search : "");
}
