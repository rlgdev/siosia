// @vitest-environment node
// Siosia 2.11 against the REAL SQL migration in PGlite: what is due between two sides on the weekly
// report, a reminder to pay, dobry Pancio and a comment on it (FR-321–325, V78–V80). Same cases as
// tests/unit/settle.test.ts (V19).

import { beforeAll, describe, expect, it } from "vitest";
import { pushText } from "../../supabase/functions/_shared/push-text";
import { createHarness, errorOf, type Json, type SqlHarness } from "./sql-harness";

const U = {
  dad: "00000000-0000-4000-8000-000000000501",
  mum: "00000000-0000-4000-8000-000000000502",
  nanny: "00000000-0000-4000-8000-000000000503",
  other: "00000000-0000-4000-8000-000000000504",
  dad2: "00000000-0000-4000-8000-000000000505"
};
type Who = keyof typeof U;
const NAMES: Record<Who, string> = { dad: "Roman", mum: "Anna", nanny: "Toria", other: "Ewa", dad2: "Roman" };
const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const MIN = 60_000;
const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args);
const name = (uid: unknown) => (Object.keys(U) as Who[]).find((k) => U[k] === uid) ?? String(uid);
const outbox = async () =>
  ((await h.admin("select kind, user_id, params from public.push_outbox order by id")).rows as Json[]).map((r) => ({ ...r, kind: String(r.kind), params: r.params as Json, who: name(r.user_id) }));
const sent = async () => (await outbox()).map((r) => `${r.kind}>${r.who}`).sort();
const clearOutbox = () => h.admin("delete from public.push_outbox");
const report = (who: Who, week: string | null = null) => call<Json>(who, "siosia_report", [week, "family"]);
const due = async (who: Who) => (await report(who)).due as Json[];
const settlements = async (who: Who) => (await report(who)).settlements as Json[];
const ms = async (sql: string, params: unknown[] = []) => Number(((await h.admin(`select public.siosia_ms((${sql})) as t`, params)).rows[0] as Json).t);
const localDay = async (id: unknown) =>
  String(((await h.admin("select to_char((starts_at at time zone 'Europe/Warsaw')::date, 'YYYY-MM-DD') as d from public.appointments where id = $1", [id])).rows[0] as Json).d);

/** An accepted appointment (3 h) that ended `agoMin` minutes ago, marked done by the sweep. */
async function done(client: Who, agoMin: number): Promise<Json> {
  const a = await call<Json>(client, "siosia_request_service", ["childcare", pub.nanny, at(26 * 60), 180, HOME, "", null]);
  await call("nanny", "siosia_answer_appointment", [a.id, "accept"]);
  await h.admin("update public.appointments set starts_at = now() - make_interval(mins => duration_min + $2), requested_at = now() - interval '30 days' where id = $1", [
    a.id,
    agoMin
  ]);
  await h.admin("select public.siosia_sweep()");
  return a;
}
/** The nanny's ride with dad at the wheel (fare 18), completed `agoMin` minutes ago. */
async function ride(agoMin: number, paid = false): Promise<string> {
  const r = await h.admin(
    `insert into public.rides (rider_id, driver_id, status, pickup_lat, pickup_lng, pickup_label, dropoff_lat, dropoff_lng, dropoff_label,
                               est_km, est_min, fare, currency, accepted_at, started_at, ended_at, requested_at, paid)
     values ($1, $2, 'completed', 52.2297, 21.0122, 'Centrum', 52.2432, 21.0441, 'Praga', 3.4, 9, 18, 'PLN',
             now() - make_interval(mins => $3 + 20), now() - make_interval(mins => $3 + 10), now() - make_interval(mins => $3),
             now() - make_interval(mins => $3 + 30), $4)
     returning id`,
    [U.nanny, U.dad, agoMin, paid]
  );
  return String((r.rows[0] as Json).id);
}

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  for (const k of Object.keys(U) as Who[]) {
    await h.onboard(U[k], NAMES[k]);
    pub[k] = String((await call<Json>(k, "siosia_get_profile")).publicId);
    await call(k, "siosia_save_push", [`https://web.push.apple.com/${k}`, "p".repeat(40), "a".repeat(16)]);
  }
  await call("nanny", "siosia_set_offers", [["childcare"]]);
  await call("dad", "siosia_family_invite", [pub.mum]);
  await call("mum", "siosia_family_answer", [((await call<Json>("mum", "siosia_family")).incoming as Json[])[0].id, "join"]);
  const k = await call<Json>("dad", "siosia_propose_contract", [pub.nanny, "family", JSON.stringify([{ serviceId: "childcare", perHour: 40 }]), ""]);
  await call("nanny", "siosia_answer_contract", [k.id, "accept"]);
}, 60_000);

