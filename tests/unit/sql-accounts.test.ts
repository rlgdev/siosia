// @vitest-environment node
// Siosia 2.12 accounts against the REAL SQL migration in PGlite: one account per person on every
// phone (FR-326–FR-331, V81–V86). A phone signs in (email code or Google) and hands the anonymous
// account it used before to the signed-in one (siosia_absorb); the operator merges phones gone
// (siosia_merge_into); the deployment can then ask for accounts and open membership. Same cases as
// the engine tests (tests/unit/accounts.test.ts) where the engine knows the rule — the twin rule (V19).

import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, errorOf, type Claims, type Json, type SqlHarness } from "./sql-harness";

const U = {
  // phones: anonymous accounts, as today
  r1: "00000000-0000-4000-8000-000000001201",
  r2: "00000000-0000-4000-8000-000000001202",
  t1: "00000000-0000-4000-8000-000000001203",
  t2: "00000000-0000-4000-8000-000000001204",
  t3: "00000000-0000-4000-8000-000000001205",
  k1: "00000000-0000-4000-8000-000000001206",
  k2: "00000000-0000-4000-8000-000000001207",
  a1: "00000000-0000-4000-8000-000000001208",
  o1: "00000000-0000-4000-8000-000000001209",
  sb: "00000000-0000-4000-8000-000000001210",
  x1: "00000000-0000-4000-8000-000000001211",
  w1: "00000000-0000-4000-8000-000000001212",
  u1: "00000000-0000-4000-8000-000000001213",
  x2: "00000000-0000-4000-8000-000000001214",
  x3: "00000000-0000-4000-8000-000000001215",
  p1: "00000000-0000-4000-8000-000000001216",
  j1: "00000000-0000-4000-8000-000000001217",
  x4: "00000000-0000-4000-8000-000000001218",
  // signed-in accounts (email), fresh
  R: "00000000-0000-4000-8000-000000001221",
  T: "00000000-0000-4000-8000-000000001222",
  K: "00000000-0000-4000-8000-000000001223",
  A: "00000000-0000-4000-8000-000000001224",
  S: "00000000-0000-4000-8000-000000001225",
  Q: "00000000-0000-4000-8000-000000001226",
  Y: "00000000-0000-4000-8000-000000001227",
  Z: "00000000-0000-4000-8000-000000001228",
  M: "00000000-0000-4000-8000-000000001229",
  P: "00000000-0000-4000-8000-000000001230"
};
type Who = keyof typeof U;
const SIGNED_IN: Who[] = ["R", "T", "K", "A", "S", "Q", "Y", "Z", "M", "P"];
const anonymous = (who: Who): boolean => !SIGNED_IN.includes(who);
const TORIA = "toria-link-token-0001";
const ROMAN = "roman-link-token-0001";

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const claims = (who: Who): Claims => ({ anonymous: anonymous(who), email: anonymous(who) ? null : `${who.toLowerCase()}@example.com` });
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args, claims(who));
const code = (p: Promise<unknown>) => errorOf(p).then((m) => (m === "no error" ? "ok" : m));
const name = (uid: unknown) => (Object.keys(U) as Who[]).find((k) => U[k] === uid) ?? String(uid);
const whoami = (who: Who) => call<Json>(who, "siosia_whoami", [`dev-${who}`]);
const profile = (who: Who) => call<Json | null>(who, "siosia_get_profile");
const transfer = async (who: Who) => String((await call<Json>(who, "siosia_create_transfer")).code);
const absorb = async (into: Who, from: Who) => call<Json>(into, "siosia_absorb", [await transfer(from), `dev-${into}`]);
const rows = async (sql: string, params: unknown[] = []) => (await h.admin(sql, params)).rows;
const accounts = async (who: Who) =>
  ((await rows("select public.siosia_person_accounts($1) a", [U[who]]))[0].a as string[]).slice().sort();
const kidsOf = async (who: Who) => ((await call<Json[]>(who, "siosia_kids")) ?? []).map((k) => String(k.name)).sort();

