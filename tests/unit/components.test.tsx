// Component tests (spec §11 "Component"): screens render their states in EN and PL; S4 appears
// whenever sharing is on.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { SharingBanner } from "../../src/components/SharingBanner";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import type { Lang, OfferView, RideView } from "../../src/core/types";
import { I18nProvider } from "../../src/i18n";
import { AfterRide } from "../../src/screens/AfterRide";
import { Home } from "../../src/screens/Home";
import { OfferCard } from "../../src/screens/driver/OfferCard";
import { Searching } from "../../src/screens/rider/Searching";
import { sharing } from "../../src/state/sharing";
import { AppStore, StoreContext } from "../../src/state/store";

function setup(lang: Lang, ui: ReactNode, backend?: Partial<Backend>) {
  const store = new AppStore();
  store.backend = (backend ?? {}) as Backend;
  (store as unknown as { snap: object }).snap = {
    ...store.get(),
    phase: "ready",
    lang,
    profile: { userId: "u", nickname: "Ola", language: lang, riderCancels: 0, driverCancels: 0, lateCancels: 0, rating: { mean: null, count: 0 } },
    deployment: DEFAULT_CONFIG,
    cfg: { backend: "mock" }
  };
  return render(
    <StoreContext.Provider value={store}>
      <I18nProvider lang={lang}>{ui}</I18nProvider>
    </StoreContext.Provider>
  );
}

/** A fixed request deadline (server clock), 10 min ahead. */
const EXP = Date.now() + 600_000;

const ride = (over: Partial<RideView> = {}): RideView => ({
  id: "r1",
  status: "requested",
  role: "rider",
  pickup: { lat: 52.2, lng: 21, label: "Marszałkowska 1" },
  dropoff: { lat: 52.25, lng: 21.05, label: "Praga" },
  estKm: 5.2,
  estMin: 14,
  fare: 25.5,
  currency: "PLN",
  fareIsEstimate: false,
  actualKm: 5.6,
  actualMin: 15.5,
  requestedAt: Date.now() - 20_000,
  dispatchStartedAt: Date.now() - 20_000,
  acceptedAt: null,
  arrivedAt: null,
  startedAt: null,
  endedAt: null,
  cancelledBy: null,
  cancelReason: null,
  paid: false,
  collected: false,
  notifiedCount: 3,
  redispatchCount: 0,
  round: 1,
  expiresAt: EXP,
  scheduledFor: null,
  rider: { nickname: "Ola", rating: { mean: null, count: 0 } },
  driver: null,
  myRating: null,
  ...over
});

describe("S1 Home", () => {
  it.each([
    ["en", "Hi, Ola", "Ride", "Drive"],
    ["pl", "Cześć, Ola", "Jadę", "Wożę"]
  ] as const)("renders in %s", (lang, hello, ride, drive) => {
    setup(lang, <Home />);
    expect(screen.getByRole("heading", { name: hello })).toBeInTheDocument();
    expect(screen.getByTestId("mode-ride")).toHaveTextContent(ride);
    expect(screen.getByTestId("mode-drive")).toHaveTextContent(drive);
  });
});

describe("S4 sharing banner", () => {
  it("is visible exactly while something is sharing, and Stop ends it", async () => {
    setup("en", <SharingBanner />);
    expect(screen.queryByTestId("sharing-banner")).toBeNull();
    const stop = vi.fn(() => sharing.set("driver", null));
    act(() => sharing.set("driver", { role: "driver", stop }));
    expect(screen.getByTestId("sharing-banner")).toHaveTextContent("Sharing your live location · online as a driver");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalled();
    expect(screen.queryByTestId("sharing-banner")).toBeNull();
  });
});

describe("R2 Searching", () => {
  it("shows notified drivers and cancel, then Try again when expired", () => {
    const { rerender } = setup(
      "en",
      <Searching ride={ride()} expiresAt={EXP} expired={false} nearbyCount={2} busy={false} error={null} onCancel={() => {}} onTryAgain={() => {}} onBack={() => {}} />
    );
    expect(screen.getByText(/Drivers notified: 3/)).toBeInTheDocument();
    // The deadline is server time, shown as this device's local wall clock.
    const expected = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(EXP);
    expect(screen.getByTestId("search-until")).toHaveTextContent(`We keep looking until ${expected}.`);
    expect(screen.getByTestId("cancel-request")).toBeEnabled();
    rerender(
      <StoreContext.Provider value={new AppStore()}>
        <I18nProvider lang="pl">
          <Searching ride={ride({ status: "expired" })} expiresAt={Date.now()} expired nearbyCount={0} busy={false} error={null} onCancel={() => {}} onTryAgain={() => {}} onBack={() => {}} />
        </I18nProvider>
      </StoreContext.Provider>
    );
    expect(screen.getByText("Żaden kierowca nie przyjął zamówienia.")).toBeInTheDocument();
    expect(screen.getByTestId("try-again")).toHaveTextContent("Spróbuj ponownie");
  });
});

describe("R4 Receipt / D4 Summary", () => {
  it("shows the frozen fare next to actual totals and rates once", async () => {
    const rate = vi.fn(async () => {});
    const getRide = vi.fn(async () => ride({ status: "completed", myRating: 4 }));
    setup("en", <AfterRide ride={ride({ status: "completed" })} onDone={() => {}} />, { rate, getRide, markPaid: vi.fn(async () => {}) });
    expect(screen.getByTestId("receipt-fare")).toHaveTextContent("25.50");
    expect(screen.getByText(/actual 5.6 km · estimated 5.2 km/)).toBeInTheDocument();
    expect(screen.getByTestId("send-rating")).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "4 of 5 stars" }));
    await userEvent.click(screen.getByTestId("send-rating"));
    expect(rate).toHaveBeenCalledWith("r1", 4, "");
    expect(await screen.findByText("Thanks for rating!")).toBeInTheDocument();
  });

  it("offers Collected to the driver in Polish", () => {
    setup("pl", <AfterRide ride={ride({ status: "completed", role: "driver" })} onDone={() => {}} />);
    expect(screen.getByTestId("mark-paid")).toHaveTextContent("Oznacz opłatę jako pobraną");
    expect(screen.getByText("Oceń pasażera")).toBeInTheDocument();
  });
});

describe("D2 Offer card", () => {
  it("counts down from 20 s and times out once", async () => {
    vi.useFakeTimers();
    const offer: OfferView = {
      id: "o1",
      rideId: "r1",
      status: "offered",
      offeredAt: Date.now(),
      driverDistanceKm: 1.2,
      pickup: { lat: 52.2, lng: 21, label: "A" },
      dropoff: { lat: 52.25, lng: 21.05, label: "B" },
      estKm: 5.2,
      estMin: 14,
      fare: 25.5,
      currency: "PLN",
      fareIsEstimate: false,
      rider: { nickname: "Ola", rating: { mean: 4.8, count: 12 } }
    };
    const onTimeout = vi.fn();
    setup("en", <OfferCard offer={offer} queued={1} offerS={20} from={null} busy={false} onAccept={() => {}} onDecline={() => {}} onTimeout={onTimeout} />);
    expect(screen.getByTestId("offer-card")).toHaveTextContent("Ola");
    expect(screen.getByTestId("offer-card")).toHaveTextContent("★ 4.8");
    expect(screen.getByText("+1 waiting")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
