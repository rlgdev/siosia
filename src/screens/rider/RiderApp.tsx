// Rider mode. One persistent map; the sheet below it switches between R1 → R2 → R3 → R4 following
// the server state of the rider's ride. Terminal states are fetched once the active ride disappears.

import { useEffect, useMemo, useRef, useState } from "react";
import { MapView, type MapMarker } from "../../components/MapView";
import { TopBar, useBusy } from "../../components/ui";
import { haversineKm, haversineM } from "../../core/geo";
import type { DriverPresence, LatLng, Place, RideView } from "../../core/types";
import { useI18n, type Translate } from "../../i18n";
import type { MessageKey } from "../../i18n/en";
import { readPref, writePref } from "../../services/device";
import { reverseLabel } from "../../services/geocode";
import { useGeo } from "../../services/geolocation";
import { getRoute } from "../../services/routing";
import { useRobots } from "../../state/demo";
import { useLiveRoute, useRiderRuntime } from "../../state/runtime";
import { useApp, useStore } from "../../state/store";
import { AfterRide } from "../AfterRide";
import { RiderActive } from "./RiderActive";
import { RiderHome, type Field } from "./RiderHome";
import { Searching } from "./Searching";
import { useEstimate } from "./useEstimate";

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Next 5-minute mark at or after `ms`. */
const roundUp5 = (ms: number) => Math.ceil(ms / 300_000) * 300_000;

/** A local time as the value of a datetime-local input ("2026-10-12T14:30"). */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function reasonText(t: Translate, reason: string | null): string {
  return reason ? t(`reason.${reason}` as MessageKey) : "";
}

