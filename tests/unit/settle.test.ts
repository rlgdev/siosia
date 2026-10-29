// Siosia 2.11 in the engine (the SQL twin is tests/unit/sql-settle.test.ts — same cases, V19):
// what is due between two sides on the weekly report, a reminder to pay, dobry Pancio and a
// comment on it (FR-321–325, V78–V80).

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent } from "../../src/core/engine";
import { destination } from "../../src/core/geo";
import { ServerError, type AppointmentView, type LatLng, type Place, type RideView } from "../../src/core/types";
import { pushText, pushUrl } from "../../supabase/functions/_shared/push-text";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const PICKUP = { lat: 52.2297, lng: 21.0122, label: "Centrum" };
const DROPOFF = { ...destination(PICKUP, 60, 3), label: "Praga" };
const CFG: EngineConfig = { ...DEFAULT_CONFIG, services: DEFAULT_SERVICES, inviteCode: "PILOT" };

let db: DbState;
let now: number;
let pushes: PushEvent[];
const at = <T>(fn: (e: Engine) => T): T => {
  const e = new Engine(db, CFG, now);
  const out = fn(e);
  pushes.push(...e.effects.push);
  return out;
};
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof ServerError ? e.code : String(e);
  }
};
const pub = (uid: string) => at((e) => e.getProfile(uid))!.publicId!;
const sent = () => pushes.map((p) => `${p.kind}>${p.userId}`).sort();
const report = (uid: string, week: string | null = null) => at((e) => e.report(uid, week, "family"));

