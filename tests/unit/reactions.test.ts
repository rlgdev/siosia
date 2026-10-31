// Siosia 2.12.3 server rules in the engine (the SQL twin is tests/unit/sql-reactions.test.ts — same
// cases, V19): reactions on chat messages and session updates (FR-330–332, V88) — the fixed set, one
// per person per item, who may react and when, the one notification per person per item, the rate,
// and the reactions' life with the account (move, merge, delete) and with their item.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SERVICES } from "../../src/core/defaults";
import { Engine, emptyDb, type DbState, type EngineConfig, type PushEvent } from "../../src/core/engine";
import { REACTIONS } from "../../src/core/reactions";
import { ServerError, type AppointmentView, type ChatRoom, type Place } from "../../src/core/types";

const MIN = 60_000;
const H = 60 * MIN;
const HOME: Place = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };
const CFG: EngineConfig = { ...DEFAULT_CONFIG, services: DEFAULT_SERVICES, inviteCode: "PILOT" };
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z";

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
function user(uid: string, nick: string) {
  at((e) => e.join(uid, "pilot", `dev-${uid}`));
  at((e) => e.saveProfile(uid, nick, "en"));
}
const join = (from: string, to: string) => {
  at((e) => e.inviteToFamily(from, pub(to)));
  at((e) => e.answerInvite(to, e.family(to).incoming[0].id, "join"));
};
const send = (uid: string, room: ChatRoom, text: string) => at((e) => e.sendMessage(uid, room, text));
const chat = (uid: string, room: ChatRoom, markRead = false) => at((e) => e.chat(uid, room, markRead));
const post = (uid: string, id: string, text: string, photo: string | null = null) => at((e) => e.postUpdate(uid, id, { text, kidId: null }, photo));
const feed = (uid: string, id: string, seen = false) => at((e) => e.updates(uid, id, seen));
const reactM = (uid: string, id: string, emoji: string | null) => at((e) => e.reactMessage(uid, id, emoji));
const reactU = (uid: string, id: string, emoji: string | null) => at((e) => e.reactUpdate(uid, id, emoji));

/** An accepted childcare of Toria with Siosia, starting in 20 min (the feed and the room are open). */
function session(): AppointmentView {
  const a = at((e) =>
    e.requestService("client", { serviceId: "childcare", providerId: pub("siosia"), startsAt: now + 31 * MIN, durationMin: 180, place: HOME, note: "" })
  );
  at((e) => e.answerAppointment("siosia", a.id, "accept"));
  now += 11 * MIN;
  pushes = [];
  return at((e) => e.getAppointment("client", a.id));
}

beforeEach(() => {
  db = emptyDb();
  now = Date.UTC(2026, 9, 20, 10, 0); // Tue 20 Oct 2026, 12:00 in Warsaw
  pushes = [];
  user("client", "Toria");
  user("siosia", "Siosia");
  user("mum", "Anna"); // Toria's family
  user("kasia", "Kasia"); // Siosia's family
  user("other", "Ewa");
  at((e) => e.setOffers("siosia", ["childcare"]));
  join("client", "mum");
  join("siosia", "kasia");
  pushes = [];
});

