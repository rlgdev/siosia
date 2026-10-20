// A place chosen like an R1 field (FR-094, FR-140): My place, this phone's location, or an address
// search (geocoding only on an explicit tap, FR-033). Used by C2, the ride sheets and S2.

import { useState, type FormEvent } from "react";
import type { LatLng, Place } from "../core/types";
import { useI18n } from "../i18n";
import { GeocodeError, reverseLabel, searchAddress } from "../services/geocode";
import { geo } from "../services/geolocation";

interface Props {
  label: string;
  value: Place | null;
  onChange: (p: Place | null) => void;
  /** Offered as one tap (the user's My place). */
  home?: Place | null;
  near?: LatLng | null;
  testId: string;
  /** The field may stay empty (an entry that needs no place). */
  optional?: boolean;
}

export function PlaceInput({ label, value, onChange, home, near, testId, optional }: Props) {
  const { t, lang } = useI18n();
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 4) return setErr(t("rider.searchHint"));
    setBusy(true);
    setErr(null);
    try {
      const r = await searchAddress(q, lang, near ?? home ?? null);
      setResults(r);
      if (!r.length) setErr(t("rider.noResults"));
    } catch (x) {
      setErr(x instanceof GeocodeError ? t("rider.geocodeDown") : t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const here = async () => {
    setBusy(true);
    setErr(null);
    try {
      const fix = geo.getState().fix ?? (await currentFix());
      const name = await reverseLabel(fix, lang).catch(() => null);
      onChange({ lat: fix.lat, lng: fix.lng, label: name ?? t("rider.myLocation") });
    } catch {
      setErr(t("geo.deniedTitle"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field place-input" data-testid={testId}>
      <span>{label}</span>
      <div className="place-value" data-testid={`${testId}-value`}>
        {value ? value.label : optional ? t("place.none") : "—"}
      </div>
      <div className="row wrap">
        {home && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => onChange(home)} data-testid={`${testId}-home`}>
            🏠 {t("place.myPlace")}
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void here()} data-testid={`${testId}-here`}>
          ◎ {t("place.here")}
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setSearching((s) => !s)} aria-expanded={searching} data-testid={`${testId}-search`}>
          🔎 {t("place.search")}
        </button>
        {optional && value && (
          <button type="button" className="btn btn-link btn-small" onClick={() => onChange(null)}>
            {t("place.clear")}
          </button>
        )}
      </div>
      {searching && (
        <form className="row" onSubmit={(e) => void search(e)}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("rider.searchPlaceholder")} aria-label={t("place.search")} data-testid={`${testId}-query`} />
          <button type="submit" className="btn btn-secondary" disabled={busy}>
            {t("rider.search")}
          </button>
        </form>
      )}
      {err && <small className="form-error">{err}</small>}
      {searching && results && results.length > 0 && (
        <ul className="results">
          {results.map((r, i) => (
            <li key={i}>
              <button
                type="button"
                className="btn btn-link"
                onClick={() => {
                  onChange(r);
                  setSearching(false);
                  setResults(null);
                }}
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function currentFix(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("geo_unavailable"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  });
}
