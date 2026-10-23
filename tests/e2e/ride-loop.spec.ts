import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Full P1 loop on the mock backend (US1–US4): rider requests, a human driver accepts, statuses
// propagate, positions stream, sharing stops, receipts, ratings, history and earnings.
// External map services are blocked so the run is deterministic (routing falls back to the
// straight-line estimate — US6 — and pins keep their coordinate labels).

async function isolate(context: BrowserContext) {
  await context.route(/router\.project-osrm\.org|nominatim\.openstreetmap\.org|tile\.openstreetmap\.org/, (r) => r.abort());
}

async function onboard(page: Page, nick: string) {
  await page.goto("/?launch=0&robots=0");
  await page.getByLabel("Nickname").fill(nick);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${nick}` })).toBeVisible();
}

/** 2.0: S1 → Siosia → Ride (R1) / Ride — Go online (D1). */
async function openRide(page: Page) {
  await page.getByTestId("start-siosia").click();
  await page.getByTestId("catalog-ride").click();
}
async function openDrive(page: Page) {
  await page.getByTestId("start-siosia").click();
  await page.getByTestId("catalog-drive").click();
}

async function longPressMap(page: Page, dx: number, dy: number) {
  const box = (await page.locator(".map").boundingBox())!;
  // Leaflet turns a right-click / long-press into "contextmenu" → sets the dropoff (FR-011).
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + 120 + dy, { button: "right" });
}

test("rider and driver complete a ride end to end", async ({ context }) => {
  await isolate(context);
  const driver = await context.newPage();
  const rider = await context.newPage();

  // --- driver: nickname → Drive → vehicle → Go online (S4 visible) ---
  await onboard(driver, "Adam");
  await openDrive(driver);
  await driver.getByLabel("Make").fill("Skoda");
  await driver.getByLabel("Model").fill("Octavia");
  await driver.getByLabel("Colour").fill("Grey");
  await driver.getByLabel("Plate").fill("WX 12345");
  await driver.getByRole("button", { name: "Save" }).click();
  await driver.getByTestId("toggle-online").click();
  await expect(driver.getByTestId("driver-state")).toHaveText("Online");
  await expect(driver.getByTestId("sharing-banner")).toContainText("online as a driver");

  // --- rider: nickname → Ride → pickup from GPS, dropoff by long-press → fare ---
  await onboard(rider, "Ola");
  await openRide(rider);
  await expect(rider.getByTestId("pickup-field")).toContainText("My location");
  await longPressMap(rider, 100, 60);
  await expect(rider.getByTestId("dropoff-field")).toContainText("Pinned");
  await expect(rider.getByTestId("fare")).toContainText("PLN");
  await expect(rider.getByTestId("estimate")).toContainText("estimate"); // routing blocked → fallback (FR-032)
  const fare = (await rider.getByTestId("fare").textContent())!.trim();
  await rider.getByTestId("request-ride").click();
  await expect(rider.getByTestId("searching-title")).toHaveText("Finding a driver…");

  // --- driver gets the offer card within the ping round-trip, accepts ---
  const card = driver.getByTestId("offer-card");
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText("Ola");
  await expect(card).toContainText(fare.match(/\d+[.,]\d{2}/)![0]); // same frozen fare on the offer
  await driver.getByTestId("accept-offer").click();
  await expect(driver.getByTestId("trip-status")).toContainText("Head to the pickup");

  // --- rider sees driver, vehicle and plate (FR-015/044) and shares location (S4) ---
  await expect(rider.getByTestId("driver-card")).toContainText("Adam");
  await expect(rider.getByTestId("plate")).toHaveText("WX 12345");
  await expect(rider.getByTestId("ride-status")).toContainText("Your driver is on the way");
  await expect(rider.getByTestId("sharing-banner")).toContainText("with your driver");

  // driver moves → rider's car marker appears (positions over the ride channel only). Chromium
  // feeds GPS only to the focused page, so focus the driver like the phone in their hand.
  await driver.bringToFront();
  await context.setGeolocation({ latitude: 52.2307, longitude: 21.0132, accuracy: 8 });
  await expect(rider.locator(".leaflet-marker-icon.car")).toBeVisible({ timeout: 10_000 });

  // --- statuses propagate within a second each (US1.4) ---
  await driver.getByTestId("arrived").click();
  await expect(rider.getByTestId("ride-status")).toContainText("Your driver has arrived", { timeout: 2000 });
  await driver.getByTestId("start-trip").click();
  await expect(rider.getByTestId("ride-status")).toContainText("On the way to your destination", { timeout: 2000 });
  await expect(rider.getByTestId("sharing-banner")).toHaveCount(0); // rider sharing stops at in_progress
  await driver.getByTestId("complete-trip").click();

  // --- receipts on both sides; all sharing stopped on the rider ---
  await expect(rider.getByTestId("after-ride-title")).toHaveText("Trip complete");
  await expect(rider.getByTestId("receipt-fare")).toHaveText(fare);
  await expect(driver.getByTestId("after-ride-title")).toHaveText("Trip summary");
  await expect(rider.getByTestId("sharing-banner")).toHaveCount(0);

  await rider.getByTestId("mark-paid").click();
  await expect(rider.getByText("Paid")).toBeVisible();
  await rider.getByRole("radio", { name: "5 of 5 stars" }).click();
  await rider.getByTestId("send-rating").click();
  await expect(rider.getByText("Thanks for rating!")).toBeVisible();
  await driver.getByTestId("mark-paid").click(); // "Mark fare collected"
  await driver.getByRole("radio", { name: "4 of 5 stars" }).click();
  await driver.getByTestId("send-rating").click();
  await driver.getByTestId("after-ride-done").click();
  await rider.getByTestId("after-ride-done").click();

  // --- earnings and history (US7) ---
  await expect(driver.getByTestId("today-earnings")).toHaveText(fare);
  // H1 as a panel on D1: the online driver stays online (FR-133).
  await driver.getByTestId("open-history").click();
  await expect(driver.getByTestId("earnings-today")).toHaveText(fare);
  await expect(driver.getByTestId("history-list")).toContainText("Completed");
  await driver.getByRole("dialog").getByRole("button", { name: "Back" }).click();
  await expect(driver.getByTestId("driver-state")).toHaveText("Online");
  await driver.getByTestId("toggle-online").click();
  await expect(driver.getByTestId("start-siosia")).toBeVisible(); // offline: back on S1 (FR-082)
  await expect(driver.getByTestId("sharing-banner")).toHaveCount(0);
  await rider.getByTestId("start-history").click(); // finishing the ride returned the rider to S1
  await expect(rider.getByTestId("history-list")).toContainText("Completed");
});

async function goOnlineAsDriver(driver: Page, nick: string, plate: string) {
  await onboard(driver, nick);
  await openDrive(driver);
  await driver.getByLabel("Make").fill("Kia");
  await driver.getByLabel("Model").fill("Ceed");
  await driver.getByLabel("Colour").fill("Blue");
  await driver.getByLabel("Plate").fill(plate);
  await driver.getByRole("button", { name: "Save" }).click();
  await driver.getByTestId("toggle-online").click();
  await expect(driver.getByTestId("driver-state")).toHaveText("Online");
}

test("a request nobody accepts stays open 20 minutes, then expires and Try again requests anew (US3-4)", async ({ context }) => {
  await isolate(context);
  const rider = await context.newPage();
  await rider.clock.install(); // real time keeps flowing; fastForward jumps the server timers too
  await onboard(rider, "Ewa");
  await openRide(rider);
  await longPressMap(rider, -150, 30);
  await rider.getByTestId("request-ride").click();
  await expect(rider.getByTestId("searching-title")).toBeVisible();
  await expect(rider.getByText("No drivers nearby yet")).toBeVisible({ timeout: 8000 });
  await expect(rider.getByTestId("search-until")).toContainText("We keep looking until");
  await rider.clock.fastForward("10:00");
  await rider.waitForTimeout(7000); // let the mock server sweep and the rider poll run at least once
  await expect(rider.getByTestId("searching-title")).toBeVisible(); // still searching after 10 min
  await rider.clock.fastForward("10:05");
  await expect(rider.getByText("No driver accepted your request.")).toBeVisible({ timeout: 10_000 });
  await rider.getByTestId("try-again").click();
  await expect(rider.getByTestId("searching-title")).toHaveText("Finding a driver…");
  await rider.getByTestId("cancel-request").click();
  await expect(rider.getByTestId("request-ride")).toBeVisible();
});

test("a driver who goes online later gets the waiting request; Show requests brings back a declined one", async ({ context }) => {
  await isolate(context);
  const rider = await context.newPage();
  await onboard(rider, "Iga");
  await openRide(rider);
  await longPressMap(rider, 100, 60);
  await rider.getByTestId("request-ride").click();
  await expect(rider.getByText("No drivers nearby yet")).toBeVisible({ timeout: 8000 });

  // The request was made before any driver was online: going online offers it automatically.
  const driver = await context.newPage();
  await driver.bringToFront(); // Chromium feeds GPS only to the focused page
  await goOnlineAsDriver(driver, "Olek", "WX 777");
  const card = driver.getByTestId("offer-card");
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText("Iga");
  await driver.getByTestId("decline-offer").click();
  await expect(card).toHaveCount(0);
  await expect(driver.getByTestId("pending-nearby")).toHaveText("Pending requests nearby: 1");

  // "Show requests" brings the declined request back at once.
  await driver.getByTestId("show-requests").click();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Iga");

  // So does going offline and online again.
  await driver.getByTestId("decline-offer").click();
  await expect(card).toHaveCount(0);
  await driver.getByTestId("toggle-online").click();
  await expect(driver.getByTestId("start-siosia")).toBeVisible(); // offline: back on S1 (FR-082)
  await openDrive(driver);
  await driver.getByTestId("toggle-online").click();
  await expect(card).toBeVisible({ timeout: 5000 });

  // Once the rider cancels there is nothing left to show.
  await rider.getByTestId("cancel-request").click();
  await expect(card).toHaveCount(0, { timeout: 5000 });
  await expect(driver.getByTestId("pending-nearby")).toHaveText("No pending requests nearby right now.", { timeout: 8000 });
  await driver.getByTestId("show-requests").click();
  await expect(driver.getByTestId("toast")).toHaveText("No pending requests nearby right now.");
});

test("the Toria link rides from her default places at a fixed 18; rider only", async ({ context }) => {
  await isolate(context);
  // Everyone near Toria's default pickup in Stare Babice.
  await context.setGeolocation({ latitude: 52.2504843, longitude: 20.8253459, accuracy: 10 });
  const driver = await context.newPage();
  await goOnlineAsDriver(driver, "Adam", "WX 4242");

  const rider = await context.newPage();
  await rider.goto("/?launch=0&robots=0#master=demo-master");
  await rider.bringToFront();
  await expect(rider.getByTestId("link-toast")).toHaveText("This phone now uses the shared profile Toria.");
  await expect(rider).toHaveURL(/\/\?launch=0&robots=0$/); // the token left the address bar
  await openRide(rider);
  const chip = rider.getByTestId("master-chip");
  await expect(chip).toContainText("Toria");
  await expect(chip).toContainText("Master profile · every ride:");
  await expect(rider.getByTestId("pickup-field")).toContainText("Warszawsa 269, Stare Babice");
  await expect(rider.getByTestId("dropoff-field")).toContainText("Husarska 16, Lipków");
  await expect(rider.getByTestId("fare")).toContainText(/18[.,]00/);
  await expect(rider.getByTestId("fixed-fare")).toHaveText("Fixed fare");
  await rider.getByTestId("request-ride").click();

  const card = driver.getByTestId("offer-card");
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText("Toria");
  await expect(card).toContainText("Husarska 16, Lipków");
  await expect(card).toContainText(/18[.,]00/);
  await rider.getByTestId("cancel-request").click();
  await expect(card).toHaveCount(0, { timeout: 5000 });

  await rider.getByRole("button", { name: "Menu" }).click();
  await expect(rider.getByText("Shared profile from a link")).toBeVisible();
  await expect(rider.getByRole("button", { name: "Switch to Drive" })).toHaveCount(0);
});

test("the Roman link opens a driver profile with his green Taycan; riders see it on the driver card", async ({ context }) => {
  await isolate(context);
  const roman = await context.newPage();
  await roman.goto("/?launch=0&robots=0#master=demo-roman");
  await roman.bringToFront(); // GPS for going online
  await expect(roman.getByTestId("link-toast")).toHaveText("This phone now uses the shared profile Roman.");
  await roman.getByTestId("start-siosia").click();
  await expect(roman.getByTestId("catalog-learning")).toBeVisible(); // the catalog has loaded…
  await expect(roman.getByTestId("catalog-ride")).toHaveCount(0); // …without Ride: a driver profile cannot ride
  await roman.getByTestId("catalog-drive").click();
  // The car is preset — only the plate is added once.
  await expect(roman.getByLabel("Make")).toHaveValue("Porsche");
  await expect(roman.getByLabel("Model")).toHaveValue("Taycan Cross Turismo");
  await expect(roman.getByLabel("Colour")).toHaveValue("Zielony");
  await roman.getByLabel("Plate").fill("WX 5555");
  await roman.getByRole("button", { name: "Save" }).click();
  await expect(roman.getByTestId("master-chip")).toContainText("Roman");
  await expect(roman.getByTestId("master-chip").getByRole("img", { name: "Green Taycan Cross Turismo" })).toBeVisible();
  await roman.getByTestId("toggle-online").click();
  await expect(roman.getByTestId("driver-state")).toHaveText("Online");
  await roman.getByRole("button", { name: "Menu" }).click();
  await expect(roman.getByRole("button", { name: "Switch to Ride" })).toHaveCount(0); // driver only
  await roman.getByRole("dialog").getByRole("button", { name: "Back" }).click();

  const rider = await context.newPage();
  await onboard(rider, "Ola");
  await openRide(rider);
  await longPressMap(rider, 100, 60);
  await rider.getByTestId("request-ride").click();
  const card = roman.getByTestId("offer-card");
  await expect(card).toBeVisible({ timeout: 5000 });
  await roman.getByTestId("accept-offer").click();
  const driverCard = rider.getByTestId("driver-card");
  await expect(driverCard).toContainText("Roman");
  await expect(driverCard.getByRole("img", { name: "Green Taycan Cross Turismo" })).toBeVisible();
  await expect(driverCard).toContainText("Zielony Porsche Taycan Cross Turismo");
  await expect(rider.getByTestId("plate")).toHaveText("WX 5555");
});

test("a wrong master-profile link says so and falls back to the normal start", async ({ context }) => {
  await isolate(context);
  const page = await context.newPage();
  await page.goto("/?launch=0&robots=0#master=not-a-real-link");
  await expect(page.getByTestId("link-toast")).toHaveText("This link is not valid any more. Ask the organiser for a new one.");
  await expect(page.getByLabel("Nickname")).toBeVisible();
});

test("a master link on a phone with its own profile asks before replacing it", async ({ context }) => {
  await isolate(context);
  const page = await context.newPage();
  await onboard(page, "Ola");
  await page.goto("/?launch=0&robots=0#master=demo-master"); // only the #hash changes: the app reloads itself
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("It replaces your profile “Ola” here");
  await page.reload(); // e.g. an app update mid-question: the link is still waiting for an answer
  await expect(dialog).toContainText("It replaces your profile “Ola” here");
  await dialog.getByRole("button", { name: "No" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Hi, Ola" })).toBeVisible(); // nothing changed
  await page.waitForTimeout(1000);
  await expect(dialog).toHaveCount(0); // answered: not asked again

  await page.goto("/?launch=0&robots=0#master=demo-master");
  await page.getByRole("alertdialog").getByRole("button", { name: "Use shared profile" }).click();
  await expect(page.getByTestId("link-toast")).toHaveText("This phone now uses the shared profile Toria.");
  await expect(page.getByRole("heading", { name: "Hi, Toria" })).toBeVisible();
  await openRide(page);
  await expect(page.getByTestId("master-chip")).toContainText("Toria");
});

test("a one-time code moves a profile into another app (the iOS Home Screen app has its own storage)", async ({ context }) => {
  await isolate(context);
  const browser = await context.newPage();
  await onboard(browser, "Ola");
  await browser.getByRole("button", { name: "Profile" }).click();
  const section = browser.getByTestId("app-section");
  await expect(section).toContainText("Siosia as an app");
  await section.getByTestId("show-transfer-code").click();
  const code = (await browser.getByTestId("transfer-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // Another tab is another account here — like the Home Screen app on an iPhone.
  const appPage = await context.newPage();
  await appPage.goto("/?launch=0&robots=0");
  await appPage.getByText("Moving from the browser or another phone?").click();
  await appPage.getByTestId("move-code").fill(code.toLowerCase());
  await appPage.getByTestId("move-submit").click();
  await expect(appPage.getByTestId("link-toast")).toHaveText("Your profile Ola is now in this app.");
  await expect(appPage.getByRole("heading", { name: "Hi, Ola" })).toBeVisible();

  // The browser notices by itself and starts fresh (no reload, no stuck screen).
  await expect(browser.getByTestId("link-toast")).toHaveText("This profile moved to another app or phone. Here you can start again.");
  await expect(browser.getByLabel("Nickname")).toBeVisible();
});

test("a rider books a ride for later; a driver takes it in advance; the rider sees who and can cancel", async ({ context }) => {
  await isolate(context);
  const driver = await context.newPage();
  await goOnlineAsDriver(driver, "Adam", "WX 4242");

  const rider = await context.newPage();
  await onboard(rider, "Ola");
  await openRide(rider);
  await longPressMap(rider, 100, 60);
  await rider.getByTestId("when-later").click();
  const d = new Date(Date.now() + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  await rider.getByTestId("later-at").fill(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`);
  await expect(rider.getByTestId("book-ride")).toContainText("Book for");
  await rider.getByTestId("book-ride").click();
  await expect(rider.getByTestId("booked-notice")).toContainText("Booked for");
  await rider.getByTestId("my-bookings-link").click(); // 2.0: bookings live in Planned
  await expect(rider.getByTestId("planned")).toBeVisible();
  await expect(rider.getByTestId("booking")).toContainText("Waiting for a driver");

  await expect(driver.getByTestId("push-toast")).toContainText("New booking"); // the demo shows notifications in the app
  await expect(driver.getByTestId("bookings-row")).toContainText("1 to take", { timeout: 8000 });
  await driver.getByTestId("open-bookings").click();
  const offer = driver.getByTestId("open-booking");
  await expect(offer).toContainText("Ola");
  await offer.getByTestId("take-booking").click();
  await expect(driver.getByTestId("my-booking")).toContainText("Ola");

  await expect(rider.getByTestId("push-toast")).toContainText("Adam will drive you");
  await expect(rider.getByTestId("booking-driver")).toContainText("Driver: Adam", { timeout: 35_000 });
  await expect(rider.getByTestId("booking-driver")).toContainText("WX 4242");

  // 2.2 (FR-180): the booking starts (30 min before); when the driver's car moves off, the rider is
  // told it set off, and the driver's Navigate opens Google Maps (FR-181).
  await driver.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("siosia.mock.db.v1") ?? "null");
    if (!db) throw new Error("no mock db");
    for (const r of Object.values(db.rides) as { status: string; scheduledFor: number | null }[]) if (r.status === "scheduled" && r.scheduledFor) r.scheduledFor = Date.now() + 29 * 60_000;
    localStorage.setItem("siosia.mock.db.v1", JSON.stringify(db));
  });
  await expect(driver.getByTestId("push-toast")).toContainText("Time to go", { timeout: 15_000 });
  await expect(driver.getByTestId("navigate")).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
  // The started ride holds R1: the rider's app follows it there by itself (V1).
  await expect(rider.getByTestId("ride-status")).toContainText("Your driver will set off soon", { timeout: 15_000 });
  await driver.bringToFront(); // Chromium feeds GPS only to the focused page
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 8 });
  await driver.waitForTimeout(1500);
  await context.setGeolocation({ latitude: 52.2327, longitude: 21.0122, accuracy: 8 }); // ~330 m north: set off
  await expect(rider.getByTestId("ride-status")).toContainText("Your driver has set off", { timeout: 15_000 });
  await expect(rider.getByTestId("push-toast")).toContainText("Adam has set off");
  await rider.bringToFront(); // a backgrounded Chromium tab answers clicks late
  await rider.getByTestId("cancel-ride").click();
  await rider.getByRole("alertdialog").getByRole("button", { name: "Cancel ride" }).click();
  await expect(rider.getByTestId("request-ride")).toBeDisabled({ timeout: 15_000 }); // R1 again, no ride
  await expect(driver.getByTestId("offer-card")).toHaveCount(0);
});

