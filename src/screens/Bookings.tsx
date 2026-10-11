// Rides booked in advance. Riders: their bookings, with the driver once one took it, and Cancel.
// Drivers: bookings to take (with the distance from here) and their own (with when to leave),
// Take and Give back. Lists refresh when the user's state changes and every 30 s.

import { useCallback, useEffect, useRef, useState } from "react";
import { ProfileIcon } from "../components/ProfileIcon";
import { Confirm, Money, Panel, RatingBadge, useBusy } from "../components/ui";
import { coarse, haversineKm } from "../core/geo";
import type { OpenBooking, RideView } from "../core/types";
import { useI18n } from "../i18n";
import { useGeo } from "../services/geolocation";
import { useApp, useStore } from "../state/store";

/** "Mon 12 Oct, 14:30". Booked times are wall-clock times: shown exactly as booked. */
function useWhen(): (ms: number) => string {
  const { locale } = useI18n();
  return (ms) => new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}

export function BookingsPanel() {
  const app = useApp();
  return app.mode === "drive" ? <DriverBookings /> : <RiderBookings />;
}

function Route({ r }: { r: RideView }) {
  return (
    <div className="trip-line">
      <span>{r.pickup.label}</span>
      <span aria-hidden="true">→</span>
      <span>{r.dropoff.label}</span>
    </div>
  );
}

