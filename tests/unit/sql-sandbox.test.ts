// @vitest-environment node
// Siosia 2.7 test accounts against the REAL SQL migration in PGlite: who joins with the test invite
// code is in the sandbox and meets only other test accounts (V66). Same cases as the engine tests
// (tests/unit/sandbox.test.ts) — the twin rule (V19).

import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, errorOf, type Json, type SqlHarness } from "./sql-harness";

const U = {
  anna: "00000000-0000-4000-8000-000000000401",
  toria: "00000000-0000-4000-8000-000000000402",
  t1: "00000000-0000-4000-8000-000000000403",
  t2: "00000000-0000-4000-8000-000000000404",
  x: "00000000-0000-4000-8000-000000000405",
  t1b: "00000000-0000-4000-8000-000000000406",
  m1: "00000000-0000-4000-8000-000000000407",
  m2: "00000000-0000-4000-8000-000000000408",
  n1: "00000000-0000-4000-8000-000000000409",
  n2: "00000000-0000-4000-8000-000000000410"
};
type Who = keyof typeof U;
const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const AWAY = { lat: 52.2663135, lng: 20.814317, label: "Husarska 16" };
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args);
const name = (uid: unknown) => (Object.keys(U) as Who[]).find((k) => U[k] === uid) ?? String(uid);
const names = (list: Json[]) => list.map((p) => String(p.nickname)).sort();
const request = (who: Who, provider: Who | null) => call(who, "siosia_request_service", ["childcare", provider && pub[provider], at(26 * 60), 180, HOME, "", null]);
const outbox = async (kind: string) =>
  ((await h.admin("select user_id from public.push_outbox where kind = $1 order by id", [kind])).rows as { user_id: string }[]).map((r) => name(r.user_id)).sort();

async function user(who: Who, nick: string, invite: string, car = false) {
  await call(who, "siosia_join", [invite, `dev-${who}`]);
  await call(who, "siosia_save_profile", [nick, "en"]);
  if (car) await call(who, "siosia_save_vehicle", ["Kia", "Ceed", "Blue", `W ${who}`, 4]);
  await call(who, "siosia_save_push", [`https://web.push.apple.com/${who}`, "p".repeat(40), "a".repeat(16)]);
  pub[who] = String((await call<Json>(who, "siosia_get_profile")).publicId);
}

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  expect(await errorOf(h.admin("select public.siosia_set_test_invite_code('PILOT 2026')"))).toMatch(/must differ/);
  await h.admin("select public.siosia_set_test_invite_code('SMOKE TEST')");
  await user("anna", "Anna", "pilot 2026", true);
  await user("toria", "Toria", "pilot 2026");
  await user("t1", "Smoke Rider", "smoke test");
  await user("t2", "Smoke Driver", "SMOKETEST", true);
  for (const u of ["toria", "t2"] as Who[]) await call(u, "siosia_set_offers", [["childcare"]]);
}, 60_000);

