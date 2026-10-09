import { useEffect, useState } from "react";
import { computeFare } from "../../core/fare";
import type { LatLng, Tariff } from "../../core/types";
import { getRoute, type RouteResult } from "../../services/routing";

export interface Estimate {
  loading: boolean;
  /** Rounded values exactly as sent to the server, so the frozen fare equals the shown one (FR-013). */
  km: number;
  min: number;
  fare: number;
  line: LatLng[] | null;
  estimate: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Route distance, duration and fare between two points (FR-012), refreshed when either changes. */
export function useEstimate(a: LatLng | null, b: LatLng | null, tariff: Tariff | null): Estimate | null {
  const key = a && b ? `${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}` : "";
  const [state, setState] = useState<{ key: string; route: RouteResult } | null>(null);

  useEffect(() => {
    if (!a || !b) return;
    let alive = true;
    void getRoute(a, b, { timeoutMs: 2000 }).then((route) => {
      if (alive) setState({ key, route });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!a || !b || !tariff) return null;
  if (!state || state.key !== key) return { loading: true, km: 0, min: 0, fare: 0, line: null, estimate: false };
  const km = Math.max(0.01, r2(state.route.km));
  const min = Math.max(1, r1(state.route.min));
  return { loading: false, km, min, fare: computeFare(tariff, km, min), line: state.route.line, estimate: state.route.estimate };
}
