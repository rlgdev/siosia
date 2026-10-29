// @vitest-environment node
// Siosia 2.6 backend rules against the REAL SQL migration in PGlite: the family (V58), shared kids
// (V59) and appointments (V60), contracts (V61) and their price (V62), the cost summary (V63), the
// weekly report (V64) and its Monday notification (V65). Same cases as the engine tests
// (tests/unit/family.test.ts) — the twin rule (V19).

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, localMidnight, weekOf } from "../../src/core/time";
import { createHarness, errorOf, type Json, type SqlHarness } from "./sql-harness";

const U = {
  dad: "00000000-0000-4000-8000-000000000201",
  mum: "00000000-0000-4000-8000-000000000202",
  nanny: "00000000-0000-4000-8000-000000000203",
  other: "00000000-0000-4000-8000-000000000204",
  x: "00000000-0000-4000-8000-000000000205",
  y: "00000000-0000-4000-8000-000000000206",
  p1: "00000000-0000-4000-8000-000000000211",
  p2: "00000000-0000-4000-8000-000000000212",
  p3: "00000000-0000-4000-8000-000000000213",
  p4: "00000000-0000-4000-8000-000000000214",
  p5: "00000000-0000-4000-8000-000000000215",
  p6: "00000000-0000-4000-8000-000000000216",
  nu: "00000000-0000-4000-8000-000000000217"
};
type Who = keyof typeof U;
const NAMES: Record<Who, string> = { dad: "Roman", mum: "Anna", nanny: "Toria", other: "Ewa", x: "Xenia", y: "Yan", p1: "P1", p2: "P2", p3: "P3", p4: "P4", p5: "P5", p6: "P6", nu: "Kasia" };
const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const MIN = 60_000;
const TZ = "Europe/Warsaw";
const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args);
const code = (p: Promise<unknown>) => errorOf(p);
const name = (uid: unknown) => (Object.keys(U) as Who[]).find((k) => U[k] === uid) ?? String(uid);

function request(who: Who, provider: Who | null, startMin: number, o: { service?: string; duration?: number; repeat?: unknown; kids?: unknown } = {}) {
  const args: unknown[] = [o.service ?? "childcare", provider === null ? null : pub[provider], at(startMin), o.duration ?? 180, HOME, "", o.repeat ?? null];
  if (o.kids !== undefined) args.push(o.kids);
  return call(who, "siosia_request_service", args);
}
const family = (who: Who) => call<Json>(who, "siosia_family");
const invite = (from: Who, to: Who) => call<Json>(from, "siosia_family_invite", [pub[to]]);
const join = async (who: Who) => call<Json>(who, "siosia_family_answer", [((await family(who)).incoming as Json[])[0].id, "join"]);
const couple = async () => {
  await invite("dad", "mum");
  await join("mum");
  await clearOutbox();
};
const propose = (who: Who, to: Who, as: "family" | "provider", rates: unknown, note = "") => call<Json>(who, "siosia_propose_contract", [pub[to], as, JSON.stringify(rates), note]);
const answerContract = (who: Who, id: unknown, d: string) => call<Json>(who, "siosia_answer_contract", [id, d]);
const contracts = (who: Who) => call<Json[]>(who, "siosia_contracts");
const answer = (who: Who, id: unknown) => call(who, "siosia_answer_appointment", [id, "accept"]);
const getAppt = (who: Who, id: unknown) => call<Json>(who, "siosia_get_appointment", [id]);
const outbox = async () =>
  ((await h.admin("select kind, user_id, params from public.push_outbox order by id")).rows as { kind: string; user_id: string; params: Json }[]).map((r) => ({
    ...r,
    who: name(r.user_id)
  }));
const sent = async (kind?: string) => (await outbox()).filter((r) => !kind || r.kind === kind).map((r) => `${r.kind}>${r.who}`).sort();
const clearOutbox = () => h.admin("delete from public.push_outbox");
const sweep = () => h.admin("select public.siosia_sweep()");
/** Moves an appointment so that it ended `agoMin` minutes ago (and was requested before). */
const endAgo = (id: unknown, agoMin: number) =>
  h.admin(
    "update public.appointments set starts_at = now() - make_interval(mins => duration_min + $2), requested_at = now() - interval '30 days' where id = $1",
    [id, agoMin]
  );

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  for (const k of Object.keys(U) as Who[]) {
    if (k === "nu") continue; // 2.8: comes in by an invite link
    await h.onboard(U[k], NAMES[k]);
    pub[k] = String((await call<Json>(k, "siosia_get_profile")).publicId);
    await call(k, "siosia_save_push", [`https://web.push.apple.com/${k}`, "p".repeat(40), "a".repeat(16)]);
  }
  await call("nanny", "siosia_set_offers", [["learning", "childcare"]]);
  await call("mum", "siosia_set_offers", [["learning"]]);
}, 60_000);

