// Component tests of the 2.0 screens (spec §13 "Component"): C1 catalog, C2 request form, P1
// planned, C3 appointment, H1 history, S2 additions — EN and PL, with a fake backend.
// 2.1: open requests (FR-160–164, V34–V37) — C1 never disabled, C2 Anyone who can, P1 You could
// help, C3 candidate view and the take sheet, provider null on every screen.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { AddToCalendar } from "../../src/components/AddToCalendar";
import { toLocalInput } from "../../src/components/datetime";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import type { AppointmentView, CatalogItem, Lang, MyState, Place, Planned as PlannedData, Profile, RideView, ServiceRequestInput } from "../../src/core/types";
import { ServerError } from "../../src/core/types";
import { I18nProvider } from "../../src/i18n";
import { en } from "../../src/i18n/en";
import { pl } from "../../src/i18n/pl";
import { LeaveDriveConfirm } from "../../src/App";
import { AppointmentPanel, derivedPickup } from "../../src/screens/Appointment";
import { DriverBookingsPanel } from "../../src/screens/Bookings";
import { Catalog } from "../../src/screens/Catalog";
import { HistoryScreen } from "../../src/screens/HistoryScreen";
import { Planned } from "../../src/screens/Planned";
import { ProfilePanel } from "../../src/screens/Profile";
import { RequestPanel } from "../../src/screens/RequestForm";
import { AppStore, StoreContext } from "../../src/state/store";

