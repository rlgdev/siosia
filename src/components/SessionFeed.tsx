// 2.5 session updates (FR-230–233): the feed of one appointment — what the person with the kids
// tells the parent (and the parent's notes), each about everyone or one kid, with a photo or
// not — as a section of C3 with its composer, and read-only under a done appointment in H1. The
// feed in front stamps the viewer's presence (on open and every 20 s), so the backend sends no
// notification for what they are looking at (V55). Heading home (FR-240–242): the client's button
// on C3 opens a sheet that works out the driving time from the phone's location (or a searched
// address) to the place and sends only the minutes; both parties then see the notice.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppointmentView, Place, SessionFeed, SessionUpdate } from "../core/types";
import { ServerError } from "../core/types";
import { useI18n } from "../i18n";
import type { Translate } from "../i18n";
import { geo, useGeo } from "../services/geolocation";
import { getRoute } from "../services/routing";
import { useListsKey, useStore } from "../state/store";
import { otherName, otherOf } from "./apptWords";
import { Icon } from "./Icon";
import { InfoTip } from "./InfoTip";
import { resizeToJpeg } from "./photo";
import { PlaceInput } from "./PlaceInput";
import { Avatar, Initial } from "./ProfileIcon";
import { Confirm, useBusy } from "./ui";
import { sameDay, timeText, whenText } from "./when";

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
/** While the feed is in front, updates(id, true) goes out this often: it keeps the presence fresh (V55). */
export const FEED_HEARTBEAT_MS = 20_000;
/** The client may say they are heading home from 30 min before the start until 2 h after the end (V56). */
const COMING_BEFORE_MS = 30 * 60_000;
const COMING_AFTER_MS = 2 * 3600_000;
/** Without a place or a location: the minutes the client picks themselves (FR-240). */
const PICK_MINUTES = [15, 30, 45, 60, 90] as const;
/** A fix older than this is not "where you are" any more. */
const FIX_MAX_AGE_MS = 2 * 60_000;
/** How long the sheet waits for the phone's location before it offers the search and the picker. */
const FIX_WAIT_MS = 6000;

export const updateCountText = (n: number, t: Translate): string => (n === 1 ? t("feed.countOne") : t("feed.count", { n }));

/** The preview of a picked photo (a data URL: no object URLs to revoke, and it works everywhere). */
const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/**
 * "{name} is on the way home · about 25 min (17:40)" for the provider — the minutes still to go —
 * and "You told {name} at 17:15: about 30 min." for the client — the minutes they sent (FR-241).
 */
export function comingText(a: AppointmentView, now: number, locale: string, t: Translate): string | null {
  if (!a.coming) return null;
  const left = Math.max(0, Math.round((a.coming.etaAt - now) / 60_000));
  const told = Math.max(0, Math.round((a.coming.etaAt - a.coming.at) / 60_000));
  return a.role === "provider"
    ? t("coming.line", { name: a.client.nickname, n: left, time: timeText(a.coming.etaAt, locale) })
    : t("coming.sent", { name: otherName(a, t), time: timeText(a.coming.at, locale), n: told });
}

/** The notice on C3 (both parties, FR-241). */
export function ComingLine({ a }: { a: AppointmentView }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const text = comingText(a, store.serverNow(), locale, t);
  if (!text) return null;
  return (
    <p className="row coming-line" data-testid="coming-line">
      <Icon name="car" className="ico-inline" /> <span>{text}</span>
    </p>
  );
}

const append = (f: SessionFeed | null, u: SessionUpdate): SessionFeed | null => (f && !f.items.some((x) => x.id === u.id) ? { ...f, items: [...f.items, u] } : f);

