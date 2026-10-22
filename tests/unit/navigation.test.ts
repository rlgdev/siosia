// Navigation and the browser history (FR-082, FR-084): the app keeps the history at [S1] or
// [S1, screen] (plus a panel's entry), so ← — a step back — always lands on the app's own S1, also
// after a reload (a new store booting on the same entry). jsdom's history is real: pushState /
// replaceState / back, with popstate a couple of timer turns later.
// 2.1: an open request's notification opens P1, the take panel, and the car colour in the store.
// 2.3: a chat notification (./?chat=<room>) opens that thread as a panel, also over D1 (FR-221).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend, PushMessage } from "../../src/backend/types";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import type { MyState, OfferView, Profile, RideView, Vehicle } from "../../src/core/types";
import { ServerError } from "../../src/core/types";
import { AppStore, PROFILE_MAX_AGE_MS } from "../../src/state/store";

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
  photo: null,
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
  unreadChats: 0,
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
    expect(history.state).toEqual({ panel: "appointment", arg: "a1", screen: "planned", depth: 1 });
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
    expect(history.state).toEqual({ panel: "bookings", arg: null, screen: "drive", depth: 1 });
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
    expect(history.state).toEqual({ panel: "request", arg: "childcare", screen: "catalog", depth: 1 });
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
    expect(history.state).toEqual({ panel: "appointment", arg: "take:a7", screen: "planned", depth: 1 });
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

describe("2.3: a chat notification and the chat panel (FR-221, FR-222)", () => {
  it("./?chat=<room> opens that thread as a panel over the current screen — an online driver stays on D1", async () => {
    const driver = onlineDriver();
    const store = await launch("/", driver);
    store.openFromUrl("./?chat=ride%3Ar1");
    expect(store.get().screen).toBe("drive");
    expect(store.get().panel).toBe("chat");
    expect(store.get().panelArg).toBe("ride:r1");
    expect(store.get().leaveDrive).toBeNull(); // no "go offline?" — D1 stays under the thread
    expect(history.state).toEqual({ panel: "chat", arg: "ride:r1", screen: "drive", depth: 1 });
    store.closePanel();
    await settle();
    expect(store.get().panel).toBeNull();
    expect(history.state).toEqual({ screen: "drive" });
    // Not a room of ours: nothing happens.
    store.openFromUrl("./?chat=bogus");
    expect(store.get().panel).toBeNull();
    store.openFromUrl("./?chat=appt%3A../x");
    expect(store.get().panel).toBeNull();
  });

  it("opened from a closed app: S1 with the thread over it, the parameter gone; ← closes the thread, then leaves", async () => {
    const store = await launch("/?chat=appt:a1");
    expect(store.get().screen).toBe("home");
    expect(store.get().panel).toBe("chat");
    expect(store.get().panelArg).toBe("appt:a1");
    expect(location.search).toBe("");
    expect(history.state).toEqual({ panel: "chat", arg: "appt:a1", screen: "home", depth: 1 });
    history.back(); // the phone's back gesture
    await settle();
    expect(store.get().panel).toBeNull();
    expect(store.get().screen).toBe("home");
    expect(history.state).toEqual({ screen: "home" });
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true });
  });

  it("a chat_message event in front: a toast whose link opens the room — none while that thread is open", async () => {
    const store = await launch("/");
    const show = (store as unknown as { showPush(m: PushMessage): Promise<void> }).showPush.bind(store);
    const hi: PushMessage = { kind: "chat_message", rideId: null, appointmentId: "a1", params: { sender: "Ewa", text: "Hi", room: "appt:a1" } };
    await show(hi);
    expect(store.get().pushToast?.url).toBe("./?chat=appt%3Aa1");
    store.openFromUrl(store.get().pushToast!.url!);
    expect(store.get().panel).toBe("chat");
    expect(store.get().panelArg).toBe("appt:a1");
    store.clearPushToast();
    // The user is looking at that thread: no banner (FR-222).
    await show(hi);
    expect(store.get().pushToast).toBeNull();
    // Another room still shows one; other kinds carry no link.
    await show({ kind: "chat_message", rideId: "r1", appointmentId: null, params: { sender: "Adam", text: "Here", room: "ride:r1" } });
    expect(store.get().pushToast?.url).toBe("./?chat=ride%3Ar1");
    await show({ kind: "appt_accepted", rideId: null, appointmentId: "a1", params: { provider: "Ewa", service: "Childcare" } });
    expect(store.get().pushToast?.url).toBeNull();
  });
});

