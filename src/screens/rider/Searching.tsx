// R2 Searching: elapsed time, drivers notified, Cancel; Try again after expiry (FR-014).

import { Money, Sheet, mmss, useElapsed } from "../../components/ui";
import type { RideView } from "../../core/types";
import { useI18n } from "../../i18n";
import { useStore } from "../../state/store";

interface Props {
  ride: RideView;
  /** Server-clock time the request expires if nobody accepts (RideView.expiresAt). */
  expiresAt: number;
  expired: boolean;
  nearbyCount: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onTryAgain: () => void;
  onBack: () => void;
}

export function Searching({ ride, expiresAt, expired, nearbyCount, busy, error, onCancel, onTryAgain, onBack }: Props) {
  const { t, locale } = useI18n();
  const store = useStore();
  // Local wall-clock time of the server-side expiry (server clock → this device's clock).
  const until = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(expiresAt - (store.serverNow() - Date.now()));
  const elapsed = useElapsed(expired ? null : ride.dispatchStartedAt);
  if (expired) {
    return (
      <Sheet>
        <h2>{t("search.expired")}</h2>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={onBack}>
            {t("common.back")}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onTryAgain} data-testid="try-again">
            {t("search.tryAgain")}
          </button>
        </div>
      </Sheet>
    );
  }
  // §6 rule 1: every eligible driver pulls the request within one 4 s heartbeat, so "nobody
  // notified" soon means nobody eligible — even if idle cars show nearby (e.g. one that cancelled).
  const noDrivers = ride.notifiedCount === 0 && elapsed >= 3 && (nearbyCount === 0 || elapsed >= 10);
  return (
    <Sheet>
      <div className="searching">
        <span className="spinner" aria-hidden="true" />
        <div>
          <h2 data-testid="searching-title">{t(ride.redispatchCount > 0 ? "search.again" : "search.title")}</h2>
          <p className="muted">
            {t("search.elapsed", { t: mmss(elapsed) })} · {t("search.notified", { n: ride.notifiedCount })}
          </p>
        </div>
      </div>
      {ride.redispatchCount > 0 && ride.cancelReason !== "driver_lost" && <p className="hint">{t("search.driverCancelled")}</p>}
      <p className="muted small" data-testid="search-until">
        {t("search.until", { time: until })}
      </p>
      {noDrivers && <p className="hint">{t("search.noDrivers")}</p>}
      <div className="trip-line">
        <span>{ride.pickup.label}</span>
        <span aria-hidden="true">→</span>
        <span>{ride.dropoff.label}</span>
      </div>
      <p>
        <Money amount={ride.fare} currency={ride.currency} /> {ride.fareIsEstimate && <span className="badge badge-warn">{t("common.estimate")}</span>}
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={onCancel} data-testid="cancel-request">
        {t("common.cancel")}
      </button>
    </Sheet>
  );
}
