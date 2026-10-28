// C1 Catalog ("Siosia", FR-090–092): what the user offers first (drivers: Ride — Go online with the
// rides to take), then every enabled entry with who offers it. Ride opens the v1 rider flow (R1);
// a time entry opens the request form (C2) — 2.1: also one nobody offers yet, as an open request
// everyone in the group sees (FR-160); open requests of others lead to P1 (FR-161).
// 2.8 (FR-304–306): YOLO — the 4th card of the services; it opens the YOLO catalog (a panel) of
// special days around the year, the dated ones in the order of their next date ("in 12 days" within
// two months), then the any-time ones.

import { useCallback, useEffect, useState } from "react";
import { EMOJI_ICONS, Icon } from "../components/Icon";
import { Avatar, ProfileIcon } from "../components/ProfileIcon";
import { profileIcon } from "../components/profileIcons";
import { Money, Page, Panel, RatingBadge } from "../components/ui";
import { addDays, localDate } from "../core/time";
import { playYoloSound, setYoloSound, yoloSoundOn } from "../services/yoloSounds";
import type { CatalogItem, LocalText } from "../core/types";
import { useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";

export const localText = (x: LocalText | null | undefined, lang: string) => (x ? (lang === "pl" ? x.pl || x.en : x.en || x.pl) : "");

/** "1 h", "1 h 30 min", "45 min" */
export function durationText(min: number, t: (k: "common.hours" | "common.hoursMin" | "common.minutes", v: Record<string, number>) => string): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return t("common.hoursMin", { h, m });
  if (h) return t("common.hours", { h });
  return t("common.minutes", { m });
}

/** A catalog entry's icon: a profile icon, else the stroke icon its emoji maps to (V53), else as given. */
export function EntryIcon({ icon }: { icon: string }) {
  if (profileIcon(icon)) return <ProfileIcon icon={icon} size="sm" />;
  const name = EMOJI_ICONS[icon];
  return name ? <Icon name={name} size={24} /> : <span aria-hidden="true">{icon}</span>;
}

/**
 * 2.9: an event's icon in its tile — the same for every party (client, provider, family) in P1, H1
 * and C3; a YOLO event in its own colour.
 */
export function EventIcon({ icon, serviceId }: { icon: string; serviceId: string }) {
  const tone = YOLO_TONES[serviceId];
  return (
    <span className={`entry-icon event-tile${tone ? " yolo-tile" : ""}`} data-tone={tone} aria-hidden="true" data-testid="event-icon">
      <EntryIcon icon={icon} />
    </span>
  );
}

/** 2.8 (V71): each YOLO event's colour (the tile behind its icon); others take the accent. */
const YOLO_TONES: Record<string, string> = {
  yolo_halloween: "orange",
  yolo_nicholas: "red",
  yolo_christmas: "green",
  yolo_new_year: "violet",
  yolo_winter: "sky",
  yolo_date_night: "pink",
  yolo_carnival: "violet",
  yolo_easter: "yellow",
  yolo_childrens_day: "sky",
  yolo_summer: "teal",
  yolo_back_to_school: "blue",
  yolo_birthday: "pink",
  yolo_party: "orange",
  yolo_sleepover: "indigo",
  yolo_wedding: "yellow"
};

/** Days from today to the event's next "MM-DD" in the deployment's timezone (0 = today); null = any time. */
export function daysUntil(date: string | null | undefined, now: number, tz: string): number | null {
  if (!date || !/^\d\d-\d\d$/.test(date)) return null;
  const today = localDate(now, tz);
  let next = `${today.slice(0, 4)}-${date}`;
  if (next < today) next = `${Number(today.slice(0, 4)) + 1}-${date}`;
  let n = 0;
  for (let d = today; d < next && n < 400; d = addDays(d, 1)) n++;
  return n;
}

/** The YOLO events in the order of their next date, the any-time ones after (as configured). */
export function yoloOrder(items: CatalogItem[], now: number, tz: string): { e: CatalogItem; days: number | null }[] {
  return items
    .map((e, i) => ({ e, i, days: daysUntil(e.date, now, tz) }))
    .sort((a, b) => (a.days ?? 1e6) - (b.days ?? 1e6) || a.i - b.i)
    .map(({ e, days }) => ({ e, days }));
}

