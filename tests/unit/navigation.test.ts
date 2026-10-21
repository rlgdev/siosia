// Navigation and the browser history (FR-082, FR-084): the app keeps the history at [S1] or
// [S1, screen] (plus a panel's entry), so ← — a step back — always lands on the app's own S1, also
// after a reload (a new store booting on the same entry). jsdom's history is real: pushState /
// replaceState / back, with popstate a couple of timer turns later.
// 2.1: an open request's notification opens P1, the take panel, and the car colour in the store.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import type { MyState, OfferView, Profile, RideView, Vehicle } from "../../src/core/types";
import { ServerError } from "../../src/core/types";
import { AppStore } from "../../src/state/store";

const PROFILE: Profile = {
  userId: "u",
  nickname: "Adam",
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
  publicId: "pub-adam",
  offers: [],
  offersPreset: false,
  home: null
};

const MY: MyState = {
  serverNow: Date.now(),
  ride: null,
  offer: null,
  queuedOffers: 0,
  driverOnline: false,
  hasVehicle: true,
  nearbyRequests: null,
  pendingReceipt: null,
  bookings: 0,
  driverBookings: 0,
  hasProfile: true,
  standby: false,
  openBookings: 0,
  toAnswer: 0,
  openRequests: 0,
  planned: 0,
  nextPlanned: null
};

/** jsdom takes two timer turns for a history step, then fires popstate. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

const stores: AppStore[] = [];

/** Every store listens to the one window: a store whose page is gone must not react any more. */
function unload(s: AppStore): void {
  s.dispose();
  (s as unknown as { snap: object }).snap = { ...s.get(), my: null, panel: null };
}

afterEach(async () => {
  await settle();
  stores.forEach(unload);
  stores.length = 0;
});

/** Starts the app on the current history entry, as a page load does. */
async function start(backend: Partial<Backend> = {}, my: Partial<MyState> = {}): Promise<AppStore> {
  const store = new AppStore();
  stores.push(store);
  store.backend = {
    getProfile: async () => PROFILE,
    getVehicle: async () => null,
    onMyChanges: () => () => {},
    myState: async () => ({ ...MY, ...my, serverNow: Date.now() }),
    ...backend
  } as Backend;
  (store as unknown as { snap: object }).snap = { ...store.get(), uid: "u", deployment: DEFAULT_CONFIG, cfg: { backend: "mock" } };
  await (store as unknown as { afterMember(): Promise<void> }).afterMember();
  return store;
}

/** Opens the app at `href` in a tab (or a new window) whose previous page is not the app. */
async function launch(href: string, backend: Partial<Backend> = {}, my: Partial<MyState> = {}): Promise<AppStore> {
  history.pushState({ outside: true }, "", "/elsewhere");
  history.pushState(null, "", href);
  return start(backend, my);
}

/** Reloads the page: `old` is gone, a new store boots on the same history entry. */
async function reload(old: AppStore, backend: Partial<Backend> = {}, my: Partial<MyState> = {}): Promise<AppStore> {
  await settle();
  unload(old);
  const store = await start(backend, my);
  await settle();
  return store;
}

/** A driver who is online until setOnline(false). */
function onlineDriver() {
  let online = true;
  const setOnline = vi.fn(async (on: boolean) => {
    online = on;
  });
  return { setOnline, myState: async () => ({ ...MY, serverNow: Date.now(), driverOnline: online }) };
}

describe("launch on a screen other than S1 (C2)", () => {
  it("a notification opened ./?open=planned in a new window: ← lands on the app's S1, not outside the app", async () => {
    const store = await launch("/?open=planned");
    expect(store.get().screen).toBe("planned");
    expect(location.search).toBe(""); // opened once
    expect(history.state).toEqual({ screen: "planned" });
    store.home();
    await settle();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
  });

  it("an online driver reopening on D1 has S1 under it: Go offline and leave lands on S1", async () => {
    const store = await launch("/", onlineDriver());
    expect(store.get().screen).toBe("drive");
    expect(history.state).toEqual({ screen: "drive" });
    // The phone's back gesture on D1: D1 stays and the driver is asked first.
    history.back();
    await settle();
    expect(store.get().screen).toBe("drive");
    expect(store.get().leaveDrive).toBe("home");
    await store.leaveDriveConfirmed();
    await settle();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
  });

  it("a launch on S1 from an older Planned entry of the app steps back onto the S1 under it", async () => {
    history.pushState({ outside: true }, "", "/elsewhere");
    history.pushState({ screen: "home" }, "", "/");
    history.pushState({ screen: "planned" }, "", "/");
    const store = await start();
    expect(store.get().screen).toBe("home");
    await settle();
    expect(history.state).toEqual({ screen: "home" });
    store.go("history");
    store.home();
    await settle();
    expect(store.get().screen).toBe("home"); // not back on the old Planned entry
    expect(history.state).toEqual({ screen: "home" });
  });

  it("an offer that shows while a panel is open on Planned: D1 replaces both, S1 stays right under it", async () => {
    const store = await launch("/");
    store.go("planned");
    store.openPanel("appointment", "a1");
    expect(history.state).toEqual({ panel: "appointment", screen: "planned" });
    store.applyMy({ ...MY, serverNow: Date.now(), driverOnline: true, offer: { id: "o1" } as OfferView });
    expect(store.get().screen).toBe("drive");
    expect(store.get().panel).toBeNull();
    await settle();
    expect(history.state).toEqual({ screen: "drive" });
    // Declined and offline again: ← is one step to S1.
    store.applyMy({ ...MY, serverNow: Date.now() });
    store.home();
    await settle();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
  });
});