// No network in tests: a fixed road route.
vi.mock("../../src/services/routing", () => ({ getRoute: async () => ({ km: 5, min: 12, line: [], estimate: false }) }));
vi.mock("../../src/services/geocode", () => ({ GeocodeError: class extends Error {}, reverseLabel: async () => "Warszawska 269", searchAddress: vi.fn(async () => []) }));

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
  it("lists every entry with who offers it; one nobody offers can still be asked for (2.1), in Polish", async () => {
    const { store } = setup("pl", <Catalog />, { catalog: async () => CATALOG });
    expect(await screen.findByTestId("catalog-childcare")).toHaveTextContent("Opieka nad dziećmi");
    expect(screen.getByTestId("catalog-childcare")).toHaveTextContent("Siosia");
    expect(screen.getByTestId("catalog-childcare")).toBeEnabled();
    expect(screen.getByTestId("catalog-learning")).toBeEnabled();
    expect(screen.getByTestId("nobody-learning")).toHaveTextContent("Nikt tego jeszcze nie oferuje — poproś mimo to, zobaczą to wszyscy w grupie");
    await userEvent.click(screen.getByTestId("catalog-learning"));
    expect(store.get().panel).toBe("request");
    expect(store.get().panelArg).toBe("learning");
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

  it("still offers Ride from the deployment when the catalog fails, and Retry loads the rest (C9)", async () => {
    const catalog = vi.fn<() => Promise<CatalogItem[]>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(CATALOG);
    const { store } = setup("en", <Catalog />, { catalog });
    expect(await screen.findByTestId("catalog-failed")).toHaveTextContent("Couldn't load everything Siosia offers.");
    expect(screen.getByTestId("catalog-ride")).toHaveTextContent("Ride");
    expect(screen.queryByTestId("catalog-childcare")).toBeNull();
    await userEvent.click(screen.getByTestId("catalog-retry"));
    expect(await screen.findByTestId("catalog-childcare")).toBeEnabled();
    expect(screen.queryByTestId("catalog-failed")).toBeNull();
    expect(catalog).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByTestId("catalog-ride"));
    expect(store.get().screen).toBe("ride");
  });

  it("says so in Polish when the catalog fails, and a driver profile gets no Ride entry either way", async () => {
    setup("pl", <Catalog />, { catalog: async () => Promise.reject(new Error("offline")) }, { profile: { ...PROFILE, language: "pl", masterRole: "driver", masterId: "m" } });
    expect(await screen.findByTestId("catalog-failed")).toHaveTextContent("Nie udało się wczytać");
    expect(screen.getByTestId("catalog-retry")).toHaveTextContent("Spróbuj ponownie");
    expect(screen.queryByTestId("catalog-ride")).toBeNull();
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
  }, 15_000);

  it("asks for a provider when several offer it, and shows the price per occurrence", async () => {
    const priced: CatalogItem[] = [{ ...DEFAULT_SERVICES[1], price: { perHour: 80 }, providers: [SIOSIA, { ...SIOSIA, publicId: "pub-ewa", nickname: "Ewa" }] }];
    setup("pl", <RequestPanel />, { catalog: async () => priced }, { panel: "request", panelArg: "learning" });
    expect(await screen.findByTestId("request-problem")).toHaveTextContent("Wybierz, kogo prosisz.");
    await userEvent.click(screen.getByRole("radio", { name: /Ewa/ }));
    expect(screen.getByTestId("request-price")).toHaveTextContent(/80[,.]00/);
    await userEvent.selectOptions(screen.getByTestId("request-duration"), "120");
    expect(screen.getByTestId("request-price")).toHaveTextContent(/160[,.]00/);
  });

  it("never stays on Loading: Retry when the catalog fails, 'not available' when the entry is gone (C12)", async () => {
    const catalog = vi.fn<() => Promise<CatalogItem[]>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(CATALOG);
    const { unmount } = setup("en", <RequestPanel />, { catalog }, { panel: "request", panelArg: "childcare" });
    expect(await screen.findByTestId("request-failed")).toHaveTextContent("Couldn't load this service.");
    await userEvent.click(screen.getByTestId("request-retry"));
    expect(await screen.findByTestId("request-send")).toBeInTheDocument();
    expect(catalog).toHaveBeenCalledTimes(2);
    unmount();
    setup("pl", <RequestPanel />, { catalog: async () => CATALOG.filter((e) => e.id !== "childcare") }, { panel: "request", panelArg: "childcare" });
    expect(await screen.findByTestId("request-gone")).toHaveTextContent("Ta usługa nie jest już dostępna.");
    expect(screen.queryByText("Ładowanie…")).toBeNull();
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
    open: false,
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
  departedAt: null,
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
      rides: [booking(), booking({ id: "r9", appointmentId: "a1", leg: "there", scheduledFor: now + 3600_000 })],
      open: []
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
        planned: async () => ({ appointments: [], rides: [], open: [] }),
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
    const { store } = setup("en", <Planned />, { planned: async () => ({ appointments: [appt()], rides: [], open: [] }) });
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

describe("H1 History (FR-133, FR-106)", () => {
  it("merges appointments and rides newest first, with earnings on top for a driver and Rate for 24 h", async () => {
    const now = Date.now();
    const done = appt({ status: "done", startsAt: now - 5 * 3600_000, endedAt: now - 2 * 3600_000 });
    const declined = appt({ id: "a2", status: "declined", startsAt: now - 3 * 86_400_000 });
    const drove = booking({ id: "r2", status: "completed", role: "driver", scheduledFor: null, requestedAt: now - 86_400_000, rider: { nickname: "Ola", rating: { mean: null, count: 0 } } });
    const timeline = async () => [
      { kind: "appointment" as const, at: done.startsAt, appointment: done },
      { kind: "ride" as const, at: drove.requestedAt, ride: drove },
      { kind: "appointment" as const, at: declined.startsAt, appointment: declined }
    ];
    const earnings = async () => ({ todayTotal: 0, todayCount: 0, monthTotal: 42.5, monthCount: 2, currency: "PLN" });
    const { store } = setup("en", <HistoryScreen />, { timeline, earnings }, { vehicle: { make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4 } });
    const list = await screen.findByTestId("history-list");
    const rows = Array.from(list.children);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Childcare");
    expect(rows[0]).toHaveTextContent("Done");
    expect(rows[0]).toHaveTextContent("With Siosia");
    expect(rows[1]).toHaveTextContent("Ride (you drove)");
    expect(rows[1]).toHaveTextContent("Completed");
    expect(rows[1]).toHaveTextContent("Ola");
    expect(rows[2]).toHaveTextContent("Declined");
    expect(await screen.findByTestId("earnings-month")).toHaveTextContent(/42[.,]50/);
    await userEvent.click(screen.getByTestId("history-rate"));
    expect(store.get().panel).toBe("appointment");
    expect(store.get().panelArg).toBe("a1");
  });

  it("shows the empty state in Polish and no earnings to a rider", async () => {
    setup("pl", <HistoryScreen />, { timeline: async () => [], earnings: async () => ({ todayTotal: 0, todayCount: 0, monthTotal: 0, monthCount: 0, currency: "PLN" }) });
    expect(await screen.findByTestId("history-empty")).toHaveTextContent("Nic jeszcze nie zakończono");
    expect(screen.queryByTestId("earnings")).toBeNull();
  });

  it("rates a done appointment once from C3", async () => {
    const a = appt({ status: "done", startsAt: Date.now() - 5 * 3600_000, endedAt: Date.now() - 3600_000 });
    const rateAppointment = vi.fn(async () => undefined);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, rateAppointment } as Partial<Backend>, { panel: "appointment", panelArg: "a1" });
    const box = await screen.findByTestId("appt-rate");
    expect(box).toHaveTextContent("How was it with Siosia?");
    expect(screen.getByTestId("appt-rate-send")).toBeDisabled();
    expect(screen.queryByTestId("appt-cancel")).toBeNull();
    await userEvent.click(screen.getAllByRole("radio")[3]);
    await userEvent.click(screen.getByTestId("appt-rate-send"));
    await waitFor(() => expect(rateAppointment).toHaveBeenCalledWith("a1", 4, ""));
  });
});

describe("S2 My place and Services I offer (FR-140, FR-093, FR-123, FR-142)", () => {
  it("saves My place with a name, and turns offers on and off", async () => {
    let profile: Profile = { ...PROFILE, home: null, offers: ["learning"] };
    const saveHome = vi.fn(async (p: Place | null) => ((profile = { ...profile, home: p }), profile));
    const setOffers = vi.fn(async (ids: string[]) => ((profile = { ...profile, offers: ids }), profile));
    const geo = { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 52.25, longitude: 20.82 } } as GeolocationPosition) };
    Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
    const { store } = setup("en", <ProfilePanel />, { getProfile: async () => profile, saveHome, setOffers } as Partial<Backend>, {
      panel: "profile",
      profile,
      deployment: { ...DEFAULT_CONFIG, services: DEFAULT_SERVICES }
    });
    const offers = await screen.findByTestId("offers");
    expect(offers).toHaveTextContent("Services I offer");
    expect(screen.getByTestId("offer-learning")).toBeChecked();
    expect(screen.getByTestId("offer-childcare")).not.toBeChecked();
    expect(screen.queryByTestId("offer-ride")).toBeNull(); // rides: by having a car
    await userEvent.click(screen.getByTestId("offer-childcare"));
    await waitFor(() => expect(setOffers).toHaveBeenCalledWith(["learning", "childcare"]));
    await waitFor(() => expect(screen.getByTestId("offer-childcare")).toBeChecked());

    expect(screen.getByTestId("my-place-input-value")).toHaveTextContent("—");
    expect(screen.getByTestId("my-place-save")).toBeDisabled();
    await userEvent.click(screen.getByTestId("my-place-input-here"));
    const name = await screen.findByTestId("my-place-name");
    await userEvent.clear(name);
    await userEvent.type(name, "Home");
    await userEvent.click(screen.getByTestId("my-place-save"));
    await waitFor(() => expect(saveHome).toHaveBeenCalledWith({ lat: 52.25, lng: 20.82, label: "Home" }));
    await waitFor(() => expect(store.get().profile?.home?.label).toBe("Home"));
    expect(screen.getByTestId("my-place-clear")).toBeInTheDocument();
  });

  it("hides the toggles on a master profile, and the delete and notification texts name appointments, in Polish", async () => {
    const master: Profile = { ...PROFILE, language: "pl", masterId: "m", masterRole: "rider", offersPreset: true, home: { lat: 52.2, lng: 21, label: "Dom Torii" } };
    setup("pl", <ProfilePanel />, { getProfile: async () => master }, { panel: "profile", profile: master, deployment: { ...DEFAULT_CONFIG, services: DEFAULT_SERVICES } });
    expect(await screen.findByTestId("my-place-input-value")).toHaveTextContent("Dom Torii");
    expect(screen.queryByTestId("offers")).toBeNull();
    expect(pl["push.off"]).toContain("przypomnienia");
    expect(en["push.off"]).toContain("reminders");
    expect(pl["profile.deleteConfirm"]).toContain("terminy zostaną odwołane");
    expect(en["profile.deleteConfirm"]).toContain("appointments are cancelled");
  });
});

