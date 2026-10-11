// R3 Active ride: driver, vehicle and plate (only now — FR-044), live car, ETA, status, cancel.

import { BookedFor } from "../../components/BookedFor";
import { ProfileIcon } from "../../components/ProfileIcon";
import { profileIcon } from "../../components/profileIcons";
import { useEffect, useState } from "react";
import { Confirm, Money, RatingBadge, Sheet, fmtMin } from "../../components/ui";
import { haversineM } from "../../core/geo";
import { riderCanCancel } from "../../core/lifecycle";
import type { RideView } from "../../core/types";
import { useI18n } from "../../i18n";
import { navigationUrl } from "../../services/device";
import type { LiveRoute, RiderRuntime } from "../../state/runtime";

interface Props {
  ride: RideView;
  rt: RiderRuntime;
  route: LiveRoute;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
}

export function RiderActive({ ride, rt, route, busy, error, onCancel }: Props) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const d = ride.driver;
  const status = ride.status as "accepted" | "arrived" | "in_progress";
  const seenAgo = rt.driverSeenAt ? Math.round((now - rt.driverSeenAt) / 1000) : null;
  const stale = seenAgo !== null && seenAgo * 1000 > 10_000;
  // §12: with sharing off the driver goes to the fixed pin, so tell a rider who walked away.
  const awayM = !rt.sharingOn && rt.fix && status !== "in_progress" ? Math.round(haversineM(rt.fix, ride.pickup)) : 0;
  return (
    <Sheet>
      <p className="status-line" role="status" aria-live="polite" data-testid="ride-status">
        {t(`active.${status}`)}
        {status !== "arrived" && route.min !== null && rt.driverPos && <strong> · {t("active.eta", { min: fmtMin(route.min) })}</strong>}
      </p>
      {rt.driverPresent === false && status === "in_progress" && <p className="hint">{t("active.reconnecting")}</p>}
      {!rt.driverPos && rt.driverPresent !== false && <p className="hint">{t("active.waitingFix")}</p>}
      {stale && <p className="hint">{t("active.lastSeen", { s: seenAgo! })}</p>}
      {awayM > 100 && <p className="hint">{t("active.awayFromPin", { m: awayM })}</p>}
      {ride.scheduledFor !== null && ride.status !== "in_progress" && <BookedFor at={ride.scheduledFor} />}
      {d && (
        <div className="driver-card" data-testid="driver-card">
          {profileIcon(d.icon) ? (
            <ProfileIcon icon={d.icon} size="sm" />
          ) : (
            <div className="avatar" aria-hidden="true">
              {d.nickname.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="grow">
            <strong>{d.nickname}</strong> <RatingBadge rating={d.rating} />
            {d.vehicle && (
              <p className="muted">
                {d.vehicle.colour} {d.vehicle.make} {d.vehicle.model} · {t("active.seats", { n: d.vehicle.seats })}
              </p>
            )}
          </div>
          {d.vehicle && (
            <span className="plate" data-testid="plate">
              {d.vehicle.plate}
            </span>
          )}
        </div>
      )}
      <div className="trip-line">
        <span>{ride.pickup.label}</span>
        <span aria-hidden="true">→</span>
        <span>{ride.dropoff.label}</span>
        <Money amount={ride.fare} currency={ride.currency} />
      </div>
      {(status === "accepted" || status === "arrived") && (
        <label className="switch-row">
          <input type="checkbox" checked={rt.sharingOn} onChange={(e) => rt.setSharingOn(e.target.checked)} />
          <span>
            {t("sharing.title")} · {t("sharing.rider")}
          </span>
        </label>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="row">
        {(status === "accepted" || status === "arrived") && (
          <a className="btn btn-secondary" href={navigationUrl(ride.pickup, "walking")} target="_blank" rel="noreferrer">
            {t("active.walk")}
          </a>
        )}
        {riderCanCancel(ride.status) && (
          <button type="button" className="btn btn-danger-outline" disabled={busy} onClick={() => setConfirm(true)} data-testid="cancel-ride">
            {t("active.cancel")}
          </button>
        )}
      </div>
      <Confirm
        open={confirm}
        danger
        message={t("active.cancelConfirm")}
        confirmLabel={t("active.cancel")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          onCancel();
        }}
      />
    </Sheet>
  );
}