describe("a reload of the app's own entry", () => {
  /** The phone's back gesture on D1, Go offline, then one more step back from S1. */
  async function leaveDriveAndApp(store: AppStore): Promise<void> {
    history.back();
    await settle();
    expect(store.get().screen).toBe("drive");
    expect(store.get().leaveDrive).toBe("home");
    await store.leaveDriveConfirmed();
    await settle();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true }); // S1 was the app's only entry under D1
  }

  it("an online driver reloading on D1, twice: no S1 is added under D1, ← from S1 leaves the app", async () => {
    const driver = onlineDriver();
    let store = await launch("/", driver);
    const length = history.length;
    store = await reload(store, driver);
    store = await reload(store, driver);
    expect(store.get().screen).toBe("drive");
    expect(history.state).toEqual({ screen: "drive" });
    expect(history.length).toBe(length);
    await leaveDriveAndApp(store);
  });

  it("a rider reloading during a ride stays on R1 with S1 right under it", async () => {
    const ride = { id: "r1", role: "rider" } as RideView;
    let store = await launch("/", {}, { ride });
    const length = history.length;
    store = await reload(store, {}, { ride });
    expect(store.get().screen).toBe("ride");
    expect(history.state).toEqual({ screen: "ride" });
    expect(history.length).toBe(length);
    // The ride is over: ← is one step to S1, and one more leaves the app.
    store.applyMy({ ...MY, serverNow: Date.now() });
    store.home();
    await settle();
    expect(history.state).toEqual({ screen: "home" });
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true });
  });

  it("a reload on Planned opens S1 — the S1 under Planned, not a second one", async () => {
    let store = await launch("/");
    store.go("planned");
    const length = history.length;
    store = await reload(store);
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
    expect(history.length).toBe(length);
    store.go("history");
    expect(history.state).toEqual({ screen: "history" });
    store.home();
    await settle();
    expect(history.state).toEqual({ screen: "home" });
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true });
  });

  it("a reload on S1 that opens D1 (a driver on standby) puts D1 on that S1", async () => {
    const store = await reload(await launch("/"), {}, { standby: true });
    expect(store.get().screen).toBe("drive");
    expect(history.state).toEqual({ screen: "drive" });
    store.home();
    await settle();
    expect(history.state).toEqual({ screen: "home" });
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true });
  });

  it("with the bookings panel open on D1: the panel closes, the stack is [S1, D1]", async () => {
    const driver = onlineDriver();
    let store = await launch("/", driver);
    store.openPanel("bookings");
    expect(history.state).toEqual({ panel: "bookings", screen: "drive" });
    store = await reload(store, driver);
    expect(store.get().screen).toBe("drive");
    expect(store.get().panel).toBeNull();
    expect(history.state).toEqual({ screen: "drive" });
    await leaveDriveAndApp(store);
  });

  it("with a panel open on Planned or on S1: S1 opens, the app's only S1", async () => {
    let store = await launch("/");
    store.go("planned");
    store.openPanel("appointment", "a1");
    store = await reload(store);
    expect(store.get().screen).toBe("home");
    expect(store.get().panel).toBeNull();
    expect(history.state).toEqual({ screen: "home" });
    store.openPanel("profile");
    store = await reload(store);
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true });
  });
});

describe("a screen opened from a panel (C10)", () => {
  it("S1 → Siosia → request → Send → Planned: the stack is [S1, Planned] and ← goes to S1", async () => {
    const store = await launch("/");
    store.go("catalog");
    store.openPanel("request", "childcare");
    expect(history.state).toEqual({ panel: "request", screen: "catalog" });
    store.goFromPanel("planned");
    expect(store.get().screen).toBe("planned");
    expect(store.get().panel).toBeNull();
    await settle();
    expect(history.state).toEqual({ screen: "planned" });
    store.home();
    await settle();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
  });

  it("the menu's Planned and History links: from S1 one entry on S1, on Planned itself just the panel closes", async () => {
    const store = await launch("/");
    store.openPanel("profile");
    store.goFromPanel("history");
    expect(history.state).toEqual({ screen: "history" });
    store.go("planned");
    store.openPanel("profile");
    store.goFromPanel("planned");
    await settle();
    expect(store.get().screen).toBe("planned");
    expect(history.state).toEqual({ screen: "planned" });
    history.back(); // the phone's back gesture
    await settle();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
  });
});

