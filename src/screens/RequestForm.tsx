// C2 Request form (FR-094, FR-107): provider (preselected when only one offers it), date and start
// time (15-minute steps, at least booking.minLeadMin ahead), duration, repeat (none / weekly /
// every 2 weeks; until a date or a number of times), place (default My place), note, the price per
// occurrence when the entry has one. Send request stays disabled until the form is valid.
// 2.1 (FR-094, FR-161): "Anyone who can" sends an open request (providerId null) that everyone in
// the group sees until someone takes it; preselected when nobody offers the entry.
// 2.3 (FR-201): a client with kids ticks the ones who will be there; they travel as kidIds (a
// series: to every occurrence) and the provider sees them — nobody else.
// 2.12.2: Payment — at the rate (a contract's, else the price list's; a YOLO event without a price of
// its own takes its base's, the Childcare rate) or a custom amount for the whole event (each time).

import { useEffect, useMemo, useState } from "react";
import { InfoTip } from "../components/InfoTip";
import { fromInput, roundUp, seriesStarts, toDateInput, toLocalInput } from "../components/datetime";
import { KidPicker, useMyKids } from "../components/Kids";
import { PlaceInput } from "../components/PlaceInput";
import { durationText, EntryIcon, localText } from "./Catalog";
import { Money, Panel, RatingBadge, useBusy } from "../components/ui";
import { CUSTOM_PRICE_MAX } from "../core/fare";
import type { CatalogItem, Place, RepeatInput } from "../core/types";
import { useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";

type Repeat = "none" | "weekly" | "biweekly";

/** The provider choice "Anyone who can" (an open request). */
const ANYONE = "*anyone";

export function RequestPanel() {
  const { t, lang, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const [entry, setEntry] = useState<CatalogItem | null>(null);
  // Never Loading for ever: a failed load offers Retry; an entry gone from the catalog says so.
  const [state, setState] = useState<"loading" | "failed" | "gone" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    store.api.catalog().then(
      (all) => {
        if (!live) return;
        const e = all.find((x) => x.id === app.panelArg && x.kind === "time" && x.duration) ?? null;
        setEntry(e);
        setState(e ? "ready" : "gone");
      },
      () => {
        if (live) setState("failed");
      }
    );
    return () => {
      live = false;
    };
  }, [store, app.panelArg, attempt]);
  return (
    <Panel title={entry ? localText(entry.name, lang) : t("request.title")} onClose={() => store.closePanel()}>
      {state === "ready" && entry ? (
        <RequestForm key={entry.id} entry={entry} locale={locale} />
      ) : state === "failed" ? (
        <div className="stack" data-testid="request-failed">
          <p className="form-error">{t("request.error")}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setState("loading");
              setAttempt((n) => n + 1);
            }}
            data-testid="request-retry"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : state === "gone" ? (
        <p className="muted" data-testid="request-gone">
          {t("request.gone")}
        </p>
      ) : (
        <p className="muted">{t("common.loading")}</p>
      )}
    </Panel>
  );
}