describe("reactions on chat messages (2.12.3: FR-330, FR-331, V88)", () => {
  it("one emoji per person from the fixed set; the author hears once; both parties refetch", () => {
    const a = session();
    const room: ChatRoom = `appt:${a.id}`;
    const m = send("client", room, "Kids are asleep");
    pushes = [];
    for (const bad of ["x", "❤", "🎃", "", "❤️❤️"]) expect(code(() => reactM("siosia", m.id, bad)), bad).toBe("bad_input");
    expect(code(() => reactM("siosia", "m-none", "❤️"))).toBe("not_found");
    // A room is its two parties': not a family member, not another member.
    expect(code(() => reactM("mum", m.id, "❤️"))).toBe("not_found");
    expect(code(() => reactM("other", m.id, "❤️"))).toBe("not_found");
    const r1 = reactM("siosia", m.id, "❤️");
    expect(r1).toMatchObject({ id: m.id, mine: false, text: "Kids are asleep", reactions: [{ emoji: "❤️", count: 1, mine: true, names: [] }] });
    expect(changed).toEqual(["client", "siosia"]);
    expect(pushes).toEqual([
      { userId: "client", kind: "reaction", rideId: null, appointmentId: a.id, params: { sender: "Siosia", emoji: "❤️", text: "Kids are asleep", room, messageId: m.id } }
    ]);
    // Reacting to my own message is fine and tells nobody; the order is the set's, not the time's.
    pushes = [];
    now += MIN;
    reactM("client", m.id, "👍");
    now += MIN;
    expect(pushes).toEqual([]);
    expect(chat("client", room).messages[0].reactions).toEqual([
      { emoji: "❤️", count: 1, mine: false, names: ["Siosia"] },
      { emoji: "👍", count: 1, mine: true, names: [] }
    ]);
    // A change, taking it back, setting it again: never a second notification.
    expect(reactM("siosia", m.id, "👍").reactions).toEqual([{ emoji: "👍", count: 2, mine: true, names: ["Toria"] }]);
    expect(reactM("siosia", m.id, "👍").reactions).toEqual([{ emoji: "👍", count: 2, mine: true, names: ["Toria"] }]); // the same again: nothing
    expect(reactM("siosia", m.id, null).reactions).toEqual([{ emoji: "👍", count: 1, mine: false, names: ["Toria"] }]);
    expect(reactM("siosia", m.id, null).reactions).toEqual([{ emoji: "👍", count: 1, mine: false, names: ["Toria"] }]);
    now += MIN;
    expect(reactM("siosia", m.id, "😂").reactions.map((r) => r.emoji)).toEqual(["👍", "😂"]);
    expect(pushes).toEqual([]);
    expect(REACTIONS).toEqual(["❤️", "👍", "😂", "😮", "😢", "🙏"]);
    // A push only, like a chat message: never a bell entry (V73).
    expect((db.notifications ?? []).filter((n) => n.kind === "reaction")).toEqual([]);
  });

  it("no notification to an author who has the thread open; read-only 24 h after the end", () => {
    const a = session();
    const room: ChatRoom = `appt:${a.id}`;
    const m = send("siosia", room, "On my way");
    chat("siosia", room, true); // Siosia looks at the thread
    pushes = [];
    reactM("client", m.id, "🙏");
    expect(pushes).toEqual([]);
    expect(chat("siosia", room).messages[0].reactions).toEqual([{ emoji: "🙏", count: 1, mine: false, names: ["Toria"] }]);
    // Done at the end; the room stays open 24 h, then reactions are refused as messages are.
    now = a.endsAt;
    at((e) => e.sweep());
    now += 24 * H;
    expect(reactM("client", m.id, "❤️").reactions[0].emoji).toBe("❤️");
    now += MIN;
    expect(code(() => reactM("client", m.id, null))).toBe("illegal_transition");
  });

  it("at most 60 new items reacted to in 10 minutes; changing one already set is never refused", () => {
    const a = session();
    const room: ChatRoom = `appt:${a.id}`;
    const ids = Array.from({ length: 61 }, (_, i) => {
      const id = `m-rate-${i}`;
      db.messages!.push({ id, room, sender: "client", text: `n${i}`, sentAt: now, readAt: null });
      return id;
    });
    for (const id of ids.slice(0, 60)) reactM("siosia", id, "❤️");
    expect(code(() => reactM("siosia", ids[60], "❤️"))).toBe("too_many");
    expect(reactM("siosia", ids[0], "👍").reactions[0].emoji).toBe("👍");
    now += 10 * MIN + 1;
    expect(reactM("siosia", ids[60], "❤️").reactions[0].emoji).toBe("❤️");
    // Later, changing or taking back the old ones is no new item: a new one is still welcome.
    now += 11 * MIN;
    for (const id of ids.slice(0, 60)) reactM("siosia", id, null);
    db.messages!.push({ id: "m-rate-new", room, sender: "client", text: "new", sentAt: now, readAt: null });
    expect(reactM("siosia", "m-rate-new", "😮").reactions[0].emoji).toBe("😮");
  });
});