export function RiderApp() {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  const api = store.api;
  const dep = app.deployment!;
  const cfg = app.cfg!;
  const my = app.my;
  const ride = my?.ride && my.ride.role === "rider" ? my.ride : null;
  const gps = useGeo(true);

  // A rider master profile starts every ride from its default places (the rider can change them).
  const defPickup = app.profile?.defaultPickup ?? null;
  const defDropoff = app.profile?.defaultDropoff ?? null;
  const [pickup, setPickup] = useState<Place | null>(defPickup);
  const [pickupSource, setPickupSource] = useState<"gps" | "manual">(defPickup ? "manual" : "gps");
  const [dropoff, setDropoff] = useState<Place | null>(defDropoff);
  const resetToDefaults = () => {
    if (defPickup) {
      setPickup(defPickup);
      setPickupSource("manual");
    }
    setDropoff(defDropoff);
  };
  const defaultsKey = JSON.stringify([defPickup, defDropoff]);
  const firstDefaults = useRef(true);
  useEffect(() => {
    // The profile changed under this screen (e.g. a master link was just confirmed).
    if (firstDefaults.current) {
      firstDefaults.current = false;
      return;
    }
    if (defPickup) {
      setPickup(defPickup);
      setPickupSource("manual");
    }
    if (defDropoff) setDropoff(defDropoff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultsKey]);
  const [pickMode, setPickMode] = useState<Field | null>(null);
  const [watched, setWatched] = useState<string | null>(null);
  const [ended, setEnded] = useState<RideView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(() => readPref<string[]>(`dismissedReceipts.${app.uid}`, []));
  const [drivers, setDrivers] = useState<DriverPresence[]>([]);
  const [busy, run, error, setError] = useBusy();
  // Booking for later: local wall-clock value of a datetime-local input.
  const [when, setWhen] = useState<"now" | "later">("now");
  const [laterAt, setLaterAt] = useState(() => toLocalInput(roundUp5(Date.now() + 60 * 60_000)));
  const [booked, setBooked] = useState<string | null>(null);
  const bookingCfg = dep.booking;
  // The earliest offered time is on a 5-minute mark with a minute to spare (iOS ignores `min`, so
  // the button checks it too).
  const laterMinMs = roundUp5(Date.now() + (bookingCfg.minLeadMin + 1) * 60_000);
  const laterMaxMs = Date.now() + bookingCfg.maxDays * 86_400_000;
  const laterMs = new Date(laterAt).getTime();
  const laterValid = Number.isFinite(laterMs) && laterMs >= Date.now() + bookingCfg.minLeadMin * 60_000 + 30_000 && laterMs <= laterMaxMs;

  // Pickup defaults to the GPS position until the rider picks another one (FR-010).
  const fix = gps.fix;
  useEffect(() => {
    if (!fix || pickupSource !== "gps" || ride) return;
    setPickup((p) => (!p || haversineM(p, fix) > 30 ? { lat: fix.lat, lng: fix.lng, label: t("rider.myLocation") } : p));
  }, [fix, pickupSource, ride, t]);

  // Follow the active ride; when it disappears, fetch how it ended.
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
        if (r.status === "completed" || r.status === "expired") setEnded(r);
        else if (r.status === "cancelled" && r.cancelledBy !== "rider") setNotice(t("active.cancelledByDriver", { reason: reasonText(t, r.cancelReason) }));
      })
      .catch(() => {});
  }, [rideId, watched, api, t]);

  const pending = my?.pendingReceipt && my.pendingReceipt.role === "rider" && !dismissed.includes(my.pendingReceipt.id) ? my.pendingReceipt : null;
  // A receipt restored after a reload (§12) stays until Done, even once rating removes it from
  // pendingReceipt — otherwise "Mark as paid" would become unreachable.
  useEffect(() => {
    if (!ride && !ended && pending) setEnded(pending);
  }, [ride, ended, pending]);
  const receipt = !ride && ended?.status === "completed" ? ended : null;
  const expired = !ride && ended?.status === "expired" ? ended : null;

  // Nearby cars: anonymous idle drivers within the dispatch radius (FR-018, Q4).
  const watching = !ride || ride.status === "requested";
  useEffect(() => (watching ? api.watchDrivers(setDrivers) : undefined), [watching, api]);
  const center: LatLng = pickup ?? fix ?? cfg.fallbackCenter;
  const nearby = useMemo(
    () => drivers.filter((d) => d.state === "idle" && haversineKm(d, center) <= dep.dispatchRadiusKm),
    [drivers, center, dep.dispatchRadiusKm]
  );

  useRobots(pickup ?? fix ?? cfg.fallbackCenter, true);

  const est = useEstimate(ride || receipt ? null : pickup, ride || receipt ? null : dropoff, dep.tariff, app.profile?.fixedFare ?? null);
  const searchLine = useEstimate(ride?.status === "requested" ? ride.pickup : null, ride?.status === "requested" ? ride.dropoff : null, dep.tariff);
  const rt = useRiderRuntime(ride);
  const liveTarget = ride ? (ride.status === "in_progress" ? ride.dropoff : ride.pickup) : null;
  const live = useLiveRoute(ride && ride.status !== "requested" ? rt.driverPos : null, liveTarget);

  let blockReason: string | null = null;
  if (dep.serviceArea && pickup && haversineKm(dep.serviceArea, pickup) > dep.serviceArea.radiusKm) blockReason = t("rider.outside");
  else if (est && !est.loading && est.km > dep.maxTripKm) blockReason = t("rider.tooFar", { km: dep.maxTripKm });

  const setPlace = (f: Field, p: Place, source: "gps" | "manual") => {
    if (f === "pickup") {
      setPickup(p);
      setPickupSource(source);
    } else setDropoff(p);
    setPickMode(null);
    setError(null);
  };

  const setPinned = (f: Field, p: LatLng) => {
    const place = { ...p, label: t("rider.pinned", { lat: p.lat.toFixed(4), lng: p.lng.toFixed(4) }) };
    setPlace(f, place, "manual");
    void reverseLabel(p, lang).then((label) => {
      if (!label) return;
      const update = (cur: Place | null) => (cur && cur.lat === p.lat && cur.lng === p.lng ? { ...cur, label } : cur);
      if (f === "pickup") setPickup(update);
      else setDropoff(update);
    });
  };

  const request = () =>
    run(async () => {
      if (!pickup || !dropoff || !est || est.loading) return;
      await api.requestRide({ pickup, dropoff, estKm: est.km, estMin: est.min, fareIsEstimate: est.estimate });
      await store.refresh();
    });

  const book = () =>
    run(async () => {
      if (!pickup || !dropoff || !est || est.loading || !laterValid) return;
      const r = await api.bookRide({
        pickup,
        dropoff,
        estKm: est.km,
        estMin: est.min,
        fareIsEstimate: est.estimate,
        // A booked time is wall-clock time: exactly what the rider picked (no clock-offset shift).
        scheduledFor: laterMs
      });
      const at = new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(
        r.scheduledFor ?? laterMs
      );
      setBooked(t("book.done", { time: at }));
      setWhen("now");
      resetToDefaults();
      await store.refresh();
    });

  const tryAgain = () =>
    run(async () => {
      if (!expired) return;
      const r = await getRoute(expired.pickup, expired.dropoff);
      setPickup(expired.pickup);
      setPickupSource("manual");
      setDropoff(expired.dropoff);
      await api.requestRide({
        pickup: expired.pickup,
        dropoff: expired.dropoff,
        estKm: Math.max(0.01, r2(r.km)),
        estMin: Math.max(1, r1(r.min)),
        fareIsEstimate: r.estimate
      });
      setEnded(null);
      await store.refresh();
    });

  const cancel = () =>
    run(async () => {
      if (!ride) return;
      await api.cancelRide(ride.id);
      await store.refresh();
    });

  const doneReceipt = () => {
    if (!receipt) return;
    const next = [...dismissed, receipt.id].slice(-20);
    setDismissed(next);
    writePref(`dismissedReceipts.${app.uid}`, next);
    setEnded(null);
    resetToDefaults();
  };

  // ---------- map scene ----------
  const markers: MapMarker[] = [];
  let line: LatLng[] | null = null;
  let lineEstimate = false;
  let fitPoints: LatLng[] = [];
  let fitKey = "";
  const showDraft = !ride && !receipt;
  if (showDraft || ride?.status === "requested") {
    const pu = ride ? ride.pickup : pickup;
    const dr = ride ? ride.dropoff : dropoff;
    if (pu) markers.push({ id: "pickup", kind: "pickup", pos: pu, draggable: !ride, onDragEnd: (p) => setPinned("pickup", p), title: t("rider.pickup") });
    if (dr) markers.push({ id: "dropoff", kind: "dropoff", pos: dr, draggable: !ride, onDragEnd: (p) => setPinned("dropoff", p), title: t("rider.dropoff") });
    for (const d of nearby) markers.push({ id: `n-${d.id}`, kind: "nearby", pos: d, heading: d.heading });
    const e = ride ? searchLine : est;
    line = e && !e.loading ? e.line : null;
    lineEstimate = !!e?.estimate;
    fitPoints = [pu, dr].filter(Boolean) as LatLng[];
    fitKey = `draft:${pu ? `${pu.lat.toFixed(3)},${pu.lng.toFixed(3)}` : ""}|${dr ? `${dr.lat.toFixed(4)},${dr.lng.toFixed(4)}` : ""}`;
  } else if (ride) {
    const stale = rt.driverSeenAt !== null && Date.now() - rt.driverSeenAt > 10_000;
    if (rt.driverPos)
      markers.push({ id: "car", kind: "car", pos: rt.driverPos, heading: rt.driverPos.heading, stale, title: ride.driver?.nickname, icon: ride.driver?.icon });
    if (ride.status !== "in_progress") markers.push({ id: "pickup", kind: "pickup", pos: ride.pickup });
    markers.push({ id: "dropoff", kind: "dropoff", pos: ride.dropoff });
    if (fix && ride.status !== "in_progress") markers.push({ id: "me", kind: "me", pos: fix });
    line = live.line;
    lineEstimate = live.estimate;
    fitPoints = [rt.driverPos, liveTarget].filter(Boolean) as LatLng[];
    fitKey = `ride:${ride.id}:${ride.status}:${rt.driverPos ? 1 : 0}`;
  }
  const accuracy = fix && fix.accuracy > 50 && (showDraft || ride) ? { pos: fix, radius: fix.accuracy } : null;

  let sheet;
  if (receipt) sheet = <AfterRide key={receipt.id} ride={receipt} onDone={doneReceipt} />;
  else if (expired)
    sheet = <Searching ride={expired} expiresAt={expired.expiresAt} expired nearbyCount={nearby.length} busy={busy} error={error} onCancel={cancel} onTryAgain={() => void tryAgain()} onBack={() => setEnded(null)} />;
  else if (ride?.status === "requested")
    sheet = <Searching ride={ride} expiresAt={ride.expiresAt} expired={false} nearbyCount={nearby.length} busy={busy} error={error} onCancel={() => void cancel()} onTryAgain={() => {}} onBack={() => {}} />;
  else if (ride) sheet = <RiderActive ride={ride} rt={rt} route={live} busy={busy} error={error} onCancel={() => void cancel()} />;
  else
    sheet = (
      <RiderHome
        pickup={pickup}
        dropoff={dropoff}
        setPlace={setPlace}
        pickMode={pickMode}
        setPickMode={setPickMode}
        gps={gps}
        near={center}
        est={est}
        currency={dep.tariff.currency}
        nearbyCount={nearby.length}
        blockReason={blockReason}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        when={when}
        setWhen={(w) => {
          setWhen(w);
          setBooked(null);
        }}
        laterAt={laterAt}
        setLaterAt={setLaterAt}
        laterMin={toLocalInput(laterMinMs)}
        laterMax={toLocalInput(laterMaxMs)}
        laterValid={laterValid}
        onBook={() => void book()}
        booked={booked}
        onDismissBooked={() => setBooked(null)}
        bookingsCount={my?.bookings ?? 0}
        minLeadMin={bookingCfg.minLeadMin}
        onOpenBookings={() => store.openPanel("bookings")}
        onRequest={() => void request()}
        busy={busy}
        error={error}
      />
    );

  return (
    <div className="screen">
      <TopBar title={t("home.ride")} />
      <MapView
        endpoints={cfg.map}
        center={center}
        markers={markers}
        accuracy={accuracy}
        route={line}
        routeEstimate={lineEstimate}
        fitKey={fitKey}
        fitPoints={fitPoints}
        bottomInset={320}
        label={t("home.ride")}
        onTap={(p) => {
          if (showDraft && pickMode) setPinned(pickMode, p);
        }}
        onLongPress={(p) => {
          if (showDraft) setPinned(pickMode ?? "dropoff", p);
        }}
      />
      {sheet}
    </div>
  );
}