describe("test accounts (2.7, V66)", () => {
  it("the test invite code admits into the sandbox; a wrong code does not", async () => {
    expect(await errorOf(call("x", "siosia_join", ["nope", "dev-x"]))).toBe("bad_invite");
    const rows = (await h.admin("select user_id from public.memberships where sandbox order by user_id")).rows.map((r) => name(r.user_id));
    expect(rows).toEqual(["t1", "t2"]);
    expect(await errorOf(h.as(U.t1, "select public.siosia_set_sandbox('x', true)"))).toMatch(/permission denied/);
  });

  it("lists, the catalog and lookups by public id stay within the realm", async () => {
    expect(names(await call<Json[]>("anna", "siosia_members"))).toEqual(["Toria"]);
    expect(names(await call<Json[]>("t1", "siosia_members"))).toEqual(["Smoke Driver"]);
    const cat = (who: Who) => call<Json[]>(who, "siosia_catalog").then((c) => names(c.find((x) => x.id === "childcare")!.providers as Json[]));
    expect(await cat("anna")).toEqual(["Toria"]);
    expect(await cat("t1")).toEqual(["Smoke Driver"]);
    expect(await errorOf(request("anna", "t2"))).toBe("no_provider");
    expect(await errorOf(request("t1", "toria"))).toBe("no_provider");
    expect(await errorOf(call("anna", "siosia_family_invite", [pub.t1]))).toBe("not_found");
    expect(await errorOf(call("t1", "siosia_propose_contract", [pub.toria, "family", JSON.stringify([{ serviceId: "childcare", perHour: 1 }]), ""]))).toBe("not_found");
    expect((await request("t1", "t2")).status).toBe("requested");
  });

  it("an open request reaches its own realm only", async () => {
    await h.admin("delete from public.push_outbox");
    const real = await request("anna", null);
    const test = await request("t1", null);
    expect(await outbox("appt_open")).toEqual(["t2", "toria"]);
    expect(((await call<Json>("toria", "siosia_planned")).open as Json[]).map((a) => a.id)).toEqual([real.id]);
    expect(((await call<Json>("t2", "siosia_planned")).open as Json[]).map((a) => a.id)).toEqual([test.id]);
    expect(await call<Json>("toria", "siosia_my_state")).toMatchObject({ openRequests: 1 });
    expect(await errorOf(call("toria", "siosia_get_appointment", [test.id]))).toBe("not_found");
    expect(await errorOf(call("toria", "siosia_take_request", [test.id]))).toBe("not_found");
    expect(await errorOf(call("t2", "siosia_take_request", [real.id]))).toBe("not_found");
  });

  it("rides and bookings are offered within the realm only", async () => {
    await call("anna", "siosia_set_online", [true]);
    await call("t2", "siosia_set_online", [true]);
    const ride = await call<Json>("t1", "siosia_request_ride", [HOME, AWAY, 3, 8, false]);
    expect(await call<Json>("anna", "siosia_heartbeat", [HOME.lat, HOME.lng])).toMatchObject({ offer: null, nearbyRequests: 0 });
    expect(((await call<Json>("t2", "siosia_heartbeat", [HOME.lat, HOME.lng])).offer as Json).rideId).toBe(ride.id);
    await call("t1", "siosia_cancel_ride", [ride.id, null]);
    await call("anna", "siosia_set_online", [false]);
    await call("t2", "siosia_set_online", [false]);
    await h.admin("delete from public.push_outbox");
    const b = await call<Json>("t1", "siosia_book_ride", [HOME, AWAY, 3, 8, false, at(26 * 60)]);
    expect(await outbox("booking_new")).toEqual(["t2"]);
    expect(await call<Json[]>("anna", "siosia_open_bookings", [null, null])).toEqual([]);
    expect(await call<Json>("anna", "siosia_my_state")).toMatchObject({ openBookings: 0 });
    expect(await errorOf(call("anna", "siosia_claim_booking", [b.id]))).toBe("not_found");
    expect(await call("t2", "siosia_claim_booking", [b.id])).toBe("won");
  });

  it("a master profile's phones are listed once — its newest account — and not to its own phones (V67)", async () => {
    await h.admin("select public.siosia_set_master('nanny', 'nanny-token-0123456789', 'Niania', null, null, 'rider', null, null, null, array['childcare'])");
    for (const m of ["m1", "m2"] as Who[]) {
      await call(m, "siosia_join_master", ["nanny-token-0123456789", `dev-${m}`, "pl", false]);
      pub[m] = String((await call<Json>(m, "siosia_get_profile")).publicId);
    }
    await h.admin("update public.profiles set created_at = now() - interval '1 day' where user_id = $1", [U.m1]);
    const listed = async (viewer: Who) => (await call<Json[]>(viewer, "siosia_members")).filter((p) => p.nickname === "Niania").map((p) => p.publicId);
    expect(await listed("anna")).toEqual([pub.m2]);
    const cat = await call<Json[]>("anna", "siosia_catalog");
    expect((cat.find((x) => x.id === "childcare")!.providers as Json[]).filter((p) => p.nickname === "Niania").map((p) => p.publicId)).toEqual([pub.m2]);
    expect(await listed("m1")).toEqual([]);
    expect(await listed("t1")).toEqual([]);
  });

  it("2.9: a master profile's phones are one person — a proposal to an unused phone is answered from the one in use (V72)", async () => {
    await h.admin("update public.profiles set seen_at = null where user_id = any ($1)", [[U.m1, U.m2]]);
    await call("m1", "siosia_my_state"); // the phone in use
    const listed = async () => (await call<Json[]>("anna", "siosia_members")).filter((p) => p.nickname === "Niania").map((p) => p.publicId);
    expect(await listed()).toEqual([pub.m1]);
    await h.admin("delete from public.push_outbox");
    const c = await call<Json>("anna", "siosia_propose_contract", [pub.m2, "family", JSON.stringify([{ serviceId: "childcare", perHour: 40 }]), ""]);
    expect(await call<Json>("m1", "siosia_my_state")).toMatchObject({ familyPending: 1 });
    expect((await call<Json[]>("m1", "siosia_contracts"))[0]).toMatchObject({ id: c.id, side: "provider", canAnswer: true });
    await call("m1", "siosia_answer_contract", [c.id, "accept"]);
    expect((await call<Json[]>("anna", "siosia_contracts"))[0].status).toBe("active");
    const a = await call<Json>("anna", "siosia_request_service", ["childcare", pub.m1, new Date(Date.now() + 26 * 3600_000).toISOString(), 180, HOME, "", null]);
    expect(a).toMatchObject({ price: 120, rate: 40, contractId: c.id });
    await call("anna", "siosia_family_invite", [pub.m2]);
    const inv = (await call<Json>("m1", "siosia_family")).incoming as Json[];
    expect(inv.map((i) => (i.from as Json).nickname)).toEqual(["Anna"]);
    await call("m1", "siosia_family_answer", [inv[0].id, "join"]);
    expect(((await call<Json>("anna", "siosia_family")).members as Json[]).map((m) => m.nickname)).toContain("Niania");
  });

  it("a test account's invite link admits a test account (2.8, FR-303)", async () => {
    await call("n1", "siosia_join_link", [(await call<Json>("t1", "siosia_create_member_invite")).token, "dev-n1"]);
    await call("n2", "siosia_join_link", [(await call<Json>("anna", "siosia_create_member_invite")).token, "dev-n2"]);
    const sb = async (who: Who) => (await h.admin("select public.siosia_sandbox($1) as s", [U[who]])).rows[0].s;
    expect(await sb("n1")).toBe(true);
    expect(await sb("n2")).toBe(false);
  });

  it("a test account stays one after the account move; the operator can move one out", async () => {
    const { code } = await call<{ code: string }>("t1", "siosia_create_transfer");
    await call("t1b", "siosia_redeem_transfer", [code, "dev-t1b", false]);
    expect((await h.admin("select bool_or(sandbox) as s from public.memberships where user_id = $1", [U.t1b])).rows[0].s).toBe(true);
    expect(names(await call<Json[]>("t1b", "siosia_members"))).toEqual(["Smoke Driver"]);
    await h.admin("select public.siosia_set_sandbox($1, false)", [pub.t2]);
    expect(names(await call<Json[]>("anna", "siosia_members"))).toEqual(["Niania", "Smoke Driver", "Toria"]);
  });
});
