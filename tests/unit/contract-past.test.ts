// Siosia 2.10 in the engine (the SQL twin is tests/unit/sql-contract-past.test.ts — same cases,
// V19): an active contract applied to past appointments from a chosen date (FR-319, V76).

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent } from "../../src/core/engine";
import { ServerError, type AppointmentView, type Place } from "../../src/core/types";
import { pushText } from "../../supabase/functions/_shared/push-text";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
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
function user(uid: string, nick: string) {
  at((e) => e.join(uid, "pilot", `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
}
/** An accepted appointment starting `startMin` from now (3 h). */
function accepted(client: string, provider: string, startMin: number, service = "childcare"): AppointmentView {
  const a = at((e) =>
    e.requestService(client, { serviceId: service, providerId: pub(provider), startsAt: now + startMin * MIN, durationMin: 180, place: HOME, note: "" })
  );
  at((e) => e.answerAppointment(provider, a.id, "accept"));
  return a;
}
const appt = (uid: string, id: string) => at((e) => e.getAppointment(uid, id));
const apply = (uid: string, id: string, from: string) => at((e) => e.applyContractToPast(uid, id, from));

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 20, 10, 0); // Tue 20 Oct 2026, 12:00 in Warsaw
  pushes = [];
  user("dad", "Roman");
  user("mum", "Anna");
  user("nanny", "Toria");
  user("other", "Ewa");
  at((e) => e.setOffers("nanny", ["learning", "childcare"]));
  at((e) => e.inviteToFamily("dad", pub("mum")));
  at((e) => e.answerInvite("mum", e.family("mum").incoming[0].id, "join"));
});

describe("an active contract applied to past appointments (FR-319, V76)", () => {
  it("prices the done appointments since the date; the other side hears how many; the report follows", () => {
    const wed = accepted("dad", "nanny", 26 * 60); // Wed 21 Oct 14:00
    const thu = accepted("mum", "nanny", 50 * 60); // Thu 22 Oct 14:00, the other parent
    const lesson = accepted("dad", "nanny", 74 * 60, "learning"); // Fri: the contract has no Learning rate
    const later = accepted("dad", "nanny", 8 * 24 * 60); // next week: not past yet
    now += 4 * DAY; // Sat 24 Oct
    at((e) => e.sweep());
    expect(appt("dad", wed.id).cost).toMatchObject({ rate: null, total: null });
    const k = at((e) => e.proposeContract("dad", { to: pub("nanny"), as: "family", rates: [{ serviceId: "childcare", perHour: 40 }], note: "" }));
    expect(code(() => apply("dad", k.id, "2026-10-21"))).toBe("illegal_transition"); // not accepted yet
    at((e) => e.answerContract("nanny", k.id, "accept"));
    expect(code(() => apply("other", k.id, "2026-10-21"))).toBe("not_found");
    for (const bad of ["2026-13-01", "x", "2026-10-25", "2025-10-23", "2026-02-30"]) expect(code(() => apply("dad", k.id, bad)), bad).toBe("bad_input");
    pushes = [];
    expect(apply("dad", k.id, "2026-10-22")).toEqual({ count: 1 });
    expect(appt("dad", thu.id)).toMatchObject({ rate: 40, contractId: k.id, price: 120, cost: { rate: 40, total: 120, source: "contract" } });
    expect(appt("dad", wed.id).rate).toBeNull(); // before the date
    expect(sent()).toEqual(["contract_applied>nanny"]); // the other side only
    expect(pushes[0].params).toMatchObject({ sender: "Roman", count: 1, since: "2026-10-22" });
    expect(pushText("contract_applied", pushes[0].params, "en", "Europe/Warsaw").body).toBe("Since 22 Oct: 1 now at the contract's rates.");
    // From the day before: one more; the one already priced does not count again.
    pushes = [];
    expect(apply("nanny", k.id, "2026-10-21")).toEqual({ count: 1 });
    expect(appt("mum", wed.id).cost).toMatchObject({ total: 120, source: "contract" });
    expect(sent()).toEqual(["contract_applied>dad", "contract_applied>mum"]); // the provider applied: the family hears
    expect(appt("dad", lesson.id).rate).toBeNull(); // no Learning rate
    expect(appt("dad", later.id)).toMatchObject({ rate: 40, price: 120, contractId: k.id }); // 2.12.2: coming, unpriced — priced when the contract became active
    pushes = [];
    expect(apply("dad", k.id, "2026-10-20")).toEqual({ count: 0 });
    expect(pushes).toEqual([]);
    expect(at((e) => e.report("dad", "2026-10-19", "family")).spent.total).toBe(240);
  });
});
