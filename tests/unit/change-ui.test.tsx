// Component tests of 2.14 "proposing a change" (FR-334–339, V93): C3 Propose a change (a move with
// my ride's new pickup, a new length of a live or done appointment), the pending card (Accept /
// Decline for the other party, Withdraw for the proposer), the change:<id> panel arg, P1 To answer
// with the change chip and H1's chip — EN and PL, with a fake backend. 2.14.2 (FR-346–348, V97–V98):
// a ride under way as a warning (sheet and card), the Payment card of a done appointment, H1's tip.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { toLocalInput } from "../../src/components/datetime";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import type { AppointmentView, CatalogItem, ChangeInput, ChangeView, Lang, Profile } from "../../src/core/types";
import { ServerError } from "../../src/core/types";
import { I18nProvider } from "../../src/i18n";
import { en } from "../../src/i18n/en";
import { pl } from "../../src/i18n/pl";
import { AppointmentPanel, proposeKind } from "../../src/screens/Appointment";
import { HistoryScreen } from "../../src/screens/HistoryScreen";
import { Planned } from "../../src/screens/Planned";
import { getRoute } from "../../src/services/routing";
import { AppStore, StoreContext } from "../../src/state/store";

// No network in tests: a fixed road route.
vi.mock("../../src/services/routing", () => ({ getRoute: vi.fn(async () => ({ km: 5, min: 12, line: [], estimate: false })) }));
vi.mock("../../src/services/geocode", () => ({ GeocodeError: class extends Error {}, reverseLabel: async () => "Warszawska 269", searchAddress: vi.fn(async () => []) }));

afterEach(() => {
  vi.useRealTimers();
});

const HOME = { lat: 52.25, lng: 20.82, label: "Warszawska 269" };
const KIDS = { lat: 52.23, lng: 21.0, label: "Kids' home" };
const PARK = { lat: 52.21, lng: 21.03, label: "Park Łazienki" };

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
  photo: null,
  offers: [],
  offersPreset: false,
  home: HOME
};

const SIOSIA = { publicId: "pub-siosia", nickname: "Siosia", rating: { mean: 4.8, count: 5 }, icon: null };
const TORIA = { publicId: "pub-toria", nickname: "Toria", rating: { mean: null, count: 0 }, icon: null };
const CATALOG: CatalogItem[] = DEFAULT_SERVICES.map((s) => ({ ...s, providers: [] }));

function setup(lang: Lang, ui: ReactNode, backend: Partial<Backend>, extra: Record<string, unknown> = {}) {
  const store = new AppStore();
  store.backend = { catalog: async () => CATALOG, myState: vi.fn(async () => Promise.reject(new Error("offline"))), ...backend } as unknown as Backend;
  (store as unknown as { snap: object }).snap = {
    ...store.get(),
    phase: "ready",
    lang,
    profile: { ...PROFILE, language: lang },
    deployment: DEFAULT_CONFIG,
    cfg: { backend: "mock" },
    my: { toAnswer: 0, planned: 0, nextPlanned: null, openBookings: 0 },
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

function appt(over: Partial<AppointmentView> = {}): AppointmentView {
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
    answeredAt: Date.now() - 1800_000,
    endedAt: null,
    cancelledBy: null,
    cancelReason: null,
    rides: [],
    reminders: [],
    myRating: null,
    series: null,
    calendar: { google: null, ics: null },
    kids: [],
    kidCount: 0,
    unread: 0,
    updateCount: 0,
    feedOpen: false,
    coming: null,
    rate: null,
    contractId: null,
    actualMin: null,
    cost: null,
    tip: null,
    family: null,
    customPrice: false,
    change: null,
    ...over
  };
}

function change(a: AppointmentView, over: Partial<ChangeView> = {}): ChangeView {
  const startsAt = over.startsAt ?? a.startsAt + 3600_000;
  const durationMin = over.durationMin ?? a.durationMin;
  return {
    id: "c1",
    kind: "move",
    by: "provider",
    mine: false,
    startsAt,
    durationMin,
    endsAt: startsAt + durationMin * 60_000,
    place: a.place,
    minutes: null,
    price: null,
    note: "",
    createdAt: Date.now() - 60_000,
    expiresAt: a.startsAt,
    rides: [],
    ...over
  };
}

const at = (h: number, m = 0) => new Date(2026, 10, 3, h, m).getTime();

describe("C3 Propose a change — a move (FR-334, FR-339)", () => {
  it("sends the new start, length, place and my ride's new pickup with its route estimate", async () => {
    const a = appt({
      rides: [{ rideId: "r1", leg: "there", passenger: "client", mine: true, scheduledFor: Date.now() + 25 * 3600_000, status: "confirmed", underway: false, driver: null, pickup: PARK, dropoff: KIDS, fare: 20 }]
    });
    const proposeChange = vi.fn(async (_id: string, _i: ChangeInput) => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "a1" });
    await userEvent.click(await screen.findByTestId("appt-change"));
    const sheet = screen.getByTestId("change-sheet");
    expect(sheet).toHaveTextContent("Propose a change");
    // Nothing changed yet: Send stays off.
    expect(screen.getByTestId("change-same")).toHaveTextContent("Change something first.");
    expect(screen.getByTestId("change-send")).toBeDisabled();
    const newStart = a.startsAt + 2 * 3600_000;
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(newStart) } });
    await waitFor(() => expect(within(screen.getByTestId("change-duration")).getAllByRole("option").length).toBeGreaterThan(3));
    await userEvent.selectOptions(screen.getByTestId("change-duration"), "120");
    expect(screen.getByTestId("change-pickup-there")).toHaveTextContent("New pickup for the ride there");
    await userEvent.click(screen.getByTestId("change-pickup-there-home"));
    expect(await screen.findByTestId("change-pickup-there-fare")).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("change-note"), "  Dentist at 14  ");
    expect(screen.getByTestId("change-preview")).toHaveTextContent("Ends");
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() =>
      expect(proposeChange).toHaveBeenCalledWith("a1", {
        kind: "move",
        startsAt: newStart,
        durationMin: 120,
        place: KIDS,
        pickups: [{ leg: "there", pickup: HOME, estKm: 5, estMin: 12, fareIsEstimate: false }],
        note: "Dentist at 14"
      })
    );
    await waitFor(() => expect(screen.queryByTestId("change-sheet")).not.toBeInTheDocument());
  });

  it("shows the server's refusal in Polish (ride_started, no_change)", async () => {
    const a = appt();
    const proposeChange = vi.fn(async () => {
      throw new ServerError("ride_started");
    });
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "change:a1" });
    // change:<id> opens the sheet at once.
    expect(await screen.findByTestId("change-sheet")).toHaveTextContent("Zaproponuj zmianę");
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(a.startsAt + 3600_000) } });
    await userEvent.click(screen.getByTestId("change-send"));
    expect(await screen.findByRole("alert")).toHaveTextContent(pl["err.ride_started"]);
    expect(en["err.no_change"]).toBeTruthy();
    expect(pl["err.no_change"]).toBeTruthy();
  });
});