describe("Add to calendar (FR-135, V28)", () => {
  it("offers Google and, on the demo, the .ics download; says once that events don't update", async () => {
    const a = appt({ series: series() });
    setup("en", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a1" });
    await userEvent.click(await screen.findByTestId("cal-open"));
    const google = new URL(screen.getByTestId("cal-google").getAttribute("href")!);
    expect(google.hostname).toBe("calendar.google.com");
    expect(google.searchParams.get("text")).toBe("Childcare with Siosia");
    expect(google.searchParams.get("ctz")).toBe("Europe/Warsaw");
    expect(google.searchParams.get("recur")).toBeNull();
    expect(screen.getByTestId("cal-ics")).toHaveTextContent("Apple Calendar / .ics");
    expect(screen.getByTestId("cal-note")).toHaveTextContent("don't update by themselves");
    // The whole series: one repeating event.
    await userEvent.click(screen.getByTestId("cal-open-series"));
    const links = screen.getAllByTestId("cal-google").map((l) => new URL(l.getAttribute("href")!).searchParams.get("recur"));
    expect(links).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=8");
  });

  it("shows the .ics link only when the deployment has the calendar function, in Polish", async () => {
    const without = appt();
    const { unmount } = setup("pl", <AppointmentPanel />, { getAppointment: async () => without }, { panel: "appointment", panelArg: "a1", cfg: { backend: "supabase" } });
    await userEvent.click(await screen.findByTestId("cal-open"));
    expect(screen.getByTestId("cal-google")).toHaveTextContent("Kalendarz Google");
    expect(screen.queryByTestId("cal-ics")).toBeNull();
    unmount();
    const withLink = appt({ calendar: { google: null, ics: "https://x.supabase.co/functions/v1/calendar?a=a1&u=pub-toria&t=0123" } });
    setup("pl", <AppointmentPanel />, { getAppointment: async () => withLink }, { panel: "appointment", panelArg: "a1", cfg: { backend: "supabase" } });
    await userEvent.click(await screen.findByTestId("cal-open"));
    expect(screen.getByTestId("cal-ics")).toHaveAttribute("href", withLink.calendar.ics);
    expect(screen.getByTestId("cal-note")).toHaveTextContent("nie aktualizują się same");
  });
});

/** An online driver's state; the heartbeat brings a new one every 4 s. */
const MY: MyState = {
  serverNow: Date.now(),
  ride: null,
  offer: null,
  queuedOffers: 0,
  driverOnline: true,
  hasVehicle: true,
  nearbyRequests: 0,
  pendingReceipt: null,
  bookings: 0,
  driverBookings: 0,
  hasProfile: true,
  standby: false,
  openBookings: 2,
  toAnswer: 0,
  openRequests: 0,
  planned: 1,
  nextPlanned: null
};

describe("lists reload on a change, not on every heartbeat (C14)", () => {
  /** Heartbeats: a new MyState each time with nothing new in it (only the nearby count moves). */
  const beats = (store: AppStore) => {
    for (let i = 1; i <= 3; i++) act(() => store.applyMy({ ...MY, serverNow: Date.now(), nearbyRequests: i }));
  };
  const KIA = { make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4 };

  it("H1 History reloads when a ride ends, not on the heartbeat", async () => {
    const timeline = vi.fn(async () => []);
    const earnings = vi.fn(async () => ({ todayTotal: 0, todayCount: 0, monthTotal: 0, monthCount: 0, currency: "PLN" }));
    const { store } = setup("en", <HistoryScreen />, { timeline, earnings }, { my: MY, vehicle: KIA });
    await screen.findByTestId("history-empty");
    beats(store);
    await act(async () => {});
    expect(timeline).toHaveBeenCalledTimes(1);
    expect(earnings).toHaveBeenCalledTimes(1);
    // A finished ride waiting for its receipt: History may have changed.
    act(() => store.applyMy({ ...MY, serverNow: Date.now(), pendingReceipt: booking({ id: "r7", status: "completed", role: "driver" }) }));
    await waitFor(() => expect(timeline).toHaveBeenCalledTimes(2));
  });

  it("P1 Planned and C3 reload on a change event (an appointment accepted counts nothing new)", async () => {
    const planned = vi.fn(async () => ({ appointments: [appt()], rides: [], open: [] }));
    const getAppointment = vi.fn(async () => appt());
    const myState = vi.fn(async () => ({ ...MY, serverNow: Date.now() }));
    const { store } = setup(
      "en",
      <>
        <Planned />
        <AppointmentPanel />
      </>,
      { planned, getAppointment, myState },
      { my: MY, uid: "u", panel: "appointment", panelArg: "a1" }
    );
    await screen.findAllByTestId("planned-appointment");
    await waitFor(() => expect(getAppointment).toHaveBeenCalledTimes(1));
    beats(store);
    await act(async () => {});
    expect(planned).toHaveBeenCalledTimes(1);
    expect(getAppointment).toHaveBeenCalledTimes(1);
    await act(async () => {
      await store.refresh(); // what a realtime "changed" event does
    });
    await waitFor(() => expect(planned).toHaveBeenCalledTimes(2));
    expect(getAppointment).toHaveBeenCalledTimes(2);
  });

  it("D1's bookings panel too", async () => {
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: () => {}, watchPosition: () => 1, clearWatch: () => {} }, configurable: true });
    const bookings = vi.fn(async () => [] as RideView[]);
    const openBookings = vi.fn(async () => []);
    const { store } = setup("pl", <DriverBookingsPanel />, { bookings, openBookings }, { my: MY, vehicle: KIA, panel: "bookings" });
    await waitFor(() => expect(bookings).toHaveBeenCalledTimes(1));
    beats(store);
    await act(async () => {});
    expect(bookings).toHaveBeenCalledTimes(1);
    expect(openBookings).toHaveBeenCalledTimes(1);
    act(() => store.applyMy({ ...MY, serverNow: Date.now(), driverBookings: 1 }));
    await waitFor(() => expect(bookings).toHaveBeenCalledTimes(2));
  });
});

