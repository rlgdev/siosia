// Component tests of 2.11 (FR-321–324) on the weekly report: what is due per side, "Ask to pay",
// dobry Pancio behind a confirmation, and the comment on a dobry Pancio — EN and PL, fake backend.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import type { DueLine, Lang, Profile, SettlementView, WeeklyReport } from "../../src/core/types";
import { I18nProvider } from "../../src/i18n";
import { DueSection } from "../../src/screens/SettleUp";
import { AppStore, StoreContext } from "../../src/state/store";

const PROFILE = { userId: "u", nickname: "Toria", language: "en", publicId: "pub-toria", photo: null, icon: null, masterId: null, masterRole: null } as unknown as Profile;
const NOW = Date.now();
const LINE: DueLine = {
  party: "pub-roman",
  who: "Roman, Anna",
  theyOwe: { services: 250, rides: 0 },
  weOwe: { services: 0, rides: 18 },
  net: 232,
  count: 3,
  since: Date.UTC(2026, 9, 21, 12),
  remindedAt: null
};
const GOT: SettlementView = { id: "s1", at: NOW - 60_000, by: "Anna", mine: false, who: "Roman, Anna", direction: "in", amount: 232, count: 3, comment: null, canComment: true };
const side = { total: 0, services: [], servicesTotal: 0, rides: { count: 0, total: 0, due: 0 }, tips: 0 };
const report = (due: DueLine[], settlements: SettlementView[]): WeeklyReport => ({
  week: "2026-10-19",
  weekStart: 0,
  weekEnd: 0,
  scope: "me",
  hasFamily: false,
  currency: "PLN",
  spent: side,
  earned: side,
  net: 0,
  members: null,
  due,
  settlements
});

function setup(lang: Lang, ui: ReactNode, backend: Partial<Backend>) {
  const store = new AppStore();
  store.backend = backend as Backend;
  (store as unknown as { snap: object }).snap = {
    ...store.get(),
    phase: "ready",
    lang,
    profile: { ...PROFILE, language: lang },
    deployment: DEFAULT_CONFIG,
    cfg: { backend: "supabase" }
  };
  return render(
    <StoreContext.Provider value={store}>
      <I18nProvider lang={lang}>{ui}</I18nProvider>
    </StoreContext.Provider>
  );
}

describe("settling up on the weekly report (FR-321–324)", () => {
  it("shows both ways and the net; asks them to pay; dobry Pancio only after Yes", async () => {
    const remindPayment = vi.fn(async () => ({ net: 232 }));
    const settleUp = vi.fn(async () => ({ count: 3, net: 232 }));
    const onChanged = vi.fn();
    setup("en", <DueSection report={report([LINE], [])} onChanged={onChanged} />, { remindPayment, settleUp });
    const line = screen.getByTestId("due-line");
    expect(within(line).getByTestId("due-net")).toHaveTextContent("Owed to you PLN 232.00");
    expect(line).toHaveTextContent("Services — owed to you");
    expect(line).toHaveTextContent("Rides — you owe");
    expect(line).toHaveTextContent("3 unpaid");
    await userEvent.click(within(line).getByTestId("due-remind"));
    await waitFor(() => expect(remindPayment).toHaveBeenCalledWith("pub-roman"));
    expect(screen.getByTestId("due-note")).toHaveTextContent("Reminder sent to Roman, Anna.");
    expect(onChanged).toHaveBeenCalledTimes(1);

    await userEvent.click(within(line).getByTestId("due-settle"));
    const ask = screen.getByRole("alertdialog");
    expect(ask).toHaveTextContent("Mark PLN 232.00 from Roman, Anna as received?");
    await userEvent.click(within(ask).getByRole("button", { name: "No" }));
    expect(settleUp).not.toHaveBeenCalled();
    await userEvent.click(within(line).getByTestId("due-settle"));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "dobry Pancio" }));
    await waitFor(() => expect(settleUp).toHaveBeenCalledWith("pub-roman"));
    expect(screen.getByTestId("due-note")).toHaveTextContent("Settled. Roman, Anna got a notification.");
  });

  it("we owe: no reminder; a recent reminder is shown, not repeated", () => {
    setup("en", <DueSection report={report([{ ...LINE, net: -10, theyOwe: { services: 0, rides: 0 }, weOwe: { services: 10, rides: 0 } }], [])} onChanged={() => {}} />, {});
    expect(screen.getByTestId("due-net")).toHaveTextContent("You owe PLN 10.00");
    expect(screen.queryByTestId("due-remind")).toBeNull();
  });

  it("a reminder within 12 hours is disabled and says when", () => {
    setup("pl", <DueSection report={report([{ ...LINE, remindedAt: NOW - 3600_000 }], [])} onChanged={() => {}} />, {});
    const b = screen.getByTestId("due-remind");
    expect(b).toBeDisabled();
    expect(b).toHaveTextContent("Poproszono");
    expect(screen.getByTestId("due-net")).toHaveTextContent("Należne");
  });

  it("the side that got a dobry Pancio comments on it once; the comment shows", async () => {
    const commentSettlement = vi.fn(async () => ({ ...GOT, comment: { text: "Dzięki!", by: "Toria", at: NOW }, canComment: false }));
    const onChanged = vi.fn();
    setup("pl", <DueSection report={report([], [GOT])} onChanged={onChanged} />, { commentSettlement });
    expect(screen.getByTestId("due-none")).toHaveTextContent("Nic do rozliczenia.");
    const s = screen.getByTestId("settlement");
    expect(s).toHaveTextContent("Od: Roman, Anna — 232,00 zł");
    expect(s).toHaveTextContent("dobry Pancio od: Anna");
    expect(within(s).getByTestId("settlement-comment-send")).toBeDisabled();
    await userEvent.type(within(s).getByTestId("settlement-comment-input"), "Dzięki!");
    await userEvent.click(within(s).getByTestId("settlement-comment-send"));
    await waitFor(() => expect(commentSettlement).toHaveBeenCalledWith("s1", "Dzięki!"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("a comment already given shows, with no form", () => {
    setup("en", <DueSection report={report([], [{ ...GOT, mine: true, direction: "out", who: "Toria", by: "Roman", canComment: false, comment: { text: "Thanks!", by: "Toria", at: NOW } }])} onChanged={() => {}} />, {});
    expect(screen.getByTestId("settlement")).toHaveTextContent("To Toria: PLN 232.00");
    expect(screen.getByTestId("settlement-comment")).toHaveTextContent("Toria: “Thanks!”");
    expect(screen.queryByTestId("settlement-comment-input")).toBeNull();
  });

  it("nothing due and no settlements: no section", () => {
    setup("en", <DueSection report={report([], [])} onChanged={() => {}} />, {});
    expect(screen.queryByTestId("due")).toBeNull();
  });
});
