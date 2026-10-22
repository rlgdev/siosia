// C3 Appointment (FR-101, FR-102, FR-109–117, FR-132): everything the viewer may see — service,
// time, the other party, place, note, status, the series line, attached rides — and the actions:
// Accept (C4: with a ride there / back) or Decline, Add ride (for all remaining on a series),
// Remove ride, Cancel (this one / all remaining), Add to calendar, Rate.
// 2.1 (FR-163, FR-164): someone's open request (role candidate) shows its details and I can do it —
// the take sheet is C4 with takeRequest instead of Accept; the client's own open request waits for
// someone to take it and can be withdrawn.
// 2.3 (FR-201–203, FR-221): the attached kids — the client changes them until the end, the
// provider sees their cards and rates each once the appointment is done, a candidate sees only
// how many — and the chat with the other party once accepted.

import { useCallback, useEffect, useRef, useState } from "react";
import { AddToCalendar } from "../components/AddToCalendar";
import { apptRoom, isOpen, kidCountText, otherName, otherOf, partyText, rideLines, seriesMarker, statusChip } from "../components/apptWords";
import { ChatButton } from "../components/ChatSheet";
import { fromInput, toLocalInput } from "../components/datetime";
import { AttachedKidCards, KidPicker, RateKidBox, useMyKids } from "../components/Kids";
import { PlaceInput } from "../components/PlaceInput";
import { Avatar } from "../components/ProfileIcon";
import { rangeTimes, timeText, whenText } from "../components/when";
import { Money, Panel, RatingBadge, StarInput, useBusy } from "../components/ui";
import { computeFare } from "../core/fare";
import { derivedPickup } from "../core/time";
import type { AppointmentView, Leg, Place, RideTemplateInput } from "../core/types";
import { ServerError } from "../core/types";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { navigationUrl } from "../services/device";
import { getRoute } from "../services/routing";
import { useApp, useListsKey, useStore } from "../state/store";
import { EntryIcon, localText } from "./Catalog";

export function AppointmentPanel() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const arg = app.panelArg ?? "";
  // "accept:<id>" opens C4 at once (To answer), "take:<id>" the take sheet (You could help).
  const accepting = arg.startsWith("accept:");
  const taking = arg.startsWith("take:");
  const id = accepting ? arg.slice(7) : taking ? arg.slice(5) : arg;
  const [a, setA] = useState<AppointmentView | null>(null);
  const [failed, setFailed] = useState(false);
  // The reload said not_found: no longer this viewer's — an open request someone else took or the
  // client withdrew. The stale view (with its I can do it) is dropped; a failure like being
  // offline keeps it.
  const [gone, setGone] = useState(false);
  const load = useCallback(
    () =>
      store.api.getAppointment(id).then(
        (v) => (setA(v), setFailed(false), setGone(false)),
        (e) => (setFailed(true), setGone(e instanceof ServerError && e.code === "not_found"))
      ),
    [store, id]
  );
  // Not on every MyState: an online driver's heartbeat brings one every 4 s.
  const listsKey = useListsKey();
  useEffect(() => {
    void load();
  }, [load, listsKey]);
  return (
    <Panel title={a ? localText(a.service?.name, app.lang) || a.serviceId : t("appt.title")} onClose={() => store.closePanel()}>
      {gone || (failed && !a) ? (
        <p className="form-error" data-testid="appt-gone">
          {t(a?.role === "candidate" ? "open.gone" : "err.not_found")}
        </p>
      ) : !a ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <AppointmentDetails a={a} reload={load} accepting={accepting} taking={taking} />
      )}
    </Panel>
  );
}

