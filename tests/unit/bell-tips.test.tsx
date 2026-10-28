// Component tests of 2.9 (FR-311–318): the notifications bell on S1 and the screens'
// headers, S1's My profile card, and the tip box — EN and PL, with a fake backend.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { agoText, NotificationsBell } from "../../src/components/Notifications";
import { TipBox } from "../../src/components/Tip";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import type { Lang, NotificationItem, Profile } from "../../src/core/types";
import { I18nProvider } from "../../src/i18n";
import { Home } from "../../src/screens/Home";
import { AppStore, StoreContext } from "../../src/state/store";

const PROFILE = { userId: "u", nickname: "Roman", language: "en", publicId: "pub-roman", photo: null, icon: null, masterId: null, masterRole: null } as unknown as Profile;
const MY = { toAnswer: 0, planned: 0, nextPlanned: null, openBookings: 0, openRequests: 0, unreadChats: 0, familyPending: 0, unreadNotifications: 2, ride: null };

function setup(lang: Lang, ui: ReactNode, backend: Partial<Backend>, extra: Record<string, unknown> = {}) {
  const store = new AppStore();
  store.backend = backend as Backend;
  (store as unknown as { snap: object }).snap = {
    ...store.get(),
    phase: "ready",
    lang,
    profile: { ...PROFILE, language: lang },
    deployment: DEFAULT_CONFIG,
    cfg: { backend: "supabase" },
    my: MY,
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

const NOW = Date.now();
const ITEMS: NotificationItem[] = [
  {
    id: "2",
    kind: "appt_summary",
    params: { service: "Childcare", at: NOW - 3 * 3600_000, minutes: 180, total: 120, currency: "PLN" },
    rideId: null,
    appointmentId: "a1",
    createdAt: NOW - 5 * 60_000,
    read: false
  },
  { id: "1", kind: "driver_arrived", params: { driver: "Adam" }, rideId: "r1", appointmentId: null, createdAt: NOW - 2 * 86_400_000, read: true }
];

describe("the notifications bell (FR-311–313)", () => {
  it("shows the unread count; opening lists the news as the pushes word them and marks them read", async () => {
    const notifications = vi.fn(async () => ({ items: ITEMS, unread: 1 }));
    const readNotifications = vi.fn(async () => {});
    const { store } = setup("en", <NotificationsBell />, { notifications, readNotifications });
    expect(screen.getByTestId("bell-badge")).toHaveTextContent("2");
    expect(screen.getByTestId("bell")).toHaveAccessibleName("Notifications, 2 new");
    await userEvent.click(screen.getByTestId("bell"));
    const items = await screen.findAllByTestId("bell-item");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Summary: Childcare");
    expect(items[0]).toHaveTextContent("5 minutes ago");
    expect(items[0]).toHaveClass("bell-item-new");
    expect(items[1]).toHaveTextContent("Adam is here");
    expect(items[1]).not.toHaveClass("bell-item-new");
    await waitFor(() => expect(readNotifications).toHaveBeenCalledTimes(1));
    // A tap opens what it is about: the appointment's C3.
    await userEvent.click(items[0]);
    expect(store.get().panel).toBe("appointment");
    expect(store.get().panelArg).toBe("a1");
    expect(screen.queryByTestId("bell-list")).toBeNull();
  });

  it("a past ride's notification opens History; nothing yet says so, in Polish", async () => {
    const { store, unmount } = setup("en", <NotificationsBell />, { notifications: async () => ({ items: [ITEMS[1]], unread: 0 }), readNotifications: vi.fn() });
    await userEvent.click(screen.getByTestId("bell"));
    await userEvent.click(await screen.findByTestId("bell-item"));
    expect(store.get().screen).toBe("history");
    unmount();
    setup("pl", <NotificationsBell />, { notifications: async () => ({ items: [], unread: 0 }), readNotifications: vi.fn() }, { my: { ...MY, unreadNotifications: 0 } });
    expect(screen.queryByTestId("bell-badge")).toBeNull();
    await userEvent.click(screen.getByTestId("bell"));
    expect(await screen.findByTestId("bell-empty")).toHaveTextContent("Na razie nic");
  });

  it("words the time like the app's language", () => {
    expect(agoText(NOW - 10_000, NOW, "en")).toBe("now");
    expect(agoText(NOW - 3 * 3600_000, NOW, "en")).toBe("3 hours ago");
    expect(agoText(NOW - 86_400_000, NOW, "pl")).toBe("wczoraj");
  });
});

describe("S1: My profile is a card; the language and the guide below (2.9)", () => {
  it("opens the profile from the 4th card, with the bell in the header", async () => {
    const { store } = setup("pl", <Home />, {});
    const nav = screen.getByRole("navigation");
    const cards = within(nav).getAllByRole("button");
    expect(cards).toHaveLength(4);
    expect(cards[3]).toHaveTextContent("Mój profil");
    expect(cards[3]).toHaveTextContent("Ustawienia, auto, dzieci, rodzina i umowy");
    expect(screen.getByTestId("bell")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("pl");
    expect(screen.getByRole("link", { name: "Jak to działa" })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("home-profile"));
    expect(store.get().panel).toBe("profile");
  });
});

describe("the tip box (FR-314, FR-315)", () => {
  it("picks a suggested amount or another one (1 to the most), sends it once, then thanks", async () => {
    const onTip = vi.fn(async () => {});
    const { rerender } = render(
      <I18nProvider lang="en">
        <TipBox currency="PLN" max={500} suggested={[5, 10, 20]} tip={null} onTip={onTip} />
      </I18nProvider>
    );
    expect(screen.getByTestId("tip-send")).toBeDisabled();
    await userEvent.click(screen.getAllByTestId("tip-chip")[1]);
    expect(screen.getByTestId("tip-send")).toHaveTextContent("Tip PLN 10.00");
    await userEvent.click(screen.getByTestId("tip-other"));
    await userEvent.type(screen.getByTestId("tip-amount"), "501");
    expect(screen.getByTestId("tip-send")).toBeDisabled();
    await userEvent.clear(screen.getByTestId("tip-amount"));
    await userEvent.type(screen.getByTestId("tip-amount"), "12.5");
    await userEvent.click(screen.getByTestId("tip-send"));
    expect(onTip).toHaveBeenCalledWith(12.5);
    rerender(
      <I18nProvider lang="pl">
        <TipBox currency="PLN" max={500} suggested={[5, 10, 20]} tip={12.5} onTip={onTip} />
      </I18nProvider>
    );
    expect(screen.getByTestId("tip-given")).toHaveTextContent("Zostawiono napiwek: 12,50 zł. Dziękujemy!");
  });
});
