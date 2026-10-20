// Component tests of the 2.0 screens (spec §13 "Component"): C1 catalog, C2 request form, P1
// planned, C3 appointment, H1 history — EN and PL, with a fake backend.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { toLocalInput } from "../../src/components/datetime";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import type { AppointmentView, CatalogItem, Lang, Profile, RideView } from "../../src/core/types";
import { I18nProvider } from "../../src/i18n";
import { AppointmentPanel, derivedPickup } from "../../src/screens/Appointment";
import { Catalog } from "../../src/screens/Catalog";
import { Planned } from "../../src/screens/Planned";
import { RequestPanel } from "../../src/screens/RequestForm";
import { AppStore, StoreContext } from "../../src/state/store";

// No network in tests: a fixed road route.
vi.mock("../../src/services/routing", () => ({ getRoute: async () => ({ km: 5, min: 12, line: [], estimate: false }) }));

afterEach(() => {
  vi.useRealTimers();
});

const PROFILE: Profile = {
  userId: "u",
  nickname: "Toria",
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
  publicId: "pub-toria",
  offers: [],
  offersPreset: false,
  home: { lat: 52.25, lng: 20.82, label: "Warszawska 269" }
};

const SIOSIA = { publicId: "pub-siosia", nickname: "Siosia", rating: { mean: 4.8, count: 5 }, icon: null };

const CATALOG: CatalogItem[] = [
  { ...DEFAULT_SERVICES[0], providers: [] },
  { ...DEFAULT_SERVICES[1], providers: [] },
  { ...DEFAULT_SERVICES[2], providers: [SIOSIA] }
];

export function setup(lang: Lang, ui: ReactNode, backend: Partial<Backend>, extra: Record<string, unknown> = {}) {
  const store = new AppStore();
  store.backend = backend as Backend;
  (store as unknown as { snap: object }).snap = {
    ...store.get(),
    phase: "ready",
    lang,
    profile: { ...PROFILE, language: lang },
    deployment: DEFAULT_CONFIG,
    cfg: { backend: "mock" },
    my: { toAnswer: 0, planned: 0, nextPlanned: null, openBookings: 2 },
    ...extra
  };
  return {
    store,
    ...render(
      <StoreContext.Provider value={store}>
        <I18nProvider lang={lang}>{ui}</I18nProvider>
      </StoreContext.Provider>
    )
  };
}

describe("C1 Catalog (FR-090–092)", () => {
  it("lists every entry with who offers it, disables one nobody offers, in Polish", async () => {
    setup("pl", <Catalog />, { catalog: async () => CATALOG });
    expect(await screen.findByTestId("catalog-childcare")).toHaveTextContent("Opieka nad dziećmi");
    expect(screen.getByTestId("catalog-childcare")).toHaveTextContent("Siosia");
    expect(screen.getByTestId("catalog-childcare")).toBeEnabled();
    expect(screen.getByTestId("catalog-learning")).toBeDisabled();
    expect(screen.getByTestId("nobody-learning")).toHaveTextContent("Nikt tego jeszcze nie oferuje");
    expect(screen.getByTestId("catalog-ride")).toHaveTextContent("Przejazd");
    expect(screen.getByTestId("catalog-drive")).toHaveTextContent("Woź z Siosią"); // no car yet
  });

  it("shows Ride — Go online with the rides to take to a driver, and no drive card to a rider profile", async () => {
    const { unmount } = setup("en", <Catalog />, { catalog: async () => CATALOG }, { vehicle: { make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4 } });
    expect(await screen.findByTestId("catalog-drive")).toHaveTextContent("Ride — Go online");
    expect(screen.getByTestId("catalog-drive")).toHaveTextContent("Rides to take: 2");
    unmount();
    setup("en", <Catalog />, { catalog: async () => CATALOG }, { profile: { ...PROFILE, masterRole: "rider", masterId: "m" } });
    expect(await screen.findByTestId("catalog-ride")).toBeInTheDocument();
    expect(screen.queryByTestId("catalog-drive")).toBeNull();
  });
});

