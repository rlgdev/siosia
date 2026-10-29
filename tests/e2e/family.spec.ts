import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Siosia 2.6 on the mock backend: Roman invites Anna into his family (she joins from the S1
// notice), proposes a contract to the robot Siosia (she accepts), asks for childcare at the
// contract rate; Anna sees his appointment as family; once it is over the summary shows what it
// cost and the weekly report sums it — for Roman, and for the family on Anna's side.

async function isolate(context: BrowserContext) {
  await context.route(/router\.project-osrm\.org|nominatim\.openstreetmap\.org|tile\.openstreetmap\.org/, (r) => r.abort());
}

async function onboard(page: Page, nick: string, query: string) {
  await page.goto(`/${query}&launch=0`);
  await page.getByLabel("Nickname").fill(nick);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${nick}` })).toBeVisible();
}

const back = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).first().click();

/** A datetime-local value in the page's local time (the request form's start). */
const localInput = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

test("family and contracts: invite → join; a contract with Siosia; childcare at its rate; the summary and the weekly report (FR-250–282)", async ({ context }) => {
  await isolate(context);
  const anna = await context.newPage();
  await onboard(anna, "Anna", "?robots=0&siosia=0");
  const roman = await context.newPage();
  await roman.clock.install({ time: Date.now() });
  await onboard(roman, "Roman", "?robots=0"); // the robot Siosia runs in Roman's tab

  // Roman invites Anna.
  await roman.getByRole("button", { name: "Profile" }).click();
  await roman.getByTestId("profile-family").click();
  await roman.getByTestId("family-invite").click();
  await roman.getByTestId("family-pick").selectOption({ label: "Anna" });
  await roman.getByTestId("family-send").click();
  await expect(roman.getByTestId("family-invited")).toContainText("Invited: Anna");

  // Anna: the S1 notice, and the bell (2.9) — its news opens the Family panel → Join.
  await expect(anna.getByTestId("home-family")).toContainText("1 waiting for your answer", { timeout: 10_000 });
  await expect(anna.getByTestId("bell-badge")).toHaveText("1");
  await anna.getByTestId("bell").click();
  await expect(anna.getByTestId("bell-item")).toContainText("Roman invites you to their family");
  await anna.getByTestId("bell-item").click();
  await expect(anna.getByTestId("bell-badge")).toHaveCount(0);
  await expect(anna.getByTestId("family-incoming")).toContainText("Roman invites you to their family");
  await anna.getByTestId("family-join").click();
  await expect(anna.getByTestId("family-members")).toContainText("Roman");
  await expect(anna.getByTestId("family-members")).toContainText("Anna");
  await expect(roman.getByTestId("family-members")).toContainText("Anna", { timeout: 10_000 });

  // A contract with Siosia: childcare at 40 an hour; she accepts in a moment.
  await roman.getByTestId("contract-new").click();
  await roman.getByTestId("contract-to").selectOption({ label: "Siosia" });
  await roman.getByTestId("contract-pick-childcare").check();
  await roman.getByTestId("contract-rate-childcare").fill("40");
  await roman.getByTestId("contract-send").click();
  const active = roman.getByTestId("contract-active");
  await expect(active).toBeVisible({ timeout: 10_000 });
  await expect(active.getByTestId("contract-rate")).toContainText("40.00");
  await back(roman);
  await back(roman);

  // Childcare at the contract rate: 3 h × 40 = 120.
  await roman.getByTestId("start-siosia").click();
  await roman.getByTestId("catalog-childcare").click();
  await expect(roman.getByTestId("request-form")).toBeVisible();
  await expect(roman.getByTestId("request-contract")).toContainText("Contract rate with Siosia");
  await expect(roman.getByTestId("request-price")).toContainText("120.00");
  const start = Math.ceil((Date.now() + 31 * 60_000) / 900_000) * 900_000;
  await roman.getByTestId("request-start").fill(localInput(start));
  await roman.getByTestId("request-place-here").click();
  await expect(roman.getByTestId("request-place-value")).not.toHaveText("—");
  await roman.getByTestId("request-send").click();
  const item = roman.getByTestId("planned-appointment");
  await expect(item.getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 10_000 });

  // Anna sees it as family: whose it is, read-only.
  await back(anna);
  await anna.getByTestId("start-planned").click();
  const hers = anna.getByTestId("planned-appointment");
  await expect(hers).toContainText("Roman with Siosia", { timeout: 10_000 });
  await hers.getByTestId("open-appointment").click();
  await expect(anna.getByTestId("appt-family")).toContainText("Roman's appointment");
  await expect(anna.getByTestId("appt-cancel")).toHaveCount(0);
  await back(anna);

  // Three hours later it is over: the summary on C3, and its notification.
  await roman.clock.fastForward(start + 3 * 3600_000 + 60_000 - Date.now());
  await roman.getByTestId("page-back").click();
  await roman.getByTestId("start-history").click();
  const row = roman.getByTestId("history-appointment");
  await expect(row.getByTestId("history-cost")).toContainText("120.00", { timeout: 10_000 });
  await row.locator(".planned-open").click();
  const cost = roman.getByTestId("appt-cost");
  await expect(cost.getByTestId("cost-time")).toHaveText("3 h");
  await expect(cost.getByTestId("cost-rate")).toContainText("contract rate");
  await expect(cost.getByTestId("cost-total")).toContainText("120.00");
  // 2.9: a tip at the end — 20 on top.
  const tip = roman.getByTestId("appt-tip");
  await tip.getByTestId("tip-chip").nth(1).click();
  await tip.getByTestId("tip-send").click();
  await expect(tip.getByTestId("tip-given")).toContainText("20.00", { timeout: 10_000 });
  await back(roman);

  // The weekly report: spent 120 with Siosia and a 20 tip.
  await roman.getByTestId("history-report").click();
  await expect(roman.getByTestId("report-spent")).toContainText("140.00", { timeout: 10_000 });
  await expect(roman.getByTestId("report-tips")).toContainText("20.00");
  await expect(roman.getByTestId("report-spent-lines").getByTestId("report-line")).toContainText("Siosia");

  // Anna's family report sums it, one line per member.
  await anna.getByTestId("page-back").click();
  await anna.getByTestId("start-history").click();
  await anna.getByTestId("history-report").click();
  await anna.getByTestId("report-family").click();
  await expect(anna.getByTestId("report-spent")).toContainText("140.00", { timeout: 10_000 });
  await expect(anna.getByTestId("report-members")).toContainText("Roman");
});

test("2.10: an active contract applied to a past appointment from a chosen day (FR-319)", async ({ context }) => {
  await isolate(context);
  const roman = await context.newPage();
  await roman.clock.install({ time: Date.now() });
  await onboard(roman, "Roman", "?robots=0"); // the robot Siosia runs in Roman's tab

  // Childcare with Siosia before any contract: the price list has no price for it.
  await roman.getByTestId("start-siosia").click();
  await roman.getByTestId("catalog-childcare").click();
  const start = Math.ceil((Date.now() + 31 * 60_000) / 900_000) * 900_000;
  await roman.getByTestId("request-start").fill(localInput(start));
  await roman.getByTestId("request-place-here").click();
  await expect(roman.getByTestId("request-place-value")).not.toHaveText("—");
  await roman.getByTestId("request-send").click();
  await expect(roman.getByTestId("planned-appointment").getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 10_000 });

  // FR-320: on a small iPhone the notifications list stays on the screen, also under a page header.
  const size = roman.viewportSize()!;
  await roman.setViewportSize({ width: 320, height: 568 });
  await roman.getByTestId("bell").click();
  const box = (await roman.getByTestId("bell-list").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(320 - 8);
  await roman.keyboard.press("Escape");
  await roman.setViewportSize(size);

  // A day later it is long over; then a contract with Siosia: childcare at 40 an hour.
  await roman.clock.fastForward(start + 24 * 3600_000 - Date.now());
  await roman.getByTestId("page-back").click();
  await roman.getByTestId("home-profile").click();
  await roman.getByTestId("profile-family").click();
  await roman.getByTestId("contract-new").click();
  await roman.getByTestId("contract-to").selectOption({ label: "Siosia" });
  await roman.getByTestId("contract-pick-childcare").check();
  await roman.getByTestId("contract-rate-childcare").fill("40");
  await roman.getByTestId("contract-send").click();
  const active = roman.getByTestId("contract-active");
  await expect(active).toBeVisible({ timeout: 10_000 });

  // Apply it from the appointment's day: 3 h × 40 = 120.
  await active.getByTestId("contract-past").click();
  const d = new Date(start);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await active.getByTestId("contract-past-from").fill(day);
  await active.getByTestId("contract-past-apply").click();
  await expect(active.getByTestId("contract-past-result")).toHaveText("Applied to 1 past appointment(s).");
  await active.getByTestId("contract-past-apply").click();
  await expect(active.getByTestId("contract-past-result")).toHaveText("Nothing to change since then.");
  await back(roman);
  await back(roman);
  await roman.getByTestId("start-history").click();
  await expect(roman.getByTestId("history-appointment").getByTestId("history-cost")).toContainText("120.00", { timeout: 10_000 });
});

test("2.11: what is due on the weekly report; dobry Pancio after a confirmation settles it (FR-321–323)", async ({ context }) => {
  await isolate(context);
  const roman = await context.newPage();
  await roman.clock.install({ time: Date.now() });
  await onboard(roman, "Roman", "?robots=0"); // the robot Siosia runs in Roman's tab

  // A contract with Siosia (childcare at 40 an hour), then 3 h of childcare.
  await roman.getByTestId("home-profile").click();
  await roman.getByTestId("profile-family").click();
  await roman.getByTestId("contract-new").click();
  await roman.getByTestId("contract-to").selectOption({ label: "Siosia" });
  await roman.getByTestId("contract-pick-childcare").check();
  await roman.getByTestId("contract-rate-childcare").fill("40");
  await roman.getByTestId("contract-send").click();
  await expect(roman.getByTestId("contract-active")).toBeVisible({ timeout: 10_000 });
  await back(roman);
  await back(roman);
  await roman.getByTestId("start-siosia").click();
  await roman.getByTestId("catalog-childcare").click();
  const start = Math.ceil((Date.now() + 31 * 60_000) / 900_000) * 900_000;
  await roman.getByTestId("request-start").fill(localInput(start));
  await roman.getByTestId("request-place-here").click();
  await expect(roman.getByTestId("request-place-value")).not.toHaveText("—");
  await roman.getByTestId("request-send").click();
  await expect(roman.getByTestId("planned-appointment").getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 10_000 });

  // Once it is over, the weekly report of its week: 120 to pay to Siosia, also on the week's line.
  await roman.clock.fastForward(start + 4 * 3600_000 - Date.now());
  await roman.getByTestId("page-back").click();
  await roman.getByTestId("start-history").click();
  await roman.getByTestId("history-report").click();
  const due = roman.getByTestId("due");
  await expect(due.getByTestId("due-line")).toHaveCount(1, { timeout: 10_000 });
  await expect(due.getByTestId("due-line")).toContainText("Siosia");
  await expect(due.getByTestId("due-net")).toHaveText("You owe PLN 120.00");
  await expect(due.getByTestId("due-remind")).toHaveCount(0); // we owe: nothing to ask for
  await expect(roman.getByTestId("report-due").first()).toContainText("120.00");

  // dobry Pancio asks first; "No" changes nothing.
  await due.getByTestId("due-settle").click();
  const ask = roman.getByRole("alertdialog");
  await expect(ask).toContainText("Mark PLN 120.00");
  await expect(ask).toContainText("as paid");
  await ask.getByRole("button", { name: "No" }).click();
  await expect(due.getByTestId("due-line")).toHaveCount(1);
  await due.getByTestId("due-settle").click();
  await roman.getByRole("alertdialog").getByRole("button", { name: "dobry Pancio" }).click();
  await expect(due.getByTestId("due-note")).toHaveText("Settled. Siosia got a notification.");
  await expect(due.getByTestId("due-none")).toBeVisible();
  await expect(roman.getByTestId("report-due")).toHaveCount(0);
  const done = due.getByTestId("settlement");
  await expect(done).toContainText("To Siosia: PLN 120.00");
  await expect(done).toContainText("dobry Pancio from Roman");
  await expect(done.getByTestId("settlement-comment-input")).toHaveCount(0); // the side that pressed it does not comment
});
