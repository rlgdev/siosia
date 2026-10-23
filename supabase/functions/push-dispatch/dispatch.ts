// Sends what the database queued in push_outbox to every Web Push subscription of its user.
// Pure logic with injected I/O (database, web-push), so it is unit-tested in Node
// (tests/unit/push.test.ts) and wired to Supabase + web-push in index.ts (Deno).

import { pushText, type PushKind, type PushParams } from "../_shared/push-text.ts";

export interface OutboxRow {
  id: number;
  user_id: string;
  kind: PushKind;
  ride_id: string | null;
  /** 2.0: appointment notifications carry their appointment (tag) and open Planned. */
  appointment_id?: string | null;
  /** 2.3: a chat_message row carries its room in params.room (tag and open URL) and the message's
   *  id in params.messageId (C6: a message already read is dropped); ride_id / appointment_id are
   *  set too, for the outbox's own bookkeeping. */
  params: PushParams;
  lang: string;
  tz: string;
  /** When the row was queued (ISO, as siosia_claim_push returns it) — the chat grace counts from here. */
  created_at?: string | null;
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
  /** 2.3 (C6): whether the recipient has read this message meanwhile (messages.read_at is set). */
  isMessageRead(messageId: string): Promise<boolean>;
  /** Waits before a chat message younger than CHAT_GRACE_MS is checked (default: a timer; tests inject). */
  wait?(ms: number): Promise<void>;
  /** The clock (default Date.now; tests inject). */
  now?(): number;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  dropped: number;
  /** 2.3 (C6): chat messages read before they went out — marked done, no push. */
  skipped: number;
}

/** Appointment and booking notifications open Planned (FR-125: a booking's Take it lives there in 2.0,
 *  "./" is S1; 2.1: appt_open's I can do it too, FR-162); ride ones open the app (the active ride
 *  shows). A held ride / D1 still wins on launch. 2.3: a chat message opens its room (FR-222) — the
 *  room comes from params; without one, the app. */
export const openUrl = (kind: PushKind, params?: PushParams, appointmentId?: string | null): string => {
  if (kind === "chat_message") return params?.room ? `./?chat=${params.room}` : "./";
  // 2.5 (FR-232, FR-241): the feed and the notice live on C3 of that appointment.
  if (kind === "session_update" || kind === "client_coming") return appointmentId ? `./?appointment=${appointmentId}` : "./?open=planned";
  return kind.startsWith("appt_") || kind.startsWith("booking_") ? "./?open=planned" : "./";
};

/** A message is claimed at most this many times (= runs); then it is given up. */
export const MAX_ATTEMPTS = 5;

/** 2.3 (C6): a chat message is queued the moment it is stored, while a recipient looking at the
 *  thread marks it read a moment later (siosia_chat with p_mark_read). A chat row younger than this
 *  is held for the rest of the time, then dropped if read — so the mark-read lands first and the
 *  thread in front gets no push for what it already shows (V48). */
export const CHAT_GRACE_MS = 2000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The read check must never block a push: a hiccup (or an id the database does not know) = send. */
async function isRead(deps: Deps, messageId: string): Promise<boolean> {
  try {
    return await deps.isMessageRead(messageId);
  } catch {
    return false;
  }
}

export async function dispatch(deps: Deps, limit = 100): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, failed: 0, dropped: 0, skipped: 0 };
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  for (const row of await deps.pending(limit)) {
    const params = row.params ?? {};
    if (row.kind === "chat_message") {
      // The rows come oldest first and were all claimed together, so the waits of one run add up
      // to about CHAT_GRACE_MS at most (the row stays claimed: a parallel run cannot take it).
      const queued = Date.parse(row.created_at ?? "");
      const left = Number.isFinite(queued) ? Math.min(CHAT_GRACE_MS, CHAT_GRACE_MS - (now() - queued)) : 0;
      if (left > 0) await wait(left);
      if (params.messageId && (await isRead(deps, params.messageId))) {
        await deps.markSent(row.id);
        result.skipped++;
        continue;
      }
    }
    const text = pushText(row.kind, params, row.lang, row.tz, row.appointment_id ?? row.ride_id);
    // kind and room (chat) let the service worker hand a message to the thread that is open (push-sw.js).
    const payload = JSON.stringify({
      ...text,
      url: openUrl(row.kind, params, row.appointment_id),
      kind: row.kind,
      ...(row.kind === "chat_message" && params.room ? { room: params.room } : {})
    });
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