describe("C2 Request form (FR-094, FR-107)", () => {
  it("preselects the only provider, My place and the default duration; validates; sends a weekly series", async () => {
    const requestService = vi.fn(async () => ({}) as never);
    setup("en", <RequestPanel />, { catalog: async () => CATALOG, requestService }, { panel: "request", panelArg: "childcare" });
    const send = await screen.findByTestId("request-send");
    expect(screen.getByRole("radio", { name: /Siosia/ })).toBeChecked();
    expect(screen.getByTestId("request-duration")).toHaveValue("180");
    expect(screen.getByTestId("request-place-value")).toHaveTextContent("Warszawska 269");
    // Too soon: disabled with the reason.
    fireEvent.change(screen.getByTestId("request-start"), { target: { value: toLocalInput(Date.now() + 10 * 60_000) } });
    expect(send).toBeDisabled();
    expect(screen.getByTestId("request-problem")).toHaveTextContent("at least 30 min");
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setHours(16, 0, 0, 0);
    fireEvent.change(screen.getByTestId("request-start"), { target: { value: toLocalInput(start.getTime()) } });
    expect(send).toBeEnabled();
    await userEvent.selectOptions(screen.getByTestId("request-repeat"), "weekly");
    fireEvent.change(screen.getByTestId("request-times"), { target: { value: "13" } });
    expect(screen.getByTestId("request-problem")).toHaveTextContent("2 to 12 dates");
    fireEvent.change(screen.getByTestId("request-times"), { target: { value: "8" } });
    expect(screen.getByTestId("request-series-preview")).toHaveTextContent("8 times");
    await userEvent.type(screen.getByTestId("request-note"), "Kids back at 14:30");
    await userEvent.click(send);
    await waitFor(() => expect(requestService).toHaveBeenCalled());
    expect(requestService).toHaveBeenCalledWith({
      serviceId: "childcare",
      providerId: "pub-siosia",
      startsAt: start.getTime(),
      durationMin: 180,
      place: PROFILE.home,
      note: "Kids back at 14:30",
      repeat: { every: 1, count: 8 }
    });
  });

  it("asks for a provider when several offer it, and shows the price per occurrence", async () => {
    const priced: CatalogItem[] = [{ ...DEFAULT_SERVICES[1], price: { perHour: 80 }, providers: [SIOSIA, { ...SIOSIA, publicId: "pub-ewa", nickname: "Ewa" }] }];
    setup("pl", <RequestPanel />, { catalog: async () => priced }, { panel: "request", panelArg: "learning" });
    expect(await screen.findByTestId("request-problem")).toHaveTextContent("Wybierz, kogo prosisz.");
    await userEvent.click(screen.getByRole("radio", { name: /Ewa/ }));
    expect(screen.getByTestId("request-price")).toHaveTextContent(/80[,.]00/);
    await userEvent.selectOptions(screen.getByTestId("request-duration"), "120");
    expect(screen.getByTestId("request-price")).toHaveTextContent(/160[,.]00/);
  });
});

const ROMAN = { nickname: "Roman", rating: { mean: 4.9, count: 12 }, icon: null };
const KIDS = { lat: 52.23, lng: 21.0, label: "Kids' home" };
const TORIA = { publicId: "pub-toria", nickname: "Toria", rating: { mean: null, count: 0 }, icon: null };
const EWA = { publicId: "pub-ewa", nickname: "Ewa", rating: { mean: 5, count: 2 }, icon: null };

function appt(over: Partial<AppointmentView> = {}): AppointmentView {
  // Starts are picked in 15-minute steps.
  const startsAt = over.startsAt ?? Math.ceil((Date.now() + 26 * 3600_000) / 900_000) * 900_000;
  const durationMin = over.durationMin ?? 180;
  return {
    id: "a1",
    status: "accepted",
    role: "client",
    serviceId: "childcare",
    service: { name: DEFAULT_SERVICES[2].name, icon: DEFAULT_SERVICES[2].icon },
    startsAt,
    durationMin,
    endsAt: startsAt + durationMin * 60_000,
    place: KIDS,
    note: "",
    price: null,
    currency: "PLN",
    client: TORIA,
    provider: SIOSIA,
    requestedAt: Date.now() - 3600_000,
    answeredAt: null,
    endedAt: null,
    cancelledBy: null,
    cancelReason: null,
    rides: [],
    reminders: [],
    myRating: null,
    series: null,
    calendar: { google: null, ics: null },
    ...over
  };
}

const series = (over: Partial<NonNullable<AppointmentView["series"]>> = {}): NonNullable<AppointmentView["series"]> => ({
  id: "s1",
  rule: "weekly",
  seq: 2,
  count: 8,
  until: Date.now() + 50 * 86_400_000,
  status: "answered",
  remaining: 7,
  declined: [],
  gaps: [],
  starts: [],
  rideTemplates: [],
  ics: null,
  ...over
});

