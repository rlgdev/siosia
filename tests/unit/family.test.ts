// Siosia 2.6 server rules in the engine (the SQL twin is tests/unit/sql-family.test.ts — same cases,
// V19): the family (V58), shared kids (V59) and appointments (V60), contracts (V61) and the price
// they set (V62), the cost summary (V63), the weekly report (V64) and its Monday notification (V65).

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent } from "../../src/core/engine";
import { ServerError, type AppointmentView, type ContractRate, type Place, type RepeatInput } from "../../src/core/types";

const MIN = 60_000;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const CFG: EngineConfig = { ...DEFAULT_CONFIG, services: DEFAULT_SERVICES, inviteCode: "PILOT" };

let db: DbState;
let now: number;
let pushes: PushEvent[];
let changed: string[];
const at = <T>(fn: (e: Engine) => T): T => {
  const e = new Engine(db, CFG, now);
  const out = fn(e);
  pushes.push(...e.effects.push);
  changed = [...e.effects.notify].sort();
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
const sent = () => pushes.map((p) => `${p.kind}>${p.userId}`);
/** Only the notifications of one kind (a jump of the clock also sends reminders). */
const sentOf = (kind: string) => sent().filter((s) => s.startsWith(`${kind}>`)).sort();

function user(uid: string, nick: string) {
  at((e) => e.join(uid, "pilot", `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
}
function request(uid: string, provider: string | null, startMin: number, o: { service?: string; duration?: number; repeat?: RepeatInput; kidIds?: string[] } = {}): AppointmentView {
  return at((e) =>
    e.requestService(uid, {
      serviceId: o.service ?? "childcare",
      providerId: provider === null ? null : pub(provider),
      startsAt: now + startMin * MIN,
      durationMin: o.duration ?? 180,
      place: HOME,
      note: "",
      repeat: o.repeat,
      kidIds: o.kidIds
    })
  );
}
const family = (uid: string) => at((e) => e.family(uid));
const invite = (from: string, to: string) => at((e) => e.inviteToFamily(from, pub(to)));
const join = (uid: string) => at((e) => e.answerInvite(uid, e.family(uid).incoming[0].id, "join"));
const couple = () => {
  invite("dad", "mum");
  join("mum");
  pushes = [];
};
const propose = (uid: string, to: string, as: "family" | "provider", rates: ContractRate[], note = "") => at((e) => e.proposeContract(uid, { to: pub(to), as, rates, note }));
const contracts = (uid: string) => at((e) => e.contracts(uid));
const getAppt = (uid: string, id: string) => at((e) => e.getAppointment(uid, id));
const sweep = () => at((e) => e.sweep());

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 20, 10, 0); // Tue 20 Oct 2026, 12:00 in Warsaw
  pushes = [];
  user("dad", "Roman");
  user("mum", "Anna");
  user("nanny", "Toria");
  user("other", "Ewa");
  at((e) => e.setOffers("nanny", ["learning", "childcare"]));
  at((e) => e.setOffers("mum", ["learning"]));
  pushes = [];
});

describe("family (FR-250–252, V58)", () => {
  it("invites a member, who joins; both see the family; the others are told", () => {
    expect(family("dad")).toEqual({ id: null, members: [], invites: [], incoming: [] });
    expect(code(() => at((e) => e.inviteToFamily("dad", "nope")))).toBe("not_found");
    expect(code(() => invite("dad", "dad"))).toBe("not_found");
    const f = invite("dad", "mum");
    expect(f.members.map((m) => [m.nickname, m.me])).toEqual([["Roman", true]]);
    expect(f.invites.map((i) => i.to.nickname)).toEqual(["Anna"]);
    expect(sent()).toEqual(["family_invite>mum"]);
    expect(pushes[0].params).toMatchObject({ sender: "Roman" });
    expect(changed).toEqual(["dad", "mum"]);
    // Inviting again is no second invitation.
    expect(invite("dad", "mum").invites).toHaveLength(1);
    expect(at((e) => e.myState("mum")).familyPending).toBe(1);
    expect(family("mum").incoming.map((i) => [i.from.nickname, i.expiresAt - i.createdAt])).toEqual([["Roman", 7 * 86_400_000]]);
    pushes = [];
    const joined = join("mum");
    expect(joined.members.map((m) => m.nickname)).toEqual(["Roman", "Anna"]);
    expect(joined.incoming).toEqual([]);
    expect(family("dad").invites).toEqual([]);
    expect(sent()).toEqual(["family_joined>dad"]);
    expect(at((e) => e.myState("mum")).familyPending).toBe(0);
    expect(JSON.stringify(family("dad"))).not.toMatch(/"(dad|mum|nanny)"/);
    expect(code(() => invite("mum", "dad"))).toBe("in_family");
  });

  it("declines, withdraws, lapses after 7 days; refuses someone in another family; at most 6", () => {
    invite("dad", "mum");
    at((e) => e.answerInvite("mum", e.family("mum").incoming[0].id, "decline"));
    expect(family("dad").invites).toEqual([]);
    expect(family("mum").id).toBeNull();
    const id = invite("dad", "mum").invites[0].id;
    expect(code(() => at((e) => e.withdrawInvite("mum", id)))).toBe("not_found");
    at((e) => e.withdrawInvite("dad", id));
    expect(family("mum").incoming).toEqual([]);
    expect(code(() => at((e) => e.answerInvite("mum", id, "join")))).toBe("illegal_transition");
    invite("dad", "mum");
    now += 7 * 86_400_000;
    expect(family("mum").incoming).toEqual([]);
    expect(code(() => at((e) => e.answerInvite("mum", db.familyInvites!.at(-1)!.id, "join")))).toBe("illegal_transition");
    // Ewa and Toria form a family; Ewa cannot join Roman's while she is in one with someone.
    invite("other", "nanny");
    join("nanny");
    invite("dad", "other");
    expect(code(() => join("other"))).toBe("in_family");
    for (const [u, n] of [["p1", "P1"], ["p2", "P2"], ["p3", "P3"], ["p4", "P4"], ["p5", "P5"], ["p6", "P6"]]) user(u, n);
    for (const u of ["p1", "p2", "p3", "p4", "p5"]) {
      invite("dad", u);
      join(u);
    }
    expect(family("dad").members).toHaveLength(6);
    expect(code(() => invite("dad", "p6"))).toBe("family_full");
  });

  it("leaving keeps the family for those left; the last one out ends it and its contracts", () => {
    couple();
    const c = propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }]);
    at((e) => e.answerContract("nanny", c.id, "accept"));
    pushes = [];
    expect(at((e) => e.leaveFamily("mum")).id).toBeNull();
    expect(family("dad").members.map((m) => m.nickname)).toEqual(["Roman"]);
    expect(contracts("dad")[0].status).toBe("active");
    expect(contracts("mum")).toEqual([]);
    at((e) => e.leaveFamily("dad"));
    expect(contracts("nanny")[0].status).toBe("ended");
    expect(sent()).toEqual(["contract_ended>nanny"]);
    expect(code(() => at((e) => e.leaveFamily("dad")))).toBe("not_found");
  });

  it("a family of one merges in: its contracts come along unless the new family has one with that provider", () => {
    const a = propose("mum", "nanny", "family", [{ serviceId: "childcare", perHour: 35 }]);
    at((e) => e.answerContract("nanny", a.id, "accept"));
    const solo = family("mum").id;
    invite("dad", "mum");
    join("mum");
    expect(db.families![solo!]).toBeUndefined();
    expect(contracts("dad").map((c) => [c.status, c.rates[0].perHour])).toEqual([["active", 35]]);
    // A second couple: both had a contract with Toria — the joiner's ends.
    user("x", "Xenia");
    user("y", "Yan");
    for (const [u, rate] of [["x", 10], ["y", 20]] as const) {
      const c = propose(u, "nanny", "family", [{ serviceId: "childcare", perHour: rate }]);
      at((e) => e.answerContract("nanny", c.id, "accept"));
    }
    invite("x", "y");
    join("y");
    expect(contracts("x").map((c) => [c.status, c.rates[0].perHour])).toEqual([["active", 10], ["ended", 20]]);
  });
});

describe("shared kids (FR-253, V59)", () => {
  it("every member sees, edits, removes and attaches the family's kids; the owner is kept", () => {
    const z = at((e) => e.addKid("dad", { name: "Zosia", bornYear: 2018, note: "" }));
    expect(code(() => at((e) => e.updateKid("mum", z.id, { name: "Zo", bornYear: 2018, note: "" })))).toBe("not_found");
    couple();
    expect(at((e) => e.kids("mum")).map((k) => [k.name, k.ownerNickname, k.mine])).toEqual([["Zosia", "Roman", false]]);
    const k = at((e) => e.addKid("mum", { name: "Kuba", bornYear: null, note: "" }));
    expect(changed).toEqual(["dad", "mum"]);
    expect(at((e) => e.kids("dad")).map((x) => x.name)).toEqual(["Zosia", "Kuba"]);
    at((e) => e.updateKid("mum", z.id, { name: "Zosia", bornYear: 2018, note: "Nut allergy" }));
    expect(db.kids![z.id]).toMatchObject({ ownerId: "dad", note: "Nut allergy" });
    expect(at((e) => e.setPhoto("mum", { kind: "kid", id: z.id }, "data:image/jpeg;base64,AAAA"))).toBe("data:image/jpeg;base64,AAAA");
    const a = request("mum", "nanny", 26 * 60, { kidIds: [z.id, k.id] });
    expect(a.kids.map((x) => x.name)).toEqual(["Zosia", "Kuba"]);
    expect(code(() => request("other", "nanny", 26 * 60, { kidIds: [z.id] }))).toBe("bad_input");
    // Leaving takes my own kids along; the attachment stays.
    at((e) => e.leaveFamily("mum"));
    expect(at((e) => e.kids("mum")).map((x) => x.name)).toEqual(["Kuba"]);
    expect(at((e) => e.kids("dad")).map((x) => x.name)).toEqual(["Zosia"]);
    expect(getAppt("nanny", a.id).kids.map((x) => x.name)).toEqual(["Zosia", "Kuba"]);
  });
});

describe("shared appointments (FR-254–256, V60)", () => {
  it("shows the other member's appointments, both roles, read-only, with the feed", () => {
    couple();
    const a = request("dad", "nanny", 26 * 60);
    expect(changed).toEqual(["dad", "mum", "nanny"]);
    const b = request("other", "mum", 50 * 60, { service: "learning", duration: 60 });
    const mumView = at((e) => e.planned("dad")).appointments;
    expect(mumView.map((x) => [x.id, x.role, x.family])).toEqual([
      [a.id, "client", null],
      [b.id, "family", { side: "provider", member: "Anna" }]
    ]);
    expect(getAppt("mum", a.id)).toMatchObject({ role: "family", family: { side: "client", member: "Roman" }, unread: 0, myRating: null });
    expect(code(() => getAppt("other", a.id))).toBe("not_found");
    // None of the actions.
    expect(code(() => at((e) => e.cancelAppointment("mum", a.id)))).toBe("not_found");
    expect(code(() => at((e) => e.answerAppointment("dad", b.id, "accept")))).toBe("not_found");
    expect(code(() => at((e) => e.setAppointmentKids("mum", a.id, [])))).toBe("forbidden");
    expect(code(() => at((e) => e.chat("mum", `appt:${a.id}`)))).toBe("not_found");
    // S1 counters stay personal: Anna's own request to answer, not Roman's appointment.
    expect(at((e) => e.myState("mum"))).toMatchObject({ planned: 1, toAnswer: 1 });
    // The feed: the client's family posts; a provider's update reaches both parents.
    at((e) => e.answerAppointment("nanny", a.id, "accept"));
    now = a.startsAt;
    pushes = [];
    at((e) => e.postUpdate("nanny", a.id, { text: "All good", kidId: null }));
    expect(sentOf("session_update")).toEqual(["session_update>dad", "session_update>mum"]);
    pushes = [];
    at((e) => e.postUpdate("mum", a.id, { text: "Thanks!", kidId: null }));
    expect(sentOf("session_update")).toEqual(["session_update>dad", "session_update>nanny"]);
    expect(at((e) => e.updates("dad", a.id)).items.map((u) => [u.author.nickname, u.text])).toEqual([
      ["Toria", "All good"],
      ["Anna", "Thanks!"]
    ]);
    // The provider's family reads, but does not post.
    at((e) => e.answerAppointment("mum", b.id, "accept"));
    now = b.startsAt;
    expect(at((e) => e.updates("dad", b.id)).items).toEqual([]);
    expect(code(() => at((e) => e.postUpdate("dad", b.id, { text: "hi", kidId: null })))).toBe("forbidden");
    // Roman's finished one is in Anna's history too.
    expect(at((e) => e.timeline("mum")).map((h) => (h.kind === "appointment" ? [h.appointment.id, h.appointment.role] : null))).toEqual([[a.id, "family"]]);
  });

  it("an open request of my family is mine to see, not to take", () => {
    couple();
    const o = request("dad", null, 26 * 60);
    expect(at((e) => e.planned("mum")).open).toEqual([]);
    expect(getAppt("mum", o.id).role).toBe("family");
    expect(code(() => at((e) => e.takeRequest("mum", o.id)))).toBe("forbidden");
  });
});

describe("contracts (FR-260–264, V61)", () => {
  it("proposes, the other side accepts; a newer proposal replaces the waiting one; accepting replaces the active one", () => {
    couple();
    for (const bad of [[], [{ serviceId: "childcare", perHour: -1 }], [{ serviceId: "childcare", perHour: 10001 }], [{ serviceId: "childcare", perHour: 1.005 }], [{ serviceId: "childcare", perHour: 4 }, { serviceId: "childcare", perHour: 5 }]])
      expect(code(() => propose("dad", "nanny", "family", bad as ContractRate[])), JSON.stringify(bad)).toBe("bad_input");
    expect(code(() => propose("dad", "nanny", "family", [{ serviceId: "ride", perHour: 4 }]))).toBe("not_offered");
    expect(code(() => propose("dad", "other", "family", [{ serviceId: "learning", perHour: 4 }]))).toBe("not_offered");
    expect(code(() => propose("dad", "mum", "family", [{ serviceId: "learning", perHour: 4 }]))).toBe("forbidden");
    expect(code(() => propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 4 }], "x".repeat(201)))).toBe("bad_input");
    const c1 = propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }], " evenings ");
    expect(c1).toMatchObject({ status: "proposed", side: "family", proposedByMe: true, canAnswer: false, version: 1, note: "evenings", currency: "PLN", family: ["Roman", "Anna"] });
    expect(sent()).toEqual(["contract_proposed>nanny"]);
    expect(at((e) => e.myState("nanny")).familyPending).toBe(1);
    expect(contracts("nanny")[0]).toMatchObject({ side: "provider", canAnswer: true, proposedByMe: false });
    expect(code(() => at((e) => e.answerContract("mum", c1.id, "accept")))).toBe("forbidden");
    expect(code(() => at((e) => e.answerContract("other", c1.id, "accept")))).toBe("not_found");
    const c2 = propose("mum", "nanny", "family", [{ serviceId: "childcare", perHour: 45 }, { serviceId: "learning", perHour: 50 }]);
    expect(contracts("dad").map((c) => [c.id, c.status])).toEqual([[c2.id, "proposed"], [c1.id, "withdrawn"]]);
    pushes = [];
    at((e) => e.answerContract("nanny", c2.id, "accept"));
    expect(sent().sort()).toEqual(["contract_accepted>dad", "contract_accepted>mum"]);
    // The provider proposes new rates; any family member accepts; the old one is replaced.
    const c3 = propose("nanny", "dad", "provider", [{ serviceId: "childcare", perHour: 50 }]);
    expect(c3.version).toBe(3);
    expect(code(() => at((e) => e.withdrawContract("dad", c3.id)))).toBe("forbidden");
    at((e) => e.answerContract("mum", c3.id, "accept"));
    expect(contracts("nanny").map((c) => [c.version, c.status])).toEqual([[3, "active"], [2, "replaced"], [1, "withdrawn"]]);
    pushes = [];
    at((e) => e.endContract("dad", c3.id));
    expect(sent()).toEqual(["contract_ended>nanny"]);
    expect(code(() => at((e) => e.endContract("dad", c3.id)))).toBe("illegal_transition");
    // A provider proposing to someone without a family makes them one of their own.
    const c4 = propose("nanny", "other", "provider", [{ serviceId: "learning", perHour: 30 }]);
    expect(family("other").members.map((m) => m.nickname)).toEqual(["Ewa"]);
    at((e) => e.answerContract("other", c4.id, "decline"));
    expect(sent()).toContain("contract_declined>nanny");
    const c5 = propose("nanny", "other", "provider", [{ serviceId: "learning", perHour: 30 }]);
    at((e) => e.withdrawContract("nanny", c5.id));
    expect(contracts("other").map((c) => c.status)).toEqual(["withdrawn", "declined"]);
  });
});

describe("price and cost (FR-262, FR-270–273, V62, V63)", () => {
  const accepted = (uid: string, provider: string, o: Parameters<typeof request>[3] = {}) => {
    const a = request(uid, provider, 26 * 60, o);
    at((e) => e.answerAppointment(provider, a.id, "accept"));
    return a;
  };
  it("a contract sets the rate of new requests from any family member; the catalog price otherwise", () => {
    couple();
    const before = request("dad", "nanny", 26 * 60);
    expect(before).toMatchObject({ price: null, rate: null, contractId: null });
    const c = propose("nanny", "mum", "provider", [{ serviceId: "childcare", perHour: 40 }]);
    at((e) => e.answerContract("dad", c.id, "accept"));
    expect(at((e) => e.catalog("mum")).find((x) => x.id === "childcare")!.providers[0]).toMatchObject({ nickname: "Toria", contractRate: 40 });
    expect(at((e) => e.catalog("other")).find((x) => x.id === "childcare")!.providers[0].contractRate).toBeNull();
    const a = request("mum", "nanny", 30 * 60, { duration: 150 });
    expect(a).toMatchObject({ price: 100, rate: 40, contractId: c.id });
    expect(request("dad", "nanny", 50 * 60, { service: "learning", duration: 60 })).toMatchObject({ price: null, rate: null });
    const s = request("dad", "nanny", 70 * 60, { duration: 60, repeat: { every: 1, count: 3 } });
    expect(Object.values(db.appointments!).filter((x) => x.seriesId === s.series!.id).map((x) => x.price)).toEqual([40, 40, 40]);
    // Ending keeps the frozen prices.
    at((e) => e.endContract("dad", c.id));
    expect(getAppt("dad", a.id).price).toBe(100);
    expect(getAppt("dad", before.id).price).toBeNull();
  });

  it("an open request is repriced at the taker's contract", () => {
    const c = propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 30 }]);
    at((e) => e.answerContract("nanny", c.id, "accept"));
    const o = request("dad", null, 26 * 60, { duration: 120 });
    expect(o.price).toBeNull();
    expect(at((e) => e.takeRequest("nanny", o.id))).toMatchObject({ price: 60, rate: 30, contractId: c.id });
  });

  it("summarises a done appointment once, to both parents and the provider; the provider corrects the time within 24 h", () => {
    couple();
    const c = propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }]);
    at((e) => e.answerContract("nanny", c.id, "accept"));
    const a = accepted("dad", "nanny");
    expect(getAppt("dad", a.id).cost).toBeNull();
    pushes = [];
    now = a.endsAt;
    sweep();
    expect(getAppt("mum", a.id).cost).toEqual({ minutes: 180, rate: 40, total: 120, currency: "PLN", source: "contract", corrected: false });
    expect(sent().sort()).toEqual(["appt_summary>dad", "appt_summary>mum", "appt_summary>nanny"]);
    expect(pushes[0].params).toMatchObject({ minutes: 180, total: 120, currency: "PLN", corrected: false });
    sweep();
    expect(pushes).toHaveLength(3);
    for (const bad of [10, 1441, 200, 90.5]) expect(code(() => at((e) => e.setActualTime("nanny", a.id, bad)))).toBe("bad_input");
    expect(code(() => at((e) => e.setActualTime("dad", a.id, 240)))).toBe("forbidden");
    expect(code(() => at((e) => e.setActualTime("other", a.id, 240)))).toBe("not_found");
    pushes = [];
    expect(at((e) => e.setActualTime("nanny", a.id, 240)).cost).toMatchObject({ minutes: 240, total: 160, corrected: true });
    expect(sent().sort()).toEqual(["appt_summary>dad", "appt_summary>mum"]);
    expect(at((e) => e.setActualTime("nanny", a.id, 180)).cost).toMatchObject({ minutes: 180, total: 120, corrected: false });
    now += 24 * 3600_000 + 1;
    expect(code(() => at((e) => e.setActualTime("nanny", a.id, 240)))).toBe("window_closed");
    // Without a price: the time, no total, no notification.
    const b = accepted("other", "nanny");
    pushes = [];
    now = b.endsAt;
    sweep();
    expect(getAppt("other", b.id).cost).toEqual({ minutes: 180, rate: null, total: null, currency: "PLN", source: "none", corrected: false });
    expect(sent()).toEqual([]);
  });
});

describe("weekly report (FR-280–283, V64, V65)", () => {
  it("sums one week's spent and earned, per person or for the family; rides count by their end", () => {
    couple();
    const c = propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }, { serviceId: "learning", perHour: 60 }]);
    at((e) => e.answerContract("nanny", c.id, "accept"));
    const a1 = request("dad", "nanny", 26 * 60); // Wed 21 Oct, 180 min → 120
    const a2 = request("mum", "nanny", 50 * 60, { service: "learning", duration: 90 }); // Thu → 90
    const a3 = request("other", "mum", 74 * 60, { service: "learning", duration: 60 }); // Fri, no price
    for (const [p, a] of [["nanny", a1], ["nanny", a2], ["mum", a3]] as const) at((e) => e.answerAppointment(p, a.id, "accept"));
    const next = request("dad", "nanny", 7 * 24 * 60); // next week
    at((e) => e.answerAppointment("nanny", next.id, "accept"));
    now += 8 * 24 * 60 * MIN;
    sweep();
    at((e) => e.setActualTime("nanny", next.id, 120));
    const week = "2026-10-19";
    const me = at((e) => e.report("dad", week, "me"));
    expect(me).toMatchObject({ week, scope: "me", hasFamily: true, currency: "PLN", net: -120, members: null });
    expect(me.spent).toEqual({ total: 120, servicesTotal: 120, services: [{ who: "Toria", serviceId: "childcare", count: 1, minutes: 180, total: 120 }], rides: { count: 0, total: 0 } });
    expect(me.earned.total).toBe(0);
    const fam = at((e) => e.report("mum", "2026-10-22", "family"));
    expect(fam.week).toBe(week);
    expect(fam.spent.services.map((l) => [l.who, l.serviceId, l.total])).toEqual([
      ["Toria", "childcare", 120],
      ["Toria", "learning", 90]
    ]);
    expect(fam.earned.services).toEqual([{ who: "Ewa", serviceId: "learning", count: 1, minutes: 60, total: 0 }]);
    expect(fam.members).toEqual([
      { nickname: "Roman", spent: 120, earned: 0 },
      { nickname: "Anna", spent: 90, earned: 0 }
    ]);
    expect(at((e) => e.report("nanny", week, "family"))).toMatchObject({ scope: "me", hasFamily: false, earned: { total: 210 } });
    expect(at((e) => e.report("dad", null, "me")).spent.services[0]).toMatchObject({ minutes: 120, total: 80 });
    for (const bad of ["2026-13-01", "x", "2025-10-01", "2026-11-30"]) expect(code(() => at((e) => e.report("dad", bad, "me"))), bad).toBe("bad_input");
  });

  it("tells everyone with something last week on Monday from 08:00, once", () => {
    const a = request("dad", "nanny", 26 * 60);
    at((e) => e.answerAppointment("nanny", a.id, "accept"));
    db.reportWeek = "2026-10-19";
    now = Date.UTC(2026, 9, 26, 6, 59); // Mon 26 Oct 07:59 in Warsaw (CET after the DST change)
    pushes = [];
    sweep();
    expect(sent().filter((s) => s.startsWith("weekly"))).toEqual([]);
    now += 60_000;
    sweep();
    expect(sent().filter((s) => s.startsWith("weekly")).sort()).toEqual(["weekly_report>dad", "weekly_report>nanny"]);
    expect(pushes.find((p) => p.kind === "weekly_report" && p.userId === "dad")!.params).toMatchObject({ spent: 0, earned: 0, week: "2026-10-19", currency: "PLN" });
    sweep();
    expect(pushes.filter((p) => p.kind === "weekly_report")).toHaveLength(2);
    expect(db.reportWeek).toBe("2026-10-26");
  });
});

describe("delete and move (V49, FR-263)", () => {
  it("a deleted provider's contracts end; a deleted member leaves; the move re-keys the family", () => {
    couple();
    const c = propose("dad", "nanny", "family", [{ serviceId: "childcare", perHour: 40 }]);
    at((e) => e.answerContract("nanny", c.id, "accept"));
    pushes = [];
    at((e) => e.deleteProfile("nanny"));
    expect(contracts("dad")[0].status).toBe("ended");
    expect(sent().filter((s) => s.startsWith("contract")).sort()).toEqual(["contract_ended>dad", "contract_ended>mum"]);
    const { code: moveCode } = at((e) => e.createTransfer("mum"));
    at((e) => e.redeemTransfer("mum2", moveCode, "dev-mum2"));
    expect(family("dad").members.map((m) => [m.nickname, m.me])).toEqual([["Roman", true], ["Anna", false]]);
    expect(family("mum2").members.find((m) => m.me)!.nickname).toBe("Anna");
    at((e) => e.deleteProfile("mum2"));
    expect(family("dad").members.map((m) => m.nickname)).toEqual(["Roman"]);
  });
});
