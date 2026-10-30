// Shared PGlite harness for the SQL backend tests: the real migration (run twice, it is idempotent)
// on Postgres compiled to WebAssembly, with a prelude that stubs what Supabase provides
// (auth.uid(), auth.jwt(), auth.users, realtime.messages/send/topic, the anon/authenticated roles).

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";

export const MIGRATION = readFileSync(new URL("../../supabase/migrations/0001_siosia.sql", import.meta.url), "utf8");

export const PRELUDE = `
create schema if not exists extensions;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
-- 2.12: the columns the accounts code and the operator queries read (Supabase has them all).
alter table auth.users add column if not exists email text unique;
alter table auth.users add column if not exists is_anonymous boolean not null default true;
alter table auth.users add column if not exists banned_until timestamptz;
alter table auth.users add column if not exists created_at timestamptz default now();
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
-- Supabase's auth.jwt(): the request's claims (is_anonymous, email, …); {} outside a request.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists realtime;
create table if not exists realtime.messages (
  id bigserial primary key, topic text not null, extension text not null default 'broadcast',
  event text, payload jsonb, private boolean, inserted_at timestamptz default now());
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '') $$;
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language sql security definer as $$
  insert into realtime.messages (topic, extension, event, payload, private) values (topic, 'broadcast', event, payload, private) $$;
grant usage on schema public, auth, realtime, extensions to anon, authenticated;
grant select, insert on realtime.messages to authenticated;
`;

export type Json = Record<string, unknown>;

/** 2.12: who the caller is to Supabase Auth — an anonymous session (default: every phone before 2.12) or a signed-in account. */
export interface Claims {
  anonymous?: boolean;
  email?: string | null;
}

export interface SqlHarness {
  db: PGlite;
  /** Runs `sql` as an authenticated user (RLS applies), returning the first column of the first row. */
  as<T = Json>(uid: string, sql: string, params?: unknown[], claims?: Claims): Promise<T>;
  /** Calls an API function and unwraps {ok} / throws Error(code) on {error}. */
  call<T = Json>(uid: string, fn: string, args?: unknown[], claims?: Claims): Promise<T>;
  /** Runs `sql` as the anon role (no session), returning the first column of the first row. */
  asAnonRole<T = Json>(sql: string, params?: unknown[]): Promise<T>;
  /** Adds an auth user (an anonymous one unless an email is given). */
  addUser(id: string, opts?: { email?: string | null; anonymous?: boolean }): Promise<void>;
  admin(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** Invite code + nickname (+ vehicle) for a test user. */
  onboard(uid: string, nick: string, vehicle?: boolean): Promise<void>;
}

export async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
}

export async function createHarness(users: string[], opts: { prelude?: string } = {}): Promise<SqlHarness> {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  if (opts.prelude) await db.exec(opts.prelude);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // idempotent re-run
  const admin = (sql: string, params: unknown[] = []) => db.query<Record<string, unknown>>(sql, params);
  for (const id of users) await admin("insert into auth.users (id) values ($1)", [id]);
  await admin("select public.siosia_set_invite_code('PILOT 2026')");
  const as = async <T = Json>(uid: string, sql: string, params: unknown[] = [], claims: Claims = {}): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      const jwt = { sub: uid, role: "authenticated", is_anonymous: claims.anonymous ?? true, email: claims.email ?? null };
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(jwt)]);
      await tx.exec("set local role authenticated");
      const res = await tx.query<Record<string, unknown>>(sql, params);
      const row = res.rows[0];
      return (row ? Object.values(row)[0] : undefined) as T;
    });
  const call = async <T = Json>(uid: string, fn: string, args: unknown[] = [], claims: Claims = {}): Promise<T> => {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
    const res = await as<{ ok?: T; error?: string }>(uid, `select public.${fn}(${placeholders})`, args, claims);
    if (res && typeof res === "object" && "error" in res && res.error) throw new Error(res.error);
    return (res as { ok: T }).ok;
  };
  const onboard = async (uid: string, nick: string, vehicle = false) => {
    await call(uid, "siosia_join", ["pilot 2026", `dev-${uid.slice(-2)}`]);
    await call(uid, "siosia_save_profile", [nick, "en"]);
    if (vehicle) await call(uid, "siosia_save_vehicle", ["Skoda", "Fabia", "Blue", `WX ${uid.slice(-4)}`, 4]);
  };
  const asAnonRole = async <T = Json>(sql: string, params: unknown[] = []): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      const res = await tx.query<Record<string, unknown>>(sql, params);
      const row = res.rows[0];
      return (row ? Object.values(row)[0] : undefined) as T;
    });
  const addUser = async (id: string, o: { email?: string | null; anonymous?: boolean } = {}) => {
    await admin("insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)", [id, o.email ?? null, o.anonymous ?? !o.email]);
  };
  return { db, as, call, admin, onboard, asAnonRole, addUser };
}
