import type { AppConfig } from "../config";
import type { Backend } from "./types";

/** Picks the backend from configuration. supabase-js is loaded only when it is actually used. */
export async function createBackend(cfg: AppConfig): Promise<Backend> {
  if (cfg.backend === "supabase") {
    const { SupabaseBackend } = await import("./supabase/index");
    return new SupabaseBackend(cfg.supabaseUrl, cfg.supabaseKey);
  }
  const { MockBackend, tabUserId } = await import("./mock/index");
  return new MockBackend(tabUserId(), { ...cfg.deployment, inviteCode: cfg.mockInviteCode });
}

export type { Backend } from "./types";
