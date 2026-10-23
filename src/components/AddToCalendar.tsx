// Add to calendar (FR-135, V28): Google Calendar (a prefilled event link, built here) and Apple
// Calendar / .ics (the viewer's link from the server when the deployment has the calendar function;
// on the demo backend the file is built in the browser and downloaded, or shared on iPhone). The
// event is a copy: the action says that it does not update by itself.

import { Icon } from "./Icon";
import { useState } from "react";
import {
  appointmentGoogleLink,
  appointmentIcs,
  rideGoogleLink,
  rideIcs,
  seriesIcs,
  type IcsContext
} from "../../supabase/functions/_shared/ics";
import type { AppointmentView, RideView } from "../core/types";
import { useI18n } from "../i18n";
import { isIOS } from "../services/device";
import { useApp } from "../state/store";

type Props = { appointment: AppointmentView; wholeSeries?: boolean; ride?: undefined } | { ride: RideView; appointment?: undefined; wholeSeries?: undefined };

export function AddToCalendar(props: Props) {
  const { t, lang } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  const dep = app.deployment;
  // An open request has no provider and no fixed date with anyone yet: nothing to add (V37).
  if (!dep || (props.appointment && (!props.appointment.provider || props.appointment.role === "candidate"))) return null;
  const ctx: IcsContext = {
    lang,
    timezone: dep.timezone,
    reminderMin: dep.appointment.reminderMin,
    siteUrl: typeof location !== "undefined" ? location.origin + location.pathname : null
  };
  const demo = app.cfg?.backend === "mock";
  const { appointment: a, ride: r, wholeSeries } = props;
  const google = a ? appointmentGoogleLink(a, ctx, !!wholeSeries) : rideGoogleLink(r!, ctx);
  const icsUrl = a ? (wholeSeries ? (a.series?.ics ?? null) : a.calendar.ics) : (r!.calendar?.ics ?? null);
  const build = () => (a ? (wholeSeries ? seriesIcs(a, ctx) : appointmentIcs(a, ctx)) : rideIcs(r!, ctx));
  const id = a ? (wholeSeries ? `series-${a.series?.id}` : a.id) : r!.id;
  const label = wholeSeries ? t("cal.addSeries") : t("cal.add");
  return (
    <div className="stack cal" data-testid={wholeSeries ? "add-to-calendar-series" : "add-to-calendar"}>
      <button type="button" className="btn btn-secondary btn-small" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid={wholeSeries ? "cal-open-series" : "cal-open"}>
        <Icon name="calendarPlus" className="ico-inline" /> {label}
      </button>
      {open && (
        <div className="stack cal-choices">
          <div className="row wrap">
            <a className="btn btn-secondary btn-small" href={google} target="_blank" rel="noreferrer" data-testid="cal-google">
              {t("cal.google")}
            </a>
            {demo ? (
              <button type="button" className="btn btn-secondary btn-small" onClick={() => download(build(), `siosia-${id.slice(0, 8)}.ics`)} data-testid="cal-ics">
                {t("cal.apple")}
              </button>
            ) : (
              icsUrl && (
                <a className="btn btn-secondary btn-small" href={icsUrl} data-testid="cal-ics">
                  {t("cal.apple")}
                </a>
              )
            )}
          </div>
          <p className="muted small" data-testid="cal-note">
            {t("cal.note")}
          </p>
        </div>
      )}
    </div>
  );
}

/** The demo's .ics: shared on iPhone (Add to Calendar from the share sheet), downloaded elsewhere. */
function download(ics: string, name: string): void {
  const file = new File([ics], name, { type: "text/calendar" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (isIOS() && nav.canShare?.({ files: [file] })) {
    void navigator.share({ files: [file] }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