const booking = (over: Partial<RideView> = {}): RideView => ({
  id: "r1",
  status: "scheduled",
  role: "rider",
  pickup: { lat: 52.2, lng: 21, label: "Marszałkowska 1" },
  dropoff: { lat: 52.25, lng: 21.05, label: "Praga" },
  estKm: 5.2,
  estMin: 14,
  fare: 25.5,
  currency: "PLN",
  fareIsEstimate: false,
  actualKm: null,
  actualMin: null,
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
  notifiedCount: 0,
  redispatchCount: 0,
  round: 0,
  expiresAt: Date.now() + 3 * 86_400_000,
  scheduledFor: Date.now() + 3 * 86_400_000,
  rider: { nickname: "Toria", rating: { mean: null, count: 0 } },
  driver: null,
  myRating: null,
  ...over
});

describe("P1 Planned (FR-130–131, FR-123, US13)", () => {
  it("starts with To answer, then the day groups with chips, the In 2 h marker, the repeat marker and the ride line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 21, 10, 0));
    const now = Date.now();
    const answerAppointment = vi.fn(async () => ({}) as never);
    const mine = appt({
      startsAt: now + 2 * 3600_000,
      series: series(),
      rides: [{ rideId: "r9", leg: "there", passenger: "client", mine: true, scheduledFor: now + 3600_000, status: "confirmed", driver: ROMAN }]
    });
    const ask = appt({ id: "a2", status: "requested", role: "provider", serviceId: "learning", service: { name: DEFAULT_SERVICES[1].name, icon: "📚" }, client: EWA, provider: TORIA, startsAt: now + 26 * 3600_000 });
    const waiting = appt({ id: "a3", status: "requested", startsAt: now + 50 * 3600_000 });
    const planned = vi.fn(async () => ({
      appointments: [mine, ask, waiting],
      // the attached ride is in the appointment's line, not a second item
      rides: [booking(), booking({ id: "r9", appointmentId: "a1", leg: "there", scheduledFor: now + 3600_000 })]
    }));
    setup("en", <Planned />, { planned, answerAppointment });
    const toAnswer = await screen.findByTestId("to-answer");
    expect(toAnswer).toHaveTextContent("To answer (1)");
    expect(toAnswer).toHaveTextContent("Learning");
    expect(toAnswer).toHaveTextContent("For Ewa");
    expect(toAnswer).toHaveTextContent("Please answer");
    const items = screen.getAllByTestId("planned-appointment").filter((el) => !toAnswer.contains(el));
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Confirmed");
    expect(items[0]).toHaveTextContent("In 2 h");
    expect(items[0]).toHaveTextContent("12:00–15:00");
    expect(items[0]).toHaveTextContent("↻ every week · 2/8");
    expect(items[0]).toHaveTextContent("Ride there: Roman ✓");
    expect(items[1]).toHaveTextContent("Waiting for an answer from Siosia");
    expect(screen.getAllByTestId("booking")).toHaveLength(1);
    const days = screen.getAllByTestId("planned-day").map((d) => d.querySelector("h2")?.textContent);
    expect(days[0]).toBe("Today");
    expect(days).toHaveLength(3);
    expect(screen.queryByTestId("rides-to-take")).toBeNull(); // no car
    await userEvent.click(screen.getByTestId("answer-decline"));
    await waitFor(() => expect(answerAppointment).toHaveBeenCalledWith("a2", "decline"));
  });

  it("shows a driver the rides to take and the empty state, in Polish", async () => {
    const claimBooking = vi.fn(async () => ({}) as never);
    setup(
      "pl",
      <Planned />,
      {
        planned: async () => ({ appointments: [], rides: [] }),
        openBookings: async () => [{ ride: booking({ id: "r5", role: "driver", rider: { nickname: "Ola", rating: { mean: null, count: 0 } } }), distanceKm: 2.4 }],
        claimBooking
      },
      { vehicle: { make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4 } }
    );
    expect(await screen.findByTestId("planned-empty")).toHaveTextContent("Nic nie zaplanowano");
    const take = await screen.findByTestId("take-booking");
    expect(screen.getByTestId("rides-to-take")).toHaveTextContent("Przejazdy do wzięcia: 1");
    await userEvent.click(take);
    await waitFor(() => expect(claimBooking).toHaveBeenCalledWith("r5"));
  });

  it("opens C3 when an appointment is tapped", async () => {
    const { store } = setup("en", <Planned />, { planned: async () => ({ appointments: [appt()], rides: [] }) });
    await userEvent.click(await screen.findByTestId("open-appointment"));
    expect(store.get().panel).toBe("appointment");
    expect(store.get().panelArg).toBe("a1");
  });
});