beforeEach(async () => {
  await h.db.exec(
    "delete from public.ratings; delete from public.rides; delete from public.appointments; delete from public.appointment_series; delete from public.push_outbox;" +
      "delete from public.kids; delete from public.family_invites; delete from public.contracts; delete from public.family_members; delete from public.families;" +
      "delete from public.member_invites;"
  );
});

describe("family (FR-250–252, V58)", () => {
  it("invites a member, who joins; both see the family; the others are told", async () => {
    expect(await family("dad")).toEqual({ id: null, members: [], invites: [], incoming: [] });
    expect(await code(call("dad", "siosia_family_invite", ["nope"]))).toBe("not_found");
    expect(await code(invite("dad", "dad"))).toBe("not_found");
    const f = await invite("dad", "mum");
    expect((f.members as Json[]).map((m) => [m.nickname, m.me])).toEqual([["Roman", true]]);
    expect((f.invites as Json[]).map((i) => (i.to as Json).nickname)).toEqual(["Anna"]);
    expect(await sent()).toEqual(["family_invite>mum"]);
    expect((await outbox())[0].params).toMatchObject({ sender: "Roman" });
    expect((await invite("dad", "mum")).invites).toHaveLength(1);
    expect(await call<Json>("mum", "siosia_my_state")).toMatchObject({ familyPending: 1 });
    const inc = (await family("mum")).incoming as Json[];
    expect(inc.map((i) => [(i.from as Json).nickname, Number(i.expiresAt) - Number(i.createdAt)])).toEqual([["Roman", 7 * 86_400_000]]);
    await clearOutbox();
    const joined = await join("mum");
    expect((joined.members as Json[]).map((m) => m.nickname)).toEqual(["Roman", "Anna"]);
    expect(joined.incoming).toEqual([]);
    expect((await family("dad")).invites).toEqual([]);
    expect(await sent()).toEqual(["family_joined>dad"]);
    expect(await call<Json>("mum", "siosia_my_state")).toMatchObject({ familyPending: 0 });
    expect(JSON.stringify(await family("dad"))).not.toMatch(/0000-4000/);
    expect(await code(invite("mum", "dad"))).toBe("in_family");
  });

  it("declines, withdraws, lapses after 7 days; refuses someone in another family; at most 6", async () => {
    await invite("dad", "mum");
    await call("mum", "siosia_family_answer", [((await family("mum")).incoming as Json[])[0].id, "decline"]);
    expect((await family("dad")).invites).toEqual([]);
    expect((await family("mum")).id).toBeNull();
    const id = ((await invite("dad", "mum")).invites as Json[])[0].id;
    expect(await code(call("mum", "siosia_family_withdraw", [id]))).toBe("not_found");
    await call("dad", "siosia_family_withdraw", [id]);
    expect((await family("mum")).incoming).toEqual([]);
    expect(await code(call("mum", "siosia_family_answer", [id, "join"]))).toBe("illegal_transition");
    await invite("dad", "mum");
    await h.admin("update public.family_invites set created_at = now() - interval '7 days' where status = 'pending'");
    expect((await family("mum")).incoming).toEqual([]);
    const lapsed = (await h.admin("select id from public.family_invites where status = 'expired'")).rows[0].id;
    expect(await code(call("mum", "siosia_family_answer", [lapsed, "join"]))).toBe("illegal_transition");
    await invite("other", "nanny");
    await join("nanny");
    await invite("dad", "other");
    expect(await code(join("other"))).toBe("in_family");
    for (const u of ["p1", "p2", "p3", "p4", "p5"] as Who[]) {
      await invite("dad", u);
      await join(u);
    }
    expect((await family("dad")).members).toHaveLength(6);
    expect(await code(invite("dad", "p6"))).toBe("family_full");
  });

  it("leaving keeps the family for those left; the last one out ends it and its contracts", async () => {
    await couple();
    const c = await propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }]);
    await answerContract("nanny", c.id, "accept");
    await clearOutbox();
    expect((await call<Json>("mum", "siosia_family_leave")).id).toBeNull();
    expect(((await family("dad")).members as Json[]).map((m) => m.nickname)).toEqual(["Roman"]);
    expect((await contracts("dad"))[0].status).toBe("active");
    expect(await contracts("mum")).toEqual([]);
    await call("dad", "siosia_family_leave");
    expect((await contracts("nanny"))[0].status).toBe("ended");
    expect(await sent()).toEqual(["contract_ended>nanny"]);
    expect(await code(call("dad", "siosia_family_leave"))).toBe("not_found");
  });

  it("a family of one merges in: its contracts come along unless the new family has one with that provider", async () => {
    const a = await propose("mum", "nanny", "family", [{ serviceId: "childcare", perHour: 35 }]);
    await answerContract("nanny", a.id, "accept");
    const solo = (await family("mum")).id;
    await invite("dad", "mum");
    await join("mum");
    expect((await h.admin("select count(*)::int as n from public.families where id = $1", [solo])).rows[0].n).toBe(0);
    expect((await contracts("dad")).map((c) => [c.status, Number((c.rates as Json[])[0].perHour)])).toEqual([["active", 35]]);
    for (const [u, rate] of [["x", 10], ["y", 20]] as const) {
      const c = await propose(u, "nanny", "family", [{ serviceId: "childcare", perHour: rate }]);
      await answerContract("nanny", c.id, "accept");
    }
    await invite("x", "y");
    await join("y");
    expect((await contracts("x")).map((c) => [c.status, Number((c.rates as Json[])[0].perHour)])).toEqual([["active", 10], ["ended", 20]]);
  });
});

