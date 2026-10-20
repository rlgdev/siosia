// C2 Request form (FR-094, FR-107): provider (preselected when only one offers it), date and start
// time (15-minute steps, at least booking.minLeadMin ahead), duration, repeat (none / weekly /
// every 2 weeks; until a date or a number of times), place (default My place), note, the price per
// occurrence when the entry has one. Send request stays disabled until the form is valid.

import { useEffect, useMemo, useState } from "react";
import { fromInput, roundUp, seriesStarts, toDateInput, toLocalInput } from "../components/datetime";
import { PlaceInput } from "../components/PlaceInput";
import { durationText, EntryIcon, localText } from "./Catalog";
import { Money, Panel, RatingBadge, useBusy } from "../components/ui";
import type { CatalogItem, Place, RepeatInput } from "../core/types";
import { useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";

type Repeat = "none" | "weekly" | "biweekly";

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
  const [provider, setProvider] = useState(entry.providers.length === 1 ? entry.providers[0].publicId ?? "" : "");
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

  const startMs = fromInput(start);
  const every = repeat === "biweekly" ? 2 : 1;
  const max = dep.appointment.seriesMaxCount;
  const starts = useMemo(
    () => (repeat === "none" || !Number.isFinite(startMs) ? [startMs] : seriesStarts(startMs, every, by === "times" ? times : null, by === "until" ? fromInput(until) : null, max)),
    [repeat, startMs, every, by, times, until, max]
  );
  const durations: number[] = [];
  for (let m = d.min; m <= d.max; m += d.step) durations.push(m);
  const price = entry.price ? ("perHour" in entry.price ? Math.round(((entry.price.perHour * duration) / 60) * 100) / 100 : entry.price.fixed) : null;

  // Every rule the server checks, so Send request is only enabled when it will pass (V3, V23).
  const problem = (() => {
    if (!provider) return t("request.pickProvider");
    if (!Number.isFinite(startMs) || startMs < Date.now() + dep.booking.minLeadMin * 60_000) return t("request.tooSoon", { min: dep.booking.minLeadMin });
    if (startMs > Date.now() + dep.booking.maxDays * 86_400_000) return t("request.tooFar", { days: dep.booking.maxDays });
    if (entry.needsPlace && !place) return t("request.needPlace");
    if (note.length > 200) return t("request.noteLong");
    if (repeat !== "none") {
      if (starts.length < 2 || starts.length > max) return t("request.repeatCount", { max });
      if (starts[starts.length - 1] > Date.now() + dep.appointment.seriesMaxDays * 86_400_000) return t("request.repeatFar", { days: dep.appointment.seriesMaxDays });
    }
    return null;
  })();

  const send = () =>
    run(async () => {
      const rep: RepeatInput | undefined = repeat === "none" ? undefined : by === "times" ? { every, count: times } : { every, until: fromInput(until) };
      await store.api.requestService({ serviceId: entry.id, providerId: provider, startsAt: startMs, durationMin: duration, place, note: note.trim(), repeat: rep });
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
      </fieldset>
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
      {price !== null && (
        <p className="estimate" data-testid="request-price">
          <span>{durationText(duration, t)}</span>
          <strong>
            <Money amount={price} currency={dep.tariff.currency} />
          </strong>
          {repeat !== "none" && <span className="muted small">{t("request.perOccurrence")}</span>}
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