describe("a notification tapped while online on D1 (C11)", () => {
  it("asks first, goes offline and opens what was tapped", async () => {
    let online = true;
    const setOnline = vi.fn(async (on: boolean) => {
      online = on;
    });
    const myState = async () => ({ ...MY, serverNow: Date.now(), driverOnline: online });
    const { store } = setup("en", <LeaveDriveConfirm />, { setOnline, myState }, { my: MY, uid: "u", screen: "drive", mode: "drive" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    act(() => store.openFromUrl("./?open=planned"));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("You're online as a driver. Go offline and leave?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Go offline" }));
    await waitFor(() => expect(store.get().screen).toBe("planned"));
    expect(setOnline).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

// ---------- 2.1: open requests (FR-160–164, V34–V37) ----------

const LEARNING = { name: DEFAULT_SERVICES[1].name, icon: DEFAULT_SERVICES[1].icon };

/** Someone else's open request as a member who could take it sees it (role candidate, V34). */
const candidate = (over: Partial<AppointmentView> = {}) =>
  appt({ id: "a7", status: "requested", role: "candidate", open: true, provider: null, client: EWA, serviceId: "learning", service: LEARNING, durationMin: 60, ...over });

/** The client's own open request (nobody took it yet). */
const ownOpen = (over: Partial<AppointmentView> = {}) => appt({ id: "a5", status: "requested", open: true, provider: null, serviceId: "learning", service: LEARNING, durationMin: 60, ...over });

describe("2.1 C1: an entry nobody offers can be asked for (FR-090)", () => {
  it("says ask anyway, opens C2, and points to the open requests of others in Planned", async () => {
    const { store } = setup("en", <Catalog />, { catalog: async () => CATALOG }, { my: { toAnswer: 0, openRequests: 2, planned: 0, nextPlanned: null, openBookings: 0 } });
    expect(await screen.findByTestId("nobody-learning")).toHaveTextContent("Nobody offers this yet — ask anyway: everyone in the group sees it");
    expect(screen.getByTestId("catalog-learning")).toBeEnabled();
    expect(screen.getByTestId("catalog-open-requests")).toHaveTextContent("Requests you could help with: 2");
    await userEvent.click(screen.getByTestId("catalog-open-requests"));
    expect(store.get().screen).toBe("planned");
  });
});

describe("C2 address search inside the request form (B7)", () => {
  it("searches on the button and on Enter without submitting the request", async () => {
    const requestService = vi.fn(async () => ({}) as never);
    const geocode = await import("../../src/services/geocode");
    vi.mocked(geocode.searchAddress).mockResolvedValueOnce([{ lat: 52.2663, lng: 20.8143, label: "Husarska 16, Lipków" }]);
    setup("en", <RequestPanel />, { catalog: async () => CATALOG, requestService }, { panel: "request", panelArg: "childcare", profile: { ...PROFILE, home: null } });
    await screen.findByTestId("request-send");
    await userEvent.click(screen.getByTestId("request-place-search"));
    await userEvent.type(screen.getByTestId("request-place-query"), "Husarska 16");
    await userEvent.click(screen.getByTestId("request-place-go"));
    await userEvent.click(await screen.findByRole("button", { name: "Husarska 16, Lipków" }));
    expect(screen.getByTestId("request-place-value")).toHaveTextContent("Husarska 16, Lipków");
    expect(requestService).not.toHaveBeenCalled();
    // Enter in the search box searches too, and still sends nothing.
    vi.mocked(geocode.searchAddress).mockResolvedValueOnce([]);
    await userEvent.click(screen.getByTestId("request-place-search"));
    await userEvent.type(screen.getByTestId("request-place-query"), "Nowhere 1{enter}");
    expect(await screen.findByText("No results — try another spelling or place a pin.")).toBeInTheDocument();
    expect(requestService).not.toHaveBeenCalled();
  });
});

describe("2.1 C2: Anyone who can (FR-094, FR-161)", () => {
  it("is preselected when nobody offers the entry, tells who sees it, and sends an open request", async () => {
    const requestService = vi.fn(async (_input: ServiceRequestInput) => ({}) as never);
    setup("en", <RequestPanel />, { catalog: async () => CATALOG, requestService }, { panel: "request", panelArg: "learning" });
    const send = await screen.findByTestId("request-send");
    expect(screen.getByRole("radio", { name: "Anyone who can" })).toBeChecked();
    expect(screen.getByTestId("request-open-note")).toHaveTextContent("Everyone in the group sees this request.");
    // The full explanation sits behind the round "i" (FR-190).
    await userEvent.click(screen.getByTestId("request-open-info"));
    expect(screen.getByTestId("request-open-tip")).toHaveTextContent("Everyone in the group sees this request — time, place and note — until someone takes it.");
    expect(send).toBeEnabled();
    await userEvent.click(send);
    await waitFor(() => expect(requestService).toHaveBeenCalled());
    expect(requestService.mock.calls[0][0]).toMatchObject({ serviceId: "learning", providerId: null, durationMin: 60, place: PROFILE.home, note: "" });
  });

  it("keeps the only provider preselected; with several the user picks — Anyone too — in Polish", async () => {
    const { unmount } = setup("pl", <RequestPanel />, { catalog: async () => CATALOG }, { panel: "request", panelArg: "childcare" });
    expect(await screen.findByRole("radio", { name: /Siosia/ })).toBeChecked();
    expect(screen.getByTestId("request-anyone")).not.toBeChecked();
    expect(screen.queryByTestId("request-open-note")).toBeNull();
    unmount();
    const requestService = vi.fn(async (_input: ServiceRequestInput) => ({}) as never);
    const two: CatalogItem[] = [{ ...DEFAULT_SERVICES[1], providers: [SIOSIA, EWA] }];
    setup("pl", <RequestPanel />, { catalog: async () => two, requestService }, { panel: "request", panelArg: "learning" });
    expect(await screen.findByTestId("request-problem")).toHaveTextContent("Wybierz, kogo prosisz.");
    expect(screen.getByTestId("request-anyone")).not.toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Każdy, kto może" }));
    expect(screen.getByTestId("request-open-note")).toHaveTextContent("Wszyscy w grupie widzą tę prośbę.");
    await userEvent.click(screen.getByTestId("request-open-info"));
    expect(screen.getByTestId("request-open-tip")).toHaveTextContent("Wszyscy w grupie widzą tę prośbę — termin, miejsce i notatkę — dopóki ktoś się jej nie podejmie.");
    await userEvent.click(screen.getByTestId("request-send"));
    await waitFor(() => expect(requestService).toHaveBeenCalled());
    expect(requestService.mock.calls[0][0].providerId).toBeNull();
  });
});

describe("2.1 P1: You could help (FR-161)", () => {
  it("lists others' open requests with what they need and I can do it; my own open one waits for someone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 21, 10, 0));
    const now = Date.now();
    const weekly = [new Date(2026, 9, 23, 9, 0), new Date(2026, 9, 30, 9, 0), new Date(2026, 10, 6, 9, 0), new Date(2026, 10, 13, 9, 0)].map((d) => d.getTime());
    const single = candidate({ startsAt: new Date(2026, 9, 22, 16, 0).getTime(), endsAt: new Date(2026, 9, 22, 17, 0).getTime(), note: "Maths, grade 5", price: 40 });
    const repeating = candidate({
      id: "a8",
      client: { publicId: "pub-ola", nickname: "Ola", rating: { mean: null, count: 0 }, icon: null },
      startsAt: weekly[0],
      endsAt: weekly[0] + 3600_000,
      series: series({ id: "s8", seq: 1, count: 4, status: "requested", remaining: 4, starts: weekly })
    });
    const mine = ownOpen({ startsAt: now + 28 * 3600_000, endsAt: now + 29 * 3600_000 });
    const { store } = setup("en", <Planned />, { planned: async () => ({ appointments: [mine], rides: [], open: [single, repeating] }) });
    const section = await screen.findByTestId("open-requests");
    expect(section).toHaveTextContent("You could help (2)");
    const items = within(section).getAllByTestId("open-request");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Learning");
    expect(within(items[0]).getByTestId("open-request-when")).toHaveTextContent("Tomorrow · 16:00–17:00");
    expect(items[0]).toHaveTextContent("Ewa asks");
    expect(items[0]).toHaveTextContent("★ 5.0");
    expect(items[0]).toHaveTextContent("Kids' home");
    expect(items[0]).toHaveTextContent("„Maths, grade 5”");
    expect(items[0]).toHaveTextContent(/40[.,]00/);
    expect(items[1]).toHaveTextContent("Ola asks");
    expect(within(items[1]).getByTestId("series-marker")).toHaveTextContent("↻ every week, 4 times: 23 Oct – 13 Nov");
    // My own open request is in my schedule, never in To answer.
    expect(screen.queryByTestId("to-answer")).toBeNull();
    const own = screen.getAllByTestId("planned-appointment");
    expect(own).toHaveLength(1);
    expect(within(own[0]).getByTestId("appt-chip")).toHaveTextContent("Waiting for someone to take it");
    expect(own[0]).toHaveTextContent("Open to anyone");
    await userEvent.click(within(items[0]).getByTestId("take-request"));
    expect(store.get().panel).toBe("appointment");
    expect(store.get().panelArg).toBe("take:a7");
  });

  it("counts the dates still to take: a date the client withdrew is neither counted nor shown (U3)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 21, 10, 0));
    const weekly = [new Date(2026, 9, 23, 9, 0), new Date(2026, 9, 30, 9, 0), new Date(2026, 10, 6, 9, 0), new Date(2026, 10, 13, 9, 0)].map((d) => d.getTime());
    // The client withdrew 23 Oct: the series now opens on 30 Oct with three dates left.
    const second = candidate({ id: "a8", startsAt: weekly[1], endsAt: weekly[1] + 3600_000, series: series({ id: "s8", seq: 2, count: 4, status: "requested", remaining: 3, gaps: [weekly[0]], starts: weekly }) });
    // 6 Nov withdrawn too: two dates left, still 30 Oct – 13 Nov.
    const third = candidate({ id: "a9", startsAt: weekly[1], endsAt: weekly[1] + 3600_000, series: series({ id: "s9", seq: 2, count: 4, status: "requested", remaining: 2, gaps: [weekly[0], weekly[2]], starts: weekly }) });
    // Only the last date left: the plain marker, no range.
    const last = candidate({ id: "a10", startsAt: weekly[3], endsAt: weekly[3] + 3600_000, series: series({ id: "s10", seq: 4, count: 4, status: "requested", remaining: 1, gaps: [weekly[0], weekly[1], weekly[2]], starts: weekly }) });
    setup("en", <Planned />, { planned: async () => ({ appointments: [], rides: [], open: [second, third, last] }) });
    const items = within(await screen.findByTestId("open-requests")).getAllByTestId("open-request");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByTestId("series-marker")).toHaveTextContent("↻ every week, 3 times: 30 Oct – 13 Nov");
    expect(within(items[0]).getByTestId("series-marker")).not.toHaveTextContent("23 Oct");
    expect(within(items[1]).getByTestId("series-marker")).toHaveTextContent("↻ every week, 2 times: 30 Oct – 13 Nov");
    expect(within(items[2]).getByTestId("series-marker")).toHaveTextContent("↻ every week · 4/4");
  });

  it("says it in Polish, and a list without open requests (an older server) shows none", async () => {
    const { unmount } = setup("pl", <Planned />, { planned: async () => ({ appointments: [ownOpen()], rides: [], open: [candidate()] }) });
    const section = await screen.findByTestId("open-requests");
    expect(section).toHaveTextContent("Możesz pomóc: 1");
    expect(section).toHaveTextContent("Prosi: Ewa");
    expect(within(section).getByTestId("take-request")).toHaveTextContent("Mogę to zrobić");
    expect(screen.getByTestId("appt-chip")).toHaveTextContent("Czeka, aż ktoś się podejmie");
    expect(screen.getByTestId("planned-appointment")).toHaveTextContent("Dla każdego, kto może");
    unmount();
    setup("en", <Planned />, { planned: async () => ({ appointments: [], rides: [] }) as unknown as PlannedData });
    expect(await screen.findByTestId("planned-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("open-requests")).toBeNull();
  });

  it("reloads when the number of open requests changes (another member's request, or someone took it)", async () => {
    const planned = vi.fn(async () => ({ appointments: [], rides: [], open: [] }));
    const { store } = setup("en", <Planned />, { planned }, { my: MY });
    await screen.findByTestId("planned-empty");
    expect(planned).toHaveBeenCalledTimes(1);
    act(() => store.applyMy({ ...MY, serverNow: Date.now(), openRequests: 1 }));
    await waitFor(() => expect(planned).toHaveBeenCalledTimes(2));
  });
});

describe("2.1 C3: someone's open request and the take sheet (FR-163)", () => {
  it("shows what they need without any action of a party, then takes it and books a ride there — in that order", async () => {
    const a = candidate({ note: "Maths", price: 40 });
    const calls: string[] = [];
    const takeRequest = vi.fn(async (_id: string) => (calls.push("take"), { ...a, role: "provider" as const, status: "accepted" as const, open: false, provider: TORIA }));
    const bookRide = vi.fn(async () => (calls.push("book"), {}) as never);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, takeRequest, bookRide }, { panel: "appointment", panelArg: "a7" });
    expect(await screen.findByTestId("appt-status")).toHaveTextContent("Open request");
    expect(screen.getByTestId("appt-party")).toHaveTextContent("Ewa asks");
    expect(screen.getByTestId("appt-party")).toHaveTextContent("★ 5.0");
    expect(screen.getByTestId("appt-place")).toHaveTextContent("Kids' home");
    expect(screen.getByTestId("appt-note")).toHaveTextContent("Maths");
    expect(screen.queryByTestId("appt-cancel")).toBeNull();
    expect(screen.queryByTestId("appt-accept")).toBeNull();
    expect(screen.queryByTestId("add-ride-there")).toBeNull();
    expect(screen.queryByTestId("cal-open")).toBeNull();
    await userEvent.click(screen.getByTestId("appt-take"));
    expect(screen.getByTestId("take-sheet")).toHaveTextContent("I can do it — do you need a ride?");
    await userEvent.click(screen.getByTestId("need-ride-there"));
    expect(screen.getByTestId("ride-there-pickup-value")).toHaveTextContent("Warszawska 269"); // the taker's My place
    expect(screen.getByTestId("ride-there-dropoff-value")).toHaveTextContent("Kids' home");
    const confirm = screen.getByTestId("take-confirm");
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    await waitFor(() => expect(bookRide).toHaveBeenCalled());
    expect(calls).toEqual(["take", "book"]);
    expect(takeRequest).toHaveBeenCalledWith("a7");
    expect(bookRide).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: "a7", leg: "there", pickup: PROFILE.home, dropoff: KIDS }));
    await waitFor(() => expect(screen.queryByTestId("take-sheet")).toBeNull());
  });

  it("opens straight on the take sheet from P1; a series' rides become templates", async () => {
    const a = candidate({ id: "a8", series: series({ id: "s8", seq: 1, count: 4, status: "requested", remaining: 4 }) });
    const takeRequest = vi.fn(async (_id: string) => ({ ...a, role: "provider" as const, status: "accepted" as const, open: false, provider: TORIA }));
    const setRideTemplate = vi.fn(async (_id: string, _t: { leg: string }) => ({}) as never);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, takeRequest, setRideTemplate } as Partial<Backend>, { panel: "appointment", panelArg: "take:a8" });
    const sheet = await screen.findByTestId("take-sheet");
    expect(sheet).toHaveTextContent("You take every date; dates that clash with your schedule are declined.");
    await userEvent.click(screen.getByTestId("need-ride-back"));
    const confirm = screen.getByTestId("take-confirm");
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    await waitFor(() => expect(setRideTemplate).toHaveBeenCalled());
    expect(takeRequest).toHaveBeenCalledWith("a8");
    expect(setRideTemplate.mock.calls[0][0]).toBe("s8");
    expect(setRideTemplate.mock.calls[0][1].leg).toBe("back");
  });

  it("says when it clashes with the taker's schedule or someone was faster, and stays open — in Polish", async () => {
    const a = candidate();
    const takeRequest = vi.fn<(id: string) => Promise<AppointmentView>>().mockRejectedValueOnce(new ServerError("overlap")).mockRejectedValueOnce(new ServerError("taken"));
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a, takeRequest }, { panel: "appointment", panelArg: "take:a7" });
    expect(await screen.findByTestId("take-sheet")).toHaveTextContent("Mogę to zrobić — potrzebujesz przejazdu?");
    await userEvent.click(screen.getByTestId("take-confirm"));
    expect(await screen.findByRole("alert")).toHaveTextContent("W tym czasie masz już coś zaplanowanego.");
    await userEvent.click(screen.getByTestId("take-confirm"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Ktoś inny już się tego podjął."));
    expect(takeRequest).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("take-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("appt-status")).toHaveTextContent("Otwarta prośba");
  });

  it("after the take went through but the ride failed, Confirm again books the ride only — never takes twice (U1)", async () => {
    const a = candidate();
    const taken: AppointmentView = { ...a, role: "provider", status: "accepted", open: false, provider: TORIA };
    let current = a;
    const getAppointment = vi.fn(async () => current);
    // A second take would be refused as taken (by the caller) — it must never be sent.
    const takeRequest = vi.fn<Backend["takeRequest"]>(async () => (current = taken));
    const bookRide = vi.fn<Backend["bookRide"]>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({} as never);
    setup("en", <AppointmentPanel />, { getAppointment, takeRequest, bookRide }, { panel: "appointment", panelArg: "take:a7" });
    await screen.findByTestId("take-sheet");
    await userEvent.click(screen.getByTestId("need-ride-there"));
    const confirm = screen.getByTestId("take-confirm");
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    // The take went through — the reload shows me as the provider — but the ride did not.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("appt-status")).not.toHaveTextContent("Open request"));
    expect(screen.getByTestId("appt-party")).toHaveTextContent("Ewa");
    expect(takeRequest).toHaveBeenCalledTimes(1);
    expect(bookRide).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("take-sheet")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("take-confirm"));
    await waitFor(() => expect(bookRide).toHaveBeenCalledTimes(2));
    expect(takeRequest).toHaveBeenCalledTimes(1);
    expect(bookRide.mock.calls[1][0]).toEqual(expect.objectContaining({ appointmentId: "a7", leg: "there" }));
    await waitFor(() => expect(screen.queryByTestId("take-sheet")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    // The normal C3 of the provider: a ride back can still be added.
    expect(screen.getByTestId("add-ride-back")).toBeInTheDocument();
  });

  it("drops the stale candidate view once the request is gone — taken by someone else or withdrawn (U2)", async () => {
    const getAppointment = vi
      .fn<Backend["getAppointment"]>()
      .mockResolvedValueOnce(candidate())
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValue(new ServerError("not_found"));
    const { store, unmount } = setup("en", <AppointmentPanel />, { getAppointment }, { my: MY, panel: "appointment", panelArg: "a7" });
    expect(await screen.findByTestId("appt-take")).toBeInTheDocument();
    // Offline for a moment: the view stays, with its I can do it.
    act(() => store.applyMy({ ...MY, serverNow: Date.now(), openRequests: 1 }));
    await waitFor(() => expect(getAppointment).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByTestId("appt-take")).toBeInTheDocument();
    expect(screen.queryByTestId("appt-gone")).toBeNull();
    // Someone took it (the count of open requests moved): the reload says not_found.
    act(() => store.applyMy({ ...MY, serverNow: Date.now(), openRequests: 0 }));
    expect(await screen.findByTestId("appt-gone")).toHaveTextContent("This request is no longer open: someone else took it, or it was withdrawn.");
    expect(screen.queryByTestId("appt-take")).toBeNull();
    expect(screen.queryByTestId("appointment")).toBeNull();
    expect(getAppointment).toHaveBeenCalledTimes(3);
    unmount();
    // The same with the take sheet open, in Polish.
    const gone = vi.fn<Backend["getAppointment"]>().mockResolvedValueOnce(candidate()).mockRejectedValue(new ServerError("not_found"));
    const second = setup("pl", <AppointmentPanel />, { getAppointment: gone }, { my: MY, panel: "appointment", panelArg: "take:a7" });
    await screen.findByTestId("take-sheet");
    act(() => second.store.applyMy({ ...MY, serverNow: Date.now(), openRequests: 1 }));
    expect(await screen.findByTestId("appt-gone")).toHaveTextContent("Ta prośba nie jest już otwarta: ktoś inny się jej podjął albo została wycofana.");
    expect(screen.queryByTestId("take-sheet")).toBeNull();
    expect(screen.queryByTestId("take-confirm")).toBeNull();
  });

  it("the client's own open request: waiting for someone, open to anyone, and Withdraw (FR-164)", async () => {
    const a = ownOpen();
    const cancelAppointment = vi.fn(async () => undefined);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, cancelAppointment } as Partial<Backend>, { panel: "appointment", panelArg: "a5" });
    expect(await screen.findByTestId("appt-status")).toHaveTextContent("Waiting for someone to take it");
    expect(screen.getByTestId("appt-party")).toHaveTextContent("Open to anyone");
    expect(screen.queryByTestId("appt-take")).toBeNull();
    await userEvent.click(screen.getByTestId("appt-cancel"));
    expect(screen.getByTestId("cancel-box")).toHaveTextContent("Withdraw your open request? Nobody will see it any more.");
    await userEvent.click(screen.getByTestId("cancel-one"));
    await waitFor(() => expect(cancelAppointment).toHaveBeenCalledWith("a5", null, "one"));
  });
});