describe("shared kids (FR-253, V59)", () => {
  it("every member sees, edits, removes and attaches the family's kids; the owner is kept", async () => {
    const z = await call<Json>("dad", "siosia_add_kid", [{ name: "Zosia", bornYear: 2018, note: "" }]);
    expect(await code(call("mum", "siosia_update_kid", [z.id, { name: "Zo", bornYear: 2018, note: "" }]))).toBe("not_found");
    await couple();
    expect((await call<Json[]>("mum", "siosia_kids")).map((k) => [k.name, k.ownerNickname, k.mine])).toEqual([["Zosia", "Roman", false]]);
    const k = await call<Json>("mum", "siosia_add_kid", [{ name: "Kuba", bornYear: null, note: "" }]);
    expect((await call<Json[]>("dad", "siosia_kids")).map((x) => x.name)).toEqual(["Zosia", "Kuba"]);
    await call("mum", "siosia_update_kid", [z.id, { name: "Zosia", bornYear: 2018, note: "Nut allergy" }]);
    expect((await h.admin("select owner_id, note from public.kids where id = $1", [z.id])).rows[0]).toEqual({ owner_id: U.dad, note: "Nut allergy" });
    // A photo of Roman's kid set by Anna: under her own folder, for that kid.
    const path = `kid/${pub.mum}/${z.id}/a.jpg`;
    await call("mum", "siosia_set_photo", ["kid", z.id, path]);
    expect((await h.admin("select public.siosia_photo_upload_ok($1, $2) as ok", [path, U.mum])).rows[0].ok).toBe(true);
    expect((await h.admin("select public.siosia_can_see_photo($1, $2) as ok", [path, U.dad])).rows[0].ok).toBe(true);
    expect((await h.admin("select public.siosia_can_see_photo($1, $2) as ok", [path, U.other])).rows[0].ok).toBe(false);
    const a = await request("mum", "nanny", 26 * 60, { kids: [z.id, k.id] });
    expect((a.kids as Json[]).map((x) => x.name)).toEqual(["Zosia", "Kuba"]);
    expect(await code(request("other", "nanny", 26 * 60, { kids: [z.id] }))).toBe("bad_input");
    await call("mum", "siosia_family_leave");
    expect((await call<Json[]>("mum", "siosia_kids")).map((x) => x.name)).toEqual(["Kuba"]);
    expect((await call<Json[]>("dad", "siosia_kids")).map((x) => x.name)).toEqual(["Zosia"]);
    expect(((await getAppt("nanny", a.id)).kids as Json[]).map((x) => x.name)).toEqual(["Zosia", "Kuba"]);
  });
});

