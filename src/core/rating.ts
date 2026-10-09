import { SERVER } from "./defaults";
import type { RatingSummary } from "./types";

/**
 * Displayed rating (FR-061): mean of the last 20 ratings, "New" (mean = null) with fewer than 3.
 * `starsNewestFirst` must be ordered newest first. Mirrored by public.siosia_rating() in SQL.
 */
export function summarizeRatings(starsNewestFirst: number[]): RatingSummary {
  const count = starsNewestFirst.length;
  if (count < SERVER.ratingMinCount) return { mean: null, count };
  const window = starsNewestFirst.slice(0, SERVER.ratingWindow);
  const mean = window.reduce((s, x) => s + x, 0) / window.length;
  return { mean: Math.round(mean * 10) / 10, count };
}
