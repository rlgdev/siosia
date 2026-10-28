// Small shared UI pieces. Touch targets ≥ 44 px and visible focus come from theme.css (FR-072, NFR-10).

import { useEffect, useState, type ReactNode } from "react";
import { formatMoney } from "../core/fare";
import { Icon } from "./Icon";
import { NotificationsBell } from "./Notifications";
import type { RatingSummary } from "../core/types";
import { errorMessage, useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";

export function Sheet({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`sheet ${className}`}>{children}</section>;
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Money({ amount, currency }: { amount: number; currency: string }) {
  const { locale } = useI18n();
  return <span className="money">{formatMoney(amount, currency, locale)}</span>;
}

export function RatingBadge({ rating }: { rating: RatingSummary }) {
  const { t } = useI18n();
  if (rating.mean === null) return <span className="badge">{t("common.new")}</span>;
  return (
    <span className="badge" aria-label={t("common.stars", { n: rating.mean.toFixed(1) })}>
      ★ {rating.mean.toFixed(1)}
    </span>
  );
}

export function StarInput({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="stars" role="radiogroup">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={t("common.stars", { n })}
          className={n <= value ? "star on" : "star"}
          disabled={disabled}
          onClick={() => onChange(n)}
        >
          {n <= value ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}

/** Seconds remaining until `deadline` (server-clock ms), ticking. */
export function useCountdown(deadline: number | null): number {
  const store = useStore();
  const [now, setNow] = useState(() => store.serverNow());
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(store.serverNow()), 250);
    return () => clearInterval(id);
  }, [deadline, store]);
  return deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Seconds elapsed since `start` (server-clock ms), ticking every second. */
export function useElapsed(start: number | null): number {
  const store = useStore();
  const [now, setNow] = useState(() => store.serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(store.serverNow()), 1000);
    return () => clearInterval(id);
  }, [store]);
  return start === null ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function Confirm({
  open,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  danger
}: {
  open: boolean;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={message} onClick={(e) => e.stopPropagation()}>
        <p>{message}</p>
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={onCancel} autoFocus>
            {t("common.no")}
          </button>
          <button type="button" className={danger ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm}>
            {confirmLabel ?? t("common.yes")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Top bar over the map: mode title, demo badge and the profile menu. */
export function TopBar({ title, right, onBack }: { title: string; right?: ReactNode; onBack?: () => void }) {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  return (
    <header className="topbar">
      {onBack && (
        <button type="button" className="icon-btn" aria-label={t("common.back")} onClick={onBack} data-testid="back-home">
          <Icon name="back" />
        </button>
      )}
      <button type="button" className="icon-btn" aria-label={t("common.menu")} onClick={() => store.openPanel("profile")}>
        <Icon name="menu" />
      </button>
      <h1 className="topbar-title">{title}</h1>
      {app.cfg?.backend === "mock" && <span className="badge badge-demo">DEMO</span>}
      {right}
      <NotificationsBell />
    </header>
  );
}

/** A full screen of 2.0 (C1, P1, H1): back to S1, the title, the menu; the content scrolls. */
export function Page({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  const { t } = useI18n();
  const store = useStore();
  return (
    <main className="page" data-testid={testId}>
      <header className="page-head">
        <button type="button" className="icon-btn" aria-label={t("common.back")} onClick={() => store.home()} data-testid="page-back">
          <Icon name="back" />
        </button>
        <h1>{title}</h1>
        <NotificationsBell />
        <button type="button" className="icon-btn page-menu" aria-label={t("common.menu")} onClick={() => store.openPanel("profile")}>
          <Icon name="menu" />
        </button>
      </header>
      <div className="page-body">{children}</div>
    </main>
  );
}

export function Panel({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="panel" role="dialog" aria-modal="true" aria-label={title}>
      <header className="panel-head">
        <button type="button" className="icon-btn" aria-label={t("common.back")} onClick={onClose}>
          <Icon name="back" />
        </button>
        <h2>{title}</h2>
        <NotificationsBell />
      </header>
      <div className="panel-body">{children}</div>
    </div>
  );
}

export function useBusy(): [boolean, <T>(fn: () => Promise<T>) => Promise<T | undefined>, string | null, (e: string | null) => void] {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(t, e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [busy, run, error, setError];
}

export { fmtKm, fmtMin } from "../i18n/format";