describe("shared appointments (FR-254–256, V60)", () => {
  it("shows the other member's appointments, both roles, read-only, with the feed", async () => {
    await couple();
    const a = await request("dad", "nanny", 26 * 60);
    const b = await request("other", "mum", 50 * 60, { service: "learning", duration: 60 });
    const seen = (await call<Json>("dad", "siosia_planned")).appointments as Json[];
    expect(seen.map((x) => [x.id, x.role, x.family])).toEqual([
      [a.id, "client", null],
      [b.id, "family", { side: "provider", member: "Anna" }]
    ]);
    expect(await getAppt("mum", a.id)).toMatchObject({ role: "family", family: { side: "client", member: "Roman" }, unread: 0, myRating: null });
    expect(await code(getAppt("other", a.id))).toBe("not_found");
    expect(await code(call("mum", "siosia_cancel_appointment", [a.id, null, "one"]))).toBe("not_found");
    expect(await code(call("dad", "siosia_answer_appointment", [b.id, "accept"]))).toBe("not_found");
    expect(await code(call("mum", "siosia_set_appointment_kids", [a.id, []]))).toBe("forbidden");
    expect(await code(call("mum", "siosia_chat", [`appt:${a.id}`, false]))).toBe("not_found");
    expect(await call<Json>("mum", "siosia_my_state")).toMatchObject({ planned: 1, toAnswer: 1 });
    // Realtime: the families of both parties are told.
    await h.admin("delete from realtime.messages");
    await answer("nanny", a.id);
    const topics = (await h.admin("select distinct topic from realtime.messages")).rows.map((r) => String(r.topic)).sort();
    expect(topics).toEqual([`user:${U.dad}`, `user:${U.mum}`, `user:${U.nanny}`].sort());
    await h.admin("update public.appointments set starts_at = now() + interval '5 minutes' where id = $1", [a.id]);
    await clearOutbox();
    await call("nanny", "siosia_post_update", [a.id, "All good", null, null]);
    expect(await sent("session_update")).toEqual(["session_update>dad", "session_update>mum"]);
    await clearOutbox();
    await call("mum", "siosia_post_update", [a.id, "Thanks!", null, null]);
    expect(await sent("session_update")).toEqual(["session_update>dad", "session_update>nanny"]);
    const feed = await call<Json>("dad", "siosia_updates", [a.id, false]);
    expect((feed.items as Json[]).map((u) => [(u.author as Json).nickname, u.text])).toEqual([
      ["Toria", "All good"],
      ["Anna", "Thanks!"]
    ]);
    // Anna's photo for the feed: under her folder, for that appointment.
    expect((await h.admin("select public.siosia_photo_upload_ok($1, $2) as ok", [`update/${pub.mum}/${a.id}/p.jpg`, U.mum])).rows[0].ok).toBe(true);
    await answer("mum", b.id);
    await h.admin("update public.appointments set starts_at = now() + interval '5 minutes' where id = $1", [b.id]);
    expect((await call<Json>("dad", "siosia_updates", [b.id, false])).items).toEqual([]);
    expect(await code(call("dad", "siosia_post_update", [b.id, "hi", null, null]))).toBe("forbidden");
    await endAgo(a.id, 10);
    await sweep();
    const hist = await call<Json[]>("mum", "siosia_timeline");
    expect(hist.map((x) => [(x.appointment as Json).id, (x.appointment as Json).role])).toEqual([[a.id, "family"]]);
  });

  it("an open request of my family is mine to see, not to take", async () => {
    await couple();
    const o = await request("dad", null, 26 * 60);
    expect((await call<Json>("mum", "siosia_planned")).open).toEqual([]);
    expect((await getAppt("mum", o.id)).role).toBe("family");
    expect(await code(call("mum", "siosia_take_request", [o.id]))).toBe("forbidden");
  });
});

