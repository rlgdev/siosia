// Component tests (spec §11 "Component"): screens render their states in EN and PL; S4 appears
// whenever sharing is on. 2.1: the S1 badge of open requests (FR-161) and the car colour (FR-170).

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync } from "node:fs";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { DriverIcon, MasterChip, ProfileIcon } from "../../src/components/ProfileIcon";
import { CAR_PAINTS, carPaint, iconLabel, iconSvg, normalPaint, profileIcon, shade, shadesOf } from "../../src/components/profileIcons";
import { INFO_TIP_MS, InfoTip } from "../../src/components/InfoTip";
import { SharingBanner } from "../../src/components/SharingBanner";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import type { Lang, MyState, OfferView, Profile, RideView, Vehicle } from "../../src/core/types";
import { I18nProvider, translator } from "../../src/i18n";
import { en } from "../../src/i18n/en";
import { pl } from "../../src/i18n/pl";
import { AfterRide } from "../../src/screens/AfterRide";
import { Home } from "../../src/screens/Home";
import { RiderBookingCard } from "../../src/screens/Bookings";
import { driverEndedNotice, VehicleLine } from "../../src/screens/driver/DriverApp";
import { OfferCard } from "../../src/screens/driver/OfferCard";
import { RiderActive } from "../../src/screens/rider/RiderActive";
import { endedNotice, reasonText } from "../../src/screens/rider/RiderApp";
import { Searching } from "../../src/screens/rider/Searching";
import { navigationUrl } from "../../src/services/device";
import type { GeoFix } from "../../src/services/geolocation";
import { DEPART_ACCURACY_M, DEPART_M, DEPART_RETRY_MS, hasDeparted, type RiderRuntime } from "../../src/state/runtime";
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
  departedAt: null,
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

describe("S1 Home (FR-080, FR-083, V22)", () => {
  it.each([
    ["en", "Hi, Ola", "Siosia", "Planned", "History"],
    ["pl", "Cześć, Ola", "Siosia", "Zaplanowane", "Historia"]
  ] as const)("shows three buttons in %s and no mode cards", (lang, hello, siosia, planned, history) => {
    setup(lang, <Home />);
    expect(screen.getByRole("heading", { name: hello })).toBeInTheDocument();
    expect(screen.getByTestId("start-siosia")).toHaveTextContent(siosia);
    expect(screen.getByTestId("start-planned")).toHaveTextContent(planned);
    expect(screen.getByTestId("start-history")).toHaveTextContent(history);
    expect(screen.queryByTestId("mode-ride")).toBeNull();
    expect(screen.queryByTestId("mode-drive")).toBeNull();
    expect(screen.queryByTestId("badge-answer")).toBeNull();
  });

  it("badges requests to answer and names the next planned item", () => {
    const at = new Date();
    at.setHours(at.getHours() + 3, 0, 0, 0);
    const store = new AppStore();
    (store as unknown as { snap: object }).snap = {
      ...store.get(),
      phase: "ready",
      lang: "en",
      profile: { userId: "u", nickname: "Ola", language: "en", riderCancels: 0, driverCancels: 0, lateCancels: 0, rating: { mean: null, count: 0 } },
      deployment: DEFAULT_CONFIG,
      cfg: { backend: "mock" },
      my: { toAnswer: 2, planned: 3, nextPlanned: { kind: "appointment", at: at.getTime(), title: "Childcare", serviceId: "childcare" } }
    };
    render(
      <StoreContext.Provider value={store}>
        <I18nProvider lang="en">
          <Home />
        </I18nProvider>
      </StoreContext.Provider>
    );
    expect(screen.getByTestId("badge-answer")).toHaveTextContent("2 to answer");
    expect(screen.getByTestId("badge-planned")).toHaveTextContent("3");
    expect(screen.getByTestId("planned-next")).toHaveTextContent(/^Next: Childcare, (today|tomorrow) \d\d:00$/);
  });
});