test("the menu offers notifications next to the app install steps", async ({ context }) => {
  await isolate(context);
  const page = await context.newPage();
  await onboard(page, "Ola");
  await page.getByRole("button", { name: "Profile" }).click();
  // Headless Chromium reports notifications as blocked; the on/off flow is unit-tested (push.test.ts).
  await expect(page.getByTestId("push-section")).toContainText("Notifications");
  await expect(page.getByTestId("push-state")).not.toBeEmpty();
});

test("the rider keeps the driver's car, greyed with 'last seen', when the driver's app goes quiet (§12, iPhone)", async ({ context }) => {
  await isolate(context);
  const driver = await context.newPage();
  await goOnlineAsDriver(driver, "Roman", "W1LLRUN");
  const rider = await context.newPage();
  await onboard(rider, "Toria");
  await openRide(rider);
  await longPressMap(rider, 100, 60);
  await rider.getByTestId("request-ride").click();
  await driver.getByTestId("accept-offer").click();
  await expect(rider.getByTestId("driver-card")).toContainText("Roman");
  await driver.bringToFront(); // Chromium feeds GPS only to the focused page
  await context.setGeolocation({ latitude: 52.2307, longitude: 21.0132, accuracy: 8 });
  await expect(rider.locator(".leaflet-marker-icon.car")).toBeVisible({ timeout: 10_000 });

  // The driver's app disappears (on an iPhone: screen locked, or Apple Maps in front).
  await driver.close();
  await expect(rider.getByTestId("driver-paused")).toContainText("Your ride is still on", { timeout: 15_000 });
  await rider.waitForTimeout(10_000); // the marker used to vanish 8 s after the driver left
  await expect(rider.locator(".leaflet-marker-icon.car.is-stale")).toBeVisible();
  await expect(rider.getByTestId("driver-last-seen")).toContainText("Last seen");
  await expect(rider.getByTestId("ride-status")).toContainText("Your driver is on the way");
});

