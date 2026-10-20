// Local date/time inputs. Times are wall-clock times on this phone (the deployment's time zone,
// as every phone of a deployment is assumed to be in it — spec §16).

const p2 = (n: number) => String(n).padStart(2, "0");

/** "2026-10-22T14:00" for a datetime-local input. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "2026-10-22" for a date input. */
export function toDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** The ms of a datetime-local / date input value (local time); NaN when empty. */
export const fromInput = (v: string): number => (v ? new Date(v.length === 10 ? `${v}T23:59` : v).getTime() : NaN);

/** The next `step`-minute mark at or after `ms`. */
export const roundUp = (ms: number, step: number) => Math.ceil(ms / (step * 60_000)) * step * 60_000;

/** `weeks` weeks later at the same local time (the browser keeps wall-clock across DST). */
export function addWeeksLocal(ms: number, weeks: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + 7 * weeks);
  return d.getTime();
}

/** The starts of a series: every `every` weeks, `count` times or until the end of `until`'s day. */
export function seriesStarts(first: number, every: 1 | 2, count: number | null, until: number | null, max: number): number[] {
  const out: number[] = [];
  for (let k = 0; k <= max; k++) {
    const t = addWeeksLocal(first, k * every);
    if (count !== null && out.length >= count) break;
    if (count === null && (until === null || t > until)) break;
    out.push(t);
  }
  return out;
}
