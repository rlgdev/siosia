// R1 Rider home sheet: pickup (GPS, pin, address), dropoff (pin, address), estimate, Request ride.

import { useState, type FormEvent } from "react";
import { MasterChip } from "../../components/ProfileIcon";
import { Money, Notice, Sheet, fmtKm, fmtMin } from "../../components/ui";
import type { LatLng, Place } from "../../core/types";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/store";
import { GeocodeError, searchAddress } from "../../services/geocode";
import type { GeoState } from "../../services/geolocation";
import type { Estimate } from "./useEstimate";

export type Field = "pickup" | "dropoff";

interface Props {
  pickup: Place | null;
  dropoff: Place | null;
  setPlace: (f: Field, p: Place, source: "gps" | "manual") => void;
  pickMode: Field | null;
  setPickMode: (f: Field | null) => void;
  gps: GeoState;
  near: LatLng | null;
  est: Estimate | null;
  currency: string;
  nearbyCount: number;
  blockReason: string | null;
  notice: string | null;
  onDismissNotice: () => void;
  onRequest: () => void;
  busy: boolean;
  error: string | null;
}

export function RiderHome(p: Props) {
  const { t } = useI18n();
  const fixed = useApp().profile?.fixedFare ?? null;
  const canRequest = !!p.pickup && !!p.dropoff && !!p.est && !p.est.loading && !p.blockReason && !p.busy;
  return (
    <Sheet>
      <MasterChip />
      {p.notice && (
        <Notice kind="warn">
          <span>{p.notice}</span>{" "}
          <button type="button" className="btn btn-link" onClick={p.onDismissNotice}>
            {t("common.close")}
          </button>
        </Notice>
      )}
      {p.gps.status === "denied" && (
        <Notice kind="warn">
          <strong>{t("geo.deniedTitle")}</strong>
          <p>{t("geo.deniedBody")}</p>
        </Notice>
      )}
      {p.gps.fix && p.gps.fix.accuracy > 100 && <Notice kind="warn">{t("geo.poor", { m: Math.round(p.gps.fix.accuracy) })}</Notice>}

      <PlaceField which="pickup" place={p.pickup} {...p} />
      <PlaceField which="dropoff" place={p.dropoff} {...p} />

      {p.pickMode && <p className="hint" role="status">{t("rider.pinHint", { field: t(p.pickMode === "pickup" ? "rider.pickup" : "rider.dropoff").toLowerCase() })}</p>}
      {!p.dropoff && !p.pickMode && <p className="hint">{t("rider.whereTo")}</p>}

      {p.est && (
        <div className="estimate" aria-live="polite" data-testid="estimate">
          {p.est.loading ? (
            <span className="muted">{t("rider.routing")}</span>
          ) : (
            <>
              <span>
                {t("common.km", { n: fmtKm(p.est.km) })} · {t("common.min", { n: fmtMin(p.est.min) })}
              </span>
              <strong data-testid="fare">
                <Money amount={p.est.fare} currency={p.currency} />
              </strong>
              {fixed !== null ? (
                <span className="badge" data-testid="fixed-fare">
                  {t("fare.fixed")}
                </span>
              ) : (
                p.est.estimate && <span className="badge badge-warn">{t("common.estimate")}</span>
              )}
            </>
          )}
        </div>
      )}
      {p.est?.estimate && !p.est.loading && <p className="hint">{t("rider.estimateBy")}</p>}
      {p.blockReason && <p className="form-error">{p.blockReason}</p>}
      {p.error && <p className="form-error" role="alert">{p.error}</p>}
      <p className="muted small">{p.nearbyCount > 0 ? t("rider.cars", { n: p.nearbyCount }) : t("rider.noCars")}</p>
      <button type="button" className="btn btn-primary btn-block" disabled={!canRequest} onClick={p.onRequest} data-testid="request-ride">
        {t("rider.request")}
      </button>
    </Sheet>
  );
}

function PlaceField({ which, place, setPlace, pickMode, setPickMode, gps, near }: Props & { which: Field; place: Place | null }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const label = t(which === "pickup" ? "rider.pickup" : "rider.dropoff");

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 4) {
      setErr(t("rider.searchHint"));
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await searchAddress(q, lang, near);
      setResults(r);
      if (!r.length) setErr(t("rider.noResults"));
    } catch (x) {
      setErr(x instanceof GeocodeError ? t("rider.geocodeDown") : t("common.error"));
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`place-field ${pickMode === which ? "is-picking" : ""}`}>
      <div className="place-row">
        <span className={`place-dot place-${which}`} aria-hidden="true" />
        <button type="button" className="place-label" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid={`${which}-field`}>
          <small>{label}</small>
          <span>{place ? place.label : "—"}</span>
        </button>
        {which === "pickup" && gps.fix && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t("rider.useGps")}
            title={t("rider.useGps")}
            onClick={() => setPlace("pickup", { lat: gps.fix!.lat, lng: gps.fix!.lng, label: t("rider.myLocation") }, "gps")}
          >
            ◎
          </button>
        )}
        <button
          type="button"
          className={`icon-btn ${pickMode === which ? "is-on" : ""}`}
          aria-label={`${t("rider.pinOnMap")}: ${label}`}
          aria-pressed={pickMode === which}
          title={t("rider.pinOnMap")}
          onClick={() => setPickMode(pickMode === which ? null : which)}
          data-testid={`${which}-pin`}
        >
          📌
        </button>
      </div>
      {open && (
        <form className="search" onSubmit={search} role="search">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("rider.searchPlaceholder")}
            aria-label={`${label}: ${t("rider.search")}`}
            enterKeyHint="search"
            data-testid={`${which}-search-input`}
          />
          <button type="submit" className="btn btn-secondary" disabled={loading}>
            {t("rider.search")}
          </button>
          {err && <p className="form-error full">{err}</p>}
          {results && results.length > 0 && (
            <ul className="results full">
              {results.map((r, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => {
                      setPlace(which, r, "manual");
                      setOpen(false);
                      setResults(null);
                      setQ("");
                    }}
                  >
                    {r.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
    </div>
  );
}
