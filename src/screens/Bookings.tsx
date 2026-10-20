// Rides booked in advance, as cards inside P1 Planned (2.0: the v1 bookings panel became P2).
// Riders: their booking with the driver once one took it, and Cancel. Drivers: bookings to take
// (with the distance from here) and the ones they took (with when to leave) — Take and Give back.

import { useCallback, useEffect, useRef, useState } from "react";
import { AddToCalendar } from "../components/AddToCalendar";
import { ProfileIcon } from "../components/ProfileIcon";
import { Confirm, Money, Panel, RatingBadge, useBusy } from "../components/ui";
import { coarse, haversineKm } from "../core/geo";
import type { OpenBooking, RideView } from "../core/types";
import { useI18n } from "../i18n";
import { useGeo } from "../services/geolocation";
import { useApp, useListsKey, useStore } from "../state/store";

/** "Mon 12 Oct, 14:30". Booked times are wall-clock times: shown exactly as booked. */
export function useWhen(): (ms: number) => string {
  const { locale } = useI18n();
  return (ms) => new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}

export function Route({ r }: { r: Pick<RideView, "pickup" | "dropoff"> }) {
  return (
    <div className="trip-line">
      <span>{r.pickup.label}</span>
      <span aria-hidden="true">→</span>
      <span>{r.dropoff.label}</span>
    </div>
  );
}

/** A booking as its rider sees it: the driver once taken, and Cancel. */
export function RiderBookingCard({ r, onChanged }: { r: RideView; onChanged: () => void }) {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const when = useWhen();
  const [confirm, setConfirm] = useState(false);
  const [busy, run, error] = useBusy();
  return (
    <div className="card stack" data-testid="booking">
      <div className="kv">
        <strong>
          🚗 {when(r.scheduledFor ?? r.requestedAt)}
        </strong>
        <strong>
          <Money amount={r.fare} currency={r.currency} />
        </strong>
      </div>
      <Route r={r} />
      {r.driver ? (
        <p data-testid="booking-driver">
          <ProfileIcon icon={r.driver.icon} size="sm" /> {t("book.driverIs", { name: r.driver.nickname })} <RatingBadge rating={r.driver.rating} />
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
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <AddToCalendar ride={r} />
      <button type="button" className="btn btn-danger-outline" disabled={busy} onClick={() => setConfirm(true)} data-testid="cancel-booking">
        {t("book.cancel")}
      </button>
      <Confirm
        open={confirm}
        danger
        message={t("book.cancelConfirm")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void run(async () => {
            try {
              await store.api.cancelRide(r.id);
            } finally {
              onChanged();
              await store.refresh().catch(() => {});
            }
          });
        }}
      />
    </div>
  );
}

/** A booking a driver took: when to leave, and Give back. */
export function DriverBookingCard({ r, onChanged }: { r: RideView; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const when = useWhen();
  const { fix } = useGeo(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, run, error] = useBusy();
  const time = (ms: number) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(ms);
  // Straight line × 1.3 at 30 km/h (like the routing fallback) plus 5 min to spare.
  const leave = fix && r.scheduledFor !== null ? r.scheduledFor - (((haversineKm(fix, r.pickup) * 1.3) / 30) * 60 + 5) * 60_000 : null;
  return (
    <div className="card stack" data-testid="my-booking">
      <div className="kv">
        <strong>🚗 {when(r.scheduledFor ?? r.requestedAt)}</strong>
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
        <p className="muted small">{t("book.startsAt", { time: time(r.scheduledFor - (app.deployment?.booking.leadMin ?? 30) * 60_000) })}</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <AddToCalendar ride={r} />
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirm(true)} data-testid="release-booking">
        {t("book.release")}
      </button>
      <Confirm
        open={confirm}
        danger
        message={t("book.releaseConfirm")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void run(async () => {
            try {
              await store.api.releaseBooking(r.id);
            } finally {
              onChanged();
              await store.refresh().catch(() => {});
            }
          });
        }}
      />
    </div>
  );
}

/** P2 Rides to take: bookings without a driver, with the distance from here, and Take this ride. */
export function useOpenBookings(enabled: boolean): [OpenBooking[] | null, () => Promise<void>] {
  const store = useStore();
  const app = useApp();
  const { fix } = useGeo(enabled);
  const [open, setOpen] = useState<OpenBooking[] | null>(null);
  const fixRef = useRef(fix);
  fixRef.current = fix;
  const hasFix = !!fix;
  const load = useCallback(async () => {
    if (!enabled) return;
    const pos = fixRef.current ? coarse(fixRef.current) : null;
    setOpen(await store.api.openBookings(pos).catch(() => [] as OpenBooking[]));
  }, [store, enabled]);
  const counts = `${app.my?.driverBookings}|${app.my?.openBookings}`;
  useEffect(() => {
    void load();
  }, [load, counts, hasFix]);
  return [open, load];
}

export function OpenBookingsList({ open, onChanged }: { open: OpenBooking[]; onChanged: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  const when = useWhen();
  const [busy, run, error] = useBusy();
  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open.length === 0 ? (
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
                    try {
                      await store.api.claimBooking(r.id);
                    } finally {
                      onChanged();
                      await store.refresh().catch(() => {});
                    }
                  })
                }
                data-testid="take-booking"
              >
                {t("book.take")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** D1's bookings panel (v1, unchanged for an online driver who must not leave D1): P2 and the taken ones. */
export function DriverBookingsPanel() {
  const { t } = useI18n();
  const store = useStore();
  const [open, reloadOpen] = useOpenBookings(true);
  const [mine, setMine] = useState<RideView[] | null>(null);
  const loadMine = useCallback(() => store.api.bookings().then((all) => setMine(all.filter((r) => r.role === "driver")), () => setMine((l) => l ?? [])), [store]);
  // Not on every MyState: this panel is on D1, where the heartbeat brings one every 4 s.
  const listsKey = useListsKey();
  useEffect(() => {
    void loadMine();
  }, [loadMine, listsKey]);
  useEffect(() => {
    const id = setInterval(() => {
      void loadMine();
      void reloadOpen();
    }, 30_000);
    return () => clearInterval(id);
  }, [loadMine, reloadOpen]);
  const changed = () => {
    void loadMine();
    void reloadOpen();
  };
  return (
    <Panel title={t("planned.ridesToTake", { n: open?.length ?? 0 })} onClose={() => store.closePanel()}>
      <div className="stack">
        {open === null ? <p className="muted">{t("common.loading")}</p> : <OpenBookingsList open={open} onChanged={changed} />}
        {mine && mine.length > 0 && (
          <>
            <h3 className="section-title">{t("book.taken")}</h3>
            {mine.map((r) => (
              <DriverBookingCard key={r.id} r={r} onChanged={changed} />
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}
