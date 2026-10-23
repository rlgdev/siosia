// C1 Catalog ("Siosia", FR-090–092): what the user offers first (drivers: Ride — Go online with the
// rides to take), then every enabled entry with who offers it. Ride opens the v1 rider flow (R1);
// a time entry opens the request form (C2) — 2.1: also one nobody offers yet, as an open request
// everyone in the group sees (FR-160); open requests of others lead to P1 (FR-161).

import { useCallback, useEffect, useState } from "react";
import { EMOJI_ICONS, Icon } from "../components/Icon";
import { Avatar, ProfileIcon } from "../components/ProfileIcon";
import { profileIcon } from "../components/profileIcons";
import { Money, Page, RatingBadge } from "../components/ui";
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
          .filter((e) => e.kind === "time")
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
      </section>
    </Page>
  );
}