function RiderBookings() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const when = useWhen();
  const [list, setList] = useState<RideView[] | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [busy, run, error] = useBusy();
  const load = useCallback(
    () => store.api.bookings().then((all) => setList(all.filter((r) => r.role === "rider")), () => setList((l) => l ?? [])),
    [store]
  );
  // Reload whenever my state changes (a driver took or gave back a booking, a booking started).
  const my = app.my;
  useEffect(() => {
    void load();
  }, [load, my]);
  useEffect(() => {
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Panel title={t("book.mine")} onClose={() => store.closePanel()}>
      {list === null ? (
        <p className="muted">{t("common.loading")}</p>
      ) : list.length === 0 ? (
        <p className="muted">{t("book.none")}</p>
      ) : (
        <ul className="booking-list" data-testid="booking-list">
          {list.map((r) => (
            <li key={r.id} className="card stack" data-testid="booking">
              <div className="kv">
                <strong>{when(r.scheduledFor ?? r.requestedAt)}</strong>
                <strong>
                  <Money amount={r.fare} currency={r.currency} />
                </strong>
              </div>
              <Route r={r} />
              {r.driver ? (
                <p data-testid="booking-driver">
                  <ProfileIcon icon={r.driver.icon} size="sm" /> {t("book.driverIs", { name: r.driver.nickname })}{" "}
                  <RatingBadge rating={r.driver.rating} />
                  {r.driver.vehicle && (
                    <span className="muted small">
                      {" "}
                      · {r.driver.vehicle.colour} {r.driver.vehicle.make} {r.driver.vehicle.model} · {r.driver.vehicle.plate}
                    </span>
                  )}
                </p>
              ) : (
                <p className="muted small">{t("book.waiting", { min: app.deployment?.booking.openMin ?? 20 })}</p>
              )}
              <button type="button" className="btn btn-danger-outline" disabled={busy} onClick={() => setCancelId(r.id)} data-testid="cancel-booking">
                {t("book.cancel")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Confirm
        open={!!cancelId}
        danger
        message={t("book.cancelConfirm")}
        onCancel={() => setCancelId(null)}
        onConfirm={() => {
          const id = cancelId!;
          setCancelId(null);
          void run(async () => {
            await store.api.cancelRide(id);
            await load();
            await store.refresh();
          });
        }}
      />
    </Panel>
  );
}

function DriverBookings() {
  const { t, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const when = useWhen();
  const { fix } = useGeo(true);
  const [tab, setTab] = useState<"open" | "mine">("open");
  const [open, setOpen] = useState<OpenBooking[] | null>(null);
  const [mine, setMine] = useState<RideView[] | null>(null);
  const [releaseId, setReleaseId] = useState<string | null>(null);
  const [busy, run, error] = useBusy();
  const hasFix = !!fix;
  const fixRef = useRef(fix);
  fixRef.current = fix;
  const load = useCallback(async () => {
    const pos = fixRef.current ? coarse(fixRef.current) : null;
    const [o, m] = await Promise.all([
      store.api.openBookings(pos).catch(() => [] as OpenBooking[]),
      store.api.bookings().then((all) => all.filter((r) => r.role === "driver")).catch(() => [] as RideView[])
    ]);
    setOpen(o);
    setMine(m);
  }, [store, fixRef]);
  const counts = `${app.my?.bookings}|${app.my?.openBookings}`;
  useEffect(() => {
    void load();
  }, [load, counts, hasFix]);
  useEffect(() => {
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const time = (ms: number) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(ms);
  // Straight line × 1.3 at 30 km/h (like the routing fallback) plus 5 min to spare.
  const leaveBy = (r: RideView) => {
    if (!fix || r.scheduledFor === null) return null;
    const min = ((haversineKm(fix, r.pickup) * 1.3) / 30) * 60 + 5;
    return r.scheduledFor - min * 60_000;
  };

  return (
    <Panel title={t("book.titleDriver")} onClose={() => store.closePanel()}>
      <div className="row tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "open"} className={`btn ${tab === "open" ? "btn-primary" : "btn-secondary"}`} onClick={() => setTab("open")} data-testid="tab-open">
          {t("book.tabOpen", { n: open?.length ?? 0 })}
        </button>
        <button type="button" role="tab" aria-selected={tab === "mine"} className={`btn ${tab === "mine" ? "btn-primary" : "btn-secondary"}`} onClick={() => setTab("mine")} data-testid="tab-mine">
          {t("book.tabMine", { n: mine?.length ?? 0 })}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {tab === "open" &&
        (open === null ? (
          <p className="muted">{t("common.loading")}</p>
        ) : open.length === 0 ? (
          <p className="muted">{t("book.noneOpen")}</p>
        ) : (
          <ul className="booking-list" data-testid="open-bookings">
            {open.map(({ ride: r, distanceKm }) => (
              <li key={r.id} className="card stack" data-testid="open-booking">
                <div className="kv">
                  <strong>{when(r.scheduledFor ?? r.requestedAt)}</strong>
                  <strong>
                    <Money amount={r.fare} currency={r.currency} />
                  </strong>
                </div>
                <p>
                  <ProfileIcon icon={r.rider.icon} size="sm" /> <strong>{r.rider.nickname}</strong> <RatingBadge rating={r.rider.rating} />
                  {distanceKm !== null && <span className="muted small"> · {t("book.away", { km: distanceKm.toFixed(1) })}</span>}
                </p>
                <Route r={r} />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await store.api.claimBooking(r.id);
                      await load();
                      await store.refresh();
                      setTab("mine");
                    })
                  }
                  data-testid="take-booking"
                >
                  {t("book.take")}
                </button>
              </li>
            ))}
          </ul>
        ))}
      {tab === "mine" &&
        (mine === null ? (
          <p className="muted">{t("common.loading")}</p>
        ) : mine.length === 0 ? (
          <p className="muted">{t("book.none")}</p>
        ) : (
          <ul className="booking-list" data-testid="my-bookings">
            {mine.map((r) => {
              const leave = leaveBy(r);
              return (
                <li key={r.id} className="card stack" data-testid="my-booking">
                  <div className="kv">
                    <strong>{when(r.scheduledFor ?? r.requestedAt)}</strong>
                    <strong>
                      <Money amount={r.fare} currency={r.currency} />
                    </strong>
                  </div>
                  <p>
                    <ProfileIcon icon={r.rider.icon} size="sm" /> <strong>{r.rider.nickname}</strong> <RatingBadge rating={r.rider.rating} />
                  </p>
                  <Route r={r} />
                  {leave !== null && <p className="hint">{t("book.leaveBy", { time: time(leave) })}</p>}
                  {r.scheduledFor !== null && (
                    <p className="muted small">
                      {t("book.startsAt", { time: time(r.scheduledFor - (app.deployment?.booking.leadMin ?? 30) * 60_000) })}
                    </p>
                  )}
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setReleaseId(r.id)} data-testid="release-booking">
                    {t("book.release")}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
      <Confirm
        open={!!releaseId}
        danger
        message={t("book.releaseConfirm")}
        onCancel={() => setReleaseId(null)}
        onConfirm={() => {
          const id = releaseId!;
          setReleaseId(null);
          void run(async () => {
            await store.api.releaseBooking(id);
            await load();
            await store.refresh();
          });
        }}
      />
    </Panel>
  );
}