describe("C3 the pending change card (FR-336, FR-339, V93)", () => {
  it("the other party sees old → new, the rides and the note, and accepts or declines — in Polish", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 2, 10, 0));
    const a = appt({ role: "provider", startsAt: at(14), durationMin: 180, endsAt: at(17), rate: 40, price: 120 });
    a.change = change(a, {
      by: "client",
      startsAt: at(15),
      durationMin: 240,
      endsAt: at(19),
      place: PARK,
      price: 160,
      note: "Dentysta o 14",
      rides: [
        { rideId: "r1", leg: "there", passenger: "provider", mine: true, from: at(13, 30), to: at(14, 30), effect: "move", pickup: HOME, fare: 22 },
        { rideId: "r2", leg: "back", passenger: "client", mine: false, from: at(17, 5), to: at(19, 5), effect: "cancel" }
      ]
    });
    const answerChange = vi.fn(async () => a);
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a, answerChange }, { panel: "appointment", panelArg: "a1" });
    const card = await screen.findByTestId("change-card");
    expect(card).toHaveTextContent("Propozycja zmiany od: Toria");
    expect(screen.getByTestId("change-when")).toHaveTextContent("15:00–19:00");
    expect(screen.getByTestId("change-when")).toHaveTextContent("było");
    expect(screen.getByTestId("change-when")).toHaveTextContent("14:00–17:00");
    expect(screen.getByTestId("change-length")).toHaveTextContent("Czas trwania");
    expect(screen.getByTestId("change-place-line")).toHaveTextContent("Park Łazienki");
    expect(screen.getByTestId("change-price")).toHaveTextContent(/160,00/);
    expect(screen.getByTestId("change-ride-there")).toHaveTextContent("Przejazd tam: przesuwa się na 14:30");
    expect(screen.getByTestId("change-ride-there")).toHaveTextContent("odbiór: Warszawska 269");
    expect(screen.getByTestId("change-ride-back")).toHaveTextContent("Przejazd powrotny: zostanie odwołany");
    expect(screen.getByTestId("change-note-text")).toHaveTextContent("Dentysta o 14");
    // A pending change from the other side may be countered.
    expect(screen.getByTestId("appt-change")).toBeInTheDocument();
    expect(screen.queryByTestId("change-withdraw")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("change-accept"));
    await waitFor(() => expect(answerChange).toHaveBeenCalledWith("a1", "accept"));
    await userEvent.click(screen.getByTestId("change-decline"));
    await waitFor(() => expect(answerChange).toHaveBeenCalledWith("a1", "decline"));
  });

  it("the proposer waits and may withdraw; no second proposal meanwhile", async () => {
    const a = appt();
    a.change = change(a, { by: "client", mine: true, rides: [{ rideId: "r1", leg: "there", passenger: "client", mine: true, from: a.startsAt - 1800_000, to: a.startsAt - 1800_000, effect: "keep" }] });
    const withdrawChange = vi.fn(async () => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, withdrawChange }, { panel: "appointment", panelArg: "a1" });
    expect(await screen.findByTestId("change-card")).toHaveTextContent("Your proposal — waiting for Siosia");
    expect(screen.getByTestId("change-ride-there")).toHaveTextContent("Ride there: stays at");
    expect(screen.queryByTestId("change-accept")).not.toBeInTheDocument();
    expect(screen.queryByTestId("appt-change")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("change-withdraw"));
    await waitFor(() => expect(withdrawChange).toHaveBeenCalledWith("a1"));
  });

  it("the family sees no Propose a change", async () => {
    const a = appt({ role: "family", family: { side: "client", member: "Roman" } });
    setup("en", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a1" });
    await screen.findByTestId("appointment");
    expect(screen.queryByTestId("appt-change")).not.toBeInTheDocument();
  });
});

