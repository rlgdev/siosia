// @vitest-environment node
// Siosia 2.0 backend rules against the REAL SQL migration in PGlite: the service catalog,
// appointments (single and series), rides as part of a service, reminders, the calendar token.
// Same cases as the engine tests (tests/unit/appointments.test.ts) — the twin rule.

import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, errorOf, type Json, type SqlHarness } from "./sql-harness";

const U = {
  client: "00000000-0000-4000-8000-000000000101",
  siosia: "00000000-0000-4000-8000-000000000102",
  driver: "00000000-0000-4000-8000-000000000103",
  other: "00000000-0000-4000-8000-000000000104",
  stranger: "00000000-0000-4000-8000-000000000105"
};

let h: SqlHarness;

beforeAll(async () => {
  h = await createHarness(Object.values(U));
  await h.onboard(U.client, "Toria");
  await h.onboard(U.siosia, "Siosia");
  await h.onboard(U.driver, "Roman", true);
  await h.onboard(U.other, "Ewa");
}, 60_000);

describe("catalog and schema (T1)", () => {
  it("seeds ride, learning and childcare once, and gives every profile a public id", async () => {
    const { rows } = await h.admin("select services from public.app_config where id = 1");
    const services = rows[0].services as Json[];
    expect(services.map((s) => s.id)).toEqual(["ride", "learning", "childcare"]);
    expect(services[2]).toMatchObject({ kind: "time", duration: { default: 180, min: 60, max: 720, step: 30 }, price: null });
    const ids = await h.admin("select public_id from public.profiles");
    expect(ids.rows.length).toBe(4);
    expect(ids.rows.every((r) => /^[A-Za-z0-9_-]{12}$/.test(String(r.public_id)))).toBe(true);
    expect(new Set(ids.rows.map((r) => r.public_id)).size).toBe(4);
  });

  it("keeps appointments out of clients' direct reach", async () => {
    expect(await errorOf(h.as(U.client, "select count(*) from public.appointments"))).toMatch(/permission denied/);
    expect(await errorOf(h.as(U.client, "select count(*) from public.appointment_series"))).toMatch(/permission denied/);
  });

  it("validates the catalog: one ride entry, well-formed ids and durations, nothing deleted", async () => {
    const base = ((await h.admin("select services from public.app_config where id = 1")).rows[0].services as Json[]).map((e) => ({ ...e }));
    const set = (v: unknown) => h.admin("select public.siosia_set_services($1::jsonb)", [JSON.stringify(v)]);
    expect(await errorOf(set([...base, { ...base[1], id: "Bad-Id" }]))).toMatch(/bad id/);
    expect(await errorOf(set([...base, { ...base[0], id: "ride2" }]))).toMatch(/ride entry has the id "ride"|exactly one/);
    expect(await errorOf(set([base[0], base[1]]))).toMatch(/keep every entry.*childcare/);
    expect(await errorOf(set([base[0], base[1], { ...base[2], duration: { default: 30, min: 60, max: 720, step: 30 } }]))).toMatch(/duration/);
    expect(await errorOf(set([base[0], base[1], { ...base[2], duration: { default: 180, min: 60, max: 720, step: 20 } }]))).toMatch(/duration/);
    const music = { id: "music", kind: "time", name: { en: "Music", pl: "Muzyka" }, description: { en: "", pl: "" }, icon: "🎹", duration: { default: 45, min: 30, max: 90, step: 15 }, price: { perHour: 80 }, needsPlace: false, enabled: false };
    await set([...base, music]);
    const saved = (await h.admin("select services from public.app_config where id = 1")).rows[0].services as Json[];
    expect(saved.map((s) => s.id)).toEqual(["ride", "learning", "childcare", "music"]);
  });

  it("allows a rating of a ride or of an appointment, never both", async () => {
    expect(
      await errorOf(h.admin("insert into public.ratings (from_user, to_user, stars) values ($1, $2, 5)", [U.client, U.siosia]))
    ).toMatch(/ratings_one_target/);
  });
});
