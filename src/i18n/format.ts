// Number formatting that follows the UI language (decimal comma in Polish).

let numberLocale = "en-GB";

/** Set by the i18n provider whenever the language changes. */
export function setNumberLocale(locale: string): void {
  numberLocale = locale;
}

export function fmtKm(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return "–";
  return new Intl.NumberFormat(numberLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.round(km * 10) / 10);
}

export function fmtMin(min: number | null | undefined): string {
  return min === null || min === undefined || !Number.isFinite(min) ? "–" : String(Math.max(1, Math.round(min)));
}
