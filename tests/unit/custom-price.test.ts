// Siosia 2.12.2 server rules in the engine (the SQL twin is tests/unit/sql-custom-price.test.ts — same
// cases, V19): a YOLO event without a price of its own takes the Childcare price (its base), and the
// client may set a custom payment per occurrence instead of the rate — no contract reprices it.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig } from "../../src/core/engine";
import { ServerError, type AppointmentView, type ContractRate, type Place, type RepeatInput } from "../../src/core/types";

const MIN = 60_000;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
// The price list has a Childcare rate (50 an hour); Learning and the YOLO events have none of their own.
const SERVICES = DEFAULT_SERVICES.map((e) => (e.id === "childcare" ? { ...e, price: { perHour: 50 } } : e));
const CFG: EngineConfig = { ...DEFAULT_CONFIG, services: SERVICES, inviteCode: "PILOT" };

let db: DbState;
let now: number;
const at = <T>(fn: (e: Engine) => T): T => fn(new Engine(db, CFG, now));
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof ServerError ? e.code : String(e);
  }
};
const pub = (uid: string) => at((e) => e.getProfile(uid))!.publicId!;
function user(uid: string, nick: string) {
  at((e) => e.join(uid, "pilot", `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
}
function request(uid: string, provider: string | null, startMin: number, o: { service?: string; duration?: number; repeat?: RepeatInput; custom?: number | null } = {}): AppointmentView {
  return at((e) =>
    e.requestService(uid, {
      serviceId: o.service ?? "yolo_halloween",
      providerId: provider === null ? null : pub(provider),
      startsAt: now + startMin * MIN,
      durationMin: o.duration ?? 180,
      place: HOME,
      note: "",
      repeat: o.repeat,
      ...(o.custom !== undefined ? { customPrice: o.custom } : {})
    })
  );
}
const contract = (rates: ContractRate[]) => {
  const c = at((e) => e.proposeContract("dad", { to: pub("nanny"), as: "family", rates, note: "" }));
  at((e) => e.answerContract("nanny", c.id, "accept"));
  return c;
};
const getAppt = (uid: string, id: string) => at((e) => e.getAppointment(uid, id));

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 20, 10, 0); // Tue 20 Oct 2026, 12:00 in Warsaw
  user("dad", "Roman");
  user("nanny", "Toria");
  user("other", "Ewa");
  at((e) => e.setOffers("nanny", ["learning", "childcare"]));
});

describe("the price of a YOLO event and a custom payment (2.12.2)", () => {
  it("a YOLO event takes the Childcare price; a contract's Childcare rate before it", () => {
    expect(request("dad", "nanny", 26 * 60)).toMatchObject({ price: 150, rate: 50, contractId: null, customPrice: false });
    expect(request("dad", null, 27 * 60, { duration: 120 })).toMatchObject({ price: 100, rate: 50, customPrice: false });
    expect(request("dad", "nanny", 30 * 60, { service: "learning", duration: 60 })).toMatchObject({ price: null, rate: null });
    const c = contract([{ serviceId: "childcare", perHour: 40 }]);
    expect(request("dad", "nanny", 50 * 60)).toMatchObject({ price: 120, rate: 40, contractId: c.id });
  });

  it("prices a YOLO event at Childcare's list price only while Childcare is enabled (the form shows the same)", () => {
    const off: EngineConfig = { ...CFG, services: SERVICES.map((e) => (e.id === "childcare" ? { ...e, enabled: false } : e)) };
    const input = { serviceId: "yolo_halloween", providerId: pub("nanny"), startsAt: now + 26 * 60 * MIN, durationMin: 180, place: HOME, note: "" };
    expect(new Engine(db, off, now).requestService("dad", input)).toMatchObject({ price: null, rate: null, customPrice: false });
    expect(request("dad", "nanny", 30 * 60)).toMatchObject({ price: 150, rate: 50 });
  });

  it("a custom payment replaces the rate, for every occurrence; it is checked", () => {
    for (const bad of [0, 0.99, 10000.01, Number.NaN, Number.POSITIVE_INFINITY]) expect(code(() => request("dad", "nanny", 26 * 60, { custom: bad })), String(bad)).toBe("bad_input");
    expect(request("dad", "nanny", 26 * 60, { custom: 199.999 })).toMatchObject({ price: 200, rate: null, contractId: null, customPrice: true });
    expect(request("dad", "nanny", 27 * 60, { custom: null })).toMatchObject({ price: 150, customPrice: false });
    const s = request("dad", "nanny", 50 * 60, { service: "learning", duration: 60, custom: 35, repeat: { every: 1, count: 3 } });
    expect(Object.values(db.appointments!).filter((x) => x.seriesId === s.series!.id).map((x) => x.price)).toEqual([35, 35, 35]);
    expect(s.customPrice).toBe(true);
  });

  it("no contract reprices a custom payment: not on taking, not on becoming active, not when applied to the past", () => {
    const mine = request("dad", "nanny", 26 * 60, { custom: 200 });
    const unpriced = request("dad", "nanny", 30 * 60, { service: "learning", duration: 60 });
    const open = request("dad", null, 74 * 60, { duration: 120, custom: 90 });
    const c = contract([
      { serviceId: "childcare", perHour: 40 },
      { serviceId: "learning", perHour: 30 }
    ]);
    // Becoming active priced the one without a price, not the custom one.
    expect(getAppt("dad", mine.id)).toMatchObject({ price: 200, rate: null, contractId: null, customPrice: true });
    expect(getAppt("dad", unpriced.id)).toMatchObject({ price: 30, rate: 30, contractId: c.id });
    // A custom payment with a contract in place stays custom.
    expect(request("dad", "nanny", 100 * 60, { custom: 55 })).toMatchObject({ price: 55, rate: null, contractId: null });
    // Taken by the contract's provider: still the custom payment.
    expect(at((e) => e.takeRequest("nanny", open.id))).toMatchObject({ price: 90, rate: null, contractId: null, customPrice: true });
    // Done: the cost is the custom payment, whatever the time; applying the contract to the past skips it.
    at((e) => e.answerAppointment("nanny", mine.id, "accept"));
    now = mine.endsAt;
    at((e) => e.sweep());
    at((e) => e.setActualTime("nanny", mine.id, 240));
    expect(getAppt("dad", mine.id).cost).toMatchObject({ minutes: 240, rate: null, total: 200, source: "custom", corrected: true });
    expect(at((e) => e.applyContractToPast("dad", c.id, "2026-10-21"))).toEqual({ count: 0 });
    expect(getAppt("dad", mine.id)).toMatchObject({ price: 200, contractId: null });
  });
});