describe("C3 a new length (FR-335)", () => {
  it("a live session: the new length with the new end and price from the rate", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 15, 0));
    const a = appt({ startsAt: at(14), durationMin: 180, endsAt: at(17), rate: 40, price: 120 });
    // 2.14.1 (FR-345): live, a move and a new length are both allowed — the sheet offers the switch
    expect(proposeKind(a, Date.now())).toEqual(["move", "length"]);
    const proposeChange = vi.fn(async () => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "a1" });
    await userEvent.click(await screen.findByTestId("appt-change"));
    expect(screen.getByTestId("change-mode-move")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("change-mode-length"));
    expect(screen.getByTestId("change-mode-length")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("change-sheet")).toHaveTextContent("Propose a new length");
    expect(screen.queryByTestId("change-start")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId("change-minutes"), "240");
    expect(screen.getByTestId("change-preview")).toHaveTextContent("Ends 18:00");
    expect(screen.getByTestId("change-preview")).toHaveTextContent(/160\.00/);
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(proposeChange).toHaveBeenCalledWith("a1", { kind: "length", minutes: 240, note: "" }));
  });

  it("a done one: Correct the time gave way to proposing another time frame in Payment (either party), in Polish", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const a = appt({
      role: "client",
      status: "done",
      startsAt: at(14),
      durationMin: 180,
      endsAt: at(17),
      endedAt: at(17),
      rate: 40,
      price: 120,
      cost: { minutes: 180, rate: 40, total: 120, currency: "PLN", source: "catalog", corrected: false }
    });
    const proposeChange = vi.fn(async () => a);
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "a1" });
    expect(await screen.findByTestId("appt-cost")).toBeInTheDocument();
    expect(screen.queryByTestId("cost-correct")).not.toBeInTheDocument();
    // 2.14.2 (FR-347): Propose another time frame in the Payment card; the sheet opens inside it
    expect(screen.getByTestId("payment-propose")).toHaveTextContent("Zaproponuj inne godziny");
    await userEvent.click(screen.getByTestId("payment-propose"));
    expect(within(screen.getByTestId("appt-payment")).getByTestId("change-sheet")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("change-mode-length"));
    expect(screen.getByTestId("change-sheet")).toHaveTextContent("Zaproponuj nową długość");
    await userEvent.selectOptions(screen.getByTestId("change-minutes"), "150");
    expect(screen.getByTestId("change-preview")).toHaveTextContent(/Nowa kwota: 100,00/);
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(proposeChange).toHaveBeenCalledWith("a1", { kind: "length", minutes: 150, note: "" }));
  });

  it("on a database without change proposals (no 'changes', V89): no Propose a change; the provider still corrects the time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const old = { ...DEFAULT_CONFIG, features: ["customPrice" as const, "reactions" as const] };
    const done = appt({
      role: "provider",
      status: "done",
      startsAt: at(14),
      durationMin: 180,
      endsAt: at(17),
      endedAt: at(17),
      rate: 40,
      price: 120,
      cost: { minutes: 180, rate: 40, total: 120, currency: "PLN", source: "catalog", corrected: false }
    });
    const setActualTime = vi.fn(async () => done);
    const { unmount } = setup("en", <AppointmentPanel />, { getAppointment: async () => done, setActualTime }, { panel: "appointment", panelArg: "a1", deployment: old });
    expect(await screen.findByTestId("appt-cost")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-propose")).not.toBeInTheDocument();
    // 2.14.2 (FR-347): Correct the time stays inside the Payment card
    expect(within(screen.getByTestId("appt-payment")).getByTestId("cost-correct")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("cost-correct"));
    await userEvent.selectOptions(screen.getByTestId("cost-minutes"), "150");
    await userEvent.click(screen.getByTestId("cost-save"));
    await waitFor(() => expect(setActualTime).toHaveBeenCalledWith("a1", 150));
    unmount();
    vi.useRealTimers();
    setup("en", <AppointmentPanel />, { getAppointment: async () => appt() }, { panel: "appointment", panelArg: "a1", deployment: old });
    expect(await screen.findByTestId("appt-status")).toBeInTheDocument();
    expect(screen.queryByTestId("appt-change")).not.toBeInTheDocument();
  });

  it("a day after the end only a move (2.14.1), 30 days after nothing", () => {
    const now = Date.now();
    const a = appt({ status: "done", startsAt: now - 30 * 3600_000, durationMin: 60, endsAt: now - 29 * 3600_000 });
    expect(proposeKind(a, now)).toEqual(["move"]);
    const old = appt({ status: "done", startsAt: now - 31 * 86_400_000, durationMin: 60, endsAt: now - 31 * 86_400_000 + 3600_000 });
    expect(proposeKind(old, now)).toEqual([]);
    expect(proposeKind(appt(), now)).toEqual(["move"]);
    // accepted and already over (not yet done): still a move
    expect(proposeKind(appt({ startsAt: now - 5 * 3600_000, endsAt: now - 2 * 3600_000 }), now)).toEqual(["move"]);
    expect(proposeKind(appt({ role: "candidate" }), now)).toEqual([]);
    expect(proposeKind(appt({ role: "family" }), now)).toEqual([]);
  });
});

describe("P1 To answer and H1 (FR-339)", () => {
  it("lists a change awaiting me under To answer with its chip, Accept answers it; mine reads Change sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 2, 10, 0));
    const theirs = appt({ id: "a1", startsAt: at(14), endsAt: at(17) });
    theirs.change = change(theirs, { by: "provider", startsAt: at(15), endsAt: at(18) });
    const mine = appt({ id: "a2", startsAt: at(9), durationMin: 60, endsAt: at(10) });
    mine.change = change(mine, { id: "c2", by: "client", mine: true });
    const answerChange = vi.fn(async () => theirs);
    setup("en", <Planned />, { planned: async () => ({ appointments: [theirs, mine], rides: [], open: [] }), answerChange });
    const box = await screen.findByTestId("to-answer");
    expect(box).toHaveTextContent("To answer (1)");
    expect(within(box).getByTestId("appt-change-chip")).toHaveTextContent("Change proposed");
    expect(within(box).getByTestId("planned-change-when")).toHaveTextContent("15:00–18:00");
    const days = screen.getAllByTestId("planned-day");
    expect(days.some((d) => within(d).queryByText("Change sent"))).toBe(true);
    await userEvent.click(within(box).getByTestId("planned-change-accept"));
    await waitFor(() => expect(answerChange).toHaveBeenCalledWith("a1", "accept"));
  });

  it("counts requests and changes together, in Polish, and Decline answers the change", async () => {
    const req = appt({ id: "a3", status: "requested", role: "provider" });
    const theirs = appt({ id: "a1", role: "provider" });
    theirs.change = change(theirs, { by: "client" });
    const answerChange = vi.fn(async () => theirs);
    setup("pl", <Planned />, { planned: async () => ({ appointments: [req, theirs], rides: [], open: [] }), answerChange });
    const box = await screen.findByTestId("to-answer");
    expect(within(box).getAllByTestId("planned-appointment")).toHaveLength(2);
    expect(within(box).getByTestId("appt-change-chip")).toHaveTextContent("Propozycja zmiany");
    await userEvent.click(within(box).getByTestId("planned-change-decline"));
    await waitFor(() => expect(answerChange).toHaveBeenCalledWith("a1", "decline"));
  });

  it("H1 shows the chip on a done appointment with a pending length change", async () => {
    const now = Date.now();
    const done = appt({ status: "done", startsAt: now - 5 * 3600_000, durationMin: 180, endsAt: now - 2 * 3600_000, endedAt: now - 2 * 3600_000 });
    done.change = change(done, { kind: "length", minutes: 240, startsAt: done.startsAt, durationMin: 180 });
    setup("en", <HistoryScreen />, {
      timeline: async () => [{ kind: "appointment" as const, at: done.startsAt, appointment: done }],
      earnings: async () => ({ todayTotal: 0, todayCount: 0, monthTotal: 0, monthCount: 0, currency: "PLN" })
    });
    expect(await screen.findByTestId("history-change-chip")).toHaveTextContent("Change proposed");
  });
});

