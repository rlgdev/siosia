// 2.3 chat (FR-220–225): the thread of one room — a ride with its driver (ride:<id>) or an
// accepted appointment (appt:<id>) — as a panel: the other party on top, bubbles (mine on the
// right, theirs on the left) with the time and a read mark on mine once read, messages arriving
// live while open, and the input while the room is open (until 24 h after the end, FR-223).
// Opening the thread marks it read (FR-224); the unread badges follow. The backend notifies and
// pushes; nothing is sent from here but the message itself.

import { Icon } from "./Icon";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatRoom, ChatThread } from "../core/types";
import { ServerError } from "../core/types";
import { useI18n } from "../i18n";
import { chatRoomOf, useApp, useListsKey, useStore } from "../state/store";
import { Avatar, Initial } from "./ProfileIcon";
import { Panel, RatingBadge, useBusy } from "./ui";
import { sameDay, timeText, whenText } from "./when";

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
/**
 * While the thread is in front, chat(room, true) goes out this often: it marks new messages read
 * (FR-224) and keeps the server's presence of this viewer fresh, so the other party's message is
 * not also pushed to a phone that shows the thread (FR-222, C8/C10). Hidden, a plain reload.
 */
export const CHAT_HEARTBEAT_MS = 20_000;

/** The chat panel (store panel "chat", panelArg = the room). */
export function ChatPanel() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const room = chatRoomOf(app.panelArg);
  return (
    <Panel title={t("chat.title")} onClose={() => store.closePanel()}>
      {room ? (
        <ChatSheet room={room} />
      ) : (
        <p className="form-error" data-testid="chat-gone">
          {t("err.not_found")}
        </p>
      )}
    </Panel>
  );
}

/** Appends a message once (the one I sent comes back from the call and over the bus). */
const append = (th: ChatThread | null, m: ChatMessage): ChatThread | null => (th && !th.messages.some((x) => x.id === m.id) ? { ...th, messages: [...th.messages, m] } : th);

export function ChatSheet({ room }: { room: ChatRoom }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [busy, run, error, setError] = useBusy();
  const end = useRef<HTMLLIElement>(null);

  // Marks read only while the thread is in front (FR-224); `refresh` then renews my state so the
  // badges drop — once, not on every reload, or a refresh would reload and reload again.
  const load = useCallback(
    async (markRead: boolean, refresh = false) => {
      try {
        const th = await store.api.chat(room, markRead);
        setThread(th);
        setFailed(false);
        if (refresh) store.requestRefresh(0);
      } catch {
        setFailed(true);
      }
    },
    [store, room]
  );
  const first = useRef(true);
  // Reloads on a change of my state (read receipts, a message that came while the app was away).
  const listsKey = useListsKey();
  useEffect(() => {
    const mark = visible();
    void load(mark, mark && first.current);
    first.current = false;
  }, [load, listsKey]);
  // The heartbeat: read + presence while visible, no refresh of my state (that happened on open and
  // happens once more when the app comes back in front — never a reload loop).
  useEffect(() => {
    const id = setInterval(() => void load(visible()), CHAT_HEARTBEAT_MS);
    const seen = () => {
      if (visible()) void load(true, true);
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [load]);
  // Live messages of this room, both directions, while the thread is open.
  useEffect(() => {
    if (typeof store.api.onMessage !== "function") return;
    return store.api.onMessage(room, (m) => {
      setThread((th) => append(th, m));
      // Theirs, read at once while in front: mark it so and renew the badges.
      if (!m.mine && visible()) void load(true, true);
    });
  }, [store, room, load]);
  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);

  const send = () => {
    const body = text.trim();
    if (!body || !thread?.open) return;
    void run(async () => {
      try {
        const m = await store.api.sendMessage(room, body);
        setText("");
        setThread((th) => append(th, m));
      } catch (e) {
        if (e instanceof ServerError && e.code === "too_many") return setError(t("chat.tooMany"));
        if (e instanceof ServerError && e.code === "illegal_transition") {
          // The room closed meanwhile (24 h after the end): show it read-only.
          await load(false);
          return setError(t("chat.closed"));
        }
        throw e;
      }
    });
  };

  const now = store.serverNow();
  const when = (ms: number) => (sameDay(ms, now) ? timeText(ms, locale) : whenText(ms, now, locale, t));

  return (
    <div className="chat" data-testid="chat-sheet">
      {thread && (
        <div className="chat-head row" data-testid="chat-other">
          <Avatar photo={thread.other.photo} icon={thread.other.icon} paint={thread.other.paint} fallback={<Initial name={thread.other.nickname} />} />
          <strong>{thread.other.nickname}</strong>
          <RatingBadge rating={thread.other.rating} />
        </div>
      )}
      {failed && !thread ? (
        <div className="row spread">
          <p className="form-error">{t("chat.error")}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void load(visible())}>
            {t("common.retry")}
          </button>
        </div>
      ) : !thread ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <>
          <ol className="chat-thread" data-testid="chat-thread" aria-live="polite">
            {thread.messages.length === 0 && (
              <li className="muted small chat-empty" data-testid="chat-empty">
                {t("chat.empty")}
              </li>
            )}
            {thread.messages.map((m) => (
              <li key={m.id} className={`chat-msg ${m.mine ? "mine" : "theirs"}`} data-testid={m.mine ? "chat-msg-mine" : "chat-msg-theirs"}>
                {/* Who wrote it, for screen readers: the sides are told apart by position only (C19). */}
                <span className="sr-only" data-testid="chat-sender">
                  {m.mine ? t("chat.you") : thread.other.nickname}:{" "}
                </span>
                <span className="chat-bubble">{m.text}</span>
                <span className="chat-meta muted">
                  {when(m.sentAt)}
                  {m.mine && m.readAt !== null && (
                    <span className="chat-read" data-testid="chat-read">
                      {" "}
                      · ✓✓ {t("chat.read")}
                    </span>
                  )}
                </span>
              </li>
            ))}
            <li ref={end} className="chat-end" aria-hidden="true" />
          </ol>
          {!thread.open && (
            <p className="muted small" data-testid="chat-closed">
              {t("chat.closed")}
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <form
            className="chat-compose row"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              value={text}
              maxLength={500}
              placeholder={t("chat.placeholder")}
              aria-label={t("chat.placeholder")}
              disabled={!thread.open || busy}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
              data-testid="chat-input"
            />
            <button type="submit" className="btn btn-primary" disabled={!thread.open || busy || !text.trim()} data-testid="chat-send">
              {t("chat.send")}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

/** The 💬 that opens a room, with the unread count (R3, D3, C3, the P1 item, the booking cards). */
export function ChatButton({ room, unread, small }: { room: ChatRoom; unread?: number | null; small?: boolean }) {
  const { t } = useI18n();
  const store = useStore();
  const n = unread ?? 0;
  return (
    <button
      type="button"
      className={`btn btn-secondary chat-btn${small ? " btn-small" : ""}`}
      aria-label={n ? `${t("chat.open")} · ${t("chat.unread", { n })}` : t("chat.open")}
      onClick={() => store.openPanel("chat", room)}
      data-testid="chat-open"
    >
      <Icon name="chat" className="ico-inline" /> {t("chat.open")}
      {n > 0 && (
        <span className="badge badge-accent" data-testid="chat-unread">
          {n}
        </span>
      )}
    </button>
  );
}