describe("reactions on session updates (2.12.3: FR-330, FR-331, V88)", () => {
  it("who may post may react — the parties and the client's family — while the feed is open; the author hears once", () => {
    const a = session();
    const u = post("siosia", a.id, "", JPEG); // a photo, no words
    pushes = [];
    expect(code(() => reactU("kasia", u.id, "❤️"))).toBe("forbidden"); // Siosia's family reads, never writes
    expect(code(() => reactU("other", u.id, "❤️"))).toBe("not_found");
    expect(code(() => reactU("mum", "u-none", "❤️"))).toBe("not_found");
    expect(code(() => reactU("mum", u.id, "🎃"))).toBe("bad_input");
    const x = reactU("mum", u.id, "❤️");
    expect(x).toMatchObject({ id: u.id, reactions: [{ emoji: "❤️", count: 1, mine: true, names: [] }] });
    expect(changed).toEqual(["client", "kasia", "mum", "siosia"]); // every viewer of the feed refetches
    expect(pushes).toEqual([
      { userId: "siosia", kind: "reaction", rideId: null, appointmentId: a.id, params: { sender: "Anna", emoji: "❤️", text: "", photo: true, kid: null, updateId: u.id } }
    ]);
    now += MIN;
    pushes = [];
    reactU("client", u.id, "❤️");
    expect(pushes.map((p) => p.userId)).toEqual(["siosia"]); // Toria's own first reaction tells Siosia too
    // Everyone who reads the feed sees who: the provider's family too (read-only).
    expect(feed("kasia", a.id).items[0].reactions).toEqual([{ emoji: "❤️", count: 2, mine: false, names: ["Anna", "Toria"] }]);
    expect(feed("client", a.id).items[0].reactions).toEqual([{ emoji: "❤️", count: 2, mine: true, names: ["Anna"] }]);
    // The author with the feed in front: no notification.
    const u2 = post("siosia", a.id, "Painting now");
    feed("siosia", a.id, true);
    pushes = [];
    reactU("client", u2.id, "😂");
    expect(pushes).toEqual([]);
    // Deleting the update takes its reactions.
    at((e) => e.deleteUpdate("siosia", u2.id));
    expect(db.reactions!.some((r) => r.updateId === u2.id)).toBe(false);
    // Someone who left the family is not told of reactions on what they wrote (they no longer see the feed).
    const note = post("mum", a.id, "Hello from granny");
    at((e) => e.leaveFamily("mum"));
    pushes = [];
    reactU("client", note.id, "❤️");
    expect(pushes).toEqual([]);
    expect(code(() => feed("mum", a.id))).toBe("not_found");
    // The feed closes 7 days after the end: reactions with it.
    now = a.endsAt;
    at((e) => e.sweep());
    now += 7 * 24 * H + MIN;
    expect(code(() => reactU("client", u.id, "👍"))).toBe("illegal_transition");
    expect(feed("client", a.id).items[0].reactions[0].count).toBe(2); // still shown
  });
});

describe("reactions and the account (2.12.3: V88 with V49, V82)", () => {
  it("a merge keeps into's reaction on an item both reacted to and moves the rest; a deleted profile's reactions go, and those on what it wrote", () => {
    const a = session();
    const room: ChatRoom = `appt:${a.id}`;
    const u1 = post("siosia", a.id, "Lunch");
    const u2 = post("siosia", a.id, "Nap");
    reactU("client", u1.id, "👍");
    reactU("mum", u1.id, "❤️");
    reactU("mum", u2.id, "😮");
    const rows = () => db.reactions!.map((r) => `${r.userId}:${r.messageId ?? r.updateId}:${r.emoji}`).sort();
    // A move to a new phone takes them along.
    const { code: move } = at((e) => e.createTransfer("mum"));
    at((e) => e.redeemTransfer("app", move, "dev-app"));
    expect(rows()).toEqual([`app:${u1.id}:❤️`, `app:${u2.id}:😮`, `client:${u1.id}:👍`].sort());
    // A merge: into's reaction stays where both reacted, the rest moves.
    at((e) => e.mergeAccounts("app", "client", "operator"));
    expect(rows()).toEqual([`client:${u1.id}:👍`, `client:${u2.id}:😮`].sort());
    // Deleting a profile: Siosia's updates go, and every reaction on them; Siosia's own reactions too.
    const m = send("client", room, "Thanks!");
    reactM("siosia", m.id, "🙏");
    expect(rows()).toHaveLength(3);
    at((e) => e.deleteProfile("siosia"));
    expect(db.reactions).toEqual([]);
  });

  it("a ride's thread that starts afresh for a new driver takes the reactions with its words", () => {
    // The engine has no foreign keys: resetRoom prunes by hand (SQL: on delete cascade).
    for (const d of ["d1", "d2"]) {
      user(d, d.toUpperCase());
      at((e) => e.saveVehicle(d, { make: "Skoda", model: "Fabia", colour: "Blue", plate: `WX ${d}`, seats: 4 }));
    }
    const b = at((e) => e.bookRide("client", { pickup: HOME, dropoff: { lat: 52.2663, lng: 20.8143, label: "School" }, estKm: 3, estMin: 8, fareIsEstimate: false, scheduledFor: now + 120 * MIN }));
    at((e) => e.claimBooking("d1", b.id));
    const room: ChatRoom = `ride:${b.id}`;
    const m = send("client", room, "Gate 2, please");
    reactM("d1", m.id, "👍");
    expect(db.reactions).toHaveLength(1);
    at((e) => e.releaseBooking("d1", b.id));
    at((e) => e.claimBooking("d2", b.id));
    expect(chat("d2", room).messages).toEqual([]);
    expect(db.reactions).toEqual([]);
  });
});