// B15 (2026-11-03, the 2.14 pre-release review): the sheet and the answer, each finding pinned.
describe("2.14 review fixes (B15)", () => {
  const myThere = (a: AppointmentView) =>
    [{ rideId: "r1", leg: "there" as const, passenger: "client" as const, mine: true, scheduledFor: a.startsAt - 1800_000, status: "confirmed" as const, underway: false, driver: null, pickup: PARK, dropoff: KIDS, fare: 20 }];

  it("the same pickup chosen twice keeps its estimate (Send stays on); a moved place re-routes the there ride to it", async () => {
    const a = appt();
    a.rides = myThere(a) as AppointmentView["rides"];
    const route = vi.mocked(getRoute);
    route.mockClear();
    const proposeChange = vi.fn(async (_id: string, _i: ChangeInput) => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    // the start's lowest choice is on a quarter hour (the step counts from it)
    expect(screen.getByTestId("change-start").getAttribute("min")).toMatch(/T\d\d:(00|15|30|45)$/);
    await userEvent.click(screen.getByTestId("change-pickup-there-home"));
    expect(await screen.findByTestId("change-pickup-there-fare")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("change-pickup-there-home"));
    expect(screen.getByTestId("change-pickup-there-fare")).toBeInTheDocument();
    expect(screen.getByTestId("change-send")).toBeEnabled();
    expect(route.mock.calls.at(-1)![1]).toEqual(KIDS);
    // the appointment moves to my home: the there ride's route goes there now (its dropoff follows)
    await userEvent.click(screen.getByTestId("change-place-home"));
    await waitFor(() => expect(route.mock.calls.at(-1)![1]).toEqual(HOME));
    await waitFor(() => expect(screen.getByTestId("change-send")).toBeEnabled());
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(proposeChange).toHaveBeenCalledWith("a1", expect.objectContaining({ place: HOME, pickups: [{ leg: "there", pickup: HOME, estKm: 5, estMin: 12, fareIsEstimate: false }] })));
  });

  it("an overlap on accepting names the provider's clash to the client; the provider reads their own", async () => {
    const theirs = appt();
    theirs.change = change(theirs, { by: "provider" });
    const answerChange = vi.fn(async () => {
      throw new ServerError("overlap");
    });
    const first = setup("en", <AppointmentPanel />, { getAppointment: async () => theirs, answerChange }, { panel: "appointment", panelArg: "a1" });
    await userEvent.click(await screen.findByTestId("change-accept"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Siosia is no longer free at that time.");
    first.unmount();
    // in P1 To answer too, in Polish
    setup("pl", <Planned />, { planned: async () => ({ appointments: [theirs], rides: [], open: [] }), answerChange });
    await userEvent.click(await screen.findByTestId("planned-change-accept"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Siosia nie ma już wolnego czasu w tych godzinach.");
    cleanup();
    const mine = appt({ role: "provider" });
    mine.change = change(mine, { by: "client" });
    setup("en", <AppointmentPanel />, { getAppointment: async () => mine, answerChange }, { panel: "appointment", panelArg: "a1" });
    await userEvent.click(await screen.findByTestId("change-accept"));
    expect(await screen.findByRole("alert")).toHaveTextContent(en["err.overlap"]);
  });
});

// 2.14.1 (FR-342–345, V96): a move may go into the past — on a planned, live or done (≤ 30 d) appointment.
describe("2.14.1 moving into the past (FR-345)", () => {
  const doneAt = (over: Partial<AppointmentView> = {}) =>
    appt({
      status: "done",
      startsAt: at(14),
      durationMin: 180,
      endsAt: at(17),
      endedAt: at(17),
      rate: 40,
      price: 120,
      cost: { minutes: 180, rate: 40, total: 120, currency: "PLN", source: "catalog", corrected: false },
      ...over
    });

  it("a done appointment offers both modes and can be moved to yesterday; a new end after now is refused here", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const a = doneAt();
    const proposeChange = vi.fn(async (_id: string, _i: ChangeInput) => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "a1" });
    // 2.14.2 (FR-347): on a done one, in the Payment card (not among the actions)
    await userEvent.click(await screen.findByTestId("payment-propose"));
    expect(screen.queryByTestId("appt-change")).not.toBeInTheDocument();
    const sheet = within(screen.getByTestId("appt-payment")).getByTestId("change-sheet");
    expect(screen.getByTestId("change-mode-move")).toHaveTextContent("Time and place");
    expect(screen.getByTestId("change-mode-length")).toHaveTextContent("Length only");
    expect(screen.getByTestId("change-mode-move")).toHaveAttribute("aria-pressed", "true");
    expect(sheet).toHaveTextContent("Propose a change");
    // the hint behind the i (V42)
    expect(screen.getByTestId("change-past-info")).toBeInTheDocument();
    // as far back as 30 days, on a quarter hour
    expect(screen.getByTestId("change-start")).toHaveAttribute("min", toLocalInput(Date.now() - 30 * 86_400_000)); // the server's bound (30 × 24 h; here across the DST change)
    // ending after now: a done one stays in the past
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(at(16)) } });
    expect(screen.getByTestId("change-problem")).toHaveTextContent(en["change.doneFuture"]);
    expect(screen.getByTestId("change-send")).toBeDisabled();
    // yesterday 9:00–12:00
    const yesterday = new Date(2026, 10, 2, 9, 0).getTime();
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(yesterday) } });
    expect(screen.queryByTestId("change-problem")).not.toBeInTheDocument();
    expect(screen.getByTestId("change-preview")).toHaveTextContent("Ends 12:00");
    expect(screen.getByTestId("change-preview")).toHaveTextContent(/New total: .*120\.00/);
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(proposeChange).toHaveBeenCalledWith("a1", { kind: "move", startsAt: yesterday, durationMin: 180, place: KIDS, pickups: [], note: "" }));
  });

  it("a done appointment three days on: a move only, no switch; past 30 days nothing — in Polish", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 6, 12, 0));
    const a = doneAt();
    const first = setup("pl", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a1" });
    await userEvent.click(await screen.findByTestId("payment-propose"));
    expect(screen.getByTestId("change-sheet")).toHaveTextContent("Zaproponuj zmianę");
    expect(screen.queryByTestId("change-mode-length")).not.toBeInTheDocument();
    // the button hides while its sheet is open
    expect(screen.queryByTestId("payment-propose")).not.toBeInTheDocument();
    expect(screen.getByTestId("change-start")).toBeInTheDocument();
    first.unmount();
    vi.setSystemTime(new Date(2026, 11, 4, 12, 0));
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a1" });
    expect(await screen.findByTestId("appt-cost")).toBeInTheDocument();
    expect(screen.queryByTestId("appt-change")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-propose")).not.toBeInTheDocument();
  });

  it("a future appointment may move into the past; a start ahead keeps the lead; 30 days back at most — in Polish", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 10, 0));
    const a = appt({ startsAt: at(18), durationMin: 120, endsAt: at(20) });
    const proposeChange = vi.fn(async (_id: string, _i: ChangeInput) => a);
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    // before the start: a move only
    expect(screen.queryByTestId("change-mode-move")).not.toBeInTheDocument();
    expect(screen.getByTestId("change-start")).toHaveAttribute("min", toLocalInput(Date.now() - 30 * 86_400_000));
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(at(10, 15)) } });
    expect(screen.getByTestId("change-problem")).toHaveTextContent(pl["change.inLead"].replace("{min}", "30"));
    expect(screen.getByTestId("change-send")).toBeDisabled();
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(new Date(2026, 9, 1, 10, 0).getTime()) } });
    expect(screen.getByTestId("change-problem")).toHaveTextContent(pl["change.tooOld"]);
    // yesterday afternoon: fine
    const past = new Date(2026, 10, 2, 15, 0).getTime();
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(past) } });
    expect(screen.queryByTestId("change-problem")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(proposeChange).toHaveBeenCalledWith("a1", expect.objectContaining({ kind: "move", startsAt: past, durationMin: 120 })));
  });

  it("the server's bad_time and window_closed read as change words, not a ride's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const a = doneAt();
    let code = "bad_time";
    const proposeChange = vi.fn(async () => {
      throw new ServerError(code as "bad_time");
    });
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(at(10)) } });
    await userEvent.click(screen.getByTestId("change-send"));
    expect(await screen.findByRole("alert")).toHaveTextContent(en["change.badTime"]);
    code = "window_closed";
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en["change.windowClosed"]));
    expect(pl["change.badTime"]).toBeTruthy();
    expect(pl["change.windowClosed"]).toBeTruthy();
  });

  it("a live appointment: no new pickup for my ride already behind, one for the ride back still ahead", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 15, 0));
    const a = appt({ startsAt: at(14), durationMin: 180, endsAt: at(17) });
    a.rides = [
      { rideId: "r1", leg: "there", passenger: "client", mine: true, scheduledFor: at(13, 30), status: "confirmed", underway: false, driver: null, pickup: PARK, dropoff: KIDS, fare: 20 },
      { rideId: "r2", leg: "back", passenger: "client", mine: true, scheduledFor: at(17, 5), status: "confirmed", underway: false, driver: null, pickup: KIDS, dropoff: PARK, fare: 20 }
    ] as AppointmentView["rides"];
    setup("en", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    expect(screen.getByTestId("change-mode-move")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("change-pickup-there")).not.toBeInTheDocument();
    expect(screen.getByTestId("change-pickup-back")).toBeInTheDocument();
  });

  it("the other party sees a done appointment's move with its new time, length and total", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const a = doneAt({ role: "provider" });
    a.change = change(a, { by: "client", startsAt: at(9), durationMin: 120, endsAt: at(11), price: 80, expiresAt: at(9) + 7 * 86_400_000 });
    setup("en", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a1" });
    await screen.findByTestId("change-card");
    expect(screen.getByTestId("change-when")).toHaveTextContent(/0?9:00/);
    expect(screen.getByTestId("change-length")).toHaveTextContent("Length");
    expect(screen.getByTestId("change-price")).toHaveTextContent("New total");
  });

  it("moving a done appointment keeps an agreed length correction unless changed; the preview shows was", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    // booked 14:00–17:00 at 40/h, an accepted length change made it 2 h 30 min (100)
    const a = doneAt({ actualMin: 150, cost: { minutes: 150, rate: 40, total: 100, currency: "PLN", source: "catalog", corrected: true } });
    const proposeChange = vi.fn(async (_id: string, _i: ChangeInput) => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    await waitFor(() => expect(screen.getByTestId("change-duration")).toHaveValue("150"));
    const yesterday = new Date(2026, 10, 2, 14, 0).getTime();
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(yesterday) } });
    expect(screen.getByTestId("change-preview")).toHaveTextContent(/New total: .*100\.00/);
    expect(screen.queryByTestId("change-preview-length")).not.toBeInTheDocument();
    expect(screen.queryByTestId("change-preview-was")).not.toBeInTheDocument();
    // picking the booked length shows what it undoes
    await userEvent.selectOptions(screen.getByTestId("change-duration"), "180");
    expect(screen.getByTestId("change-preview-length")).toHaveTextContent("was");
    expect(screen.getByTestId("change-preview-was")).toHaveTextContent(/was .*100\.00/);
    await userEvent.selectOptions(screen.getByTestId("change-duration"), "150");
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(proposeChange).toHaveBeenCalledWith("a1", { kind: "move", startsAt: yesterday, durationMin: 150, place: KIDS, pickups: [], note: "" }));
  });

  it("a counted length the service does not allow: the booked one, with the old length and total shown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    // childcare goes in 30-minute steps: 2 h 45 min cannot be booked (the server's bad_duration)
    const a = doneAt({ actualMin: 165, cost: { minutes: 165, rate: 40, total: 110, currency: "PLN", source: "catalog", corrected: true } });
    setup("en", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    await waitFor(() => expect(screen.getByTestId("change-duration")).toHaveValue("180"));
    expect(screen.getByTestId("change-preview-length")).toHaveTextContent("was");
    expect(screen.getByTestId("change-preview-was")).toHaveTextContent(/was .*110\.00/);
  });
});