test("Keep the screen on: a top-bar checkbox, on by itself while a driver is online, remembered on this phone", async ({ context }) => {
  await isolate(context);
  const driver = await context.newPage();
  await goOnlineAsDriver(driver, "Kuba", "WE 4321");
  const box = driver.getByTestId("screen-on");
  await expect(box).toBeChecked(); // online: the screen stays on anyway (FR-020)
  await expect(box).toBeDisabled();
  await driver.getByTestId("toggle-online").click();
  await expect(driver.getByTestId("start-siosia")).toBeVisible(); // offline: S1 (FR-082)
  await openDrive(driver);
  await expect(driver.getByTestId("driver-state")).toHaveText("Offline");
  await expect(box).not.toBeChecked();
  await box.check();
  await driver.reload(); // opens on S1: no mode is remembered, the checkbox is
  await openDrive(driver);
  await expect(driver.getByTestId("driver-state")).toHaveText("Offline");
  await expect(driver.getByTestId("screen-on")).toBeChecked();
  // The same choice in the menu, with what it does.
  await driver.getByRole("button", { name: "Menu" }).click();
  await driver.getByTestId("screen-on-info").click(); // the explanation is behind the round "i" (FR-190)
  await expect(driver.getByTestId("screen-on-tip")).toContainText("pressing the side button still pauses Siosia");
  await expect(driver.getByTestId("screen-on-section").getByRole("checkbox")).toBeChecked();
});

