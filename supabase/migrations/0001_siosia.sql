-- =============================================================================================
-- Siosia v1 — database schema, server rules and access policies (Supabase / Postgres 15+).
--
-- Paste the whole file into Supabase → SQL Editor → Run. It is idempotent: re-running it upgrades
-- functions and policies in place. Then set the invite code (see docs/SETUP.md, step 4):
--     select public.siosia_set_invite_code('YOUR-CODE');
--
-- This is the SQL twin of src/core/engine.ts (the reference implementation used by the in-browser
-- mock backend and the unit tests). Rule changes must be made in both places.
--
-- Guarantees enforced HERE, not in the client (NFR-05, NFR-07, FR-006):
--   * every write goes through a SECURITY DEFINER function that validates the caller and the
--     ride lifecycle (spec §5); tables accept no direct writes from clients;
--   * Accept is an atomic claim (UPDATE … WHERE status = 'requested'); one driver per ride;
--   * the fare is computed and frozen server-side at request time and never changes;
--   * no table has a column for live positions (FR-043): drivers send their coarse position only
--     as an argument of siosia_heartbeat(), used for matching and immediately discarded;
--   * the invite code is stored as a bcrypt hash and checked server-side (FR-007).
-- =============================================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

-- Deployment configuration (one row). Readable by clients through siosia_config().
create table if not exists public.app_config (
  id                 smallint primary key default 1 check (id = 1),
  currency           text    not null default 'PLN',
  fare_base          numeric(10,2) not null default 5.00,
  fare_per_km        numeric(10,2) not null default 2.50,
  fare_per_min       numeric(10,2) not null default 0.50,
  fare_minimum       numeric(10,2) not null default 10.00,
  offer_timeout_s    int     not null default 20  check (offer_timeout_s between 5 and 120),
  request_expiry_s   int     not null default 1200 check (request_expiry_s between 30 and 7200),
  no_show_wait_s     int     not null default 300 check (no_show_wait_s between 0 and 3600),
  service_lat        double precision,
  service_lng        double precision,
  service_radius_km  double precision,
  dispatch_radius_km double precision not null default 8,
  max_trip_km        double precision not null default 50,
  timezone           text    not null default 'Europe/Warsaw',
  operator_contact   text    not null default ''
);
-- Upgrades for databases created by an earlier version of this file (idempotent):
-- requests stay open 20 min by default (up to 2 h), and a lapsed card is re-offered after 2 min.
alter table public.app_config alter column request_expiry_s set default 1200;
alter table public.app_config drop constraint if exists app_config_request_expiry_s_check;
alter table public.app_config add constraint app_config_request_expiry_s_check check (request_expiry_s between 30 and 7200);
-- One-time data upgrade from the 3-minute version: a database without offer_retry_s still holds
-- the old default 180, which moves to 20 min. Runs once (the column then exists), so a value an
-- operator chooses later is never overwritten by re-running this file.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'app_config' and column_name = 'offer_retry_s') then
    update public.app_config set request_expiry_s = 1200 where id = 1 and request_expiry_s = 180;
  end if;
end $$;
alter table public.app_config add column if not exists offer_retry_s int not null default 120;
alter table public.app_config drop constraint if exists app_config_offer_retry_s_check;
alter table public.app_config add constraint app_config_offer_retry_s_check check (offer_retry_s between 0 and 3600);
-- Rides booked in advance (minutes / days): earliest and latest booking, when a claimed booking
-- starts (driver sets off) and when an unclaimed one opens to normal dispatch.
alter table public.app_config add column if not exists booking_min_lead_min int not null default 30;
alter table public.app_config add column if not exists booking_max_days int not null default 30;
alter table public.app_config add column if not exists booking_lead_min int not null default 30;
alter table public.app_config add column if not exists booking_open_min int not null default 20;
alter table public.app_config drop constraint if exists app_config_booking_check;
alter table public.app_config add constraint app_config_booking_check check (
  booking_min_lead_min between 0 and 1440 and booking_max_days between 1 and 365
  and booking_lead_min between 5 and 240 and booking_open_min between 0 and 240);
insert into public.app_config (id) values (1) on conflict (id) do nothing;

-- Secrets (one row). No policy → unreadable by clients.
create table if not exists public.app_secrets (
  id               smallint primary key default 1 check (id = 1),
  invite_code_hash text
);
insert into public.app_secrets (id) values (1) on conflict (id) do nothing;

-- Profile = basic info only: nickname (the only personal field, NFR-06) and language.
create table if not exists public.profiles (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  nickname       text not null check (char_length(nickname) between 2 and 20),
  language       text not null default 'en' check (language in ('en', 'pl')),
  created_at     timestamptz not null default now(),
  rider_cancels  int not null default 0,
  driver_cancels int not null default 0,
  late_cancels   int not null default 0,
  deleted        boolean not null default false
);

-- Master profiles (operator decision of 2026-10-11): a shared identity opened by a dedicated link
-- …/#master=<token>. Only the SHA-256 of the token is stored. Every device that opens the link
-- becomes this profile (nickname, icon) in one role: a RIDER profile rides only, every ride at
-- fixed_fare, with default pickup/dropoff; a DRIVER profile drives only, with a preset vehicle.
create table if not exists public.master_profiles (
  id         text primary key check (id ~ '^[a-z0-9-]{2,30}$'),
  token_hash text not null unique,
  nickname   text not null check (char_length(nickname) between 2 and 20),
  icon       text check (icon is null or icon ~ '^[a-z0-9-]{1,40}$'),
  fixed_fare numeric(8,2) check (fixed_fare is null or fixed_fare >= 0),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.master_profiles add column if not exists role text not null default 'rider';
alter table public.master_profiles drop constraint if exists master_profiles_role_check;
alter table public.master_profiles add constraint master_profiles_role_check check (role in ('rider', 'driver'));
alter table public.master_profiles add column if not exists default_pickup jsonb;
alter table public.master_profiles add column if not exists default_dropoff jsonb;
-- Driver profiles: {make, model, colour, seats, plate?}; without a plate each phone adds its own.
alter table public.master_profiles add column if not exists vehicle jsonb;
alter table public.profiles add column if not exists master_id text;

create table if not exists public.vehicles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  make       text not null check (char_length(make) between 1 and 30),
  model      text not null check (char_length(model) between 1 and 30),
  colour     text not null check (char_length(colour) between 1 and 20),
  plate      text not null check (char_length(plate) between 2 and 12),
  seats      int  not null check (seats between 1 and 6),
  updated_at timestamptz not null default now()
);

-- Driver liveness only — deliberately NO coordinates.
create table if not exists public.driver_status (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  online    boolean not null default false,
  last_seen timestamptz not null default now()
);

-- Proof that the invite code was entered on a device (FR-007).
create table if not exists public.memberships (
  user_id     uuid not null references auth.users (id) on delete cascade,
  device_id   text not null check (char_length(device_id) between 1 and 80),
  accepted_at timestamptz not null default now(),
  primary key (user_id, device_id)
);
-- Set when the device joined through a master link instead of the invite code: such a membership
-- counts only while that master profile is switched on, and ends when its token changes.
alter table public.memberships add column if not exists via_master text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_master_id_fkey') then
    alter table public.profiles add constraint profiles_master_id_fkey
      foreign key (master_id) references public.master_profiles (id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'memberships_via_master_fkey') then
    alter table public.memberships add constraint memberships_via_master_fkey
      foreign key (via_master) references public.master_profiles (id) on delete cascade;
  end if;
end $$;

