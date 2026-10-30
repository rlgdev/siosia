// Siosia 2.12 accounts in the engine (the SQL twin is tests/unit/sql-accounts.test.ts — same cases
// where the engine knows the rule, V19): one account per person on every phone. A phone signs in and
// hands the account it used before to the signed-in one (absorb); nothing of either is lost; two
// families, two master profiles or two realms refuse; a merged-away account is frozen and its phone
// is sent to sign in; a closed master link lets no new phone in (FR-326–FR-331, V81–V85).

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type MasterProfile } from "../../src/core/engine";
import { ServerError } from "../../src/core/types";

const TORIA: MasterProfile = { id: "master", token: "toria-link-token-0001", nickname: "Toria", icon: null, fixedFare: 18, role: "rider" };
const ROMAN: MasterProfile = {
  id: "roman",
  token: "roman-link-token-0001",
  nickname: "Roman",
  icon: null,
  fixedFare: null,
  role: "driver",
  vehicle: { make: "Porsche", model: "Taycan", colour: "Zielony", seats: 4, plate: "W1LLRUN" },
  offers: ["childcare"]
};

let db: DbState;
let now: number;
let cfg: EngineConfig;
const at = <T>(fn: (e: Engine) => T): T => fn(new Engine(db, cfg, now));
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof ServerError ? e.code : String(e);
  }
};
const pub = (uid: string) => db.users[uid]?.publicId ?? "";
const transfer = (uid: string) => at((e) => e.createTransfer(uid)).code;
const absorb = (into: string, from: string) => at((e) => e.absorb(into, transfer(from), `dev-${into}`));
const whoami = (uid: string) => at((e) => e.whoami(uid, `dev-${uid}`));
const kids = (uid: string) => at((e) => e.kids(uid)).map((k) => k.name).sort();
const members = (uid: string) => at((e) => e.family(uid)).members.map((m) => m.nickname).sort();
const joinFamily = (uid: string) => at((e) => e.answerInvite(uid, at((x) => x.family(uid)).incoming[0].id, "join"));

function phone(uid: string, how: { master?: MasterProfile; invite?: string; nick?: string }) {
  if (how.master) at((e) => e.joinMaster(uid, how.master!.token, `dev-${uid}`, "en"));
  else {
    at((e) => e.join(uid, how.invite ?? "pilot", `dev-${uid}`));
    at((e) => e.saveProfile(uid, how.nick ?? uid, "en"));
  }
}

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 30, 10, 0);
  cfg = { ...DEFAULT_CONFIG, services: DEFAULT_SERVICES, inviteCode: "PILOT", testInviteCode: "SMOKE TEST", masters: [{ ...TORIA }, { ...ROMAN }] };
  for (const u of ["r1", "r2"]) phone(u, { master: ROMAN });
  for (const u of ["t1", "t2", "t3"]) phone(u, { master: TORIA });
  phone("k1", { nick: "Karol" });
  phone("k2", { nick: "Karol" });
  phone("a1", { nick: "Ań" });
  phone("o1", { nick: "Ola" });
  phone("sb", { invite: "smoke test", nick: "Smoke" });
  at((e) => e.inviteToFamily("t1", pub("a1")));
  joinFamily("a1");
  at((e) => e.inviteToFamily("t1", pub("k1")));
  joinFamily("k1");
  at((e) => e.inviteToFamily("k2", pub("o1")));
  joinFamily("o1");
  const c = at((e) => e.proposeContract("t1", { to: pub("r1"), as: "family", rates: [{ serviceId: "childcare", perHour: 40 }], note: "" }));
  at((e) => e.answerContract("r1", c.id, "accept"));
  at((e) => e.addKid("t1", { name: "Ola", bornYear: 2019, note: "" }));
  at((e) => e.addKid("t2", { name: "Zosia", bornYear: 2021, note: "" }));
  (db.settlements ??= []).push({
    id: "s1", kind: "remind", byUser: "k2", withUser: "o1", fromParty: "p:k2", toParty: "p:o1",
    amount: 30, itemCount: 1, createdAt: now, comment: null, commentBy: null, commentAt: null
  });
});

