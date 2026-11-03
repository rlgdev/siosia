import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Siosia 2.14 on the mock backend (FR-334–339): proposing a change. Two people in two pages of one
// context: the client moves a confirmed appointment, the provider finds it under To answer and
// accepts, and both see the new times; then a length change of a session under way (the clock
// moved on in both pages), accepted from C3. Map services are blocked (straight-line routes).

async function isolate(context: BrowserContext) {
  await context.route(/router\.project-osrm\.org|nominatim\.openstreetmap\.org|tile\.openstreetmap\.org/, (r) => r.abort());
}

async function onboard(page: Page, nick: string, query = "?robots=0&siosia=0") {
  await page.goto(`/${query}${query.includes("?") ? "&" : "?"}launch=0`);
  await page.getByLabel("Nickname").fill(nick);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${nick}` })).toBeVisible();
}

async function offer(page: Page, entry: string) {
  await page.getByRole("button", { name: "Profile" }).click();
  await page.getByTestId(`offer-${entry}`).check();
  await expect(page.getByTestId(`offer-${entry}`)).toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
}

/** S1 → Siosia → childcare → C2 with "Here", optionally a start (datetime-local value), then Send. */
async function requestChildcare(page: Page, start?: string) {
  await page.getByTestId("start-siosia").click();
  await page.getByTestId("catalog-childcare").click();
  await expect(page.getByTestId("request-form")).toBeVisible();
  if (start) await page.getByTestId("request-start").fill(start);
  await page.getByTestId("request-place-here").click();
  await expect(page.getByTestId("request-place-value")).not.toHaveText("—");
  await page.getByTestId("request-send").click();
  await expect(page.getByTestId("planned")).toBeVisible();
}

/** The provider accepts from Planned → To answer, without rides. */
async function acceptRequest(page: Page) {
  await page.getByTestId("start-planned").click();
  const ask = page.getByTestId("to-answer");
  await expect(ask).toContainText("To answer (1)", { timeout: 8000 });
  await ask.getByTestId("answer-accept").click();
  await page.getByTestId("accept-confirm").click();
  await expect(page.getByTestId("appt-status")).toHaveText("Confirmed");
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).first().click();
}

/** In the page's own time zone: a datetime-local value moved by `min` minutes, and its "HH:MM" (en-GB). */
const shift = (page: Page, value: string, min: number) =>
  page.evaluate(
    ([v, m]) => {
      const d = new Date(new Date(v as string).getTime() + (m as number) * 60_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return {
        input: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`,
        hhmm: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(d)
      };
    },
    [value, min] as const
  );

test("a move: the client proposes, the provider accepts under To answer, both see the new time (FR-334, FR-337, FR-339)", async ({ context }) => {
  await isolate(context);
  const ewa = await context.newPage();
  await onboard(ewa, "Ewa");
  await offer(ewa, "childcare");

  const toria = await context.newPage();
  await onboard(toria, "Toria");
  await requestChildcare(toria);
  await acceptRequest(ewa);
  await expect(toria.getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 8000 });

  // Toria proposes an hour later.
  await toria.getByTestId("open-appointment").click();
  await toria.getByTestId("appt-change").click();
  const sheet = toria.getByTestId("change-sheet");
  await expect(sheet).toBeVisible();
  await expect(toria.getByTestId("change-send")).toBeDisabled();
  const old = await toria.getByTestId("change-start").inputValue();
  const later = await shift(toria, old, 60);
  const end = await shift(toria, old, 60 + 180);
  await toria.getByTestId("change-start").fill(later.input);
  await toria.getByTestId("change-note").fill("School ends later");
  await toria.getByTestId("change-send").click();
  const card = toria.getByTestId("change-card");
  await expect(card).toContainText("Your proposal — waiting for Ewa");
  await expect(toria.getByTestId("change-when")).toContainText(`${later.hhmm}–${end.hhmm}`);
  await expect(toria.getByTestId("appt-change")).toHaveCount(0);

  // Ewa: To answer lists it with its chip; she accepts there.
  const ask = ewa.getByTestId("to-answer");
  await expect(ask).toContainText("To answer (1)", { timeout: 8000 });
  await expect(ask.getByTestId("appt-change-chip")).toHaveText("Change proposed");
  await expect(ask.getByTestId("planned-change-when")).toContainText(`${later.hhmm}–${end.hhmm}`);
  await ask.getByTestId("planned-change-accept").click();
  await expect(ewa.getByTestId("to-answer")).toHaveCount(0, { timeout: 8000 });
  await expect(ewa.getByTestId("planned-appointment")).toContainText(`${later.hhmm}–${end.hhmm}`);

  // Toria: the card is gone and the appointment has the new time.
  await expect(toria.getByTestId("change-card")).toHaveCount(0, { timeout: 8000 });
  await expect(toria.getByTestId("appt-when")).toContainText(`${later.hhmm}–${end.hhmm}`);
});

test("a new length of a session under way: proposed by the provider, accepted by the client in C3 (FR-335, FR-337)", async ({ context }) => {
  await isolate(context);
  const ewa = await context.newPage();
  await ewa.clock.install({ time: Date.now() });
  await onboard(ewa, "Ewa");
  await offer(ewa, "childcare");

  const toria = await context.newPage();
  await toria.clock.install({ time: Date.now() });
  await onboard(toria, "Toria");
  const start = await toria.evaluate(() => {
    const d = new Date(Math.ceil((Date.now() + 31 * 60_000) / 900_000) * 900_000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  await requestChildcare(toria, start);
  await acceptRequest(ewa);
  await expect(toria.getByTestId("appt-chip")).toHaveText("Confirmed", { timeout: 8000 });

  // Half an hour into the session, in both pages.
  const ahead = (await toria.evaluate((s) => new Date(s).getTime() + 30 * 60_000 - Date.now(), start)) as number;
  await ewa.clock.fastForward(ahead);
  await toria.clock.fastForward(ahead);

  // Ewa proposes 4 h instead of 3 h.
  await ewa.getByTestId("planned-appointment").getByTestId("open-appointment").click();
  await expect(ewa.getByTestId("appt-when")).toContainText("Now until");
  await ewa.getByTestId("appt-change").click();
  await expect(ewa.getByTestId("change-sheet")).toContainText("Propose a new length");
  await ewa.getByTestId("change-minutes").selectOption("240");
  const end = await shift(ewa, start, 240);
  await expect(ewa.getByTestId("change-preview")).toContainText(`Ends ${end.hhmm}`);
  await ewa.getByTestId("change-send").click();
  await expect(ewa.getByTestId("change-card")).toContainText("Your proposal — waiting for Toria");

  // Toria accepts in C3; both see the new end.
  await toria.getByTestId("open-appointment").click();
  const card = toria.getByTestId("change-card");
  await expect(card).toContainText("Ewa proposes a change", { timeout: 8000 });
  await expect(toria.getByTestId("change-length")).toContainText("4 h");
  await toria.getByTestId("change-accept").click();
  await expect(toria.getByTestId("change-card")).toHaveCount(0);
  await expect(toria.getByTestId("appt-when")).toContainText(`Now until ${end.hhmm}`);
  await expect(ewa.getByTestId("change-card")).toHaveCount(0, { timeout: 8000 });
  await expect(ewa.getByTestId("appt-when")).toContainText(`Now until ${end.hhmm}`);
});
