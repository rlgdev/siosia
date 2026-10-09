// Durable state of the mock backend: one JSON document in localStorage, shared by all tabs of the
// browser. Every "server call" runs under a Web Lock so two tabs can never interleave — this is
// what makes the mock's atomic Accept claim truly atomic across tabs.

import { emptyDb, type DbState } from "../../core/engine";
import { ServerError } from "../../core/types";

const KEY = "siosia.mock.db.v1";
let memory: DbState | null = null; // fallback when localStorage is unavailable

function load(): DbState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DbState;
      if (parsed && parsed.version === 1) return parsed;
    }
    return emptyDb();
  } catch {
    return memory ?? (memory = emptyDb());
  }
}

function save(db: DbState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    memory = db;
  }
}

/**
 * Run `fn` against the database atomically. The state is saved when `fn` returns or throws a
 * ServerError (server functions may legitimately record e.g. a timed-out offer before refusing),
 * mirroring the SQL functions, which return error codes instead of rolling back.
 */
export async function withDb<T>(fn: (db: DbState) => T): Promise<T> {
  const run = (): T => {
    const db = load();
    try {
      const out = fn(db);
      save(db);
      return out;
    } catch (e) {
      if (e instanceof ServerError) save(db);
      throw e;
    }
  };
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) return locks.request(KEY, async () => run()) as Promise<T>;
  return run();
}

export function resetMockDb(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    memory = null;
  }
}