describe("settling up between two sides (FR-321–325, V78–V80)", () => {
  it("counts both ways per side; a reminder; dobry Pancio zeroes it; the other side comments once", async () => {
    const a1 = await done("dad", 300); // 120
    const a2 = await done("mum", 60); // 120, the other parent
    await call("mum", "siosia_tip_appointment", [a2.id, 10]);
    const r1 = await ride(30); // the nanny owes the family its fare
    const r2 = await ride(20, true); // marked paid on the receipt: not due
    const since = await ms("select starts_at from public.appointments where id = $1", [a1.id]);

    const toria = await due("nanny");
    expect(toria).toEqual([
      { party: expect.any(String), who: "Roman, Anna", theyOwe: { services: 250, rides: 0 }, weOwe: { services: 0, rides: 18 }, net: 232, count: 3, since, remindedAt: null }
    ]);
    expect([pub.dad, pub.mum]).toContain(toria[0].party);
    const family = await due("dad");
    expect(family).toEqual([
      { party: pub.nanny, who: "Toria", theyOwe: { services: 0, rides: 18 }, weOwe: { services: 250, rides: 0 }, net: -232, count: 3, since, remindedAt: null }
    ]);
    expect(await due("mum")).toEqual(family);
    expect(await due("other")).toEqual([]);
    // The week's lines say how much of them is still to pay (both appointments in a1's week here or not).
    const week = await report("dad", await localDay(a1.id));
    const line = ((week.spent as Json).services as Json[]).find((l) => l.who === "Toria")!;
    expect(line.due).toBe(line.total);
    expect(((week.earned as Json).rides as Json).due).toBeLessThanOrEqual(18);

    // A reminder: only to a side that owes us; once per 12 hours; both of the family hear it.
    await clearOutbox();
    expect(await errorOf(call("dad", "siosia_remind_payment", [pub.nanny]))).toBe("illegal_transition");
    expect(await errorOf(call("nanny", "siosia_remind_payment", ["nobody"]))).toBe("not_found");
    expect(await errorOf(call("dad", "siosia_remind_payment", [pub.mum]))).toBe("forbidden");
    expect(await call("nanny", "siosia_remind_payment", [toria[0].party])).toEqual({ net: 232 });
    expect(await sent()).toEqual(["pay_remind>dad", "pay_remind>mum"]);
    const remind = (await outbox())[0].params;
    expect(remind).toMatchObject({ sender: "Toria", total: 232, currency: "PLN", since: await localDay(a1.id) });
    expect(pushText("pay_remind", remind as never, "pl", "Europe/Warsaw").title).toBe("Toria prosi o rozliczenie");
    expect(await errorOf(call("nanny", "siosia_remind_payment", [pub.mum]))).toBe("rate_limited");
    expect((await due("nanny"))[0].remindedAt).toEqual(expect.any(Number));
    expect((await due("dad"))[0].remindedAt).toBeNull();

    // dobry Pancio from the family: everything between the two sides is paid, both ways.
    await clearOutbox();
    expect(await errorOf(call("other", "siosia_settle_up", [pub.nanny]))).toBe("illegal_transition");
    expect(await errorOf(call("mum", "siosia_settle_up", [pub.dad]))).toBe("forbidden");
    expect(await call("mum", "siosia_settle_up", [pub.nanny])).toEqual({ count: 3, net: -232 });
    expect(await sent()).toEqual(["pay_settled>nanny"]);
    const settled = (await outbox())[0].params;
    expect(settled).toMatchObject({ sender: "Anna", total: 232, count: 3, status: "paid" });
    expect(pushText("pay_settled", settled as never, "en", "Europe/Warsaw").body).toBe("232.00 PLN to you is marked paid — you’re square. Tap to add a comment.");
    expect(await due("nanny")).toEqual([]);
    expect(await due("dad")).toEqual([]);
    const after = await report("dad", await localDay(a1.id));
    expect(((after.spent as Json).services as Json[]).find((l) => l.who === "Toria")!.due).toBe(0);
    expect(((after.earned as Json).rides as Json).due).toBe(0);
    const rows = (await h.admin("select id, settled_at is not null as s, settlement_id from public.rides where id in ($1, $2) order by id = $1 desc", [r1, r2])).rows as Json[];
    expect(rows.map((r) => r.s)).toEqual([true, false]);
    expect(((await h.admin("select settled_at is not null as s from public.appointments where id = $1", [a1.id])).rows[0] as Json).s).toBe(true);
    expect(await errorOf(call("mum", "siosia_settle_up", [pub.nanny]))).toBe("illegal_transition");

    // Both sides see it; the side that got it may comment, once.
    const theirs = await settlements("nanny");
    expect(theirs).toEqual([
      { id: expect.any(String), at: expect.any(Number), by: "Anna", mine: false, who: "Roman, Anna", direction: "in", amount: 232, count: 3, comment: null, canComment: true }
    ]);
    expect(await settlements("dad")).toEqual([expect.objectContaining({ by: "Anna", mine: true, who: "Toria", direction: "out", amount: 232, canComment: false })]);
    const id = theirs[0].id;
    expect(await errorOf(call("dad", "siosia_comment_settlement", [id, "ok"]))).toBe("not_found");
    expect(await errorOf(call("nanny", "siosia_comment_settlement", [id, "   "]))).toBe("bad_input");
    expect(await errorOf(call("nanny", "siosia_comment_settlement", [id, "x".repeat(281)]))).toBe("bad_input");
    await clearOutbox();
    expect(await call("nanny", "siosia_comment_settlement", [id, "  Dzięki, doszło!  "])).toMatchObject({
      comment: { text: "Dzięki, doszło!", by: "Toria", at: expect.any(Number) },
      canComment: false
    });
    expect(await sent()).toEqual(["pay_comment>dad", "pay_comment>mum"]);
    expect(pushText("pay_comment", (await outbox())[0].params as never, "en", "Europe/Warsaw")).toMatchObject({ title: "Toria answered your dobry Pancio", body: "Dzięki, doszło!" });
    expect(await errorOf(call("nanny", "siosia_comment_settlement", [id, "again"]))).toBe("illegal_transition");
    expect(((await settlements("mum"))[0].comment as Json).text).toBe("Dzięki, doszło!");

    // What comes after is due again; the nanny settles this time (she got paid); 30 days to comment.
    const a3 = await done("dad", 5);
    expect(await due("nanny")).toEqual([
      expect.objectContaining({ theyOwe: { services: 120, rides: 0 }, weOwe: { services: 0, rides: 0 }, net: 120, count: 1, since: await ms("select starts_at from public.appointments where id = $1", [a3.id]) })
    ]);
    await clearOutbox();
    expect(await call("nanny", "siosia_settle_up", [pub.dad])).toEqual({ count: 1, net: 120 });
    expect(await sent()).toEqual(["pay_settled>dad", "pay_settled>mum"]);
    expect(pushText("pay_settled", (await outbox())[0].params as never, "pl", "Europe/Warsaw").body).toBe(
      "Twoja wpłata 120,00 PLN odnotowana — jesteście kwita. Stuknij, aby dodać komentarz."
    );
    const later = (await settlements("dad"))[0];
    expect(later).toMatchObject({ by: "Toria", mine: false, direction: "out", amount: 120, canComment: true });
    await h.admin("update public.settlements set created_at = created_at - interval '30 days' where id = $1", [later.id]);
    expect((await settlements("dad"))[0].canComment).toBe(false);
    expect(await errorOf(call("dad", "siosia_comment_settlement", [later.id, "late"]))).toBe("window_closed");
    await h.admin("update public.settlements set created_at = now() - interval '91 days'");
    expect(await settlements("dad")).toEqual([]);
  }, 60_000);

  it("late changes are due again; a test account or a split phone makes no stuck or second side; a comment reaches the side that pressed it", async () => {
    const a1 = await done("dad", 200); // 120
    expect(await call("dad", "siosia_settle_up", [pub.nanny])).toEqual({ count: 1, net: -120 });
    // A tip after the dobry Pancio is due again, on its own; the week's line shows it.
    await call("mum", "siosia_tip_appointment", [a1.id, 15]);
    expect(await due("nanny")).toEqual([expect.objectContaining({ theyOwe: { services: 15, rides: 0 }, net: 15, count: 1 })]);
    const week = await report("dad", await localDay(a1.id));
    expect(((week.spent as Json).services as Json[]).find((l) => l.who === "Toria")!.due).toBe(15);
    expect(await call("nanny", "siosia_settle_up", [pub.dad])).toEqual({ count: 1, net: 15 });
    expect(Number(((await h.admin("select settled_amount from public.appointments where id = $1", [a1.id])).rows[0] as Json).settled_amount)).toBe(135);
    // A shorter time afterwards: the nanny owes the difference back.
    await call("nanny", "siosia_set_actual", [a1.id, 120]);
    expect(await due("dad")).toEqual([expect.objectContaining({ party: pub.nanny, weOwe: { services: -40, rides: 0 }, net: 40 })]);
    await clearOutbox();
    expect(await call("nanny", "siosia_settle_up", [pub.dad])).toEqual({ count: 1, net: -40 });
    expect((await outbox())[0].params).toMatchObject({ total: 40, status: "paid" });
    expect(await due("dad")).toEqual([]);

    // A test account (V66): what is between it and a real member is never due — it could not be settled.
    await done("dad", 100);
    await h.admin("update public.memberships set sandbox = true where user_id = $1", [U.nanny]);
    expect(await due("dad")).toEqual([]);
    await h.admin("update public.memberships set sandbox = false where user_id = $1", [U.nanny]);
    // The newest one is with Anna, no member any more: the line stands for Roman, who can be reached.
    await done("mum", 50);
    await h.db.exec(`create temp table mb_save as select * from public.memberships where user_id = '${U.mum}'; delete from public.memberships where user_id = '${U.mum}';`);
    expect(await due("nanny")).toEqual([expect.objectContaining({ party: pub.dad, count: 2, net: 240 })]);
    await h.db.exec("insert into public.memberships select * from mb_save; drop table mb_save;");
    // Roman's second phone (same master profile, outside the family) is the same side.
    await h.admin("select public.siosia_set_master('rm', 'rm-token-0123456789abcdef', 'Roman', null, null, 'rider', null, null, null, null)");
    await h.admin("update public.profiles set master_id = 'rm' where user_id = any ($1)", [[U.dad, U.dad2]]);
    expect(await due("dad2")).toEqual(await due("dad"));
    expect(await due("nanny")).toHaveLength(1);

    // Roman settles, then leaves the family: Toria's comment goes to the side that got paid by — Anna.
    expect(await call("dad", "siosia_settle_up", [pub.nanny])).toEqual({ count: 2, net: -240 });
    const s = (await settlements("nanny"))[0];
    await call("dad", "siosia_family_leave");
    await clearOutbox();
    await call("nanny", "siosia_comment_settlement", [s.id, "OK"]);
    expect(await sent()).toEqual(["pay_comment>mum"]);
  }, 60_000);
});