-- "Move to the app" codes (iOS Home Screen apps have their own storage): one-time, 30 minutes,
-- stored as a SHA-256 of the normalised code.
create table if not exists public.account_transfers (
  code_hash  text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.invite_failures (
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index if not exists invite_failures_user_idx on public.invite_failures (user_id, at);

-- A ride keeps endpoints, totals, timestamps, fare, statuses — nothing else about location (FR-043).
create table if not exists public.rides (
  id                  uuid primary key default gen_random_uuid(),
  rider_id            uuid not null,
  driver_id           uuid,
  status              text not null default 'requested'
                        check (status in ('requested','accepted','arrived','in_progress','completed','cancelled','expired')),
  pickup_lat          double precision not null check (pickup_lat between -90 and 90),
  pickup_lng          double precision not null check (pickup_lng between -180 and 180),
  pickup_label        text not null default '' check (char_length(pickup_label) <= 120),
  dropoff_lat         double precision not null check (dropoff_lat between -90 and 90),
  dropoff_lng         double precision not null check (dropoff_lng between -180 and 180),
  dropoff_label       text not null default '' check (char_length(dropoff_label) <= 120),
  est_km              numeric(8,1) not null,
  est_min             int not null,
  fare                numeric(10,2) not null,
  currency            text not null,
  fare_is_estimate    boolean not null default false,
  actual_km           numeric(8,1),
  actual_min          numeric(8,1),
  requested_at        timestamptz not null default now(),
  dispatch_started_at timestamptz not null default now(),
  accepted_at         timestamptz,
  arrived_at          timestamptz,
  started_at          timestamptz,
  ended_at            timestamptz,
  cancelled_by        text check (cancelled_by in ('rider','driver','system')),
  cancel_reason       text,
  paid                boolean not null default false,
  collected           boolean not null default false,
  notified_count      int not null default 0,
  redispatch_count    int not null default 0,
  round               int not null default 1,
  excluded            uuid[] not null default '{}'
);
-- Rides booked in advance: status 'scheduled' until they start (see siosia_sweep).
alter table public.rides add column if not exists scheduled_for timestamptz;
alter table public.rides drop constraint if exists rides_status_check;
alter table public.rides add constraint rides_status_check
  check (status in ('scheduled','requested','accepted','arrived','in_progress','completed','cancelled','expired'));
create index if not exists rides_scheduled_idx on public.rides (scheduled_for) where status = 'scheduled';
create index if not exists rides_rider_idx  on public.rides (rider_id, requested_at desc);
create index if not exists rides_driver_idx on public.rides (driver_id, requested_at desc);
create index if not exists rides_open_idx   on public.rides (status) where status in ('requested','accepted','arrived','in_progress');
-- NFR-05: at most one active ride per rider and per driver.
create unique index if not exists rides_one_active_rider  on public.rides (rider_id)  where status in ('requested','accepted','arrived','in_progress');
create unique index if not exists rides_one_active_driver on public.rides (driver_id) where driver_id is not null and status in ('accepted','arrived','in_progress');

create table if not exists public.offers (
  id                 uuid primary key default gen_random_uuid(),
  ride_id            uuid not null references public.rides (id) on delete cascade,
  driver_id          uuid not null,
  round              int  not null,
  status             text not null check (status in ('queued','offered','declined','timed_out','withdrawn','won')),
  created_at         timestamptz not null default clock_timestamp(),
  offered_at         timestamptz,
  decided_at         timestamptz,
  driver_distance_km numeric(6,1) not null,
  unique (ride_id, driver_id, round)
);
create index if not exists offers_driver_open_idx on public.offers (driver_id, created_at) where status in ('queued','offered');
create index if not exists offers_ride_idx on public.offers (ride_id);
-- §6 rule 5: a driver holds at most one offered card at a time.
create unique index if not exists offers_one_offered on public.offers (driver_id) where status = 'offered';

create table if not exists public.ratings (
  ride_id    uuid not null references public.rides (id) on delete cascade,
  from_user  uuid not null,
  to_user    uuid not null,
  stars      int  not null check (stars between 1 and 5),
  comment    text not null default '' check (char_length(comment) <= 140),
  created_at timestamptz not null default now(),
  primary key (ride_id, from_user)
);
create index if not exists ratings_to_idx on public.ratings (to_user, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Row level security: clients may only READ their own rows; all writes go through functions.
-- ---------------------------------------------------------------------------------------------

alter table public.app_config      enable row level security;
alter table public.app_secrets     enable row level security;
alter table public.profiles        enable row level security;
alter table public.vehicles        enable row level security;
alter table public.driver_status   enable row level security;
alter table public.memberships     enable row level security;
alter table public.invite_failures enable row level security;
alter table public.rides           enable row level security;
alter table public.offers          enable row level security;
alter table public.ratings         enable row level security;
alter table public.master_profiles enable row level security;
alter table public.account_transfers enable row level security;

-- Explicit grants, so the script also works on projects created with "automatically expose new
-- tables" turned off (recommended).
grant usage on schema public to anon, authenticated;

revoke all on public.app_config, public.app_secrets, public.profiles, public.vehicles, public.driver_status,
              public.memberships, public.invite_failures, public.rides, public.offers, public.ratings,
              public.master_profiles, public.account_transfers
  from anon, authenticated;
-- No direct table access at all: clients use the functions below, which return only what each
-- party may see (raw tables would expose other users' ids, e.g. rides.driver_id / excluded).

drop policy if exists siosia_config_read  on public.app_config;
drop policy if exists siosia_profile_read on public.profiles;
drop policy if exists siosia_vehicle_read on public.vehicles;
drop policy if exists siosia_status_read  on public.driver_status;
drop policy if exists siosia_member_read  on public.memberships;
drop policy if exists siosia_ride_read    on public.rides;
drop policy if exists siosia_offer_read   on public.offers;
drop policy if exists siosia_rating_read  on public.ratings;

create policy siosia_config_read  on public.app_config    for select to authenticated using (true);
create policy siosia_profile_read on public.profiles      for select to authenticated using (user_id = auth.uid());
create policy siosia_vehicle_read on public.vehicles      for select to authenticated using (user_id = auth.uid());
create policy siosia_status_read  on public.driver_status for select to authenticated using (user_id = auth.uid());
create policy siosia_member_read  on public.memberships   for select to authenticated using (user_id = auth.uid());
create policy siosia_ride_read    on public.rides         for select to authenticated using (rider_id = auth.uid() or driver_id = auth.uid());
create policy siosia_offer_read   on public.offers        for select to authenticated using (driver_id = auth.uid());
create policy siosia_rating_read  on public.ratings       for select to authenticated using (from_user = auth.uid() or to_user = auth.uid());

-- ---------------------------------------------------------------------------------------------
-- Pure helpers
-- ---------------------------------------------------------------------------------------------

-- Great-circle distance in km (twin of haversineKm in src/core/geo.ts).
create or replace function public.siosia_km(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable as $$
  select 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))));
$$;

create or replace function public.siosia_ms(t timestamptz)
returns bigint language sql immutable as $$
  select case when t is null then null else floor(extract(epoch from t) * 1000)::bigint end;
$$;

create or replace function public.siosia_ok(v jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', v);
$$;

create or replace function public.siosia_err(code text) returns jsonb language sql immutable as $$
  select jsonb_build_object('error', code);
$$;

create or replace function public.siosia_norm_code(p text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g'));
$$;

-- FR-050: base + per km + per min, rounded to 0.50, never below the minimum (twin of computeFare).
create or replace function public.siosia_fare(p_km numeric, p_min numeric)
returns numeric language sql stable set search_path = public as $$
  select greatest(c.fare_minimum,
                  round((c.fare_base + c.fare_per_km * greatest(p_km, 0) + c.fare_per_min * greatest(p_min, 0)) * 2) / 2)
  from app_config c where c.id = 1;
$$;

-- FR-061: mean of the last 20 ratings, null ("New") with fewer than 3 (twin of summarizeRatings).
create or replace function public.siosia_rating(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with last20 as (select stars from ratings where to_user = p_user order by created_at desc limit 20),
       total  as (select count(*)::int as n from ratings where to_user = p_user)
  select jsonb_build_object(
    'mean',  case when (select n from total) < 3 then null else round((select avg(stars) from last20)::numeric, 1) end,
    'count', (select n from total));
$$;

-- The role ('rider' / 'driver') of the master profile a user joined, switched on or not.
create or replace function public.siosia_master_role(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from profiles p join master_profiles m on m.id = p.master_id
   where p.user_id = p_user and not p.deleted;
$$;

-- The active master profile a user joined through its link (null row when none).
create or replace function public.siosia_master_of(p_user uuid)
returns public.master_profiles language sql stable security definer set search_path = public as $$
  select m.* from profiles p join master_profiles m on m.id = p.master_id and m.active
   where p.user_id = p_user and not p.deleted;
$$;

create or replace function public.siosia_party(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'nickname', coalesce((select nickname from profiles where user_id = p_user), 'Deleted user'),
    'rating',   siosia_rating(p_user),
    'icon',     (siosia_master_of(p_user)).icon);
$$;

create or replace function public.siosia_vehicle_json(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('make', make, 'model', model, 'colour', colour, 'plate', plate, 'seats', seats)
  from vehicles where user_id = p_user;
$$;

create or replace function public.siosia_profile_json(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'userId', user_id, 'nickname', nickname, 'language', language,
    'riderCancels', rider_cancels, 'driverCancels', driver_cancels, 'lateCancels', late_cancels,
    'rating', siosia_rating(user_id),
    'masterId', master_id,
    'masterRole', siosia_master_role(p_user),
    'icon', (siosia_master_of(p_user)).icon,
    'fixedFare', case when (siosia_master_of(p_user)).role = 'rider' then (siosia_master_of(p_user)).fixed_fare end,
    'defaultPickup', case when (siosia_master_of(p_user)).role = 'rider' then (siosia_master_of(p_user)).default_pickup end,
    'defaultDropoff', case when (siosia_master_of(p_user)).role = 'rider' then (siosia_master_of(p_user)).default_dropoff end,
    'masterVehicle', case when (siosia_master_of(p_user)).role = 'driver' then (siosia_master_of(p_user)).vehicle end)
  from profiles where user_id = p_user and not deleted;
$$;

-- RideView. FR-044: the driver's vehicle/plate is included only once a driver is assigned.
create or replace function public.siosia_ride_json(r public.rides, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'role', case when r.rider_id = p_viewer then 'rider' else 'driver' end,
    'pickup',  jsonb_build_object('lat', r.pickup_lat,  'lng', r.pickup_lng,  'label', r.pickup_label),
    'dropoff', jsonb_build_object('lat', r.dropoff_lat, 'lng', r.dropoff_lng, 'label', r.dropoff_label),
    'estKm', r.est_km, 'estMin', r.est_min,
    'fare', r.fare, 'currency', r.currency, 'fareIsEstimate', r.fare_is_estimate,
    'actualKm', r.actual_km, 'actualMin', r.actual_min,
    'requestedAt', siosia_ms(r.requested_at), 'dispatchStartedAt', siosia_ms(r.dispatch_started_at),
    'acceptedAt', siosia_ms(r.accepted_at), 'arrivedAt', siosia_ms(r.arrived_at),
    'startedAt', siosia_ms(r.started_at), 'endedAt', siosia_ms(r.ended_at),
    'cancelledBy', r.cancelled_by, 'cancelReason', r.cancel_reason,
    'paid', r.paid, 'collected', r.collected,
    'notifiedCount', r.notified_count, 'redispatchCount', r.redispatch_count,
    'round', r.round,
    -- When an open request expires (current config, exactly as the sweep applies it).
    'expiresAt', siosia_ms(greatest(r.dispatch_started_at
                                    + make_interval(secs => (select c.request_expiry_s from app_config c where c.id = 1)),
                                    r.scheduled_for + interval '15 minutes')),
    'scheduledFor', siosia_ms(r.scheduled_for),
    'rider', siosia_party(r.rider_id),
    'driver', case when r.driver_id is null then null
                   else siosia_party(r.driver_id) || jsonb_build_object('vehicle', siosia_vehicle_json(r.driver_id)) end,
    'myRating', (select g.stars from ratings g where g.ride_id = r.id and g.from_user = p_viewer));
$$;

create or replace function public.siosia_offer_json(o public.offers)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'rideId', o.ride_id, 'status', o.status,
    'offeredAt', siosia_ms(coalesce(o.offered_at, o.created_at)),
    'driverDistanceKm', o.driver_distance_km,
    'pickup',  jsonb_build_object('lat', r.pickup_lat,  'lng', r.pickup_lng,  'label', r.pickup_label),
    'dropoff', jsonb_build_object('lat', r.dropoff_lat, 'lng', r.dropoff_lng, 'label', r.dropoff_label),
    'estKm', r.est_km, 'estMin', r.est_min, 'fare', r.fare, 'currency', r.currency,
    'fareIsEstimate', r.fare_is_estimate,
    'rider', siosia_party(r.rider_id))
  from rides r where r.id = o.ride_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Realtime notifications (Broadcast from Database, private topics). Payloads carry NO data:
-- clients refetch through the functions below, which apply the access rules.
-- ---------------------------------------------------------------------------------------------

create or replace function public.siosia_send(p_topic text, p_event text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_sent text := coalesce(current_setting('siosia.sent', true), '');
  v_key  text := p_topic || '/' || p_event || ';';
begin
  if position(v_key in v_sent) > 0 then return; end if;   -- once per topic per transaction
  perform set_config('siosia.sent', v_sent || v_key, true);
  begin
    perform realtime.send(jsonb_build_object('t', siosia_ms(clock_timestamp())), p_event, p_topic, true);
  exception when others then
    null; -- Realtime unavailable: clients still converge through polling.
  end;
end $$;

create or replace function public.siosia_notify(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is not null then perform siosia_send('user:' || p_user::text, 'changed'); end if;
end $$;

create or replace function public.siosia_rides_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform siosia_notify(new.rider_id);
  perform siosia_notify(new.driver_id);
  if tg_op = 'UPDATE' and old.driver_id is distinct from new.driver_id then
    perform siosia_notify(old.driver_id);
  end if;
  -- A request opened or re-opened: data-less ping so online drivers heartbeat now (§6).
  if new.status = 'requested' and (tg_op = 'INSERT' or old.status <> 'requested' or old.round <> new.round) then
    perform siosia_send('drivers', 'ping');
  end if;
  return null;
end $$;

drop trigger if exists siosia_rides_notify on public.rides;
create trigger siosia_rides_notify after insert or update on public.rides
  for each row execute function public.siosia_rides_trigger();

create or replace function public.siosia_offers_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform siosia_notify(new.driver_id);
  return null;
end $$;

drop trigger if exists siosia_offers_notify on public.offers;
create trigger siosia_offers_notify after insert or update on public.offers
  for each row execute function public.siosia_offers_trigger();

-- ---------------------------------------------------------------------------------------------
-- Internal dispatch machinery (not callable by clients)
-- ---------------------------------------------------------------------------------------------

-- Give the driver their oldest still-valid queued offer if they hold no card (§6 rule 5).
create or replace function public.siosia_promote(p_driver uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q record;
begin
  if exists (select 1 from offers where driver_id = p_driver and status = 'offered') then return; end if;
  for q in select o.id, o.ride_id, o.round from offers o
           where o.driver_id = p_driver and o.status = 'queued' order by o.created_at loop
    if exists (select 1 from rides r where r.id = q.ride_id and r.status = 'requested' and r.round = q.round) then
      update offers set status = 'offered', offered_at = now() where id = q.id;
      return;
    end if;
    update offers set status = 'withdrawn', decided_at = now() where id = q.id;
  end loop;
end $$;

create or replace function public.siosia_close_offer(p_offer uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare v_driver uuid;
begin
  update offers set status = p_status, decided_at = now()
   where id = p_offer and status in ('offered','queued')
  returning driver_id into v_driver;
  if v_driver is not null then perform siosia_promote(v_driver); end if;
end $$;

create or replace function public.siosia_withdraw_ride_offers(p_ride uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o record;
begin
  for o in select id from offers where ride_id = p_ride and status in ('offered','queued') loop
    perform siosia_close_offer(o.id, 'withdrawn');
  end loop;
end $$;

drop function if exists public.siosia_end_ride(uuid, text, text, text);
drop function if exists public.siosia_redispatch(uuid, text);

-- Ends a ride only if it is still in one of the expected statuses (a concurrent transition wins).
create or replace function public.siosia_end_ride(p_ride uuid, p_status text, p_by text, p_reason text,
                                                  p_from text[] default array['requested','accepted','arrived'])
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update rides set status = p_status, ended_at = now(), cancelled_by = p_by, cancel_reason = p_reason
   where id = p_ride and status = any (p_from);
  if not found then return false; end if;
  perform siosia_withdraw_ride_offers(p_ride);
  return true;
end $$;

-- accepted/arrived → requested without this driver; expiry restarts; fare unchanged (FR-051).
-- Guarded on the expected driver and status, so it can never undo a concurrent cancel or start.
create or replace function public.siosia_redispatch(p_ride uuid, p_reason text, p_driver uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update rides set
    status = 'requested',
    excluded = case when driver_id = any (excluded) then excluded else array_append(excluded, driver_id) end,
    driver_id = null, accepted_at = null, arrived_at = null,
    round = round + 1, redispatch_count = redispatch_count + 1,
    dispatch_started_at = now(), notified_count = 0, cancel_reason = p_reason
  where id = p_ride and status in ('accepted','arrived') and driver_id = p_driver;
  return found;
end $$;

create or replace function public.siosia_go_offline(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o record;
begin
  update driver_status set online = false where user_id = p_user;
  for o in select id from offers where driver_id = p_user and status in ('offered','queued') order by status desc loop
    perform siosia_close_offer(o.id, 'withdrawn');
  end loop;
end $$;

-- Timeouts, expiry, stale drivers, lost drivers. Runs on every call ("expiry check on read",
-- §6 rule 7) and, when pg_cron is available, every 10 seconds.
create or replace function public.siosia_sweep()
returns void language plpgsql security definer set search_path = public as $$
declare c app_config; o record; r record; v_rider_busy boolean;
begin
  if not pg_try_advisory_xact_lock(727274) then return; end if;
  select * into c from app_config where id = 1;
  -- 0. bookings: a claimed one starts (driver on the way) booking_lead_min before its time; an
  --    unclaimed one opens to normal dispatch booking_open_min before. Either waits while its
  --    people are busy and gives up 15 minutes after the booked time.
  for r in select * from rides where status = 'scheduled'
           and scheduled_for - make_interval(mins => case when driver_id is null then c.booking_open_min
                                                          else c.booking_lead_min end) <= now()
           order by scheduled_for
           for update skip locked loop
    begin
      v_rider_busy := exists (select 1 from rides x where x.rider_id = r.rider_id
                              and x.status in ('requested','accepted','arrived','in_progress'));
      if r.driver_id is not null and not v_rider_busy
         and not exists (select 1 from rides x where x.driver_id = r.driver_id and x.status in ('accepted','arrived','in_progress')) then
        update rides set status = 'accepted', accepted_at = now(), dispatch_started_at = now()
         where id = r.id and status = 'scheduled';
        -- The driver is on duty for this ride from now on, even before their app is open.
        insert into driver_status (user_id, online, last_seen) values (r.driver_id, true, now())
        on conflict (user_id) do update set online = true, last_seen = now();
        for o in select id from offers where driver_id = r.driver_id and status in ('offered','queued') order by status desc loop
          perform siosia_close_offer(o.id, 'withdrawn');
        end loop;
      elsif r.driver_id is null and not v_rider_busy then
        update rides set status = 'requested', dispatch_started_at = now(), notified_count = 0
         where id = r.id and status = 'scheduled';
      elsif now() > r.scheduled_for + interval '15 minutes' then
        if v_rider_busy then
          perform siosia_end_ride(r.id, 'expired', 'system', null, array['scheduled']);
        else
          update rides set status = 'requested', driver_id = null, dispatch_started_at = now(), notified_count = 0
           where id = r.id and status = 'scheduled';
        end if;
      end if;
    exception when unique_violation then
      null; -- someone became busy concurrently: the next sweep tries again
    end;
  end loop;
  -- 1. lapsed offer countdowns
  for o in select id from offers where status = 'offered'
           and offered_at + make_interval(secs => c.offer_timeout_s) <= now() loop
    perform siosia_close_offer(o.id, 'timed_out');
  end loop;
  -- 2. drivers silent for > 12 s lose their cards (tab killed, offline phone)
  for o in select f.id from offers f left join driver_status d on d.user_id = f.driver_id
           where f.status in ('offered','queued')
             and (d.user_id is null or not d.online or d.last_seen < now() - interval '12 seconds')
           order by f.status desc loop
    perform siosia_close_offer(o.id, 'withdrawn');
  end loop;
  -- 3. cards whose ride moved on
  for o in select f.id from offers f join rides x on x.id = f.ride_id
           where f.status in ('offered','queued') and (x.status <> 'requested' or x.round <> f.round) loop
    perform siosia_close_offer(o.id, 'withdrawn');
  end loop;
  -- 4. requests nobody accepted in time. Rows being changed right now (an Accept in flight) are
  --    skipped and re-checked by the next sweep; the guarded update re-checks the status anyway.
  for r in select id from rides where status = 'requested'
           and greatest(dispatch_started_at + make_interval(secs => c.request_expiry_s),
                        scheduled_for + interval '15 minutes') <= now()
           for update skip locked loop
    perform siosia_end_ride(r.id, 'expired', 'system', null, array['requested']);
  end loop;
  -- 5. accepted/arrived rides whose driver vanished for 60 s are re-dispatched (§12)
  for r in select x.id, x.driver_id from rides x left join driver_status d on d.user_id = x.driver_id
           where x.status in ('accepted','arrived')
             and (d.user_id is null or d.last_seen < now() - interval '60 seconds')
             -- a booked ride gives its driver until 15 min after the booked time to show up
             and (x.scheduled_for is null or x.scheduled_for + interval '15 minutes' <= now())
           for update of x skip locked loop
    if siosia_redispatch(r.id, 'driver_lost', r.driver_id) then
      update driver_status set online = false where user_id = r.driver_id;
      perform siosia_notify(r.driver_id);
    end if;
  end loop;
  -- 6. idle drivers silent for 60 s go offline (a short screen lock is tolerated; a killed tab
  --    must not leave the user "online" for good — FR-005, US4-2)
  for r in update driver_status d set online = false
            where d.online and d.last_seen < now() - interval '60 seconds'
              and not exists (select 1 from rides x where x.driver_id = d.user_id
                              and x.status in ('accepted','arrived','in_progress'))
           returning d.user_id loop
    perform siosia_notify(r.user_id);
  end loop;
end $$;

-- Pull offers for an idle online driver from its current coarse position (never stored).
create or replace function public.siosia_pull_offers(p_driver uuid, p_lat float8, p_lng float8)
returns void language plpgsql security definer set search_path = public as $$
declare c app_config; r record; d float8; v_holding boolean; v_id uuid; v_old uuid; v_old_status text;
        v_old_decided timestamptz;
begin
  select * into c from app_config where id = 1;
  for r in select x.id, x.round, x.pickup_lat, x.pickup_lng from rides x
           where x.status = 'requested' and x.rider_id <> p_driver and not (p_driver = any (x.excluded))
           order by x.requested_at loop
    -- A card withdrawn for driver-side reasons (offline, silent, won another ride) is offered again
    -- once the driver is eligible (§6 rule 4). A card the driver let lapse comes back after
    -- offer_retry_s (requests stay open long); a Decline holds until siosia_clear_decisions.
    v_old := null;
    v_old_status := null;
    v_old_decided := null;
    select id, status, decided_at into v_old, v_old_status, v_old_decided from offers
     where ride_id = r.id and driver_id = p_driver and round = r.round;
    continue when v_old is not null
      and not (v_old_status = 'withdrawn'
               or (v_old_status = 'timed_out' and c.offer_retry_s > 0
                   and v_old_decided <= now() - make_interval(secs => c.offer_retry_s)));
    d := siosia_km(p_lat, p_lng, r.pickup_lat, r.pickup_lng);
    continue when d > c.dispatch_radius_km;
    v_holding := exists (select 1 from offers where driver_id = p_driver and status = 'offered');
    if v_old is not null then
      begin
        update offers set status = case when v_holding then 'queued' else 'offered' end,
                          offered_at = case when v_holding then null else now() end,
                          created_at = clock_timestamp(), decided_at = null,
                          driver_distance_km = round(d::numeric, 1)
         where id = v_old;
      exception when unique_violation then
        -- Another transaction gave this driver a card meanwhile: queue this one behind it.
        update offers set status = 'queued', offered_at = null, created_at = clock_timestamp(),
                          decided_at = null, driver_distance_km = round(d::numeric, 1)
         where id = v_old;
      end;
      continue;
    end if;
    v_id := null;
    insert into offers (ride_id, driver_id, round, status, offered_at, driver_distance_km)
    values (r.id, p_driver, r.round,
            case when v_holding then 'queued' else 'offered' end,
            case when v_holding then null else now() end,
            round(d::numeric, 1))
    on conflict do nothing
    returning id into v_id;
    if v_id is not null then
      update rides set notified_count = notified_count + 1 where id = r.id;
    end if;
  end loop;
end $$;

-- p_lat/p_lng: the driver's coarse position sent with this call (heartbeat / Show requests), used
-- only to count pending requests nearby and never stored. Older versions took (uuid) only.
drop function if exists public.siosia_state_json(uuid);
create or replace function public.siosia_state_json(p_user uuid, p_lat float8 default null, p_lng float8 default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r rides; o offers; p rides; c app_config;
begin
  select * into c from app_config where id = 1;
  select * into r from rides
   where status in ('requested','accepted','arrived','in_progress') and (rider_id = p_user or driver_id = p_user)
   order by requested_at desc limit 1;
  select * into o from offers where driver_id = p_user and status = 'offered' limit 1;
  select * into p from rides x
   where x.status = 'completed' and (x.rider_id = p_user or x.driver_id = p_user)
     and x.ended_at > now() - interval '2 hours'
     and not exists (select 1 from ratings g where g.ride_id = x.id and g.from_user = p_user)
   order by x.ended_at desc limit 1;
  return jsonb_build_object(
    'serverNow', siosia_ms(clock_timestamp()),
    'ride', case when r.id is null then null else siosia_ride_json(r, p_user) end,
    'offer', case when o.id is null then null else siosia_offer_json(o) end,
    'queuedOffers', (select count(*) from offers where driver_id = p_user and status = 'queued'),
    'driverOnline', coalesce((select online from driver_status where user_id = p_user), false),
    'hasVehicle', exists (select 1 from vehicles where user_id = p_user),
    'nearbyRequests', case when p_lat is null or p_lng is null then null else
      (select count(*) from rides x
        where x.status = 'requested' and x.rider_id <> p_user and not (p_user = any (x.excluded))
          and siosia_km(p_lat, p_lng, x.pickup_lat, x.pickup_lng) <= c.dispatch_radius_km) end,
    'pendingReceipt', case when p.id is null then null else siosia_ride_json(p, p_user) end,
    'bookings', (select count(*) from rides x where x.status = 'scheduled' and (x.rider_id = p_user or x.driver_id = p_user)),
    'openBookings', case when siosia_master_role(p_user) = 'rider' then 0 else
      (select count(*) from rides x where x.status = 'scheduled' and x.driver_id is null
          and x.rider_id <> p_user and not (p_user = any (x.excluded))) end);
end $$;

-- Declined / lapsed cards on still-open requests become offerable again (same round).
create or replace function public.siosia_clear_decisions(p_driver uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update offers o set status = 'withdrawn', decided_at = now()
    from rides x
   where o.ride_id = x.id and o.driver_id = p_driver and o.status in ('declined','timed_out')
     and x.status = 'requested' and x.round = o.round;
end $$;

-- Membership: the invite code was entered on a device, or it joined through a master link that is
-- still switched on. p_device null = on any device.
create or replace function public.siosia_member_ok(p_user uuid, p_device text default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships mb left join master_profiles m on m.id = mb.via_master
                  where mb.user_id = p_user and (p_device is null or mb.device_id = p_device)
                    and (mb.via_master is null or m.active));
$$;

-- Caller checks shared by every client function. Returns an error code or null.
create or replace function public.siosia_guard(p_need_profile boolean)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return 'forbidden'; end if;
  if not siosia_member_ok(v_uid) then return 'not_member'; end if;
  if p_need_profile and not exists (select 1 from profiles where user_id = v_uid and not deleted) then
    return 'no_profile';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Client API (called through supabase.rpc). Every function returns {ok: …} or {error: code}.
-- ---------------------------------------------------------------------------------------------

create or replace function public.siosia_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tariff', jsonb_build_object('base', fare_base, 'perKm', fare_per_km, 'perMin', fare_per_min,
                                 'minimum', fare_minimum, 'currency', currency),
    'timers', jsonb_build_object('offerS', offer_timeout_s, 'expiryS', request_expiry_s, 'noShowS', no_show_wait_s,
                                 'retryS', offer_retry_s),
    'booking', jsonb_build_object('minLeadMin', booking_min_lead_min, 'maxDays', booking_max_days,
                                  'leadMin', booking_lead_min, 'openMin', booking_open_min),
    'serviceArea', case when service_lat is null or service_lng is null or service_radius_km is null then null
                        else jsonb_build_object('lat', service_lat, 'lng', service_lng, 'radiusKm', service_radius_km) end,
    'dispatchRadiusKm', dispatch_radius_km,
    'maxTripKm', max_trip_km,
    'timezone', timezone,
    'operatorContact', operator_contact)
  from app_config where id = 1;
$$;

-- Operator only (SQL editor / service role): sets the invite code, stored as a bcrypt hash.
create or replace function public.siosia_set_invite_code(p_code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  if char_length(siosia_norm_code(p_code)) < 4 then raise exception 'Invite code must have at least 4 characters'; end if;
  update app_secrets set invite_code_hash = crypt(siosia_norm_code(p_code), gen_salt('bf', 8)) where id = 1;
  return 'Invite code set. Share it with your pilot group.';
end $$;

create or replace function public.siosia_join(p_code text, p_device text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); v_hash text;
begin
  if v_uid is null then return siosia_err('forbidden'); end if;
  if coalesce(char_length(p_device), 0) not between 1 and 80 then return siosia_err('bad_input'); end if;
  if (select count(*) from invite_failures where user_id = v_uid and at > now() - interval '1 hour') >= 10 then
    return siosia_err('rate_limited');
  end if;
  select invite_code_hash into v_hash from app_secrets where id = 1;
  if v_hash is null or crypt(siosia_norm_code(p_code), v_hash) <> v_hash then
    insert into invite_failures (user_id) values (v_uid);
    return siosia_err('bad_invite');
  end if;
  insert into memberships (user_id, device_id) values (v_uid, p_device) on conflict do nothing;
  return siosia_ok('true'::jsonb);
end $$;

-- A driver master's complete vehicle (with plate) on a user's account.
create or replace function public.siosia_apply_master_vehicle(p_user uuid, v jsonb)
returns void language sql security definer set search_path = public as $$
  insert into vehicles (user_id, make, model, colour, plate, seats)
  values (p_user, v ->> 'make', v ->> 'model', v ->> 'colour', upper(v ->> 'plate'), (v ->> 'seats')::int)
  on conflict (user_id) do update set make = excluded.make, model = excluded.model, colour = excluded.colour,
                                      plate = excluded.plate, seats = excluded.seats, updated_at = now();
$$;

-- A place {lat, lng, label} as stored for default pickups / dropoffs (null is fine).
create or replace function public.siosia_valid_place(p jsonb)
returns boolean language sql immutable as $$
  select p is null or (jsonb_typeof(p -> 'lat') = 'number' and jsonb_typeof(p -> 'lng') = 'number'
                       and abs((p ->> 'lat')::float8) <= 90 and abs((p ->> 'lng')::float8) <= 180
                       and char_length(coalesce(p ->> 'label', '')) between 1 and 120);
$$;

-- Opens a master profile from its link: this device's user becomes that profile (nickname, icon,
-- fixed fare, rider only). The link replaces the invite code; wrong tokens count as failed invite
-- attempts (same rate limit).
drop function if exists public.siosia_join_master(text, text, text);
create or replace function public.siosia_join_master(p_token text, p_device text, p_language text, p_replace boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); m master_profiles;
begin
  if v_uid is null then return siosia_err('forbidden'); end if;
  if coalesce(char_length(p_device), 0) not between 1 and 80 then return siosia_err('bad_input'); end if;
  if (select count(*) from invite_failures where user_id = v_uid and at > now() - interval '1 hour') >= 10 then
    return siosia_err('rate_limited');
  end if;
  select * into m from master_profiles
   where token_hash = encode(digest(btrim(coalesce(p_token, '')), 'sha256'), 'hex') and active;
  if m.id is null then
    insert into invite_failures (user_id) values (v_uid);
    return siosia_err('bad_link');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  if exists (select 1 from rides where driver_id = v_uid and status in ('accepted','arrived','in_progress')) then
    return siosia_err('active_trip');
  end if;
  if exists (select 1 from rides where rider_id = v_uid and status in ('requested','accepted','arrived','in_progress')) then
    return siosia_err('active_ride');
  end if;
  -- Replacing another profile on this account (a nickname of its own, or another master) needs the
  -- user's explicit confirmation.
  if not coalesce(p_replace, false)
     and exists (select 1 from profiles where user_id = v_uid and not deleted and master_id is distinct from m.id) then
    return siosia_err('has_profile');
  end if;
  perform siosia_go_offline(v_uid);
  insert into memberships (user_id, device_id, via_master) values (v_uid, p_device, m.id)
  on conflict (user_id, device_id) do update
    set via_master = case when memberships.via_master is null then null else excluded.via_master end;
  insert into profiles (user_id, nickname, language, master_id)
  values (v_uid, m.nickname, case when p_language = 'pl' then 'pl' else 'en' end, m.id)
  on conflict (user_id) do update set nickname = excluded.nickname, master_id = excluded.master_id, deleted = false;
  if m.role = 'driver' and m.vehicle ? 'plate' then perform siosia_apply_master_vehicle(v_uid, m.vehicle); end if;
  perform siosia_notify(v_uid);
  return siosia_ok(siosia_profile_json(v_uid));
end $$;

-- A one-time code (30 min) that lets another app or phone take over this profile.
create or replace function public.siosia_create_transfer()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
  v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_raw text := ''; b bytea := gen_random_bytes(8);
  v_exp timestamptz := now() + interval '30 minutes';
begin
  if v_err is not null then return siosia_err(v_err); end if;
  delete from account_transfers where user_id = v_uid or expires_at < now();
  for i in 0..7 loop
    v_raw := v_raw || substr(v_alpha, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  insert into account_transfers (code_hash, user_id, expires_at)
  values (encode(digest(v_raw, 'sha256'), 'hex'), v_uid, v_exp);
  return siosia_ok(jsonb_build_object('code', substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4),
                                      'expiresAt', siosia_ms(v_exp)));
end $$;

-- Redeems a code on this app/phone: the old account's profile, vehicle, history, ratings and master
-- link move here (the old app starts fresh). Another profile here is merged into it only when the
-- user confirmed (p_replace). Wrong codes count as failed invite attempts.
create or replace function public.siosia_redeem_transfer(p_code text, p_device text, p_replace boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); t account_transfers; v_old uuid; v_via text; v_hash text;
begin
  if v_uid is null then return siosia_err('forbidden'); end if;
  if coalesce(char_length(p_device), 0) not between 1 and 80 then return siosia_err('bad_input'); end if;
  if (select count(*) from invite_failures where user_id = v_uid and at > now() - interval '1 hour') >= 10 then
    return siosia_err('rate_limited');
  end if;
  v_hash := encode(digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
  select * into t from account_transfers where code_hash = v_hash and expires_at > now();
  v_old := t.user_id;
  if v_old is null or not exists (select 1 from profiles where user_id = v_old and not deleted) then
    insert into invite_failures (user_id) values (v_uid);
    return siosia_err('bad_transfer');
  end if;
  if v_old = v_uid then
    delete from account_transfers where code_hash = v_hash;
    return siosia_ok(siosia_profile_json(v_uid));
  end if;
  -- Both accounts, always in the same order (no deadlock with a concurrent move).
  perform pg_advisory_xact_lock(hashtextextended(least(v_old, v_uid)::text, 7));
  perform pg_advisory_xact_lock(hashtextextended(greatest(v_old, v_uid)::text, 7));
  perform siosia_sweep();
  if exists (select 1 from rides where status in ('requested','accepted','arrived','in_progress')
             and (rider_id in (v_old, v_uid) or driver_id in (v_old, v_uid))) then
    return siosia_err('active_ride');
  end if;
  if not coalesce(p_replace, false) and exists (select 1 from profiles where user_id = v_uid and not deleted) then
    return siosia_err('has_profile');
  end if;
  perform siosia_go_offline(v_old);
  perform siosia_go_offline(v_uid);
  update rides set rider_id = v_uid where rider_id = v_old;
  update rides set driver_id = v_uid where driver_id = v_old;
  update rides set excluded = array_replace(excluded, v_old, v_uid) where v_old = any (excluded);
  update offers set driver_id = v_uid where driver_id = v_old;
  update ratings set from_user = v_uid where from_user = v_old;
  update ratings set to_user = v_uid where to_user = v_old;
  delete from profiles where user_id = v_uid;
  update profiles set user_id = v_uid where user_id = v_old;
  if exists (select 1 from vehicles where user_id = v_old) then
    delete from vehicles where user_id = v_uid;
    update vehicles set user_id = v_uid where user_id = v_old;
  end if;
  delete from driver_status where user_id = v_old;
  -- This device becomes a member the way the old account was: invite code first, else its link.
  select via_master into v_via from memberships where user_id = v_old order by via_master nulls first limit 1;
  insert into memberships (user_id, device_id, via_master) values (v_uid, p_device, v_via)
  on conflict (user_id, device_id) do update
    set via_master = case when memberships.via_master is null then null else excluded.via_master end;
  delete from memberships where user_id = v_old;
  delete from account_transfers where user_id = v_old;
  perform siosia_notify(v_old);
  perform siosia_notify(v_uid);
  return siosia_ok(siosia_profile_json(v_uid));
end $$;

-- Operator only (SQL editor): create or update a master profile and (re)set its link token. The
-- link is <app URL>#master=<token>; setting a new token makes the old link stop working.
--   p_role 'rider': p_fixed_fare (null = tariff), p_pickup / p_dropoff {lat, lng, label} defaults.
--   p_role 'driver': p_vehicle {make, model, colour, seats, plate?}.
drop function if exists public.siosia_set_master(text, text, text, text, numeric);
create or replace function public.siosia_set_master(p_id text, p_token text, p_nickname text, p_icon text, p_fixed_fare numeric,
                                                    p_role text default 'rider', p_pickup jsonb default null,
                                                    p_dropoff jsonb default null, p_vehicle jsonb default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text := encode(digest(btrim(coalesce(p_token, '')), 'sha256'), 'hex'); u record;
begin
  if btrim(coalesce(p_token, '')) !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'The link token must be 16-128 characters: letters, digits, - or _';
  end if;
  if p_role is null or p_role not in ('rider', 'driver') then raise exception 'p_role must be rider or driver'; end if;
  if not siosia_valid_place(p_pickup) or not siosia_valid_place(p_dropoff) then
    raise exception 'A place is {"lat": number, "lng": number, "label": "1-120 characters"}';
  end if;
  if p_vehicle is not null and (
       char_length(coalesce(p_vehicle ->> 'make', '')) not between 1 and 30
       or char_length(coalesce(p_vehicle ->> 'model', '')) not between 1 and 30
       or char_length(coalesce(p_vehicle ->> 'colour', '')) not between 1 and 20
       or jsonb_typeof(p_vehicle -> 'seats') <> 'number' or (p_vehicle ->> 'seats')::numeric not between 1 and 6
       or (p_vehicle ? 'plate' and char_length(coalesce(p_vehicle ->> 'plate', '')) not between 2 and 12)) then
    raise exception 'A vehicle is {"make", "model", "colour", "seats": 1-6, "plate"?: 2-12 characters}';
  end if;
  -- A new token retires the old link: phones that joined only through it must open the new one.
  delete from memberships mb using master_profiles m
   where mb.via_master = m.id and m.id = p_id and m.token_hash <> v_hash;
  insert into master_profiles (id, token_hash, nickname, icon, fixed_fare, active, role, default_pickup, default_dropoff, vehicle)
  values (p_id, v_hash, btrim(p_nickname), nullif(btrim(coalesce(p_icon, '')), ''),
          p_fixed_fare, true, p_role, p_pickup, p_dropoff, p_vehicle)
  on conflict (id) do update set token_hash = excluded.token_hash, nickname = excluded.nickname, icon = excluded.icon,
                                  fixed_fare = excluded.fixed_fare, active = true, role = excluded.role,
                                  default_pickup = excluded.default_pickup, default_dropoff = excluded.default_dropoff,
                                  vehicle = excluded.vehicle;
  update profiles set nickname = btrim(p_nickname) where master_id = p_id and not deleted;
  -- Phones already on this profile follow its role: riders leave the driver seat; drivers get the
  -- preset vehicle when it is complete.
  for u in select user_id from profiles where master_id = p_id and not deleted loop
    if p_role = 'rider' and not exists (select 1 from rides where driver_id = u.user_id
                                         and status in ('accepted','arrived','in_progress')) then
      perform siosia_go_offline(u.user_id);
    elsif p_role = 'driver' and p_vehicle ? 'plate' then
      perform siosia_apply_master_vehicle(u.user_id, p_vehicle);
    end if;
  end loop;
  return format('Master profile %s is ready. Share <app URL>#master=<token>.', p_id);
end $$;

create or replace function public.siosia_is_member(p_device text)
returns boolean language sql stable security definer set search_path = public as $$
  select siosia_member_ok(auth.uid(), p_device);
$$;

create or replace function public.siosia_get_profile()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(false);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(siosia_profile_json(auth.uid()));
end $$;

create or replace function public.siosia_save_profile(p_nickname text, p_language text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(false); v_nick text := btrim(coalesce(p_nickname, ''));
begin
  if v_err is not null then return siosia_err(v_err); end if;
  -- A master profile's nickname is set by the operator; only the language changes here.
  select coalesce(m.nickname, p.nickname, v_nick) into v_nick
    from (select 1) one
    left join profiles p on p.user_id = auth.uid() and not p.deleted and p.master_id is not null
    left join master_profiles m on m.id = p.master_id;
  if char_length(v_nick) not between 2 and 20 then return siosia_err('bad_nickname'); end if;
  insert into profiles (user_id, nickname, language)
  values (auth.uid(), v_nick, case when p_language = 'pl' then 'pl' else 'en' end)
  on conflict (user_id) do update set nickname = excluded.nickname, language = excluded.language, deleted = false;
  return siosia_ok(siosia_profile_json(auth.uid()));
end $$;

create or replace function public.siosia_get_vehicle()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(false);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(siosia_vehicle_json(auth.uid()));
end $$;

create or replace function public.siosia_save_vehicle(p_make text, p_model text, p_colour text, p_plate text, p_seats int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true);
  v_make text := btrim(coalesce(p_make, '')); v_model text := btrim(coalesce(p_model, ''));
  v_colour text := btrim(coalesce(p_colour, '')); v_plate text := upper(btrim(coalesce(p_plate, '')));
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if siosia_master_role(auth.uid()) = 'rider' then return siosia_err('rider_only'); end if;
  if char_length(v_make) not between 1 and 30 or char_length(v_model) not between 1 and 30
     or char_length(v_colour) not between 1 and 20 or char_length(v_plate) not between 2 and 12
     or p_seats is null or p_seats not between 1 and 6 then
    return siosia_err('bad_vehicle');
  end if;
  insert into vehicles (user_id, make, model, colour, plate, seats)
  values (auth.uid(), v_make, v_model, v_colour, v_plate, p_seats)
  on conflict (user_id) do update set make = excluded.make, model = excluded.model, colour = excluded.colour,
                                      plate = excluded.plate, seats = excluded.seats, updated_at = now();
  return siosia_ok(siosia_vehicle_json(auth.uid()));
end $$;

-- Delete = anonymise (nickname "Deleted user"), remove vehicle and memberships (§9 retention).
create or replace function public.siosia_delete_profile()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if exists (select 1 from rides where status in ('requested','accepted','arrived','in_progress')
             and (rider_id = v_uid or driver_id = v_uid)) then
    return siosia_err('active_ride');
  end if;
  update rides set status = 'cancelled', ended_at = now(), cancelled_by = 'rider'
   where rider_id = v_uid and status = 'scheduled';
  update rides set driver_id = null where driver_id = v_uid and status = 'scheduled';
  perform siosia_go_offline(v_uid);
  delete from vehicles where user_id = v_uid;
  delete from memberships where user_id = v_uid;
  update profiles set nickname = 'Deleted user', deleted = true, master_id = null where user_id = v_uid;
  return siosia_ok('true'::jsonb);
end $$;

create or replace function public.siosia_my_state()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(false);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  return siosia_ok(siosia_state_json(auth.uid()));
end $$;

create or replace function public.siosia_get_ride(p_ride uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(false); r rides;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into r from rides where id = p_ride and (rider_id = auth.uid() or driver_id = auth.uid());
  if r.id is null then return siosia_err('not_found'); end if;
  return siosia_ok(siosia_ride_json(r, auth.uid()));
end $$;

create or replace function public.siosia_history()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(false);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(coalesce((
    select jsonb_agg(siosia_ride_json(x, auth.uid()) order by x.requested_at desc)
    from (select * from rides where (rider_id = auth.uid() or driver_id = auth.uid()) and status <> 'scheduled'
          order by requested_at desc limit 50) x), '[]'::jsonb));
end $$;

-- FR-063: completed rides only, in the deployment's timezone.
create or replace function public.siosia_earnings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(false); c app_config; v_today date; v jsonb;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  select * into c from app_config where id = 1;
  v_today := (now() at time zone c.timezone)::date;
  select jsonb_build_object(
    'todayTotal', coalesce(sum(fare) filter (where (ended_at at time zone c.timezone)::date = v_today), 0),
    'todayCount', count(*) filter (where (ended_at at time zone c.timezone)::date = v_today),
    'monthTotal', coalesce(sum(fare), 0),
    'monthCount', count(*),
    'currency', c.currency)
  into v
  from rides
  where driver_id = auth.uid() and status = 'completed'
    and date_trunc('month', ended_at at time zone c.timezone) = date_trunc('month', now() at time zone c.timezone);
  return siosia_ok(v);
end $$;

create or replace function public.siosia_request_ride(p_pickup jsonb, p_dropoff jsonb, p_est_km float8, p_est_min float8, p_fare_is_estimate boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text := siosia_guard(true); v_uid uuid := auth.uid(); c app_config; r rides;
  plat float8; plng float8; dlat float8; dlng float8; v_km float8; v_min float8; v_fixed numeric;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if siosia_master_role(v_uid) = 'driver' then return siosia_err('driver_only'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  if exists (select 1 from rides where status in ('requested','accepted','arrived','in_progress')
             and (rider_id = v_uid or driver_id = v_uid)) then
    return siosia_err('active_ride');
  end if;
  if exists (select 1 from driver_status where user_id = v_uid and online) then
    -- FR-005 applies to a live driver session; a driver tab that died (silent > 12 s, no trip —
    -- checked above) must not block this user from riding, so close that stale session.
    if exists (select 1 from driver_status where user_id = v_uid and online and last_seen >= now() - interval '12 seconds') then
      return siosia_err('online_as_driver');
    end if;
    perform siosia_go_offline(v_uid);
  end if;
  begin
    plat := (p_pickup ->> 'lat')::float8;  plng := (p_pickup ->> 'lng')::float8;
    dlat := (p_dropoff ->> 'lat')::float8; dlng := (p_dropoff ->> 'lng')::float8;
  exception when others then return siosia_err('bad_input');
  end;
  if plat is null or plng is null or dlat is null or dlng is null
     or abs(plat) > 90 or abs(dlat) > 90 or abs(plng) > 180 or abs(dlng) > 180
     or p_est_km is null or p_est_min is null or p_est_km <= 0 or p_est_min < 0
     or p_est_km = 'Infinity'::float8 or p_est_min = 'Infinity'::float8 then
    return siosia_err('bad_input');
  end if;
  select * into c from app_config where id = 1;
  if c.service_lat is not null and c.service_lng is not null and c.service_radius_km is not null
     and siosia_km(c.service_lat, c.service_lng, plat, plng) > c.service_radius_km then
    return siosia_err('outside_area');
  end if;
  -- Never trust a route shorter than the straight line.
  v_km := greatest(p_est_km, siosia_km(plat, plng, dlat, dlng));
  if v_km > c.max_trip_km then return siosia_err('too_far'); end if;
  v_min := greatest(1, p_est_min);
  -- A master profile rides at its fixed fare, whatever the route.
  v_fixed := case when (siosia_master_of(v_uid)).role = 'rider' then (siosia_master_of(v_uid)).fixed_fare end;
  insert into rides (rider_id, pickup_lat, pickup_lng, pickup_label, dropoff_lat, dropoff_lng, dropoff_label,
                     est_km, est_min, fare, currency, fare_is_estimate)
  values (v_uid, plat, plng, left(coalesce(p_pickup ->> 'label', ''), 120),
          dlat, dlng, left(coalesce(p_dropoff ->> 'label', ''), 120),
          round(v_km::numeric, 1), round(v_min)::int,
          coalesce(v_fixed, siosia_fare(v_km::numeric, v_min::numeric)), c.currency,
          v_fixed is null and coalesce(p_fare_is_estimate, false))
  returning * into r;
  return siosia_ok(siosia_ride_json(r, v_uid));
exception when unique_violation then
  return siosia_err('active_ride');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Rides booked in advance
-- ---------------------------------------------------------------------------------------------

create or replace function public.siosia_book_ride(p_pickup jsonb, p_dropoff jsonb, p_est_km float8, p_est_min float8,
                                                   p_fare_is_estimate boolean, p_scheduled_for timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text := siosia_guard(true); v_uid uuid := auth.uid(); c app_config; r rides;
  plat float8; plng float8; dlat float8; dlng float8; v_km float8; v_min float8; v_fixed numeric;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if siosia_master_role(v_uid) = 'driver' then return siosia_err('driver_only'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  begin
    plat := (p_pickup ->> 'lat')::float8;  plng := (p_pickup ->> 'lng')::float8;
    dlat := (p_dropoff ->> 'lat')::float8; dlng := (p_dropoff ->> 'lng')::float8;
  exception when others then return siosia_err('bad_input');
  end;
  if plat is null or plng is null or dlat is null or dlng is null
     or abs(plat) > 90 or abs(dlat) > 90 or abs(plng) > 180 or abs(dlng) > 180
     or p_est_km is null or p_est_min is null or p_est_km <= 0 or p_est_min < 0
     or p_est_km = 'Infinity'::float8 or p_est_min = 'Infinity'::float8 then
    return siosia_err('bad_input');
  end if;
  select * into c from app_config where id = 1;
  if c.service_lat is not null and c.service_lng is not null and c.service_radius_km is not null
     and siosia_km(c.service_lat, c.service_lng, plat, plng) > c.service_radius_km then
    return siosia_err('outside_area');
  end if;
  v_km := greatest(p_est_km, siosia_km(plat, plng, dlat, dlng));
  if v_km > c.max_trip_km then return siosia_err('too_far'); end if;
  v_min := greatest(1, p_est_min);
  if p_scheduled_for is null or p_scheduled_for < now() + make_interval(mins => c.booking_min_lead_min)
     or p_scheduled_for > now() + make_interval(days => c.booking_max_days) then
    return siosia_err('bad_time');
  end if;
  if (select count(*) from rides where rider_id = v_uid and status = 'scheduled') >= 5 then
    return siosia_err('too_many');
  end if;
  v_fixed := case when (siosia_master_of(v_uid)).role = 'rider' then (siosia_master_of(v_uid)).fixed_fare end;
  insert into rides (rider_id, status, scheduled_for, dispatch_started_at, pickup_lat, pickup_lng, pickup_label,
                     dropoff_lat, dropoff_lng, dropoff_label, est_km, est_min, fare, currency, fare_is_estimate)
  values (v_uid, 'scheduled', p_scheduled_for, p_scheduled_for, plat, plng, left(coalesce(p_pickup ->> 'label', ''), 120),
          dlat, dlng, left(coalesce(p_dropoff ->> 'label', ''), 120),
          round(v_km::numeric, 1), round(v_min)::int,
          coalesce(v_fixed, siosia_fare(v_km::numeric, v_min::numeric)), c.currency,
          v_fixed is null and coalesce(p_fare_is_estimate, false))
  returning * into r;
  return siosia_ok(siosia_ride_json(r, v_uid));
end $$;

-- My upcoming bookings, as rider or as the driver who took them, soonest first.
create or replace function public.siosia_bookings()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(false);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  return siosia_ok(coalesce((
    select jsonb_agg(siosia_ride_json(x, auth.uid()) order by x.scheduled_for)
      from rides x where x.status = 'scheduled' and (x.rider_id = auth.uid() or x.driver_id = auth.uid())), '[]'::jsonb));
end $$;

-- Bookings without a driver that this driver could take, soonest first, with the distance from
-- the position sent with the call (used for this answer only, never stored).
create or replace function public.siosia_open_bookings(p_lat float8, p_lng float8)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if siosia_master_role(v_uid) = 'rider' then return siosia_err('rider_only'); end if;
  perform siosia_sweep();
  return siosia_ok(coalesce((
    select jsonb_agg(jsonb_build_object(
             'ride', siosia_ride_json(x, v_uid),
             'distanceKm', case when p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then null
                                else round(siosia_km(p_lat, p_lng, x.pickup_lat, x.pickup_lng)::numeric, 1) end)
           order by x.scheduled_for)
      from rides x where x.status = 'scheduled' and x.driver_id is null and x.rider_id <> v_uid
                     and not (v_uid = any (x.excluded))), '[]'::jsonb));
end $$;

-- A driver takes a booking in advance (atomic: one driver wins); no two overlapping ones.
create or replace function public.siosia_claim_booking(p_ride uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); r rides;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if siosia_master_role(v_uid) = 'rider' then return siosia_err('rider_only'); end if;
  if not exists (select 1 from vehicles where user_id = v_uid) then return siosia_err('no_vehicle'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  select * into r from rides where id = p_ride;
  if r.id is null or r.rider_id = v_uid or v_uid = any (r.excluded) then return siosia_err('not_found'); end if;
  if r.status <> 'scheduled' or r.driver_id is not null then return siosia_err('taken'); end if;
  if exists (select 1 from rides x where x.status = 'scheduled' and x.driver_id = v_uid
             and abs(extract(epoch from x.scheduled_for - r.scheduled_for)) < (greatest(x.est_min, r.est_min) + 30) * 60) then
    return siosia_err('overlap');
  end if;
  update rides set driver_id = v_uid where id = p_ride and status = 'scheduled' and driver_id is null;
  if not found then return siosia_err('taken'); end if;
  return siosia_ok('"won"'::jsonb);
end $$;

-- The driver gives a booking back (close to its time this counts as a driver cancellation).
create or replace function public.siosia_release_booking(p_ride uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); r rides;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into r from rides where id = p_ride for update;
  if r.id is null or r.driver_id is distinct from v_uid then return siosia_err('not_found'); end if;
  if r.status <> 'scheduled' then return siosia_err('illegal_transition'); end if;
  if r.scheduled_for - now() < interval '60 minutes' then
    update profiles set driver_cancels = driver_cancels + 1 where user_id = v_uid;
  end if;
  update rides set driver_id = null where id = p_ride;
  return siosia_ok('true'::jsonb);
end $$;

create or replace function public.siosia_cancel_ride(p_ride uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); r rides; c app_config;
  v_reason text := case when p_reason in ('no_show','wrong_pickup','vehicle_problem','other') then p_reason else 'other' end;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into r from rides where id = p_ride for update;
  if r.id is null then return siosia_err('not_found'); end if;
  if r.rider_id = v_uid and r.status = 'scheduled' then
    if r.scheduled_for - now() < interval '60 minutes' then
      update profiles set rider_cancels = rider_cancels + 1 where user_id = v_uid;
    end if;
    perform siosia_end_ride(r.id, 'cancelled', 'rider', null, array['scheduled']);
    return siosia_ok('true'::jsonb);
  elsif r.driver_id = v_uid and r.status = 'scheduled' then
    return siosia_release_booking(r.id);
  elsif r.rider_id = v_uid then
    if r.status not in ('requested','accepted','arrived') then return siosia_err('illegal_transition'); end if;
    update profiles set rider_cancels = rider_cancels + 1,
                        late_cancels = late_cancels + case when r.status = 'arrived' then 1 else 0 end
     where user_id = v_uid;
    perform siosia_end_ride(r.id, 'cancelled', 'rider', case when r.status = 'arrived' then 'late_cancel' end);
    return siosia_ok('true'::jsonb);
  elsif r.driver_id = v_uid then
    if r.status = 'arrived' and v_reason = 'no_show' then
      select * into c from app_config where id = 1;
      if r.arrived_at is null or now() < r.arrived_at + make_interval(secs => c.no_show_wait_s) then
        return siosia_err('too_early');
      end if;
      perform siosia_end_ride(r.id, 'cancelled', 'driver', 'no_show');
      return siosia_ok('true'::jsonb);
    end if;
    if r.status not in ('accepted','arrived') then return siosia_err('illegal_transition'); end if;
    update profiles set driver_cancels = driver_cancels + 1 where user_id = v_uid;
    perform siosia_redispatch(r.id, v_reason, v_uid);
    return siosia_ok('true'::jsonb);
  end if;
  return siosia_err('forbidden');
end $$;

create or replace function public.siosia_set_online(p_online boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_fresh boolean; v_was boolean;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  if p_online then
    if siosia_master_role(v_uid) = 'rider' then return siosia_err('rider_only'); end if;
    if not exists (select 1 from vehicles where user_id = v_uid) then return siosia_err('no_vehicle'); end if;
    if exists (select 1 from rides where rider_id = v_uid and status in ('requested','accepted','arrived','in_progress')) then
      return siosia_err('active_ride');
    end if;
    select online into v_was from driver_status where user_id = v_uid for update;
    v_fresh := not coalesce(v_was, false);
    insert into driver_status (user_id, online, last_seen) values (v_uid, true, now())
    on conflict (user_id) do update set online = true, last_seen = now();
    -- A new online session reviews every pending request nearby again — including ones this
    -- driver declined or let lapse earlier.
    if v_fresh then perform siosia_clear_decisions(v_uid); end if;
  else
    if exists (select 1 from rides where driver_id = v_uid and status in ('accepted','arrived','in_progress')) then
      return siosia_err('active_trip');
    end if;
    perform siosia_go_offline(v_uid);
  end if;
  perform siosia_notify(v_uid);
  return siosia_ok('true'::jsonb);
end $$;

-- Heartbeat: liveness + sweep + pull offers. p_lat/p_lng are used for matching ONLY and are
-- never written anywhere (FR-043). Returns the caller's state, like siosia_my_state().
create or replace function public.siosia_heartbeat(p_lat float8, p_lng float8)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_idle boolean := false;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  -- Same per-driver lock as set_online / decide_offer / refresh_offers: one pull at a time.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  update driver_status set last_seen = now() where user_id = v_uid and online;
  if found then
    perform siosia_sweep();
    if p_lat is not null and p_lng is not null and abs(p_lat) <= 90 and abs(p_lng) <= 180
       and not exists (select 1 from rides where driver_id = v_uid and status in ('accepted','arrived','in_progress')) then
      v_idle := true;
      perform siosia_pull_offers(v_uid, p_lat, p_lng);
    end if;
  end if;
  return siosia_ok(case when v_idle then siosia_state_json(v_uid, p_lat, p_lng) else siosia_state_json(v_uid) end);
end $$;

-- "Show requests": re-offer every pending request near the driver, including ones they declined
-- or let lapse (one card at a time, the rest queued). Drivers who cancelled a ride stay excluded.
create or replace function public.siosia_refresh_offers(p_lat float8, p_lng float8)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return siosia_err('bad_input'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  update driver_status set last_seen = now() where user_id = v_uid and online;
  if not found then return siosia_err('not_online'); end if;
  perform siosia_sweep();
  if exists (select 1 from rides where driver_id = v_uid and status in ('accepted','arrived','in_progress')) then
    return siosia_err('active_trip');
  end if;
  perform siosia_clear_decisions(v_uid);
  perform siosia_pull_offers(v_uid, p_lat, p_lng);
  perform siosia_notify(v_uid);
  return siosia_ok(siosia_state_json(v_uid, p_lat, p_lng));
end $$;

create or replace function public.siosia_decide_offer(p_offer uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); o offers; r rides; c app_config; v_won uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  update driver_status set last_seen = now() where user_id = v_uid and online; -- a sign of life
  perform siosia_sweep();
  select * into o from offers where id = p_offer and driver_id = v_uid;
  if o.id is null then return siosia_err('not_found'); end if;
  select * into r from rides where id = o.ride_id;
  if p_decision = 'accept' then
    if o.status <> 'offered' then
      return siosia_err(case when r.status <> 'requested' and r.driver_id is distinct from v_uid then 'taken' else 'offer_expired' end);
    end if;
    if not exists (select 1 from driver_status where user_id = v_uid and online) then return siosia_err('not_online'); end if;
    if exists (select 1 from rides where status in ('requested','accepted','arrived','in_progress')
               and (rider_id = v_uid or driver_id = v_uid)) then
      return siosia_err('active_trip');
    end if;
    -- Atomic claim (§6 rule 3): succeeds only while the ride is still requested in this round.
    update rides set status = 'accepted', driver_id = v_uid, accepted_at = now()
     where id = o.ride_id and status = 'requested' and round = o.round
    returning id into v_won;
    if v_won is null then
      perform siosia_close_offer(o.id, 'withdrawn');
      return siosia_err('taken');
    end if;
    update offers set status = 'won', decided_at = now() where id = o.id;
    perform siosia_withdraw_ride_offers(o.ride_id);
    perform siosia_drop_cards(v_uid);
    return siosia_ok('"won"'::jsonb);
  elsif p_decision in ('decline','timeout') then
    if o.status in ('offered','queued') then
      select * into c from app_config where id = 1;
      if p_decision = 'timeout' and o.status = 'offered'
         and now() < o.offered_at + make_interval(secs => c.offer_timeout_s - 1) then
        return siosia_ok('"ok"'::jsonb); -- early client timer; the server clock decides
      end if;
      perform siosia_close_offer(o.id, case when p_decision = 'decline' then 'declined' else 'timed_out' end);
      perform siosia_notify(r.rider_id);
    elsif o.status = 'withdrawn' or (o.status = 'timed_out' and p_decision = 'decline') then
      -- Decided after the card left the screen server-side (phone briefly offline, or a Decline
      -- landing just after the countdown): a Decline is recorded as such; a timeout is like any
      -- lapsed card and comes back after offer_retry_s.
      update offers set status = case when p_decision = 'decline' then 'declined' else 'timed_out' end,
                        decided_at = now()
       where id = o.id;
    end if;
    return siosia_ok('"ok"'::jsonb);
  end if;
  return siosia_err('bad_input');
end $$;

-- After winning a ride the driver is busy: their other cards go away (those rides stay open).
create or replace function public.siosia_drop_cards(p_driver uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update offers set status = 'withdrawn', decided_at = now()
   where driver_id = p_driver and status in ('offered','queued');
end $$;

create or replace function public.siosia_advance(p_ride uuid, p_to text, p_actual_km float8)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); r rides;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  update driver_status set last_seen = now() where user_id = v_uid and online; -- a sign of life
  perform siosia_sweep();
  select * into r from rides where id = p_ride for update;
  if r.id is null then return siosia_err('not_found'); end if;
  if r.driver_id is distinct from v_uid then return siosia_err('forbidden'); end if;
  if r.status = 'accepted' and p_to = 'arrived' then
    update rides set status = 'arrived', arrived_at = now() where id = p_ride returning * into r;
  elsif r.status = 'arrived' and p_to = 'in_progress' then
    update rides set status = 'in_progress', started_at = now() where id = p_ride returning * into r;
  elsif r.status = 'in_progress' and p_to = 'completed' then
    update rides set status = 'completed', ended_at = now(),
                     actual_km = round(least(greatest(coalesce(nullif(p_actual_km, 'NaN'::float8), 0), 0), 1000)::numeric, 1),
                     actual_min = round((extract(epoch from now() - coalesce(started_at, now())) / 60)::numeric, 1)
     where id = p_ride returning * into r;
  else
    return siosia_err('illegal_transition');
  end if;
  return siosia_ok(siosia_ride_json(r, v_uid));
end $$;

-- Receipt actions are allowed within 24 h of completion; status unchanged (§5).
create or replace function public.siosia_after_ride(p_ride uuid)
returns rides language plpgsql stable security definer set search_path = public as $$
declare r rides;
begin
  select * into r from rides where id = p_ride and (rider_id = auth.uid() or driver_id = auth.uid());
  return r;
end $$;

create or replace function public.siosia_mark_paid(p_ride uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); r rides := siosia_after_ride(p_ride);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if r.id is null then return siosia_err('not_found'); end if;
  if r.rider_id <> auth.uid() then return siosia_err('forbidden'); end if;
  if r.status <> 'completed' then return siosia_err('illegal_transition'); end if;
  if now() > r.ended_at + interval '24 hours' then return siosia_err('window_closed'); end if;
  update rides set paid = true where id = p_ride;
  return siosia_ok('true'::jsonb);
end $$;

create or replace function public.siosia_mark_collected(p_ride uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); r rides := siosia_after_ride(p_ride);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if r.id is null then return siosia_err('not_found'); end if;
  if r.driver_id is distinct from auth.uid() then return siosia_err('forbidden'); end if;
  if r.status <> 'completed' then return siosia_err('illegal_transition'); end if;
  if now() > r.ended_at + interval '24 hours' then return siosia_err('window_closed'); end if;
  update rides set collected = true where id = p_ride;
  return siosia_ok('true'::jsonb);
end $$;

create or replace function public.siosia_rate(p_ride uuid, p_stars int, p_comment text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); r rides := siosia_after_ride(p_ride); v_to uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if r.id is null then return siosia_err('not_found'); end if;
  if r.status <> 'completed' then return siosia_err('illegal_transition'); end if;
  if now() > r.ended_at + interval '24 hours' then return siosia_err('window_closed'); end if;
  v_to := case when r.rider_id = v_uid then r.driver_id else r.rider_id end;
  if v_to is null then return siosia_err('forbidden'); end if;
  if p_stars is null or p_stars not between 1 and 5 then return siosia_err('bad_input'); end if;
  insert into ratings (ride_id, from_user, to_user, stars, comment)
  values (p_ride, v_uid, v_to, p_stars, left(btrim(coalesce(p_comment, '')), 140));
  perform siosia_notify(r.rider_id);
  perform siosia_notify(r.driver_id);
  return siosia_ok('true'::jsonb);
exception when unique_violation then
  return siosia_err('already_rated');
end $$;

-- 12-month retention (§9) + housekeeping. Scheduled daily when pg_cron is available.
create or replace function public.siosia_retention()
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from rides where coalesce(ended_at, requested_at) < now() - interval '12 months';
  delete from invite_failures where at < now() - interval '1 day';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Function privileges: clients get the API above, nothing else.
-- ---------------------------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'siosia\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function public.siosia_config() to anon, authenticated;
grant execute on function public.siosia_join(text, text) to authenticated;
grant execute on function public.siosia_join_master(text, text, text, boolean) to authenticated;
grant execute on function public.siosia_create_transfer() to authenticated;
grant execute on function public.siosia_redeem_transfer(text, text, boolean) to authenticated;
grant execute on function public.siosia_is_member(text) to authenticated;
grant execute on function public.siosia_get_profile() to authenticated;
grant execute on function public.siosia_save_profile(text, text) to authenticated;
grant execute on function public.siosia_get_vehicle() to authenticated;
grant execute on function public.siosia_save_vehicle(text, text, text, text, int) to authenticated;
grant execute on function public.siosia_delete_profile() to authenticated;
grant execute on function public.siosia_my_state() to authenticated;
grant execute on function public.siosia_get_ride(uuid) to authenticated;
grant execute on function public.siosia_history() to authenticated;
grant execute on function public.siosia_earnings() to authenticated;
grant execute on function public.siosia_request_ride(jsonb, jsonb, float8, float8, boolean) to authenticated;
grant execute on function public.siosia_cancel_ride(uuid, text) to authenticated;
grant execute on function public.siosia_book_ride(jsonb, jsonb, float8, float8, boolean, timestamptz) to authenticated;
grant execute on function public.siosia_bookings() to authenticated;
grant execute on function public.siosia_open_bookings(float8, float8) to authenticated;
grant execute on function public.siosia_claim_booking(uuid) to authenticated;
grant execute on function public.siosia_release_booking(uuid) to authenticated;
grant execute on function public.siosia_set_online(boolean) to authenticated;
grant execute on function public.siosia_heartbeat(float8, float8) to authenticated;
grant execute on function public.siosia_refresh_offers(float8, float8) to authenticated;
grant execute on function public.siosia_decide_offer(uuid, text) to authenticated;
grant execute on function public.siosia_advance(uuid, text, float8) to authenticated;
grant execute on function public.siosia_mark_paid(uuid) to authenticated;
grant execute on function public.siosia_mark_collected(uuid) to authenticated;
grant execute on function public.siosia_rate(uuid, int, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Realtime authorization (private channels). Turn OFF "Allow public access" in Realtime settings.
-- ---------------------------------------------------------------------------------------------

-- Topic suffix "<ride uuid>:<round>": only the current round's two parties are authorised, so a
-- driver removed by re-dispatch cannot follow the ride on the new channel.
create or replace function public.siosia_in_ride(p_ride_text text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from rides
                 where id::text = split_part(p_ride_text, ':', 1)
                   and round::text = split_part(p_ride_text, ':', 2)
                   and (rider_id = auth.uid() or driver_id = auth.uid())
                   and status in ('requested','accepted','arrived','in_progress'));
$$;

-- Receive: the shared "drivers" channel (pings + nearby-car presence), my own user topic, and
-- the channel of a ride I take part in while it is active.
create or replace function public.siosia_rt_can_read(p_topic text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and siosia_member_ok(auth.uid())
     and (p_topic = 'drivers'
          or p_topic = 'user:' || auth.uid()::text
          or (p_topic like 'ride:%' and siosia_in_ride(substr(p_topic, 6))));
$$;

-- Send: presence on "drivers" only while online as a driver; broadcast/presence on my active ride.
create or replace function public.siosia_rt_can_write(p_topic text, p_extension text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and siosia_member_ok(auth.uid())
     and ((p_topic = 'drivers' and p_extension = 'presence'
           and exists (select 1 from driver_status where user_id = auth.uid() and online))
          or (p_topic like 'ride:%' and p_extension in ('broadcast','presence')
              and siosia_in_ride(substr(p_topic, 6))));
$$;

grant execute on function public.siosia_in_ride(text) to authenticated;
grant execute on function public.siosia_rt_can_read(text) to authenticated;
grant execute on function public.siosia_rt_can_write(text, text) to authenticated;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists siosia_rt_read on realtime.messages';
    execute 'drop policy if exists siosia_rt_write on realtime.messages';
    execute 'create policy siosia_rt_read on realtime.messages for select to authenticated
               using (public.siosia_rt_can_read(realtime.topic()))';
    execute 'create policy siosia_rt_write on realtime.messages for insert to authenticated
               with check (public.siosia_rt_can_write(realtime.topic(), extension))';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Scheduled jobs (optional): server-side expiry every 10 s and daily retention. If pg_cron is not
-- available the expiry still runs on every API call ("expiry check on read").
-- ---------------------------------------------------------------------------------------------

do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname in ('siosia-sweep', 'siosia-retention');
  perform cron.schedule('siosia-sweep', '10 seconds', 'select public.siosia_sweep()');
  perform cron.schedule('siosia-retention', '17 3 * * *', 'select public.siosia_retention()');
exception when others then
  raise notice 'pg_cron not available (%); expiry runs on read instead.', sqlerrm;
end $$;