function AppointmentDetails({ a, reload, accepting, taking }: { a: AppointmentView; reload: () => void; accepting: boolean; taking: boolean }) {
  const { t, lang, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const dep = app.deployment!;
  const now = store.serverNow();
  const [busy, run, error] = useBusy();
  const [mode, setMode] = useState<"view" | "accept" | "take" | "cancel" | "kids" | Leg>(
    accepting && a.status === "requested" && a.role === "provider" ? "accept" : taking && a.status === "requested" && a.role === "candidate" ? "take" : "view"
  );
  const other = otherOf(a);
  const chip = statusChip(a, lang, t);
  const inProgress = a.status === "accepted" && a.startsAt <= now && now < a.endsAt;
  const marker = seriesMarker(a, t);
  const lines = rideLines(a, lang, t, dep.booking.maxDays, now);
  const myLegs = new Set(a.rides.filter((r) => r.mine && r.status !== "failed" && r.status !== "done").map((r) => r.leg));
  const myTemplates = a.series?.rideTemplates.filter((x) => x.mine) ?? [];
  const canCancel = (a.status === "accepted" || (a.status === "requested" && a.role === "client")) && now < a.startsAt;
  const canAddRide = a.status === "accepted" && now < a.endsAt && !!a.place;
  const rateUntil = (a.endedAt ?? a.endsAt) + 24 * 3600_000;
  const canRate = a.status === "done" && a.myRating === null && now < rateUntil;
  // 2.3: the kids — the client changes them until the end (FR-201), given they have kids to attach
  // (C20); the provider rates each once it is done, within 24 h (FR-203); a candidate learns only
  // the count (FR-202).
  const kids = a.kids ?? [];
  const [myKids] = useMyKids(a.role === "client");
  const canChangeKids = a.role === "client" && (a.status === "requested" || a.status === "accepted") && now < a.endsAt && !!myKids && myKids.length > 0;
  const showKids = kids.length > 0 || canChangeKids || (a.role === "candidate" && a.kidCount > 0);
  const kidsToRate = a.status === "done" && a.role === "provider" ? kids.filter((k) => k.myRating !== null || now < rateUntil) : [];
  const room = apptRoom(a);

  const act = (fn: () => Promise<unknown>) =>
    run(async () => {
      try {
        await fn();
      } finally {
        reload();
        await store.refresh().catch(() => {});
      }
    });

  return (
    <div className="stack" data-testid="appointment">
      <section className="card stack">
        <div className="row spread">
          <strong className="appt-title">
            <EntryIcon icon={a.service?.icon ?? "📅"} /> {localText(a.service?.name, lang) || a.serviceId}
          </strong>
          <span className={`chip chip-${chip.kind}`} data-testid="appt-status">
            {chip.text}
          </span>
        </div>
        <p data-testid="appt-when">
          {inProgress ? t("appt.nowUntil", { time: timeText(a.endsAt, locale) }) : whenText(a.startsAt, now, locale, t)} · {rangeTimes(a.startsAt, a.endsAt, locale)}
        </p>
        {marker && (
          <p className="muted small" data-testid="appt-series">
            {marker}
            {a.series && ` · ${t("appt.seriesLeft", { n: a.series.remaining })}`}
            {a.series && a.series.declined.length > 0 &&
              ` · ${t("appt.declinedDates", { dates: a.series.declined.map((d) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d)).join(", ") })}`}
          </p>
        )}
        <p className="row" data-testid="appt-party">
          <Avatar photo={other?.photo} icon={other?.icon} size="sm" paint={other?.paint} />
          <span>{partyText(a, t)}</span>
          {other && <RatingBadge rating={other.rating} />}
        </p>
        <p data-testid="appt-place">
          📍 {a.place ? a.place.label : t("appt.noPlace")}{" "}
          {a.place && (
            <a className="btn btn-link btn-small" href={navigationUrl(a.place)} target="_blank" rel="noreferrer">
              {t("appt.map")}
            </a>
          )}
        </p>
        {a.note && <p className="note" data-testid="appt-note">„{a.note}”</p>}
        {a.price !== null && (
          <p>
            <Money amount={a.price} currency={a.currency} />
          </p>
        )}
        {a.status === "cancelled" && a.cancelledBy && (
          <p className="muted small">
            {t(`appt.cancelledBy.${a.cancelledBy}` as MessageKey, { name: a.cancelledBy === "client" ? a.client.nickname : (a.provider?.nickname ?? t("appt.anyone")) })}
          </p>
        )}
      </section>

      {showKids && (
        <section className="card stack" data-testid="appt-kids">
          <div className="row spread">
            <strong>{t("appt.kids")}</strong>
            {canChangeKids && mode === "view" && (
              <button type="button" className="btn btn-link btn-small" disabled={busy} onClick={() => setMode("kids")} data-testid="appt-kids-change">
                {t("appt.kidsChange")}
              </button>
            )}
          </div>
          {a.role === "candidate" ? (
            <p data-testid="appt-kid-count">{kidCountText(a.kidCount, t)}</p>
          ) : kids.length === 0 ? (
            <p className="muted small">{t("appt.kidsNone")}</p>
          ) : (
            <AttachedKidCards kids={kids} />
          )}
        </section>
      )}
      {mode === "kids" && <KidsEditor a={a} onDone={() => setMode("view")} reload={reload} />}

      {(lines.length > 0 || myTemplates.length > 0) && (
        <section className="card stack" data-testid="appt-rides">
          {lines.map((l, i) => (
            <p key={i} className="ride-line">
              {l}
            </p>
          ))}
          {a.rides
            .filter((r) => r.mine && (r.status === "pending" || r.status === "confirmed"))
            .map((r) => (
              <button key={r.rideId} type="button" className="btn btn-link btn-small" disabled={busy} onClick={() => void act(() => store.api.cancelRide(r.rideId))} data-testid={`remove-ride-${r.leg}`}>
                {t("appt.removeRide", { leg: t(`appt.leg.${r.leg}` as MessageKey) })}
              </button>
            ))}
          {myTemplates.map((x) => (
            <button key={x.leg} type="button" className="btn btn-link btn-small" disabled={busy} onClick={() => void act(() => store.api.dropRideTemplate(a.series!.id, x.leg))} data-testid={`drop-template-${x.leg}`}>
              {t("appt.dropTemplate", { leg: t(`appt.leg.${x.leg}` as MessageKey) })}
            </button>
          ))}
        </section>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {mode === "accept" && <AcceptSheet a={a} onDone={() => setMode("view")} reload={reload} />}
      {mode === "take" && <AcceptSheet a={a} take onDone={() => setMode("view")} reload={reload} />}
      {(mode === "there" || mode === "back") && <AddRide a={a} leg={mode} onDone={() => setMode("view")} reload={reload} />}

      {mode === "cancel" && (
        <section className="card stack" data-testid="cancel-box">
          <p>{isOpen(a) ? t("appt.withdrawOpen") : t(a.status === "accepted" ? "appt.cancelConfirm" : "appt.withdrawConfirm", { name: otherName(a, t) })}</p>
          <div className="row wrap">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act(() => store.api.cancelAppointment(a.id, null, "one")).then(() => setMode("view"))} data-testid="cancel-one">
              {a.series ? t("appt.cancelOne") : t("appt.cancelYes")}
            </button>
            {a.series && a.series.remaining > 1 && (
              <button type="button" className="btn btn-danger-outline" disabled={busy} onClick={() => void act(() => store.api.cancelAppointment(a.id, null, "series")).then(() => setMode("view"))} data-testid="cancel-series">
                {t("appt.cancelAll", { n: a.series.remaining })}
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => setMode("view")}>
              {t("appt.keep")}
            </button>
          </div>
        </section>
      )}

      {mode === "view" && (
        <section className="stack">
          {a.status === "requested" && a.role === "candidate" && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setMode("take")} data-testid="appt-take">
              {t("open.take")}
            </button>
          )}
          {a.status === "requested" && a.role === "provider" && (
            <div className="row">
              <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => setMode("accept")} data-testid="appt-accept">
                {t("appt.accept")}
              </button>
              <button type="button" className="btn btn-secondary grow" disabled={busy} onClick={() => void act(() => store.api.answerAppointment(a.id, "decline"))} data-testid="appt-decline">
                {t("appt.decline")}
              </button>
            </div>
          )}
          {canAddRide && (
            <div className="row wrap">
              {(["there", "back"] as const)
                .filter((leg) => !myLegs.has(leg) && !myTemplates.some((x) => x.leg === leg))
                .map((leg) => (
                  <button key={leg} type="button" className="btn btn-secondary" onClick={() => setMode(leg)} data-testid={`add-ride-${leg}`}>
                    🚗 {t(a.series ? "appt.addRideAll" : "appt.addRide", { leg: t(`appt.leg.${leg}` as MessageKey) })}
                  </button>
                ))}
            </div>
          )}
          {room && (
            <div className="row">
              <ChatButton room={room} unread={a.unread} />
            </div>
          )}
          {a.status === "accepted" && <AddToCalendar appointment={a} />}
          {a.status === "accepted" && a.series && a.series.remaining > 0 && <AddToCalendar appointment={a} wholeSeries />}
          {canRate && <RateBox a={a} onRated={reload} />}
          {kidsToRate.length > 0 && (
            <section className="card stack" data-testid="appt-rate-kids">
              {kidsToRate.map((k) => (
                <RateKidBox key={k.id} appointmentId={a.id} kid={k} onRated={reload} />
              ))}
            </section>
          )}
          {canCancel && (
            <button type="button" className="btn btn-danger-outline" onClick={() => setMode("cancel")} data-testid="appt-cancel">
              {t(a.status === "accepted" ? "appt.cancel" : "appt.withdraw")}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/** The client picks which of their kids come to this appointment (FR-201); Save replaces the set. */
function KidsEditor({ a, onDone, reload }: { a: AppointmentView; onDone: () => void; reload: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  const [kids] = useMyKids();
  const [selected, setSelected] = useState<string[]>(() => (a.kids ?? []).map((k) => k.id));
  const [busy, run, error] = useBusy();
  const save = () =>
    run(async () => {
      try {
        await store.api.setAppointmentKids(a.id, selected);
        onDone();
      } finally {
        reload();
      }
    });
  return (
    <section className="card stack" data-testid="appt-kids-editor">
      <strong>{t("appt.kids")}</strong>
      {!kids ? <p className="muted">{t("common.loading")}</p> : kids.length === 0 ? <p className="muted small">{t("kids.empty")}</p> : <KidPicker kids={kids} selected={selected} onChange={setSelected} disabled={busy} />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary grow" disabled={busy || !kids || kids.length === 0} onClick={() => void save()} data-testid="appt-kids-save">
          {t("appt.kidsSave")}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}

// ---------- rides: the sheet fields (C4 and Add ride) ----------

export interface RideDraft {
  pickup: Place | null;
  dropoff: Place | null;
  at: string;
  estKm: number | null;
  estMin: number | null;
  fareIsEstimate: boolean;
  /** The user changed the time: keep it when the route changes. */
  timeEdited: boolean;
}

export { derivedPickup };

export function initialDraft(a: AppointmentView, leg: Leg, home: Place | null): RideDraft {
  const place = a.place;
  return {
    pickup: leg === "there" ? home : place,
    dropoff: leg === "there" ? place : home,
    at: toLocalInput(derivedPickup(a, leg, 15)),
    estKm: null,
    estMin: null,
    fareIsEstimate: true,
    timeEdited: false
  };
}

function RideFields({ a, leg, value, onChange }: { a: AppointmentView; leg: Leg; value: RideDraft; onChange: (d: RideDraft) => void }) {
  const { t } = useI18n();
  const app = useApp();
  const dep = app.deployment!;
  const home = app.profile?.home ?? null;
  const { pickup, dropoff } = value;
  const key = pickup && dropoff ? `${pickup.lat},${pickup.lng}>${dropoff.lat},${dropoff.lng}` : "";
  useEffect(() => {
    if (!pickup || !dropoff) return;
    let live = true;
    void getRoute(pickup, dropoff, { timeoutMs: 2000 }).then((r) => {
      if (!live) return;
      onChange({
        ...value,
        estKm: r.km,
        estMin: r.min,
        fareIsEstimate: r.estimate,
        at: value.timeEdited ? value.at : toLocalInput(derivedPickup(a, leg, r.min))
      });
    });
    return () => {
      live = false;
    };
    // Recompute only when the places change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const atMs = fromInput(value.at);
  const fare = app.profile?.fixedFare ?? (value.estKm !== null && value.estMin !== null ? computeFare(dep.tariff, value.estKm, value.estMin) : null);
  return (
    <div className="stack">
      <PlaceInput label={t("rider.pickup")} value={pickup} onChange={(p) => onChange({ ...value, pickup: p })} home={home} testId={`ride-${leg}-pickup`} />
      <PlaceInput label={t("rider.dropoff")} value={dropoff} onChange={(p) => onChange({ ...value, dropoff: p })} home={home} testId={`ride-${leg}-dropoff`} />
      <label className="field">
        <span>{t("appt.pickupTime")}</span>
        <input type="datetime-local" step={300} value={value.at} onChange={(e) => onChange({ ...value, at: e.target.value, timeEdited: true })} data-testid={`ride-${leg}-time`} />
      </label>
      {fare !== null && (
        <p className="muted small">
          <Money amount={fare} currency={dep.tariff.currency} /> {value.fareIsEstimate && app.profile?.fixedFare == null ? `(${t("common.estimate")})` : ""}
        </p>
      )}
      {Number.isFinite(atMs) && atMs < Date.now() + dep.booking.minLeadMin * 60_000 && (
        <p className="hint" data-testid={`ride-${leg}-too-soon`}>
          {t("appt.tooSoon")}
        </p>
      )}
    </div>
  );
}

/** A ride draft the server would accept (V9): both places, a route, the time window and the leg rule. */
function draftProblem(a: AppointmentView, leg: Leg, d: RideDraft, minLeadMin: number): string | null {
  const at = fromInput(d.at);
  if (!d.pickup || !d.dropoff || d.estKm === null || d.estMin === null) return "places";
  if (!Number.isFinite(at) || at < Date.now() + minLeadMin * 60_000) return "soon";
  if ((leg === "there" && at >= a.startsAt) || (leg === "back" && at < a.startsAt)) return "leg";
  return null;
}

async function bookDraft(store: ReturnType<typeof useStore>, a: AppointmentView, leg: Leg, d: RideDraft, allRemaining: boolean): Promise<void> {
  const at = fromInput(d.at);
  if (allRemaining && a.series) {
    const template: RideTemplateInput = {
      leg,
      pickup: d.pickup!,
      dropoff: d.dropoff!,
      offsetMin: Math.round((at - (leg === "there" ? a.startsAt : a.endsAt)) / 60_000),
      estKm: d.estKm!,
      estMin: d.estMin!,
      fareIsEstimate: d.fareIsEstimate
    };
    await store.api.setRideTemplate(a.series.id, template);
  } else {
    await store.api.bookRide({ pickup: d.pickup!, dropoff: d.dropoff!, estKm: d.estKm!, estMin: d.estMin!, fareIsEstimate: d.fareIsEstimate, scheduledFor: at, appointmentId: a.id, leg });
  }
}

/**
 * C4: Accept, optionally with a ride there and / or back (on a series: for every occurrence).
 * `take` (2.1, FR-163): someone's open request — take it (the first taker wins; a series as a
 * whole), then book the ticked rides the same way. A retry after a failed ride books the rides only.
 */
function AcceptSheet({ a, take, onDone, reload }: { a: AppointmentView; take?: boolean; onDone: () => void; reload: () => void }) {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const home = app.profile?.home ?? null;
  const [want, setWant] = useState<Record<Leg, boolean>>({ there: false, back: false });
  const [drafts, setDrafts] = useState<Record<Leg, RideDraft>>({ there: initialDraft(a, "there", home), back: initialDraft(a, "back", home) });
  const [busy, run, error, setError] = useBusy();
  const minLead = app.deployment!.booking.minLeadMin;
  const legs = (["there", "back"] as const).filter((l) => want[l]);
  const blocked = legs.some((l) => draftProblem(a, l, drafts[l], minLead) !== null);
  // The take / accept happens once: when it went through but a ride failed, Confirm again only
  // books the rides not booked yet — taking again would be refused as taken (by the caller).
  const claimed = useRef<AppointmentView | null>(null);
  const booked = useRef(new Set<Leg>());
  const confirm = () =>
    run(async () => {
      try {
        let mine = claimed.current ?? a;
        if (!claimed.current) {
          // Take only while the view is still a candidate's (a reload may already show me as provider).
          if (take && a.role === "candidate") {
            try {
              mine = await store.api.takeRequest(a.id);
            } catch (e) {
              // Someone was faster, or it clashes with the taker's own schedule: say which.
              if (e instanceof ServerError && (e.code === "taken" || e.code === "overlap")) {
                setError(t(e.code === "taken" ? "open.taken" : "open.overlap"));
                return;
              }
              throw e;
            }
          } else if (!take && a.status === "requested") await store.api.answerAppointment(a.id, "accept");
          claimed.current = mine;
        }
        for (const leg of legs) {
          if (booked.current.has(leg)) continue;
          await bookDraft(store, mine, leg, drafts[leg], !!mine.series);
          booked.current.add(leg);
        }
        onDone();
      } finally {
        reload();
        await store.refresh().catch(() => {});
      }
    });
  return (
    <section className="card stack" data-testid={take ? "take-sheet" : "accept-sheet"}>
      <h3>{t(take ? "open.takeTitle" : "appt.acceptTitle")}</h3>
      {take && a.series && <p className="muted small">{t("open.takeSeries")}</p>}
      {a.place &&
        (["there", "back"] as const).map((leg) => (
          <div key={leg} className="stack">
            <label className="switch-row">
              <input type="checkbox" checked={want[leg]} onChange={(e) => setWant({ ...want, [leg]: e.target.checked })} data-testid={`need-ride-${leg}`} />
              <span>{t(leg === "there" ? "appt.needThere" : "appt.needBack")}</span>
            </label>
            {want[leg] && <RideFields a={a} leg={leg} value={drafts[leg]} onChange={(d) => setDrafts((x) => ({ ...x, [leg]: d }))} />}
          </div>
        ))}
      {a.series && legs.length > 0 && <p className="muted small">{t("appt.ridesRepeat", { days: app.deployment!.booking.maxDays })}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary grow"
          disabled={busy || blocked}
          onClick={() => void confirm()}
          data-testid={take ? "take-confirm" : "accept-confirm"}
        >
          {t("appt.confirmAccept")}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}

/** Add ride there / back to an accepted appointment (C3); on a series optionally for all remaining. */
function AddRide({ a, leg, onDone, reload }: { a: AppointmentView; leg: Leg; onDone: () => void; reload: () => void }) {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const [draft, setDraft] = useState(() => initialDraft(a, leg, app.profile?.home ?? null));
  const [all, setAll] = useState(!!a.series);
  const [busy, run, error] = useBusy();
  const problem = draftProblem(a, leg, draft, app.deployment!.booking.minLeadMin);
  const book = () =>
    run(async () => {
      try {
        await bookDraft(store, a, leg, draft, all);
        onDone();
      } finally {
        reload();
        await store.refresh().catch(() => {});
      }
    });
  return (
    <section className="card stack" data-testid={`add-ride-sheet-${leg}`}>
      <h3>{t("appt.addRide", { leg: t(`appt.leg.${leg}` as MessageKey) })}</h3>
      <RideFields a={a} leg={leg} value={draft} onChange={setDraft} />
      {a.series && (
        <label className="switch-row">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="ride-all-remaining" />
          <span>{t("appt.forAllRemaining")}</span>
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary grow" disabled={busy || problem !== null} onClick={() => void book()} data-testid={`book-ride-${leg}`}>
          {t("appt.bookRide")}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}

function RateBox({ a, onRated }: { a: AppointmentView; onRated: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, run, error] = useBusy();
  return (
    <section className="card stack" data-testid="appt-rate">
      <strong>{t("appt.rate", { name: otherName(a, t) })}</strong>
      <StarInput value={stars} onChange={setStars} disabled={busy} />
      <input value={comment} maxLength={140} onChange={(e) => setComment(e.target.value)} placeholder={t("receipt.comment")} aria-label={t("receipt.comment")} />
      {error && <p className="form-error">{error}</p>}
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || stars < 1}
        onClick={() => void run(async () => (await store.api.rateAppointment(a.id, stars, comment), onRated()))}
        data-testid="appt-rate-send"
      >
        {t("receipt.sendRating")}
      </button>
    </section>
  );
}