/** The Session section of C3 (FR-231): the feed, live, with the composer while posting is allowed. */
export function SessionFeedSection({ a }: { a: AppointmentView }) {
  const { t } = useI18n();
  const store = useStore();
  const [feed, setFeed] = useState<SessionFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    async (seen: boolean) => {
      try {
        setFeed(await store.api.updates(a.id, seen));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    },
    [store, a.id]
  );
  // Reloads on a change of my state (an update landed on the other side); in front = seen.
  const listsKey = useListsKey();
  useEffect(() => {
    void load(visible());
  }, [load, listsKey]);
  useEffect(() => {
    const id = setInterval(() => void load(visible()), FEED_HEARTBEAT_MS);
    const seen = () => {
      if (visible()) void load(true);
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [load]);

  const remove = async (u: SessionUpdate) => {
    await store.api.deleteUpdate(u.id);
    setFeed((f) => (f ? { ...f, items: f.items.filter((x) => x.id !== u.id) } : f));
    store.requestRefresh(0);
  };

  return (
    <section className="card stack feed" data-testid="feed">
      <div className="row">
        <strong>{t("feed.title")}</strong>
        <InfoTip text={t("feed.hint")} testId="feed-hint" />
      </div>
      {failed && !feed ? (
        <div className="row spread">
          <p className="form-error">{t("feed.error")}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void load(visible())}>
            {t("common.retry")}
          </button>
        </div>
      ) : !feed ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <>
          <UpdateList items={feed.items} onDelete={feed.open ? remove : undefined} />
          {feed.open ? (
            <Composer
              a={a}
              onPosted={(u) => {
                setFeed((f) => append(f, u));
                store.requestRefresh(0);
              }}
            />
          ) : (
            <p className="muted small" data-testid="feed-closed">
              {t("feed.closed")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The updates, oldest first; a photo opens full size; the author may delete their own. */
export function UpdateList({ items, onDelete }: { items: SessionUpdate[]; onDelete?: (u: SessionUpdate) => Promise<void> }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const [open, setOpen] = useState<SessionUpdate | null>(null);
  const [toDelete, setToDelete] = useState<SessionUpdate | null>(null);
  const [busy, run, error] = useBusy();
  const now = store.serverNow();
  // The full-size photo closes on Escape, like the app's dialogs.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const when = (ms: number) => (sameDay(ms, now) ? timeText(ms, locale) : whenText(ms, now, locale, t));
  if (items.length === 0)
    return (
      <p className="muted small" data-testid="feed-empty">
        {t("feed.empty")}
      </p>
    );
  return (
    <>
      <ol className="feed-list" data-testid="feed-list">
        {items.map((u) => (
          <li key={u.id} className="feed-item" data-testid={u.mine ? "feed-item-mine" : "feed-item-theirs"}>
            <Avatar photo={u.author.photo} icon={u.author.icon} paint={u.author.paint} fallback={<Initial name={u.author.nickname} />} />
            <div className="feed-body">
              <span className="feed-meta muted">
                <strong data-testid="feed-author">{u.mine ? t("feed.you") : u.author.nickname}</strong> · {when(u.createdAt)}
                {u.kid && (
                  <>
                    {" "}
                    <span className="chip chip-info" data-testid="feed-kid">
                      {u.kid.name}
                    </span>
                  </>
                )}
              </span>
              {u.text && (
                <p className="feed-text" data-testid="feed-text">
                  {u.text}
                </p>
              )}
              {u.photo && (
                <button type="button" className="feed-photo" onClick={() => setOpen(u)} aria-label={t("feed.viewPhoto")} data-testid="feed-photo">
                  <img src={u.photo} alt={t("feed.photoAlt", { name: u.mine ? t("feed.you") : u.author.nickname })} />
                </button>
              )}
              {u.mine && onDelete && (
                <button type="button" className="btn btn-link btn-small feed-delete" disabled={busy} onClick={() => setToDelete(u)} data-testid="feed-delete">
                  {t("feed.delete")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && open.photo && (
        <div className="feed-lightbox" role="dialog" aria-modal="true" aria-label={t("feed.viewPhoto")} onClick={() => setOpen(null)} data-testid="feed-lightbox">
          <img src={open.photo} alt={t("feed.photoAlt", { name: open.mine ? t("feed.you") : open.author.nickname })} />
          <button
            type="button"
            className="btn btn-secondary"
            autoFocus
            onClick={(e) => {
              e.stopPropagation();
              setOpen(null);
            }}
            data-testid="feed-lightbox-close"
          >
            {t("feed.closePhoto")}
          </button>
        </div>
      )}
      <Confirm
        open={!!toDelete && !!onDelete}
        message={t("feed.deleteConfirm")}
        confirmLabel={t("feed.delete")}
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          const u = toDelete;
          setToDelete(null);
          if (u && onDelete) void run(() => onDelete(u));
        }}
      />
    </>
  );
}

/** A text and/or a photo, about everyone or one attached kid (FR-230). */
function Composer({ a, onPosted }: { a: AppointmentView; onPosted: (u: SessionUpdate) => void }) {
  const { t } = useI18n();
  const store = useStore();
  const [text, setText] = useState("");
  const [kidId, setKidId] = useState<string | null>(null);
  const [jpeg, setJpeg] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, run, error, setError] = useBusy();
  const kids = a.kids ?? [];

  const pick = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const blob = await resizeToJpeg(file).catch(() => null);
      if (!blob) return setError(t("photo.failed"));
      setJpeg(blob);
      setPreview(await toDataUrl(blob));
    });
  };
  const clearPhoto = () => {
    setJpeg(null);
    setPreview(null);
  };
  const post = () => {
    const body = text.trim();
    if (!body && !jpeg) return;
    void run(async () => {
      try {
        const u = await store.api.postUpdate(a.id, { text: body, kidId }, jpeg);
        setText("");
        clearPhoto();
        onPosted(u);
      } catch (e) {
        if (e instanceof ServerError && e.code === "too_many") return setError(t("feed.tooMany"));
        if (e instanceof ServerError && e.code === "illegal_transition") return setError(t("feed.closed"));
        throw e;
      }
    });
  };

  return (
    <form
      className="feed-compose stack"
      onSubmit={(e) => {
        e.preventDefault();
        post();
      }}
      data-testid="feed-compose"
    >
      {kids.length > 0 && (
        <div className="feed-chips" role="group" aria-label={t("feed.about")}>
          <button type="button" className="feed-chip" aria-pressed={kidId === null} onClick={() => setKidId(null)} data-testid="feed-about-all">
            {t("feed.everyone")}
          </button>
          {kids.map((k) => (
            <button key={k.id} type="button" className="feed-chip" aria-pressed={kidId === k.id} onClick={() => setKidId(k.id)} data-testid={`feed-about-${k.id}`}>
              {k.name}
            </button>
          ))}
        </div>
      )}
      <textarea
        value={text}
        maxLength={500}
        rows={2}
        placeholder={t("feed.placeholder")}
        aria-label={t("feed.placeholder")}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        data-testid="feed-input"
      />
      {/* No `capture`: accept="image/*" alone gives the camera-or-gallery sheet (2.3 C3/C7). */}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
        data-testid="feed-file"
      />
      <div className="row wrap">
        {preview ? (
          <>
            <img src={preview} alt="" className="feed-preview" data-testid="feed-preview" />
            <button type="button" className="btn btn-link btn-small" disabled={busy} onClick={clearPhoto} data-testid="feed-photo-remove">
              {t("feed.removePhoto")}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => input.current?.click()} data-testid="feed-photo-pick">
            <Icon name="image" className="ico-inline" /> {t("feed.addPhoto")}
          </button>
        )}
        <button type="submit" className="btn btn-primary grow" disabled={busy || (!text.trim() && !jpeg)} data-testid="feed-send">
          {t("feed.send")}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** Under a done appointment in H1 (FR-233): fetched on expand, read-only. */
export function HistoryFeed({ a }: { a: AppointmentView }) {
  const { t } = useI18n();
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<SessionFeed | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || feed) return;
    store.api.updates(a.id, false).then(setFeed, () => setFailed(true)); // read-only: no presence stamp
  }, [open, feed, store, a.id]);
  return (
    <details className="feed-details" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="history-feed">
      <summary data-testid="history-feed-summary">{t("feed.history", { n: a.updateCount })}</summary>
      {open && (failed ? <p className="form-error">{t("feed.error")}</p> : !feed ? <p className="muted">{t("common.loading")}</p> : <UpdateList items={feed.items} />)}
    </details>
  );
}

/** The client's "I'm heading home" (FR-240): the button, and the sheet that works out the minutes. */
export function ComingHomeBox({ a, reload }: { a: AppointmentView; reload: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  const [open, setOpen] = useState(false);
  const now = store.serverNow();
  const live = a.role === "client" && (a.status === "accepted" || a.status === "done") && !!a.provider && now >= a.startsAt - COMING_BEFORE_MS && now <= a.endsAt + COMING_AFTER_MS;
  if (!live) return null;
  return open ? (
    <ComingSheet
      a={a}
      onDone={() => {
        setOpen(false);
        reload();
      }}
      onCancel={() => setOpen(false)}
    />
  ) : (
    <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} data-testid="coming-open">
      <Icon name="home" className="ico-inline" /> {t("coming.button")}
    </button>
  );
}

function ComingSheet({ a, onDone, onCancel }: { a: AppointmentView; onDone: () => void; onCancel: () => void }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const { status, fix } = useGeo(true);
  const [from, setFrom] = useState<Place | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [computed, setComputed] = useState<{ min: number; estimate: boolean } | null>(null);
  const [waited, setWaited] = useState(false);
  const [busy, run, error] = useBusy();
  const name = otherOf(a)?.nickname ?? t("appt.anyone");

  // The phone's own location, fresh enough, unless the client searched for a place themselves.
  useEffect(() => {
    const id = setTimeout(() => setWaited(true), FIX_WAIT_MS);
    return () => clearTimeout(id);
  }, []);
  const fresh = fix && (geo.isSimulated() || Date.now() - fix.t <= FIX_MAX_AGE_MS) ? fix : null;
  const origin: Place | null = from ?? (fresh ? { lat: fresh.lat, lng: fresh.lng, label: "" } : null);
  // Recomputed when the origin moves by a ~100 m cell, not on every jitter of the fix; the last
  // estimate (and Send) stays while the next one is on its way.
  const originKey = origin ? `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}` : null;
  useEffect(() => {
    if (!origin || !a.place) return;
    let gone = false;
    void getRoute(origin, a.place).then((r) => {
      if (!gone) setComputed({ min: Math.max(0, Math.min(600, Math.ceil(r.min))), estimate: r.estimate });
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originKey, a.place?.lat, a.place?.lng]);

  const minutes = picked ?? computed?.min ?? null;
  const denied = status === "denied" || status === "unavailable";
  const noLocation = denied || (waited && !fresh);
  // The straight-line fallback (no road route) is a rough guess: said so, and the client may pick the minutes instead.
  const showFallback = !a.place || (!from && noLocation) || !!computed?.estimate;
  const send = () =>
    run(async () => {
      if (minutes === null) return;
      await store.api.comingHome(a.id, minutes);
      onDone();
    });

  return (
    <section className="card stack" data-testid="coming-sheet">
      <div className="row">
        <strong>{t("coming.title")}</strong>
        <InfoTip text={t("coming.hint", { name })} testId="coming-hint" />
      </div>
      {!a.place && <p className="muted small">{t("coming.noPlace")}</p>}
      {a.place && !from && !fresh && !noLocation && (
        <p className="muted small" data-testid="coming-locating">
          {t("coming.locating")}
        </p>
      )}
      {a.place && !from && noLocation && (
        <p className="muted small" data-testid="coming-nofix">
          {t(denied ? "coming.noFix" : "coming.stillLooking")}
        </p>
      )}
      {a.place && (!fresh || from || noLocation) && <PlaceInput label={t("coming.from")} value={from} onChange={setFrom} near={a.place} testId="coming-from" />}
      {origin && a.place && computed === null && picked === null && <p className="muted small">{t("common.loading")}</p>}
      {computed !== null && picked === null && (
        <p data-testid="coming-estimate">
          <Icon name="car" className="ico-inline" /> {t("coming.about", { n: computed.min, time: timeText(Date.now() + computed.min * 60_000, locale) })}
          {computed.estimate && ` (${t("common.estimate")})`}
        </p>
      )}
      {computed?.estimate && picked === null && (
        <p className="hint" data-testid="coming-estimate-by">
          {t("rider.estimateBy")}
        </p>
      )}
      {(showFallback || picked !== null) && (
        <label>
          <span>{t("coming.pick")}</span>
          <select value={picked ?? ""} onChange={(e) => setPicked(e.target.value === "" ? null : Number(e.target.value))} data-testid="coming-pick">
            <option value="">—</option>
            {PICK_MINUTES.map((m) => (
              <option key={m} value={m}>
                {t("coming.minutes", { n: m })}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <button type="button" className="btn btn-primary grow" disabled={busy || minutes === null} onClick={() => void send()} data-testid="coming-send">
          {t("coming.send", { name })}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}
