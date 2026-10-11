import type { AppConfig } from "../config";
import type { Backend } from "./types";

/** Picks the backend from configuration. supabase-js is loaded only when it is actually used. */
export async function createBackend(cfg: AppConfig): Promise<Backend> {
  if (cfg.backend === "supabase") {
    const { SupabaseBackend } = await import("./supabase/index");
    return new SupabaseBackend(cfg.supabaseUrl, cfg.supabaseKey);
  }
  const [{ MockBackend, tabUserId }, { DEMO_MASTERS }] = await Promise.all([import("./mock/index"), import("../core/engine")]);
  return new MockBackend(tabUserId(), { ...cfg.deployment, inviteCode: cfg.mockInviteCode, masters: DEMO_MASTERS });
}

export type { Backend } from "./types";
