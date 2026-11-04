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
// 2.5 (FR-230–233, FR-240–241): the session feed (updates with photos, about everyone or one kid)
// while it is open or has anything, the client's "I'm heading home" during the session and the
// notice it leaves for both parties.
// 2.14 (FR-334–339): either party proposes a change — a planned appointment's start, length, place
// and their own rides' pickups, or a live / just-finished one's length; the pending change is a
// card above everything with Accept / Decline (the other party) or Withdraw (the proposer).
// 2.14.2 (FR-346–347): a ride already on its way never blocks a change — it shows as a warning (it
// stays as booked); a done appointment has one Payment card — what counts, a pending change, the
// tip, the total with the tip and Propose another time frame (its sheet opens inside the card).

import { Icon } from "../components/Icon";
import { InfoTip } from "../components/InfoTip";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AddToCalendar } from "../components/AddToCalendar";
import { answerChangeOrBusy, apptRoom, isOpen, kidCountText, otherName, otherOf, partyText, rideLines, seriesMarker, statusChip } from "../components/apptWords";
import { ChatButton } from "../components/ChatSheet";
import { fromInput, roundUp, toLocalInput } from "../components/datetime";
import { AttachedKidCards, KidPicker, RateKidBox, useMyKids } from "../components/Kids";
import { PlaceInput } from "../components/PlaceInput";
import { PartyAvatar } from "../components/ProfileIcon";
import { ComingHomeBox, ComingLine, SessionFeedSection } from "../components/SessionFeed";
import { TipBox } from "../components/Tip";
import { rangeTimes, timeText, whenText } from "../components/when";
import { Money, Panel, RatingBadge, StarInput, useBusy } from "../components/ui";
import { computeFare } from "../core/fare";
import { haversineKm } from "../core/geo";
import { derivedPickup } from "../core/time";
import type { AppointmentView, AttachedRide, CatalogItem, ChangeInput, ChangeKind, ChangePickup, ChangeView, Leg, Place, RideTemplateInput } from "../core/types";
import { hasFeature, ServerError } from "../core/types";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { navigationUrl } from "../services/device";
import { getRoute } from "../services/routing";
import { useApp, useListsKey, useStore } from "../state/store";
import { durationText, EventIcon, localText } from "./Catalog";

export function AppointmentPanel() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const arg = app.panelArg ?? "";
  // "accept:<id>" opens C4 at once (To answer), "take:<id>" the take sheet (You could help),
  // 2.14 "change:<id>" the Propose a change sheet.
  const accepting = arg.startsWith("accept:");
  const taking = arg.startsWith("take:");
  const changing = arg.startsWith("change:");
  const id = accepting || changing ? arg.slice(7) : taking ? arg.slice(5) : arg;
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
        <AppointmentDetails a={a} reload={load} accepting={accepting} taking={taking} changing={changing} />
      )}
    </Panel>
  );
}