function RequestForm({ entry, locale }: { entry: CatalogItem; locale: string }) {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const dep = app.deployment!;
  const [busy, run, error] = useBusy();
  const d = entry.duration!;
  const [provider, setProvider] = useState(
    entry.providers.length === 0 ? ANYONE : entry.providers.length === 1 ? (entry.providers[0].publicId ?? "") : ""
  );
  const open = provider === ANYONE;
  const minStart = roundUp(Date.now() + (dep.booking.minLeadMin + 1) * 60_000, 15);
  const [start, setStart] = useState(() => toLocalInput(roundUp(Date.now() + 24 * 3600_000, 60)));
  const [duration, setDuration] = useState(d.default);
  const [repeat, setRepeat] = useState<Repeat>("none");
  const [by, setBy] = useState<"times" | "until">("times");
  const [times, setTimes] = useState(4);
  const [until, setUntil] = useState(() => toDateInput(Date.now() + 30 * 86_400_000));
  const home = app.profile?.home ?? null;
  const [place, setPlace] = useState<Place | null>(home);
  const [keepHome, setKeepHome] = useState(false);
  const [note, setNote] = useState("");
  // The picker shows only to a client who has kids (none: nothing to tick).
  const [kids] = useMyKids();
  const [kidIds, setKidIds] = useState<string[]>([]);
  // 2.12.2: a custom amount for the whole event instead of the rate.
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState("");

  const startMs = fromInput(start);
  const every = repeat === "biweekly" ? 2 : 1;
  const max = dep.appointment.seriesMaxCount;
  const starts = useMemo(
    () => (repeat === "none" || !Number.isFinite(startMs) ? [startMs] : seriesStarts(startMs, every, by === "times" ? times : null, by === "until" ? fromInput(until) : null, max)),
    [repeat, startMs, every, by, times, until, max]
  );
  const durations: number[] = [];
  for (let m = d.min; m <= d.max; m += d.step) durations.push(m);
  // 2.6 (FR-262): my family's contract with the chosen provider sets the rate (the server freezes the same).
  const chosen = open ? null : (entry.providers.find((p) => p.publicId === provider) ?? null);
  const contractRate = chosen?.contractRate ?? null;
  // 2.12.2: an entry without a price of its own takes its base's (a YOLO event: the Childcare price).
  const baseEntry = entry.base ? (dep.services.find((x) => x.id === entry.base) ?? null) : null;
  const list = entry.price ?? baseEntry?.price ?? null;
  const fromBase = !entry.price && !!baseEntry?.price;
  const ratePrice =
    contractRate !== null
      ? Math.round(((contractRate * duration) / 60) * 100) / 100
      : list
        ? "perHour" in list
          ? Math.round(((list.perHour * duration) / 60) * 100) / 100
          : list.fixed
        : null;
  const hourly = contractRate ?? (list && "perHour" in list ? list.perHour : null);
  // Whole units or up to two decimals, a comma or a dot (Polish keyboards) — never a third decimal to round.
  const amountText = amount.trim().replace(",", ".");
  const customShape = /^\d+(\.\d{1,2})?$/.test(amountText);
  const customAmount = Number(amountText);
  const customOk = customShape && customAmount >= 1 && customAmount <= CUSTOM_PRICE_MAX;
  const price = custom ? (customOk ? customAmount : null) : ratePrice;
  const fmtRate = (r: number) => new Intl.NumberFormat(locale, { style: "currency", currency: dep.tariff.currency }).format(r);
  const baseName = localText(baseEntry?.name, locale.startsWith("pl") ? "pl" : "en") || entry.base || "";

  // Every rule the server checks, so Send request is only enabled when it will pass (V3, V23).
  const problem = (() => {
    if (!provider) return t("request.pickProvider");
    if (!Number.isFinite(startMs) || startMs < Date.now() + dep.booking.minLeadMin * 60_000) return t("request.tooSoon", { min: dep.booking.minLeadMin });
    if (startMs > Date.now() + dep.booking.maxDays * 86_400_000) return t("request.tooFar", { days: dep.booking.maxDays });
    if (entry.needsPlace && !place) return t("request.needPlace");
    if (note.length > 200) return t("request.noteLong");
    if (custom && !customOk) return t(amountText !== "" && /^\d+\.\d{3,}$/.test(amountText) ? "request.customDecimals" : "request.customBad", { max: CUSTOM_PRICE_MAX });
    if (repeat !== "none") {
      if (starts.length < 2 || starts.length > max) return t("request.repeatCount", { max });
      if (starts[starts.length - 1] > Date.now() + dep.appointment.seriesMaxDays * 86_400_000) return t("request.repeatFar", { days: dep.appointment.seriesMaxDays });
    }
    return null;
  })();

  const send = () =>
    run(async () => {
      const rep: RepeatInput | undefined = repeat === "none" ? undefined : by === "times" ? { every, count: times } : { every, until: fromInput(until) };
      await store.api.requestService({
        serviceId: entry.id,
        providerId: open ? null : provider,
        startsAt: startMs,
        durationMin: duration,
        place,
        note: note.trim(),
        repeat: rep,
        ...(kidIds.length ? { kidIds } : {}),
        ...(custom ? { customPrice: customAmount } : {})
      });
      if (keepHome && place) await store.api.saveHome(place).then(() => store.reloadProfile());
      // The request now waits in Planned (US9).
      store.goFromPanel("planned");
    });

  const fmtDate = (ms: number) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(ms);

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) void send();
      }}
      data-testid="request-form"
    >
      <p className="muted">
        <EntryIcon icon={entry.icon} /> {localText(entry.description, app.lang)}
      </p>
      <fieldset className="field">
        <legend>{t("request.provider")}</legend>
        {entry.providers.map((p) => (
          <label key={p.publicId} className="switch-row">
            <input type="radio" name="provider" checked={provider === p.publicId} onChange={() => setProvider(p.publicId ?? "")} />
            <span>
              {p.nickname} <RatingBadge rating={p.rating} />
            </span>
          </label>
        ))}
        <label className="switch-row">
          <input type="radio" name="provider" checked={open} onChange={() => setProvider(ANYONE)} data-testid="request-anyone" />
          <span>{t("request.anyone")}</span>
        </label>
      </fieldset>
      {open && (
        <p className="muted small with-info" data-testid="request-open-note">
          {t("request.openNoteShort")}
          <InfoTip text={t("request.openNote")} testId="request-open" />
        </p>
      )}
      <label className="field">
        <span>{t("request.start")}</span>
        <input
          type="datetime-local"
          value={start}
          min={toLocalInput(minStart)}
          max={toLocalInput(Date.now() + dep.booking.maxDays * 86_400_000)}
          step={900}
          onChange={(e) => setStart(e.target.value)}
          data-testid="request-start"
        />
      </label>
      <label className="field">
        <span>{t("request.duration")}</span>
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} data-testid="request-duration">
          {durations.map((m) => (
            <option key={m} value={m}>
              {durationText(m, t)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t("request.repeat")}</span>
        <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} data-testid="request-repeat">
          <option value="none">{t("request.repeatNone")}</option>
          <option value="weekly">{t("request.repeatWeekly")}</option>
          <option value="biweekly">{t("request.repeatBiweekly")}</option>
        </select>
      </label>
      {repeat !== "none" && (
        <div className="stack repeat-box" data-testid="request-repeat-box">
          <div className="row wrap">
            <label className="switch-row">
              <input type="radio" name="by" checked={by === "times"} onChange={() => setBy("times")} />
              <span>{t("request.times")}</span>
            </label>
            {by === "times" && (
              <input
                type="number"
                className="narrow-input"
                min={2}
                max={max}
                value={times}
                onChange={(e) => setTimes(Math.round(Number(e.target.value)))}
                aria-label={t("request.times")}
                data-testid="request-times"
              />
            )}
            <label className="switch-row">
              <input type="radio" name="by" checked={by === "until"} onChange={() => setBy("until")} />
              <span>{t("request.until")}</span>
            </label>
            {by === "until" && <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label={t("request.until")} data-testid="request-until" />}
          </div>
          {starts.length >= 2 && Number.isFinite(startMs) && (
            <p className="muted small" data-testid="request-series-preview">
              {t("request.seriesPreview", { n: starts.length, first: fmtDate(starts[0]), last: fmtDate(starts[starts.length - 1]) })}
            </p>
          )}
        </div>
      )}
      <PlaceInput label={t("request.place")} value={place} onChange={setPlace} home={home} testId="request-place" optional={!entry.needsPlace} />
      {kids && kids.length > 0 && (
        <fieldset className="field" data-testid="request-kids">
          <legend>
            <span className="with-info">
              {t("request.kids")}
              <InfoTip text={t("request.kidsHint")} testId="request-kids" />
            </span>
          </legend>
          <KidPicker kids={kids} selected={kidIds} onChange={setKidIds} />
        </fieldset>
      )}
      {!home && place && (
        <label className="switch-row">
          <input type="checkbox" checked={keepHome} onChange={(e) => setKeepHome(e.target.checked)} />
          <span>{t("place.keepAsHome")}</span>
        </label>
      )}
      <label className="field">
        <span>{t("request.note")}</span>
        <textarea value={note} maxLength={200} rows={3} onChange={(e) => setNote(e.target.value)} placeholder={t("request.notePlaceholder")} data-testid="request-note" />
        <small>{t("request.noteLeft", { n: 200 - note.length })}</small>
      </label>
      <fieldset className="field" data-testid="request-pay">
        <legend>
          <span className="with-info">
            {t("request.pay")}
            <InfoTip text={t("request.payCustomHint")} testId="request-pay" />
          </span>
        </legend>
        <label className="switch-row">
          <input type="radio" name="pay" checked={!custom} onChange={() => setCustom(false)} data-testid="request-pay-rate" />
          <span>{t("request.payRate")}</span>
        </label>
        <label className="switch-row">
          <input type="radio" name="pay" checked={custom} onChange={() => setCustom(true)} data-testid="request-pay-custom" />
          <span>{t("request.payCustom")}</span>
        </label>
        {custom && (
          <label className="field">
            <span>
              {t("request.customAmount")} ({dep.tariff.currency})
            </span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              className="narrow-input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="request-custom-price"
            />
          </label>
        )}
        {!custom && ratePrice === null && (
          <small className="muted" data-testid="request-no-rate">
            {t("request.noRate")}
          </small>
        )}
      </fieldset>
      {price !== null && (
        <p className="estimate" data-testid="request-price">
          <span>{durationText(duration, t)}</span>
          <strong>
            <Money amount={price} currency={dep.tariff.currency} />
          </strong>
          {repeat !== "none" && <span className="muted small">{t("request.perOccurrence")}</span>}
          {!custom && contractRate !== null && chosen && (
            <span className="muted small" data-testid="request-contract">
              {t("request.contractRate", { name: chosen.nickname, rate: fmtRate(contractRate) })}
              {/* 2.8 (FR-305): a YOLO event takes the contract's rate of its base service */}
              {entry.base && ` · ${t("request.baseRate", { service: baseName })}`}
            </span>
          )}
        </p>
      )}
      {/* 2.12.2: where the price comes from, under the row (the row itself stays as narrow as before) */}
      {price !== null && (custom || hourly !== null) && (
        <p className="muted small" data-testid="request-price-notes">
          {custom && <span data-testid="request-custom">{t("request.customPrice")}</span>}
          {!custom && contractRate === null && hourly !== null && (
            <span data-testid="request-list-rate">
              {fromBase ? t("request.baseListRate", { service: baseName, rate: fmtRate(hourly) }) : t("request.listRate", { rate: fmtRate(hourly) })}
              {" · "}
            </span>
          )}
          {!custom && hourly !== null && <span data-testid="request-estimate-note">{t("request.estimateNote")}</span>}
        </p>
      )}
      {problem && <p className="hint" data-testid="request-problem">{problem}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !!problem} data-testid="request-send">
        {t("request.send")}
      </button>
    </form>
  );
}
