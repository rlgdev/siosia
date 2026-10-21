// Appointment and ride status words of P1 / C3 — taken from the notification texts module, so the
// app shows exactly what the reminders say (one source, NFR-16 / V8).
// 2.1: an open request has no provider yet (V37): the client reads "Waiting for someone to take it"
// and "Open to anyone"; a member who could take it (role candidate) reads who asks.

import { apptStatusText, rideLineText } from "../../supabase/functions/_shared/push-text";
import type { AppointmentView, PublicProvider } from "../core/types";
import type { MessageKey } from "../i18n/en";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type ChipKind = "ok" | "warn" | "info" | "muted";

/** An open request: nobody took it yet (no provider). */
export const isOpen = (a: AppointmentView) => a.status === "requested" && (a.open || !a.provider);

/** The status chip: Confirmed / Waiting for an answer from … / Please answer / Declined … */
export function statusChip(a: AppointmentView, lang: string, t: T): { text: string; kind: ChipKind } {
  if (a.status === "accepted") return { text: apptStatusText("confirmed", a.provider?.nickname ?? "", lang), kind: "ok" };
  if (a.status === "requested") {
    if (a.role === "candidate") return { text: t("appt.status.open"), kind: "info" };
    if (isOpen(a)) return { text: apptStatusText("open", null, lang) || t("appt.waitingAnyone"), kind: "info" };
    return a.role === "client"
      ? { text: apptStatusText("waiting", a.provider?.nickname ?? "", lang), kind: "info" }
      : { text: apptStatusText("answer", a.provider?.nickname ?? "", lang), kind: "warn" };
  }
  // An open request nobody took before its start: its own words.
  if (a.status === "expired" && !a.provider) return { text: t("appt.status.expiredOpen"), kind: "muted" };
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

/** The other party of an appointment for the viewer; null while the client's request is open. */
export const otherOf = (a: AppointmentView): PublicProvider | null => (a.role === "client" ? a.provider : a.client);

/** "With Siosia" / "For Ewa" / "Open to anyone" (the client's open request) / "Ewa asks" (a candidate). */
export function partyText(a: AppointmentView, t: T): string {
  if (a.role === "candidate") return t("open.askedBy", { name: a.client.nickname });
  if (a.role === "provider") return t("appt.client", { name: a.client.nickname });
  return a.provider ? t("appt.provider", { name: a.provider.nickname }) : t("appt.openToAnyone");
}

/** The other party's nickname for a sentence ("Rate Siosia"), "Anyone" when there is none yet. */
export const otherName = (a: AppointmentView, t: T): string => otherOf(a)?.nickname ?? t("appt.anyone");