describe("contracts (FR-260–264, V61)", () => {
  it("proposes, the other side accepts; a newer proposal replaces the waiting one; accepting replaces the active one", async () => {
    await couple();
    for (const bad of [[], [{ serviceId: "childcare", perHour: -1 }], [{ serviceId: "childcare", perHour: 10001 }], [{ serviceId: "childcare", perHour: 1.005 }], [{ serviceId: "childcare", perHour: 4 }, { serviceId: "childcare", perHour: 5 }]])
      expect(await code(propose("dad", "nanny", "family", bad)), JSON.stringify(bad)).toBe("bad_input");
    expect(await code(propose("dad", "nanny", "family", [{ serviceId: "ride", perHour: 4 }]))).toBe("not_offered");
    expect(await code(propose("dad", "mum", "family", [{ serviceId: "learning", perHour: 4 }]))).toBe("forbidden");
    expect(await code(propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 4 }], "x".repeat(201)))).toBe("bad_input");
    const c1 = await propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }], " evenings ");
    expect(c1).toMatchObject({ status: "proposed", side: "family", proposedByMe: true, canAnswer: false, version: 1, note: "evenings", currency: "PLN", family: ["Roman", "Anna"] });
    expect(await sent()).toEqual(["contract_proposed>nanny"]);
    expect(await call<Json>("nanny", "siosia_my_state")).toMatchObject({ familyPending: 1 });
    expect((await contracts("nanny"))[0]).toMatchObject({ side: "provider", canAnswer: true, proposedByMe: false });
    expect(await code(answerContract("mum", c1.id, "accept"))).toBe("forbidden");
    expect(await code(answerContract("other", c1.id, "accept"))).toBe("not_found");
    const c2 = await propose("mum", "nanny", "family", [{ serviceId: "childcare", perHour: 45 }, { serviceId: "learning", perHour: 50 }]);
    expect((await contracts("dad")).map((c) => [c.id, c.status])).toEqual([[c2.id, "proposed"], [c1.id, "withdrawn"]]);
    await clearOutbox();
    await answerContract("nanny", c2.id, "accept");
    expect(await sent()).toEqual(["contract_accepted>dad", "contract_accepted>mum"]);
    const c3 = await propose("nanny", "dad", "provider", [{ serviceId: "childcare", perHour: 50 }]);
    expect(c3.version).toBe(3);
    expect(await code(call("dad", "siosia_withdraw_contract", [c3.id]))).toBe("forbidden");
    await answerContract("mum", c3.id, "accept");
    expect((await contracts("nanny")).map((c) => [c.version, c.status])).toEqual([[3, "active"], [2, "replaced"], [1, "withdrawn"]]);
    await clearOutbox();
    await call("dad", "siosia_end_contract", [c3.id]);
    expect(await sent()).toEqual(["contract_ended>nanny"]);
    expect(await code(call("dad", "siosia_end_contract", [c3.id]))).toBe("illegal_transition");
    const c4 = await propose("nanny", "other", "provider", [{ serviceId: "learning", perHour: 30 }]);
    expect(((await family("other")).members as Json[]).map((m) => m.nickname)).toEqual(["Ewa"]);
    await answerContract("other", c4.id, "decline");
    expect(await sent()).toContain("contract_declined>nanny");
    const c5 = await propose("nanny", "other", "provider", [{ serviceId: "learning", perHour: 30 }]);
    await call("nanny", "siosia_withdraw_contract", [c5.id]);
    expect((await contracts("other")).map((c) => c.status)).toEqual(["withdrawn", "declined"]);
  });
});

describe("2.8: a contract with anyone; YOLO priced from the base rate (V68, V70)", () => {
  const providers = async (who: Who, id: string) =>
    ((await call<Json[]>(who, "siosia_catalog")).find((x) => x.id === id)!.providers as Json[]).map((p) => [p.nickname, p.contractRate]);
  it("contracts with someone who offers nothing, who then shows to that family only and can be asked", async () => {
    await couple();
    expect(await providers("dad", "childcare")).toEqual([["Toria", null]]);
    expect(await code(request("dad", "other", 26 * 60))).toBe("not_offered");
    const c = await propose("dad", "other", "family", [{ serviceId: "childcare", perHour: 30 }]);
    await answerContract("other", c.id, "accept");
    expect(await providers("dad", "childcare")).toEqual([["Ewa", 30], ["Toria", null]]);
    expect(await providers("mum", "childcare")).toEqual([["Ewa", 30], ["Toria", null]]);
    expect(await providers("x", "childcare")).toEqual([["Toria", null]]);
    expect(await request("dad", "other", 26 * 60, { duration: 120 })).toMatchObject({ price: 60, rate: 30, contractId: c.id });
    expect(await code(request("dad", "other", 30 * 60, { service: "learning", duration: 60 }))).toBe("not_offered");
  });

  it("a YOLO event is offered by whoever offers its base and takes the contract's base rate", async () => {
    expect((await call<Json[]>("dad", "siosia_catalog")).filter((x) => x.section === "yolo")).toHaveLength(15);
    expect(await providers("dad", "yolo_halloween")).toEqual([["Toria", null]]);
    expect(await request("dad", "nanny", 26 * 60, { service: "yolo_halloween" })).toMatchObject({ price: null, rate: null });
    const c = await propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }]);
    await answerContract("nanny", c.id, "accept");
    expect(await providers("dad", "yolo_halloween")).toEqual([["Toria", 40]]);
    expect(await request("dad", "nanny", 50 * 60, { service: "yolo_halloween" })).toMatchObject({ price: 120, rate: 40, contractId: c.id });
    const c2 = await propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }, { serviceId: "yolo_new_year", perHour: 60 }]);
    await answerContract("nanny", c2.id, "accept");
    expect(await request("dad", "nanny", 74 * 60, { service: "yolo_new_year", duration: 360 })).toMatchObject({ price: 360, rate: 60 });
  });
});