describe("2.14.1 on a database still at 2.14 (no 'pastMoves', V89)", () => {
  const old = { ...DEFAULT_CONFIG, features: ["customPrice" as const, "reactions" as const, "changes" as const] };

  it("proposeKind keeps the 2.14 rules", () => {
    const now = Date.now();
    expect(proposeKind(appt(), now, false)).toEqual(["move"]);
    expect(proposeKind(appt({ startsAt: now - 3600_000, endsAt: now + 3600_000, durationMin: 120 }), now, false)).toEqual(["length"]);
    expect(proposeKind(appt({ startsAt: now - 5 * 3600_000, endsAt: now - 2 * 3600_000 }), now, false)).toEqual([]);
    expect(proposeKind(appt({ status: "done", startsAt: now - 5 * 3600_000, endsAt: now - 2 * 3600_000 }), now, false)).toEqual(["length"]);
    expect(proposeKind(appt({ status: "done", startsAt: now - 30 * 3600_000, durationMin: 60, endsAt: now - 29 * 3600_000 }), now, false)).toEqual([]);
    expect(proposeKind(appt({ role: "family" }), now, false)).toEqual([]);
  });

  it("a live one opens on the length; a done one 2 days old offers nothing; a planned one starts after the lead, no past hint", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 15, 0));
    const live = appt({ startsAt: at(14), durationMin: 180, endsAt: at(17) });
    const first = setup("en", <AppointmentPanel />, { getAppointment: async () => live }, { panel: "appointment", panelArg: "a1", deployment: old });
    await userEvent.click(await screen.findByTestId("appt-change"));
    expect(screen.getByTestId("change-minutes")).toBeInTheDocument();
    expect(screen.queryByTestId("change-mode-move")).not.toBeInTheDocument();
    expect(screen.queryByTestId("change-start")).not.toBeInTheDocument();
    first.unmount();
    vi.setSystemTime(new Date(2026, 10, 5, 18, 0));
    const done = appt({ status: "done", startsAt: at(14), durationMin: 180, endsAt: at(17), endedAt: at(17), rate: 40, price: 120, cost: { minutes: 180, rate: 40, total: 120, currency: "PLN", source: "catalog", corrected: false } });
    const second = setup("en", <AppointmentPanel />, { getAppointment: async () => done }, { panel: "appointment", panelArg: "a1", deployment: old });
    expect(await screen.findByTestId("appt-cost")).toBeInTheDocument();
    expect(screen.queryByTestId("appt-change")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-propose")).not.toBeInTheDocument();
    second.unmount();
    vi.setSystemTime(new Date(2026, 10, 3, 10, 0));
    const planned = appt({ startsAt: at(18), durationMin: 120, endsAt: at(20) });
    const proposeChange = vi.fn(async () => {
      throw new ServerError("bad_time");
    });
    setup("en", <AppointmentPanel />, { getAppointment: async () => planned, proposeChange }, { panel: "appointment", panelArg: "change:a1", deployment: old });
    await screen.findByTestId("change-sheet");
    expect(screen.queryByTestId("change-past-info")).not.toBeInTheDocument();
    expect(screen.getByTestId("change-start")).toHaveAttribute("min", toLocalInput(at(10, 45)));
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(at(19)) } });
    await userEvent.click(screen.getByTestId("change-send"));
    // the 2.14 server's bad_time is not described with the 2.14.1 rules
    expect(await screen.findByRole("alert")).not.toHaveTextContent(en["change.badTime"]);
  });
});

