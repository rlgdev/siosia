// Wall-clock time in the deployment's time zone (twin of the SQL "at time zone" arithmetic):
// a weekly series keeps its local start time across daylight saving changes.

/** Offset of `tz` from UTC at instant `ms`, in ms (e.g. +2 h in Warsaw in summer). */
export function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - (ms - (ms % 1000 + 1000) % 1000);
}

/** The instant `weeks` weeks after `ms` at the same local wall-clock time in `tz`. */
export function addWeeksWallClock(ms: number, weeks: number, tz: string): number {
  const local = ms + tzOffsetMs(ms, tz);
  const target = local + weeks * 7 * 86_400_000;
  // The offset at the result may differ (DST): settle on the instant whose local time is `target`.
  let guess = target - tzOffsetMs(ms, tz);
  for (let i = 0; i < 2; i++) guess = target - tzOffsetMs(guess, tz);
  return guess;
}

/** Local calendar date "YYYY-MM-DD" of `ms` in `tz`. */
export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}
