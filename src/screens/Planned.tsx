// P1 Planned (FR-130–132, FR-134, US13): To answer (providers), Rides to take (drivers, the v1
// open-bookings list), then everything coming up in both roles grouped Today / Tomorrow / date,
// soonest first, an appointment in progress on top. Refreshes on state changes and every 30 s.
// 2.1 (FR-161): You could help (N) — others' open requests, soonest first, with I can do it.
// 2.3 (FR-202, FR-221): "with Zosia and Kuba" on an item with kids attached (a candidate: the
// count), the other party's photo, and the chat of an accepted appointment with its unread count.
// 2.12.2: every appointment shows its price — "est." when it is the rate × the booked time (the final
// cost follows the time spent), as set for a fixed price or a custom amount, or "no price set".

import { Icon } from "../components/Icon";
import { useCallback, useEffect, useState } from "react";
import { AddToCalendar } from "../components/AddToCalendar";
import { apptRoom, kidsLine, otherOf, partyText, rideLines, seriesMarker, statusChip } from "../components/apptWords";
import { ChatButton } from "../components/ChatSheet";
import { PartyAvatar } from "../components/ProfileIcon";
import { comingText, updateCountText } from "../components/SessionFeed";
import { dayText, rangeTimes, sameDay, timeText } from "../components/when";
import { Money, Page, RatingBadge, useBusy } from "../components/ui";
import type { AppointmentView, Planned as PlannedData, RideView } from "../core/types";
import { useI18n } from "../i18n";
import { useApp, useListsKey, useStore } from "../state/store";
import { DriverBookingCard, OpenBookingsList, RiderBookingCard, Route, useOpenBookings } from "./Bookings";
import { durationText, EventIcon, localText } from "./Catalog";

type Item = { kind: "appointment"; at: number; a: AppointmentView } | { kind: "ride"; at: number; r: RideView };

export function Planned() {
  const { t, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const role = app.profile?.masterRole ?? null;
  const isDriver = role !== "rider" && !!(app.vehicle || app.profile?.masterVehicle);
  const [data, setData] = useState<PlannedData | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, reloadOpen] = useOpenBookings(isDriver);
  const load = useCallback(
    () =>
      store.api.planned().then(
        (d) => (setData(d), setFailed(false)),
        () => setFailed(true)
      ),
    [store]
  );
  // Not on every MyState: an online driver's heartbeat brings one every 4 s.
  const listsKey = useListsKey();
  useEffect(() => {
    void load();
  }, [load, listsKey]);
  useEffect(() => {
    const id = setInterval(() => {
      void load();
      void reloadOpen();
    }, 30_000);
    return () => clearInterval(id);
  }, [load, reloadOpen]);
  const changed = () => {
    void load();
    void reloadOpen();
  };

  const now = store.serverNow();
  const toAnswer = data?.appointments.filter((a) => a.status === "requested" && a.role === "provider") ?? [];
  // Others' open requests this user could take (a backend without them sends none).
  const could = data?.open ?? [];
  const items: Item[] = data
    ? [
        ...data.appointments.filter((a) => !toAnswer.includes(a)).map((a): Item => ({ kind: "appointment", at: a.startsAt, a })),
        // A rider's ride attached to an appointment is shown in the appointment's ride line.
        ...data.rides.filter((r) => !(r.role === "rider" && r.appointmentId && r.status === "scheduled")).map((r): Item => ({ kind: "ride", at: r.scheduledFor ?? r.requestedAt, r }))
      ]
    : [];
  // In progress first (an active ride or an appointment under way), then soonest first.
  const live = (i: Item) => (i.kind === "ride" ? i.r.status !== "scheduled" : i.a.status === "accepted" && i.a.startsAt <= now);
  items.sort((x, y) => Number(live(y)) - Number(live(x)) || x.at - y.at);
  const groups: { label: string; items: Item[] }[] = [];
  for (const i of items) {
    const label = live(i) ? t("planned.now") : dayText(i.at, now, locale, t);
    const g = groups[groups.length - 1];
    if (g && g.label === label && (live(i) || sameDay(g.items[0].at, i.at))) g.items.push(i);
    else groups.push({ label, items: [i] });
  }

  return (
    <Page title={t("start.planned")} testId="planned">
      {failed && !data ? (
        <div className="stack">
          <p className="form-error">{t("planned.error")}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : !data ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <div className="stack">
          {toAnswer.length > 0 && (
            <section className="stack" data-testid="to-answer">
              <h2 className="section-title">{t("planned.toAnswer", { n: toAnswer.length })}</h2>
              {toAnswer.map((a) => (
                <AppointmentItem key={a.id} a={a} now={now} onChanged={changed} answer />
              ))}
            </section>
          )}
          {could.length > 0 && (
            <section className="stack" data-testid="open-requests">
              <h2 className="section-title">{t("planned.openRequests", { n: could.length })}</h2>
              {could.map((a) => (
                <OpenRequestItem key={a.id} a={a} />
              ))}
            </section>
          )}
          {isDriver && (
            <section className="stack" data-testid="rides-to-take">
              <h2 className="section-title">{t("planned.ridesToTake", { n: open?.length ?? 0 })}</h2>
              {open === null ? <p className="muted">{t("common.loading")}</p> : <OpenBookingsList open={open} onChanged={changed} />}
            </section>
          )}
          {items.length === 0 ? (
            <p className="muted" data-testid="planned-empty">
              {t("planned.empty")}
            </p>
          ) : (
            groups.map((g, gi) => (
              <section key={gi} className="stack" data-testid="planned-day">
                <h2 className="section-title">{g.label}</h2>
                {g.items.map((i) =>
                  i.kind === "appointment" ? (
                    <AppointmentItem key={i.a.id} a={i.a} now={now} onChanged={changed} />
                  ) : (
                    <RideItem key={i.r.id} r={i.r} onChanged={changed} />
                  )
                )}
              </section>
            ))
          )}
          <button type="button" className="btn btn-secondary" onClick={() => store.go("catalog")} data-testid="planned-request">
            {t("planned.requestMore")}
          </button>
        </div>
      )}
    </Page>
  );
}

