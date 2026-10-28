// A tip at the end of a service (2.9, FR-314, FR-315): the client side after a done appointment
// (C3), the rider on the receipt (R4). Three suggested amounts or another one, once; afterwards the
// thank-you. Siosia takes no money: the tip is paid the way the rest is, and counted in the reports.

import { useState } from "react";
import { formatMoney } from "../core/fare";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { Notice, useBusy } from "./ui";

export function TipBox({
  currency,
  max,
  suggested,
  tip,
  onTip
}: {
  currency: string;
  /** 1000 after an appointment, 500 after a ride (V74). */
  max: number;
  suggested: number[];
  /** The tip already given, if any. */
  tip: number | null;
  onTip: (amount: number) => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const [pick, setPick] = useState<number | "other" | null>(null);
  const [other, setOther] = useState("");
  const [busy, run, error] = useBusy();
  const fmt = (n: number) => formatMoney(n, currency, locale);
  if (tip !== null)
    return (
      <Notice kind="ok">
        <span data-testid="tip-given">
          <Icon name="sparkles" className="ico-inline" /> {t("tip.given", { amount: fmt(tip) })}
        </span>
      </Notice>
    );
  const typed = Math.round(Number(other.replace(",", ".")) * 100) / 100;
  const amount = pick === "other" ? (Number.isFinite(typed) && typed >= 1 && typed <= max ? typed : null) : pick;
  return (
    <section className="stack tip-box" data-testid="tip-box">
      <h3>
        <Icon name="sparkles" className="ico-inline" /> {t("tip.title")}
      </h3>
      <p className="muted small">{t("tip.hint")}</p>
      <div className="tip-chips" role="group" aria-label={t("tip.title")}>
        {suggested.map((n) => (
          <button
            key={n}
            type="button"
            className={`tip-chip${pick === n ? " on" : ""}`}
            aria-pressed={pick === n}
            disabled={busy}
            onClick={() => setPick(n)}
            data-testid="tip-chip"
          >
            {fmt(n)}
          </button>
        ))}
        <button
          type="button"
          className={`tip-chip${pick === "other" ? " on" : ""}`}
          aria-pressed={pick === "other"}
          disabled={busy}
          onClick={() => setPick("other")}
          data-testid="tip-other"
        >
          {t("tip.other")}
        </button>
      </div>
      {pick === "other" && (
        <label className="field">
          <span>{t("tip.range", { max: fmt(max) })}</span>
          <input
            type="number"
            inputMode="decimal"
            min={1}
            max={max}
            step="0.01"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            data-testid="tip-amount"
          />
        </label>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-block"
        disabled={busy || amount === null}
        onClick={() => amount !== null && void run(() => onTip(amount))}
        data-testid="tip-send"
      >
        {amount === null ? t("tip.title") : t("tip.send", { amount: fmt(amount) })}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