describe("C3 Appointment and C4 accept sheet (FR-101, FR-109–112, FR-117)", () => {
  it("derives the pickup: there = start − route − 10 min floored to 5 min; back = end + 5 min", () => {
    const startsAt = new Date(2026, 9, 22, 16, 0).getTime();
    const a = { startsAt, endsAt: startsAt + 3600_000 };
    expect(new Date(derivedPickup(a, "there", 12)).toTimeString().slice(0, 5)).toBe("15:35");
    expect(new Date(derivedPickup(a, "back", 12)).toTimeString().slice(0, 5)).toBe("17:05");
  });

  it("accepts with a ride back: places and time prefilled, then accept and book in that order", async () => {
    const a = appt({ id: "a2", status: "requested", role: "provider", client: EWA, provider: TORIA });
    const calls: string[] = [];
    const answerAppointment = vi.fn(async () => (calls.push("answer"), {}) as never);
    const bookRide = vi.fn(async () => (calls.push("book"), {}) as never);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, answerAppointment, bookRide }, { panel: "appointment", panelArg: "accept:a2" });
    expect(await screen.findByTestId("accept-sheet")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("need-ride-back"));
    expect(screen.getByTestId("ride-back-pickup-value")).toHaveTextContent("Kids' home");
    expect(screen.getByTestId("ride-back-dropoff-value")).toHaveTextContent("Warszawska 269");
    expect(screen.getByTestId("ride-back-time")).toHaveValue(toLocalInput(a.endsAt + 5 * 60_000));
    const confirm = screen.getByTestId("accept-confirm");
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    await waitFor(() => expect(bookRide).toHaveBeenCalled());
    expect(calls).toEqual(["answer", "book"]);
    expect(answerAppointment).toHaveBeenCalledWith("a2", "accept");
    expect(bookRide).toHaveBeenCalledWith({
      pickup: KIDS,
      dropoff: PROFILE.home,
      estKm: 5,
      estMin: 12,
      fareIsEstimate: false,
      scheduledFor: a.endsAt + 5 * 60_000,
      appointmentId: "a2",
      leg: "back"
    });
  });

  it("refuses a ride there that would be under 30 min ahead and points to Ride now, in Polish", async () => {
    const a = appt({ startsAt: Date.now() + 40 * 60_000 });
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a1" });
    await userEvent.click(await screen.findByTestId("add-ride-there"));
    expect(await screen.findByTestId("ride-there-too-soon")).toHaveTextContent("Siosia → Przejazd");
    expect(screen.getByTestId("book-ride-there")).toBeDisabled();
  });

  it("on a series: a ride for all remaining is a template, and Cancel offers This one / All remaining", async () => {
    const a = appt({ series: series() });
    const setRideTemplate = vi.fn(async (_id: string, _t: { leg: string; offsetMin: number; pickup: unknown; dropoff: unknown }) => ({}) as never);
    const cancelAppointment = vi.fn(async () => ({}) as never);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, setRideTemplate, cancelAppointment } as Partial<Backend>, { panel: "appointment", panelArg: "a1" });
    expect(await screen.findByTestId("appt-series")).toHaveTextContent("↻ every week · 2/8 · 7 left");
    await userEvent.click(screen.getByTestId("add-ride-there"));
    expect(screen.getByTestId("ride-all-remaining")).toBeChecked();
    const book = screen.getByTestId("book-ride-there");
    await waitFor(() => expect(book).toBeEnabled());
    await userEvent.click(book);
    await waitFor(() => expect(setRideTemplate).toHaveBeenCalled());
    const [seriesId, tpl] = setRideTemplate.mock.calls[0];
    expect(seriesId).toBe("s1");
    expect(tpl.leg).toBe("there");
    expect(tpl.offsetMin).toBe(Math.round((derivedPickup(a, "there", 12) - a.startsAt) / 60_000));
    expect(tpl.pickup).toEqual(PROFILE.home);
    expect(tpl.dropoff).toEqual(KIDS);
    await userEvent.click(await screen.findByTestId("appt-cancel"));
    expect(screen.getByTestId("cancel-one")).toHaveTextContent("This one");
    await userEvent.click(screen.getByTestId("cancel-series"));
    await waitFor(() => expect(cancelAppointment).toHaveBeenCalledWith("a1", null, "series"));
  });
});