/** An appointment in P1: service, time, the other party, status chip, ride lines; tap opens C3. */
function AppointmentItem({ a, now, onChanged, answer }: { a: AppointmentView; now: number; onChanged: () => void; answer?: boolean }) {
  const { t, lang, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const chip = statusChip(a, lang, t);
  const other = otherOf(a);
  const inProgress = a.status === "accepted" && a.startsAt <= now && now < a.endsAt;
  const marker = seriesMarker(a, t);
  const soon = a.startsAt - now;
  // "Now until 17:00" / "In 40 min" / "In 2 h" markers (FR-123), then the time range.
  const soonMark = inProgress
    ? t("appt.nowUntil", { time: timeText(a.endsAt, locale) })
    : soon > 0 && soon < 3600_000
      ? t("planned.inMin", { n: Math.max(1, Math.ceil(soon / 60_000)) })
      : soon > 0 && soon <= 3 * 3600_000
        ? t("planned.inHours", { n: Math.round(soon / 3600_000) })
        : null;
  return (
    <article className="card stack planned-item" data-testid="planned-appointment">
      <button type="button" className="planned-open" onClick={() => store.openPanel("appointment", a.id)} data-testid="open-appointment">
        <span className="row spread">
          <strong>
            <EventIcon icon={a.service?.icon ?? "📅"} serviceId={a.serviceId} /> {localText(a.service?.name, lang) || a.serviceId}
          </strong>
          <span className={`chip chip-${chip.kind}`} data-testid="appt-chip">
            {chip.text}
          </span>
        </span>
        <span className="row">
          {soonMark && (
            <span className="chip chip-info" data-testid="appt-soon">
              {soonMark}
            </span>
          )}
          <span>{rangeTimes(a.startsAt, a.endsAt, locale)}</span>
        </span>
        <span className="row muted small">
          <PartyAvatar p={other} /> {partyText(a, t)}
          {" · "}
          <ApptPrice a={a} />
        </span>
        {kidsLine(a, lang, t) && (
          <span className="muted small" data-testid="kids-line">
            {kidsLine(a, lang, t)}
          </span>
        )}
        {marker && (
          <span className="muted small" data-testid="series-marker">
            {marker}
          </span>
        )}
        {a.updateCount > 0 && (
          <span className="muted small" data-testid="feed-count">
            {updateCountText(a.updateCount, t)}
          </span>
        )}
        {comingText(a, now, locale, t) && (
          <span className="small" data-testid="coming-line">
            {comingText(a, now, locale, t)}
          </span>
        )}
        {rideLines(a, lang, t, app.deployment?.booking.maxDays ?? 30, now).map((l, i) => (
          <span key={i} className="ride-line small" data-testid="ride-line">
            {l}
          </span>
        ))}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {a.status === "accepted" && !answer && (
        <div className="row wrap">
          <AddToCalendar appointment={a} />
          {apptRoom(a) && <ChatButton room={apptRoom(a)!} unread={a.unread} small />}
        </div>
      )}
      {answer && (
        <div className="row">
          <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => store.openPanel("appointment", `accept:${a.id}`)} data-testid="answer-accept">
            {t("appt.accept")}
          </button>
          <button
            type="button"
            className="btn btn-secondary grow"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                try {
                  await store.api.answerAppointment(a.id, "decline");
                } finally {
                  onChanged();
                  await store.refresh().catch(() => {});
                }
              })
            }
            data-testid="answer-decline"
          >
            {t("appt.decline")}
          </button>
        </div>
      )}
    </article>
  );
}

