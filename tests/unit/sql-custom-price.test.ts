// @vitest-environment node
// Siosia 2.12.2 backend rules against the REAL SQL migration in PGlite: a YOLO event without a price of
// its own takes the Childcare price (its base), and the client may set a custom payment per
// occurrence instead of the rate — no contract reprices it. Same cases as the engine tests
// (tests/unit/custom-price.test.ts) — the twin rule (V19) — plus the migration's backfill.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, localDate } from "../../src/core/time";
import { createHarness, errorOf, MIGRATION, type Json, type SqlHarness } from "./sql-harness";

const U = {
  dad: "00000000-0000-4000-8000-000000000601",
  nanny: "00000000-0000-4000-8000-000000000602",
  other: "00000000-0000-4000-8000-000000000603"
};
type Who = keyof typeof U;
const NAMES: Record<Who, string> = { dad: "Roman", nanny: "Toria", other: "Ewa" };
const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const MIN = 60_000;
const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args);
const code = (p: Promise<unknown>) => errorOf(p);

function request(who: Who, provider: Who | null, startMin: number, o: { service?: string; duration?: number; repeat?: unknown; custom?: number | null } = {}) {
  const args: unknown[] = [o.service ?? "yolo_halloween", provider === null ? null : pub[provider], at(startMin), o.duration ?? 180, HOME, "", o.repeat ?? null];
  if (o.custom !== undefined) args.push(null, o.custom);
  return call(who, "siosia_request_service", args);
}
const contract = async (rates: unknown) => {
  const c = await call<Json>("dad", "siosia_propose_contract", [pub.nanny, "family", JSON.stringify(rates), ""]);
  await call("nanny", "siosia_answer_contract", [c.id, "accept"]);
  return c;
};
const getAppt = (who: Who, id: unknown) => call<Json>(who, "siosia_get_appointment", [id]);

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  for (const k of Object.keys(U) as Who[]) {
    await h.onboard(U[k], NAMES[k]);
    pub[k] = String((await call<Json>(k, "siosia_get_profile")).publicId);
  }
  await call("nanny", "siosia_set_offers", [["learning", "childcare"]]);
  // The price list has a Childcare rate (50 an hour); Learning and the YOLO events have none of their own.
  await h.admin(`update public.app_config set services = (
    select jsonb_agg(case when e ->> 'id' = 'childcare' then jsonb_set(e, '{price}', '{"perHour": 50}') else e end order by o)
      from jsonb_array_elements(services) with ordinality x(e, o)) where id = 1`);
}, 60_000);

beforeEach(async () => {
  await h.db.exec("delete from public.appointments; delete from public.appointment_series; delete from public.push_outbox; delete from public.contracts;");
});

describe("the price of a YOLO event and a custom payment (2.12.2)", () => {
  it("a YOLO event takes the Childcare price; a contract's Childcare rate before it", async () => {
    expect(await request("dad", "nanny", 26 * 60)).toMatchObject({ price: 150, rate: 50, contractId: null, customPrice: false });
    expect(await request("dad", null, 27 * 60, { duration: 120 })).toMatchObject({ price: 100, rate: 50, customPrice: false });
    expect(await request("dad", "nanny", 30 * 60, { service: "learning", duration: 60 })).toMatchObject({ price: null, rate: null });
    const c = await contract([{ serviceId: "childcare", perHour: 40 }]);
    expect(await request("dad", "nanny", 50 * 60)).toMatchObject({ price: 120, rate: 40, contractId: c.id });
  });

  it("a custom payment replaces the rate, for every occurrence; it is checked", async () => {
    for (const bad of [0, 0.99, 10000.01]) expect(await code(request("dad", "nanny", 26 * 60, { custom: bad })), String(bad)).toBe("bad_input");
    expect(await request("dad", "nanny", 26 * 60, { custom: 199.999 })).toMatchObject({ price: 200, rate: null, contractId: null, customPrice: true });
    expect(await request("dad", "nanny", 27 * 60, { custom: null })).toMatchObject({ price: 150, customPrice: false });
    const s = await request("dad", "nanny", 50 * 60, { service: "learning", duration: 60, custom: 35, repeat: { every: 1, count: 3 } });
    const prices = (await h.admin("select price from public.appointments where series_id = $1 order by seq", [(s.series as Json).id])).rows.map((r) => Number(r.price));
    expect(prices).toEqual([35, 35, 35]);
    expect(s.customPrice).toBe(true);
  });

  it("no contract reprices a custom payment: not on taking, not on becoming active, not when applied to the past", async () => {
    const mine = await request("dad", "nanny", 26 * 60, { custom: 200 });
    const unpriced = await request("dad", "nanny", 30 * 60, { service: "learning", duration: 60 });
    const open = await request("dad", null, 74 * 60, { duration: 120, custom: 90 });
    const c = await contract([
      { serviceId: "childcare", perHour: 40 },
      { serviceId: "learning", perHour: 30 }
    ]);
    expect(await getAppt("dad", mine.id)).toMatchObject({ price: 200, rate: null, contractId: null, customPrice: true });
    expect(await getAppt("dad", unpriced.id)).toMatchObject({ price: 30, rate: 30, contractId: c.id });
    expect(await request("dad", "nanny", 100 * 60, { custom: 55 })).toMatchObject({ price: 55, rate: null, contractId: null });
    expect(await call<Json>("nanny", "siosia_take_request", [open.id])).toMatchObject({ price: 90, rate: null, contractId: null, customPrice: true });
    await call("nanny", "siosia_answer_appointment", [mine.id, "accept"]);
    await h.admin("update public.appointments set starts_at = now() - make_interval(mins => duration_min + 5) where id = $1", [mine.id]);
    await h.admin("select public.siosia_sweep()");
    await call("nanny", "siosia_set_actual", [mine.id, 240]);
    expect((await getAppt("dad", mine.id)).cost).toMatchObject({ minutes: 240, rate: null, total: 200, source: "custom", corrected: true });
    const from = addDays(localDate(Date.now(), "Europe/Warsaw"), -1);
    expect(await call("dad", "siosia_contract_apply_past", [c.id, from])).toEqual({ count: 0 });
    expect(await getAppt("dad", mine.id)).toMatchObject({ price: 200, contractId: null });
  });

  it("re-running the migration prices the coming appointments still without a price, never a custom payment", async () => {
    const a = await request("dad", "nanny", 26 * 60);
    const b = await request("dad", "nanny", 30 * 60, { custom: 70 });
    await h.admin("update public.appointments set price = null, rate = null where id = $1", [a.id]);
    await h.db.exec(MIGRATION);
    expect(await getAppt("dad", a.id)).toMatchObject({ price: 150, rate: 50, customPrice: false });
    expect(await getAppt("dad", b.id)).toMatchObject({ price: 70, rate: null, customPrice: true });
  });
});