describe("2.8: invite links (FR-301–303, V69)", () => {
  it("a link admits a new phone once; after the nickname comes the family invitation", async () => {
    const { token, expiresAt } = await call<{ token: string; expiresAt: number }>("dad", "siosia_create_member_invite");
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(Math.round((expiresAt - Date.now()) / 86_400_000)).toBe(14);
    expect((await h.admin("select count(*)::int as n from public.member_invites where token_hash = $1", [token])).rows[0].n).toBe(0); // only the hash
    expect(await h.as(U.nu, "select public.siosia_is_member('dev-nu')")).toBe(false);
    expect(await code(call("nu", "siosia_join_link", ["wrong", "dev-nu"]))).toBe("bad_link");
    await call("nu", "siosia_join_link", [token, "dev-nu"]);
    expect(await h.as(U.nu, "select public.siosia_is_member('dev-nu')")).toBe(true);
    expect(await code(call("p6", "siosia_join_link", [token, "dev-p6"]))).toBe("bad_link");
    await clearOutbox();
    await call("nu", "siosia_save_profile", ["Kasia", "pl"]);
    await call("nu", "siosia_save_push", ["https://web.push.apple.com/nu", "p".repeat(40), "a".repeat(16)]);
    expect(((await family("nu")).incoming as Json[]).map((i) => (i.from as Json).nickname)).toEqual(["Roman"]);
    await call("nu", "siosia_save_profile", ["Kasia K", "pl"]);
    expect((await family("nu")).incoming).toHaveLength(1); // once
  });

  it("a member who opens a link gets the invitation at once; links lapse after 14 days; 10 open at most", async () => {
    const { token } = await call<{ token: string }>("dad", "siosia_create_member_invite");
    await call("other", "siosia_join_link", [token, "dev-other"]);
    expect(((await family("other")).incoming as Json[]).map((i) => (i.from as Json).nickname)).toEqual(["Roman"]);
    const late = (await call<{ token: string }>("dad", "siosia_create_member_invite")).token;
    await h.admin("update public.member_invites set expires_at = now() - interval '1 second' where used_by is null and from_user = $1", [U.dad]);
    expect(await code(call("p6", "siosia_join_link", [late, "dev-p6"]))).toBe("bad_link");
    await h.db.exec("delete from public.member_invites; delete from public.invite_failures;");
    for (let i = 0; i < 10; i++) await call("mum", "siosia_create_member_invite");
    expect(await code(call("mum", "siosia_create_member_invite"))).toBe("too_many");
    for (let i = 0; i < 10; i++) await code(call("p6", "siosia_join_link", [`x${i}`, "dev-p6"]));
    expect(await code(call("p6", "siosia_join_link", ["y", "dev-p6"]))).toBe("rate_limited");
    await h.admin("delete from public.invite_failures");
  });
});

