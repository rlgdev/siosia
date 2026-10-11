// D2 Offer card (FR-022): rider, distance and ETA from the driver's current position to the pickup,
// trip, fare, a 20 s countdown on the SERVER clock, Accept / Decline.

import { ProfileIcon } from "../../components/ProfileIcon";
import { useEffect, useRef, useState } from "react";
import { Money, RatingBadge, fmtKm, fmtMin, useCountdown } from "../../components/ui";
import { straightLineEstimate } from "../../core/geo";
import type { LatLng, OfferView } from "../../core/types";
import { useI18n } from "../../i18n";
import { getRoute } from "../../services/routing";

interface Props {
  offer: OfferView;
  queued: number;
  offerS: number;
  from: LatLng | null;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onTimeout: () => void;
}

export function OfferCard({ offer, queued, offerS, from, busy, onAccept, onDecline, onTimeout }: Props) {
  const { t } = useI18n();
  const left = useCountdown(offer.offeredAt + offerS * 1000);
  const [toPickup, setToPickup] = useState<{ km: number; min: number } | null>(null);
  const fired = useRef(false);
  const fromRef = useRef(from);
  fromRef.current = from;
  const pickupRef = useRef(offer.pickup);
  pickupRef.current = offer.pickup;

  useEffect(() => {
    fired.current = false;
    const f = fromRef.current;
    if (!f) return;
    const pickup = pickupRef.current;
    setToPickup(straightLineEstimate(f, pickup));
    let alive = true;
    void getRoute(f, pickup, { timeoutMs: 2000 }).then((r) => alive && setToPickup({ km: r.km, min: r.min }));
    return () => {
      alive = false;
    };
  }, [offer.id, offer.offeredAt, offer.pickup.lat, offer.pickup.lng]);

  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onTimeout();
    }
  }, [left, onTimeout]);

  const km = toPickup?.km ?? offer.driverDistanceKm;
  const min = toPickup?.min ?? (offer.driverDistanceKm / 30) * 60;
  const pct = Math.max(0, Math.min(100, (left / offerS) * 100));

  return (
    <div className="offer" role="alertdialog" aria-label={t("offer.title")} data-testid="offer-card">
      <div className="offer-head">
        <h2>{t("offer.title")}</h2>
        <span className="countdown" aria-label={`${left} s`} style={{ ["--pct" as string]: `${pct}%` }}>
          {left}
        </span>
      </div>
      <p>
        <ProfileIcon icon={offer.rider.icon} size="sm" /> <strong>{offer.rider.nickname}</strong> <RatingBadge rating={offer.rider.rating} />
      </p>
      <p className="offer-pickup">{t("offer.toPickup", { km: fmtKm(km), min: fmtMin(min) })}</p>
      <p className="muted">{t("offer.trip", { km: fmtKm(offer.estKm), min: fmtMin(offer.estMin) })}</p>
      <div className="trip-line">
        <span>{offer.pickup.label}</span>
        <span aria-hidden="true">→</span>
        <span>{offer.dropoff.label}</span>
      </div>
      <p className="offer-fare">
        <Money amount={offer.fare} currency={offer.currency} /> {offer.fareIsEstimate && <span className="badge badge-warn">{t("common.estimate")}</span>}
      </p>
      {queued > 0 && <p className="muted small">{t("driver.queued", { n: queued })}</p>}
      <div className="row">
        <button type="button" className="btn btn-secondary grow" disabled={busy} onClick={onDecline} data-testid="decline-offer">
          {t("offer.decline")}
        </button>
        <button type="button" className="btn btn-primary grow" disabled={busy} onClick={onAccept} data-testid="accept-offer">
          {t("offer.accept")}
        </button>
      </div>
    </div>
  );
}
