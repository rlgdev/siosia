// The notifications bell (2.9, FR-311–313): on every screen's header, with the unread count. A tap
// drops down Siosia's recent notifications (newest first, the last 60 days) — worded as their push
// was (push-text), the unread ones marked — and opening it marks them read. Tapping one goes where
// its push would (pushUrl): the appointment, the family, the week's report, Planned, History…
// The list hangs from the screen, not from the bell (a bell left of the menu button pushed it off
// the left edge of a small iPhone): 12 px from both sides at most 380 px wide, just under the bell.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  pushText,
  type PushKind,
} from "../../supabase/functions/_shared/push-text";
import type { NotificationItem } from "../core/types";
import { useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";
import { Icon, type IconName } from "./Icon";

/** The glyph of a notification, by what it is about. */
export function notificationIcon(kind: PushKind): IconName {
  if (kind === "appt_tip" || kind === "ride_tip") return "sparkles";
  if (kind.startsWith("family_") || kind.startsWith("contract_"))
    return "users";
  if (kind === "weekly_report" || kind === "appt_summary") return "history";
  if (
    kind.startsWith("appt_") ||
    kind === "session_update" ||
    kind === "client_coming"
  )
    return "calendar";
  return "car";
}

/** "now", "5 min ago", "yesterday", "3 days ago" — in the app's language. */
export function agoText(at: number, now: number, locale: string): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (s < 60) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86_400) return rtf.format(-Math.floor(s / 3600), "hour");
  return rtf.format(-Math.floor(s / 86_400), "day");
}

export function NotificationsBell() {
  const { t, lang, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const unread = app.my?.unreadNotifications ?? 0;
  const hasUnread = unread > 0;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const drop = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);

  // Load on open (and again when something new arrives while it is open); opening marks all read.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setFailed(false);
    store.api
      .notifications()
      .then((r) => {
        if (!live) return;
        setItems(r.items);
        if (r.unread > 0)
          void store.api.readNotifications().then(
            () => store.requestRefresh(),
            () => {},
          );
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [open, hasUnread, store]);

  // A tap outside or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !drop.current?.contains(t))
        setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!app.profile) return null;
  const tz = app.deployment?.timezone ?? "Europe/Warsaw";
  const now = store.serverNow();
  return (
    <div className="bell" ref={box}>
      <button
        type="button"
        className="icon-btn bell-btn"
        aria-label={
          unread ? t("notif.titleUnread", { n: unread }) : t("notif.title")
        }
        aria-expanded={open}
        onClick={() => {
          setTop(
            Math.round((box.current?.getBoundingClientRect().bottom ?? 56) + 8),
          );
          setOpen((o) => !o);
        }}
        data-testid="bell"
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="bell-badge" data-testid="bell-badge">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            className="bell-drop"
            ref={drop}
            style={{ top }}
            role="dialog"
            aria-label={t("notif.title")}
            data-testid="bell-list"
          >
            <h2 className="bell-head">{t("notif.title")}</h2>
            {failed ? (
              <p className="muted bell-empty">{t("notif.failed")}</p>
            ) : items === null ? (
              <p className="muted bell-empty">{t("common.loading")}</p>
            ) : items.length === 0 ? (
              <p className="muted bell-empty" data-testid="bell-empty">
                {t("notif.empty")}
              </p>
            ) : (
              <ul className="bell-items">
                {items.map((n) => {
                  const text = pushText(
                    n.kind,
                    n.params,
                    lang,
                    tz,
                    n.appointmentId ?? n.rideId,
                  );
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        className={`bell-item${n.read ? "" : " bell-item-new"}`}
                        onClick={() => {
                          setOpen(false);
                          store.openNotification(n);
                        }}
                        data-testid="bell-item"
                      >
                        <span className="bell-ico" aria-hidden="true">
                          <Icon name={notificationIcon(n.kind)} size={18} />
                        </span>
                        <span className="bell-text">
                          <strong>{text.title}</strong>
                          {text.body && <span>{text.body}</span>}
                          <small className="muted">
                            {agoText(n.createdAt, now, locale)}
                          </small>
                        </span>
                        {!n.read && (
                          <span
                            className="bell-dot"
                            aria-label={t("notif.new")}
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
