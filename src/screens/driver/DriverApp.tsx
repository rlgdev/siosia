// Driver mode: D1 dashboard with the online switch, D2 offer overlay, D3 trip, D4 summary.

import { useCallback, useEffect, useState } from "react";
import { MapView, type MapMarker } from "../../components/MapView";
import { Money, Notice, Sheet, TopBar, useBusy } from "../../components/ui";
import type { DriverCancelReason, Earnings, LatLng, RideView } from "../../core/types";
import { ServerError } from "../../core/types";
import { useI18n } from "../../i18n";
import { readPref, wakeLockSupported, writePref } from "../../services/device";
import { clearTripKm, useDriverRuntime, useLiveRoute } from "../../state/runtime";
import { useApp, useStore } from "../../state/store";
import { AfterRide } from "../AfterRide";
import { DriverTrip } from "./DriverTrip";
import { OfferCard } from "./OfferCard";
import { VehicleSetup } from "./VehicleForm";

export function DriverApp() {
  const app = useApp();
  if (!app.vehicle) return <VehicleSetup />;
  return <DriverMain />;
}

function DriverMain() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const api = store.api;
  const dep = app.deployment!;
  const cfg = app.cfg!;
  const my = app.my;
  const rt = useDriverRuntime();
  const ride = my?.ride && my.ride.role === "driver" ? my.ride : null;
  const offer = !ride ? my?.offer ?? null : null;
  const [busy, run, error, setError] = useBusy();
  const [watched, setWatched] = useState<string | null>(null);
  const [ended, setEnded] = useState<RideView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [earn, setEarn] = useState<Earnings | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(() => readPref<string[]>(`dismissedSummaries.${app.uid}`, []));

  const rideId = ride?.id ?? null;
  useEffect(() => {
    if (rideId) {
      setWatched(rideId);
      setEnded(null);
      setNotice(null);
    }
  }, [rideId]);
  useEffect(() => {
    if (rideId || !watched) return;
    const id = watched;
    setWatched(null);
    api
      .getRide(id)
      .then((r) => {
        if (r.status === "completed" && r.role === "driver") setEnded(r);
        else if (r.status === "cancelled" && r.cancelledBy === "rider") setNotice(t("trip.riderCancelled"));
      })
      .catch(() => {});
  }, [rideId, watched, api, t]);

  const pending = my?.pendingReceipt && my.pendingReceipt.role === "driver" && !dismissed.includes(my.pendingReceipt.id) ? my.pendingReceipt : null;
  const summary = !ride ? (ended?.status === "completed" ? ended : pending) : null;

  // Today's earnings on D1 (FR-027), refreshed after each trip.
  useEffect(() => {
    void api.earnings().then(setEarn, () => {});
  }, [api, summary?.id, rideId]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  // Going online needs a location fix first (goOnline throws not_online when location is denied).
  const toggleOnline = () => run(() => (rt.online ? rt.goOffline() : rt.goOnline()));

  const decide = useCallback(
    (decision: "accept" | "decline" | "timeout") =>
      run(async () => {
        if (!offer) return;
        try {
          await api.decideOffer(offer.id, decision);
        } catch (e) {
          if (e instanceof ServerError && (e.code === "taken" || e.code === "offer_expired")) setToast(t(e.code === "taken" ? "offer.taken" : "offer.expired"));
          else throw e;
        } finally {
          await store.refresh();
        }
      }),
    [offer, api, store, run, t]
  );
  const onTimeout = useCallback(() => void decide("timeout"), [decide]);

  const advance = (to: "arrived" | "in_progress" | "completed") =>
    run(async () => {
      if (!ride) return;
      await api.advance(ride.id, to, to === "completed" ? rt.tripKm : undefined);
      if (to === "completed") clearTripKm(ride.id);
      await store.refresh();
    });

  const cancel = (reason: DriverCancelReason) =>
    run(async () => {
      if (!ride) return;
      await api.cancelRide(ride.id, reason);
      await store.refresh();
    });

  const doneSummary = () => {
    if (!summary) return;
    const next = [...dismissed, summary.id].slice(-20);
    setDismissed(next);
    writePref(`dismissedSummaries.${app.uid}`, next);
    setEnded(null);
  };

  // Live route from my position to the current target.
  const target = ride ? (ride.status === "in_progress" ? ride.dropoff : ride.pickup) : null;
  const live = useLiveRoute(ride ? rt.fix : null, target);

  // ---------- map scene ----------
  const markers: MapMarker[] = [];
  let fitPoints: LatLng[] = [];
  let fitKey = "";
  const me = rt.fix;
  if (me) markers.push({ id: "me", kind: "car", pos: me, heading: me.heading });
  if (offer) {
    markers.push({ id: "pickup", kind: "pickup", pos: offer.pickup }, { id: "dropoff", kind: "dropoff", pos: offer.dropoff });
    fitPoints = [me, offer.pickup, offer.dropoff].filter(Boolean) as LatLng[];
    fitKey = `offer:${offer.id}`;
  } else if (ride) {
    if (ride.status !== "in_progress") {
      markers.push({ id: "pickup", kind: "pickup", pos: ride.pickup });
      if (rt.riderPos) markers.push({ id: "rider", kind: "rider", pos: rt.riderPos, title: t("trip.riderLive") });
    }
    markers.push({ id: "dropoff", kind: "dropoff", pos: ride.dropoff });
    fitPoints = [me, target].filter(Boolean) as LatLng[];
    fitKey = `trip:${ride.id}:${ride.status}:${me ? 1 : 0}`;
  } else {
    fitPoints = me ? [me] : [];
    fitKey = me ? "me" : "";
  }
  const accuracy = me && me.accuracy > 50 ? { pos: me, radius: me.accuracy } : null;

  let sheet;
  if (summary) sheet = <AfterRide key={summary.id} ride={summary} onDone={doneSummary} />;
  else if (ride)
    sheet = <DriverTrip ride={ride} rt={rt} route={live} timers={dep.timers} busy={busy} error={error} onAdvance={(to) => void advance(to)} onCancel={(r) => void cancel(r)} />;
  else
    sheet = (
      <Sheet>
        {notice && (
          <Notice kind="warn">
            {notice}{" "}
            <button type="button" className="btn btn-link" onClick={() => setNotice(null)}>
              {t("common.close")}
            </button>
          </Notice>
        )}
        <div className="online-row">
          <div>
            <span className={`dot ${rt.online ? "dot-on" : "dot-off"}`} aria-hidden="true" />
            <strong data-testid="driver-state">{t(rt.online ? "driver.online" : "driver.offline")}</strong>
            <p className="muted small">{t(rt.online ? "driver.waiting" : "driver.offlineHint")}</p>
          </div>
          <button
            type="button"
            className={rt.online ? "btn btn-secondary" : "btn btn-primary"}
            disabled={busy}
            onClick={() => {
              setError(null);
              void toggleOnline();
            }}
            data-testid="toggle-online"
          >
            {t(rt.online ? "driver.goOffline" : "driver.goOnline")}
          </button>
        </div>
        {(rt.geoStatus === "denied" || (error && !rt.online && error === t("err.not_online"))) && <Notice kind="warn">{t("geo.driverNeeds")}</Notice>}
        {error && error !== t("err.not_online") && <p className="form-error" role="alert">{error}</p>}
        {rt.online && !rt.fix && <p className="hint">{t("geo.waiting")}</p>}
        {rt.online && (!rt.wakeOk || !wakeLockSupported()) && (
          <Notice kind="warn">
            <strong>{t("wake.title")}</strong> {t("wake.body")}
          </Notice>
        )}
        {rt.online && rt.wakeOk && <p className="muted small">{t("driver.keepOpen")}</p>}
        {earn && (
          <div className="kv">
            <span>
              {t("driver.today")} · {t("driver.rides", { n: earn.todayCount })}
            </span>
            <strong data-testid="today-earnings">
              <Money amount={earn.todayTotal} currency={earn.currency} />
            </strong>
          </div>
        )}
        <button type="button" className="btn btn-link" onClick={() => store.openPanel("earnings")}>
          {t("profile.earnings")}
        </button>
      </Sheet>
    );

  return (
    <div className="screen">
      <TopBar title={t("home.drive")} />
      <MapView
        endpoints={cfg.map}
        center={me ?? cfg.fallbackCenter}
        markers={markers}
        accuracy={accuracy}
        route={ride ? live.line : null}
        routeEstimate={live.estimate}
        fitKey={fitKey}
        fitPoints={fitPoints}
        bottomInset={300}
        label={t("home.drive")}
      />
      {sheet}
      {offer && (
        <OfferCard
          offer={offer}
          queued={my?.queuedOffers ?? 0}
          offerS={dep.timers.offerS}
          from={me}
          busy={busy}
          onAccept={() => void decide("accept")}
          onDecline={() => void decide("decline")}
          onTimeout={onTimeout}
        />
      )}
      {toast && (
        <div className="toast" role="status" data-testid="toast">
          {toast}
        </div>
      )}
    </div>
  );
}
