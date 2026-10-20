import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Siosia 2.0 on the mock backend (spec §13 "End-to-end"): the robot Siosia loop in one tab; client,
// provider and driver in three pages (request → accept with a ride there → the driver takes it →
// both see the driver; cancel cascades); a weekly series → All remaining; Add to calendar; the
// opening rules and ?open=. Map services are blocked: routes fall back to the straight line and
// "Here" gives the browser's (mocked) position without an address.

async function isolate(context: BrowserContext) {
  await context.route(/router\.project-osrm\.org|nominatim\.openstreetmap\.org|tile\.openstreetmap\.org/, (r) => r.abort());
}

/** Onboards a user; `query` picks robots: the robot Siosia is on unless siosia=0. */
async function onboard(page: Page, nick: string, query = "?robots=0&siosia=0") {
  await page.goto(`/${query}`);
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
  await page.goto("/?robots=0&siosia=0&open=planned");
  await expect(page.getByTestId("planned")).toBeVisible();
  expect(new URL(page.url()).searchParams.has("open")).toBe(false);
  await page.getByTestId("page-back").click();
  await expect(page.getByTestId("start-planned")).toBeVisible();
  await page.goto("/?robots=0&siosia=0&open=history");
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
