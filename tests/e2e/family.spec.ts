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