test("a driver whose app went quiet stays on standby and is back online with the request when the app opens", async ({ context }) => {
  await isolate(context);
  const driver = await context.newPage();
  await goOnlineAsDriver(driver, "Adam", "WX 4242");
  await driver.getByTestId("online-hints-info").click();
  await expect(driver.getByTestId("online-hints-tip")).toContainText("you still hear about new requests");
  await driver.goto("about:blank"); // the app is closed (this tab keeps its account)

  const rider = await context.newPage();
  await rider.clock.install();
  await onboard(rider, "Ola");
  await rider.clock.fastForward("01:30"); // the driver has been silent for 90 s: offline, still on standby
  await rider.waitForTimeout(2500); // the demo server sweeps every 2 s
  await openRide(rider);
  await longPressMap(rider, 100, 60);
  await rider.getByTestId("request-ride").click(); // → "New ride request" notification to the driver
  const drivers = await rider.evaluate(
    () => Object.values(JSON.parse(localStorage.getItem("siosia.mock.db.v1")!).drivers) as { online: boolean; standbyUntil?: number }[]
  );
  expect(drivers.some((d) => !d.online && (d.standbyUntil ?? 0) > 0)).toBe(true); // offline, on standby

  await driver.bringToFront(); // GPS for the driver
  await driver.goto("/?launch=0&robots=0"); // opened from the notification
  await expect(driver.getByTestId("driver-state")).toHaveText("Online", { timeout: 10_000 });
  await expect(driver.getByTestId("offer-card")).toContainText("Ola", { timeout: 10_000 });
});

