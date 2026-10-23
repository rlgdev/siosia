import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Siosia 2.0 on the mock backend (spec §13 "End-to-end"): the robot Siosia loop in one tab; client,
// provider and driver in three pages (request → accept with a ride there → the driver takes it →
// both see the driver; cancel cascades); a weekly series → All remaining; Add to calendar; the
// opening rules and ?open=. Map services are blocked: routes fall back to the straight line and
// "Here" gives the browser's (mocked) position without an address.
// 2.1: an open request taken by another member; the car colour from the car icon.

async function isolate(context: BrowserContext) {
  await context.route(/router\.project-osrm\.org|nominatim\.openstreetmap\.org|tile\.openstreetmap\.org/, (r) => r.abort());
}

/** Onboards a user; `query` picks robots: the robot Siosia is on unless siosia=0. */
async function onboard(page: Page, nick: string, query = "?robots=0&siosia=0") {
  await page.goto(`/${query}${query.includes("?") ? "&" : "?"}launch=0`);
  await page.getByLabel("Nickname").fill(nick);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${nick}` })).toBeVisible();
}

/** S1 → Siosia → an entry → C2 with "Here" as the place, the default start (tomorrow) and duration. */
async function requestService(page: Page, entry: string, repeat?: { times: number }) {
  await page.getByTestId("start-siosia").click();
  await page.getByTestId(`catalog-${entry}`).click();
  await expect(page.getByTestId("request-form")).toBeVisible();
  await page.getByTestId("request-place-here").click();
  await expect(page.getByTestId("request-place-value")).not.toHaveText("—");
  if (repeat) {
    await page.getByTestId("request-repeat").selectOption("weekly");
    await page.getByTestId("request-times").fill(String(repeat.times));
  }
  await page.getByTestId("request-send").click();
  await expect(page.getByTestId("planned")).toBeVisible(); // the request waits in Planned (US9)
}

async function offer(page: Page, entry: string) {
  await page.getByRole("button", { name: "Profile" }).click();
  await page.getByTestId(`offer-${entry}`).check();
  await expect(page.getByTestId(`offer-${entry}`)).toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
}

async function goOnlineAsDriver(driver: Page, nick: string, plate: string) {
  await onboard(driver, nick);
  await driver.getByTestId("start-siosia").click();
  await driver.getByTestId("catalog-drive").click();
  await driver.getByLabel("Make").fill("Kia");
  await driver.getByLabel("Model").fill("Ceed");
  await driver.getByLabel("Colour").fill("Blue");
  await driver.getByLabel("Plate").fill(plate);
  await driver.getByRole("button", { name: "Save" }).click();
  await driver.getByTestId("toggle-online").click();
  await expect(driver.getByTestId("driver-state")).toHaveText("Online");
}

test("one tab: the robot Siosia accepts within 5 s and books a ride there; Add to calendar (FR-151, FR-135)", async ({ context }) => {
  await isolate(context);
  const page = await context.newPage();
  await onboard(page, "Toria", "?robots=0");
  await page.getByTestId("start-siosia").click();
  await expect(page.getByTestId("catalog-childcare")).toContainText("Siosia", { timeout: 8000 });
  await page.getByTestId("page-back").click();
  await requestService(page, "childcare");
  const item = page.getByTestId("planned-appointment");
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 5000 });
  await expect(item.getByTestId("ride-line")).toHaveText("Ride there: no driver yet", { timeout: 5000 });
  await expect(page.getByTestId("push-toast")).toContainText("Siosia"); // the demo shows the notification

  // Add to calendar: the Google link and the demo's .ics file.
  await item.getByTestId("cal-open").click();
  const google = new URL((await item.getByTestId("cal-google").getAttribute("href"))!);
  expect(google.hostname).toBe("calendar.google.com");
  expect(google.searchParams.get("action")).toBe("TEMPLATE");
  expect(google.searchParams.get("text")).toBe("Childcare with Siosia");
  expect(google.searchParams.get("ctz")).toBe("Europe/Warsaw");
  expect(google.searchParams.get("dates")).toMatch(/^\d{8}T\d{6}\/\d{8}T\d{6}$/);
  const [download] = await Promise.all([page.waitForEvent("download"), item.getByTestId("cal-ics").click()]);
  expect(download.suggestedFilename()).toMatch(/^siosia-.*\.ics$/);
  const ics = readFileSync((await download.path())!, "utf-8");
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("SUMMARY:Childcare with Siosia");
  expect(ics).toContain("TRIGGER:-PT1440M");
  expect(item.getByTestId("cal-note")).toContainText("don't update by themselves");
});

test("client, provider and driver: request → accept with a ride there → the driver takes it → both see him; cancel cascades", async ({ context }) => {
  await isolate(context);
  const ewa = await context.newPage();
  await onboard(ewa, "Ewa");
  await offer(ewa, "childcare");

  const toria = await context.newPage();
  await onboard(toria, "Toria");
  await requestService(toria, "childcare");
  await expect(toria.getByTestId("appt-chip")).toHaveText("Waiting for an answer from Ewa");

  const driver = await context.newPage();
  await goOnlineAsDriver(driver, "Adam", "WX 4242");

  // Ewa answers from Planned → To answer, with a ride there from where she is.
  await ewa.getByTestId("start-planned").click();
  const ask = ewa.getByTestId("to-answer");
  await expect(ask).toContainText("To answer (1)", { timeout: 8000 });
  await ask.getByTestId("answer-accept").click();
  await ewa.getByTestId("need-ride-there").check();
  await context.setGeolocation({ latitude: 52.2496, longitude: 20.9538 });
  await ewa.getByTestId("ride-there-pickup-here").click();
  await expect(ewa.getByTestId("ride-there-dropoff-value")).not.toHaveText("—");
  await expect(ewa.getByTestId("accept-confirm")).toBeEnabled();
  await ewa.getByTestId("accept-confirm").click();
  await expect(ewa.getByTestId("appt-status")).toHaveText("Confirmed");
  await expect(toria.getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 8000 });
  await expect(toria.getByTestId("ride-line")).toHaveText("Ride there: no driver yet");

  // The driver takes it as a plain booking.
  await driver.getByTestId("open-bookings").click();
  const open = driver.getByTestId("open-booking");
  await expect(open).toContainText("Ewa", { timeout: 8000 });
  await open.getByTestId("take-booking").click();
  await expect(driver.getByTestId("my-booking")).toContainText("Ewa");
  await expect(toria.getByTestId("ride-line")).toHaveText("Ride there: Adam ✓", { timeout: 8000 });
  await expect(ewa.getByTestId("appt-rides")).toContainText("Ride there: Adam ✓");

  // The client cancels: Ewa is told, her ride is cancelled, the driver's booking is gone.
  await toria.getByTestId("open-appointment").click();
  await toria.getByTestId("appt-cancel").click();
  await toria.getByTestId("cancel-one").click();
  await expect(toria.getByTestId("appt-status")).toHaveText("Cancelled");
  await expect(ewa.getByTestId("push-toast")).toContainText("cancel", { ignoreCase: true, timeout: 8000 });
  await expect(driver.getByTestId("my-booking")).toHaveCount(0, { timeout: 35_000 });
});

test("a weekly series: one request, three dates on both sides; All remaining cancels the rest (US17)", async ({ context }) => {
  await isolate(context);
  const ewa = await context.newPage();
  await onboard(ewa, "Ewa");
  await offer(ewa, "childcare");
  const toria = await context.newPage();
  await onboard(toria, "Toria");
  await requestService(toria, "childcare", { times: 3 });
  await expect(toria.getByTestId("planned-appointment")).toHaveCount(3);
  await expect(toria.getByTestId("series-marker").first()).toHaveText("↻ every week · 1/3");

  await ewa.getByTestId("start-planned").click();
  await expect(ewa.getByTestId("to-answer")).toContainText("To answer (3)", { timeout: 8000 });
  await ewa.getByTestId("answer-accept").first().click();
  await ewa.getByTestId("accept-confirm").click();
  await expect(ewa.getByTestId("appt-status")).toHaveText("Confirmed");
  await ewa.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await expect(ewa.getByTestId("planned-appointment")).toHaveCount(3);
  await expect(toria.getByTestId("appt-chip")).toHaveText(["Confirmed", "Confirmed", "Confirmed"], { timeout: 8000 });

  // The second date: This one leaves the others; All remaining (every future date, FR-109) ends the rest.
  await toria.getByTestId("open-appointment").nth(1).click();
  await expect(toria.getByTestId("appt-series")).toContainText("2/3 · 3 left");
  await toria.getByTestId("appt-cancel").click();
  await toria.getByTestId("cancel-one").click();
  await expect(toria.getByTestId("appt-status")).toHaveText("Cancelled");
  await toria.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await expect(toria.getByTestId("planned-appointment")).toHaveCount(2);
  await expect(ewa.getByTestId("planned-appointment")).toHaveCount(2, { timeout: 8000 });
  await toria.getByTestId("open-appointment").first().click();
  await toria.getByTestId("appt-cancel").click();
  await expect(toria.getByTestId("cancel-series")).toHaveText("All remaining (2)");
  await toria.getByTestId("cancel-series").click();
  await expect(toria.getByTestId("appt-status")).toHaveText("Cancelled");
  await toria.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await expect(toria.getByTestId("planned-empty")).toBeVisible();
  await expect(ewa.getByTestId("planned-empty")).toBeVisible({ timeout: 8000 });
});

test("opening rules: S1 by default, ?open=planned and ?open=history once, an online driver back on D1 (FR-082, FR-084)", async ({ context }) => {
  await isolate(context);
  const page = await context.newPage();
  await onboard(page, "Toria");
  await page.goto("/?launch=0&robots=0&siosia=0&open=planned");
  await expect(page.getByTestId("planned")).toBeVisible();
  expect(new URL(page.url()).searchParams.has("open")).toBe(false);
  await page.getByTestId("page-back").click();
  await expect(page.getByTestId("start-planned")).toBeVisible();
  await page.goto("/?launch=0&robots=0&siosia=0&open=history");
  await expect(page.getByTestId("history")).toBeVisible();
  await page.reload(); // the link opened it once; a reload is back on S1
  await expect(page.getByTestId("start-siosia")).toBeVisible();

  const driver = await context.newPage();
  await goOnlineAsDriver(driver, "Adam", "WX 1");
  await driver.reload();
  await expect(driver.getByTestId("driver-state")).toHaveText("Online"); // online: reopens on D1
  await driver.getByTestId("back-home").click();
  await expect(driver.getByRole("alertdialog")).toContainText("offline"); // leaving D1 online asks first
});

// ---------- 2.1: open requests and the car colour ----------

async function longPressMap(page: Page, dx: number, dy: number) {
  const box = (await page.locator(".map").boundingBox())!;
  // Leaflet turns a right-click / long-press into "contextmenu" → sets the dropoff (FR-011).
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + 120 + dy, { button: "right" });
}

test("an open request: nobody offers Learning → Anyone who can → Ewa sees it and takes it → Toria's is confirmed with Ewa (FR-160–164)", async ({
  context
}) => {
  await isolate(context);
  const ewa = await context.newPage();
  await onboard(ewa, "Ewa");
  await expect(ewa.getByTestId("badge-open")).toHaveCount(0);

  const toria = await context.newPage();
  await onboard(toria, "Toria");
  await toria.getByTestId("start-siosia").click();
  await expect(toria.getByTestId("nobody-learning")).toHaveText("Nobody offers this yet — ask anyway: everyone in the group sees it");
  await toria.getByTestId("catalog-learning").click();
  await expect(toria.getByTestId("request-form")).toBeVisible();
  await expect(toria.getByRole("radio", { name: "Anyone who can" })).toBeChecked(); // nobody offers it: preselected
  await expect(toria.getByTestId("request-open-note")).toContainText("Everyone in the group sees this request");
  // The place by address search — inside the request form, this used to submit the whole page (B7).
  await toria.getByTestId("request-place-search").click();
  await toria.getByTestId("request-place-query").fill("Husarska 16, Lipków");
  await toria.getByTestId("request-place-go").click();
  await expect(toria.getByTestId("request-form")).toBeVisible(); // still here: nothing was submitted
  await toria.getByTestId("request-place-here").click(); // the geocoder is blocked in e2e: Here gives the pin
  await expect(toria.getByTestId("request-place-value")).not.toHaveText("—");
  await toria.getByTestId("request-send").click();
  await expect(toria.getByTestId("planned")).toBeVisible();
  const mine = toria.getByTestId("planned-appointment");
  await expect(mine.getByTestId("appt-chip")).toHaveText("Waiting for someone to take it");
  await expect(mine).toContainText("Open to anyone");

  // Ewa, on S1 all along: the badge, then Planned → You could help → I can do it.
  await expect(ewa.getByTestId("badge-open")).toHaveText("1 you could help with", { timeout: 8000 });
  await ewa.getByTestId("start-planned").click();
  const could = ewa.getByTestId("open-requests");
  await expect(could).toContainText("You could help (1)");
  await expect(could).toContainText("Learning");
  await expect(could).toContainText("Toria asks");
  await could.getByTestId("take-request").click();
  await expect(ewa.getByTestId("take-sheet")).toBeVisible();
  await ewa.getByTestId("take-confirm").click();
  await expect(ewa.getByTestId("appt-status")).toHaveText("Confirmed");
  await expect(ewa.getByTestId("appt-party")).toContainText("For Toria");
  await ewa.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await expect(ewa.getByTestId("open-requests")).toHaveCount(0); // taken: no longer open
  await expect(ewa.getByTestId("planned-appointment")).toContainText("For Toria");

  // Toria is told as for an accept, and her item names Ewa.
  await expect(mine.getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 8000 });
  await expect(mine).toContainText("With Ewa");
  await expect(toria.getByTestId("push-toast")).toContainText("Ewa", { timeout: 8000 });
});

test("the car icon picks the car's colour: the Roman link → plate → Red → his icon and car are red, for riders too (FR-170)", async ({ context }) => {
  await isolate(context);
  const roman = await context.newPage();
  await roman.goto("/?launch=0&robots=0&siosia=0#master=demo-roman");
  await roman.bringToFront(); // GPS for going online
  await expect(roman.getByTestId("link-toast")).toHaveText("This phone now uses the shared profile Roman.");
  await roman.getByTestId("start-siosia").click();
  await roman.getByTestId("catalog-drive").click();
  await roman.getByLabel("Plate").fill("WX 5555");
  await roman.getByRole("button", { name: "Save" }).click();
  const chip = roman.getByTestId("master-chip");
  await expect(chip.getByRole("img", { name: "Green Taycan Cross Turismo" })).toBeVisible();
  await expect(chip.getByTestId("car-icon")).toHaveAccessibleName("Change car colour");

  await chip.getByTestId("car-icon").click();
  const sheet = roman.getByRole("dialog", { name: "Car colour" });
  await expect(sheet.getByTestId("paint-red")).toHaveText("Red");
  await sheet.getByTestId("paint-red").click();
  await expect(sheet).toHaveCount(0);
  const icon = chip.getByRole("img", { name: "Red Taycan Cross Turismo" });
  await expect(icon.locator('[data-part="body"]')).toHaveAttribute("fill", "#c62828");
  await expect(roman.getByTestId("vehicle-line")).toHaveText("Red Porsche Taycan Cross Turismo · WX 5555");

  // Saved with the car: after a reload S1's icon is red too, and so is the form's colour.
  await roman.reload();
  await expect(roman.getByTestId("car-icon").locator('[data-part="body"]')).toHaveAttribute("fill", "#c62828");
  await roman.getByTestId("start-siosia").click();
  await roman.getByTestId("catalog-drive").click();
  await expect(roman.getByTestId("vehicle-line")).toContainText("Red Porsche");
  await roman.bringToFront();
  await roman.getByTestId("toggle-online").click();
  await expect(roman.getByTestId("driver-state")).toHaveText("Online");

  const rider = await context.newPage();
  await onboard(rider, "Ola");
  await rider.getByTestId("start-siosia").click();
  await rider.getByTestId("catalog-ride").click();
  await longPressMap(rider, 100, 60);
  await rider.getByTestId("request-ride").click();
  await expect(roman.getByTestId("offer-card")).toBeVisible({ timeout: 5000 });
  await roman.getByTestId("accept-offer").click();
  const card = rider.getByTestId("driver-card");
  await expect(card).toContainText("Red Porsche Taycan Cross Turismo");
  await expect(card.getByRole("img", { name: "Red Taycan Cross Turismo" }).locator('[data-part="body"]')).toHaveAttribute("fill", "#c62828");
});

// ---------- 2.3: kids, photos, chat ----------

/** S2 → My kids → Add kid; returns the My kids section. */
async function addKid(page: Page, name: string, bornYear: number) {
  await page.getByRole("button", { name: "Profile" }).click();
  const kids = page.getByTestId("my-kids");
  await kids.getByTestId("kid-add").click();
  await kids.getByTestId("kid-name").fill(name);
  await kids.getByTestId("kid-born").selectOption(String(bornYear));
  await kids.getByTestId("kid-save").click();
  await expect(kids.getByTestId("kid-card-name")).toHaveText(name);
  return kids;
}

test("kids and chat: Toria adds Zosia and asks Ewa with her attached; Ewa sees Zosia; after accepting both chat live (FR-200–202, FR-220–224)", async ({
  context
}) => {
  await isolate(context);
  const ewa = await context.newPage();
  await onboard(ewa, "Ewa");
  await offer(ewa, "childcare");

  const toria = await context.newPage();
  await onboard(toria, "Toria");
  const age = 7;
  const kids = await addKid(toria, "Zosia", new Date().getFullYear() - age);
  await expect(kids).toContainText(`age ${age}`);
  await toria.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();

  // C2 with Zosia ticked.
  await toria.getByTestId("start-siosia").click();
  await toria.getByTestId("catalog-childcare").click();
  await expect(toria.getByTestId("request-form")).toBeVisible();
  await toria.getByTestId("request-place-here").click();
  await expect(toria.getByTestId("request-place-value")).not.toHaveText("—");
  const tick = toria.getByTestId("request-kids").getByRole("checkbox");
  await expect(tick).toHaveCount(1);
  await tick.check();
  await toria.getByTestId("request-send").click();
  await expect(toria.getByTestId("planned")).toBeVisible();
  const mine = toria.getByTestId("planned-appointment");
  await expect(mine.getByTestId("kids-line")).toHaveText("with Zosia");

  // Ewa: Zosia on her Planned item and in C3 (name, age); she accepts.
  await ewa.getByTestId("start-planned").click();
  const ask = ewa.getByTestId("to-answer");
  await expect(ask).toContainText("To answer (1)", { timeout: 8000 });
  await expect(ask.getByTestId("kids-line")).toHaveText("with Zosia");
  await ask.getByTestId("open-appointment").click();
  const cards = ewa.getByTestId("appt-kids");
  await expect(cards).toContainText("Zosia");
  await expect(cards).toContainText(`age ${age}`);
  await expect(ewa.getByTestId("appt-kids-change")).toHaveCount(0); // the client's kids, not hers to change
  await ewa.getByTestId("appt-accept").click();
  await ewa.getByTestId("accept-confirm").click();
  await expect(ewa.getByTestId("appt-status")).toHaveText("Confirmed");

  // Toria writes from her Planned item's chat.
  await expect(mine.getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 8000 });
  await mine.getByTestId("chat-open").click();
  await expect(toria.getByTestId("chat-other")).toContainText("Ewa");
  await toria.getByTestId("chat-input").fill("Hi!");
  await toria.getByTestId("chat-send").click();
  await expect(toria.getByTestId("chat-msg-mine")).toContainText("Hi!");
  await expect(toria.getByTestId("chat-read")).toHaveCount(0); // not read yet

  // Ewa, still on C3 (over Planned, whose item badges too): the badge shows 1; she opens the thread, reads, replies.
  const c3 = ewa.getByTestId("appointment");
  await expect(c3.getByTestId("chat-unread")).toHaveText("1", { timeout: 8000 });
  await c3.getByTestId("chat-open").click();
  await expect(ewa.getByTestId("chat-msg-theirs")).toContainText("Hi!");
  await ewa.getByTestId("chat-input").fill("See you tomorrow");
  await ewa.getByTestId("chat-send").click();
  await expect(ewa.getByTestId("chat-msg-mine")).toContainText("See you tomorrow");

  // Toria sees the reply live, and that her Hi! was read.
  await expect(toria.getByTestId("chat-msg-theirs")).toContainText("See you tomorrow", { timeout: 8000 });
  await expect(toria.getByTestId("chat-read")).toBeVisible({ timeout: 8000 });
  await expect(toria.getByTestId("chat-unread")).toHaveCount(0); // read while open: no badge
});

test("a kid's photo: picked, resized in the browser, shown on the card (FR-210)", async ({ context }) => {
  await isolate(context);
  const page = await context.newPage();
  await onboard(page, "Toria");
  const kids = await addKid(page, "Kuba", new Date().getFullYear() - 4);
  await expect(kids.locator("img.avatar-photo")).toHaveCount(0);
  // A 1×1 PNG; the app turns it into a small JPEG before storing it (the demo keeps a data URL).
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await kids.locator('input[type="file"]').setInputFiles({ name: "kuba.png", mimeType: "image/png", buffer: png });
  const photo = kids.locator("img.avatar-photo");
  await expect(photo).toHaveCount(1, { timeout: 8000 });
  expect(await photo.getAttribute("src")).toMatch(/^(data:image\/jpeg|https?:|blob:)/);
  await expect(kids.getByRole("button", { name: "Remove photo" })).toBeVisible();
});

/** A datetime-local value in the page's local time (the request form's start). */
const localInput = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

test("session updates and heading home: Toria's note, Siosia's answer, a photo, the notice and its answer (FR-230–241)", async ({ context }) => {
  await isolate(context);
  const page = await context.newPage();
  // The page's clock is ours to move: the feed opens 30 min before the start (V54).
  await page.clock.install({ time: Date.now() });
  await onboard(page, "Toria", "?robots=0");
  await addKid(page, "Zosia", new Date().getFullYear() - 7);
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await page.getByTestId("start-siosia").click();
  await expect(page.getByTestId("catalog-childcare")).toContainText("Siosia", { timeout: 8000 });
  await page.getByTestId("catalog-childcare").click();
  await expect(page.getByTestId("request-form")).toBeVisible();
  // The next quarter hour at least 31 min ahead (the form's 15-minute steps and the 30-min lead).
  await page.getByTestId("request-start").fill(localInput(Math.ceil((Date.now() + 31 * 60_000) / 900_000) * 900_000));
  await page.getByTestId("request-kids").getByRole("checkbox").check();
  await page.getByTestId("request-place-here").click();
  await expect(page.getByTestId("request-place-value")).not.toHaveText("—");
  await page.getByTestId("request-send").click();
  const item = page.getByTestId("planned-appointment");
  await expect(item.getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 8000 }); // the robot accepts
  await expect(item.getByTestId("kids-line")).toHaveText("with Zosia");
  // Not open yet (the start is 31–46 min away); 17 minutes later it is (30 min before the start).
  await item.getByTestId("open-appointment").click();
  await expect(page.getByTestId("appt-status")).toHaveText("Confirmed");
  await expect(page.getByTestId("feed")).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await page.clock.fastForward(17 * 60_000);
  await item.getByTestId("open-appointment").click();
  const feed = page.getByTestId("feed");
  await expect(feed).toBeVisible({ timeout: 8000 });
  await expect(feed.getByTestId("feed-empty")).toBeVisible();
  // The parent's note about Zosia (the second chip; the first is Everyone); Siosia answers a few
  // seconds later, and the demo shows her notification.
  await feed.locator('[data-testid^="feed-about-"]').nth(1).click();
  await feed.getByTestId("feed-input").fill("Zosia has a nut allergy — snacks are in the blue box");
  await feed.getByTestId("feed-send").click();
  const mine = feed.getByTestId("feed-item-mine");
  await expect(mine).toHaveCount(1);
  await expect(mine.getByTestId("feed-kid")).toHaveText("Zosia");
  await expect(mine.getByTestId("feed-author")).toHaveText("You");
  const theirs = feed.getByTestId("feed-item-theirs");
  await expect(theirs).toHaveCount(1, { timeout: 10_000 });
  await expect(theirs.first().getByTestId("feed-text")).toHaveText("All good here 🙂 — playing outside");
  // The feed is in front: her update lands live and brings no notification (V55).
  await expect(page.getByTestId("push-toast")).toHaveCount(0);
  // A photo from the gallery: resized in the browser, shown in the feed.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await feed.getByTestId("feed-file").setInputFiles({ name: "park.png", mimeType: "image/png", buffer: png });
  await expect(feed.getByTestId("feed-preview")).toBeVisible({ timeout: 8000 });
  await feed.getByTestId("feed-send").click();
  await expect(mine).toHaveCount(2);
  await expect(feed.getByTestId("feed-photo")).toHaveCount(1);
  expect(await feed.getByTestId("feed-photo").locator("img").getAttribute("src")).toMatch(/^data:image\/jpeg/);
  // Heading home: no location in this browser → the minutes are picked; Siosia sees the notice and answers once.
  await page.getByTestId("coming-open").click();
  await expect(page.getByTestId("coming-sheet")).toBeVisible();
  await page.getByTestId("coming-pick").selectOption("30");
  await page.getByTestId("coming-send").click();
  await expect(page.getByTestId("coming-line")).toContainText(/You told Siosia at \d\d:\d\d: about 30 min\./, { timeout: 8000 });
  await expect(theirs).toHaveCount(2, { timeout: 10_000 });
  await expect(theirs.nth(1).getByTestId("feed-text")).toHaveText("Great, see you soon 🙂");
  // P1 carries the count.
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await expect(item.getByTestId("feed-count")).toHaveText("4 updates", { timeout: 8000 });
});
