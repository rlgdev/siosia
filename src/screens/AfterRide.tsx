// R4 Receipt (rider) and D4 Trip summary (driver): frozen fare next to actual totals (FR-052),
// Mark as paid / Collected flags (FR-053), one immutable 1–5 star rating each way (FR-060).

import { Icon } from "../components/Icon";
import { useState } from "react";
import { Money, Notice, Sheet, StarInput, fmtKm, fmtMin, useBusy } from "../components/ui";
import type { RideView } from "../core/types";
import { useI18n } from "../i18n";
import { useStore } from "../state/store";

export function AfterRide({ ride, onDone }: { ride: RideView; onDone: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  const api = store.api;
  const [r, setR] = useState(ride);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, run, error] = useBusy();
  const rider = r.role === "rider";
  const flagged = rider ? r.paid : r.collected;

  const reload = async () => setR(await api.getRide(r.id));

  return (
    <Sheet className="sheet-tall">
      <h2 data-testid="after-ride-title">{t(rider ? "receipt.title" : "summary.title")}</h2>
      <div className="receipt">
        <div className="kv big">
          <span>{t("receipt.fare")}</span>
          <strong data-testid="receipt-fare">
            <Money amount={r.fare} currency={r.currency} />
          </strong>
        </div>
        <p className="muted small">
          {t("receipt.fixed")}
          {r.fareIsEstimate && ` · ${t("common.estimate")}`}
        </p>
        <div className="kv">
          <span>{t("receipt.distance")}</span>
          <span>
            {t("receipt.actual", { v: t("common.km", { n: fmtKm(r.actualKm) }) })} · {t("receipt.est", { v: t("common.km", { n: fmtKm(r.estKm) }) })}
          </span>
        </div>
        <div className="kv">
          <span>{t("receipt.duration")}</span>
          <span>
            {t("receipt.actual", { v: t("common.min", { n: fmtMin(r.actualMin) }) })} · {t("receipt.est", { v: t("common.min", { n: fmtMin(r.estMin) }) })}
          </span>
        </div>
        <div className="kv">
          <span>{t("receipt.from")}</span>
          <span>{r.pickup.label}</span>
        </div>
        <div className="kv">
          <span>{t("receipt.to")}</span>
          <span>{r.dropoff.label}</span>
        </div>
      </div>

      {rider && !r.paid && <p className="hint">{t("receipt.payHint")}</p>}
      {flagged ? (
        <Notice kind="ok">
          <Icon name="check" className="ico-inline" /> {t(rider ? "receipt.paid" : "summary.collected")}
        </Notice>
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-block"
          disabled={busy}
          data-testid="mark-paid"
          onClick={() => void run(async () => (rider ? await api.markPaid(r.id) : await api.markCollected(r.id), await reload()))}
        >
          {t(rider ? "receipt.markPaid" : "summary.markCollected")}
        </button>
      )}

      {r.myRating !== null ? (
        <Notice kind="ok">{t("receipt.rated")}</Notice>
      ) : (
        <div className="stack">
          <h3>{t(rider ? "receipt.rateDriver" : "receipt.rateRider")}</h3>
          <StarInput value={stars} onChange={setStars} disabled={busy} />
          <label className="field">
            <span>{t("receipt.comment")}</span>
            <input value={comment} maxLength={140} onChange={(e) => setComment(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-block"
            disabled={busy || stars < 1}
            data-testid="send-rating"
            onClick={() => void run(async () => (await api.rate(r.id, stars, comment), await reload()))}
          >
            {t("receipt.sendRating")}
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="button" className="btn btn-primary btn-block" onClick={onDone} data-testid="after-ride-done">
        {t("common.done")}
      </button>
    </Sheet>
  );
}