describe("2.12 accounts in the engine (FR-326–FR-331, V81–V85)", () => {
  it("membership is the person's; whoami routes every session", () => {
    expect(at((e) => e.isMember("t1"))).toBe(true);
    expect(whoami("t1")).toMatchObject({ member: true, hasProfile: true, anonymous: false, mergedInto: null, sandbox: false });
    expect(whoami("T")).toMatchObject({ member: false, hasProfile: false, mergedInto: null });
    expect(code(() => at((e) => e.myState("T")))).toBe("not_member");
  });

  it("a wrong code is refused and counted", () => {
    expect(code(() => at((e) => e.absorb("T", "WRON-GCOD", "dev-T")))).toBe("bad_transfer");
    expect(db.inviteFails.T).toHaveLength(1);
  });

  it("the first phone moves the whole profile: public id, master profile, family, contract, kids", () => {
    const before = pub("t1");
    const p = absorb("T", "t1");
    expect(p).toMatchObject({ publicId: before, nickname: "Toria", masterId: "master", fixedFare: 18 });
    expect(whoami("T")).toMatchObject({ member: true, hasProfile: true });
    expect(members("T")).toEqual(["Ań", "Karol", "Toria"]);
    expect(kids("T")).toEqual(["Ola"]);
    expect([...Object.keys(db.linkMembers?.T ?? {})].sort()).toEqual(["dev-T", "dev-t1"]);
    // the old account is frozen and its phone sent to sign in, not to the invite code
    expect(whoami("t1")).toMatchObject({ member: false, hasProfile: false, mergedInto: before });
    expect(code(() => at((e) => e.myState("t1")))).toBe("account_merged");
    expect(code(() => at((e) => e.join("t1", "pilot", "dev-t1")))).toBe("already_merged");
  });

  it("another phone of the person merges in and nothing is lost", () => {
    absorb("T", "t1");
    absorb("T", "t2");
    expect(kids("T")).toEqual(["Ola", "Zosia"]);
    expect(db.users.t2).toMatchObject({ deleted: true, mergedInto: "T" });
    expect(whoami("t2")).toMatchObject({ mergedInto: pub("T") });
    expect(code(() => absorb("T", "t2"))).toBe("account_merged");
  });

  it("the operator merges a phone gone (by account, here)", () => {
    absorb("T", "t1");
    absorb("T", "t2");
    expect(at((e) => e.mergeAccounts("t3", "T", "operator"))).toBe("merge");
    expect(Object.values(db.users).filter((u) => u.masterId === "master" && !u.deleted)).toHaveLength(1);
  });

  it("the provider's phones become one account; the contract stays", () => {
    absorb("R", "r1");
    absorb("R", "r2");
    expect(at((e) => e.contracts("R")).filter((c) => c.status === "active")).toHaveLength(1);
    expect(db.vehicles.R).toBeTruthy();
    expect(at((e) => e.getProfile("R"))!.masterRole).toBe("driver");
  });

  it("two families refuse the merge and change nothing; a plain account's settlement side follows it", () => {
    absorb("K", "k1");
    expect(code(() => absorb("K", "k2"))).toBe("two_families");
    expect(db.users.k2).toMatchObject({ deleted: false });
    expect(whoami("k2")).toMatchObject({ member: true, hasProfile: true });
    at((e) => e.leaveFamily("k2"));
    absorb("K", "k2");
    expect(db.settlements!.find((s) => s.id === "s1")!.fromParty).toBe("p:K");
  });

  it("an account keeps one realm: a fresh account takes the realm of what it absorbs", () => {
    absorb("S", "sb");
    expect(whoami("S")).toMatchObject({ member: true, sandbox: true });
    expect(code(() => absorb("S", "a1"))).toBe("other_realm");
  });

  it("two different master profiles refuse the merge", () => {
    at((e) => e.joinMaster("Q", ROMAN.token, "dev-Q", "en"));
    phone("x1", { master: TORIA });
    expect(code(() => absorb("Q", "x1"))).toBe("two_masters");
  });

  it("a closed master link lets no new phone in and never counts as a failed attempt", () => {
    absorb("T", "t1");
    cfg = { ...cfg, masters: [{ ...TORIA, joinable: false }, { ...ROMAN }] };
    expect(at((e) => e.joinMaster("T", TORIA.token, "dev-T", "en"))).toMatchObject({ noop: true, masterId: "master" });
    expect(code(() => at((e) => e.joinMaster("Y", TORIA.token, "dev-Y", "en")))).toBe("bad_link");
    expect(db.inviteFails.Y ?? []).toHaveLength(0);
    expect(at((e) => e.getProfile("T"))!.fixedFare).toBe(18);
  });

  it("open membership: every account is a member", () => {
    cfg = { ...cfg, membershipMode: "open" };
    expect(whoami("Z")).toMatchObject({ member: true, hasProfile: false });
    at((e) => e.saveProfile("Z", "Zenon", "en"));
    expect(code(() => at((e) => e.myState("Z")))).toBe("ok");
  });

  it("a move code never moves an account others were merged into; whoami gives my public id and records ≤ 20 phones", () => {
    absorb("T", "t1");
    absorb("T", "t2");
    expect(code(() => at((e) => e.redeemTransfer("u1", transfer("T"), "dev-u1")))).toBe("sign_in_instead");
    expect(whoami("T").publicId).toBe(pub("T"));
    for (let i = 0; i < 25; i++) at((e) => e.whoami("T", `spam-${i}`));
    expect((db.members.T ?? []).length + Object.keys(db.linkMembers?.T ?? {}).length).toBeLessThanOrEqual(20);
  });

  it("an account others were merged into never takes a move code; an expired code is just expired", () => {
    absorb("T", "t1");
    expect(code(() => at((e) => e.redeemTransfer("T", transfer("o1"), "dev-T", true)))).toBe("use_merge");
    const c = transfer("T");
    now += 31 * 60_000;
    expect(code(() => at((e) => e.redeemTransfer("u1", c, "dev-u1")))).toBe("bad_transfer");
  });

  it("the invite code records at most 20 phones; a preview refuses what the merge would", () => {
    for (let i = 0; i < 25; i++) at((e) => e.join("j1", "pilot", `j-${i}`));
    expect(db.members.j1).toHaveLength(20);
    absorb("K", "k1");
    expect(code(() => at((e) => e.absorbPreview("K", transfer("k2"))))).toBe("two_families");
  });

  it("an account on a master profile takes a plain phone's settlements onto its side (both columns)", () => {
    at((e) => e.joinMaster("Q", ROMAN.token, "dev-Q", "en"));
    phone("x4", { nick: "Ksawery" });
    db.settlements!.push({ id: "s4", kind: "remind", byUser: "x4", withUser: "x4", fromParty: "p:x4", toParty: "p:x4", amount: 5, itemCount: 1, createdAt: now, comment: null, commentBy: null, commentAt: null });
    absorb("Q", "x4");
    expect(db.settlements!.find((s) => s.id === "s4")).toMatchObject({ fromParty: "p:roman", toParty: "p:roman" });
  });

  it("a typed code shows whose account it is first and is not spent by looking", () => {
    expect(code(() => at((e) => e.absorbPreview("P", "WRON-GCOD")))).toBe("bad_transfer");
    expect(db.inviteFails.P).toHaveLength(1);
    const c = transfer("o1");
    expect(at((e) => e.absorbPreview("P", c))).toEqual({ nickname: "Ola", publicId: pub("o1"), family: true, master: false });
    expect(at((e) => e.absorb("P", c, "dev-P", false))).toMatchObject({ nickname: "Ola" });
  });

  it("the survivor's settlement side holds every key of both accounts", () => {
    phone("x2", { nick: "Xawery" });
    phone("x3", { master: ROMAN });
    db.settlements!.push({ id: "s2", kind: "remind", byUser: "x2", withUser: "x3", fromParty: "p:x2", toParty: "p:roman", amount: 10, itemCount: 1, createdAt: now, comment: null, commentBy: null, commentAt: null });
    absorb("M", "x2");
    expect(db.settlements!.find((s) => s.id === "s2")!.fromParty).toBe("p:M");
    absorb("M", "x3");
    expect(db.settlements!.find((s) => s.id === "s2")!.fromParty).toBe("p:roman");
  });
});