describe("S1 Home: a finished ride's receipt after a relaunch (C8, §12)", () => {
  /** The app reopens on S1 (FR-082) while my state still holds the unrated receipt. */
  function home(lang: Lang, my: Partial<MyState>, extra: Record<string, unknown> = {}) {
    const store = new AppStore();
    (store as unknown as { snap: object }).snap = {
      ...store.get(),
      phase: "ready",
      lang,
      uid: "u",
      profile: { userId: "u", nickname: "Ola", language: lang, riderCancels: 0, driverCancels: 0, lateCancels: 0, rating: { mean: null, count: 0 } },
      deployment: DEFAULT_CONFIG,
      cfg: { backend: "mock" },
      my: { toAnswer: 0, planned: 0, nextPlanned: null, ride: null, ...my },
      ...extra
    };
    const view = render(
      <StoreContext.Provider value={store}>
        <I18nProvider lang={lang}>
          <Home />
        </I18nProvider>
      </StoreContext.Provider>
    );
    return { store, ...view };
  }

  it("points the rider to R4 (Mark as paid, rating)", async () => {
    const { store } = home("en", { pendingReceipt: ride({ id: "r9", status: "completed" }) });
    const card = screen.getByTestId("home-receipt");
    expect(card).toHaveTextContent("Your ride is over — pay and rate");
    await userEvent.click(card);
    expect(store.get().screen).toBe("ride");
  });

  it("points a driver to D4 in Polish; nothing once Done was tapped or while a ride is on", async () => {
    const kia = { make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4 };
    const summary = ride({ id: "r8", status: "completed", role: "driver" });
    const first = home("pl", { pendingReceipt: summary }, { vehicle: kia });
    expect(screen.getByTestId("home-receipt")).toHaveTextContent("Kurs zakończony — pobierz opłatę i oceń");
    await userEvent.click(screen.getByTestId("home-receipt"));
    expect(first.store.get().screen).toBe("drive");
    first.unmount();
    // Done on D4 (the same per-user list DriverApp keeps).
    localStorage.setItem("siosia.dismissedSummaries.u", JSON.stringify(["r8"]));
    const done = home("pl", { pendingReceipt: summary }, { vehicle: kia });
    expect(screen.queryByTestId("home-receipt")).toBeNull();
    done.unmount();
    localStorage.removeItem("siosia.dismissedSummaries.u");
    home("en", { pendingReceipt: ride({ id: "r9", status: "completed" }), ride: ride({ id: "r10", status: "accepted" }) });
    expect(screen.queryByTestId("home-receipt")).toBeNull();
  });
});