export function Catalog() {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    () =>
      store.api.catalog().then(
        (list) => (setItems(list), setFailed(false)),
        () => setFailed(true)
      ),
    [store]
  );
  const retry = () => {
    setFailed(false);
    void load();
  };
  const my = app.my;
  useEffect(() => {
    void load();
  }, [load, my?.toAnswer]);

  const role = app.profile?.masterRole ?? null;
  const offers = new Set(app.profile?.offers ?? []);
  const services = items ?? [];
  // Ride is the only way to R1: without the catalog it still comes from the deployment's entries.
  const ride = items
    ? services.find((e) => e.kind === "ride")
    : failed
      ? app.deployment?.services?.find((e) => e.kind === "ride" && e.enabled)
      : undefined;
  const mine = services.filter((e) => e.kind === "time" && offers.has(e.id));

  return (
    <Page title={t("start.siosia")} testId="catalog">
      {!!my?.toAnswer && (
        <button type="button" className="notice notice-info row spread" onClick={() => store.go("planned")} data-testid="catalog-to-answer">
          <span>{t("catalog.toAnswer", { n: my.toAnswer })}</span>
          <Icon name="chevron" className="ico-end" />
        </button>
      )}
      {!!my?.openRequests && (
        <button type="button" className="notice notice-info row spread" onClick={() => store.go("planned")} data-testid="catalog-open-requests">
          <span>{t("catalog.openRequests", { n: my.openRequests })}</span>
          <Icon name="chevron" className="ico-end" />
        </button>
      )}
      {(role !== "rider" || mine.length > 0) && (
        <section className="stack" aria-label={t("catalog.youOffer")}>
          <h2 className="section-title">{t("catalog.youOffer")}</h2>
          {role !== "rider" && (
            <button type="button" className="entry-card" onClick={() => store.go("drive")} data-testid="catalog-drive">
              <span className="entry-icon" aria-hidden="true">
                <Icon name="car" size={24} />
              </span>
              <span className="entry-main">
                <strong>{app.vehicle ? t("catalog.goOnline") : t("catalog.addCar")}</strong>
                <span className="muted small">
                  {app.vehicle ? t("catalog.ridesToTake", { n: my?.openBookings ?? 0 }) : t("catalog.addCarBody")}
                </span>
              </span>
              <Icon name="chevron" className="ico-end" />
            </button>
          )}
          {mine.map((e) => (
            <div key={e.id} className="entry-card entry-card-static">
              <span className="entry-icon">
                <EntryIcon icon={e.icon} />
              </span>
              <span className="entry-main">
                <strong>{localText(e.name, lang)}</strong>
                <span className="muted small">{t("catalog.youOfferBody")}</span>
              </span>
            </div>
          ))}
        </section>
      )}
      <section className="stack" aria-label={t("catalog.all")}>
        <h2 className="section-title">{t("catalog.all")}</h2>
        {failed && !items && (
          <div className="row spread" data-testid="catalog-failed">
            <p className="form-error">{t("catalog.error")}</p>
            <button type="button" className="btn btn-secondary btn-small" onClick={retry} data-testid="catalog-retry">
              {t("common.retry")}
            </button>
          </div>
        )}
        {!items && !failed && <p className="muted">{t("common.loading")}</p>}
        {ride && role !== "driver" && (
          <button type="button" className="entry-card" onClick={() => store.go("ride")} data-testid="catalog-ride">
            <span className="entry-icon">
              <EntryIcon icon={ride.icon} />
            </span>
            <span className="entry-main">
              <strong>{localText(ride.name, lang)}</strong>
              <span className="muted small">{localText(ride.description, lang)}</span>
            </span>
            <Icon name="chevron" className="ico-end" />
          </button>
        )}
        {services
          .filter((e) => e.kind === "time" && !e.section)
          .map((e) => {
            const nobody = e.providers.length === 0;
            return (
              <button
                key={e.id}
                type="button"
                className="entry-card"
                onClick={() => store.openPanel("request", e.id)}
                data-testid={`catalog-${e.id}`}
              >
                <span className="entry-icon">
                  <EntryIcon icon={e.icon} />
                </span>
                <span className="entry-main">
                  <strong>{localText(e.name, lang)}</strong>
                  <span className="muted small">{localText(e.description, lang)}</span>
                  {e.duration && (
                    <span className="muted small">
                      {t("catalog.duration", { d: durationText(e.duration.default, t) })}
                      {e.price && " · "}
                      {e.price && "perHour" in e.price && (
                        <>
                          <Money amount={e.price.perHour} currency={app.deployment?.tariff.currency ?? "PLN"} /> {t("catalog.perHour")}
                        </>
                      )}
                      {e.price && "fixed" in e.price && <Money amount={e.price.fixed} currency={app.deployment?.tariff.currency ?? "PLN"} />}
                    </span>
                  )}
                  {nobody ? (
                    <span className="small entry-open" data-testid={`nobody-${e.id}`}>
                      {t("catalog.nobody")}
                    </span>
                  ) : (
                    <span className="providers">
                      {e.providers.map((p) => (
                        <span key={p.publicId ?? p.nickname} className="provider-chip">
                          <Avatar photo={p.photo} icon={p.icon} paint={p.paint} size="sm" />
                          {p.nickname} <RatingBadge rating={p.rating} />
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <Icon name="chevron" className="ico-end" />
              </button>
            );
          })}
        <YoloCard items={services.filter((e) => e.kind === "time" && e.section === "yolo")} />
      </section>
    </Page>
  );
}

/** 2.8 (V71): YOLO as the 4th card of the services — the next special day under it; it opens the YOLO catalog. */
function YoloCard({ items }: { items: CatalogItem[] }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  if (!items.length) return null;
  const next = yoloOrder(items, store.serverNow(), app.deployment?.timezone ?? "Europe/Warsaw")[0];
  return (
    <button type="button" className="entry-card" onClick={() => store.openPanel("yolo")} data-testid="catalog-yolo">
      <span className="entry-icon yolo-tile" data-tone="violet">
        <Icon name="sparkles" size={24} />
      </span>
      <span className="entry-main">
        <strong>YOLO</strong>
        {next && (
          <span className="muted small" data-testid="yolo-next">
            {next.days === null
              ? localText(next.e.name, lang)
              : t("yolo.next", { name: localText(next.e.name, lang), when: next.days === 0 ? t("yolo.today") : t("yolo.inDays", { n: next.days }) })}
          </span>
        )}
      </span>
      <Icon name="chevron" className="ico-end" />
    </button>
  );
}

/** 2.8 (FR-304–306, V71): the YOLO catalog — a card per special day with its icon, date and who can do it. */
export function YoloPanel() {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Each event has its blooper on the tap (parrot, ghost, ho ho ho…); a phone may turn them off.
  const [sound, setSound] = useState(yoloSoundOn);
  const load = useCallback(
    () =>
      store.api.catalog().then(
        (list) => (setItems(list.filter((e) => e.kind === "time" && e.section === "yolo")), setFailed(false)),
        () => setFailed(true)
      ),
    [store]
  );
  useEffect(() => {
    void load();
  }, [load]);
  const tz = app.deployment?.timezone ?? "Europe/Warsaw";
  return (
    <Panel title="YOLO" onClose={() => store.closePanel()}>
      <div className="row yolo-sound">
        <button
          type="button"
          className="btn btn-link btn-small"
          aria-pressed={sound}
          onClick={() => {
            setYoloSound(!sound);
            setSound(!sound);
          }}
          data-testid="yolo-sound"
        >
          <Icon name={sound ? "volume" : "volumeOff"} className="ico-inline" /> {t(sound ? "yolo.soundOn" : "yolo.soundOff")}
        </button>
      </div>
      {failed && !items ? (
        <div className="row spread">
          <p className="form-error">{t("catalog.error")}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : !items ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <div className="yolo-grid" data-testid="yolo-catalog">
          {yoloOrder(items, store.serverNow(), tz).map(({ e, days }) => (
            <button
              key={e.id}
              type="button"
              className="yolo-card"
              onClick={() => {
                playYoloSound(e.id);
                store.openPanel("request", e.id);
              }}
              data-testid={`catalog-${e.id}`}
            >
              <span className="yolo-tile" data-tone={YOLO_TONES[e.id] ?? "accent"}>
                <EntryIcon icon={e.icon} />
              </span>
              <strong>{localText(e.name, lang)}</strong>
              <span className="muted small">{localText(e.when, lang)}</span>
              {days !== null && days <= 60 && (
                <span className="chip chip-info yolo-soon" data-testid={`yolo-soon-${e.id}`}>
                  {days === 0 ? t("yolo.today") : t("yolo.inDays", { n: days })}
                </span>
              )}
              <span className="muted small yolo-who">
                {e.providers.length === 0 ? t("catalog.nobody") : e.providers.map((p) => p.nickname).join(", ")}
              </span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
