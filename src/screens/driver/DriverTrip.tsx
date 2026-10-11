// D3 Active trip (FR-023/024/025): route to pickup then dropoff, rider live pin, status buttons,
// Navigate hand-off, Cancel with reasons (No-show only 5 min after "I've arrived").

import { BookedFor } from "../../components/BookedFor";
import { ProfileIcon } from "../../components/ProfileIcon";
import { useState } from "react";
import { Confirm, Money, RatingBadge, Sheet, fmtKm, fmtMin, mmss, useCountdown } from "../../components/ui";
import { haversineM } from "../../core/geo";
import type { DriverCancelReason, RideView, Timers } from "../../core/types";
import { useI18n } from "../../i18n";
import { navigationUrl } from "../../services/device";
import type { DriverRuntime, LiveRoute } from "../../state/runtime";

interface Props {
  ride: RideView;
  rt: DriverRuntime;
  route: LiveRoute;
  timers: Timers;
  busy: boolean;
  error: string | null;
  onAdvance: (to: "arrived" | "in_progress" | "completed") => void;
  onCancel: (reason: DriverCancelReason) => void;
}

const REASONS: DriverCancelReason[] = ["no_show", "wrong_pickup", "vehicle_problem", "other"];

export function DriverTrip({ ride, rt, route, timers, busy, error, onAdvance, onCancel }: Props) {
  const { t } = useI18n();
  const [farWarn, setFarWarn] = useState<number | null>(null);
  const [reasons, setReasons] = useState(false);
  // A booked ride waits from the booked time, even if the driver came early.
  const noShowLeft = useCountdown(
    ride.status === "arrived" && ride.arrivedAt ? Math.max(ride.arrivedAt, ride.scheduledFor ?? 0) + timers.noShowS * 1000 : null
  );
  const s = ride.status;

  const target =
    s === "in_progress"
      ? ride.dropoff
      : rt.riderPos && haversineM(rt.riderPos, ride.pickup) > 100
        ? { ...rt.riderPos, label: ride.pickup.label }
        : ride.pickup;

  const arrive = () => {
    const d = rt.fix ? haversineM(rt.fix, ride.pickup) : 0;
    if (d > 300) setFarWarn(Math.round(d));
    else onAdvance("arrived");
  };

  return (
    <Sheet>
      <p className="status-line" role="status" aria-live="polite" data-testid="trip-status">
        {s === "accepted" && t("trip.toPickup")}
        {s === "arrived" && t("trip.atPickup", { name: ride.rider.nickname })}
        {s === "in_progress" && t("trip.toDropoff")}
        {route.km !== null && s !== "arrived" && (
          <strong>
            {" "}
            · {t("common.km", { n: fmtKm(route.km) })} · {t("common.min", { n: fmtMin(route.min) })}
          </strong>
        )}
      </p>
      <p>
        <ProfileIcon icon={ride.rider.icon} size="sm" /> <strong>{ride.rider.nickname}</strong> <RatingBadge rating={ride.rider.rating} /> ·{" "}
        <Money amount={ride.fare} currency={ride.currency} />
      </p>
      <p className="muted">{s === "in_progress" ? ride.dropoff.label : ride.pickup.label}</p>
      {ride.scheduledFor !== null && s !== "in_progress" && <BookedFor at={ride.scheduledFor} />}
      {(s === "accepted" || s === "arrived") && rt.riderStopped && <p className="hint">{t("trip.riderStopped")}</p>}
      {s === "in_progress" && <p className="muted small">{t("trip.distance", { km: fmtKm(rt.tripKm) })}</p>}
      {!rt.wakeOk && <p className="hint">{t("wake.body")}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="row">
        <a className="btn btn-secondary" href={navigationUrl(target)} target="_blank" rel="noreferrer" data-testid="navigate">
          {t("trip.navigate")}
        </a>
        {s === "accepted" && (
          <button type="button" className="btn btn-primary grow" disabled={busy} onClick={arrive} data-testid="arrived">
            {t("trip.arrived")}
          </button>
        )}
        {s === "arrived" && (
          <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => onAdvance("in_progress")} data-testid="start-trip">
            {t("trip.start")}
          </button>
        )}
        {s === "in_progress" && (
          <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => onAdvance("completed")} data-testid="complete-trip">
            {t("trip.complete")}
          </button>
        )}
      </div>
      {(s === "accepted" || s === "arrived") && (
        <button type="button" className="btn btn-link danger" disabled={busy} onClick={() => setReasons(true)} data-testid="driver-cancel">
          {t("trip.cancel")}
        </button>
      )}

      <Confirm
        open={farWarn !== null}
        message={t("trip.farWarn", { m: farWarn ?? 0 })}
        onCancel={() => setFarWarn(null)}
        onConfirm={() => {
          setFarWarn(null);
          onAdvance("arrived");
        }}
      />
      {reasons && (
        <div className="modal-backdrop" role="presentation" onClick={() => setReasons(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={t("trip.reasonTitle")} onClick={(e) => e.stopPropagation()}>
            <h3>{t("trip.reasonTitle")}</h3>
            <div className="stack">
              {REASONS.map((r) => {
                const isNoShow = r === "no_show";
                const disabled = isNoShow && (s !== "arrived" || noShowLeft > 0);
                return (
                  <button
                    key={r}
                    type="button"
                    className="btn btn-secondary"
                    disabled={disabled || busy}
                    onClick={() => {
                      setReasons(false);
                      onCancel(r);
                    }}
                  >
                    {t(`reason.${r}`)}
                    {isNoShow && s === "arrived" && noShowLeft > 0 && <small> · {t("trip.noShowIn", { t: mmss(noShowLeft) })}</small>}
                  </button>
                );
              })}
              <button type="button" className="btn btn-link" onClick={() => setReasons(false)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