test("cancelling a request withdraws the offer card from the driver (US3, §5)", async ({ context }) => {
  await isolate(context);
  const driver = await context.newPage();
  const rider = await context.newPage();
  await goOnlineAsDriver(driver, "Bea", "WX 777");
  await onboard(rider, "Ola");
  await openRide(rider);
  await longPressMap(rider, 140, 20);
  await rider.getByTestId("request-ride").click();
  await expect(driver.getByTestId("offer-card")).toBeVisible({ timeout: 5000 });
  await rider.getByTestId("cancel-request").click();
  await expect(driver.getByTestId("offer-card")).toHaveCount(0, { timeout: 3000 });
  await expect(driver.getByTestId("driver-state")).toHaveText("Online");
});

test("demo robots accept a request without any second device (FR-070)", async ({ context }) => {
  await isolate(context);
  const rider = await context.newPage();
  await rider.goto("/?launch=0&robots=2");
  await rider.getByLabel("Nickname").fill("Solo");
  await rider.getByRole("button", { name: "Continue" }).click();
  await openRide(rider);
  await longPressMap(rider, 120, 40);
  await expect(rider.getByText(/Cars nearby: [12]/)).toBeVisible({ timeout: 15_000 });
  await rider.getByTestId("request-ride").click();
  await expect(rider.getByTestId("driver-card")).toContainText("Robo", { timeout: 20_000 });
  await expect(rider.getByTestId("plate")).toHaveText(/RB \d{4}/);
});
