// In-browser realtime for the mock backend: broadcast + presence across the tabs of one browser
// (BroadcastChannel) and between the clients living in the same tab (the user + robot drivers).
// It mirrors Supabase Realtime semantics closely enough for the ride loop: a sender does not hear
// its own broadcasts, presence entries vanish when their tab dies (TTL), nothing is persisted.

type Listener = (event: string, payload: unknown) => void;
type PresenceListener = (entries: Record<string, unknown>) => void;

interface WireBroadcast {
  kind: "bc";
  topic: string;
  event: string;
  payload: unknown;
  from: string;
}
interface WirePresence {
  kind: "pres";
  topic: string;
  key: string;
  meta: unknown | null;
  from: string;
}
type Wire = WireBroadcast | WirePresence;

const PRESENCE_REFRESH_MS = 2000;
const PRESENCE_TTL_MS = 6000;

export class MockBus {
  private readonly bc: BroadcastChannel | null;
  private readonly listeners = new Map<string, Set<{ client: string; cb: Listener }>>();
  private readonly presListeners = new Map<string, Set<PresenceListener>>();
  /** topic → key → entry */
  private readonly presence = new Map<string, Map<string, { meta: unknown; expires: number; client: string }>>();
  /** Entries tracked by clients in THIS tab, re-announced periodically. */
  private readonly localTracks = new Map<string, { topic: string; key: string; meta: unknown; client: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(name = "siosia-mock-bus") {
    this.bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(name) : null;
    this.bc?.addEventListener("message", (e: MessageEvent<Wire>) => this.receive(e.data));
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        for (const t of this.localTracks.values()) this.post({ kind: "pres", topic: t.topic, key: t.key, meta: null, from: t.client });
      });
    }
  }

  publish(topic: string, event: string, payload: unknown, from: string): void {
    this.deliver(topic, event, payload, from);
    this.post({ kind: "bc", topic, event, payload, from });
  }

  subscribe(topic: string, client: string, cb: Listener): () => void {
    const set = this.listeners.get(topic) ?? new Set();
    const entry = { client, cb };
    set.add(entry);
    this.listeners.set(topic, set);
    return () => set.delete(entry);
  }

  track(topic: string, key: string, meta: unknown, client: string): void {
    this.localTracks.set(`${topic}|${key}`, { topic, key, meta, client });
    this.setEntry(topic, key, meta, client);
    this.post({ kind: "pres", topic, key, meta, from: client });
    this.ensureTimer();
  }

  untrack(topic: string, key: string, client: string): void {
    this.localTracks.delete(`${topic}|${key}`);
    this.setEntry(topic, key, null, client);
    this.post({ kind: "pres", topic, key, meta: null, from: client });
  }

  presenceState(topic: string): Record<string, unknown> {
    const now = Date.now();
    const out: Record<string, unknown> = {};
    for (const [key, e] of this.presence.get(topic) ?? []) if (e.expires > now) out[key] = e.meta;
    return out;
  }

  onPresence(topic: string, cb: PresenceListener): () => void {
    const set = this.presListeners.get(topic) ?? new Set();
    set.add(cb);
    this.presListeners.set(topic, set);
    this.ensureTimer();
    queueMicrotask(() => cb(this.presenceState(topic)));
    return () => set.delete(cb);
  }

  private post(msg: Wire): void {
    try {
      this.bc?.postMessage(msg);
    } catch {
      /* tab closing */
    }
  }

  private receive(msg: Wire): void {
    if (msg.kind === "bc") this.deliver(msg.topic, msg.event, msg.payload, msg.from);
    else this.setEntry(msg.topic, msg.key, msg.meta, msg.from);
  }

  private deliver(topic: string, event: string, payload: unknown, from: string): void {
    const set = this.listeners.get(topic);
    if (!set) return;
    for (const { client, cb } of [...set]) {
      if (client === from) continue; // like Supabase broadcast self: false
      setTimeout(() => cb(event, structuredCloneSafe(payload)), 0);
    }
  }

  private setEntry(topic: string, key: string, meta: unknown | null, client: string): void {
    const map = this.presence.get(topic) ?? new Map();
    this.presence.set(topic, map);
    const had = map.has(key);
    if (meta === null) {
      if (!had) return;
      map.delete(key);
    } else {
      map.set(key, { meta, expires: Date.now() + PRESENCE_TTL_MS, client });
    }
    this.emitPresence(topic);
  }

  private emitPresence(topic: string): void {
    const state = this.presenceState(topic);
    for (const cb of this.presListeners.get(topic) ?? []) cb(state);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const t of this.localTracks.values()) {
        this.setEntry(t.topic, t.key, t.meta, t.client);
        this.post({ kind: "pres", topic: t.topic, key: t.key, meta: t.meta, from: t.client });
      }
      // Expire entries from tabs that died without saying goodbye.
      const now = Date.now();
      for (const [topic, map] of this.presence) {
        let changed = false;
        for (const [key, e] of map) {
          if (e.expires <= now) {
            map.delete(key);
            changed = true;
          }
        }
        if (changed) this.emitPresence(topic);
      }
    }, PRESENCE_REFRESH_MS);
  }
}

function structuredCloneSafe<T>(v: T): T {
  try {
    return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

let shared: MockBus | null = null;
export function getBus(): MockBus {
  if (!shared) shared = new MockBus();
  return shared;
}