describe("price and cost (FR-262, FR-270–273, V62, V63)", () => {
  const accepted = async (who: Who, provider: Who) => {
    const a = await request(who, provider, 26 * 60);
    await answer(provider, a.id);
    return a;
  };
  it("a contract sets the rate of new requests from any family member; the catalog price otherwise", async () => {
    await couple();
    const before = await request("dad", "nanny", 26 * 60);
    expect(before).toMatchObject({ price: null, rate: null, contractId: null });
    const c = await propose("nanny", "mum", "provider", [{ serviceId: "childcare", perHour: 40 }]);
    await answerContract("dad", c.id, "accept");
    const cat = await call<Json[]>("mum", "siosia_catalog");
    expect((cat.find((x) => x.id === "childcare")!.providers as Json[])[0]).toMatchObject({ nickname: "Toria", contractRate: 40 });
    const catOther = await call<Json[]>("other", "siosia_catalog");
    expect((catOther.find((x) => x.id === "childcare")!.providers as Json[])[0].contractRate).toBeNull();
    const a = await request("mum", "nanny", 30 * 60, { duration: 150 });
    expect(a).toMatchObject({ price: 100, rate: 40, contractId: c.id });
    expect(await request("dad", "nanny", 50 * 60, { service: "learning", duration: 60 })).toMatchObject({ price: null, rate: null });
    const s = await request("dad", "nanny", 70 * 60, { duration: 60, repeat: { every: 1, count: 3 } });
    const prices = (await h.admin("select price from public.appointments where series_id = $1 order by seq", [(s.series as Json).id])).rows.map((r) => Number(r.price));
    expect(prices).toEqual([40, 40, 40]);
    await call("dad", "siosia_end_contract", [c.id]);
    expect((await getAppt("dad", a.id)).price).toBe(100);
    expect((await getAppt("dad", before.id)).price).toBeNull();
  });

  it("an open request is repriced at the taker's contract", async () => {
    const c = await propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 30 }]);
    await answerContract("nanny", c.id, "accept");
    const o = await request("dad", null, 26 * 60, { duration: 120 });
    expect(o.price).toBeNull();
    expect(await call<Json>("nanny", "siosia_take_request", [o.id])).toMatchObject({ price: 60, rate: 30, contractId: c.id });
  });

  it("summarises a done appointment once, to both parents and the provider; the provider corrects the time within 24 h", async () => {
    await couple();
    const c = await propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }]);
    await answerContract("nanny", c.id, "accept");
    const a = await accepted("dad", "nanny");
    expect((await getAppt("dad", a.id)).cost).toBeNull();
    await clearOutbox();
    await endAgo(a.id, 1);
    await sweep();
    expect((await getAppt("mum", a.id)).cost).toEqual({ minutes: 180, rate: 40, total: 120, currency: "PLN", source: "contract", corrected: false });
    expect(await sent()).toEqual(["appt_summary>dad", "appt_summary>mum", "appt_summary>nanny"]);
    expect((await outbox())[0].params).toMatchObject({ minutes: 180, total: 120, currency: "PLN", corrected: false });
    await sweep();
    expect(await outbox()).toHaveLength(3);
    for (const bad of [10, 1441, 200]) expect(await code(call("nanny", "siosia_set_actual", [a.id, bad]))).toBe("bad_input");
    expect(await code(call("dad", "siosia_set_actual", [a.id, 240]))).toBe("forbidden");
    expect(await code(call("other", "siosia_set_actual", [a.id, 240]))).toBe("not_found");
    await clearOutbox();
    expect((await call<Json>("nanny", "siosia_set_actual", [a.id, 240])).cost).toMatchObject({ minutes: 240, total: 160, corrected: true });
    expect(await sent()).toEqual(["appt_summary>dad", "appt_summary>mum"]);
    expect((await call<Json>("nanny", "siosia_set_actual", [a.id, 180])).cost).toMatchObject({ minutes: 180, total: 120, corrected: false });
    await h.admin("update public.appointments set ended_at = now() - interval '24 hours 1 minute' where id = $1", [a.id]);
    expect(await code(call("nanny", "siosia_set_actual", [a.id, 240]))).toBe("window_closed");
    const b = await accepted("other", "nanny");
    await clearOutbox();
    await endAgo(b.id, 1);
    await sweep();
    expect((await getAppt("other", b.id)).cost).toEqual({ minutes: 180, rate: null, total: null, currency: "PLN", source: "none", corrected: false });
    expect(await sent()).toEqual([]);
  });
});