describe("2.3: the service worker's hand-off while the app is open (FR-222, V48)", () => {
  type SwMessage = { data: unknown; ports: Array<{ postMessage(m: unknown): void }> };
  afterEach(() => Reflect.deleteProperty(navigator, "serviceWorker"));

  it("answers whether this window shows that thread — only a visible chat on that room — and refreshes on a handed-over message", async () => {
    const listeners: Array<(ev: SwMessage) => void> = [];
    Object.defineProperty(navigator, "serviceWorker", {
      value: { addEventListener: (_type: string, cb: (ev: SwMessage) => void) => listeners.push(cb) },
      configurable: true
    });
    const store = await launch("/");
    expect(listeners).toHaveLength(1);
    const ask = (room: string): unknown => {
      const port = { postMessage: vi.fn() };
      listeners[0]({ data: { type: "siosia-chat-open?", room }, ports: [port] });
      return port.postMessage.mock.calls[0]?.[0];
    };
    expect(ask("appt:a1")).toEqual({ open: false }); // no thread open: the worker shows the notification
    store.openPanel("chat", "appt:a1");
    expect(ask("appt:a1")).toEqual({ open: true }); // the user is looking at it
    expect(ask("ride:r1")).toEqual({ open: false }); // another room
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    expect(ask("appt:a1")).toEqual({ open: false }); // a hidden tab shows nothing
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    // The message handed over instead of a notification: the state refreshes, no toast.
    const refresh = vi.spyOn(store, "requestRefresh");
    listeners[0]({ data: { type: "siosia-chat-message", room: "appt:a1", title: "Ewa", body: "Hi", url: "./?chat=appt:a1" }, ports: [] });
    expect(refresh).toHaveBeenCalled();
    expect(store.get().pushToast).toBeNull();
    // A question without a port, and a tap's link, as before.
    listeners[0]({ data: { type: "siosia-chat-open?", room: "appt:a1" }, ports: [] });
    listeners[0]({ data: { type: "siosia-open", url: "./?chat=ride%3Ar1" }, ports: [] });
    expect(store.get().panelArg).toBe("ride:r1");
  });
});

