// R5 Ride history / D5 Earnings & history (FR-027, FR-062, FR-063).

import { useEffect, useState } from "react";
import { Money, Panel } from "../components/ui";
import type { Earnings, RideView } from "../core/types";
import { useI18n } from "../i18n";
import { useStore } from "../state/store";

export function HistoryPanel({ earnings }: { earnings: boolean }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const [rides, setRides] = useState<RideView[] | null>(null);
  const [totals, setTotals] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    store.api.history().then(setRides, () => setFailed(true));
    if (earnings) store.api.earnings().then(setTotals, () => setFailed(true));
  }, [store, earnings]);

  const fmtDate = (ms: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms);

  return (
    <Panel title={t(earnings ? "earnings.title" : "history.title")} onClose={() => store.closePanel()}>
      {totals && (
        <div className="totals">
          <div className="total-card">
            <small>{t("earnings.today")}</small>
            <strong data-testid="earnings-today">
              <Money amount={totals.todayTotal} currency={totals.currency} />
            </strong>
            <small>{t("earnings.trips", { n: totals.todayCount })}</small>
          </div>
          <div className="total-card">
            <small>{t("earnings.month")}</small>
            <strong>
              <Money amount={totals.monthTotal} currency={totals.currency} />
            </strong>
            <small>{t("earnings.trips", { n: totals.monthCount })}</small>
          </div>
        </div>
      )}
      {failed && <p className="form-error">{t("err.unavailable")}</p>}
      {rides === null && !failed && <p>{t("common.loading")}</p>}
      {rides && rides.length === 0 && <p className="muted">{t("history.empty")}</p>}
      {rides && rides.length > 0 && (
        <ul className="history" data-testid="history-list">
          {rides.map((r) => (
            <li key={r.id} className="history-item">
              <div className="row spread">
                <small className="muted">{fmtDate(r.requestedAt)}</small>
                <span className={`status status-${r.status}`}>{t(`status.${r.status}`)}</span>
              </div>
              <div className="trip-line">
                <span>{r.pickup.label}</span>
                <span aria-hidden="true">→</span>
                <span>{r.dropoff.label}</span>
              </div>
              <div className="row spread">
                <small className="muted">{r.role === "driver" ? r.rider.nickname : r.driver?.nickname ?? ""}</small>
                <Money amount={r.fare} currency={r.currency} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