function user(uid: string, nick: string, vehicle = false) {
  at((e) => e.join(uid, "pilot", `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
  if (vehicle) at((e) => e.saveVehicle(uid, { make: "Toyota", model: "Yaris", colour: "Red", plate: `wx ${uid}`, seats: 4 }));
}
/** An accepted appointment (3 h, starting in 26 h), then the clock at its end (the sweep marks it done). */
function done(client: string, provider: string): AppointmentView {
  const a = at((e) =>
    e.requestService(client, { serviceId: "childcare", providerId: pub(provider), startsAt: now + 26 * 60 * MIN, durationMin: 180, place: HOME, note: "" })
  );
  at((e) => e.answerAppointment(provider, a.id, "accept"));
  now = a.endsAt;
  at((e) => e.sweep());
  return a;
}
/** The nanny's ride with dad at the wheel, from request to completed. */
function ride(): RideView {
  const r = at((e) => e.requestRide("nanny", { pickup: PICKUP, dropoff: DROPOFF, estKm: 3.42, estMin: 8.6, fareIsEstimate: false }));
  const near: LatLng = destination(PICKUP, 0, 1);
  at((e) => e.setOnline("dad", true));
  const offer = at((e) => e.heartbeat("dad", near)).offer!;
  at((e) => e.decideOffer("dad", offer.id, "accept"));
  for (const to of ["arrived", "in_progress", "completed"] as const) at((e) => e.advance("dad", r.id, to, 3));
  at((e) => e.setOnline("dad", false));
  return at((e) => e.getRide("nanny", r.id));
}

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 20, 10, 0); // Tue 20 Oct 2026, 12:00 in Warsaw
  pushes = [];
  user("dad", "Roman", true);
  user("mum", "Anna");
  user("nanny", "Toria");
  user("other", "Ewa");
  at((e) => e.setOffers("nanny", ["childcare"]));
  at((e) => e.inviteToFamily("dad", pub("mum")));
  at((e) => e.answerInvite("mum", e.family("mum").incoming[0].id, "join"));
  const k = at((e) => e.proposeContract("dad", { to: pub("nanny"), as: "family", rates: [{ serviceId: "childcare", perHour: 40 }], note: "" }));
  at((e) => e.answerContract("nanny", k.id, "accept"));
  pushes = [];
});

describe("settling up between two sides (FR-321–325, V78–V80)", () => {
  it("counts both ways per side; a reminder; dobry Pancio zeroes it; the other side comments once", () => {
    const a1 = done("dad", "nanny"); // Wed: 120
    const a2 = done("mum", "nanny"); // Thu: 120, the other parent
    at((e) => e.tipAppointment("mum", a2.id, 10));
    const r1 = ride(); // the nanny owes the family its fare
    const r2 = ride();
    at((e) => e.markPaid("nanny", r2.id)); // marked paid on the receipt: not due
    const fare = r1.fare;
    expect(fare).toBeGreaterThan(0);
    const net = Math.round((250 - fare) * 100) / 100;

    const toria = report("nanny");
    expect(toria.due).toEqual([
      {
        party: expect.any(String),
        who: "Roman, Anna",
        theyOwe: { services: 250, rides: 0 },
        weOwe: { services: 0, rides: fare },
        net,
        count: 3,
        since: a1.startsAt,
        remindedAt: null
      }
    ]);
    expect([pub("dad"), pub("mum")]).toContain(toria.due[0].party);
    const family = report("dad");
    expect(family.due).toEqual([
      { party: pub("nanny"), who: "Toria", theyOwe: { services: 0, rides: fare }, weOwe: { services: 250, rides: 0 }, net: -net, count: 3, since: a1.startsAt, remindedAt: null }
    ]);
    expect(report("mum").due).toEqual(family.due); // one side: the family
    expect(report("other").due).toEqual([]);
    // The week's lines say how much of them is still to pay.
    expect(family.spent.services).toEqual([expect.objectContaining({ who: "Toria", total: 240, due: 240 })]);
    expect(family.earned.rides).toEqual({ count: 2, total: Math.round((fare + r2.fare) * 100) / 100, due: fare });

    // A reminder: only to a side that owes us; once per 12 hours; both of the family hear it.
    pushes = [];
    expect(code(() => at((e) => e.remindPayment("dad", pub("nanny"))))).toBe("illegal_transition");
    expect(code(() => at((e) => e.remindPayment("nanny", "nobody")))).toBe("not_found");
    expect(code(() => at((e) => e.remindPayment("dad", pub("mum"))))).toBe("forbidden");
    expect(at((e) => e.remindPayment("nanny", toria.due[0].party))).toEqual({ net });
    expect(sent()).toEqual(["pay_remind>dad", "pay_remind>mum"]);
    expect(pushes[0].params).toMatchObject({ sender: "Toria", total: net, since: "2026-10-21" });
    expect(pushText("pay_remind", pushes[0].params, "pl", "Europe/Warsaw").title).toBe("Toria prosi o rozliczenie");
    expect(pushUrl("pay_remind")).toBe("./?open=report");
    expect(code(() => at((e) => e.remindPayment("nanny", pub("mum"))))).toBe("rate_limited");
    expect(report("nanny").due[0].remindedAt).toBe(now);
    expect(report("dad").due[0].remindedAt).toBeNull();

    // dobry Pancio from the family: everything between the two sides is paid, both ways.
    pushes = [];
    expect(code(() => at((e) => e.settleUp("other", pub("nanny"))))).toBe("illegal_transition"); // nothing between them
    expect(code(() => at((e) => e.settleUp("mum", pub("dad"))))).toBe("forbidden");
    now += MIN;
    expect(at((e) => e.settleUp("mum", pub("nanny")))).toEqual({ count: 3, net: -net });
    expect(sent()).toEqual(["pay_settled>nanny"]);
    expect(pushes[0].params).toMatchObject({ sender: "Anna", total: net, count: 3, status: "paid" });
    expect(pushText("pay_settled", pushes[0].params, "en", "Europe/Warsaw").body).toBe(`${net.toFixed(2)} PLN to you is marked paid — you’re square. Tap to add a comment.`);
    expect(report("nanny").due).toEqual([]);
    expect(report("dad").due).toEqual([]);
    expect(report("dad").spent.services[0]).toMatchObject({ total: 240, due: 0 });
    expect(report("dad").earned.rides.due).toBe(0);
    expect(db.appointments![a1.id]).toMatchObject({ settledAt: now, settlementId: expect.any(String) });
    expect(db.rides[r1.id].settledAt).toBe(now);
    expect(db.rides[r2.id].settledAt).toBeUndefined();
    expect(code(() => at((e) => e.settleUp("mum", pub("nanny"))))).toBe("illegal_transition");

    // Both sides see it; the side that got it may comment, once.
    const theirs = report("nanny").settlements;
    expect(theirs).toEqual([
      { id: expect.any(String), at: now, by: "Anna", mine: false, who: "Roman, Anna", direction: "in", amount: net, count: 3, comment: null, canComment: true }
    ]);
    expect(report("dad").settlements).toEqual([expect.objectContaining({ by: "Anna", mine: true, who: "Toria", direction: "out", amount: net, canComment: false })]);
    const id = theirs[0].id;
    expect(code(() => at((e) => e.commentSettlement("dad", id, "ok")))).toBe("not_found");
    expect(code(() => at((e) => e.commentSettlement("nanny", id, "   ")))).toBe("bad_input");
    expect(code(() => at((e) => e.commentSettlement("nanny", id, "x".repeat(281))))).toBe("bad_input");
    pushes = [];
    expect(at((e) => e.commentSettlement("nanny", id, "  Dzięki, doszło!  "))).toMatchObject({ comment: { text: "Dzięki, doszło!", by: "Toria", at: now }, canComment: false });
    expect(sent()).toEqual(["pay_comment>dad", "pay_comment>mum"]);
    expect(pushText("pay_comment", pushes[0].params, "en", "Europe/Warsaw")).toMatchObject({ title: "Toria answered your dobry Pancio", body: "Dzięki, doszło!" });
    expect(code(() => at((e) => e.commentSettlement("nanny", id, "again")))).toBe("illegal_transition");
    expect(report("mum").settlements[0].comment).toEqual({ text: "Dzięki, doszło!", by: "Toria", at: now });

    // What comes after is due again; the nanny settles this time (she got paid); 30 days to comment.
    const a3 = done("dad", "nanny");
    expect(report("nanny").due).toEqual([expect.objectContaining({ theyOwe: { services: 120, rides: 0 }, weOwe: { services: 0, rides: 0 }, net: 120, count: 1, since: a3.startsAt })]);
    pushes = [];
    expect(at((e) => e.settleUp("nanny", pub("dad")))).toEqual({ count: 1, net: 120 });
    expect(sent()).toEqual(["pay_settled>dad", "pay_settled>mum"]);
    expect(pushText("pay_settled", pushes[0].params, "pl", "Europe/Warsaw").body).toBe("Twoja wpłata 120,00 PLN odnotowana — jesteście kwita. Stuknij, aby dodać komentarz.");
    const later = report("dad").settlements[0];
    expect(later).toMatchObject({ by: "Toria", mine: false, direction: "out", amount: 120, canComment: true });
    now += 30 * DAY;
    expect(report("dad").settlements[0].canComment).toBe(false);
    expect(code(() => at((e) => e.commentSettlement("dad", later.id, "late")))).toBe("window_closed");
    now += 61 * DAY; // listed for 90 days
    expect(report("dad").settlements).toEqual([]);
  });
});