/**
 * Someone's open request in P1 (FR-161): service, when, who asks (with rating), place, note, the
 * repeat and the price; I can do it opens C3 with the take sheet (FR-163).
 */
function OpenRequestItem({ a }: { a: AppointmentView }) {
  const { t, lang, locale } = useI18n();
  const store = useStore();
  const now = store.serverNow();
  const date = (ms: number) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(ms);
  // The dates still to take: from this one on, without the ones the client withdrew (gaps).
  const gaps = new Set(a.series?.gaps ?? []);
  const starts = (a.series?.starts ?? []).filter((s) => s >= a.startsAt && !gaps.has(s));
  const repeat = a.series
    ? starts.length >= 2
      ? t("open.series", { rule: t(a.series.rule === "weekly" ? "appt.weekly" : "appt.biweekly"), n: starts.length, first: date(starts[0]), last: date(starts[starts.length - 1]) })
      : seriesMarker(a, t)
    : null;
  return (
    <article className="card stack planned-item open-item" data-testid="open-request">
      <button type="button" className="planned-open" onClick={() => store.openPanel("appointment", a.id)} data-testid="open-request-details">
        <span className="row spread">
          <strong>
            <EventIcon icon={a.service?.icon ?? "📅"} serviceId={a.serviceId} /> {localText(a.service?.name, lang) || a.serviceId}
          </strong>
          <strong>
            <ApptPrice a={a} />
          </strong>
        </span>
        <span data-testid="open-request-when">
          {dayText(a.startsAt, now, locale, t)} · {rangeTimes(a.startsAt, a.endsAt, locale)} ({durationText(a.durationMin, t)})
        </span>
        <span className="row small">
          <PartyAvatar p={a.client} /> {partyText(a, t)} <RatingBadge rating={a.client.rating} />
        </span>
        <span className="muted small">
          <Icon name="place" className="ico-inline" /> {a.place ? a.place.label : t("appt.noPlace")}
        </span>
        {kidsLine(a, lang, t) && (
          <span className="muted small" data-testid="kids-line">
            {kidsLine(a, lang, t)}
          </span>
        )}
        {a.note && <span className="note small">„{a.note}”</span>}
        {repeat && (
          <span className="muted small" data-testid="series-marker">
            {repeat}
          </span>
        )}
      </button>
      <div className="row">
        <button type="button" className="btn btn-primary grow" onClick={() => store.openPanel("appointment", `take:${a.id}`)} data-testid="take-request">
          {t("open.take")}
        </button>
      </div>
    </article>
  );
}

/** 2.12.2: an appointment's price — an estimate at a rate, as set otherwise, or none set yet. */
export function ApptPrice({ a }: { a: AppointmentView }) {
  const { t } = useI18n();
  if (a.price === null)
    return (
      <span className="appt-price" data-testid="appt-price-none">
        {t("planned.noPrice")}
      </span>
    );
  const estimate = a.rate !== null && a.status !== "done";
  return (
    <span className="appt-price" data-testid="appt-price">
      {estimate && `${t("planned.est")} `}
      <Money amount={a.price} currency={a.currency} />
    </span>
  );
}

/** A ride in P1: a booking (the v1 cards with Cancel / Give back) or the active ride. */
function RideItem({ r, onChanged }: { r: RideView; onChanged: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  if (r.status === "scheduled") return r.role === "rider" ? <RiderBookingCard r={r} onChanged={onChanged} /> : <DriverBookingCard r={r} onChanged={onChanged} />;
  return (
    <article className="card stack" data-testid="planned-active-ride">
      <strong>
        <Icon name="car" className="ico-inline" /> {t("planned.activeRide")}
      </strong>
      <Route r={r} />
      <button type="button" className="btn btn-primary" onClick={() => store.go(r.role === "driver" ? "drive" : "ride")}>
        {t("planned.openRide")}
      </button>
    </article>
  );
}
