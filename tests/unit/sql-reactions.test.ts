// @vitest-environment node
// Siosia 2.12.3 backend rules against the REAL SQL migration in PGlite: reactions on chat messages and
// session updates (FR-330–332, V88). Same cases as the engine tests (tests/unit/reactions.test.ts) —
// the twin rule (V19) — plus what only the database has: the foreign keys' cascade, row-level
// security and the function privileges.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, errorOf, type Json, type SqlHarness } from "./sql-harness";

const U = {
  client: "00000000-0000-4000-8000-000000000701",
  siosia: "00000000-0000-4000-8000-000000000702",
  mum: "00000000-0000-4000-8000-000000000703",
  kasia: "00000000-0000-4000-8000-000000000704",
  other: "00000000-0000-4000-8000-000000000705",
  app: "00000000-0000-4000-8000-000000000706",
  d1: "00000000-0000-4000-8000-000000000707",
  d2: "00000000-0000-4000-8000-000000000708"
};
type Who = keyof typeof U;
const NAMES: Record<Who, string> = { client: "Toria", siosia: "Siosia", mum: "Anna", kasia: "Kasia", other: "Ewa", app: "", d1: "D1", d2: "D2" };
const HOME = { lat: 52.2504843, lng: 20.8253459, label: "Warszawska 269" };

let h: SqlHarness;
const pub = {} as Record<Who, string>;
const call = <T = Json>(who: Who, fn: string, args: unknown[] = []) => h.call<T>(U[who], fn, args);
const code = (p: Promise<unknown>) => errorOf(p);
const name = (uid: unknown) => (Object.keys(U) as Who[]).find((k) => U[k] === uid) ?? String(uid);

const send = (who: Who, room: string, text: string) => call<Json>(who, "siosia_send_message", [room, text]);
const chat = (who: Who, room: string, mark = false) => call<Json>(who, "siosia_chat", [room, mark]);
const post = (who: Who, id: unknown, text: string, photo: string | null = null) => call<Json>(who, "siosia_post_update", [id, text, null, photo]);
const feed = (who: Who, id: unknown, seen = false) => call<Json>(who, "siosia_updates", [id, seen]);
const reactM = (who: Who, id: unknown, emoji: string | null) => call<Json>(who, "siosia_react_message", [id, emoji]);
const reactU = (who: Who, id: unknown, emoji: string | null) => call<Json>(who, "siosia_react_update", [id, emoji]);
const pushes = async () =>
  ((await h.admin("select kind, user_id, ride_id, appointment_id, params from public.push_outbox order by id")).rows as Json[]).map((r) => ({
    who: name(r.user_id),
    kind: r.kind,
    rideId: r.ride_id,
    appointmentId: r.appointment_id,
    params: r.params
  }));
const changed = async () => [...new Set((await h.admin("select topic from realtime.messages where event = 'changed'")).rows.map((r) => name(String(r.topic).slice(5))))].sort();
const quiet = () => h.db.exec("delete from public.push_outbox; delete from realtime.messages;");
const rows = async () =>
  ((await h.admin("select user_id, coalesce(message_id, update_id) as item, emoji from public.reactions")).rows as Json[]).map((r) => `${name(r.user_id)}:${r.item}:${r.emoji}`).sort();

/** An accepted childcare of Toria with Siosia, starting in 20 min (the feed and the room are open). */
async function session(): Promise<Json> {
  const a = await call<Json>("client", "siosia_request_service", ["childcare", pub.siosia, new Date(Date.now() + 31 * 60_000).toISOString(), 180, HOME, "", null]);
  await call("siosia", "siosia_answer_appointment", [a.id, "accept"]);
  await h.admin("update public.appointments set starts_at = now() + interval '20 minutes' where id = $1", [a.id]);
  await quiet();
  return call<Json>("client", "siosia_get_appointment", [a.id]);
}
/** Moves an appointment so that it ended `agoMin` minutes ago, done (its ended_at too). */
const endedAgo = (id: unknown, agoMin: number) =>
  h.admin(
    "update public.appointments set status = 'done', starts_at = now() - make_interval(mins => duration_min + $2), ended_at = now() - make_interval(mins => $2) where id = $1",
    [id, agoMin]
  );

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  await h.admin("create schema if not exists storage");
  await h.admin("create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null)");
}, 60_000);

