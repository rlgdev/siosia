import type { Tariff } from "./types";

/** Round to the nearest 0.50 (FR-050). Uses an epsilon so 12.25 rounds up like the SQL twin. */
export function roundToHalf(x: number): number {
  return Math.round(x * 2 + 1e-9) / 2;
}

/**
 * Fare = base + perKm × km + perMin × min, rounded to 0.50, never below the minimum (FR-050).
 * Mirrored by public.siosia_fare() in the SQL migration — keep both in sync.
 */
export function computeFare(tariff: Tariff, km: number, min: number): number {
  const raw = tariff.base + tariff.perKm * Math.max(0, km) + tariff.perMin * Math.max(0, min);
  return Math.max(tariff.minimum, roundToHalf(raw));
}

export function formatMoney(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
