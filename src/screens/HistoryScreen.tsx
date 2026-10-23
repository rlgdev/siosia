// H1 History (FR-133, FR-106, FR-134): finished appointments and rides in both roles, newest
// first, with date, type, the other party, status and price or fare; drivers see today / this
// month earnings on top (v1 FR-027). A done appointment not yet rated offers Rate (C3) for 24 h.
// Replaces the v1 Ride history and Earnings & history panels; an online driver, who keeps D1,
// opens the same list as a panel.

import { Icon } from "../components/Icon";
import { useCallback, useEffect, useState } from "react";
import { otherName, partyText, statusChip } from "../components/apptWords";
import { Money, Page, Panel } from "../components/ui";
import type { AppointmentView, Earnings, HistoryItem, RideView } from "../core/types";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { useApp, useListsKey, useStore } from "../state/store";
import { Route } from "./Bookings";
import { EntryIcon, localText } from "./Catalog";

const RATE_WINDOW_MS = 24 * 3600_000;

export function HistoryScreen() {
  const { t } = useI18n();
  return (
    <Page title={t("start.history")} testId="history">
      <HistoryList />
    </Page>
  );
}

/** D1's Earnings & history link: H1 as a panel, so an online driver stays online. */
export function HistoryPanel() {
  const { t } = useI18n();
  const store = useStore();
  return (
    <Panel title={t("start.history")} onClose={() => store.closePanel()}>
      <HistoryList />
    </Panel>
  );
}

function HistoryList() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const role = app.profile?.masterRole ?? null;
  const isDriver = role !== "rider" && !!(app.vehicle || app.profile?.masterVehicle);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [totals, setTotals] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    void store.api.timeline().then(
      (list) => (setItems(list), setFailed(false)),
      () => setFailed(true)
    );
    if (isDriver) void store.api.earnings().then(setTotals, () => {});
  }, [store, isDriver]);
  // Not on every MyState: an online driver's heartbeat brings one every 4 s.
  const listsKey = useListsKey();
  useEffect(() => {
    load();
  }, [load, listsKey]);
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="stack">
      {totals && (
        <div className="totals" data-testid="earnings">
          <div className="total-card">
            <small>{t("earnings.today")}</small>
            <strong data-testid="earnings-today">
              <Money amount={totals.todayTotal} currency={totals.currency} />
            </strong>
            <small>{t("earnings.trips", { n: totals.todayCount })}</small>
          </div>
          <div className="total-card">
            <small>{t("earnings.month")}</small>
            <strong data-testid="earnings-month">
              <Money amount={totals.monthTotal} currency={totals.currency} />
            </strong>
            <small>{t("earnings.trips", { n: totals.monthCount })}</small>
          </div>
        </div>
      )}
      {failed && !items ? (
        <div className="stack">
          <p className="form-error">{t("history.error")}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>
            {t("common.retry")}
          </button>
        </div>
      ) : !items ? (
        <p className="muted">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="muted" data-testid="history-empty">
          {t("history.empty")}
        </p>
      ) : (
        <ul className="history" data-testid="history-list">
          {items.map((i) => (i.kind === "appointment" ? <AppointmentRow key={`a${i.appointment.id}`} a={i.appointment} /> : <RideRow key={`r${i.ride.id}`} r={i.ride} />))}
        </ul>
      )}
    </div>
  );
}

function useDate(): (ms: number) => string {
  const { locale } = useI18n();
  return (ms) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

function AppointmentRow({ a }: { a: AppointmentView }) {
  const { t, lang } = useI18n();
  const store = useStore();
  const date = useDate();
  const canRate = a.status === "done" && a.myRating === null && !!a.provider && store.serverNow() < (a.endedAt ?? a.endsAt) + RATE_WINDOW_MS;
  const status = a.status === "accepted" || a.status === "requested" ? "done" : a.status;
  // An open request that nobody took reads so (V37); the other endings keep their words.
  const word = status === "expired" ? statusChip(a, lang, t).text : t(`appt.status.${status}` as MessageKey);
  return (
    <li className="history-item" data-testid="history-appointment">
      <button type="button" className="planned-open" onClick={() => store.openPanel("appointment", a.id)}>
        <span className="row spread">
          <small className="muted">{date(a.startsAt)}</small>
          <span className={`status status-${status === "done" ? "completed" : status}`}>{word}</span>
        </span>
        <strong>
          <EntryIcon icon={a.service?.icon ?? "📅"} /> {localText(a.service?.name, lang) || a.serviceId}
        </strong>
        <span className="row spread">
          <small className="muted">{partyText(a, t)}</small>
          {a.price !== null && <Money amount={a.price} currency={a.currency} />}
        </span>
        {a.myRating !== null && <small className="muted">{t("history.rated", { n: a.myRating })}</small>}
      </button>
      {canRate && (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => store.openPanel("appointment", a.id)} data-testid="history-rate">
          {t("history.rate", { name: otherName(a, t) })}
        </button>
      )}
    </li>
  );
}

function RideRow({ r }: { r: RideView }) {
  const { t } = useI18n();
  const date = useDate();
  return (
    <li className="history-item" data-testid="history-ride">
      <div className="row spread">
        <small className="muted">{date(r.scheduledFor ?? r.requestedAt)}</small>
        <span className={`status status-${r.status}`}>{t(`status.${r.status}` as MessageKey)}</span>
      </div>
      <strong>
        <Icon name="car" className="ico-inline" /> {t(r.role === "driver" ? "history.drove" : "history.rode")}
      </strong>
      <Route r={r} />
      <div className="row spread">
        <small className="muted">{r.role === "driver" ? r.rider.nickname : (r.driver?.nickname ?? "")}</small>
        <Money amount={r.fare} currency={r.currency} />
      </div>
    </li>
  );
}
