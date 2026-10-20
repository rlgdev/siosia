// Appointment and ride status words of P1 / C3 — taken from the notification texts module, so the
// app shows exactly what the reminders say (one source, NFR-16 / V8).

import { apptStatusText, rideLineText } from "../../supabase/functions/_shared/push-text";
import type { AppointmentView } from "../core/types";
import type { MessageKey } from "../i18n/en";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type ChipKind = "ok" | "warn" | "info" | "muted";

/** The status chip: Confirmed / Waiting for an answer from … / Please answer / Declined … */
export function statusChip(a: AppointmentView, lang: string, t: T): { text: string; kind: ChipKind } {
  if (a.status === "accepted") return { text: apptStatusText("confirmed", a.provider.nickname, lang), kind: "ok" };
  if (a.status === "requested")
    return a.role === "client"
      ? { text: apptStatusText("waiting", a.provider.nickname, lang), kind: "info" }
      : { text: apptStatusText("answer", a.provider.nickname, lang), kind: "warn" };
  return { text: t(`appt.status.${a.status}` as MessageKey), kind: "muted" };
}

/**
 * The ride lines: every attached ride in the reminder words, and for a series occurrence whose
 * template ride is not booked yet (beyond the booking horizon) "booked when within 30 days".
 */
export function rideLines(a: AppointmentView, lang: string, t: T, horizonDays: number, now: number): string[] {
  const lines = a.rides.map((r) => rideLineText({ leg: r.leg, status: r.status, driver: r.driver?.nickname ?? null }, lang));
  if (a.series && a.status === "accepted") {
    for (const tpl of a.series.rideTemplates) {
      const passengerHas = a.rides.some((r) => r.leg === tpl.leg && r.passenger === tpl.passenger);
      if (passengerHas) continue;
      const at = (tpl.leg === "there" ? a.startsAt : a.endsAt) + tpl.offsetMin * 60_000;
      if (at > now + horizonDays * 86_400_000) lines.push(t("appt.rideLater", { leg: t(`appt.leg.${tpl.leg}` as MessageKey), days: horizonDays }));
    }
  }
  return lines;
}

/** "↻ every week · 3/8" */
export function seriesMarker(a: AppointmentView, t: T): string | null {
  if (!a.series) return null;
  return t("appt.seriesMarker", { rule: t(a.series.rule === "weekly" ? "appt.weekly" : "appt.biweekly"), seq: a.series.seq, count: a.series.count });
}

/** The other party of an appointment for the viewer. */
export const otherOf = (a: AppointmentView) => (a.role === "client" ? a.provider : a.client);