beforeEach(async () => {
  // Every case starts from fresh people (a merge or a deletion leaves its mark on the profiles).
  await h.db.exec(
    "delete from public.reactions; delete from public.messages; delete from public.appointment_updates; delete from public.appointments; delete from public.rides;" +
      "delete from public.push_outbox; delete from realtime.messages; delete from public.chat_presence; delete from public.family_members;" +
      "delete from public.family_invites; delete from public.families; delete from public.memberships; delete from public.profiles;" +
      "delete from public.account_transfers; delete from public.push_subscriptions;"
  );
  for (const k of ["client", "siosia", "mum", "kasia", "other", "d1", "d2"] as Who[]) {
    await h.onboard(U[k], NAMES[k], k === "d1" || k === "d2");
    pub[k] = String((await call<Json>(k, "siosia_get_profile")).publicId);
    // Push on: the outbox shows who would be told.
    await call(k, "siosia_save_push", [`https://web.push.apple.com/${k}`, "p".repeat(40), "a".repeat(16)]);
  }
  await call("siosia", "siosia_set_offers", [["childcare"]]);
  for (const [from, to] of [["client", "mum"], ["siosia", "kasia"]] as [Who, Who][]) {
    await call(from, "siosia_family_invite", [pub[to]]);
    const inc = ((await call<Json>(to, "siosia_family")).incoming as Json[])[0].id;
    await call(to, "siosia_family_answer", [inc, "join"]);
  }
  await quiet();
}, 60_000);

describe("reactions on chat messages (2.12.3: FR-330, FR-331, V88)", () => {
  it("one emoji per person from the fixed set; the author hears once; both parties refetch", async () => {
    const a = await session();
    const room = `appt:${a.id}`;
    const m = await send("client", room, "Kids are asleep");
    await quiet();
    for (const bad of ["x", "❤", "🎃", "", "❤️❤️"]) expect(await code(reactM("siosia", m.id, bad)), bad).toBe("bad_input");
    expect(await code(reactM("siosia", "00000000-0000-4000-8000-0000000000aa", "❤️"))).toBe("not_found");
    expect(await code(reactM("mum", m.id, "❤️"))).toBe("not_found");
    expect(await code(reactM("other", m.id, "❤️"))).toBe("not_found");
    const r1 = await reactM("siosia", m.id, "❤️");
    expect(r1).toMatchObject({ id: m.id, mine: false, text: "Kids are asleep", reactions: [{ emoji: "❤️", count: 1, mine: true, names: [] }] });
    expect(await changed()).toEqual(["client", "siosia"]);
    expect(await pushes()).toEqual([
      { who: "client", kind: "reaction", rideId: null, appointmentId: a.id, params: { sender: "Siosia", emoji: "❤️", text: "Kids are asleep", room, messageId: m.id } }
    ]);
    await quiet();
    await reactM("client", m.id, "👍");
    expect(await pushes()).toEqual([]);
    expect(((await chat("client", room)).messages as Json[])[0].reactions).toEqual([
      { emoji: "❤️", count: 1, mine: false, names: ["Siosia"] },
      { emoji: "👍", count: 1, mine: true, names: [] }
    ]);
    expect((await reactM("siosia", m.id, "👍")).reactions).toEqual([{ emoji: "👍", count: 2, mine: true, names: ["Toria"] }]);
    expect((await reactM("siosia", m.id, "👍")).reactions).toEqual([{ emoji: "👍", count: 2, mine: true, names: ["Toria"] }]);
    expect((await reactM("siosia", m.id, null)).reactions).toEqual([{ emoji: "👍", count: 1, mine: false, names: ["Toria"] }]);
    expect((await reactM("siosia", m.id, null)).reactions).toEqual([{ emoji: "👍", count: 1, mine: false, names: ["Toria"] }]);
    expect(((await reactM("siosia", m.id, "😂")).reactions as Json[]).map((r) => r.emoji)).toEqual(["👍", "😂"]);
    expect(await pushes()).toEqual([]);
    // A push only, like a chat message: never a bell entry (V73).
    expect((await h.admin("select count(*)::int n from public.notifications where kind = 'reaction'")).rows[0].n).toBe(0);
    // The set is the engine's REACTIONS, in its order.
    expect((await h.admin("select public.siosia_reaction_set() as s")).rows[0].s).toEqual(["❤️", "👍", "😂", "😮", "😢", "🙏"]);
  });

  it("no notification to an author who has the thread open; read-only 24 h after the end", async () => {
    const a = await session();
    const room = `appt:${a.id}`;
    const m = await send("siosia", room, "On my way");
    await chat("siosia", room, true);
    await quiet();
    await reactM("client", m.id, "🙏");
    expect(await pushes()).toEqual([]);
    expect(((await chat("siosia", room)).messages as Json[])[0].reactions).toEqual([{ emoji: "🙏", count: 1, mine: false, names: ["Toria"] }]);
    await endedAgo(a.id, 24 * 60 - 1);
    expect(((await reactM("client", m.id, "❤️")).reactions as Json[])[0].emoji).toBe("❤️");
    await endedAgo(a.id, 24 * 60 + 1);
    expect(await code(reactM("client", m.id, null))).toBe("illegal_transition");
  });

  it("at most 60 new items reacted to in 10 minutes; changing one already set is never refused", async () => {
    const a = await session();
    const room = `appt:${a.id}`;
    const ids = (
      await h.admin(
        "insert into public.messages (room, appointment_id, sender, text) select $1, $2, $3, 'n' || g from generate_series(1, 61) g returning id",
        [room, a.id, U.client]
      )
    ).rows.map((r) => r.id);
    for (const id of ids.slice(0, 60)) await reactM("siosia", id, "❤️");
    expect(await code(reactM("siosia", ids[60], "❤️"))).toBe("too_many");
    expect(((await reactM("siosia", ids[0], "👍")).reactions as Json[])[0].emoji).toBe("👍");
    await h.admin("update public.reactions set set_at = set_at - interval '10 minutes 1 second', created_at = created_at - interval '10 minutes 1 second'");
    expect(((await reactM("siosia", ids[60], "❤️")).reactions as Json[])[0].emoji).toBe("❤️");
    // Later, changing or taking back the old ones is no new item: a new one is still welcome.
    await h.admin("update public.reactions set set_at = set_at - interval '11 minutes', created_at = created_at - interval '11 minutes'");
    for (const id of ids.slice(0, 60)) await reactM("siosia", id, null);
    // (inserted as above: the 61 messages already use up the sender's own chat rate)
    const fresh = (await h.admin("insert into public.messages (room, appointment_id, sender, text) values ($1, $2, $3, 'new') returning id", [room, a.id, U.client])).rows[0];
    expect(((await reactM("siosia", fresh.id, "😮")).reactions as Json[])[0].emoji).toBe("😮");
  });
});

