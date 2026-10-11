// "Booked pickup: 17:10" on the trip screens of a ride booked in advance (wall-clock time, as booked).

import { useI18n } from "../i18n";

export function BookedFor({ at }: { at: number }) {
  const { t, locale } = useI18n();
  return (
    <p className="hint" data-testid="booked-for">
      {t("trip.bookedFor", { time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at) })}
    </p>
  );
}
