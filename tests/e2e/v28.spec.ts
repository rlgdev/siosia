import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Siosia 2.8 on the mock backend: a contract with someone who offers no service (FR-300); an invite
// link made in the Family panel, shared, opened on a new phone — welcome, nickname, the family
// invitation (FR-301–302); a YOLO event booked at the contract's Childcare rate (FR-304–306).

async function isolate(context: BrowserContext) {
  await context.route(/router\.project-osrm\.org|nominatim\.openstreetmap\.org|tile\.openstreetmap\.org/, (r) => r.abort());
}

async function onboard(page: Page, nick: string, query = "?robots=0&siosia=0") {
  await page.goto(`/${query}&launch=0`);
  await page.getByLabel("Nickname").fill(nick);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${nick}` })).toBeVisible();
}

const back = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).first().click();

async function familyPanel(page: Page) {
  await page.getByRole("button", { name: "Profile" }).click();
  await page.getByTestId("profile-family").click();
}

test("a contract with someone who offers nothing; an invite link into Siosia and the family; YOLO at the contract rate (FR-300–306)", async ({ context }) => {
  await isolate(context);
  const ewa = await context.newPage();
  await onboard(ewa, "Ewa"); // offers nothing
  const roman = await context.newPage();
  // Capture the share sheet instead of opening the OS one.
  await roman.addInitScript(() => {
    (window as unknown as { shared: unknown[] }).shared = [];
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (d: unknown) => {
        (window as unknown as { shared: unknown[] }).shared.push(d);
      }
    });
  });
  await onboard(roman, "Roman");
  // 2.9: My profile is S1's 4th card, with a gear.
  await expect(roman.getByTestId("home-profile")).toContainText("My profile");
  await expect(roman.getByTestId("home-profile").locator("svg")).toHaveAttribute("data-icon", "gear");

  // Ewa is on the list although she offers nothing; Childcare at 30 an hour.
  await familyPanel(roman);
  await roman.getByTestId("contract-new").click();
  await roman.getByTestId("contract-to").selectOption({ label: "Ewa" });
  await roman.getByTestId("contract-pick-childcare").check();
  await roman.getByTestId("contract-rate-childcare").fill("30");
  await roman.getByTestId("contract-send").click();
  await expect(roman.getByTestId("contract-proposed")).toBeVisible();

  await expect(ewa.getByTestId("home-family")).toBeVisible({ timeout: 10_000 });
  await ewa.getByTestId("home-family").click();
  await ewa.getByTestId("contract-accept").click();
  await expect(ewa.getByTestId("contract-active")).toBeVisible();
  await expect(roman.getByTestId("contract-active")).toBeVisible({ timeout: 10_000 });

  // An invite link for someone new, through the share sheet.
  await roman.getByTestId("invite-new-create").click();
  const url = await roman.getByTestId("invite-new-url").inputValue();
  expect(url).toMatch(/#join=[A-Za-z0-9_-]{24}$/);
  const shared = (await roman.evaluate(() => (window as unknown as { shared: { url: string; text: string }[] }).shared))[0];
  expect(shared.url).toBe(url);
  expect(shared.text).toContain("Roman invites you to Siosia");
  await expect(roman.getByTestId("invite-new-note")).toContainText("Works once");

  // A new phone opens it: welcome, nickname, then Roman's family invitation on S1.
  const kasia = await context.newPage();
  await kasia.goto(`${url.replace(/#.*$/, "")}?robots=0&siosia=0&launch=0${url.slice(url.indexOf("#"))}`);
  await expect(kasia.getByTestId("link-toast")).toContainText("you came in by invitation");
  await kasia.getByLabel("Nickname").fill("Kasia");
  await kasia.getByRole("button", { name: "Continue" }).click();
  await expect(kasia.getByTestId("home-family")).toBeVisible({ timeout: 10_000 });
  await kasia.getByTestId("home-family").click();
  await expect(kasia.getByTestId("family-incoming")).toContainText("Roman invites you to their family");
  await kasia.getByTestId("family-join").click();
  await expect(kasia.getByTestId("family-members")).toContainText("Roman");
  // The link works once.
  const again = await context.newPage();
  await again.goto(`${url.replace(/#.*$/, "")}?robots=0&siosia=0&launch=0${url.slice(url.indexOf("#"))}`);
  await expect(again.getByTestId("link-toast")).toContainText("not valid any more");

  // YOLO: Ewa (contract) offers Halloween to Roman's family at the Childcare rate.
  await back(roman);
  await back(roman);
  await roman.getByTestId("start-siosia").click();
  // YOLO is the 4th card of the services; it opens the YOLO catalog.
  await expect(roman.locator('section:has([data-testid="catalog-ride"]) .entry-card strong')).toHaveText(["Ride", "Learning", "Childcare", "YOLO"]);
  await expect(roman.getByTestId("yolo-next")).toContainText("Next:");
  await roman.getByTestId("catalog-yolo").click();
  const yolo = roman.getByTestId("yolo-catalog");
  await expect(yolo.locator(".yolo-card")).toHaveCount(15);
  await expect(yolo.getByTestId("catalog-yolo_summer").locator("svg")).toHaveAttribute("data-icon", "parrot");
  await expect(yolo.getByTestId("catalog-yolo_halloween")).toContainText("Ewa");
  // The bloopers can be switched off (remembered on this phone) and on again.
  await expect(roman.getByTestId("yolo-sound")).toHaveAttribute("aria-pressed", "true");
  await roman.getByTestId("yolo-sound").click();
  await expect(roman.getByTestId("yolo-sound")).toHaveText("Sounds off");
  await roman.getByTestId("yolo-sound").click();
  await expect(roman.getByTestId("yolo-sound")).toHaveText("Sounds on");
  await yolo.getByTestId("catalog-yolo_halloween").click();
  await expect(roman.getByTestId("request-form")).toBeVisible();
  await expect(roman.getByTestId("request-contract")).toContainText("Contract rate with Ewa");
  await expect(roman.getByTestId("request-contract")).toContainText("Childcare rate of your contract");
  await expect(roman.getByTestId("request-price")).toContainText("90.00"); // 3 h × 30
});