function AppointmentDetails({ a, reload, accepting, taking, changing }: { a: AppointmentView; reload: () => void; accepting: boolean; taking: boolean; changing?: boolean }) {
  const { t, lang, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const dep = app.deployment!;
  const now = store.serverNow();
  const [busy, run, error, setError] = useBusy();
  // 2.14 (FR-339): a party may propose a change (a pending one of the other side is countered by it);
  // only once the database does changes (V89: the app may go live before the SQL).
  const changes = hasFeature(dep, "changes");
  // 2.14.1 (FR-345): a move and/or a new length, whichever the appointment allows now — moves into
  // the past only once the database does them too ("pastMoves", V89), else the 2.14 rules.
  const pastMoves = hasFeature(dep, "pastMoves");
  const kinds = proposeKind(a, now, pastMoves);
  const canPropose = changes && kinds.length > 0 && !a.change?.mine;
  const [mode, setMode] = useState<"view" | "accept" | "take" | "cancel" | "kids" | "change" | Leg>(
    accepting && a.status === "requested" && a.role === "provider"
      ? "accept"
      : taking && a.status === "requested" && a.role === "candidate"
        ? "take"
        : changing && canPropose
          ? "change"
          : "view"
  );
  const [changeKind, setChangeKind] = useState<ChangeKind>(kinds[0] ?? "move");
  const openChange = (k: ChangeKind) => {
    setChangeKind(k);
    setMode("change");
  };
  const other = otherOf(a);
  const chip = statusChip(a, lang, t);
  const inProgress = a.status === "accepted" && a.startsAt <= now && now < a.endsAt;
  const marker = seriesMarker(a, t);
  const lines = rideLines(a, lang, t, dep.booking.maxDays, now);
  const myLegs = new Set(a.rides.filter((r) => r.mine && r.status !== "failed" && r.status !== "done").map((r) => r.leg));
  const myTemplates = a.series?.rideTemplates.filter((x) => x.mine) ?? [];
  // 2.6 (FR-254): the family sees all of it but none of the actions.
  const family = a.role === "family";
  const canCancel = !family && (a.status === "accepted" || (a.status === "requested" && a.role === "client")) && now < a.startsAt;
  const canAddRide = !family && a.status === "accepted" && now < a.endsAt && !!a.place;
  const rateUntil = (a.endedAt ?? a.endsAt) + 24 * 3600_000;
  const canRate = !family && a.status === "done" && a.myRating === null && now < rateUntil;
  // 2.3: the kids — the client changes them until the end (FR-201), given they have kids to attach
  // (C20); the provider rates each once it is done, within 24 h (FR-203); a candidate learns only
  // the count (FR-202).
  const kids = a.kids ?? [];
  const [myKids] = useMyKids(a.role === "client");
  const canChangeKids = a.role === "client" && (a.status === "requested" || a.status === "accepted") && now < a.endsAt && !!myKids && myKids.length > 0;
  const showKids = kids.length > 0 || canChangeKids || (a.role === "candidate" && a.kidCount > 0);
  const kidsToRate = a.status === "done" && a.role === "provider" ? kids.filter((k) => k.myRating !== null || now < rateUntil) : [];
  const room = apptRoom(a);
  const done = a.status === "done";

  const act = (fn: () => Promise<unknown>) =>
    run(async () => {
      try {
        await fn();
      } finally {
        reload();
        await store.refresh().catch(() => {});
      }
    });
  // 2.14: an overlap on accepting is the provider's clash — the client is told so, not "you have a booking".
  const acceptChange = async () => {
    let theirs = false;
    await act(() => answerChangeOrBusy(store.api, a, () => (theirs = true)));
    if (theirs) setError(t("change.providerBusy", { name: otherName(a, t) }));
  };
  const sheet = mode === "change" && (
    <ProposeChange a={a} kinds={kinds} past={pastMoves} initial={kinds.includes(changeKind) ? changeKind : (kinds[0] ?? "length")} onDone={() => setMode("view")} reload={reload} />
  );

  return (
    <div className="stack" data-testid="appointment">
      <section className="card stack">
        <div className="row spread">
          <strong className="appt-title">
            <EventIcon icon={a.service?.icon ?? "📅"} serviceId={a.serviceId} /> {localText(a.service?.name, lang) || a.serviceId}
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
          <PartyAvatar p={other} />
          <span>{partyText(a, t)}</span>
          {other && <RatingBadge rating={other.rating} />}
        </p>
        <p data-testid="appt-place">
          <Icon name="place" className="ico-inline" /> {a.place ? a.place.label : t("appt.noPlace")}{" "}
          {a.place && (
            <a className="btn btn-link btn-small" href={navigationUrl(a.place)} target="_blank" rel="noreferrer">
              {t("appt.map")}
            </a>
          )}
        </p>
        {a.note && <p className="note" data-testid="appt-note">„{a.note}”</p>}
        {a.price !== null && !a.cost && (
          <p data-testid="appt-price">
            <Money amount={a.price} currency={a.currency} />
            {a.rate !== null && (
              <small className="muted">
                {" · "}
                {t("cost.planned", { rate: money(a.rate, a.currency, locale), source: t(a.contractId ? "cost.source.contract" : "cost.source.catalog") })}
                {/* 2.12.2: an estimate only while it may still happen (rate × the booked time) */}
                {(a.status === "requested" || a.status === "accepted") && ` · ${t("common.estimate")}`}
              </small>
            )}
            {a.customPrice && (
              <small className="muted" data-testid="appt-price-custom">
                {" · "}
                {t("cost.source.custom")}
              </small>
            )}
          </p>
        )}
        {family && a.family && (
          <p className="muted small" data-testid="appt-family">
            {t("family.readOnly", { member: a.family.member })}
          </p>
        )}
        {a.status === "cancelled" && a.cancelledBy && (
          <p className="muted small">
            {t(`appt.cancelledBy.${a.cancelledBy}` as MessageKey, { name: a.cancelledBy === "client" ? a.client.nickname : (a.provider?.nickname ?? t("appt.anyone")) })}
          </p>
        )}
      </section>

      {/* 2.14.2 (FR-347): a done appointment's pending change sits in its Payment card instead */}
      {a.change && !done && <ChangeCard a={a} c={a.change} busy={busy} act={act} accept={acceptChange} />}

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

      {done && a.role !== "candidate" && (
        <PaymentSection
          a={a}
          reload={reload}
          changes={changes}
          moves={kinds.includes("move")}
          changeCard={a.change && <ChangeCard a={a} c={a.change} busy={busy} act={act} accept={acceptChange} inline />}
          onPropose={canPropose && mode === "view" ? () => openChange(kinds[0]) : undefined}
          sheet={sheet}
        />
      )}

      {a.role !== "candidate" && a.coming && <ComingLine a={a} />}
      {a.role !== "candidate" && (a.updateCount > 0 || a.feedOpen) && <SessionFeedSection a={a} />}

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
      {!done && sheet}

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
                    <Icon name="car" className="ico-inline" /> {t(a.series ? "appt.addRideAll" : "appt.addRide", { leg: t(`appt.leg.${leg}` as MessageKey) })}
                  </button>
                ))}
            </div>
          )}
          {room && (
            <div className="row wrap">
              <ChatButton room={room} unread={a.unread} />
              <ComingHomeBox a={a} reload={reload} />
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
          {canPropose && !done && (
            <button type="button" className="btn btn-secondary" onClick={() => openChange(kinds[0] ?? "move")} data-testid="appt-change">
              <Icon name="calendar" className="ico-inline" /> {t("change.propose")}
            </button>
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

const money = (amount: number, currency: string, locale: string) => {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

/** 2.9 (FR-314): the client side (the client or their family) may tip within 7 days; null = no tip line at all. */
function tipState(a: AppointmentView, now: number): "given" | "choices" | null {
  if (a.status !== "done" || !a.provider || a.role === "candidate") return null;
  if (a.tip) return "given";
  const clientSide = a.role === "client" || (a.role === "family" && a.family?.side === "client");
  return clientSide && now <= (a.endedAt ?? a.endsAt) + 7 * 24 * 3600_000 ? "choices" : null;
}

/**
 * 2.14.2 (FR-347, V98): the Payment of a done appointment — one card for the two parties and their
 * families, in this order: what counts (2.6, FR-270: the time counted, the rate and where it came
 * from, the total), a pending change (FR-339), the tip (2.9, FR-314), the total with the tip, and
 * Propose another time frame (FR-342, its sheet opens here). A database without change proposals
 * (V89) keeps the provider's 2.6 Correct the time instead. The family sees it all, none of the actions.
 */
function PaymentSection({
  a,
  reload,
  changes,
  moves,
  changeCard,
  onPropose,
  sheet
}: {
  a: AppointmentView;
  reload: () => void;
  changes: boolean;
  /** A move may be proposed (else only a new length): which hint the i explains. */
  moves: boolean;
  changeCard: ReactNode;
  onPropose?: () => void;
  sheet: ReactNode;
}) {
  const { t, locale } = useI18n();
  const store = useStore();
  const now = store.serverNow();
  const cost = a.cost;
  const tip = tipState(a, now);
  // A database before 2.14 (no "changes", V89): the provider still corrects the time one-sidedly (2.6).
  const canCorrect = !!cost && !changes && a.role === "provider" && now < (a.endedAt ?? a.endsAt) + 24 * 3600_000;
  const withTip = cost?.total != null && a.tip ? round2(cost.total + a.tip.amount) : null;
  const setAmount = cost?.rate === null;
  if (!cost && !tip && !changeCard && !onPropose && !sheet) return null;
  return (
    <section className="card stack" data-testid="appt-payment">
      <strong>{t("payment.title")}</strong>
      {cost && (
        <div className="stack" data-testid="appt-cost">
          <div className="kv">
            <span>{t("cost.time")}</span>
            <span data-testid="cost-time">{durationText(cost.minutes, t)}</span>
          </div>
          {cost.corrected && <small className="muted" data-testid="cost-corrected">{t("cost.corrected", { time: durationText(a.durationMin, t) })}</small>}
          {cost.rate !== null && (
            <div className="kv">
              <span>{t("cost.rate")}</span>
              <span data-testid="cost-rate">
                {t("cost.perHour", { rate: money(cost.rate, cost.currency, locale) })} · {t(`cost.source.${cost.source}` as MessageKey)}
              </span>
            </div>
          )}
          {/* 2.12.2: a set amount (custom or a fixed price) says so; the time does not change it */}
          {cost.rate === null && (cost.source === "custom" || cost.source === "fixed") && (
            <div className="kv">
              <span>{t("cost.price")}</span>
              <span data-testid="cost-source">{t(`cost.source.${cost.source}` as MessageKey)}</span>
            </div>
          )}
          <div className="kv big">
            <span>{t("cost.total")}</span>
            {cost.total === null ? (
              <span className="muted" data-testid="cost-total">
                {t("cost.none")}
              </span>
            ) : (
              <strong className="cost-total" data-testid="cost-total">
                <Money amount={cost.total} currency={cost.currency} />
              </strong>
            )}
          </div>
        </div>
      )}
      {changeCard}
      {tip === "given" && a.tip && (
        <p className="notice notice-ok" data-testid="appt-tip">
          <Icon name="sparkles" className="ico-inline" />{" "}
          {/* FR-347: by whom — "You" only to the one who gave it (a family member may tip for the client) */}
          {a.tip.mine || (a.role === "client" && !a.tip.by) ? (
            <span data-testid="tip-given">{t("tip.given", { amount: money(a.tip.amount, a.currency, locale) })}</span>
          ) : (
            t("tip.givenBy", { who: a.tip.by || a.client.nickname, amount: money(a.tip.amount, a.currency, locale) })
          )}
        </p>
      )}
      {tip === "choices" && (
        <div data-testid="appt-tip">
          <TipBox
            currency={a.currency}
            max={1000}
            suggested={[10, 20, 50]}
            tip={null}
            onTip={async (n) => {
              await store.api.tipAppointment(a.id, n);
              reload();
            }}
          />
        </div>
      )}
      {withTip !== null && (
        <div className="kv big" data-testid="payment-total-tip">
          <span>{t("payment.totalTip")}</span>
          <strong>
            <Money amount={withTip} currency={cost!.currency} />
          </strong>
        </div>
      )}
      {onPropose && (
        <span className="with-info">
          <button type="button" className="btn btn-secondary btn-small" onClick={onPropose} data-testid="payment-propose">
            <Icon name="calendar" className="ico-inline" /> {t("payment.propose")}
          </button>
          <InfoTip
            text={t(moves ? (setAmount ? "payment.proposeHintSet" : "payment.proposeHint") : setAmount ? "change.lengthHintSet" : "change.lengthHint")}
            testId="payment-propose"
          />
        </span>
      )}
      {canCorrect && <CorrectTime a={a} reload={reload} />}
      {sheet}
    </section>
  );
}

/** 2.6 Correct the time (the provider alone), kept for a database without change proposals (V89). */
function CorrectTime({ a, reload }: { a: AppointmentView; reload: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  const cost = a.cost!;
  const [busy, run, error] = useBusy();
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(cost.minutes);
  const choices: number[] = [];
  for (let m = Math.max(15, a.durationMin - 180); m <= Math.min(1440, a.durationMin + 360); m += 15) choices.push(m);
  return (
    <>
      {editing ? (
        <div className="stack">
          <label className="field">
            <span className="with-info">
              {t("cost.correct")}
              <InfoTip text={t(cost.rate === null ? "cost.correctHintSet" : "cost.correctHint")} testId="cost-correct" />
            </span>
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} data-testid="cost-minutes">
              {choices.map((m) => (
                <option key={m} value={m}>
                  {durationText(m, t)}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary grow"
              disabled={busy || minutes === cost.minutes}
              onClick={() =>
                void run(async () => {
                  await store.api.setActualTime(a.id, minutes);
                  setEditing(false);
                  reload();
                })
              }
              data-testid="cost-save"
            >
              {t("cost.correctSave")}
            </button>
            <button type="button" className="btn btn-secondary grow" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-link btn-small" onClick={() => setEditing(true)} data-testid="cost-correct">
          {t("cost.correct")}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
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

// ---------- 2.14: proposing a change (FR-334–339) ----------

const DAY_MS = 24 * 3600_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** How far back a move may go, and how long after the end a done appointment may still be moved (FR-342). */
const BACK_MS = 30 * DAY_MS;

/**
 * What the viewer may propose now (FR-334, FR-335, FR-342, V96), move first: a move of an accepted
 * appointment at any time or of a done one until 30 days after its end; a new length while it runs
 * or within 24 h after the end — the two parties only (not their families, V60); empty = nothing.
 * A database before 2.14.1 (no "pastMoves", V89) keeps the 2.14 rules: a move before the start,
 * a new length while it runs or within 24 h after the end.
 */
export function proposeKind(a: AppointmentView, now: number, pastMoves = true): ChangeKind[] {
  if (a.role !== "client" && a.role !== "provider") return [];
  const end = a.endedAt ?? a.endsAt;
  const kinds: ChangeKind[] = [];
  if (!pastMoves) {
    if (a.status === "accepted" && now < a.startsAt) kinds.push("move");
    else if ((a.status === "accepted" && now < a.endsAt) || (a.status === "done" && now <= end + DAY_MS)) kinds.push("length");
    return kinds;
  }
  if (a.status === "accepted" || (a.status === "done" && now <= end + BACK_MS)) kinds.push("move");
  if ((a.status === "accepted" && a.startsAt <= now && now < a.endsAt) || (a.status === "done" && now <= end + DAY_MS)) kinds.push("length");
  return kinds;
}

const samePlace = (p: Place | null, q: Place | null) => (p === null || q === null ? p === q : p.label === q.label && p.lat === q.lat && p.lng === q.lng);

/**
 * 2.14.2 (FR-346, V97): an attached ride already handed to drivers or being driven, as the server
 * judges it (requested, accepted, arrived, in_progress). A booking held past its window while its
 * rider or driver is still busy is still booked ahead: it follows the change.
 */
function rideUnderway(r: AttachedRide): boolean {
  return (r.status === "pending" || r.status === "confirmed") && r.underway === true;
}

/** "Ride back is already on its way — it stays as booked; agree any change with the driver (chat)" (FR-346). */
function UnderwayLine({ leg, testId }: { leg: Leg; testId: string }) {
  const { t } = useI18n();
  return (
    <p className="notice notice-warn small" data-testid={testId}>
      <Icon name="car" className="ico-inline" /> {t("change.ride.underway", { leg: t(`appt.leg.${leg}` as MessageKey) })}
    </p>
  );
}

/**
 * The pending change as a card above everything (FR-339) — or, on a done appointment, inside its
 * Payment card (`inline`, FR-347): old → new, what each ride does, the note, the answer.
 */
function ChangeCard({ a, c, busy, act, accept, inline }: { a: AppointmentView; c: ChangeView; busy: boolean; act: (fn: () => Promise<unknown>) => unknown; accept: () => unknown; inline?: boolean }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const now = store.serverNow();
  const name = otherName(a, t);
  const done = a.status === "done";
  // 2.14.1: a move of a done appointment shows its new time and length too (FR-343).
  const move = c.kind === "move";
  const was = (old: string) => <small className="muted"> ({t("change.was", { old })})</small>;
  const timeChanged = c.startsAt !== a.startsAt || c.endsAt !== a.endsAt;
  const counted = a.cost?.minutes ?? a.actualMin ?? a.durationMin;
  const oldPrice = done ? (a.cost?.total ?? null) : a.price;
  const legWord = (leg: Leg) => t(`appt.leg.${leg}` as MessageKey);
  const rideTime = (ms: number | null) => (ms !== null ? timeText(ms, locale) : "—");
  return (
    <section className={inline ? "notice notice-info stack" : "card stack"} data-testid="change-card">
      <strong>{c.mine ? t("change.cardMine", { name }) : t("change.cardTheirs", { name })}</strong>
      {(move || !done) && timeChanged && (
        <p data-testid="change-when">
          {t("change.when")}: {whenText(c.startsAt, now, locale, t)} · {rangeTimes(c.startsAt, c.endsAt, locale)}
          {was(`${whenText(a.startsAt, now, locale, t)} · ${rangeTimes(a.startsAt, a.endsAt, locale)}`)}
        </p>
      )}
      {(move || !done) && c.durationMin !== (done ? counted : a.durationMin) && (
        <p data-testid="change-length">
          {t("change.length")}: {durationText(c.durationMin, t)}
          {was(durationText(done ? counted : a.durationMin, t))}
        </p>
      )}
      {done && !move && c.minutes !== null && (
        <p data-testid="change-length">
          {t("change.counted")}: {durationText(c.minutes, t)}
          {was(durationText(counted, t))}
        </p>
      )}
      {!samePlace(c.place, a.place) && (
        <p data-testid="change-place-line">
          <Icon name="place" className="ico-inline" /> {c.place ? c.place.label : t("appt.noPlace")}
          {was(a.place ? a.place.label : t("appt.noPlace"))}
        </p>
      )}
      {c.price !== null && (
        <p data-testid="change-price">
          {t(done ? "change.total" : "change.price")}: <Money amount={c.price} currency={a.currency} />
          {oldPrice !== null && oldPrice !== c.price && was(money(oldPrice, a.currency, locale))}
        </p>
      )}
      {c.rides.map((r) =>
        // 2.14.2 (FR-346): a ride already on its way stays as booked — a warning, not a refusal.
        r.effect === "underway" ? (
          <UnderwayLine key={r.rideId} leg={r.leg} testId={`change-ride-${r.leg}`} />
        ) : (
          <p key={r.rideId} className="ride-line small" data-testid={`change-ride-${r.leg}`}>
            {r.effect === "cancel"
              ? t("change.ride.cancel", { leg: legWord(r.leg) })
              : r.effect === "move"
                ? t("change.ride.move", { leg: legWord(r.leg), time: rideTime(r.to) })
                : t("change.ride.keep", { leg: legWord(r.leg), time: rideTime(r.from ?? r.to) })}
            {r.effect === "move" && r.pickup && ` · ${t("change.ride.pickup", { place: r.pickup.label })}`}
            {r.effect === "move" && r.fare !== undefined && (
              <>
                {" · "}
                <Money amount={r.fare} currency={a.currency} />
              </>
            )}
          </p>
        )
      )}
      {c.note && (
        <p className="note" data-testid="change-note-text">
          „{c.note}”
        </p>
      )}
      <small className="muted" data-testid="change-expires">
        {t("change.expires", { when: whenText(c.expiresAt, now, locale, t) })}
      </small>
      {c.mine ? (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act(() => store.api.withdrawChange(a.id))} data-testid="change-withdraw">
          {t("change.withdraw")}
        </button>
      ) : (
        <div className="row">
          <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => void accept()} data-testid="change-accept">
            {t("change.accept")}
          </button>
          <button type="button" className="btn btn-secondary grow" disabled={busy} onClick={() => void act(() => store.api.answerChange(a.id, "decline"))} data-testid="change-decline">
            {t("change.decline")}
          </button>
        </div>
      )}
    </section>
  );
}

/** Where a new pickup's route goes: a there ride at the old place follows a moved place (FR-337). */
function pickupTarget(leg: Leg, dropoff: Place | null | undefined, from: Place | null, to: Place | null): Place | null {
  if (leg === "there" && dropoff && from && to && !samePlace(to, from) && haversineKm(dropoff, from) <= 0.15) return to;
  return dropoff ?? from;
}

interface PickupDraft {
  pickup: Place | null;
  estKm: number | null;
  estMin: number | null;
  fareIsEstimate: boolean;
}

const NO_PICKUP: PickupDraft = { pickup: null, estKm: null, estMin: null, fareIsEstimate: true };

/** A new pickup for one of my rides, with the phone's route estimate to its dropoff (as in RideFields). */
function PickupField({ leg, to, value, onChange }: { leg: Leg; to: Place | null; value: PickupDraft; onChange: (d: PickupDraft) => void }) {
  const { t } = useI18n();
  const app = useApp();
  const dep = app.deployment!;
  const { pickup } = value;
  const key = pickup && to ? `${pickup.lat},${pickup.lng}>${to.lat},${to.lng}` : "";
  useEffect(() => {
    if (!pickup || !to) return;
    let live = true;
    void getRoute(pickup, to, { timeoutMs: 2000 }).then((r) => {
      if (live) onChange({ pickup, estKm: r.km, estMin: r.min, fareIsEstimate: r.estimate });
    });
    return () => {
      live = false;
    };
    // Recompute only when the places change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fare = value.estKm !== null && value.estMin !== null ? (app.profile?.fixedFare ?? computeFare(dep.tariff, value.estKm, value.estMin)) : null;
  return (
    <div className="stack">
      <PlaceInput
        label={t("change.pickup", { leg: t(`appt.leg.${leg}` as MessageKey) })}
        value={pickup}
        onChange={(p) => {
          // The same place again (a double tap on Home) keeps its estimate: no new route would come.
          if (p && pickup && p.lat === pickup.lat && p.lng === pickup.lng) {
            if (p.label !== pickup.label) onChange({ ...value, pickup: p });
            return;
          }
          onChange({ ...NO_PICKUP, pickup: p });
        }}
        home={app.profile?.home ?? null}
        testId={`change-pickup-${leg}`}
        optional
      />
      {pickup && fare !== null && (
        <p className="muted small" data-testid={`change-pickup-${leg}-fare`}>
          <Money amount={fare} currency={dep.tariff.currency} /> {value.fareIsEstimate && app.profile?.fixedFare == null ? `(${t("common.estimate")})` : ""}
        </p>
      )}
    </div>
  );
}

/**
 * The Propose a change sheet (FR-334, FR-335, FR-345): a move — the start (as far back as 30 days),
 * length, place, a new pickup for each of my rides still ahead and a note; while it runs or within
 * 24 h after the end the new length; where both are allowed a switch Time and place / Length only.
 * The new end and price (or total) show as previews; the server checks everything again (V96).
 */
function ProposeChange({ a, kinds, past = true, initial, onDone, reload }: { a: AppointmentView; kinds: ChangeKind[]; past?: boolean; initial: ChangeKind; onDone: () => void; reload: () => void }) {
  const { t, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const dep = app.deployment!;
  const [kind, setKind] = useState<ChangeKind>(initial);
  const done = a.status === "done";
  const nowMs = store.serverNow();
  const startId = useId();
  const [busy, run, error, setError] = useBusy();
  const [entry, setEntry] = useState<CatalogItem | null>(null);
  useEffect(() => {
    let live = true;
    store.api.catalog().then(
      (all) => {
        if (live) setEntry(all.find((x) => x.id === a.serviceId) ?? null);
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, [store, a.serviceId]);
  const [start, setStart] = useState(() => toLocalInput(a.startsAt));
  const [place, setPlace] = useState<Place | null>(a.place);
  const [pickups, setPickups] = useState<Partial<Record<Leg, PickupDraft>>>({});
  const current = done ? (a.cost?.minutes ?? a.actualMin ?? a.durationMin) : a.durationMin;
  const [minutes, setMinutes] = useState(current);
  const [note, setNote] = useState("");

  // The entry's lengths (as C2 offers them), the current one always among them.
  const d = entry?.duration ?? { min: 15, max: 1440, step: 15 };
  // A move of a done appointment starts from the length that counts (an agreed correction stays
  // unless changed, FR-343) — when the entry allows it (the server's bad_duration), else the booked one.
  const fits = (m: number) => m >= d.min && m <= d.max && (m - d.min) % d.step === 0;
  const defaultDuration = done && current !== a.durationMin && fits(current) ? current : a.durationMin;
  const [picked, setDuration] = useState<number | null>(null);
  const duration = picked ?? defaultDuration;
  const durations: number[] = [];
  for (let m = d.min; m <= d.max; m += Math.max(5, d.step)) durations.push(m);
  for (const m of [a.durationMin, defaultDuration]) if (!durations.includes(m)) durations.push(m);
  durations.sort((x, y) => x - y);
  // A new length in 15-minute steps around the booked one (as the 2.6 correction offered).
  const lengths: number[] = [];
  for (let m = Math.max(15, a.durationMin - 180); m <= Math.min(1440, a.durationMin + 360); m += 15) lengths.push(m);
  if (!lengths.includes(current)) lengths.push(current);
  lengths.sort((x, y) => x - y);

  // A new pickup only for my rides still booked ahead (a done appointment's rides are behind it; a
  // ride already on its way keeps its pickup — the server's ride_started, FR-346).
  const myRides = done
    ? []
    : a.rides.filter((r) => r.mine && (r.status === "pending" || r.status === "confirmed") && r.scheduledFor !== null && r.scheduledFor > nowMs && !rideUnderway(r));
  const startMs = fromInput(start);
  const chosen = (Object.entries(pickups) as [Leg, PickupDraft][]).filter(([, p]) => p.pickup);
  const estimating = chosen.some(([, p]) => p.estKm === null || p.estMin === null);
  const length = kind === "move" ? duration : minutes;
  const newStart = kind === "move" ? startMs : a.startsAt;
  const newEnd = newStart + length * 60_000;
  const price = a.rate !== null ? round2((a.rate * length) / 60) : done ? (a.cost?.total ?? null) : a.price;
  const same = kind === "move" ? startMs === a.startsAt && duration === a.durationMin && samePlace(place, a.place) && chosen.length === 0 : minutes === current;
  const needsPlace = entry ? entry.needsPlace : !!a.place;
  // The server's time rules, checked here first (FR-342, V96): 30 days back at most, maxDays ahead,
  // a start still ahead keeps the booking lead, a done appointment stays in the past.
  const lead = dep.booking.minLeadMin * 60_000;
  const problem: string | null =
    !past || kind !== "move" || !Number.isFinite(startMs)
      ? null
      : startMs < nowMs - BACK_MS
        ? t("change.tooOld")
        : startMs > nowMs + dep.booking.maxDays * DAY_MS
          ? t("change.tooFar", { days: dep.booking.maxDays })
          : done && newEnd > nowMs
            ? t("change.doneFuture")
            : startMs > nowMs && startMs < nowMs + lead
              ? t("change.inLead", { min: dep.booking.minLeadMin })
              : null;
  // 2.14.2 (FR-346, V97): the rides already on their way that this change would move or re-place —
  // they stay as booked (a warning; the change still goes through). A done appointment moves no ride.
  const placeMoved = kind === "move" && !samePlace(place, a.place);
  const underway =
    done || same || !Number.isFinite(newEnd)
      ? []
      : a.rides.filter((r) => rideUnderway(r) && (placeMoved || (r.leg === "there" ? newStart !== a.startsAt : newEnd !== a.endsAt)));
  const blocked = busy || same || estimating || problem !== null || (kind === "move" && (!Number.isFinite(startMs) || (needsPlace && !place)));

  const send = async () => {
    // The server's bad_time / window_closed name a ride; for a change they get their own words.
    let refused: "bad_time" | "window_closed" | null = null;
    await run(async () => {
      try {
        const input: ChangeInput =
          kind === "move"
            ? {
                kind,
                startsAt: startMs,
                durationMin: duration,
                place,
                pickups: chosen.map(([leg, p]): ChangePickup => ({ leg, pickup: p.pickup!, estKm: p.estKm!, estMin: p.estMin!, fareIsEstimate: p.fareIsEstimate })),
                note: note.trim()
              }
            : { kind, minutes, note: note.trim() };
        try {
          await store.api.proposeChange(a.id, input);
        } catch (e) {
          // (a database before 2.14.1 keeps the 2.14 words: those texts describe the 2.14.1 rules)
          if (past && e instanceof ServerError && (e.code === "bad_time" || e.code === "window_closed")) {
            refused = e.code;
            return;
          }
          throw e;
        }
        onDone();
      } finally {
        reload();
        await store.refresh().catch(() => {});
      }
    });
    if (refused) setError(t(refused === "bad_time" ? "change.badTime" : "change.windowClosed"));
  };

  return (
    <section className="card stack" data-testid="change-sheet">
      <h3 className="with-info">
        {t(kind === "move" ? "change.titleMove" : "change.titleLength")}
        <InfoTip text={t(kind === "move" ? (done ? "change.hintMoveDone" : "change.hintMove") : "change.hintLength", { name: otherName(a, t) })} testId="change" />
      </h3>
      {kinds.length > 1 && (
        <div className="segmented" role="group" aria-label={t("change.modeLabel")}>
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={kind === k ? "btn btn-primary" : "btn btn-secondary"}
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                setError(null);
              }}
              data-testid={`change-mode-${k}`}
            >
              {t(k === "move" ? "change.modeMove" : "change.modeLength")}
            </button>
          ))}
        </div>
      )}
      {kind === "move" ? (
        <>
          <div className="field">
            <span className="with-info">
              <label htmlFor={startId}>{t("change.start")}</label>
              {past && <InfoTip text={t("change.hintPast")} testId="change-past" />}
            </span>
            <input
              id={startId}
              type="datetime-local"
              value={start}
              min={toLocalInput(past ? roundUp(nowMs - BACK_MS, 15) : roundUp(nowMs + (dep.booking.minLeadMin + 1) * 60_000, 15))}
              max={toLocalInput(nowMs + dep.booking.maxDays * DAY_MS)}
              step={900}
              onChange={(e) => setStart(e.target.value)}
              data-testid="change-start"
            />
          </div>
          <label className="field">
            <span>{t("change.duration")}</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} data-testid="change-duration">
              {durations.map((m) => (
                <option key={m} value={m}>
                  {durationText(m, t)}
                </option>
              ))}
            </select>
          </label>
          {(a.place || needsPlace) && <PlaceInput label={t("change.place")} value={place} onChange={setPlace} home={app.profile?.home ?? null} testId="change-place" optional={!needsPlace} />}
          {myRides.map((r) => (
            <PickupField key={r.rideId} leg={r.leg} to={pickupTarget(r.leg, r.dropoff, a.place, place)} value={pickups[r.leg] ?? NO_PICKUP} onChange={(p) => setPickups((x) => ({ ...x, [r.leg]: p }))} />
          ))}
        </>
      ) : (
        <label className="field">
          <span>{t("change.minutes")}</span>
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} data-testid="change-minutes">
            {lengths.map((m) => (
              <option key={m} value={m}>
                {durationText(m, t)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>{t("change.note")}</span>
        <textarea value={note} maxLength={200} rows={2} onChange={(e) => setNote(e.target.value)} data-testid="change-note" />
      </label>
      {Number.isFinite(newEnd) && (
        <p className="muted small" data-testid="change-preview">
          {(kind === "move" || !done) && t("change.ends", { time: timeText(newEnd, locale) })}
          {done && kind === "move" && length !== current && (
            <span data-testid="change-preview-length">
              {" · "}
              {t("change.length")}: {durationText(length, t)} ({t("change.was", { old: durationText(current, t) })})
            </span>
          )}
          {price !== null && (
            <>
              {(kind === "move" || !done) && " · "}
              {t(done ? "change.total" : "change.price")}: <Money amount={price} currency={a.currency} />
              {done && kind === "move" && a.cost?.total != null && a.cost.total !== price && (
                <span data-testid="change-preview-was">
                  {" "}
                  ({t("change.was", { old: money(a.cost.total, a.currency, locale) })})
                </span>
              )}
            </>
          )}
        </p>
      )}
      {underway.length > 0 && (
        <div className="stack" data-testid="change-underway">
          {underway.map((r) => (
            <UnderwayLine key={r.rideId} leg={r.leg} testId={`change-underway-${r.leg}`} />
          ))}
          <small className="muted">{t("change.underwayHint")}</small>
        </div>
      )}
      {same && (
        <p className="hint" data-testid="change-same">
          {t("change.same")}
        </p>
      )}
      {!same && problem && (
        <p className="hint" data-testid="change-problem">
          {problem}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary grow" disabled={blocked} onClick={() => void send()} data-testid="change-send">
          {t("change.send")}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}
