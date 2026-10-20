// Day and time words for 2.0 lists (S1 badge, P1 groups, C3): "today 14:00", "tomorrow 14:00",
// "Wed 22 Oct, 14:00". Times are wall-clock times as picked (v1 booking rule): shown as they are.

import type { MessageKey } from "../i18n/en";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
};

/** 0 = today, 1 = tomorrow, … (calendar days on this device). */
export function daysFrom(ms: number, now: number): number {
  const a = new Date(ms);
  const b = new Date(now);
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((utc(a) - utc(b)) / 86_400_000);
}

export function timeText(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(ms);
}

/** "Today" / "Tomorrow" / "Wed 22 Oct". */
export function dayText(ms: number, now: number, locale: string, t: T): string {
  const d = daysFrom(ms, now);
  if (d === 0) return t("when.today");
  if (d === 1) return t("when.tomorrow");
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" }).format(ms);
}

/** "today 14:00" / "tomorrow 14:00" / "Wed 22 Oct, 14:00". */
export function whenText(ms: number, now: number, locale: string, t: T): string {
  const d = daysFrom(ms, now);
  if (d === 0) return t("when.todayAt", { time: timeText(ms, locale) });
  if (d === 1) return t("when.tomorrowAt", { time: timeText(ms, locale) });
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}

/** "14:00–17:00" */
export function rangeTimes(start: number, end: number, locale: string): string {
  return `${timeText(start, locale)}–${timeText(end, locale)}`;
}

export const sameDay = (a: number, b: number) => dayKey(a) === dayKey(b);
