// The launch overlay (2.4, V52) on the real build: plays once over the boot and leaves on its own,
// the app is usable right after; a tap ends it early; every other spec opens with ?launch=0.

import { expect, test } from "@playwright/test";

test("the launch plays over the boot and leaves on its own; a tap skips it", async ({ page }) => {
  await page.goto("/?robots=0&siosia=0");
  const launch = page.getByTestId("launch");
  await expect(launch).toBeVisible();
  await expect(launch).toBeHidden({ timeout: 5000 });
  await expect(page.getByLabel("Nickname")).toBeVisible();
  await expect(page.getByLabel("Nickname")).toBeEditable();

  // A new page load plays it again; a tap takes it out at once.
  await page.goto("/?robots=0&siosia=0");
  await expect(launch).toBeVisible();
  await launch.dispatchEvent("pointerdown");
  await expect(launch).toHaveAttribute("data-stage", "out");
  await expect(launch).toBeHidden({ timeout: 2000 });

  // ?launch=0: none at all.
  await page.goto("/?launch=0&robots=0&siosia=0");
  await expect(page.getByLabel("Nickname")).toBeVisible();
  await expect(launch).toHaveCount(0);
});