async function phone(who: Who, how: { master?: string; invite?: string; nick?: string }) {
  if (how.master) await call(who, "siosia_join_master", [how.master, `dev-${who}`, "en", false]);
  else {
    await call(who, "siosia_join", [how.invite ?? "pilot 2026", `dev-${who}`]);
    await call(who, "siosia_save_profile", [how.nick ?? who, "en"]);
  }
  pub[who] = String((await profile(who))!.publicId);
}

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  for (const w of SIGNED_IN) await h.admin("update auth.users set is_anonymous = false, email = $2 where id = $1", [U[w], `${w.toLowerCase()}@example.com`]);
  await h.admin("select public.siosia_set_test_invite_code('SMOKE TEST')");
  await h.admin(`select public.siosia_set_master('master', '${TORIA}', 'Toria', null, 18, 'rider')`);
  await h.admin(`select public.siosia_set_master('roman', '${ROMAN}', 'Roman', null, null, 'driver', null, null,
                   '{"make":"Porsche","model":"Taycan","colour":"Zielony","seats":4,"plate":"W1LLRUN"}'::jsonb, array['childcare'])`);
  for (const w of ["r1", "r2"] as Who[]) await phone(w, { master: ROMAN });
  for (const w of ["t1", "t2", "t3"] as Who[]) await phone(w, { master: TORIA });
  await phone("k1", { nick: "Karol" });
  await phone("k2", { nick: "Karol" });
  await phone("a1", { nick: "Ań" });
  await phone("o1", { nick: "Ola" });
  await phone("sb", { invite: "smoke test", nick: "Smoke" });
  // Toria's family: Toria (t1) and Ań; a contract with Roman; Karol's two phones in two families
  await call("t1", "siosia_family_invite", [pub.a1]);
  await call("a1", "siosia_family_answer", [((await call<Json>("a1", "siosia_family")).incoming as Json[])[0].id, "join"]);
  await call("t1", "siosia_family_invite", [pub.k1]);
  await call("k1", "siosia_family_answer", [((await call<Json>("k1", "siosia_family")).incoming as Json[])[0].id, "join"]);
  await call("k2", "siosia_family_invite", [pub.o1]);
  await call("o1", "siosia_family_answer", [((await call<Json>("o1", "siosia_family")).incoming as Json[])[0].id, "join"]);
  const c = await call<Json>("t1", "siosia_propose_contract", [pub.r1, "family", JSON.stringify([{ serviceId: "childcare", perHour: 40 }]), ""]);
  await call("r1", "siosia_answer_contract", [c.id, "accept"]);
  await call("t1", "siosia_add_kid", [{ name: "Ola", bornYear: 2019, note: "" }]);
  await call("t2", "siosia_add_kid", [{ name: "Zosia", bornYear: 2021, note: "" }]);
  for (const w of ["t1", "t2", "r1", "r2"] as Who[]) await call(w, "siosia_save_push", [`https://web.push.apple.com/${w}`, "p".repeat(40), "a".repeat(16)]);
  const fam = String((await rows("select family_id from public.family_members where user_id = $1", [U.t1]))[0].family_id);
  await h.admin(
    "insert into public.settlements (kind, by_user, with_user, from_party, to_party, amount) values ('remind', $1, $2, 'p:roman', $3, 120)",
    [U.r1, U.t1, `f:${fam}`]
  );
  await h.admin(
    "insert into public.settlements (kind, by_user, with_user, from_party, to_party, amount) values ('remind', $1, $2, $3, $4, 30)",
    [U.k2, U.o1, `p:${U.k2}`, `p:${U.o1}`]
  );
}, 120_000);