describe("2.1 provider null never breaks a screen (R7, V37)", () => {
  it("H1: an open request nobody took reads so, with no one to rate; a withdrawn one is Cancelled", async () => {
    const now = Date.now();
    const lapsed = ownOpen({ status: "expired", open: false, startsAt: now - 3 * 3600_000, endsAt: now - 2 * 3600_000 });
    const withdrawn = ownOpen({ id: "a6", status: "cancelled", open: false, cancelledBy: "client", startsAt: now - 86_400_000 });
    const timeline = async () => [
      { kind: "appointment" as const, at: lapsed.startsAt, appointment: lapsed },
      { kind: "appointment" as const, at: withdrawn.startsAt, appointment: withdrawn }
    ];
    setup("pl", <HistoryScreen />, { timeline });
    const rows = Array.from((await screen.findByTestId("history-list")).children);
    expect(rows[0]).toHaveTextContent("Nikt się nie zgłosił");
    expect(rows[0]).toHaveTextContent("Dla każdego, kto może");
    expect(rows[1]).toHaveTextContent("Odwołane");
    expect(screen.queryByTestId("history-rate")).toBeNull();
  });

  it("C3 of a withdrawn open request, and Add to calendar has nothing to offer without a provider", async () => {
    const a = ownOpen({ status: "cancelled", open: false, cancelledBy: "client" });
    const { unmount } = setup("en", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a5" });
    expect(await screen.findByTestId("appt-status")).toHaveTextContent("Cancelled");
    expect(screen.getByTestId("appt-party")).toHaveTextContent("Open to anyone");
    expect(screen.getByText("Cancelled by Toria")).toBeInTheDocument();
    unmount();
    setup("en", <AddToCalendar appointment={ownOpen({ status: "accepted", open: false })} />, {});
    expect(screen.queryByTestId("add-to-calendar")).toBeNull();
  });

  it("the guide says it in the app's words (FR-153)", async () => {
    const { readFileSync } = await import("node:fs");
    const [enPart, plPart] = readFileSync("public/guide.html", "utf-8").split('<section data-lang="pl">');
    for (const k of ["request.anyone", "open.take", "car.title", "appt.waitingAnyone"] as const) {
      expect(enPart, k).toContain(en[k]);
      expect(plPart, k).toContain(pl[k]);
    }
    expect(enPart).toContain("You could help");
    expect(plPart).toContain("Możesz pomóc");
  });
});

describe("2.1 a party's car icon is drawn in their paint (FR-170, V38, U4)", () => {
  const bodyFill = (el: HTMLElement) => el.querySelector('[data-part="body"]')?.getAttribute("fill");
  /** A master driver who offers childcare: the party JSON carries the paint of their car. */
  const PAINTED = { publicId: "pub-roman", nickname: "Roman", rating: { mean: 4.9, count: 12 }, icon: "taycan-ct-green", paint: "#c62828" };

  it("C1 provider chips, the C3 party row and the P1 item use the party's paint; without one the icon keeps its own", async () => {
    const catalog: CatalogItem[] = [{ ...DEFAULT_SERVICES[2], providers: [PAINTED, { ...SIOSIA, icon: "taycan-ct-green" }] }];
    const first = setup("en", <Catalog />, { catalog: async () => catalog });
    const entry = await screen.findByTestId("catalog-childcare");
    expect(bodyFill(within(entry).getByRole("img", { name: "Red Taycan Cross Turismo" }))).toBe("#c62828");
    expect(bodyFill(within(entry).getByRole("img", { name: "Green Taycan Cross Turismo" }))).toBe("#2e7d4f");
    first.unmount();
    const second = setup("pl", <AppointmentPanel />, { getAppointment: async () => appt({ provider: PAINTED }) }, { panel: "appointment", panelArg: "a1" });
    const party = await screen.findByTestId("appt-party");
    expect(party).toHaveTextContent("Roman");
    expect(bodyFill(within(party).getByRole("img", { name: "Czerwony Taycan Cross Turismo" }))).toBe("#c62828");
    second.unmount();
    setup("en", <Planned />, { planned: async () => ({ appointments: [appt({ provider: PAINTED })], rides: [], open: [] }) });
    const item = await screen.findByTestId("planned-appointment");
    expect(bodyFill(within(item).getByRole("img", { name: "Red Taycan Cross Turismo" }))).toBe("#c62828");
  });
});