describe("a notification tapped while online on D1 (C11)", () => {
  it("asks first; after Go offline it opens Planned, with S1 under it", async () => {
    const driver = onlineDriver();
    const store = await launch("/", driver);
    store.openFromUrl("./?open=planned");
    expect(store.get().screen).toBe("drive");
    expect(store.get().leaveDrive).toBe("planned");
    await store.leaveDriveConfirmed();
    expect(driver.setOnline).toHaveBeenCalledWith(false);
    expect(store.get().leaveDrive).toBeNull();
    expect(store.get().screen).toBe("planned");
    await settle();
    expect(history.state).toEqual({ screen: "planned" });
    store.home();
    await settle();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
  });

  it("with the bookings panel open on D1 too; No keeps D1 online", async () => {
    const driver = onlineDriver();
    const store = await launch("/", driver);
    store.openPanel("bookings");
    store.openFromUrl("./?open=history");
    expect(store.get().leaveDrive).toBe("history");
    store.cancelLeaveDrive();
    expect(store.get().leaveDrive).toBeNull();
    expect(store.get().screen).toBe("drive");
    expect(driver.setOnline).not.toHaveBeenCalled();
    store.openFromUrl("./?open=history");
    await store.leaveDriveConfirmed();
    expect(store.get().screen).toBe("history");
    expect(store.get().panel).toBeNull();
    await settle();
    expect(history.state).toEqual({ screen: "history" });
    store.home();
    await settle();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
  });
});

describe("2.1: an open request's notification and the take panel (FR-162, FR-163)", () => {
  it("./?open=planned opens P1 (You could help); I can do it is one panel entry on Planned, ← closes it", async () => {
    const store = await launch("/?open=planned", {}, { openRequests: 1 });
    expect(store.get().screen).toBe("planned");
    expect(store.get().my?.openRequests).toBe(1);
    store.openPanel("appointment", "take:a7");
    expect(history.state).toEqual({ panel: "appointment", screen: "planned" });
    store.closePanel();
    await settle();
    expect(store.get().panel).toBeNull();
    expect(store.get().screen).toBe("planned");
    expect(history.state).toEqual({ screen: "planned" });
    store.home();
    await settle();
    expect(history.state).toEqual({ screen: "home" });
  });

  it("the same notification while the app is open goes to Planned from wherever the user is", async () => {
    const store = await launch("/");
    store.go("history");
    store.openFromUrl("./?open=planned");
    expect(store.get().screen).toBe("planned");
    await settle();
    expect(history.state).toEqual({ screen: "planned" });
  });
});

describe("2.1: the car colour (FR-170)", () => {
  const kia: Vehicle = { make: "Kia", model: "Ceed", colour: "Blue", plate: "WX1", seats: 4, paint: null };

  it("replaces the vehicle at once with the colour name and paint the server saved", async () => {
    const setCarColour = vi.fn(async (colour: string, paint: string) => ({ ...kia, colour, paint }));
    const store = await start({ getVehicle: async () => kia, setCarColour });
    expect(store.get().vehicle).toEqual(kia);
    const saved = await store.setCarColour("Red", "#c62828");
    expect(setCarColour).toHaveBeenCalledWith("Red", "#c62828");
    expect(saved).toEqual({ ...kia, colour: "Red", paint: "#c62828" });
    expect(store.get().vehicle).toEqual(saved);
    expect(store.get().screen).toBe("home"); // nothing else moves
  });

  it("keeps the chosen paint when a server returns the vehicle without it", async () => {
    const store = await start({ getVehicle: async () => kia, setCarColour: async (colour: string) => ({ make: "Kia", model: "Ceed", colour, plate: "WX1", seats: 4 }) });
    await store.setCarColour("Czerwony", "#C62828");
    expect(store.get().vehicle).toEqual({ ...kia, colour: "Czerwony", paint: "#c62828" });
  });

  it("leaves the vehicle as it was when the server refuses", async () => {
    const store = await start({ getVehicle: async () => kia, setCarColour: async () => Promise.reject(new ServerError("bad_vehicle")) });
    await expect(store.setCarColour("Red", "#c62828")).rejects.toMatchObject({ code: "bad_vehicle" });
    expect(store.get().vehicle).toEqual(kia);
  });
});