describe("reactions on session updates (2.12.3: FR-330, FR-331, V88)", () => {
  it("who may post may react — the parties and the client's family — while the feed is open; the author hears once", async () => {
    const a = await session();
    const photo = `update/${pub.siosia}/${a.id}/k1.jpg`;
    await h.admin("insert into storage.objects (bucket_id, name) values ('photos', $1)", [photo]);
    const u = await post("siosia", a.id, "", photo);
    await quiet();
    expect(await code(reactU("kasia", u.id, "❤️"))).toBe("forbidden");
    expect(await code(reactU("other", u.id, "❤️"))).toBe("not_found");
    expect(await code(reactU("mum", "00000000-0000-4000-8000-0000000000aa", "❤️"))).toBe("not_found");
    expect(await code(reactU("mum", u.id, "🎃"))).toBe("bad_input");
    const x = await reactU("mum", u.id, "❤️");
    expect(x).toMatchObject({ id: u.id, reactions: [{ emoji: "❤️", count: 1, mine: true, names: [] }] });
    expect(await changed()).toEqual(["client", "kasia", "mum", "siosia"]);
    expect(await pushes()).toEqual([
      { who: "siosia", kind: "reaction", rideId: null, appointmentId: a.id, params: { sender: "Anna", emoji: "❤️", text: "", photo: true, kid: null, updateId: u.id } }
    ]);
    await quiet();
    await reactU("client", u.id, "❤️");
    expect((await pushes()).map((p) => p.who)).toEqual(["siosia"]);
    expect(((await feed("kasia", a.id)).items as Json[])[0].reactions).toEqual([{ emoji: "❤️", count: 2, mine: false, names: ["Anna", "Toria"] }]);
    expect(((await feed("client", a.id)).items as Json[])[0].reactions).toEqual([{ emoji: "❤️", count: 2, mine: true, names: ["Anna"] }]);
    const u2 = await post("siosia", a.id, "Painting now");
    await feed("siosia", a.id, true);
    await quiet();
    await reactU("client", u2.id, "😂");
    expect(await pushes()).toEqual([]);
    await call("siosia", "siosia_delete_update", [u2.id]);
    expect((await h.admin("select count(*)::int n from public.reactions where update_id = $1", [u2.id])).rows[0].n).toBe(0);
    // Someone who left the family is not told of reactions on what they wrote (they no longer see the feed).
    const note = await post("mum", a.id, "Hello from granny");
    await call("mum", "siosia_family_leave");
    await quiet();
    await reactU("client", note.id, "❤️");
    expect(await pushes()).toEqual([]);
    expect(await code(feed("mum", a.id))).toBe("not_found");
    await endedAgo(a.id, 7 * 24 * 60 + 1);
    expect(await code(reactU("client", u.id, "👍"))).toBe("illegal_transition");
    expect((((await feed("client", a.id)).items as Json[])[0].reactions as Json[])[0].count).toBe(2);
  });
});

