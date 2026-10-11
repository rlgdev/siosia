// Sends what the database queued in push_outbox to every Web Push subscription of its user.
// Pure logic with injected I/O (database, web-push), so it is unit-tested in Node
// (tests/unit/push.test.ts) and wired to Supabase + web-push in index.ts (Deno).

import { pushText, type PushKind, type PushParams } from "../_shared/push-text.ts";

export interface OutboxRow {
  id: number;
  user_id: string;
  kind: PushKind;
  ride_id: string | null;
  params: PushParams;
  lang: string;
  tz: string;
  attempts: number;
}

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface Deps {
  /** Claims unsent rows atomically (siosia_claim_push: each claim counts as an attempt). */
  pending(limit: number): Promise<OutboxRow[]>;
  subscriptions(userId: string): Promise<Subscription[]>;
  /** Encrypts and posts one message; throws an error with `statusCode` when the push service refuses. */
  send(sub: Subscription, payload: string): Promise<void>;
  markSent(id: number): Promise<void>;
  /** Releases the claim so a later run tries again. */
  markFailed(id: number): Promise<void>;
  dropSubscription(endpoint: string): Promise<void>;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  dropped: number;
}

/** A message is claimed at most this many times (= runs); then it is given up. */
export const MAX_ATTEMPTS = 5;

export async function dispatch(deps: Deps, limit = 100): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, failed: 0, dropped: 0 };
  for (const row of await deps.pending(limit)) {
    const text = pushText(row.kind, row.params ?? {}, row.lang, row.tz, row.ride_id);
    const payload = JSON.stringify({ ...text, url: "./" });
    const subs = await deps.subscriptions(row.user_id);
    let delivered = 0;
    let retry = false;
    for (const sub of subs) {
      try {
        await deps.send(sub, payload);
        delivered++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0;
        // 404 / 410: the subscription is gone for good (app removed, permission revoked).
        if (status === 404 || status === 410) {
          await deps.dropSubscription(sub.endpoint);
          result.dropped++;
        } else retry = true;
      }
    }
    if (delivered > 0 || subs.length === 0 || !retry || row.attempts >= MAX_ATTEMPTS) {
      await deps.markSent(row.id);
      if (delivered > 0) result.sent++;
    } else {
      await deps.markFailed(row.id);
      result.failed++;
    }
  }
  return result;
}