describe("2.12 accounts (FR-326–FR-331, V81–V86)", () => {
  it("siosia_config tells a phone with no session how to sign in", async () => {
    const cfg = await h.asAnonRole<Json>("select public.siosia_config()");
    expect(cfg).toMatchObject({ authMode: "anonymous", googleSignIn: "off", membershipMode: "invite" });
  });

  it("membership is the person's; whoami routes every session", async () => {
    expect(await h.as(U.t1, "select public.siosia_is_member('a-new-phone')", [], claims("t1"))).toBe(true);
    expect(await whoami("t1")).toMatchObject({ member: true, hasProfile: true, anonymous: true, signInRequired: false, mergedInto: null, sandbox: false, publicId: pub.t1 });
    expect(await whoami("T")).toMatchObject({ member: false, hasProfile: false, anonymous: false, mergedInto: null });
    expect(await code(call("T", "siosia_my_state"))).toBe("not_member");
  });

  it("a wrong code is refused and counted; an anonymous session cannot take another account in", async () => {
    expect(await code(call("T", "siosia_absorb", ["WRON-GCOD", "dev-T"]))).toBe("bad_transfer");
    expect((await rows("select count(*)::int n from public.invite_failures where user_id = $1", [U.T]))[0].n).toBe(1);
    const c = await transfer("t3");
    expect(await code(call("x1", "siosia_absorb", [c, "dev-x1"]))).toBe("sign_in_required");
  });

  it("the first phone moves the whole profile: public id, master profile, family, contract, kids, push", async () => {
    const before = pub.t1;
    const res = await absorb("T", "t1");
    expect(res).toMatchObject({ publicId: before, nickname: "Toria", masterId: "master", merge: { shape: "move", from: before, into: before } });
    expect(await whoami("T")).toMatchObject({ member: true, hasProfile: true });
    expect(((await call<Json>("T", "siosia_family")).members as Json[]).map((m) => m.nickname).sort()).toEqual(["Ań", "Karol", "Toria"]);
    expect(await kidsOf("T")).toEqual(["Ola"]);
    expect((await rows("select count(*)::int n from public.push_subscriptions where user_id = $1", [U.T]))[0].n).toBe(1);
    expect((await rows("select device_id from public.memberships where user_id = $1 order by 1", [U.T])).map((r) => r.device_id)).toEqual(["dev-T", "dev-t1"]);
    // the old account is frozen and its phone sent to sign in, not to the invite code
    expect(await whoami("t1")).toMatchObject({ member: false, hasProfile: false, mergedInto: before });
    expect(await code(call("t1", "siosia_my_state"))).toBe("account_merged");
    expect(await code(call("t1", "siosia_join", ["pilot 2026", "dev-t1"]))).toBe("already_merged");
    expect(await code(call("t1", "siosia_create_transfer"))).toBe("not_member");
  });

  it("another phone of the person merges in and nothing is lost", async () => {
    const res = await absorb("T", "t2");
    expect(res).toMatchObject({ publicId: pub.t1, merge: { shape: "merge", from: pub.t2, into: pub.t1 } });
    expect(await kidsOf("T")).toEqual(["Ola", "Zosia"]);
    expect((await rows("select count(*)::int n from public.push_subscriptions where user_id = $1", [U.T]))[0].n).toBe(2);
    const t2 = (await rows("select deleted, merged_into from public.profiles where user_id = $1", [U.t2]))[0];
    expect(t2).toEqual({ deleted: true, merged_into: U.T });
    expect(await whoami("t2")).toMatchObject({ mergedInto: pub.t1 });
    expect(await accounts("T")).toEqual([U.T, U.t3].sort());
    expect(await code(absorb("T", "t2"))).toBe("not_member");
  });

  it("a move code never moves a signed-in account (or one others were merged into) to another session", async () => {
    const before = (await rows("select count(*)::int n from public.invite_failures where user_id = $1", [U.u1]))[0].n;
    expect(await code(call("u1", "siosia_redeem_transfer", [await transfer("T"), "dev-u1", true]))).toBe("sign_in_instead");
    expect((await rows("select count(*)::int n from public.invite_failures where user_id = $1", [U.u1]))[0].n).toBe(before);
    expect(await whoami("T")).toMatchObject({ member: true, hasProfile: true });
  });

  it("a signed-in account never takes a move code: it would throw its own kids and family away", async () => {
    const c = await transfer("o1");
    expect(await code(call("T", "siosia_redeem_transfer", [c, "dev-T", true]))).toBe("use_merge");
    expect(await kidsOf("T")).toEqual(["Ola", "Zosia"]);
    expect((await call<Json>("o1", "siosia_get_profile"))!.nickname).toBe("Ola");
  });

  it("the invite code records at most 20 phones of a person", async () => {
    for (let i = 0; i < 25; i++) await call("j1", "siosia_join", ["pilot 2026", `j-${i}`]);
    expect((await rows("select count(*)::int n from public.memberships where user_id = $1", [U.j1]))[0].n).toBe(20);
    expect(await h.as(U.j1, "select public.siosia_is_member('j-24')", [], claims("j1"))).toBe(true);
  });

  it("whoami records at most 20 phones of a person", async () => {
    for (let i = 0; i < 25; i++) await call("T", "siosia_whoami", [`spam-${i}`]);
    expect((await rows("select count(*)::int n from public.memberships where user_id = $1", [U.T]))[0].n).toBeLessThanOrEqual(20);
    expect(await whoami("T")).toMatchObject({ member: true });
  });

  it("a typed code shows whose account it is first; that account's push does not follow it", async () => {
    await phone("p1", { nick: "Pola" });
    await call("p1", "siosia_save_push", ["https://web.push.apple.com/p1", "p".repeat(40), "a".repeat(16)]);
    expect(await code(call("P", "siosia_absorb_preview", ["WRON-GCOD"]))).toBe("bad_transfer");
    expect((await rows("select count(*)::int n from public.invite_failures where user_id = $1", [U.P]))[0].n).toBe(1);
    const c = await transfer("p1");
    expect(await call<Json>("P", "siosia_absorb_preview", [c])).toEqual({ nickname: "Pola", publicId: pub.p1, family: false, master: false });
    expect(await call<Json>("P", "siosia_absorb", [c, "dev-P", false])).toMatchObject({ nickname: "Pola", merge: { shape: "move" } });
    expect((await rows("select count(*)::int n from public.push_subscriptions where user_id in ($1, $2)", [U.P, U.p1]))[0].n).toBe(0);
  });

  it("the survivor's settlement side holds every key of both accounts", async () => {
    await phone("x2", { nick: "Xawery" });
    await phone("x3", { master: ROMAN });
    await h.admin("insert into public.settlements (kind, by_user, with_user, from_party, to_party, amount) values ('remind', $1, $2, $3, 'p:roman', 10)", [U.x2, U.x3, `p:${U.x2}`]);
    await absorb("M", "x2");
    expect((await rows("select from_party from public.settlements where by_user = $1", [U.M]))[0].from_party).toBe(`p:${U.M}`);
    // the second phone brings a master profile: the side becomes p:<master> for every row of the person
    await absorb("M", "x3");
    expect((await rows("select public.siosia_side($1) s", [U.M]))[0].s).toBe("p:roman");
    expect((await rows("select from_party from public.settlements where by_user = $1", [U.M]))[0].from_party).toBe("p:roman");
  });

  it("the operator merges a phone gone by public id; clients cannot", async () => {
    expect(await code(h.as(U.T, `select public.siosia_merge_into('${pub.t3}', '${pub.t1}')`, [], claims("T")))).toMatch(/permission denied/);
    expect(await code(h.as(U.T, `select public.siosia_merge_accounts('${U.t3}', '${U.T}', 'operator')`, [], claims("T")))).toMatch(/permission denied/);
    const res = (await rows(`select public.siosia_merge_into('${pub.t3}', '${pub.t1}') r`))[0].r as Json;
    expect(res).toMatchObject({ ok: { shape: "merge", into: pub.t1 } });
    expect(await accounts("T")).toEqual([U.T]);
    expect((await rows("select count(*)::int n from public.profiles where master_id = 'master' and not deleted"))[0].n).toBe(1);
  });

  it("the provider's phones become one account; the contract and the settlement sides stay", async () => {
    await absorb("R", "r1");
    await absorb("R", "r2");
    const cs = await call<Json[]>("R", "siosia_contracts");
    expect(cs.filter((c) => c.status === "active")).toHaveLength(1);
    expect((await rows("select public.siosia_side($1) s", [U.R]))[0].s).toBe("p:roman");
    expect((await rows("select count(*)::int n from public.settlements where from_party = 'p:roman' and by_user = $1", [U.R]))[0].n).toBe(1);
    expect((await rows("select user_id from public.vehicles where user_id = $1", [U.R])).length).toBe(1);
    expect((await call<Json>("R", "siosia_get_profile")).masterRole).toBe("driver");
  });

  it("two families refuse the merge and change nothing; plain accounts rewrite their settlement side", async () => {
    await absorb("K", "k1");
    expect(await code(absorb("K", "k2"))).toBe("two_families");
    expect((await rows("select deleted, merged_into from public.profiles where user_id = $1", [U.k2]))[0]).toEqual({ deleted: false, merged_into: null });
    expect(await whoami("k2")).toMatchObject({ member: true, hasProfile: true });
    // k2 leaves its family of two: then it merges, and its own side 'p:<uid>' follows the account
    await call("k2", "siosia_family_leave");
    await absorb("K", "k2");
    expect((await rows("select count(*)::int n from public.settlements where from_party = $1", [`p:${U.K}`]))[0].n).toBe(1);
  });

  it("a preview refuses what the merge would refuse (two families)", async () => {
    expect(await code(call("K", "siosia_absorb_preview", [await transfer("o1")]))).toBe("two_families");
  });

  it("an account keeps one realm: a fresh account takes the realm of what it absorbs", async () => {
    await absorb("S", "sb");
    expect(await whoami("S")).toMatchObject({ member: true, sandbox: true });
    expect(await code(absorb("S", "a1"))).toBe("other_realm");
  });

  it("two different master profiles refuse the merge", async () => {
    await call("Q", "siosia_join_master", [ROMAN, "dev-Q", "en", false]);
    await phone("x1", { master: TORIA });
    expect(await code(absorb("Q", "x1"))).toBe("two_masters");
  });

  it("an account on a master profile takes a plain phone's settlements onto its side (both columns)", async () => {
    await phone("x4", { nick: "Ksawery" });
    await h.admin("insert into public.settlements (kind, by_user, with_user, from_party, to_party, amount) values ('remind', $1, $1, $2, $2, 5)", [U.x4, `p:${U.x4}`]);
    await absorb("Q", "x4");
    expect((await rows("select from_party, to_party from public.settlements where by_user = $1", [U.Q]))[0]).toEqual({ from_party: "p:roman", to_party: "p:roman" });
  });

  it("a closed master link lets no new phone in and never counts as a failed attempt", async () => {
    await h.admin("update public.master_profiles set joinable = false where id = 'master'");
    expect(await call<Json>("T", "siosia_join_master", [TORIA, "dev-T", "en", false])).toMatchObject({ noop: true, masterId: "master" });
    expect(await code(call("Y", "siosia_join_master", [TORIA, "dev-Y", "en", false]))).toBe("bad_link");
    expect((await rows("select count(*)::int n from public.invite_failures where user_id = $1", [U.Y]))[0].n).toBe(0);
    // re-running set_master with the same token (a rename) keeps the link closed and the presets on
    await h.admin(`select public.siosia_set_master('master', '${TORIA}', 'Toria', null, 18, 'rider')`);
    expect((await rows("select joinable from public.master_profiles where id = 'master'"))[0].joinable).toBe(false);
    expect((await call<Json>("T", "siosia_get_profile")).fixedFare).toBe(18);
  });

  it("accounts mode: anonymous sessions must sign in, yet can still hand their account over", async () => {
    await h.admin("update public.app_config set auth_mode = 'accounts'");
    try {
      expect(await code(call("a1", "siosia_my_state"))).toBe("sign_in_required");
      expect(await h.as(U.a1, "select public.siosia_is_member('dev-a1')", [], claims("a1"))).toBe(false);
      expect(await whoami("a1")).toMatchObject({ member: false, hasProfile: true, anonymous: true, signInRequired: true });
      // no realtime, no photos for an anonymous session either
      expect(await h.as(U.x1, "select public.siosia_rt_can_read('drivers')", [], claims("x1"))).toBe(false);
      expect(await h.as(U.T, "select public.siosia_rt_can_read('drivers')", [], claims("T"))).toBe(true);
      expect(await h.as(U.x1, `select public.siosia_can_see_photo('profile/${pub.x1}/a.jpg')`, [], claims("x1"))).toBe(false);
      expect(await h.as(U.x1, `select public.siosia_photo_upload_ok('profile/${pub.x1}/a.jpg')`, [], claims("x1"))).toBe(false);
      expect(await h.as(U.x1, "select public.siosia_rt_can_write('drivers', 'presence')", [], claims("x1"))).toBe(false);
      expect(await h.as(U.T, `select public.siosia_photo_upload_ok('profile/${pub.t1}/a.jpg')`, [], claims("T"))).toBe(true);
      expect(await code(call("w1", "siosia_join", ["pilot 2026", "dev-w1"]))).toBe("sign_in_required");
      const res = await absorb("A", "a1");
      expect(res).toMatchObject({ nickname: "Ań", merge: { shape: "move" } });
      expect(((await call<Json>("A", "siosia_family")).members as Json[]).map((m) => m.nickname).sort()).toEqual(["Ań", "Karol", "Toria"]);
      // a signed-in account is unaffected
      expect(await code(call("T", "siosia_my_state"))).toBe("ok");
    } finally {
      await h.admin("update public.app_config set auth_mode = 'anonymous'");
    }
  });

  it("open membership: every signed-in account is a member, an anonymous session is not", async () => {
    await h.admin("update public.app_config set membership_mode = 'open'");
    try {
      expect(await whoami("w1")).toMatchObject({ member: false });
      expect(await whoami("Z")).toMatchObject({ member: true, hasProfile: false });
      await call("Z", "siosia_save_profile", ["Zenon", "en"]);
      expect(await code(call("Z", "siosia_my_state"))).toBe("ok");
    } finally {
      await h.admin("update public.app_config set membership_mode = 'invite'");
    }
  });

  it("after the migration nobody real is left on an anonymous account but test and spare phones", async () => {
    const left = (
      await rows(`select p.user_id from public.profiles p join auth.users u on u.id = p.user_id
                   where not p.deleted and u.is_anonymous and not public.siosia_sandbox(p.user_id) order by 1`)
    ).map((r) => name(r.user_id));
    expect(left).toEqual(["o1", "x1"]);
  });
});
