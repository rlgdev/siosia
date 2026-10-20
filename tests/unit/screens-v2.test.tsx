// Component tests of the 2.0 screens (spec §13 "Component"): C1 catalog, C2 request form, P1
// planned, C3 appointment, H1 history — EN and PL, with a fake backend.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { toLocalInput } from "../../src/components/datetime";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import type { CatalogItem, Lang, Profile } from "../../src/core/types";
import { I18nProvider } from "../../src/i18n";
import { Catalog } from "../../src/screens/Catalog";
import { RequestPanel } from "../../src/screens/RequestForm";
import { AppStore, StoreContext } from "../../src/state/store";

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