// 2.14.2 (FR-346–348, V97–V98): a ride already on its way warns instead of blocking; one Payment card.
describe("2.14.2 a ride under way is a warning (FR-346, V97)", () => {
  it("the sheet warns about my ride back already on its way when a live session gets longer; Send stays on, no new pickup for it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 16, 50));
    const a = appt({ startsAt: at(14), durationMin: 180, endsAt: at(17), rate: 40, price: 120 });
    // the ride back at 17:05 is handed to drivers (requested, no driver yet): the server says underway
    a.rides = [{ rideId: "r2", leg: "back", passenger: "client", mine: true, scheduledFor: at(17, 5), status: "pending", underway: true, driver: null, pickup: KIDS, dropoff: PARK, fare: 20 }] as AppointmentView["rides"];
    const proposeChange = vi.fn(async () => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    // move mode, nothing changed yet: no warning, and no pickup for a ride already on its way
    expect(screen.queryByTestId("change-underway")).not.toBeInTheDocument();
    expect(screen.queryByTestId("change-pickup-back")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("change-mode-length"));
    await userEvent.selectOptions(screen.getByTestId("change-minutes"), "240");
    expect(screen.getByTestId("change-underway-back")).toHaveTextContent("Ride back is already on its way — it stays as booked; agree any change with the driver (chat)");
    expect(screen.getByTestId("change-underway")).toHaveTextContent(en["change.underwayHint"]);
    expect(screen.getByTestId("change-send")).toBeEnabled();
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(proposeChange).toHaveBeenCalledWith("a1", { kind: "length", minutes: 240, note: "" }));
  });

  it("a later start warns about the other party's ride there whose driver has set off — in Polish; a ride booked ahead does not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 13, 40));
    const a = appt({ role: "client", startsAt: at(14), durationMin: 180, endsAt: at(17) });
    a.rides = [
      // Siosia's ride there at 13:45 with its driver: the driver has set off (accepted) — underway
      { rideId: "r1", leg: "there", passenger: "provider", mine: false, scheduledFor: at(13, 45), status: "confirmed", underway: true, driver: { nickname: "Adam" } },
      // my ride back at 17:05 is still booked ahead
      { rideId: "r2", leg: "back", passenger: "client", mine: true, scheduledFor: at(17, 5), status: "pending", underway: false, driver: null, pickup: KIDS, dropoff: PARK, fare: 20 }
    ] as AppointmentView["rides"];
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    expect(screen.queryByTestId("change-underway")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("change-start"), { target: { value: toLocalInput(at(15)) } });
    expect(screen.getByTestId("change-underway-there")).toHaveTextContent("Przejazd tam już jedzie — zostaje tak, jak był zamówiony; ewentualną zmianę uzgodnij z kierowcą (czat)");
    expect(screen.queryByTestId("change-underway-back")).not.toBeInTheDocument();
    expect(screen.getByTestId("change-pickup-back")).toBeInTheDocument();
    expect(screen.getByTestId("change-send")).toBeEnabled();
  });

  it("a booking held past its window (its driver still on another trip) is not under way: no warning, a new pickup is offered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 16, 50));
    const a = appt({ startsAt: at(14), durationMin: 180, endsAt: at(17), rate: 40, price: 120 });
    // a claimed booking at 17:05, past its driver's 30 min lead but still scheduled on the server
    a.rides = [
      { rideId: "r2", leg: "back", passenger: "client", mine: true, scheduledFor: at(17, 5), status: "confirmed", underway: false, driver: { nickname: "Adam" }, pickup: KIDS, dropoff: PARK, fare: 20 }
    ] as AppointmentView["rides"];
    setup("en", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "change:a1" });
    await screen.findByTestId("change-sheet");
    expect(screen.getByTestId("change-pickup-back")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("change-mode-length"));
    await userEvent.selectOptions(screen.getByTestId("change-minutes"), "240");
    expect(screen.queryByTestId("change-underway")).not.toBeInTheDocument();
    expect(screen.queryByTestId("change-underway-back")).not.toBeInTheDocument();
  });

  it("the card shows the ride under way as a warning to the proposer and to the other party (EN, PL)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 16, 50));
    const mine = appt({ startsAt: at(14), durationMin: 180, endsAt: at(17), rate: 40, price: 120 });
    const proposal = change(mine, {
      kind: "length",
      by: "client",
      mine: true,
      startsAt: at(14),
      durationMin: 240,
      endsAt: at(18),
      price: 160,
      rides: [{ rideId: "r2", leg: "back", passenger: "client", mine: true, from: at(17, 5), to: at(17, 5), effect: "underway" }]
    });
    mine.change = proposal;
    const first = setup("en", <AppointmentPanel />, { getAppointment: async () => mine }, { panel: "appointment", panelArg: "a1" });
    const card = await screen.findByTestId("change-card");
    expect(within(card).getByTestId("change-ride-back")).toHaveTextContent("Ride back is already on its way — it stays as booked");
    expect(within(card).getByTestId("change-ride-back")).toHaveClass("notice-warn");
    first.unmount();
    const theirs = appt({ role: "provider", startsAt: at(14), durationMin: 180, endsAt: at(17), rate: 40, price: 120 });
    theirs.change = { ...proposal, mine: false, rides: [{ ...proposal.rides[0], mine: false }] };
    const answerChange = vi.fn(async () => theirs);
    setup("pl", <AppointmentPanel />, { getAppointment: async () => theirs, answerChange }, { panel: "appointment", panelArg: "a1" });
    expect(await screen.findByTestId("change-ride-back")).toHaveTextContent("Przejazd powrotny już jedzie — zostaje tak, jak był zamówiony");
    // a warning, not a blocker: Accept is there
    await userEvent.click(screen.getByTestId("change-accept"));
    await waitFor(() => expect(answerChange).toHaveBeenCalledWith("a1", "accept"));
  });
});