describe("2.3: a panel opened from inside a panel — the chat from C3 or from the driver's bookings (C15)", () => {
  it("C3 → its chat → ← lands back on C3, then on the screen; Home from the chat drops both entries", async () => {
    const store = await launch("/");
    store.go("planned");
    store.openPanel("appointment", "a1");
    expect(history.state).toEqual({ panel: "appointment", arg: "a1", screen: "planned", depth: 1 });
    store.openPanel("chat", "appt:a1");
    expect(store.get().panel).toBe("chat");
    expect(store.get().panelArg).toBe("appt:a1");
    expect(history.state).toEqual({ panel: "chat", arg: "appt:a1", screen: "planned", depth: 2 });
    store.closePanel(); // the chat's ← / X
    await settle();
    expect(store.get().panel).toBe("appointment");
    expect(store.get().panelArg).toBe("a1");
    expect(store.get().screen).toBe("planned");
    expect(history.state).toEqual({ panel: "appointment", arg: "a1", screen: "planned", depth: 1 });
    history.back(); // the phone's back gesture on C3
    await settle();
    expect(store.get().panel).toBeNull();
    expect(store.get().screen).toBe("planned");
    expect(history.state).toEqual({ screen: "planned" });
    // Home straight from the chat over C3: [S1], and one more step back leaves the app.
    store.openPanel("appointment", "a1");
    store.openPanel("chat", "appt:a1");
    store.home();
    await settle();
    expect(store.get().screen).toBe("home");
    expect(store.get().panel).toBeNull();
    expect(history.state).toEqual({ screen: "home" });
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true });
  });

  it("the driver's bookings on D1 → a ride's chat → ← returns to the bookings; D1 stays online", async () => {
    const driver = onlineDriver();
    const store = await launch("/", driver);
    store.openPanel("bookings");
    store.openPanel("chat", "ride:r1");
    expect(history.state).toEqual({ panel: "chat", arg: "ride:r1", screen: "drive", depth: 2 });
    store.closePanel();
    await settle();
    expect(store.get().panel).toBe("bookings");
    expect(store.get().panelArg).toBeNull();
    expect(store.get().screen).toBe("drive");
    expect(store.get().leaveDrive).toBeNull();
    expect(driver.setOnline).not.toHaveBeenCalled();
    store.closePanel();
    await settle();
    expect(store.get().panel).toBeNull();
    expect(history.state).toEqual({ screen: "drive" });
  });

  it("a screen opened from a panel over a panel: the stack is [S1, screen] — over S1 and over Planned", async () => {
    const store = await launch("/");
    store.openPanel("profile");
    store.openPanel("vehicle");
    expect(history.state).toEqual({ panel: "vehicle", arg: null, screen: "home", depth: 2 });
    store.goFromPanel("history");
    expect(store.get().screen).toBe("history");
    expect(store.get().panel).toBeNull();
    await settle();
    expect(history.state).toEqual({ screen: "history" });
    store.openPanel("appointment", "a1");
    store.openPanel("chat", "appt:a1");
    store.goFromPanel("planned");
    await settle();
    expect(store.get().screen).toBe("planned");
    expect(store.get().panel).toBeNull();
    expect(history.state).toEqual({ screen: "planned" });
    store.home();
    await settle();
    expect(history.state).toEqual({ screen: "home" });
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true });
  });

  it("the same panel again adds no entry; a reload with two panels open steps back over both onto S1", async () => {
    let store = await launch("/");
    store.go("planned");
    store.openPanel("appointment", "a1");
    store.openPanel("appointment", "a1");
    expect(history.state).toEqual({ panel: "appointment", arg: "a1", screen: "planned", depth: 1 });
    store.openPanel("chat", "appt:a1");
    const length = history.length;
    store = await reload(store);
    expect(store.get().screen).toBe("home");
    expect(store.get().panel).toBeNull();
    expect(history.state).toEqual({ screen: "home" });
    expect(history.length).toBe(length);
    history.back();
    await settle();
    expect(history.state).toEqual({ outside: true });
  });
});

describe("2.3: the profile's photo URL expires while the app stays open (C16)", () => {
  it("a profile older than 50 min is fetched again on the next refresh request — once per expiry, never while fresh", async () => {
    const getProfile = vi.fn(async () => PROFILE);
    const store = await start({ getProfile });
    expect(getProfile).toHaveBeenCalledTimes(1);
    store.requestRefresh(0);
    await settle();
    expect(getProfile).toHaveBeenCalledTimes(1); // fresh enough
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + PROFILE_MAX_AGE_MS + 60_000);
      getProfile.mockResolvedValue({ ...PROFILE, photo: "https://signed/new" });
      store.requestRefresh(0); // a change event, or the app back in front (visibilitychange → requestRefresh)
      await vi.waitFor(() => expect(getProfile).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(store.get().profile?.photo).toBe("https://signed/new"));
      store.requestRefresh(0);
      await settle();
      expect(getProfile).toHaveBeenCalledTimes(2); // the new one is fresh
    } finally {
      vi.useRealTimers();
    }
  });
});
