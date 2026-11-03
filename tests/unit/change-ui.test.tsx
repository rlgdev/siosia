// Component tests of 2.14 "proposing a change" (FR-334–339, V93): C3 Propose a change (a move with
// my ride's new pickup, a new length of a live or done appointment), the pending card (Accept /
// Decline for the other party, Withdraw for the proposer), the change:<id> panel arg, P1 To answer
// with the change chip and H1's chip — EN and PL, with a fake backend.

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
      rides: [{ rideId: "r1", leg: "there", passenger: "client", mine: true, scheduledFor: Date.now() + 25 * 3600_000, status: "confirmed", driver: null, pickup: PARK, dropoff: KIDS, fare: 20 }]
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
    expect(proposeKind(a, Date.now())).toBe("length");
    const proposeChange = vi.fn(async () => a);
    setup("en", <AppointmentPanel />, { getAppointment: async () => a, proposeChange }, { panel: "appointment", panelArg: "a1" });
    await userEvent.click(await screen.findByTestId("appt-change"));
    expect(screen.getByTestId("change-sheet")).toHaveTextContent("Propose a new length");
    expect(screen.queryByTestId("change-start")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId("change-minutes"), "240");
    expect(screen.getByTestId("change-preview")).toHaveTextContent("Ends 18:00");
    expect(screen.getByTestId("change-preview")).toHaveTextContent(/160\.00/);
    await userEvent.click(screen.getByTestId("change-send"));
    await waitFor(() => expect(proposeChange).toHaveBeenCalledWith("a1", { kind: "length", minutes: 240, note: "" }));
  });

  it("a done one: Correct the time gave way to proposing another length (either party), in Polish", async () => {
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
    await userEvent.click(screen.getByTestId("cost-propose"));
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
    expect(screen.queryByTestId("cost-propose")).not.toBeInTheDocument();
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

  it("nothing to propose a day after the end", () => {
    const now = Date.now();
    const a = appt({ status: "done", startsAt: now - 30 * 3600_000, durationMin: 60, endsAt: now - 29 * 3600_000 });
    expect(proposeKind(a, now)).toBeNull();
    expect(proposeKind(appt(), now)).toBe("move");
    expect(proposeKind(appt({ role: "candidate" }), now)).toBeNull();
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
    [{ rideId: "r1", leg: "there" as const, passenger: "client" as const, mine: true, scheduledFor: a.startsAt - 1800_000, status: "confirmed" as const, driver: null, pickup: PARK, dropoff: KIDS, fare: 20 }];

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