describe("2.14.2 Payment on a done appointment (FR-347, V98)", () => {
  const COST = { minutes: 150, rate: 40, total: 100, currency: "PLN", source: "catalog" as const, corrected: true };
  const doneAt = (over: Partial<AppointmentView> = {}) =>
    appt({ status: "done", startsAt: at(14), durationMin: 180, endsAt: at(17), endedAt: at(17), rate: 40, price: 120, actualMin: 150, cost: COST, ...over });
  const follows = (x: HTMLElement, y: HTMLElement) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("one card in order: what counts, the pending change, the tip given, the total with the tip, Propose another time frame", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const a = doneAt({ tip: { amount: 20, by: "Toria", at: at(17, 30), mine: true } });
    a.change = change(a, { kind: "length", by: "provider", startsAt: a.startsAt, durationMin: 180, minutes: 180, price: 120, expiresAt: at(17) + 86_400_000 });
    const answerChange = vi.fn(async () => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, answerChange }, { panel: "appointment", panelArg: "a1" });
    const pay = await screen.findByTestId("appt-payment");
    expect(pay).toHaveTextContent("Payment");
    // no separate cost or tip cards, no change card on top, no Propose a change among the actions
    expect(screen.getAllByTestId("appt-cost")).toHaveLength(1);
    expect(screen.getAllByTestId("change-card")).toHaveLength(1);
    expect(screen.queryByTestId("appt-change")).not.toBeInTheDocument();
    const p = within(pay);
    expect(p.getByTestId("cost-time")).toHaveTextContent("2 h 30 min");
    expect(p.getByTestId("cost-corrected")).toHaveTextContent("booked: 3 h");
    expect(p.getByTestId("cost-rate")).toHaveTextContent("PLN 40.00/h · price list");
    expect(p.getByTestId("cost-total")).toHaveTextContent("PLN 100.00");
    expect(p.getByTestId("change-card")).toHaveTextContent("Siosia proposes a change");
    expect(p.getByTestId("change-length")).toHaveTextContent("3 h");
    expect(p.getByTestId("appt-tip")).toHaveTextContent("You left a tip: PLN 20.00");
    expect(p.getByTestId("payment-total-tip")).toHaveTextContent("Total with tipPLN 120.00");
    expect(p.getByTestId("payment-propose")).toHaveTextContent("Propose another time frame");
    expect(p.getByTestId("payment-propose-info")).toBeInTheDocument();
    const order = ["cost-total", "change-card", "appt-tip", "payment-total-tip", "payment-propose"].map((id) => p.getByTestId(id));
    for (let i = 1; i < order.length; i++) expect(follows(order[i - 1], order[i])).toBe(true);
    // the change is answered right there
    await userEvent.click(p.getByTestId("change-accept"));
    await waitFor(() => expect(answerChange).toHaveBeenCalledWith("a1", "accept"));
    // a counter-proposal opens the sheet inside the card, at the end
    await userEvent.click(p.getByTestId("payment-propose"));
    const sheet = p.getByTestId("change-sheet");
    expect(follows(p.getByTestId("payment-total-tip"), sheet)).toBe(true);
    expect(screen.queryByTestId("payment-propose")).not.toBeInTheDocument();
  });

  it("the client side within 7 days gets the tip choices; no total with tip before one — in Polish", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const a = doneAt();
    const tipAppointment = vi.fn(async () => a);
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a, tipAppointment }, { panel: "appointment", panelArg: "a1" });
    const pay = await screen.findByTestId("appt-payment");
    expect(pay).toHaveTextContent("Płatność");
    const p = within(pay);
    expect(p.getByTestId("cost-total")).toHaveTextContent("100,00 zł");
    expect(p.queryByTestId("payment-total-tip")).not.toBeInTheDocument();
    expect(p.getByTestId("payment-propose")).toHaveTextContent("Zaproponuj inne godziny");
    const tip = p.getByTestId("appt-tip");
    await userEvent.click(within(tip).getAllByTestId("tip-chip")[1]);
    await userEvent.click(within(tip).getByTestId("tip-send"));
    await waitFor(() => expect(tipAppointment).toHaveBeenCalledWith("a1", 20));
    // after 7 days the choices are gone
    cleanup();
    vi.setSystemTime(new Date(2026, 10, 11, 18, 0));
    setup("pl", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a1" });
    await screen.findByTestId("appt-payment");
    expect(screen.queryByTestId("appt-tip")).not.toBeInTheDocument();
    // still movable (30 days), the length no longer
    await userEvent.click(screen.getByTestId("payment-propose"));
    expect(screen.queryByTestId("change-mode-length")).not.toBeInTheDocument();
  });

  it("the provider sees who tipped and the total with it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    setup("en", <AppointmentPanel />, { getAppointment: async () => doneAt({ role: "provider", tip: { amount: 20, by: "Roman", at: at(17, 30), mine: false } }) }, { panel: "appointment", panelArg: "a1" });
    const p = within(await screen.findByTestId("appt-payment"));
    expect(p.getByTestId("appt-tip")).toHaveTextContent("Roman left a tip: PLN 20.00");
    expect(p.getByTestId("payment-total-tip")).toHaveTextContent("PLN 120.00");
    expect(p.queryByTestId("tip-chip")).not.toBeInTheDocument();
  });

  it("by whom (FR-347): the client's family is told the client tipped, the client is told a family member did", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const kin = doneAt({ role: "family", family: { side: "client", member: "Toria" }, tip: { amount: 20, by: "Toria", at: at(17, 30), mine: false } });
    const first = setup("en", <AppointmentPanel />, { getAppointment: async () => kin }, { panel: "appointment", panelArg: "a1" });
    let p = within(await screen.findByTestId("appt-payment"));
    expect(p.getByTestId("appt-tip")).toHaveTextContent("Toria left a tip: PLN 20.00");
    expect(p.queryByTestId("tip-given")).not.toBeInTheDocument();
    first.unmount();
    const client = doneAt({ tip: { amount: 20, by: "Anna", at: at(17, 30), mine: false } });
    setup("en", <AppointmentPanel />, { getAppointment: async () => client }, { panel: "appointment", panelArg: "a1" });
    p = within(await screen.findByTestId("appt-payment"));
    expect(p.getByTestId("appt-tip")).toHaveTextContent("Anna left a tip: PLN 20.00");
    expect(p.queryByTestId("tip-given")).not.toBeInTheDocument();
  });

  it("the family sees the Payment read-only: no propose, no answer, no correction", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 18, 0));
    const fam = doneAt({ role: "family", family: { side: "provider", member: "Siosia" }, tip: { amount: 20, by: "Toria", at: at(17, 30), mine: false } });
    setup("en", <AppointmentPanel />, { getAppointment: async () => fam }, { panel: "appointment", panelArg: "a1" });
    const p = within(await screen.findByTestId("appt-payment"));
    expect(p.getByTestId("cost-total")).toHaveTextContent("PLN 100.00");
    expect(p.getByTestId("appt-tip")).toHaveTextContent("Toria left a tip: PLN 20.00");
    expect(p.getByTestId("payment-total-tip")).toHaveTextContent("PLN 120.00");
    expect(screen.queryByTestId("payment-propose")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cost-correct")).not.toBeInTheDocument();
    expect(screen.queryByTestId("change-accept")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tip-chip")).not.toBeInTheDocument();
  });

  it("before it is done nothing moves: the price in the header, the change card on top, Propose a change among the actions", async () => {
    const a = appt({ price: 120, rate: 40 });
    a.change = change(a, { by: "provider" });
    setup("en", <AppointmentPanel />, { getAppointment: async () => a }, { panel: "appointment", panelArg: "a1" });
    expect(await screen.findByTestId("appt-price")).toHaveTextContent("PLN 120.00");
    expect(screen.queryByTestId("appt-payment")).not.toBeInTheDocument();
    expect(screen.getByTestId("change-card")).toHaveClass("card");
    expect(screen.getByTestId("appt-change")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-propose")).not.toBeInTheDocument();
  });

  it("H1: a done row shows the total with the tip (FR-348), EN and PL", async () => {
    const now = Date.now();
    const done = appt({
      status: "done",
      startsAt: now - 5 * 3600_000,
      durationMin: 180,
      endsAt: now - 2 * 3600_000,
      endedAt: now - 2 * 3600_000,
      cost: { minutes: 180, rate: 40, total: 120, currency: "PLN", source: "catalog", corrected: false },
      tip: { amount: 20, by: "Toria", at: now - 3600_000, mine: true }
    });
    const plain = appt({
      id: "a2",
      status: "done",
      startsAt: now - 30 * 3600_000,
      durationMin: 60,
      endsAt: now - 29 * 3600_000,
      cost: { minutes: 60, rate: 40, total: 40, currency: "PLN", source: "catalog", corrected: false }
    });
    const backend = {
      timeline: async () => [
        { kind: "appointment" as const, at: done.startsAt, appointment: done },
        { kind: "appointment" as const, at: plain.startsAt, appointment: plain }
      ],
      earnings: async () => ({ todayTotal: 0, todayCount: 0, monthTotal: 0, monthCount: 0, currency: "PLN" })
    };
    const first = setup("en", <HistoryScreen />, backend);
    const rows = await screen.findAllByTestId("history-appointment");
    expect(within(rows[0]).getByTestId("history-cost")).toHaveTextContent("PLN 120.00");
    expect(within(rows[0]).getByTestId("history-tip")).toHaveTextContent("+ PLN 20.00 tip");
    expect(within(rows[1]).queryByTestId("history-tip")).not.toBeInTheDocument();
    first.unmount();
    setup("pl", <HistoryScreen />, backend);
    expect(await screen.findByTestId("history-tip")).toHaveTextContent("+ 20,00 zł napiwku");
  });
});