describe("reactions and the account (2.12.3: V88 with V49, V82)", () => {
  it("a merge keeps into's reaction on an item both reacted to and moves the rest; a deleted profile's reactions go, and those on what it wrote", async () => {
    const a = await session();
    const room = `appt:${a.id}`;
    const u1 = await post("siosia", a.id, "Lunch");
    const u2 = await post("siosia", a.id, "Nap");
    await reactU("client", u1.id, "👍");
    await reactU("mum", u1.id, "❤️");
    await reactU("mum", u2.id, "😮");
    const { code: move } = await call<Json>("mum", "siosia_create_transfer");
    await call("app", "siosia_redeem_transfer", [move, "dev-app", false]);
    expect(await rows()).toEqual([`app:${u1.id}:❤️`, `app:${u2.id}:😮`, `client:${u1.id}:👍`].sort());
    await h.admin("select public.siosia_merge_accounts($1, $2, 'operator')", [U.app, U.client]);
    expect(await rows()).toEqual([`client:${u1.id}:👍`, `client:${u2.id}:😮`].sort());
    const m = await send("client", room, "Thanks!");
    await reactM("siosia", m.id, "🙏");
    expect(await rows()).toHaveLength(3);
    await call("siosia", "siosia_delete_profile");
    expect(await rows()).toEqual([]);
  });

  it("a ride's thread that starts afresh for a new driver, and the 12-month retention, take the reactions along", async () => {
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    const b = await call<Json>("client", "siosia_book_ride", [HOME, { lat: 52.2663, lng: 20.8143, label: "School" }, 3, 8, false, at(120)]);
    await call("d1", "siosia_claim_booking", [b.id]);
    const room = `ride:${b.id}`;
    const m = await send("client", room, "Gate 2, please");
    await reactM("d1", m.id, "👍");
    expect(await rows()).toHaveLength(1);
    await call("d1", "siosia_release_booking", [b.id]);
    await call("d2", "siosia_claim_booking", [b.id]);
    expect((await chat("d2", room)).messages).toEqual([]);
    expect(await rows()).toEqual([]);
    // An appointment older than 12 months goes with its thread, its feed and their reactions.
    const a = await session();
    const m2 = await send("client", `appt:${a.id}`, "Thanks");
    const u = await post("siosia", a.id, "Bye");
    await reactM("siosia", m2.id, "🙏");
    await reactU("client", u.id, "❤️");
    expect(await rows()).toHaveLength(2);
    await h.admin("update public.appointments set status = 'done', starts_at = now() - interval '13 months', ended_at = now() - interval '13 months' where id = $1", [a.id]);
    await h.admin("select public.siosia_retention()");
    expect(await rows()).toEqual([]);
  });

  it("tells the app what this database can do (V89)", async () => {
    expect((await h.asAnonRole<Json>("select public.siosia_config()")).features).toEqual(["customPrice", "reactions", "changes"]);
  });

  it("an older push-dispatch (no kinds) never claims a reaction; a 2.12.3 one claims the kinds it knows", async () => {
    await h.admin(
      "insert into public.push_outbox (user_id, kind, params, lang, tz) values ($1, 'chat_message', '{}', 'en', 'Europe/Warsaw'), ($1, 'reaction', '{}', 'en', 'Europe/Warsaw')",
      [U.client]
    );
    expect((await h.admin("select kind from public.siosia_claim_push(10)")).rows.map((r) => r.kind)).toEqual(["chat_message"]);
    expect((await h.admin("select kind from public.siosia_claim_push(10, array['chat_message'])")).rows).toEqual([]);
    expect((await h.admin("select kind from public.siosia_claim_push(10, array['chat_message', 'reaction'])")).rows.map((r) => r.kind)).toEqual(["reaction"]);
  });

  it("clients reach the reactions only through the functions: no table access, row-level security on, the internals not callable", async () => {
    expect(await errorOf(h.as(U.client, "select count(*) from public.reactions"))).toMatch(/permission denied/);
    expect((await h.admin("select relrowsecurity from pg_class where oid = 'public.reactions'::regclass")).rows[0].relrowsecurity).toBe(true);
    const can = async (sig: string, role: string) => (await h.admin(`select has_function_privilege('${role}', 'public.${sig}', 'execute') as ok`)).rows[0].ok;
    for (const sig of ["siosia_react_message(uuid, text)", "siosia_react_update(uuid, text)"]) {
      expect(await can(sig, "authenticated"), sig).toBe(true);
      expect(await can(sig, "anon"), sig).toBe(false);
    }
    for (const sig of [
      "siosia_set_reaction(uuid, uuid, uuid, text)",
      "siosia_push_item(uuid, text, uuid, uuid, jsonb)",
      "siosia_reactions_json(uuid, uuid, uuid)",
      "siosia_reaction_ok(text)",
      "siosia_reaction_set()"
    ])
      expect(await can(sig, "authenticated"), sig).toBe(false);
  });
});