describe("a ride ended because its appointment was cancelled (C3)", () => {
  const ended = ride({ status: "cancelled", cancelledBy: "system", cancelReason: "appointment_cancelled", acceptedAt: Date.now() - 60_000 });

  it("tells the rider and the driver why, in EN and PL, never as a raw key", () => {
    expect(endedNotice(translator("en"), ended)).toBe("The appointment was cancelled, so this ride was cancelled too.");
    expect(endedNotice(translator("pl"), ended)).toBe("Termin został odwołany, więc ten przejazd też został odwołany.");
    expect(driverEndedNotice(translator("en"), { ...ended, role: "driver" })).toBe("The appointment this ride was for was cancelled, so the ride is cancelled too.");
    expect(driverEndedNotice(translator("pl"), { ...ended, role: "driver" })).toContain("został odwołany");
    // The reason itself has words wherever reasons are shown; an unknown one reads as Other.
    expect(en["reason.appointment_cancelled"]).toBe("the appointment was cancelled");
    expect(pl["reason.appointment_cancelled"]).toBe("termin został odwołany");
    expect(reasonText(translator("en"), "appointment_cancelled")).toBe("the appointment was cancelled");
    expect(reasonText(translator("en"), "something_new")).toBe("Other");
  });

  it("keeps the other endings as they were", () => {
    const t = translator("en");
    expect(endedNotice(t, ride({ status: "cancelled", cancelledBy: "driver", cancelReason: "no_show" }))).toBe("The driver ended the ride: Rider no-show.");
    expect(endedNotice(t, ride({ status: "cancelled", cancelledBy: "rider" }))).toBeNull();
    expect(driverEndedNotice(t, ride({ status: "cancelled", cancelledBy: "rider", role: "driver" }))).toBe("The rider cancelled the ride.");
    expect(driverEndedNotice(t, ride({ status: "cancelled", cancelledBy: "driver", cancelReason: "no_show", role: "driver" }))).toBeNull();
  });

  it("and the too-many message names no stale number (C13)", () => {
    expect(en["err.too_many"]).toBe("You've reached the limit of open requests or bookings — finish or cancel one first.");
    expect(pl["err.too_many"]).not.toMatch(/\d/);
    expect(en["err.too_many"]).not.toMatch(/\d/);
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

describe("R3 Active ride: the driver's app goes quiet (§12)", () => {
  const assigned = (status: "accepted" | "in_progress") =>
    ride({ status, driver: { nickname: "Roman", rating: { mean: null, count: 0 }, icon: null, vehicle: { make: "Porsche", model: "Taycan", colour: "Zielony", plate: "W1LLRUN", seats: 4 } } } as Partial<RideView>);
  const rt = (over: Partial<RiderRuntime>): RiderRuntime => ({
    driverPos: { lat: 52.21, lng: 21.01, heading: null, t: Date.now() } as RiderRuntime["driverPos"],
    driverSeenAt: Date.now(),
    driverPresent: true,
    sharingOn: true,
    setSharingOn: () => {},
    fix: null,
    ...over
  });
  const route = { line: null, km: 2, min: 5, estimate: false };

  it("keeps the ride and the last position, says it is paused, and drops the stale ETA", () => {
    setup("pl", <RiderActive ride={assigned("accepted")} rt={rt({ driverPresent: false, driverSeenAt: Date.now() - 125_000 })} route={route} busy={false} error={null} onCancel={() => {}} />);
    expect(screen.getByTestId("ride-status")).toHaveTextContent("Kierowca jest w drodze");
    expect(screen.getByTestId("ride-status")).not.toHaveTextContent("min");
    expect(screen.getByTestId("driver-paused")).toHaveTextContent("Twój kurs jest aktualny");
    expect(screen.getByTestId("driver-last-seen")).toHaveTextContent("Ostatnio widziany 2 min temu");
    expect(screen.getByTestId("driver-card")).toHaveTextContent("W1LLRUN");
  });

  it("shows nothing extra while positions arrive, and 'reconnecting' during the trip", () => {
    const { unmount } = setup("en", <RiderActive ride={assigned("accepted")} rt={rt({})} route={route} busy={false} error={null} onCancel={() => {}} />);
    expect(screen.queryByTestId("driver-paused")).toBeNull();
    expect(screen.getByTestId("ride-status")).toHaveTextContent("ETA 5 min");
    unmount();
    setup("en", <RiderActive ride={assigned("in_progress")} rt={rt({ driverPresent: false, driverSeenAt: Date.now() - 20_000 })} route={route} busy={false} error={null} onCancel={() => {}} />);
    expect(screen.getByText("Driver reconnecting…")).toBeInTheDocument();
    expect(screen.queryByTestId("driver-paused")).toBeNull();
    expect(screen.getByTestId("driver-last-seen")).toHaveTextContent("Last seen 20 s ago");
  });

  it("stays neutral when only this phone lags, and has its own wording when no car was ever shown", () => {
    const { unmount } = setup("en", <RiderActive ride={assigned("accepted")} rt={rt({ driverSeenAt: Date.now() - 20_000 })} route={route} busy={false} error={null} onCancel={() => {}} />);
    expect(screen.queryByTestId("driver-paused")).toBeNull(); // still in the channel: maybe our own connection
    expect(screen.getByTestId("driver-last-seen")).toHaveTextContent("Last seen 20 s ago");
    unmount();
    setup("en", <RiderActive ride={assigned("accepted")} rt={rt({ driverPos: null, driverSeenAt: null, driverPresent: false })} route={route} busy={false} error={null} onCancel={() => {}} />);
    expect(screen.getByTestId("driver-paused")).toHaveTextContent("the car appears on your map when it's back");
  });

  it("tells the rider why a ride is searching again after the driver's phone stopped answering", () => {
    setup("en", <Searching ride={ride({ redispatchCount: 1, cancelReason: "driver_lost" })} expiresAt={EXP} expired={false} nearbyCount={1} busy={false} error={null} onCancel={() => {}} onTryAgain={() => {}} onBack={() => {}} />);
    expect(screen.getByText("Your driver's phone stopped answering — we're finding you another one.")).toBeInTheDocument();
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

// ---------- 2.1 ----------

/** Renders `ui` on a ready store with these snapshot fields; returns the store too. */
function mount(lang: Lang, ui: ReactNode, snap: Record<string, unknown>, backend: Partial<Backend> = {}) {
  const store = new AppStore();
  store.backend = backend as Backend;
  (store as unknown as { snap: object }).snap = { ...store.get(), phase: "ready", lang, deployment: DEFAULT_CONFIG, cfg: { backend: "mock" }, ...snap };
  const view = render(
    <StoreContext.Provider value={store}>
      <I18nProvider lang={lang}>{ui}</I18nProvider>
    </StoreContext.Provider>
  );
  return { store, ...view };
}

const OLA: Profile = {
  userId: "u",
  nickname: "Ola",
  language: "en",
  riderCancels: 0,
  driverCancels: 0,
  lateCancels: 0,
  rating: { mean: null, count: 0 },
  masterId: null,
  masterRole: null,
  defaultPickup: null,
  defaultDropoff: null,
  masterVehicle: null,
  icon: null,
  fixedFare: null,
  publicId: "pub-ola",
  offers: [],
  offersPreset: false,
  home: null
};
/** The Roman master link: a driver profile with the green Taycan as its icon. */
const ROMAN: Profile = {
  ...OLA,
  nickname: "Roman",
  masterId: "m-roman",
  masterRole: "driver",
  masterVehicle: { make: "Porsche", model: "Taycan Cross Turismo", colour: "Zielony", seats: 4 },
  icon: "taycan-ct-green",
  offersPreset: true
};
const TAYCAN: Vehicle = { make: "Porsche", model: "Taycan Cross Turismo", colour: "Zielony", plate: "WX 5555", seats: 4, paint: null };
const bodyFill = (el: HTMLElement) => el.querySelector('[data-part="body"]')?.getAttribute("fill");

describe("2.1 S1: open requests others made (FR-161)", () => {
  it.each([
    ["en", "2 you could help with", "You could help: 2"],
    ["pl", "możesz pomóc: 2", "Możesz pomóc: 2"]
  ] as const)("badges them on Siosia in %s, Planned says where they are, and Siosia still opens C1", async (lang, badge, hint) => {
    const { store } = mount(lang, <Home />, { profile: { ...OLA, language: lang }, my: { toAnswer: 0, openRequests: 2, planned: 0, nextPlanned: null } });
    expect(screen.getByTestId("badge-open")).toHaveTextContent(badge);
    expect(screen.getByTestId("planned-open")).toHaveTextContent(hint);
    await userEvent.click(screen.getByTestId("start-siosia"));
    expect(store.get().screen).toBe("catalog");
  });

  it("shows neither without open requests", () => {
    mount("en", <Home />, { profile: OLA, my: { toAnswer: 0, openRequests: 0, planned: 0, nextPlanned: null } });
    expect(screen.queryByTestId("badge-open")).toBeNull();
    expect(screen.queryByTestId("planned-open")).toBeNull();
  });
});

describe("2.1 the car icon in the car's paint (FR-170, V38)", () => {
  it("has ten colours named in EN and PL; the green Taycan keeps its shades, any other paint is shaded from it", () => {
    expect(CAR_PAINTS.map((p) => p.id)).toEqual(["green", "black", "white", "silver", "grey", "blue", "red", "yellow", "orange", "brown"]);
    expect(CAR_PAINTS.every((p) => /^#[0-9a-f]{6}$/.test(p.hex))).toBe(true);
    expect(carPaint("#C62828")?.name).toEqual({ en: "Red", pl: "Czerwony" });
    expect(carPaint("#ef6c00")?.name.pl).toBe("Pomarańczowy");
    expect(normalPaint(" #1E5AA8 ")).toBe("#1e5aa8");
    expect(normalPaint("red")).toBeNull();
    expect(shadesOf(null)).toEqual({ body: "#2e7d4f", lower: "#22603b", highlight: "#7cc896", trim: "#1d5233" });
    expect(shadesOf("#2E7D4F")).toEqual(shadesOf(null));
    expect(shade("#808080", -0.5)).toBe("#404040");
    expect(shade("#000000", 1)).toBe("#ffffff");
    const red = shadesOf("#c62828");
    expect(red.body).toBe("#c62828");
    expect(red.lower).toBe(shade("#c62828", -0.25));
    expect(red.trim).toBe(shade("#c62828", -0.37));
    expect(red.highlight).toBe(shade("#c62828", 0.42));
    const def = profileIcon("taycan-ct-green")!;
    const svg = iconSvg(def, "#c62828");
    for (const c of Object.values(red)) expect(svg).toContain(`"${c}"`);
    for (const c of ["#2e7d4f", "#22603b", "#7cc896", "#1d5233"]) expect(svg).not.toContain(c);
    expect(iconSvg(def, null)).toBe(def.svg);
    expect(def.svg).toContain('fill="#2e7d4f"');
    expect(iconLabel(def, "#c62828", "en")).toBe("Red Taycan Cross Turismo");
    expect(iconLabel(def, "#c62828", "pl")).toBe("Czerwony Taycan Cross Turismo");
    expect(iconLabel(def, null, "en")).toBe("Green Taycan Cross Turismo");
    expect(iconLabel(profileIcon("car")!, "#1e5aa8", "pl")).toBe("Niebieski samochód");
    expect(iconLabel(profileIcon("car")!, "#123456", "en")).toBe("Car");
  });

  it("ProfileIcon draws it in the paint and names it, in EN and PL", () => {
    const { unmount } = mount("en", <ProfileIcon icon="taycan-ct-green" paint="#c62828" />, {});
    expect(bodyFill(screen.getByRole("img", { name: "Red Taycan Cross Turismo" }))).toBe("#c62828");
    unmount();
    mount("pl", <ProfileIcon icon="taycan-ct-green" />, {});
    expect(bodyFill(screen.getByRole("img", { name: "Zielony Taycan Cross Turismo" }))).toBe("#2e7d4f");
  });

  it("S1: the driver profile's car icon opens Car colour; Red names the colour and redraws the icon at once", async () => {
    const setCarColour = vi.fn(async (colour: string, paint: string) => ({ ...TAYCAN, colour, paint }));
    const { store } = mount("en", <Home />, { profile: ROMAN, vehicle: TAYCAN, my: { toAnswer: 0, planned: 0, nextPlanned: null } }, { setCarColour });
    const button = screen.getByTestId("car-icon");
    expect(button).toHaveAccessibleName("Change car colour");
    expect(within(button).getByRole("img", { name: "Green Taycan Cross Turismo" })).toBeInTheDocument();
    await userEvent.click(button);
    const sheet = screen.getByRole("dialog", { name: "Car colour" });
    for (const p of CAR_PAINTS) expect(within(sheet).getByTestId(`paint-${p.id}`)).toHaveTextContent(p.name.en);
    await userEvent.click(within(sheet).getByTestId("paint-red"));
    await waitFor(() => expect(setCarColour).toHaveBeenCalledWith("Red", "#c62828"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.get().vehicle).toEqual({ ...TAYCAN, colour: "Red", paint: "#c62828" });
    const icon = within(screen.getByTestId("car-icon")).getByRole("img", { name: "Red Taycan Cross Turismo" });
    expect(bodyFill(icon)).toBe("#c62828");
  });

  it("in Polish the colour is named in Polish, and the current one is marked", async () => {
    const setCarColour = vi.fn(async (colour: string, paint: string) => ({ ...TAYCAN, colour, paint }));
    mount("pl", <MasterChip />, { profile: { ...ROMAN, language: "pl" }, vehicle: { ...TAYCAN, colour: "Niebieski", paint: "#1e5aa8" } }, { setCarColour });
    const button = screen.getByTestId("car-icon");
    expect(button).toHaveAccessibleName("Zmień kolor auta");
    expect(within(button).getByRole("img", { name: "Niebieski Taycan Cross Turismo" })).toBeInTheDocument();
    await userEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Kolor auta" })).toBeInTheDocument();
    expect(screen.getByTestId("paint-blue")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("paint-green")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByTestId("paint-yellow"));
    await waitFor(() => expect(setCarColour).toHaveBeenCalledWith("Żółty", "#f2c230"));
    await waitFor(() => expect(bodyFill(screen.getByRole("img", { name: "Żółty Taycan Cross Turismo" }))).toBe("#f2c230"));
  });

  it("without a car yet it says Add your car first and opens the vehicle form", async () => {
    const setCarColour = vi.fn();
    const { store } = mount("en", <Home />, { profile: ROMAN, vehicle: null, my: { toAnswer: 0, planned: 0, nextPlanned: null } }, { setCarColour });
    await userEvent.click(screen.getByTestId("car-icon"));
    expect(screen.getByTestId("car-none")).toHaveTextContent("Add your car first");
    expect(screen.queryByTestId("paint-red")).toBeNull();
    await userEvent.click(screen.getByTestId("car-add"));
    expect(store.get().panel).toBe("vehicle");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setCarColour).not.toHaveBeenCalled();
  });

  it("a rider profile's icon and a profile without an icon are no button", () => {
    const { unmount } = mount("en", <Home />, { profile: { ...ROMAN, masterRole: "rider" }, my: { toAnswer: 0, planned: 0, nextPlanned: null } });
    expect(screen.queryByTestId("car-icon")).toBeNull();
    expect(screen.getByRole("img", { name: "Green Taycan Cross Turismo" })).toBeInTheDocument();
    unmount();
    mount("en", <Home />, { profile: OLA, vehicle: { ...TAYCAN, paint: "#c62828" }, my: { toAnswer: 0, planned: 0, nextPlanned: null } });
    expect(screen.queryByTestId("car-icon")).toBeNull();
  });

  it("D1: the vehicle line names the car with a car icon; a master's car icon is on its chip instead (one button)", async () => {
    const kia: Vehicle = { make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4, paint: null };
    const setCarColour = vi.fn(async (colour: string, paint: string) => ({ ...kia, colour, paint }));
    const { unmount } = mount("en", <VehicleLine />, { profile: OLA, vehicle: kia }, { setCarColour });
    expect(screen.getByTestId("vehicle-line")).toHaveTextContent("Blue Kia Ceed · WX1");
    await userEvent.click(within(screen.getByTestId("car-icon")).getByRole("img", { name: "Car" }));
    await userEvent.click(screen.getByTestId("paint-silver"));
    await waitFor(() => expect(screen.getByTestId("vehicle-line")).toHaveTextContent("Silver Kia Ceed · WX1"));
    expect(bodyFill(screen.getByRole("img", { name: "Silver car" }))).toBe("#b8bec6");
    unmount();
    mount(
      "en",
      <>
        <MasterChip />
        <VehicleLine />
      </>,
      { profile: ROMAN, vehicle: TAYCAN }
    );
    expect(screen.getAllByTestId("car-icon")).toHaveLength(1);
    expect(within(screen.getByTestId("master-chip")).getByTestId("car-icon")).toBeInTheDocument();
    expect(screen.getByTestId("vehicle-line")).toHaveTextContent("Zielony Porsche Taycan Cross Turismo · WX 5555");
  });

  it("riders see the driver's car in its paint on the driver card and the booking card; the initial without either", () => {
    const driver = (over: Partial<NonNullable<RideView["driver"]>>) =>
      ({ nickname: "Roman", rating: { mean: null, count: 0 }, icon: "taycan-ct-green", vehicle: { ...TAYCAN, paint: "#c62828" }, ...over }) as RideView["driver"];
    const rt = { driverPos: null, driverSeenAt: Date.now(), driverPresent: true, sharingOn: true, setSharingOn: () => {}, fix: null } as unknown as RiderRuntime;
    const route = { line: null, km: 2, min: 5, estimate: false };
    const active = (d: RideView["driver"]) => <RiderActive ride={ride({ status: "accepted", driver: d })} rt={rt} route={route} busy={false} error={null} onCancel={() => {}} />;
    const first = mount("en", active(driver({})), { profile: OLA });
    expect(bodyFill(within(screen.getByTestId("driver-card")).getByRole("img", { name: "Red Taycan Cross Turismo" }))).toBe("#c62828");
    first.unmount();
    const second = mount("pl", active(driver({ icon: null, vehicle: { ...TAYCAN, make: "Kia", model: "Ceed", paint: "#1e5aa8" } })), { profile: OLA });
    expect(bodyFill(within(screen.getByTestId("driver-card")).getByRole("img", { name: "Niebieski samochód" }))).toBe("#1e5aa8");
    second.unmount();
    const third = mount("en", active(driver({ icon: null, vehicle: { ...TAYCAN, paint: null } })), { profile: OLA });
    expect(within(screen.getByTestId("driver-card")).queryByRole("img")).toBeNull();
    expect(screen.getByTestId("driver-card").querySelector(".avatar")).toHaveTextContent("R");
    third.unmount();
    mount("en", <RiderBookingCard r={ride({ status: "scheduled", scheduledFor: Date.now() + 86_400_000, driver: driver({}) })} onChanged={() => {}} />, { profile: OLA });
    expect(bodyFill(within(screen.getByTestId("booking-driver")).getByRole("img", { name: "Red Taycan Cross Turismo" }))).toBe("#c62828");
  });

  it("DriverIcon prefers the party's paint (sent with every party) over the assigned vehicle's (U4)", () => {
    const { unmount } = mount("en", <DriverIcon driver={{ icon: "taycan-ct-green", paint: "#1e5aa8", vehicle: { ...TAYCAN, paint: "#c62828" } }} />, {});
    expect(bodyFill(screen.getByRole("img", { name: "Blue Taycan Cross Turismo" }))).toBe("#1e5aa8");
    unmount();
    // No icon but a paint on the party: a plain car in that paint, before any vehicle is assigned.
    mount("pl", <DriverIcon driver={{ icon: null, paint: "#f2c230", vehicle: null }} />, {});
    expect(bodyFill(screen.getByRole("img", { name: "Żółty samochód" }))).toBe("#f2c230");
  });

  it("DriverIcon shows nothing (or the fallback) for a driver with neither icon nor paint", () => {
    mount("en", <DriverIcon driver={{ icon: null, vehicle: null }} fallback={<span>fallback</span>} />, {});
    expect(screen.getByText("fallback")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("InfoTip (FR-190): the round i that pops its text for 5 s", () => {
  it("opens on tap, closes by itself after its delay (5 s), on a second tap, and on a tap elsewhere", async () => {
    expect(INFO_TIP_MS).toBe(5000);
    render(
      <I18nProvider lang="en">
        <div>
          <button type="button">elsewhere</button>
          <InfoTip text="Riders see this only after you accept their request." testId="vehicle" ms={250} />
        </div>
      </I18nProvider>
    );
    const btn = screen.getByTestId("vehicle-info");
    expect(btn).toHaveAttribute("aria-label", "More about this");
    expect(screen.queryByTestId("vehicle-tip")).toBeNull();
    await userEvent.click(btn);
    expect(screen.getByTestId("vehicle-tip")).toHaveTextContent("Riders see this only after you accept their request.");
    expect(btn).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.queryByTestId("vehicle-tip")).toBeNull(), { timeout: 1500 }); // gone by itself
    await userEvent.click(btn);
    expect(screen.getByTestId("vehicle-tip")).toBeInTheDocument();
    await userEvent.click(btn); // a second tap closes it sooner
    expect(screen.queryByTestId("vehicle-tip")).toBeNull();
    await userEvent.click(btn);
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" })); // so does a tap anywhere else
    expect(screen.queryByTestId("vehicle-tip")).toBeNull();
  });

  it("closes on Escape, and an icon inside a <label> leaves the input as the labelled control (B8)", async () => {
    render(
      <I18nProvider lang="en">
        <label className="field" htmlFor="x-make">
          <span className="with-info">
            Make
            <InfoTip text="Riders see this only after you accept their request." testId="vehicle" />
          </span>
          <input id="x-make" />
        </label>
      </I18nProvider>
    );
    expect(screen.getByRole("textbox", { name: "Make" }).id).toBe("x-make"); // the input, not the "i", is what "Make" labels
    await userEvent.click(document.querySelector("label.field")!); // tapping the label focuses the field, not the icon
    expect(screen.queryByTestId("vehicle-tip")).toBeNull();
    expect(document.activeElement?.id).toBe("x-make");
    await userEvent.click(screen.getByTestId("vehicle-info"));
    expect(screen.getByTestId("vehicle-tip")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("vehicle-tip")).toBeNull();
    // The real forms label their inputs explicitly.
    for (const f of ["src/screens/driver/VehicleForm.tsx", "src/components/AppInstall.tsx"]) {
      const src = readFileSync(f, "utf-8");
      for (const m of src.matchAll(/<label[^>]*>\s*<span className="with-info">/g)) expect(src.slice(m.index! - 0, m.index! + 40), f).toContain("htmlFor=");
    }
  });

  it("is a round icon, and the screens it replaced show no standing paragraph any more", () => {
    const css = readFileSync("src/styles/theme.css", "utf-8");
    expect(css).toMatch(/\.infotip-btn \{[^}]*border-radius: 50%/);
    for (const f of ["src/screens/driver/VehicleForm.tsx", "src/screens/Profile.tsx", "src/screens/Bookings.tsx", "src/screens/RequestForm.tsx", "src/components/ScreenOn.tsx", "src/components/AppInstall.tsx"]) {
      const src = readFileSync(f, "utf-8");
      expect(src, f).toContain("<InfoTip");
    }
    for (const key of ["vehicle.intro", "profile.privacy", "profile.myPlaceHint", "profile.offersHint", "wake.help", "move.body", "app.codeIntro", "request.openNote", "book.waiting"]) {
      const used = ["src/screens", "src/components"].some((dir) => readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith(".tsx") && readFileSync(`${dir}/${f}`, "utf-8").includes(`t("${key}"`)));
      expect(used, key).toBe(true); // still shown — now behind the icon
    }
  });
});

describe("R3 Active ride: the car set off (FR-180) and Navigate (FR-181)", () => {
  const assigned = (over: Partial<RideView>) =>
    ride({ status: "accepted", scheduledFor: Date.now() + 20 * 60_000, driver: { nickname: "Roman", rating: { mean: null, count: 0 }, icon: null, vehicle: { make: "Porsche", model: "Taycan", colour: "Zielony", plate: "W1LLRUN", seats: 4 } }, ...over } as Partial<RideView>);
  const rt = (): RiderRuntime => ({ driverPos: null, driverSeenAt: null, driverPresent: true, sharingOn: true, setSharingOn: () => {}, fix: null });
  const route = { line: null, km: 2, min: 5, estimate: false };
  it("judges set-off from accurate fixes only, beyond what the accuracy could explain (FR-180)", () => {
    const fix = (lat: number, accuracy: number): GeoFix => ({ lat, lng: 21, accuracy, heading: null, speed: null, t: Date.now() });
    const home = fix(52.2, 8);
    expect(hasDeparted(null, fix(52.21, 8))).toBe(false);
    expect(hasDeparted(home, fix(52.2005, 8))).toBe(false); // ~55 m: parked
    expect(hasDeparted(home, fix(52.2015, 8))).toBe(true); // ~165 m: set off
    expect(hasDeparted(home, fix(52.2015, 80))).toBe(false); // a coarse fix proves nothing
    expect(hasDeparted(fix(52.2, 600), fix(52.2015, 8))).toBe(false); // nor a coarse origin
    expect(hasDeparted(fix(52.2, 45), fix(52.2015, 45))).toBe(false); // 165 m but 90 m of accuracy
    expect(hasDeparted(fix(52.2, 45), fix(52.2025, 45))).toBe(true); // 275 m
    expect(DEPART_M).toBe(150);
    expect(DEPART_ACCURACY_M).toBe(50);
    expect(DEPART_RETRY_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("ships every push kind in the push-dispatch bundle (the Edge Function is pasted from it)", () => {
    const bundle = readFileSync("supabase/functions/push-dispatch/dist-bundle.ts", "utf-8");
    for (const kind of ["driver_departed", "appt_open", "driver_coming", "booking_new"]) expect(bundle, kind).toContain(kind);
  });

  it.each([
    ["en", "Your driver will set off soon", "Your driver has set off"],
    ["pl", "Kierowca wkrótce ruszy", "Kierowca już jedzie"]
  ] as const)("says the driver will set off, then has set off once departedAt is set (%s)", (lang, before, after) => {
    const { rerender } = render(
      <I18nProvider lang={lang}>
        <RiderActive ride={assigned({ departedAt: null })} rt={rt()} route={route} busy={false} error={null} onCancel={() => {}} />
      </I18nProvider>
    );
    expect(screen.getByTestId("ride-status")).toHaveTextContent(before);
    rerender(
      <I18nProvider lang={lang}>
        <RiderActive ride={assigned({ departedAt: Date.now() })} rt={rt()} route={route} busy={false} error={null} onCancel={() => {}} />
      </I18nProvider>
    );
    expect(screen.getByTestId("ride-status")).toHaveTextContent(after);
    // A ride requested right now (no booking) keeps the plain "on the way".
    rerender(
      <I18nProvider lang={lang}>
        <RiderActive ride={assigned({ departedAt: null, scheduledFor: null })} rt={rt()} route={route} busy={false} error={null} onCancel={() => {}} />
      </I18nProvider>
    );
    expect(screen.getByTestId("ride-status")).toHaveTextContent(lang === "en" ? "Your driver is on the way" : "Kierowca jest w drodze");
  });

  it("links directions to Google Maps on every phone, iPhone included", () => {
    const ua = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15", configurable: true });
    try {
      expect(navigationUrl({ lat: 52.25, lng: 20.82 })).toBe("https://www.google.com/maps/dir/?api=1&destination=52.25,20.82&travelmode=driving");
      expect(navigationUrl({ lat: 52.25, lng: 20.82 }, "walking")).toBe("https://www.google.com/maps/dir/?api=1&destination=52.25,20.82&travelmode=walking");
      expect(navigationUrl({ lat: 52.25, lng: 20.82 })).not.toContain("maps.apple.com");
    } finally {
      Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
    }
  });
});
