// Registry of everything currently sending this device's position. The S4 banner renders from it
// (FR-041: visible on every screen while sending, with a one-tap stop).

import { useSyncExternalStore } from "react";
import type { Role } from "../core/types";

export interface SharingEntry {
  role: Role;
  stop: () => void;
}

class SharingRegistry {
  private entries = new Map<string, SharingEntry>();
  private snapshot: SharingEntry[] = [];
  private readonly listeners = new Set<() => void>();

  set(key: string, entry: SharingEntry | null): void {
    if (entry) this.entries.set(key, entry);
    else if (!this.entries.delete(key)) return;
    this.snapshot = [...this.entries.values()];
    this.listeners.forEach((l) => l());
  }

  get = (): SharingEntry[] => this.snapshot;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export const sharing = new SharingRegistry();

export const useSharing = () => useSyncExternalStore(sharing.subscribe, sharing.get, sharing.get);
