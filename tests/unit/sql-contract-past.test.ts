// @vitest-environment node
// Siosia 2.10 against the REAL SQL migration in PGlite: an active contract applied to past
// appointments from a chosen date (FR-319, V76). Same cases as tests/unit/contract-past.test.ts (V19).

import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, errorOf, type Json, type SqlHarness } from "./sql-harness";

const U = {
  dad: "00000000-0000-4000-8000-000000000401",
  mum: "00000000-0000-4000-8000-000000000402",
  nanny: "00000000-0000-4000-8000-000000000403",
  other: "00000000-0000-4000-8000-000000000404"
};
type Who = keyof typeof U;
const NAMES: Record<Who, string> = { dad: "Roman", mum: "Anna", nanny: "Toria", other: "Ewa" };
const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const MIN = 60_000;
const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args);
const name = (uid: unknown) => (Object.keys(U) as Who[]).find((k) => U[k] === uid) ?? String(uid);
const outbox = async () => ((await h.admin("select kind, user_id, params from public.push_outbox order by id")).rows as Json[]).map((r) => ({ ...r, kind: String(r.kind), params: r.params as Json, who: name(r.user_id) }));
const sent = async () => (await outbox()).map((r) => `${r.kind}>${r.who}`).sort();
const appt = (who: Who, id: unknown) => call<Json>(who, "siosia_get_appointment", [id]);
const apply = (who: Who, id: unknown, from: string) => call<Json>(who, "siosia_contract_apply_past", [id, from]);
/** A local day ("YYYY-MM-DD", Warsaw) by SQL: of a row's start, or today plus `days`. */
const day = async (sql: string, params: unknown[] = []) => String(((await h.admin(`select to_char((${sql})::date, 'YYYY-MM-DD') as d`, params)).rows[0] as Json).d);
const startDay = (id: unknown) => day("(select starts_at from public.appointments where id = $1) at time zone 'Europe/Warsaw'", [id]);
const today = (plus: number) => day(`(now() at time zone 'Europe/Warsaw')::date + ${plus}`);

/** An accepted appointment, then moved so that it started `daysAgo` days ago (3 h, so it is over). */
async function past(client: Who, daysAgo: number, service = "childcare") {
  const a = await call<Json>(client, "siosia_request_service", [service, pub.nanny, at(26 * 60), 180, HOME, "", null]);
  await call("nanny", "siosia_answer_appointment", [a.id, "accept"]);
  await h.admin("update public.appointments set starts_at = now() - make_interval(days => $2), requested_at = now() - interval '30 days' where id = $1", [a.id, daysAgo]);
  return a;
}

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  for (const k of Object.keys(U) as Who[]) {
    await h.onboard(U[k], NAMES[k]);
    pub[k] = String((await call<Json>(k, "siosia_get_profile")).publicId);
    await call(k, "siosia_save_push", [`https://web.push.apple.com/${k}`, "p".repeat(40), "a".repeat(16)]);
  }
  await call("nanny", "siosia_set_offers", [["learning", "childcare"]]);
  await call("dad", "siosia_family_invite", [pub.mum]);
  await call("mum", "siosia_family_answer", [((await call<Json>("mum", "siosia_family")).incoming as Json[])[0].id, "join"]);
}, 60_000);

describe("an active contract applied to past appointments (FR-319, V76)", () => {
  it("prices the done appointments since the date; the other side hears how many; the report follows", async () => {
    const older = await past("dad", 3);
    const newer = await past("mum", 1); // the other parent
    const lesson = await past("dad", 1, "learning"); // the contract has no Learning rate
    const later = await call<Json>("dad", "siosia_request_service", ["childcare", pub.nanny, at(8 * 24 * 60), 180, HOME, "", null]);
    await call("nanny", "siosia_answer_appointment", [later.id, "accept"]);
    await h.admin("select public.siosia_sweep()");
    expect((await appt("dad", older.id)).cost).toMatchObject({ rate: null, total: null });
    const k = await call<Json>("dad", "siosia_propose_contract", [pub.nanny, "family", JSON.stringify([{ serviceId: "childcare", perHour: 40 }]), ""]);
    const fromNewer = await startDay(newer.id);
    const fromOlder = await startDay(older.id);
    expect(await errorOf(apply("dad", k.id, fromNewer))).toBe("illegal_transition");
    await call("nanny", "siosia_answer_contract", [k.id, "accept"]);
    expect(await errorOf(apply("other", k.id, fromNewer))).toBe("not_found");
    for (const bad of ["2026-13-01", "x", await today(1), await today(-366), "2026-02-30"]) expect(await errorOf(apply("dad", k.id, bad)), bad).toBe("bad_input");
    await h.admin("delete from public.push_outbox");
    expect(await apply("dad", k.id, fromNewer)).toEqual({ count: 1 });
    expect(await appt("dad", newer.id)).toMatchObject({ rate: 40, contractId: k.id, price: 120, cost: { rate: 40, total: 120, source: "contract" } });
    expect((await appt("dad", older.id)).rate).toBeNull();
    expect(await sent()).toEqual(["contract_applied>nanny"]);
    expect((await outbox())[0].params).toMatchObject({ sender: "Roman", count: 1, since: fromNewer });
    await h.admin("delete from public.push_outbox");
    expect(await apply("nanny", k.id, fromOlder)).toEqual({ count: 1 });
    expect((await appt("mum", older.id)).cost).toMatchObject({ total: 120, source: "contract" });
    expect(await sent()).toEqual(["contract_applied>dad", "contract_applied>mum"]);
    expect((await appt("dad", lesson.id)).rate).toBeNull();
    expect(await appt("dad", later.id)).toMatchObject({ rate: 40, price: 120, contractId: k.id }); // 2.12.2: coming, unpriced — priced when the contract became active
    await h.admin("delete from public.push_outbox");
    expect(await apply("dad", k.id, fromOlder)).toEqual({ count: 0 });
    expect(await sent()).toEqual([]);
    // The weekly report of that week counts it at the contract's rate (the other one too when it is the same week).
    const spent = ((await call<Json>("dad", "siosia_report", [fromNewer, "family"])).spent as Json).total as number;
    expect(spent).toBe(fromOlder >= String((await call<Json>("dad", "siosia_report", [fromNewer, "family"])).week) ? 240 : 120);
  });
});