describe("weekly report (FR-280–283, V64, V65)", () => {
  /** Last week's Monday (local) and an instant `day` days + `hour` hours into it. */
  const LAST = addDays(weekOf(Date.now(), TZ), -7);
  const inLast = (day: number, hour: number) => new Date(localMidnight(addDays(LAST, day), TZ) + hour * 3600_000).toISOString();
  const place = (id: unknown, iso: string) => h.admin("update public.appointments set starts_at = $2, requested_at = $2::timestamptz - interval '30 days' where id = $1", [id, iso]);

  it("sums one week's spent and earned, per person or for the family", async () => {
    await couple();
    const c = await propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }, { serviceId: "learning", perHour: 60 }]);
    await answerContract("nanny", c.id, "accept");
    const a1 = await request("dad", "nanny", 26 * 60);
    const a2 = await request("mum", "nanny", 50 * 60, { service: "learning", duration: 90 });
    const a3 = await request("other", "mum", 74 * 60, { service: "learning", duration: 60 });
    for (const [p, a] of [["nanny", a1], ["nanny", a2], ["mum", a3]] as const) await answer(p, a.id);
    await place(a1.id, inLast(2, 10));
    await place(a2.id, inLast(3, 10));
    await place(a3.id, inLast(4, 10));
    await sweep();
    const me = await call<Json>("dad", "siosia_report", [LAST, "me"]);
    expect(me).toMatchObject({ week: LAST, scope: "me", hasFamily: true, currency: "PLN", net: -120, members: null });
    expect(me.spent).toEqual({ total: 120, servicesTotal: 120, services: [{ who: "Toria", serviceId: "childcare", count: 1, minutes: 180, total: 120, due: 120 }], rides: { count: 0, total: 0, due: 0 }, tips: 0 });
    expect((me.earned as Json).total).toBe(0);
    const fam = await call<Json>("mum", "siosia_report", [addDays(LAST, 3), "family"]);
    expect(fam.week).toBe(LAST);
    expect(((fam.spent as Json).services as Json[]).map((l) => [l.who, l.serviceId, l.total])).toEqual([
      ["Toria", "childcare", 120],
      ["Toria", "learning", 90]
    ]);
    expect((fam.earned as Json).services).toEqual([{ who: "Ewa", serviceId: "learning", count: 1, minutes: 60, total: 0, due: 0 }]);
    expect(fam.members).toEqual([
      { nickname: "Roman", spent: 120, earned: 0 },
      { nickname: "Anna", spent: 90, earned: 0 }
    ]);
    expect(await call<Json>("nanny", "siosia_report", [LAST, "family"])).toMatchObject({ scope: "me", hasFamily: false, earned: { total: 210 } });
    for (const bad of ["2026-13-01", "x", addDays(LAST, -7 * 52), addDays(LAST, 14)]) expect(await code(call("dad", "siosia_report", [bad, "me"])), bad).toBe("bad_input");
  });

  it("tells everyone with something last week on Monday from 08:00, once", async () => {
    const a = await request("dad", "nanny", 26 * 60);
    await answer("nanny", a.id);
    await place(a.id, inLast(2, 10));
    await sweep();
    await h.admin("update public.app_config set report_week = $1::date where id = 1", [LAST]);
    await clearOutbox();
    const monday = addDays(LAST, 7);
    const run = (ms: number) => h.admin("select public.siosia_sweep_family($1)", [new Date(ms).toISOString()]);
    await run(localMidnight(monday, TZ) + 8 * 3600_000 - 60_000);
    expect(await sent("weekly_report")).toEqual([]);
    await run(localMidnight(monday, TZ) + 8 * 3600_000);
    expect(await sent("weekly_report")).toEqual(["weekly_report>dad", "weekly_report>nanny"]);
    expect((await outbox()).find((r) => r.kind === "weekly_report" && r.who === "dad")!.params).toMatchObject({ spent: 0, earned: 0, week: LAST, currency: "PLN" });
    await run(localMidnight(monday, TZ) + 9 * 3600_000);
    expect(await sent("weekly_report")).toHaveLength(2);
    expect((await h.admin("select to_char(report_week, 'YYYY-MM-DD') as w from public.app_config where id = 1")).rows[0].w).toBe(monday);
  });
});

describe("delete and move (V49, FR-263)", () => {
  it("a deleted provider's contracts end; a deleted member leaves", async () => {
    await couple();
    const c = await propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }]);
    await answerContract("nanny", c.id, "accept");
    await clearOutbox();
    await call("nanny", "siosia_delete_profile");
    expect((await contracts("dad"))[0].status).toBe("ended");
    expect(await sent("contract_ended")).toEqual(["contract_ended>dad", "contract_ended>mum"]);
    await call("mum", "siosia_delete_profile");
    expect(((await family("dad")).members as Json[]).map((m) => m.nickname)).toEqual(["Roman"]);
    // Bring them back for the other tests.
    await h.admin("update public.profiles set deleted = false where user_id = any ($1)", [[U.nanny, U.mum]]);
    for (const k of ["nanny", "mum"] as Who[]) {
      await call(k, "siosia_join", ["pilot 2026", `dev-${k}`]);
      await call(k, "siosia_save_profile", [NAMES[k], "en"]);
      await call(k, "siosia_save_push", [`https://web.push.apple.com/${k}`, "p".repeat(40), "a".repeat(16)]);
    }
    await call("nanny", "siosia_set_offers", [["learning", "childcare"]]);
    await call("mum", "siosia_set_offers", [["learning"]]);
  });
});
