-- =============================================================================================
-- Siosia — database schema, server rules and access policies (Supabase / Postgres 15+).
-- v1 rides plus 2.0 service catalog and appointments (siosia-spec-v2.0.md, with its Amendments 2.1:
-- open requests and the car colour, 2.2: the car sets off, 2.3: kids, kid ratings, photos, chat).
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
-- Driver standby in hours (0 = off).
alter table public.app_config add column if not exists driver_standby_h int not null default 4;
alter table public.app_config drop constraint if exists app_config_driver_standby_check;
alter table public.app_config add constraint app_config_driver_standby_check check (driver_standby_h between 0 and 24);
-- Where the notification sender lives (https://<project ref>.supabase.co/functions/v1/push-dispatch;
-- null = notifications not set up) and the site address (also the Web Push contact).
alter table public.app_config add column if not exists push_function_url text;
alter table public.app_config add column if not exists site_url text;
insert into public.app_config (id) values (1) on conflict (id) do nothing;

-- Secrets (one row). No policy → unreadable by clients.
create table if not exists public.app_secrets (
  id               smallint primary key default 1 check (id = 1),
  invite_code_hash text
);
insert into public.app_secrets (id) values (1) on conflict (id) do nothing;
-- Notifications need no hand-entered secrets: the database makes the sender's secret (checked on
-- every call to the Edge Function push-dispatch), and the function creates its Web Push (VAPID) key
-- pair on first run and keeps it here. Only the public key ever leaves (siosia_config).
alter table public.app_secrets add column if not exists push_secret text;
-- 2.7 (V66): the test invite code (bcrypt), for the live smoke tests; null = none.
alter table public.app_secrets add column if not exists test_invite_code_hash text;
alter table public.app_secrets add column if not exists vapid_public text;
alter table public.app_secrets add column if not exists vapid_private text;
update public.app_secrets set push_secret = encode(extensions.gen_random_bytes(24), 'hex') where id = 1 and push_secret is null;

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
-- Standby: until then, new requests are notified to this driver even after their app went quiet
-- (phone locked, app closed). Extended by every heartbeat; explicit offline ends it.
alter table public.driver_status add column if not exists standby_until timestamptz;

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
-- 2.7 (V66): joined with the TEST invite code — a test account, in the sandbox: it meets only other
-- test accounts, and real members never see it (lists, catalog, open requests, rides).
alter table public.memberships add column if not exists sandbox boolean not null default false;
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

-- Notifications (Web Push). A device that turned them on keeps its subscription here; events are
-- queued in push_outbox and sent by the Edge Function push-dispatch (VAPID keys live there).
create table if not exists public.push_subscriptions (
  endpoint   text primary key check (char_length(endpoint) between 10 and 1000),
  user_id    uuid not null references auth.users (id) on delete cascade,
  p256dh     text not null check (char_length(p256dh) between 10 and 200),
  auth       text not null check (char_length(auth) between 8 and 100),
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table if not exists public.push_outbox (
  id         bigserial primary key,
  user_id    uuid not null,
  kind       text not null,
  ride_id    uuid,
  params     jsonb not null default '{}',
  lang       text not null default 'en',
  tz         text not null default 'Europe/Warsaw',
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  attempts   int not null default 0
);
create index if not exists push_outbox_pending_idx on public.push_outbox (id) where sent_at is null;
alter table public.push_outbox add column if not exists claimed_at timestamptz;

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
-- Siosia 2.0: service catalog, appointments (single and series), rides as part of a service.
-- Appended to the v1 schema; every statement is idempotent.
-- ---------------------------------------------------------------------------------------------

-- Reminder slots (minutes before the start): 15…10080, at most 4, distinct.
create or replace function public.siosia_valid_slots(s int[])
returns boolean language sql immutable as $$
  select s is not null and cardinality(s) <= 4
     and not exists (select 1 from unnest(s) x where x is null or x not between 15 and 10080)
     and (select count(distinct x) from unnest(s) x) = cardinality(s);
$$;

-- The catalog (deployment configuration, set with siosia_set_services) and the appointment settings.
alter table public.app_config add column if not exists services jsonb;
alter table public.app_config add column if not exists appt_reminder_min int[] not null default '{1440,120}';
alter table public.app_config add column if not exists appt_series_max_days int not null default 91;
alter table public.app_config add column if not exists appt_series_max_count int not null default 12;
-- Open bookings per rider (v1 had a fixed 5; series rides need room).
alter table public.app_config add column if not exists booking_max_open int not null default 12;
-- Where the calendar Edge Function lives (null = Google Calendar only).
alter table public.app_config add column if not exists calendar_function_url text;
alter table public.app_config drop constraint if exists app_config_appointment_check;
alter table public.app_config add constraint app_config_appointment_check check (
  siosia_valid_slots(appt_reminder_min) and appt_series_max_days between 30 and 365
  and appt_series_max_count between 2 and 12 and booking_max_open between 1 and 50);
-- Seeded once; the operator edits it with siosia_set_services (entries are disabled, never deleted).
update public.app_config set services = $json$[
  {"id": "ride", "kind": "ride", "name": {"en": "Ride", "pl": "Przejazd"},
   "description": {"en": "A car now or booked for later", "pl": "Samochód teraz albo na później"},
   "icon": "🚗", "duration": null, "price": null, "needsPlace": true, "enabled": true},
  {"id": "learning", "kind": "time", "name": {"en": "Learning", "pl": "Nauka"},
   "description": {"en": "Lessons and help with homework", "pl": "Lekcje i pomoc w nauce"},
   "icon": "📚", "duration": {"default": 60, "min": 30, "max": 240, "step": 30}, "price": null,
   "needsPlace": true, "enabled": true},
  {"id": "childcare", "kind": "time", "name": {"en": "Childcare", "pl": "Opieka nad dziećmi"},
   "description": {"en": "Someone with the kids", "pl": "Ktoś zostanie z dziećmi"},
   "icon": "🧸", "duration": {"default": 180, "min": 60, "max": 720, "step": 30}, "price": null,
   "needsPlace": true, "enabled": true}
]$json$::jsonb where id = 1 and services is null;
-- 2.8 (FR-304, V70): the YOLO events, appended once each by id (an operator's edits — enabled: false,
-- another name — are never overwritten; twin of src/core/yolo.ts).
update public.app_config c set services = c.services || coalesce((
  select jsonb_agg(y.e order by y.ord) from jsonb_array_elements($yolo$[{"id": "yolo_halloween", "kind": "time", "section": "yolo", "base": "childcare", "date": "10-31", "when": {"en": "31 Oct", "pl": "31 paź"}, "name": {"en": "Halloween", "pl": "Halloween"}, "description": {"en": "Costumes, pumpkins, trick-or-treat round the block", "pl": "Przebrania, dynie i cukierek albo psikus po sąsiedztwie"}, "icon": "🎃", "duration": {"default": 180, "min": 60, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_nicholas", "kind": "time", "section": "yolo", "base": "childcare", "date": "12-06", "when": {"en": "6 Dec", "pl": "6 gru"}, "name": {"en": "St Nicholas' Day", "pl": "Mikołajki"}, "description": {"en": "Gifts, a red hat and a visit from the saint", "pl": "Prezenty, czerwona czapka i wizyta Mikołaja"}, "icon": "🎁", "duration": {"default": 180, "min": 60, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_christmas", "kind": "time", "section": "yolo", "base": "childcare", "date": "12-24", "when": {"en": "24 Dec", "pl": "24 gru"}, "name": {"en": "Christmas", "pl": "Boże Narodzenie"}, "description": {"en": "Baking, decorating the tree, kids busy while you cook", "pl": "Pieczenie, ubieranie choinki, dzieci zajęte, gdy gotujesz"}, "icon": "🎄", "duration": {"default": 240, "min": 60, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_new_year", "kind": "time", "section": "yolo", "base": "childcare", "date": "12-31", "when": {"en": "31 Dec", "pl": "31 gru"}, "name": {"en": "New Year's Eve", "pl": "Sylwester"}, "description": {"en": "You celebrate, the kids watch the fireworks and sleep", "pl": "Ty świętujesz, dzieci oglądają fajerwerki i śpią"}, "icon": "🎆", "duration": {"default": 360, "min": 120, "max": 900, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_winter", "kind": "time", "section": "yolo", "base": "childcare", "date": "01-20", "when": {"en": "Jan–Feb", "pl": "sty–lut"}, "name": {"en": "Winter holidays", "pl": "Ferie zimowe"}, "description": {"en": "Sledging, snowmen and hot cocoa", "pl": "Sanki, bałwany i gorące kakao"}, "icon": "❄️", "duration": {"default": 480, "min": 120, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_date_night", "kind": "time", "section": "yolo", "base": "childcare", "date": "02-14", "when": {"en": "14 Feb", "pl": "14 lut"}, "name": {"en": "Date night", "pl": "Randka we dwoje"}, "description": {"en": "Valentine's or any evening just for the two of you", "pl": "Walentynki albo każdy wieczór tylko dla was"}, "icon": "💝", "duration": {"default": 240, "min": 60, "max": 600, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_carnival", "kind": "time", "section": "yolo", "base": "childcare", "date": "02-10", "when": {"en": "Feb", "pl": "luty"}, "name": {"en": "Carnival party", "pl": "Bal karnawałowy"}, "description": {"en": "Fancy dress, masks and doughnuts", "pl": "Przebrania, maski i pączki"}, "icon": "🎭", "duration": {"default": 180, "min": 60, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_easter", "kind": "time", "section": "yolo", "base": "childcare", "date": "04-01", "when": {"en": "Spring", "pl": "wiosna"}, "name": {"en": "Easter", "pl": "Wielkanoc"}, "description": {"en": "Painting eggs, the Easter basket, the egg hunt", "pl": "Malowanie pisanek, święconka i szukanie zajączka"}, "icon": "🥚", "duration": {"default": 180, "min": 60, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_childrens_day", "kind": "time", "section": "yolo", "base": "childcare", "date": "06-01", "when": {"en": "1 Jun", "pl": "1 cze"}, "name": {"en": "Children's Day", "pl": "Dzień Dziecka"}, "description": {"en": "Balloons, games and the kids' own day out", "pl": "Balony, zabawy i dzień tylko dla dzieci"}, "icon": "🎈", "duration": {"default": 180, "min": 60, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_summer", "kind": "time", "section": "yolo", "base": "childcare", "date": "07-01", "when": {"en": "Jul–Aug", "pl": "lip–sie"}, "name": {"en": "Summer holidays", "pl": "Wakacje"}, "description": {"en": "Lake, park and ice cream days while school is out", "pl": "Jezioro, park i lody, gdy szkoła ma przerwę"}, "icon": "🏖️", "duration": {"default": 480, "min": 120, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_back_to_school", "kind": "time", "section": "yolo", "base": "childcare", "date": "09-01", "when": {"en": "1 Sep", "pl": "1 wrz"}, "name": {"en": "Back to school", "pl": "Powrót do szkoły"}, "description": {"en": "School supplies, the first day and the first homework", "pl": "Wyprawka, pierwszy dzień i pierwsze lekcje"}, "icon": "🎒", "duration": {"default": 120, "min": 60, "max": 480, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_birthday", "kind": "time", "section": "yolo", "base": "childcare", "date": null, "when": {"en": "Any time", "pl": "kiedy chcesz"}, "name": {"en": "Birthday party", "pl": "Urodziny"}, "description": {"en": "Cake, candles and a room full of guests", "pl": "Tort, świeczki i pokój pełen gości"}, "icon": "🎂", "duration": {"default": 180, "min": 60, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_party", "kind": "time", "section": "yolo", "base": "childcare", "date": null, "when": {"en": "Any time", "pl": "kiedy chcesz"}, "name": {"en": "Kids' party", "pl": "Impreza dla dzieci"}, "description": {"en": "Music, dancing and games for a crowd of kids", "pl": "Muzyka, tańce i zabawy dla gromadki dzieci"}, "icon": "🎉", "duration": {"default": 180, "min": 60, "max": 720, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_sleepover", "kind": "time", "section": "yolo", "base": "childcare", "date": null, "when": {"en": "Any time", "pl": "kiedy chcesz"}, "name": {"en": "Sleepover", "pl": "Piżama party"}, "description": {"en": "Pyjamas, a film, stories and lights out", "pl": "Piżamy, film, bajki i gasimy światło"}, "icon": "🌙", "duration": {"default": 720, "min": 240, "max": 1440, "step": 30}, "price": null, "needsPlace": true, "enabled": true}, {"id": "yolo_wedding", "kind": "time", "section": "yolo", "base": "childcare", "date": null, "when": {"en": "Any time", "pl": "kiedy chcesz"}, "name": {"en": "Wedding & family do", "pl": "Wesele i rodzinna uroczystość"}, "description": {"en": "The grown-ups celebrate, the kids are looked after", "pl": "Dorośli świętują, dzieci są pod opieką"}, "icon": "💍", "duration": {"default": 480, "min": 120, "max": 900, "step": 30}, "price": null, "needsPlace": true, "enabled": true}]$yolo$::jsonb) with ordinality as y(e, ord)
   where not exists (select 1 from jsonb_array_elements(c.services) o where o ->> 'id' = y.e ->> 'id')), '[]'::jsonb)
 where c.id = 1 and c.services is not null;

-- Profiles: the services a person offers (catalog ids of kind "time"), their place, and a random
-- public id — the only reference to a person that reaches other users (catalog, requests).
alter table public.profiles add column if not exists offers text[] not null default '{}';
alter table public.profiles add column if not exists home jsonb;
alter table public.profiles add column if not exists public_id text;
alter table public.profiles alter column public_id
  set default translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/', '-_');
update public.profiles set public_id = translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/', '-_')
 where public_id is null;
create unique index if not exists profiles_public_id_idx on public.profiles (public_id);
-- A master profile presets what every phone using it offers (null = by role: none besides rides).
alter table public.master_profiles add column if not exists offers text[];

-- A repeating request (weekly / every 2 weeks): one row; its occurrences are appointments.
create table if not exists public.appointment_series (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null,
  provider_id    uuid not null,
  service_id     text not null,
  rule           text not null check (rule in ('weekly', 'biweekly')),
  first_start    timestamptz not null,
  duration_min   int not null check (duration_min between 15 and 1440),
  count          int not null check (count between 2 and 12),
  until          timestamptz not null,
  place_lat      double precision check (place_lat between -90 and 90),
  place_lng      double precision check (place_lng between -180 and 180),
  place_label    text check (char_length(place_label) <= 120),
  note           text not null default '' check (char_length(note) <= 200),
  price          numeric(10,2),
  currency       text not null,
  status         text not null default 'requested' check (status in ('requested', 'answered', 'cancelled', 'expired')),
  -- Rides that repeat with the series: [{passenger, leg, pickup, dropoff, offsetMin, estKm, estMin, fareIsEstimate}]
  ride_templates jsonb not null default '[]',
  templates_at   timestamptz,
  requested_at   timestamptz not null default now(),
  answered_at    timestamptz
);
-- The templates are always a list (every reader takes its elements; siosia_set_ride_template and
-- siosia_drop_ride_template write it), whatever is written behind the functions.
alter table public.appointment_series drop constraint if exists appointment_series_ride_templates_check;
alter table public.appointment_series add constraint appointment_series_ride_templates_check
  check (jsonb_typeof(ride_templates) = 'array');
create index if not exists appointment_series_client_idx on public.appointment_series (client_id, status);
create index if not exists appointment_series_provider_idx on public.appointment_series (provider_id, status);

-- An appointment keeps both parties, the entry, the time, the place and a note — nothing else about
-- location (FR-105). "In progress" is derived (accepted, start ≤ now < end).
create table if not exists public.appointments (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null,
  provider_id   uuid not null,
  service_id    text not null,
  status        text not null default 'requested'
                  check (status in ('requested', 'accepted', 'declined', 'cancelled', 'expired', 'done')),
  starts_at     timestamptz not null,
  duration_min  int not null check (duration_min between 15 and 1440),
  place_lat     double precision check (place_lat between -90 and 90),
  place_lng     double precision check (place_lng between -180 and 180),
  place_label   text check (char_length(place_label) <= 120),
  note          text not null default '' check (char_length(note) <= 200),
  price         numeric(10,2),
  currency      text not null,
  requested_at  timestamptz not null default now(),
  answered_at   timestamptz,
  ended_at      timestamptz,
  cancelled_by  text check (cancelled_by in ('client', 'provider', 'system')),
  cancel_reason text,
  reminded      int[] not null default '{}',
  series_id     uuid references public.appointment_series (id) on delete cascade,
  seq           int
);
create index if not exists appointments_provider_idx on public.appointments (provider_id, status);
create index if not exists appointments_client_idx on public.appointments (client_id, status);
create index if not exists appointments_open_idx on public.appointments (starts_at) where status in ('requested', 'accepted');
create index if not exists appointments_series_idx on public.appointments (series_id, seq);
-- 2.1 (FR-160): an open request has no provider until a member takes it (siosia_take_request).
alter table public.appointment_series alter column provider_id drop not null;
alter table public.appointments alter column provider_id drop not null;
create index if not exists appointments_open_requests_idx on public.appointments (starts_at)
  where provider_id is null and status = 'requested';

-- A ride may belong to an appointment (leg there / back); at most one live ride per passenger and leg.
alter table public.rides add column if not exists appointment_id uuid references public.appointments (id) on delete set null;
alter table public.rides add column if not exists leg text;
alter table public.rides drop constraint if exists rides_leg_check;
alter table public.rides add constraint rides_leg_check check (leg is null or leg in ('there', 'back'));
alter table public.rides add column if not exists auto_booked boolean not null default false;
-- 2.2: when the driver's car first moved towards a booked pickup (FR-180).
alter table public.rides add column if not exists departed_at timestamptz;
create unique index if not exists rides_appointment_leg on public.rides (appointment_id, rider_id, leg)
  where appointment_id is not null and status not in ('cancelled', 'expired');
create index if not exists rides_appointment_idx on public.rides (appointment_id) where appointment_id is not null;

-- Ratings: of a ride or of an appointment (exactly one), one per direction.
alter table public.ratings add column if not exists appointment_id uuid references public.appointments (id) on delete cascade;
alter table public.ratings drop constraint if exists ratings_pkey;
alter table public.ratings alter column ride_id drop not null;
alter table public.ratings drop constraint if exists ratings_one_target;
alter table public.ratings add constraint ratings_one_target check ((ride_id is null) <> (appointment_id is null));
create unique index if not exists ratings_ride_from_idx on public.ratings (ride_id, from_user) where ride_id is not null;
create unique index if not exists ratings_appointment_from_idx on public.ratings (appointment_id, from_user) where appointment_id is not null;

-- Notifications about an appointment carry its id (tag source).
alter table public.push_outbox add column if not exists appointment_id uuid;

-- 2.1 (FR-170): the car's paint (#rrggbb, lowercase) the car icon is drawn in; null = not chosen.
alter table public.vehicles add column if not exists paint text;
alter table public.vehicles drop constraint if exists vehicles_paint_check;
alter table public.vehicles add constraint vehicles_paint_check check (paint is null or paint ~ '^#[0-9a-f]{6}$');

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.3 (Amendment 2.3): kids, kid ratings, photos, chat. Appended; every statement idempotent.
-- ---------------------------------------------------------------------------------------------

-- A kid's profile (FR-200): the owner's row only; at most 8 per member (siosia_add_kid). The photo
-- is the object's PATH in the bucket 'photos', never a URL (FR-212); the viewer's signed URL is
-- made by the app from it. The year of birth is checked against this year in siosia_valid_kid.
create table if not exists public.kids (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 30),
  photo_path text,
  born_year  int check (born_year is null or born_year between 1900 and 2100),
  note       text not null default '' check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists kids_owner_idx on public.kids (owner_id, created_at);

-- The client's kids attached to an appointment (FR-201); they go with the appointment or the kid.
create table if not exists public.appointment_kids (
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  kid_id         uuid not null references public.kids (id) on delete cascade,
  primary key (appointment_id, kid_id)
);
create index if not exists appointment_kids_kid_idx on public.appointment_kids (kid_id);

-- The provider's rating of an attached kid, once per appointment and kid (FR-203). A table of its
-- own: it never touches the owner's rating in ratings (FR-060).
create table if not exists public.kid_ratings (
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  kid_id         uuid not null references public.kids (id) on delete cascade,
  from_user      uuid not null,
  stars          int  not null check (stars between 1 and 5),
  comment        text not null default '' check (char_length(comment) <= 140),
  created_at     timestamptz not null default now(),
  primary key (appointment_id, kid_id)
);
create index if not exists kid_ratings_kid_idx on public.kid_ratings (kid_id, created_at desc);

-- Chat (FR-220): one room per ride with a driver ('ride:<id>') or accepted appointment
-- ('appt:<id>'). The messages go with their ride / appointment (FR-223, 12-month retention).
create table if not exists public.messages (
  id             uuid primary key default gen_random_uuid(),
  room           text not null,
  ride_id        uuid references public.rides (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete cascade,
  sender         uuid not null,
  text           text not null check (char_length(text) between 1 and 500),
  sent_at        timestamptz not null default now(),
  read_at        timestamptz,
  check ((ride_id is null) <> (appointment_id is null)),
  -- the room names the row it hangs on
  check (room = case when ride_id is not null then 'ride:' || ride_id::text else 'appt:' || appointment_id::text end)
);
create index if not exists messages_room_idx on public.messages (room, sent_at);
create index if not exists messages_unread_idx on public.messages (room, sender) where read_at is null;

-- Chat presence (FR-222, V48, V49): when a party last had a room's thread open and visible. The
-- app marks it on every siosia_chat(room, true) — on opening and every 20 s while visible — and a
-- message is not pushed to someone seen in that room within the last 45 s (siosia_send_message).
create table if not exists public.chat_presence (
  user_id uuid not null references auth.users (id) on delete cascade,
  room    text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, room)
);

-- The profile photo's object path (FR-210); null = none.
alter table public.profiles add column if not exists photo_path text;
-- Photo ownership is ROW-based (V49): the row that holds a path owns it. These make the lookups cheap.
create index if not exists profiles_photo_path_idx on public.profiles (photo_path) where photo_path is not null;
create index if not exists kids_photo_path_idx on public.kids (photo_path) where photo_path is not null;

-- 2.5 (FR-230, FR-234, FR-235): session updates — what the person with the kids tells the parent,
-- and the parent's notes — each about everyone or one kid, with a photo or not. They go with the
-- appointment; a kid removed later leaves its name here (kid_name), not its row.
create table if not exists public.appointment_updates (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  author         uuid not null,
  kid_id         uuid references public.kids (id) on delete set null,
  kid_name       text check (kid_name is null or char_length(kid_name) between 1 and 30),
  text           text not null default '' check (char_length(text) <= 500),
  photo_path     text,
  created_at     timestamptz not null default now(),
  check (text <> '' or photo_path is not null)
);
create index if not exists appointment_updates_appt_idx on public.appointment_updates (appointment_id, created_at);
create index if not exists appointment_updates_author_idx on public.appointment_updates (author, created_at desc);
create index if not exists appointment_updates_photo_path_idx on public.appointment_updates (photo_path) where photo_path is not null;
-- 2.5 (FR-240–242): the client's heading-home notice — when they said so and when they expect to be there.
alter table public.appointments add column if not exists coming_at timestamptz;
alter table public.appointments add column if not exists eta_at timestamptz;

-- 2.6 (FR-250–252): a family — the people who share kids and see each other's appointments. A
-- member is in at most one (user_id is the key); at most 6 (siosia_family_answer).
create table if not exists public.families (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create table if not exists public.family_members (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  family_id uuid not null references public.families (id) on delete cascade,
  joined_at timestamptz not null default now()
);
create index if not exists family_members_family_idx on public.family_members (family_id, joined_at);
-- An invitation into a family (FR-250): pending for 7 days. Kept after the family went (history),
-- hence no foreign key to families.
create table if not exists public.family_invites (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null,
  from_user   uuid not null,
  to_user     uuid not null,
  status      text not null default 'pending' check (status in ('pending', 'joined', 'declined', 'withdrawn', 'expired')),
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists family_invites_to_idx on public.family_invites (to_user) where status = 'pending';
create index if not exists family_invites_family_idx on public.family_invites (family_id) where status = 'pending';
-- 2.6 (FR-260–263): rates per hour agreed between a family and a provider: [{serviceId, perHour}].
-- At most one active and one waiting per pair; an ended one stays readable (no foreign key to the
-- family, which may go when everyone left).
create table if not exists public.contracts (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null,
  provider_id   uuid not null,
  version       int  not null default 1,
  status        text not null default 'proposed'
                check (status in ('proposed', 'active', 'declined', 'withdrawn', 'ended', 'replaced')),
  rates         jsonb not null,
  note          text not null default '' check (char_length(note) <= 200),
  currency      text not null,
  proposed_by   uuid not null,
  proposed_side text not null check (proposed_side in ('family', 'provider')),
  created_at    timestamptz not null default now(),
  answered_at   timestamptz,
  ended_at      timestamptz,
  ended_by      uuid
);
create unique index if not exists contracts_active_uq on public.contracts (family_id, provider_id) where status = 'active';
create unique index if not exists contracts_proposed_uq on public.contracts (family_id, provider_id) where status = 'proposed';
create index if not exists contracts_provider_idx on public.contracts (provider_id);
-- 2.6 (FR-262, FR-270–272): the rate per hour the price came from (contract or price list), the
-- contract, the provider's correction of the time, and whether the summary went out.
alter table public.appointments add column if not exists rate numeric(10, 2);
alter table public.appointments add column if not exists contract_id uuid;
alter table public.appointments add column if not exists actual_min int;
alter table public.appointments drop constraint if exists appointments_actual_min_check;
alter table public.appointments add constraint appointments_actual_min_check
  check (actual_min is null or (actual_min between 15 and 1440 and actual_min % 15 = 0));
alter table public.appointments add column if not exists summary_sent boolean not null default false;
-- 2.8 (FR-301, V69): personal invite links into Siosia (the token's SHA-256 only), 14 days, once.
create table if not exists public.member_invites (
  token_hash  text primary key,
  from_user   uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_by     uuid,
  used_at     timestamptz,
  family_sent boolean not null default false
);
create index if not exists member_invites_from_idx on public.member_invites (from_user);
create index if not exists member_invites_used_idx on public.member_invites (used_by) where used_by is not null;
-- 2.6 (FR-282, V65): the Monday whose weekly_report notifications went out.
alter table public.app_config add column if not exists report_week date;

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
alter table public.push_subscriptions enable row level security;
alter table public.push_outbox enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_series enable row level security;
alter table public.kids enable row level security;
alter table public.appointment_kids enable row level security;
alter table public.kid_ratings enable row level security;
alter table public.messages enable row level security;
alter table public.chat_presence enable row level security;
alter table public.appointment_updates enable row level security;
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.family_invites enable row level security;
alter table public.contracts enable row level security;
alter table public.member_invites enable row level security;

-- Explicit grants, so the script also works on projects created with "automatically expose new
-- tables" turned off (recommended).
grant usage on schema public to anon, authenticated;

revoke all on public.app_config, public.app_secrets, public.profiles, public.vehicles, public.driver_status,
              public.memberships, public.invite_failures, public.rides, public.offers, public.ratings,
              public.master_profiles, public.account_transfers, public.push_subscriptions, public.push_outbox,
              public.appointments, public.appointment_series,
              public.kids, public.appointment_kids, public.kid_ratings, public.messages, public.chat_presence,
              public.appointment_updates,
              public.families, public.family_members, public.family_invites, public.contracts,
              public.member_invites
  from anon, authenticated;
-- The sender (Edge Function, service role) reads the queue and the subscriptions.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, update, delete on public.push_outbox, public.push_subscriptions to service_role;
    grant select, update on public.app_secrets to service_role;
    grant select on public.app_config to service_role;
  end if;
end $$;
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
drop policy if exists siosia_appointment_read on public.appointments;
drop policy if exists siosia_series_read on public.appointment_series;
drop policy if exists siosia_kids_read on public.kids;
drop policy if exists siosia_appointment_kids_read on public.appointment_kids;
drop policy if exists siosia_kid_ratings_read on public.kid_ratings;
drop policy if exists siosia_messages_read on public.messages;
drop policy if exists siosia_updates_read on public.appointment_updates;
drop policy if exists siosia_family_members_read on public.family_members;
drop policy if exists siosia_contracts_read on public.contracts;

create policy siosia_config_read  on public.app_config    for select to authenticated using (true);
create policy siosia_profile_read on public.profiles      for select to authenticated using (user_id = auth.uid());
create policy siosia_vehicle_read on public.vehicles      for select to authenticated using (user_id = auth.uid());
create policy siosia_status_read  on public.driver_status for select to authenticated using (user_id = auth.uid());
create policy siosia_member_read  on public.memberships   for select to authenticated using (user_id = auth.uid());
create policy siosia_ride_read    on public.rides         for select to authenticated using (rider_id = auth.uid() or driver_id = auth.uid());
create policy siosia_offer_read   on public.offers        for select to authenticated using (driver_id = auth.uid());
create policy siosia_rating_read  on public.ratings       for select to authenticated using (from_user = auth.uid() or to_user = auth.uid());
create policy siosia_appointment_read on public.appointments for select to authenticated using (client_id = auth.uid() or provider_id = auth.uid());
create policy siosia_series_read on public.appointment_series for select to authenticated using (client_id = auth.uid() or provider_id = auth.uid());
-- 2.3: the owner's kids; attachments and messages for the two parties; a kid's ratings for its
-- owner and the rater.
create policy siosia_kids_read on public.kids for select to authenticated using (owner_id = auth.uid());
create policy siosia_appointment_kids_read on public.appointment_kids for select to authenticated
  using (exists (select 1 from public.appointments a where a.id = appointment_id and (a.client_id = auth.uid() or a.provider_id = auth.uid())));
create policy siosia_kid_ratings_read on public.kid_ratings for select to authenticated
  using (from_user = auth.uid() or exists (select 1 from public.kids k where k.id = kid_id and k.owner_id = auth.uid()));
create policy siosia_messages_read on public.messages for select to authenticated
  using (sender = auth.uid()
         or exists (select 1 from public.rides r where r.id = ride_id and (r.rider_id = auth.uid() or r.driver_id = auth.uid()))
         or exists (select 1 from public.appointments a where a.id = appointment_id and (a.client_id = auth.uid() or a.provider_id = auth.uid())));
-- 2.5 (FR-234): a session feed for the two parties of its appointment.
create policy siosia_updates_read on public.appointment_updates for select to authenticated
  using (exists (select 1 from public.appointments a where a.id = appointment_id and (a.client_id = auth.uid() or a.provider_id = auth.uid())));
-- 2.6: my own family row; the contracts I hold as a provider. Everything else through the functions.
create policy siosia_family_members_read on public.family_members for select to authenticated using (user_id = auth.uid());
create policy siosia_contracts_read on public.contracts for select to authenticated using (provider_id = auth.uid());

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

-- A person as others see them: nickname, rating, icon and (2.1, V38) the paint of their car —
-- null without one — so a car icon is drawn in it everywhere. Nothing else of the vehicle.
create or replace function public.siosia_party(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'nickname', coalesce((select nickname from profiles where user_id = p_user), 'Deleted user'),
    'rating',   siosia_rating(p_user),
    'icon',     (siosia_master_of(p_user)).icon,
    'paint',    (select v.paint from vehicles v where v.user_id = p_user));
$$;

create or replace function public.siosia_vehicle_json(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('make', make, 'model', model, 'colour', colour, 'plate', plate, 'seats', seats, 'paint', paint)
  from vehicles where user_id = p_user;
$$;

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.0 helpers: catalog lookups, people as others see them, attached rides, calendar links
-- (SQL functions referenced by the views below, so defined first)
-- ---------------------------------------------------------------------------------------------

-- One catalog entry by id (enabled or not), or null.
create or replace function public.siosia_service(p_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select e from app_config c, jsonb_array_elements(coalesce(c.services, '[]'::jsonb)) e
   where c.id = 1 and e ->> 'id' = p_id limit 1;
$$;

-- A catalog entry's name in a language (English, then the id, as fallbacks).
create or replace function public.siosia_service_name(p_id text, p_lang text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(e -> 'name' ->> p_lang, e -> 'name' ->> 'en')
                     from app_config c, jsonb_array_elements(coalesce(c.services, '[]'::jsonb)) e
                    where c.id = 1 and e ->> 'id' = p_id limit 1), p_id);
$$;

-- A person as other users see them in 2.0: nickname, rating, icon, paint (2.1) and the random
-- public id — never the auth user id (FR-143). Nobody (an open request's provider, 2.1) is null.
create or replace function public.siosia_public_party(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when p_user is null then null else siosia_party(p_user)
         || jsonb_build_object('publicId', (select public_id from profiles where user_id = p_user and not deleted)) end;
$$;

-- The catalog entries a person offers: a master profile's preset (null = none besides rides,
-- which come with a vehicle), otherwise the person's own toggles.
create or replace function public.siosia_offers_of(p_user uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select case when p.master_id is not null then coalesce(m.offers, '{}'::text[]) else coalesce(p.offers, '{}'::text[]) end
    from profiles p left join master_profiles m on m.id = p.master_id
   where p.user_id = p_user and not p.deleted;
$$;

-- 2.8 (V70): a person offers an entry when they offer it or the entry it takes after (its base:
-- whoever offers Childcare offers the YOLO events). Twin of Engine.offersService.
create or replace function public.siosia_offers_service(p_user uuid, p_service text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_service = any (siosia_offers_of(p_user))
                  or (siosia_service(p_service) ->> 'base') = any (siosia_offers_of(p_user)), false);
$$;

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.3 helpers: kids and their ratings, photos as a viewer may see them, chat counts
-- (SQL functions referenced by the views below, so defined first)
-- ---------------------------------------------------------------------------------------------

-- This year (UTC, as the engine counts it): a kid's age, and the year-of-birth check.
-- 2.7 (V66): a test account (any membership made with the test invite code), and whether two
-- accounts are in the same realm — both real or both test — and so may find and reach each other.
create or replace function public.siosia_sandbox(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where user_id = p_user and sandbox);
$$;

create or replace function public.siosia_same_realm(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select siosia_sandbox(p_a) = siosia_sandbox(p_b);
$$;

-- 2.6 (FR-250): a person's family (null without one), everyone in it (just the person without one,
-- first joined first), whether two people share one, and who sees an appointment (FR-254).
create or replace function public.siosia_family_of(p_user uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select family_id from family_members where user_id = p_user;
$$;

create or replace function public.siosia_household(p_user uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce((select array_agg(m.user_id order by m.joined_at, m.user_id) from family_members m
                    where m.family_id = (select f.family_id from family_members f where f.user_id = p_user)),
                  array[p_user]);
$$;

create or replace function public.siosia_same_family(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_a <> p_b and exists (select 1 from family_members x join family_members y on y.family_id = x.family_id
                                          where x.user_id = p_a and y.user_id = p_b), false);
$$;

create or replace function public.siosia_sees(p_user uuid, a public.appointments)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(a.client_id = p_user or a.provider_id = p_user
                  or siosia_same_family(p_user, a.client_id) or siosia_same_family(p_user, a.provider_id), false);
$$;

-- 2.6 (FR-270): what a done appointment cost — rate × the time counted (the provider's correction,
-- else the booked duration), or its fixed price; null before it is done.
create or replace function public.siosia_cost_json(a public.appointments)
returns jsonb language sql immutable as $$
  select case when a.status <> 'done' then null else jsonb_build_object(
    'minutes', coalesce(a.actual_min, a.duration_min),
    'rate', a.rate,
    'total', case when a.rate is not null then round(a.rate * coalesce(a.actual_min, a.duration_min) / 60.0, 2) else a.price end,
    'currency', a.currency,
    'source', case when a.contract_id is not null then 'contract' when a.rate is not null then 'catalog'
                   when a.price is not null then 'fixed' else 'none' end,
    'corrected', a.actual_min is not null) end;
$$;

create or replace function public.siosia_year()
returns int language sql stable as $$
  select extract(year from now() at time zone 'UTC')::int;
$$;

-- A kid's rating summary (FR-203): the mean of every rating it got (one decimal), null without any.
create or replace function public.siosia_kid_rating(p_kid uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'mean',  case when count(*) = 0 then null else round(avg(stars)::numeric, 1) end,
    'count', count(*)::int)
  from kid_ratings where kid_id = p_kid;
$$;

-- A photo's path, only for a viewer allowed to see it (FR-212): the app turns it into a signed
-- URL (photo); the path itself never reaches a screen. Nothing otherwise.
create or replace function public.siosia_photo_path_json(p_path text, p_allowed boolean)
returns jsonb language sql immutable as $$
  select case when p_path is not null and coalesce(p_allowed, false) then jsonb_build_object('photoPath', p_path)
              else '{}'::jsonb end;
$$;

-- A kid as its owner sees it (Kid, S2 → My kids): every rating it got, with who gave it, newest first.
create or replace function public.siosia_kid_json(k public.kids)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', k.id, 'name', k.name, 'photo', null, 'bornYear', k.born_year, 'note', k.note,
    'rating', siosia_kid_rating(k.id),
    'ratings', coalesce((select jsonb_agg(jsonb_build_object(
                 'appointmentId', g.appointment_id,
                 'by', coalesce((select nickname from profiles where user_id = g.from_user), 'Deleted user'),
                 'stars', g.stars, 'comment', g.comment, 'at', siosia_ms(g.created_at)) order by g.created_at desc)
               from kid_ratings g where g.kid_id = k.id), '[]'::jsonb))
    || siosia_photo_path_json(k.photo_path, true);
$$;

-- The kids attached to an appointment as its two parties see them (AttachedKid, FR-202): name,
-- photo, age, note, the summary, and the viewer's own rating for this appointment. Never the owner's id.
create or replace function public.siosia_attached_kids_json(p_appt uuid, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', k.id, 'name', k.name, 'photo', null,
             'age', case when k.born_year is null then null else siosia_year() - k.born_year end,
             'note', k.note, 'rating', siosia_kid_rating(k.id),
             'myRating', (select g.stars from kid_ratings g
                           where g.appointment_id = p_appt and g.kid_id = k.id and g.from_user = p_viewer))
           || siosia_photo_path_json(k.photo_path, true)
           order by k.created_at, k.id), '[]'::jsonb)
    from appointment_kids ak join kids k on k.id = ak.kid_id where ak.appointment_id = p_appt;
$$;

-- 2.6 (FR-253): a kid as its owner's family sees it — who added it, and whether that is the viewer.
create or replace function public.siosia_kid_json(k public.kids, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select siosia_kid_json(k) || jsonb_build_object(
    'ownerNickname', coalesce((select p.nickname from profiles p where p.user_id = k.owner_id), 'Deleted user'),
    'mine', k.owner_id = p_viewer);
$$;

-- The attached kids' names, for the provider's notifications ("with Zosia and Kuba").
create or replace function public.siosia_kid_names(p_appt uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(k.name order by k.created_at, k.id), '[]'::jsonb)
    from appointment_kids ak join kids k on k.id = ak.kid_id where ak.appointment_id = p_appt;
$$;

-- The caller's family's kids (2.6, FR-253), each once; null when the list names anyone else's or an
-- unknown one (bad_input).
create or replace function public.siosia_own_kids(p_uid uuid, p_kids uuid[])
returns uuid[] language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from unnest(coalesce(p_kids, '{}'::uuid[])) x
                            where x is null or not exists (select 1 from kids k where k.id = x and k.owner_id = any (siosia_household(p_uid)))) then null
              else coalesce((select array_agg(distinct x) from unnest(coalesce(p_kids, '{}'::uuid[])) x), '{}'::uuid[]) end;
$$;

-- A person as a viewer may see them: siosia_party plus their photo's path when the viewer is
-- allowed to see it (FR-212) — the other party of their ride or appointment, a chat partner.
create or replace function public.siosia_party_for(p_user uuid, p_allowed boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select siosia_party(p_user)
         || siosia_photo_path_json((select p.photo_path from profiles p where p.user_id = p_user and not p.deleted), p_allowed);
$$;

-- siosia_public_party for a viewer: their photo's path when the viewer is allowed to see it (FR-212).
create or replace function public.siosia_public_party(p_user uuid, p_allowed boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when p_user is null then null else siosia_public_party(p_user)
         || siosia_photo_path_json((select p.photo_path from profiles p where p.user_id = p_user and not p.deleted), p_allowed) end;
$$;

-- Chat (FR-224): the other party's messages in a room the viewer has not read yet.
create or replace function public.siosia_unread(p_room text, p_viewer uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from messages m where m.room = p_room and m.sender <> p_viewer and m.read_at is null;
$$;

-- Unread messages across every room the user is a party to (MyState.unreadChats, the S1 badge).
create or replace function public.siosia_unread_total(p_user uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from messages m
    left join rides r on r.id = m.ride_id
    left join appointments a on a.id = m.appointment_id
   where m.read_at is null and m.sender <> p_user
     and ((r.id is not null and r.driver_id is not null and (r.rider_id = p_user or r.driver_id = p_user))
          or (a.id is not null and (a.client_id = p_user or a.provider_id = p_user)));
$$;

-- ChatMessage as one party sees it (FR-224: readAt tells a sender their message was read).
create or replace function public.siosia_message_json(m public.messages, p_viewer uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', m.id, 'room', m.room, 'mine', m.sender = p_viewer, 'text', m.text,
                            'sentAt', siosia_ms(m.sent_at), 'readAt', siosia_ms(m.read_at));
$$;

-- `weeks` weeks after `t`, keeping the wall-clock time in the deployment's time zone (DST-safe).
create or replace function public.siosia_add_weeks(t timestamptz, weeks int, tz text)
returns timestamptz language sql immutable as $$
  select ((t at time zone tz) + make_interval(days => 7 * weeks)) at time zone tz;
$$;

-- How an attached ride stands for its appointment (§7 rule 7); null = not shown (removed by its
-- passenger, or cancelled together with the appointment).
create or replace function public.siosia_ride_summary(p_status text, p_driver uuid, p_by text, p_reason text)
returns text language sql immutable as $$
  select case
    when p_status = 'cancelled' and (p_by = 'rider' or p_reason = 'appointment_cancelled') then null
    when p_status = 'scheduled' and p_driver is null then 'pending'
    when p_status = 'requested' then 'pending'
    when p_status in ('scheduled', 'accepted', 'arrived', 'in_progress') then 'confirmed'
    when p_status = 'completed' then 'done'
    else 'failed' end;
$$;

-- Calendar links (NFR-20): the record id plus an HMAC bound to the viewer's public id, keyed with
-- the deployment's push_secret. Only the two parties get the link, inside the app.
create or replace function public.siosia_ics_token(p_id uuid, p_public text)
returns text language sql stable security definer set search_path = public, extensions as $$
  select left(encode(hmac(p_id::text || ':' || coalesce(p_public, ''), s.push_secret, 'sha256'), 'hex'), 32)
    from app_secrets s where s.id = 1;
$$;

-- The viewer's .ics link of an appointment ('a'), series ('s') or ride ('r'); null until the
-- calendar function is deployed (app_config.calendar_function_url).
create or replace function public.siosia_ics_link(p_kind text, p_id uuid, p_viewer uuid)
returns text language sql stable security definer set search_path = public, extensions as $$
  select case when c.calendar_function_url is null or p.public_id is null then null
              else c.calendar_function_url || '?' || p_kind || '=' || p_id::text || '&u=' || p.public_id
                   || '&t=' || siosia_ics_token(p_id, p.public_id) end
    from app_config c left join profiles p on p.user_id = p_viewer and not p.deleted
   where c.id = 1;
$$;

-- The rides attached to an appointment as the viewer may see them (FR-114): the latest per
-- passenger and leg. The other party sees leg, time, status and the driver only — never places.
create or replace function public.siosia_attached_json(p_appt uuid, p_viewer uuid, p_client uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'rideId', x.id, 'leg', x.leg,
             'passenger', case when x.rider_id = p_client then 'client' else 'provider' end,
             'mine', x.rider_id = p_viewer,
             'scheduledFor', siosia_ms(x.scheduled_for),
             'status', siosia_ride_summary(x.status, x.driver_id, x.cancelled_by, x.cancel_reason),
             'driver', case when x.driver_id is null then null else jsonb_build_object(
                         'nickname', coalesce((select nickname from profiles where user_id = x.driver_id), 'Deleted user'),
                         'icon', (siosia_master_of(x.driver_id)).icon) end)
           || case when x.rider_id = p_viewer then jsonb_build_object(
                'pickup',  jsonb_build_object('lat', x.pickup_lat,  'lng', x.pickup_lng,  'label', x.pickup_label),
                'dropoff', jsonb_build_object('lat', x.dropoff_lat, 'lng', x.dropoff_lng, 'label', x.dropoff_label),
                'fare', x.fare, 'currency', x.currency) else '{}'::jsonb end
           order by x.scheduled_for), '[]'::jsonb)
    from (select distinct on (r.rider_id, r.leg) r.* from rides r
           where r.appointment_id = p_appt
             and siosia_ride_summary(r.status, r.driver_id, r.cancelled_by, r.cancel_reason) is not null
           order by r.rider_id, r.leg, r.requested_at desc) x;
$$;

-- A series as one occurrence's viewer sees it: rule, counts, the dates left out (declined or
-- cancelled — calendar EXDATEs), every start, and the ride templates (places only to their owner).
-- A candidate (2.1: a member who could take the open series) gets neither templates nor a link.
create or replace function public.siosia_series_json(p_series uuid, p_seq int, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'rule', s.rule, 'seq', p_seq, 'count', s.count, 'until', siosia_ms(s.until), 'status', s.status,
    'remaining', (select count(*) from appointments a
                   where a.series_id = s.id and a.status in ('requested', 'accepted') and a.starts_at > now()),
    'declined', coalesce((select jsonb_agg(siosia_ms(a.starts_at) order by a.starts_at) from appointments a
                           where a.series_id = s.id and a.status = 'declined'), '[]'::jsonb),
    'gaps', coalesce((select jsonb_agg(siosia_ms(a.starts_at) order by a.starts_at) from appointments a
                       where a.series_id = s.id and a.status in ('declined', 'cancelled')), '[]'::jsonb),
    'starts', coalesce((select jsonb_agg(siosia_ms(a.starts_at) order by a.seq) from appointments a
                         where a.series_id = s.id), '[]'::jsonb),
    'rideTemplates', coalesce((select jsonb_agg(
        case when t ->> 'passenger' = case when s.client_id = p_viewer then 'client' else 'provider' end
             then t || jsonb_build_object('mine', true)
             else jsonb_build_object('passenger', t ->> 'passenger', 'leg', t ->> 'leg', 'offsetMin', t -> 'offsetMin',
                                     'mine', false) end)
        -- only a list is read as one (as in siosia_materialize_templates): a non-list is no templates
        from jsonb_array_elements(case when v.party and jsonb_typeof(s.ride_templates) = 'array'
                                       then s.ride_templates else '[]'::jsonb end) t), '[]'::jsonb),
    'ics', case when v.party then siosia_ics_link('s', s.id, p_viewer) end)
  from appointment_series s
  cross join lateral (select coalesce(p_viewer = s.client_id or p_viewer = s.provider_id, false) as party) v
  where s.id = p_series;
$$;

-- AppointmentView (§12) for one of its two parties, or (2.1, V34) for a candidate — a member who
-- could take the open request: what is asked, when, where and by whom, never rides, reminders,
-- ratings, calendar links or anyone's user id. An open request has no provider (null).
-- 2.6 (FR-254): role 'family' — a member of the family of one of the parties: what that member sees
-- (kids, ride lines as a non-passenger, the feed, the notice, the cost), no actions, no calendar link.
-- 2.5 (FR-230, V54): the session feed takes posts from 30 min before the start until 7 days after
-- the end, on an accepted or done appointment.
create or replace function public.siosia_feed_open(a public.appointments)
returns boolean language sql stable as $$
  select a.status in ('accepted', 'done')
     and now() >= a.starts_at - interval '30 minutes'
     and now() <= coalesce(a.ended_at, a.starts_at + make_interval(mins => a.duration_min)) + interval '7 days';
$$;

create or replace function public.siosia_appointment_json(a public.appointments, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', a.id, 'status', a.status,
    'role', v.role,
    'open', a.provider_id is null and a.status = 'requested',
    'serviceId', a.service_id,
    'service', (select case when e is null then null else jsonb_build_object('name', e -> 'name', 'icon', e ->> 'icon') end
                  from (select siosia_service(a.service_id) e) q),
    'startsAt', siosia_ms(a.starts_at), 'durationMin', a.duration_min,
    'endsAt', siosia_ms(a.starts_at + make_interval(mins => a.duration_min)),
    'place', case when a.place_lat is null then null
                  else jsonb_build_object('lat', a.place_lat, 'lng', a.place_lng, 'label', a.place_label) end,
    'note', a.note, 'price', a.price, 'currency', a.currency,
    -- 2.3 (FR-212): the two parties see each other's photo; a candidate is no party yet.
    'client', siosia_public_party(a.client_id, v.sees), 'provider', siosia_public_party(a.provider_id, v.sees),
    'requestedAt', siosia_ms(a.requested_at), 'answeredAt', siosia_ms(a.answered_at), 'endedAt', siosia_ms(a.ended_at),
    'cancelledBy', a.cancelled_by, 'cancelReason', a.cancel_reason,
    'rides', case when v.sees then siosia_attached_json(a.id, p_viewer, a.client_id) else '[]'::jsonb end,
    'reminders', case when v.sees then to_jsonb(a.reminded) else '[]'::jsonb end,
    'myRating', case when v.party then (select g.stars from ratings g where g.appointment_id = a.id and g.from_user = p_viewer) end,
    'series', case when a.series_id is null then null else siosia_series_json(a.series_id, a.seq, p_viewer) end,
    'calendar', jsonb_build_object('google', null, 'ics', case when v.party then siosia_ics_link('a', a.id, p_viewer) end),
    -- 2.3 (FR-202): the kids' cards for the two parties; a candidate sees how many ("2 kids").
    'kids', case when v.sees then siosia_attached_kids_json(a.id, p_viewer) else '[]'::jsonb end,
    'kidCount', (select count(*)::int from appointment_kids ak where ak.appointment_id = a.id),
    -- 2.3 (FR-221): unread messages in this appointment's room.
    'unread', case when v.party then siosia_unread('appt:' || a.id::text, p_viewer) else 0 end,
    -- 2.5 (FR-230–234, FR-241): the session feed's size and state and the heading-home notice —
    -- the two parties only; a candidate learns nothing of them (V54).
    'updateCount', case when v.sees then (select count(*)::int from appointment_updates u where u.appointment_id = a.id) else 0 end,
    'feedOpen', v.sees and siosia_feed_open(a),
    'coming', case when v.sees and a.coming_at is not null and a.status in ('accepted', 'done')
                    and now() <= a.starts_at + make_interval(mins => a.duration_min) + interval '2 hours'
                   then jsonb_build_object('at', siosia_ms(a.coming_at), 'etaAt', siosia_ms(a.eta_at)) end,
    -- 2.6 (FR-262, FR-270–272): where the price came from and, once done, what it cost.
    'rate', a.rate,
    'contractId', case when v.sees then a.contract_id end,
    'actualMin', a.actual_min,
    'cost', case when v.sees then siosia_cost_json(a) end,
    'family', case when v.role = 'family' then jsonb_build_object(
                'side', case when siosia_same_family(p_viewer, a.client_id) then 'client' else 'provider' end,
                'member', coalesce((select p.nickname from profiles p
                                     where p.user_id = case when siosia_same_family(p_viewer, a.client_id) then a.client_id else a.provider_id end), '')) end)
  from (select r.role, r.role in ('client', 'provider') as party, r.role <> 'candidate' as sees
          from (select case when a.client_id = p_viewer then 'client' when a.provider_id = p_viewer then 'provider'
                            when siosia_sees(p_viewer, a) then 'family' else 'candidate' end as role) r) v;
$$;

-- 2.1 (FR-161, V34): the open requests of other members a user could take — requested, nobody's
-- yet, not started — soonest first, a series once (its earliest open date); none without a profile.
create or replace function public.siosia_open_rows(p_user uuid)
returns setof public.appointments language sql stable security definer set search_path = public as $$
  select o.* from (select distinct on (coalesce(a.series_id, a.id)) a.* from appointments a
                    where a.provider_id is null and a.status = 'requested' and a.starts_at > now()
                      and a.client_id <> p_user and not siosia_same_family(p_user, a.client_id)
                      and siosia_same_realm(p_user, a.client_id)
                      and exists (select 1 from profiles p where p.user_id = p_user and not p.deleted)
                    order by coalesce(a.series_id, a.id), a.starts_at) o
   order by o.starts_at, o.id;
$$;

-- The same as the candidate sees them (P1 "You could help").
create or replace function public.siosia_open_requests(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(siosia_appointment_json(o, p_user) order by o.starts_at, o.id), '[]'::jsonb)
    from siosia_open_rows(p_user) o;
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
    'masterVehicle', case when (siosia_master_of(p_user)).role = 'driver' then (siosia_master_of(p_user)).vehicle end,
    -- 2.0: the public id (what others see), the services offered, My place (a rider master's
    -- default pickup unless this phone saved its own).
    'publicId', public_id,
    'offers', to_jsonb(siosia_offers_of(p_user)),
    'offersPreset', master_id is not null,
    'home', coalesce(home, case when (siosia_master_of(p_user)).role = 'rider' then (siosia_master_of(p_user)).default_pickup end),
    -- 2.3: my photo — the app signs the path into `photo` (FR-212).
    'photo', null)
    || siosia_photo_path_json(photo_path, true)
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
    'acceptedAt', siosia_ms(r.accepted_at), 'departedAt', siosia_ms(r.departed_at), 'arrivedAt', siosia_ms(r.arrived_at),
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
    -- 2.3 (FR-212): the two parties see each other's photo; a driver browsing bookings is no party yet.
    'rider', siosia_party_for(r.rider_id, v.party),
    'driver', case when r.driver_id is null then null
                   else siosia_party_for(r.driver_id, v.party) || jsonb_build_object('vehicle', siosia_vehicle_json(r.driver_id)) end,
    'myRating', (select g.stars from ratings g where g.ride_id = r.id and g.from_user = p_viewer),
    -- 2.0: the appointment and leg are the rider's business only (FR-114); booked rides go into calendars.
    'appointmentId', case when r.rider_id = p_viewer then r.appointment_id end,
    'leg', case when r.rider_id = p_viewer then r.leg end,
    'calendar', jsonb_build_object('google', null,
                                   'ics', case when r.scheduled_for is not null then siosia_ics_link('r', r.id, p_viewer) end),
    -- 2.3 (FR-221): unread messages in this ride's room (there is one once a driver is assigned).
    'unread', case when v.party and r.driver_id is not null then siosia_unread('ride:' || r.id::text, p_viewer) else 0 end)
  from (select coalesce(p_viewer = r.rider_id or p_viewer = r.driver_id, false) as party) v;
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

-- 2.6 (FR-256): a person and everyone in their family refetch.
create or replace function public.siosia_notify_household(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m uuid;
begin
  if p_user is null then return; end if;
  foreach m in array siosia_household(p_user) loop
    perform siosia_notify(m);
  end loop;
end $$;

-- Queue a notification for a user who turned them on (in their language and the deployment's
-- time zone). Sent by the Edge Function push-dispatch.
create or replace function public.siosia_push(p_user uuid, p_kind text, p_ride uuid, p_params jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or not exists (select 1 from push_subscriptions where user_id = p_user)
     or not siosia_member_ok(p_user) then
    return;
  end if;
  insert into push_outbox (user_id, kind, ride_id, params, lang, tz)
  values (p_user, p_kind, p_ride, coalesce(p_params, '{}'::jsonb),
          coalesce((select language from profiles where user_id = p_user), 'en'),
          coalesce((select timezone from app_config where id = 1), 'Europe/Warsaw'));
  perform siosia_kick_push();
end $$;

-- The sender takes a batch atomically (overlapping runs never send a row twice): each claim counts
-- as an attempt; a claim older than 2 minutes (crashed run) is taken again. Service role only.
create or replace function public.siosia_claim_push(p_limit int)
returns setof public.push_outbox language sql security definer set search_path = public as $$
  update push_outbox set attempts = attempts + 1, claimed_at = now()
   where id in (select id from push_outbox
                 where sent_at is null and attempts < 5
                   and (claimed_at is null or claimed_at < now() - interval '2 minutes')
                 order by id limit greatest(1, least(coalesce(p_limit, 100), 500))
                 for update skip locked)
  returning *;
$$;

-- Ask push-dispatch to send now (pg_net, asynchronous, after commit). No-op until
-- app_config.push_function_url is set or where pg_net is missing; once per transaction.
create or replace function public.siosia_kick_push()
returns void language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  if current_setting('siosia.kicked', true) = '1' then return; end if;
  select push_function_url into v_url from app_config where id = 1;
  if v_url is null or to_regnamespace('net') is null then return; end if;
  select push_secret into v_secret from app_secrets where id = 1;
  perform set_config('siosia.kicked', '1', true);
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      using v_url, '{}'::jsonb, jsonb_build_object('x-push-secret', v_secret, 'content-type', 'application/json');
  exception when others then
    raise warning 'siosia_kick_push: %', sqlerrm; -- never let a notification break the caller
  end;
end $$;

create or replace function public.siosia_nick(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select nickname from profiles where user_id = p_user), '');
$$;

create or replace function public.siosia_standby_until()
returns timestamptz language sql stable security definer set search_path = public as $$
  select case when c.driver_standby_h > 0 then now() + make_interval(hours => c.driver_standby_h) end
    from app_config c where c.id = 1;
$$;

-- Drivers on standby whose app is not in front (phone locked, app closed) hear about a new request.
create or replace function public.siosia_push_standby(p_ride uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rides; d record;
begin
  select * into r from rides where id = p_ride;
  if r.id is null then return; end if;
  for d in select s.user_id from driver_status s
            join vehicles v on v.user_id = s.user_id
            join profiles p on p.user_id = s.user_id and not p.deleted
           where s.standby_until > now()
             and not (s.online and s.last_seen > now() - interval '6 seconds') -- app in front: the card shows it
             and s.user_id <> r.rider_id and not (s.user_id = any (r.excluded))
             and siosia_same_realm(s.user_id, r.rider_id)
             and siosia_master_role(s.user_id) is distinct from 'rider'
             and not exists (select 1 from rides x where (x.rider_id = s.user_id or x.driver_id = s.user_id)
                             and x.status in ('requested','accepted','arrived','in_progress')) loop
    perform siosia_push(d.user_id, 'request_new', r.id, jsonb_build_object('pickup', r.pickup_label));
  end loop;
end $$;

create or replace function public.siosia_rides_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare a appointments; v_old text; v_new text; v_kind text; v_params jsonb;
begin
  perform siosia_notify(new.rider_id);
  perform siosia_notify(new.driver_id);
  if tg_op = 'UPDATE' and old.driver_id is distinct from new.driver_id then
    perform siosia_notify(old.driver_id);
  end if;
  -- A request opened or re-opened: data-less ping so online drivers heartbeat now (§6).
  if new.status = 'requested' and (tg_op = 'INSERT' or old.status <> 'requested' or old.round <> new.round) then
    perform siosia_send('drivers', 'ping');
    perform siosia_push_standby(new.id);
  end if;
  -- 2.0: a ride that is part of an appointment: both parties refetch; when it gets a driver, loses
  -- it or fails, the other party hears it (V12) — the passenger keeps the v1 ride notifications,
  -- and both hear a failure.
  if new.appointment_id is not null then
    select * into a from appointments where id = new.appointment_id;
    if a.id is not null then
      perform siosia_notify(a.client_id);
      perform siosia_notify(a.provider_id);
      if tg_op = 'UPDATE' then
        v_old := siosia_ride_summary(old.status, old.driver_id, old.cancelled_by, old.cancel_reason);
        v_new := siosia_ride_summary(new.status, new.driver_id, new.cancelled_by, new.cancel_reason);
        if v_old in ('pending', 'confirmed') and v_new is distinct from v_old and v_new in ('pending', 'confirmed', 'failed') then
          v_kind := case v_new when 'confirmed' then 'appt_ride_taken' when 'pending' then 'appt_ride_lost' else 'appt_ride_failed' end;
          v_params := siosia_appt_params(a)
                      || jsonb_build_object('leg', new.leg, 'time', new.scheduled_for, 'driver', siosia_nick(new.driver_id));
          perform siosia_push_appt(case when new.rider_id = a.client_id then a.provider_id else a.client_id end, v_kind, a.id, v_params);
          if v_new = 'failed' then perform siosia_push_appt(new.rider_id, v_kind, a.id, v_params); end if;
        end if;
      end if;
    end if;
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
    driver_id = null, accepted_at = null, departed_at = null, arrived_at = null,
    round = round + 1, redispatch_count = redispatch_count + 1,
    dispatch_started_at = now(), notified_count = 0, cancel_reason = p_reason
  where id = p_ride and status in ('accepted','arrived') and driver_id = p_driver;
  return found;
end $$;

create or replace function public.siosia_go_offline(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o record;
begin
  update driver_status set online = false, standby_until = null where user_id = p_user;
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
  -- 2.0: appointments (expiry, done, reminders, series rides) before the v1 steps. Its rows are
  -- isolated one by one; this guard keeps the ride steps below running whatever happens there.
  begin
    perform siosia_sweep_appointments();
  exception when others then
    raise warning 'siosia_sweep: appointments skipped: %', sqlerrm;
  end;
  -- 2.6: lapsed family invitations, the Monday report (V65) — never stopping the ride steps.
  begin
    perform siosia_sweep_family(now());
  exception when others then
    raise warning 'siosia_sweep: family skipped: %', sqlerrm;
  end;
  -- 0. bookings: a claimed one starts (driver on the way) booking_lead_min before its time; an
  --    unclaimed one opens to normal dispatch booking_open_min before. Either waits while its
  --    people are busy and gives up 15 minutes after the booked time.
  for r in select * from rides where status = 'scheduled'
           and scheduled_for - make_interval(mins => case when driver_id is null then c.booking_open_min
                                                          else c.booking_lead_min end) <= now()
           order by scheduled_for
           for update skip locked loop
    begin
      -- A booking whose rider no longer exists ends; one whose driver is gone loses its driver.
      if not exists (select 1 from profiles where user_id = r.rider_id and not deleted) then
        perform siosia_end_ride(r.id, 'cancelled', 'system', 'user_gone', array['scheduled']);
        continue;
      end if;
      if r.driver_id is not null and not exists (select 1 from profiles where user_id = r.driver_id and not deleted) then
        update rides set driver_id = null where id = r.id;
        r.driver_id := null;
      end if;
      -- Busy = any active ride in either role (a rider who is driving someone is busy too).
      v_rider_busy := exists (select 1 from rides x where (x.rider_id = r.rider_id or x.driver_id = r.rider_id)
                              and x.status in ('requested','accepted','arrived','in_progress'));
      if r.driver_id is not null and not v_rider_busy
         and not exists (select 1 from rides x where (x.driver_id = r.driver_id or x.rider_id = r.driver_id)
                         and x.status in ('requested','accepted','arrived','in_progress')) then
        update rides set status = 'accepted', accepted_at = now(), dispatch_started_at = now()
         where id = r.id and status = 'scheduled';
        -- The driver is on duty for this ride from now on, even before their app is open.
        insert into driver_status (user_id, online, last_seen, standby_until) values (r.driver_id, true, now(), siosia_standby_until())
        on conflict (user_id) do update set online = true, last_seen = now(), standby_until = siosia_standby_until();
        for o in select id from offers where driver_id = r.driver_id and status in ('offered','queued') order by status desc loop
          perform siosia_close_offer(o.id, 'withdrawn');
        end loop;
        perform siosia_push(r.driver_id, 'time_to_go', r.id,
                            jsonb_build_object('at', r.scheduled_for, 'pickup', r.pickup_label, 'rider', siosia_nick(r.rider_id)));
        perform siosia_push(r.rider_id, 'driver_coming', r.id,
                            jsonb_build_object('at', r.scheduled_for, 'driver', siosia_nick(r.driver_id)));
      elsif r.driver_id is null and not v_rider_busy then
        update rides set status = 'requested', dispatch_started_at = now(), notified_count = 0
         where id = r.id and status = 'scheduled';
        perform siosia_push(r.rider_id, 'booking_open', r.id, jsonb_build_object('at', r.scheduled_for));
      elsif now() > r.scheduled_for + interval '15 minutes' then
        if v_rider_busy then
          perform siosia_end_ride(r.id, 'expired', 'system', null, array['scheduled']);
        else
          update rides set status = 'requested', driver_id = null, dispatch_started_at = now(), notified_count = 0
           where id = r.id and status = 'scheduled';
          perform siosia_push(r.rider_id, 'booking_open', r.id, jsonb_build_object('at', r.scheduled_for));
        end if;
      end if;
    exception when others then
      -- One booking must never stop the sweep (it runs inside every API call): skip it, retry later.
      raise warning 'siosia_sweep: booking % skipped: %', r.id, sqlerrm;
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
  -- 5. accepted/arrived rides whose driver has been silent for 15 min are re-dispatched (§12 says
  --    60 s, but an iPhone pauses Siosia whenever its screen locks or Maps is in front, so a driver
  --    on the way is often silent for minutes)
  for r in select x.id, x.driver_id from rides x left join driver_status d on d.user_id = x.driver_id
           where x.status in ('accepted','arrived')
             and (d.user_id is null or d.last_seen < now() - interval '15 minutes')
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
             and siosia_same_realm(p_driver, x.rider_id) -- 2.7 (V66)
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
          and siosia_same_realm(p_user, x.rider_id)
          and siosia_km(p_lat, p_lng, x.pickup_lat, x.pickup_lng) <= c.dispatch_radius_km) end,
    'pendingReceipt', case when p.id is null then null else siosia_ride_json(p, p_user) end,
    'bookings', (select count(*) from rides x where x.status = 'scheduled' and x.rider_id = p_user),
    'driverBookings', (select count(*) from rides x where x.status = 'scheduled' and x.driver_id = p_user),
    'hasProfile', exists (select 1 from profiles where user_id = p_user and not deleted),
    'standby', coalesce((select standby_until > now() from driver_status where user_id = p_user), false),
    'openBookings', case when siosia_master_role(p_user) = 'rider'
                           or not exists (select 1 from vehicles where user_id = p_user) then 0 else
      (select count(*) from rides x where x.status = 'scheduled' and x.driver_id is null
          and x.rider_id <> p_user and not (p_user = any (x.excluded)) and siosia_same_realm(p_user, x.rider_id)) end,
    -- 2.0 (V22): requests waiting for my answer (a series counts once), upcoming items, the next one.
    'toAnswer', (select count(distinct coalesce(series_id, id)) from appointments
                  where provider_id = p_user and status = 'requested' and starts_at > now()),
    -- 2.1 (FR-161): others' open requests I could take (a series counts once) — the S1 badge.
    'openRequests', (select count(*) from siosia_open_rows(p_user)),
    -- 2.3 (FR-221): unread chat messages across my rooms (the S1 badge).
    'unreadChats', siosia_unread_total(p_user),
    -- 2.6: family invitations to me and contract proposals my side should answer (the S1 notice).
    'familyPending', (select count(*) from family_invites i
                       where i.to_user = p_user and i.status = 'pending' and now() < i.created_at + interval '7 days')
                   + (select count(*) from contracts k where k.status = 'proposed' and siosia_contract_answers(p_user, k)),
    'planned', (select count(*) from appointments
                 where (client_id = p_user or provider_id = p_user) and status in ('requested', 'accepted')
                   and starts_at + make_interval(mins => duration_min) > now())
             + (select count(*) from rides x
                 where (x.rider_id = p_user or x.driver_id = p_user)
                   and x.status in ('scheduled', 'requested', 'accepted', 'arrived', 'in_progress')
                   and not (x.appointment_id is not null and x.rider_id = p_user)),
    'nextPlanned', (select jsonb_build_object('kind', n.k, 'at', siosia_ms(n.t), 'serviceId', n.sid,
                                              'title', siosia_service_name(n.sid, coalesce((select language from profiles where user_id = p_user), 'en')))
                      from (select 'appointment' as k, a.starts_at as t, a.service_id as sid from appointments a
                             where (a.client_id = p_user or a.provider_id = p_user) and a.status in ('requested', 'accepted')
                               and a.starts_at + make_interval(mins => a.duration_min) > now()
                            union all
                            select 'ride', x.scheduled_for, 'ride' from rides x
                             where (x.rider_id = p_user or x.driver_id = p_user) and x.status = 'scheduled'
                               and not (x.appointment_id is not null and x.rider_id = p_user)) n
                     order by n.t limit 1));
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

-- 2.7 (V67): a master profile's phones are one person in the member list and the catalog — its
-- newest account stands for it (created_at, then user_id), and its own other phones do not list it.
create or replace function public.siosia_listed(p_user uuid, p_viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select p.master_id is null
        or (p.master_id is distinct from (select v.master_id from profiles v where v.user_id = p_viewer and not v.deleted)
            and not exists (select 1 from profiles o
                             where o.master_id = p.master_id and not o.deleted and o.user_id <> p.user_id
                               and siosia_member_ok(o.user_id) and siosia_same_realm(p_viewer, o.user_id)
                               and (o.created_at, o.user_id) > (p.created_at, p.user_id)))
      from profiles p where p.user_id = p_user), true);
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
                                  'leadMin', booking_lead_min, 'openMin', booking_open_min, 'maxOpen', booking_max_open),
    'services', coalesce((select jsonb_agg(x.e order by x.ord)
                            from jsonb_array_elements(coalesce(services, '[]'::jsonb)) with ordinality as x(e, ord)
                           where coalesce((x.e ->> 'enabled')::boolean, false)), '[]'::jsonb),
    'appointment', jsonb_build_object('reminderMin', to_jsonb(appt_reminder_min), 'seriesMaxDays', appt_series_max_days,
                                      'seriesMaxCount', appt_series_max_count),
    'calendarUrl', calendar_function_url,
    'serviceArea', case when service_lat is null or service_lng is null or service_radius_km is null then null
                        else jsonb_build_object('lat', service_lat, 'lng', service_lng, 'radiusKm', service_radius_km) end,
    'dispatchRadiusKm', dispatch_radius_km,
    'maxTripKm', max_trip_km,
    'timezone', timezone,
    'standbyHours', driver_standby_h,
    'operatorContact', operator_contact,
    'vapidPublicKey', (select vapid_public from app_secrets where id = 1))
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

-- Operator only (SQL editor), 2.7 (V66): the test invite code for the live smoke tests; null removes it.
create or replace function public.siosia_set_test_invite_code(p_code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_code is null then
    update app_secrets set test_invite_code_hash = null where id = 1;
    return 'Test invite code removed.';
  end if;
  if char_length(siosia_norm_code(p_code)) < 4 then raise exception 'Test invite code must have at least 4 characters'; end if;
  if exists (select 1 from app_secrets where id = 1 and crypt(siosia_norm_code(p_code), invite_code_hash) = invite_code_hash) then
    raise exception 'The test invite code must differ from the invite code';
  end if;
  update app_secrets set test_invite_code_hash = crypt(siosia_norm_code(p_code), gen_salt('bf', 8)) where id = 1;
  return 'Test invite code set. Accounts that join with it are test accounts.';
end $$;

-- Operator only, 2.7 (V66): moves an account (by public id) into the sandbox or out of it.
create or replace function public.siosia_set_sandbox(p_public text, p_on boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  select user_id into v_uid from profiles where public_id = p_public;
  if v_uid is null then raise exception 'No profile with public id %', p_public; end if;
  update memberships set sandbox = coalesce(p_on, false) where user_id = v_uid;
  perform siosia_notify(v_uid);
  return case when coalesce(p_on, false) then 'Now a test account.' else 'Now a real account.' end;
end $$;

create or replace function public.siosia_join(p_code text, p_device text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); v_hash text; v_test text; v_sandbox boolean;
begin
  if v_uid is null then return siosia_err('forbidden'); end if;
  if coalesce(char_length(p_device), 0) not between 1 and 80 then return siosia_err('bad_input'); end if;
  if (select count(*) from invite_failures where user_id = v_uid and at > now() - interval '1 hour') >= 10 then
    return siosia_err('rate_limited');
  end if;
  select invite_code_hash, test_invite_code_hash into v_hash, v_test from app_secrets where id = 1;
  -- 2.7 (V66): the test code admits too, into the sandbox (once in it, an account stays there).
  v_sandbox := v_test is not null and crypt(siosia_norm_code(p_code), v_test) = v_test;
  if not v_sandbox and (v_hash is null or crypt(siosia_norm_code(p_code), v_hash) <> v_hash) then
    insert into invite_failures (user_id) values (v_uid);
    return siosia_err('bad_invite');
  end if;
  insert into memberships (user_id, device_id, sandbox) values (v_uid, p_device, v_sandbox)
  on conflict (user_id, device_id) do update set sandbox = memberships.sandbox or excluded.sandbox;
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

-- A place {lat, lng, label} as stored for default pickups / dropoffs (null is fine). Never null
-- itself: a missing lat or lng is false (a null here used to let such a place through). A
-- coordinate is 0 or at least 1e-300 in size (a smaller one fails its float8 cast); any label
-- that is not blank is fine, however long (geocoded ones can be): siosia_clean_place cuts it.
create or replace function public.siosia_valid_place(p jsonb)
returns boolean language sql immutable as $$
  select p is null or coalesce(jsonb_typeof(p -> 'lat') = 'number' and jsonb_typeof(p -> 'lng') = 'number'
                               and abs((p ->> 'lat')::numeric) <= 90 and abs((p ->> 'lng')::numeric) <= 180
                               and ((p ->> 'lat')::numeric = 0 or abs((p ->> 'lat')::numeric) >= 1e-300)
                               and ((p ->> 'lng')::numeric = 0 or abs((p ->> 'lng')::numeric) >= 1e-300)
                               and btrim(coalesce(p ->> 'label', '')) <> '', false);
$$;

-- A valid place as stored: just {lat, lng, label}, the label trimmed and cut to 120 characters
-- (twin of cleanPlace), never the caller's JSON.
create or replace function public.siosia_clean_place(p jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('lat', (p ->> 'lat')::float8, 'lng', (p ->> 'lng')::float8, 'label', left(btrim(p ->> 'label'), 120));
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
declare v_uid uuid := auth.uid(); t account_transfers; v_old uuid; v_via text; v_hash text; v_photo text; k kids;
begin
  if v_uid is null then return siosia_err('forbidden'); end if;
  if coalesce(char_length(p_device), 0) not between 1 and 80 then return siosia_err('bad_input'); end if;
  if (select count(*) from invite_failures where user_id = v_uid and at > now() - interval '1 hour') >= 10 then
    return siosia_err('rate_limited');
  end if;
  v_hash := encode(digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
  select * into t from account_transfers where code_hash = v_hash and expires_at > now();
  v_old := t.user_id;
  -- The old account must still have its profile and a valid membership (a revoked master link
  -- must not turn into a full membership here).
  if v_old is null or not exists (select 1 from profiles where user_id = v_old and not deleted)
     or not siosia_member_ok(v_old) then
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
  -- Re-check under the locks: a second tap that waited here finds the code already used.
  select * into t from account_transfers where code_hash = v_hash and expires_at > now() for update;
  if t.user_id is distinct from v_old or not exists (select 1 from profiles where user_id = v_old and not deleted) then
    return siosia_err('bad_transfer');
  end if;
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
  update appointments set client_id = v_uid where client_id = v_old;
  update appointments set provider_id = v_uid where provider_id = v_old;
  update appointment_series set client_id = v_uid where client_id = v_old;
  update appointment_series set provider_id = v_uid where provider_id = v_old;
  -- Both accounts may hold a card for the same ride, or have rated the same ride: keep the new one.
  delete from offers o using offers n
   where o.driver_id = v_old and n.driver_id = v_uid and n.ride_id = o.ride_id and n.round = o.round;
  delete from ratings g using ratings n
   where g.from_user = v_old and n.from_user = v_uid and n.ride_id = g.ride_id;
  update offers set driver_id = v_uid where driver_id = v_old;
  delete from ratings g using ratings n
   where g.from_user = v_old and n.from_user = v_uid and n.appointment_id = g.appointment_id;
  update ratings set from_user = v_uid where from_user = v_old;
  update ratings set to_user = v_uid where to_user = v_old;
  -- 2.3 (V49): the kid ratings given, the messages sent and the chat presence come along and, like
  -- rides and ratings, a replaced profile's own rows of those merge (its presence yields to the
  -- newer row). The kids (their attachments and ratings hang on them) come along too, but a
  -- replaced profile is a deleted one (FR-200): its own kids go first, photos included, and the
  -- providers who expect them hear about it. The photos follow their rows: the object folders are
  -- keyed by the profile's public id, which moves with the profile row below, and ownership is
  -- read from the row that holds the path (siosia_photo_owner) — nothing to rewrite.
  for k in select * from kids where owner_id = v_uid loop
    perform siosia_notify_kid_providers(k.id); -- while the attachments still say who expects the kid
    if k.photo_path is not null then perform siosia_drop_photo_object(k.photo_path); end if;
  end loop;
  delete from kids where owner_id = v_uid;
  update kids set owner_id = v_uid where owner_id = v_old;
  update kid_ratings set from_user = v_uid where from_user = v_old;
  update messages set sender = v_uid where sender = v_old;
  update appointment_updates set author = v_uid where author = v_old; -- 2.5 (FR-235)
  -- 2.6: a replaced profile leaves its family first (as a deleted one would); then the family, the
  -- invitations and the contracts follow the account.
  if exists (select 1 from profiles where user_id = v_uid and not deleted) then perform siosia_drop_from_families(v_uid); end if;
  delete from family_members where user_id = v_uid;
  update family_members set user_id = v_uid where user_id = v_old;
  update family_invites set from_user = v_uid where from_user = v_old;
  update family_invites set to_user = v_uid where to_user = v_old;
  update contracts set provider_id = v_uid where provider_id = v_old;
  update contracts set proposed_by = v_uid where proposed_by = v_old;
  update contracts set ended_by = v_uid where ended_by = v_old;
  update member_invites set from_user = v_uid where from_user = v_old; -- 2.8: links made and used follow the account
  update member_invites set used_by = v_uid where used_by = v_old;
  delete from chat_presence o using chat_presence n where o.user_id = v_old and n.user_id = v_uid and n.room = o.room;
  update chat_presence set user_id = v_uid where user_id = v_old;
  -- The replaced profile's row goes, and with it its photo: that object is dropped from the bucket.
  select photo_path into v_photo from profiles where user_id = v_uid;
  delete from profiles where user_id = v_uid;
  update profiles set user_id = v_uid where user_id = v_old;
  if v_photo is not null and v_photo is distinct from (select photo_path from profiles where user_id = v_uid) then
    perform siosia_drop_photo_object(v_photo);
  end if;
  if exists (select 1 from vehicles where user_id = v_old) then
    delete from vehicles where user_id = v_uid;
    update vehicles set user_id = v_uid where user_id = v_old;
  end if;
  delete from driver_status where user_id = v_old;
  -- This device becomes a member the way the old account was: invite code first, else its link.
  select via_master into v_via from memberships where user_id = v_old order by via_master nulls first limit 1;
  -- 2.7 (V66): a test account stays one on the new phone.
  insert into memberships (user_id, device_id, via_master, sandbox) values (v_uid, p_device, v_via, siosia_sandbox(v_old))
  on conflict (user_id, device_id) do update
    set via_master = case when memberships.via_master is null then null else excluded.via_master end,
        sandbox = memberships.sandbox or excluded.sandbox;
  delete from memberships where user_id = v_old;
  delete from account_transfers where user_id = v_old;
  delete from push_subscriptions where user_id = v_old;
  perform siosia_notify(v_old);
  perform siosia_notify(v_uid);
  return siosia_ok(siosia_profile_json(v_uid));
end $$;

-- Operator only (SQL editor): create or update a master profile and (re)set its link token. The
-- link is <app URL>#master=<token>; setting a new token makes the old link stop working.
--   p_role 'rider': p_fixed_fare (null = tariff), p_pickup / p_dropoff {lat, lng, label} defaults.
--   p_role 'driver': p_vehicle {make, model, colour, seats, plate?}.
drop function if exists public.siosia_set_master(text, text, text, text, numeric);
drop function if exists public.siosia_set_master(text, text, text, text, numeric, text, jsonb, jsonb, jsonb);
--   p_offers: catalog ids of kind "time" every phone on this profile offers (null = none; rides come with the vehicle).
create or replace function public.siosia_set_master(p_id text, p_token text, p_nickname text, p_icon text, p_fixed_fare numeric,
                                                    p_role text default 'rider', p_pickup jsonb default null,
                                                    p_dropoff jsonb default null, p_vehicle jsonb default null,
                                                    p_offers text[] default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text := encode(digest(btrim(coalesce(p_token, '')), 'sha256'), 'hex'); u record;
begin
  if btrim(coalesce(p_token, '')) !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'The link token must be 16-128 characters: letters, digits, - or _';
  end if;
  if p_role is null or p_role not in ('rider', 'driver') then raise exception 'p_role must be rider or driver'; end if;
  if not siosia_valid_place(p_pickup) or not siosia_valid_place(p_dropoff) then
    raise exception 'A place is {"lat": number, "lng": number, "label": "not blank, kept to 120 characters"}';
  end if;
  if p_vehicle is not null and (
       char_length(coalesce(p_vehicle ->> 'make', '')) not between 1 and 30
       or char_length(coalesce(p_vehicle ->> 'model', '')) not between 1 and 30
       or char_length(coalesce(p_vehicle ->> 'colour', '')) not between 1 and 20
       or jsonb_typeof(p_vehicle -> 'seats') <> 'number' or (p_vehicle ->> 'seats')::numeric not between 1 and 6
       or (p_vehicle ? 'plate' and char_length(coalesce(p_vehicle ->> 'plate', '')) not between 2 and 12)) then
    raise exception 'A vehicle is {"make", "model", "colour", "seats": 1-6, "plate"?: 2-12 characters}';
  end if;
  if p_offers is not null and exists (select 1 from unnest(p_offers) x
                                       where siosia_service(x) is null or siosia_service(x) ->> 'kind' <> 'time') then
    raise exception 'p_offers lists catalog ids of kind "time"';
  end if;
  -- A new token retires the old link: phones that joined only through it must open the new one.
  delete from memberships mb using master_profiles m
   where mb.via_master = m.id and m.id = p_id and m.token_hash <> v_hash;
  insert into master_profiles (id, token_hash, nickname, icon, fixed_fare, active, role, default_pickup, default_dropoff, vehicle, offers)
  values (p_id, v_hash, btrim(p_nickname), nullif(btrim(coalesce(p_icon, '')), ''),
          p_fixed_fare, true, p_role,
          case when p_pickup is null then null else siosia_clean_place(p_pickup) end,
          case when p_dropoff is null then null else siosia_clean_place(p_dropoff) end, p_vehicle, p_offers)
  on conflict (id) do update set token_hash = excluded.token_hash, nickname = excluded.nickname, icon = excluded.icon,
                                  fixed_fare = excluded.fixed_fare, active = true, role = excluded.role,
                                  default_pickup = excluded.default_pickup, default_dropoff = excluded.default_dropoff,
                                  vehicle = excluded.vehicle, offers = excluded.offers;
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
  perform siosia_link_family_invites(auth.uid()); -- 2.8 (FR-302): who invited me by link asks me into their family
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

-- 2.1 (FR-170, V38): the car's colour from the car icon — its name in the driver's words (riders
-- read it) and the paint the icon is drawn in (#rrggbb, any case, kept lowercase). The rest of the
-- vehicle stays; siosia_save_vehicle keeps the paint.
create or replace function public.siosia_set_car_colour(p_colour text, p_paint text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_colour text := btrim(coalesce(p_colour, ''));
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if siosia_master_role(v_uid) = 'rider' then return siosia_err('rider_only'); end if;
  if not exists (select 1 from vehicles where user_id = v_uid) then return siosia_err('no_vehicle'); end if;
  if char_length(v_colour) not between 1 and 20 or coalesce(p_paint, '') !~* '^#[0-9a-f]{6}$' then
    return siosia_err('bad_vehicle');
  end if;
  update vehicles set colour = v_colour, paint = lower(p_paint), updated_at = now() where user_id = v_uid;
  perform siosia_notify(v_uid);
  return siosia_ok(siosia_vehicle_json(v_uid));
end $$;

-- Delete = anonymise (nickname "Deleted user"), remove vehicle and memberships (§9 retention).
create or replace function public.siosia_delete_profile()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); r record; a appointments; v_ids uuid[];
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if exists (select 1 from rides where status in ('requested','accepted','arrived','in_progress')
             and (rider_id = v_uid or driver_id = v_uid)) then
    return siosia_err('active_ride');
  end if;
  -- 2.0 (FR-142): upcoming appointments in either role end (system, user_gone), their rides follow,
  -- and the other party is told once per appointment or series (an open request has none: 2.1).
  -- Finished ones are anonymised below.
  select array_agg(id) into v_ids from appointments
   where (client_id = v_uid or provider_id = v_uid) and status in ('requested', 'accepted');
  if v_ids is not null then
    update appointments set status = 'cancelled', ended_at = now(), cancelled_by = 'system', cancel_reason = 'user_gone'
     where id = any (v_ids);
    perform siosia_cascade_rides(v_ids);
    for a in select distinct on (coalesce(series_id, id)) * from appointments where id = any (v_ids)
             order by coalesce(series_id, id), starts_at loop
      perform siosia_push_appt(case when a.client_id = v_uid then a.provider_id else a.client_id end, 'appt_cancelled', a.id,
                               siosia_appt_params(a) || jsonb_build_object('who', siosia_nick(v_uid))
                               || case when a.series_id is null then '{}'::jsonb else jsonb_build_object('from', a.starts_at,
                                    'left', (select count(*) from appointments x where x.series_id = a.series_id and x.id = any (v_ids))) end);
    end loop;
  end if;
  update appointment_series set status = 'cancelled'
   where (client_id = v_uid or provider_id = v_uid) and status in ('requested', 'answered');
  for r in select id, driver_id, scheduled_for, pickup_label from rides
           where rider_id = v_uid and status = 'scheduled' and driver_id is not null loop
    perform siosia_push(r.driver_id, 'booking_cancelled', r.id, jsonb_build_object('at', r.scheduled_for, 'pickup', r.pickup_label));
  end loop;
  for r in select id, rider_id, scheduled_for from rides where driver_id = v_uid and status = 'scheduled' loop
    perform siosia_push(r.rider_id, 'booking_released', r.id, jsonb_build_object('at', r.scheduled_for));
  end loop;
  update rides set status = 'cancelled', ended_at = now(), cancelled_by = 'rider'
   where rider_id = v_uid and status = 'scheduled';
  update rides set driver_id = null where driver_id = v_uid and status = 'scheduled';
  -- 2.6 (FR-252, FR-263): I leave my family; my contracts as a provider end; my invitations go.
  perform siosia_drop_from_families(v_uid);
  perform siosia_go_offline(v_uid);
  delete from vehicles where user_id = v_uid;
  delete from memberships where user_id = v_uid;
  delete from push_subscriptions where user_id = v_uid;
  -- 2.3 (FR-200, V44, V49): the kids go with the profile — their attachments and ratings by cascade
  -- — so do the messages sent, the chat presence and every photo object of this account: each
  -- object a row holds (a merged account's kid may sit under a former folder), then whatever is
  -- left under this profile's folders (the app removed the files; this drops any row left).
  for r in select photo_path as p from kids where owner_id = v_uid and photo_path is not null
           union all select photo_path from profiles where user_id = v_uid and photo_path is not null
           union all select photo_path from appointment_updates where author = v_uid and photo_path is not null loop
    perform siosia_drop_photo_object(r.p);
  end loop;
  perform siosia_drop_photo_objects(v_uid);
  delete from kids where owner_id = v_uid;
  delete from messages where sender = v_uid;
  delete from appointment_updates where author = v_uid; -- 2.5 (FR-235): my updates and their photos (dropped above)
  delete from chat_presence where user_id = v_uid;
  update profiles set nickname = 'Deleted user', deleted = true, master_id = null, offers = '{}', home = null, photo_path = null
   where user_id = v_uid;
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
     -- a day at most: a bigger one overflows est_min / the fare (NaN counts as bigger)
     or p_est_min > 1440 or p_est_km = 'Infinity'::float8 then
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
  values (v_uid, plat, plng, left(btrim(coalesce(p_pickup ->> 'label', '')), 120),
          dlat, dlng, left(btrim(coalesce(p_dropoff ->> 'label', '')), 120),
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
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  -- The rules (lead, horizon, booking_max_open open, 10 new a day, fare frozen) live in siosia_book_for.
  return siosia_book_for(v_uid, p_pickup, p_dropoff, p_est_km, p_est_min, p_fare_is_estimate, p_scheduled_for, null, null, false);
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
  if not exists (select 1 from vehicles where user_id = v_uid) then return siosia_err('no_vehicle'); end if;
  perform siosia_sweep();
  return siosia_ok(coalesce((
    select jsonb_agg(jsonb_build_object(
             'ride', siosia_ride_json(x, v_uid),
             'distanceKm', case when p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then null
                                else round(siosia_km(p_lat, p_lng, x.pickup_lat, x.pickup_lng)::numeric, 1) end)
           order by x.scheduled_for)
      from rides x where x.status = 'scheduled' and x.driver_id is null and x.rider_id <> v_uid
                     and not (v_uid = any (x.excluded)) and siosia_same_realm(v_uid, x.rider_id)), '[]'::jsonb));
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
  if r.id is null or r.rider_id = v_uid or v_uid = any (r.excluded) or not siosia_same_realm(v_uid, r.rider_id) then
    return siosia_err('not_found');
  end if;
  if r.status <> 'scheduled' or r.driver_id is not null then return siosia_err('taken'); end if;
  if exists (select 1 from rides x where x.status = 'scheduled' and x.driver_id = v_uid
             and abs(extract(epoch from x.scheduled_for - r.scheduled_for)) < (greatest(x.est_min, r.est_min) + 30) * 60) then
    return siosia_err('overlap');
  end if;
  update rides set driver_id = v_uid where id = p_ride and status = 'scheduled' and driver_id is null;
  if not found then return siosia_err('taken'); end if;
  -- A new driver starts a fresh thread: a previous driver's words never reach them (FR-223, V47).
  delete from messages where room = 'ride:' || p_ride::text;
  perform siosia_push(r.rider_id, 'booking_taken', r.id,
                      jsonb_build_object('at', r.scheduled_for, 'driver', siosia_nick(v_uid)));
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
  perform siosia_push(r.rider_id, 'booking_released', r.id, jsonb_build_object('at', r.scheduled_for));
  return siosia_ok('true'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Notifications: this device's Web Push subscription
-- ---------------------------------------------------------------------------------------------

create or replace function public.siosia_save_push(p_endpoint text, p_p256dh text, p_auth text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  -- Only real push services (Apple, Google, Mozilla, Microsoft): the sender posts to this URL.
  if coalesce(p_endpoint, '') !~ '^https://([a-z0-9-]+\.)*(push\.apple\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)/'
     or char_length(p_endpoint) > 1000
     or char_length(coalesce(p_p256dh, '')) not between 10 and 200 or char_length(coalesce(p_auth, '')) not between 8 and 100 then
    return siosia_err('bad_input');
  end if;
  insert into push_subscriptions (endpoint, user_id, p256dh, auth) values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
                                       created_at = now();
  return siosia_ok('true'::jsonb);
end $$;

create or replace function public.siosia_delete_push(p_endpoint text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(false);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
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
    perform siosia_push(r.driver_id, 'booking_cancelled', r.id,
                        jsonb_build_object('at', r.scheduled_for, 'pickup', r.pickup_label));
    return siosia_ok('true'::jsonb);
  elsif r.driver_id = v_uid and r.status = 'scheduled' then
    return siosia_release_booking(r.id);
  elsif r.rider_id = v_uid then
    if r.status not in ('requested','accepted','arrived') then return siosia_err('illegal_transition'); end if;
    -- Not held against the rider once Siosia gave up on their driver (silent for 15 min).
    if not (r.status = 'requested' and r.cancel_reason is not distinct from 'driver_lost') then
      update profiles set rider_cancels = rider_cancels + 1,
                          late_cancels = late_cancels + case when r.status = 'arrived' then 1 else 0 end
       where user_id = v_uid;
    end if;
    perform siosia_end_ride(r.id, 'cancelled', 'rider', case when r.status = 'arrived' then 'late_cancel' end);
    return siosia_ok('true'::jsonb);
  elsif r.driver_id = v_uid then
    if r.status = 'arrived' and v_reason = 'no_show' then
      select * into c from app_config where id = 1;
      -- A booked ride waits from the booked time, even if the driver came early.
      if r.arrived_at is null or now() < greatest(r.arrived_at, r.scheduled_for) + make_interval(secs => c.no_show_wait_s) then
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
    insert into driver_status (user_id, online, last_seen, standby_until) values (v_uid, true, now(), siosia_standby_until())
    on conflict (user_id) do update set online = true, last_seen = now(), standby_until = siosia_standby_until();
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
  update driver_status set last_seen = now(), standby_until = siosia_standby_until() where user_id = v_uid and online;
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
    begin
      update rides set status = 'accepted', driver_id = v_uid, accepted_at = now()
       where id = o.ride_id and status = 'requested' and round = o.round
      returning id into v_won;
      -- A new driver starts a fresh thread (FR-223, V47) — as the engine's resetRoom.
      if v_won is not null then delete from messages where room = 'ride:' || v_won::text; end if;
    exception when unique_violation then
      return siosia_err('active_trip'); -- a booking of this driver started at this very moment
    end;
    if v_won is null then
      perform siosia_close_offer(o.id, 'withdrawn');
      return siosia_err('taken');
    end if;
    update offers set status = 'won', decided_at = now() where id = o.id;
    perform siosia_withdraw_ride_offers(o.ride_id);
    perform siosia_drop_cards(v_uid);
    perform siosia_push(r.rider_id, 'driver_coming', r.id, jsonb_build_object('driver', siosia_nick(v_uid)));
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
    perform siosia_push(r.rider_id, 'driver_arrived', r.id, jsonb_build_object('driver', siosia_nick(v_uid)));
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

-- 2.2 (FR-180): the driver's phone saw the car move towards the pickup. The rider is told once,
-- while the ride is accepted; later calls and other statuses change nothing.
create or replace function public.siosia_depart(p_ride uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); r rides;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  update driver_status set last_seen = now() where user_id = v_uid and online;
  select * into r from rides where id = p_ride for update;
  if r.id is null then return siosia_err('not_found'); end if;
  if r.driver_id is distinct from v_uid then return siosia_err('forbidden'); end if;
  if r.status = 'accepted' and r.departed_at is null then
    update rides set departed_at = now() where id = p_ride returning * into r;
    perform siosia_push(r.rider_id, 'driver_departed', r.id, jsonb_build_object('driver', siosia_nick(v_uid)));
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

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.0: the service catalog (deployment configuration)
-- ---------------------------------------------------------------------------------------------

-- The reason a catalog is invalid, or null (V21): ids ^[a-z][a-z0-9_]{1,23}$ unique, exactly one
-- entry of kind "ride" (id "ride"), at most 12, names/descriptions in EN and PL, time entries with
-- 15 ≤ min ≤ default ≤ max ≤ 1440 on a step of 15 or 30, price null | {perHour} | {fixed}.
create or replace function public.siosia_catalog_problem(p jsonb)
returns text language plpgsql immutable as $$
declare e jsonb; d jsonb; v_ids text[] := '{}'; v_rides int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return 'the catalog is a JSON array'; end if;
  if jsonb_array_length(p) not between 1 and 32 then return 'a catalog has 1 to 32 entries'; end if;
  for e in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'id', '') !~ '^[a-z][a-z0-9_]{1,23}$' then
      return format('bad id: %s', e ->> 'id');
    end if;
    if (e ->> 'id') = any (v_ids) then return format('duplicate id: %s', e ->> 'id'); end if;
    v_ids := v_ids || (e ->> 'id');
    if coalesce(e ->> 'kind', '') not in ('ride', 'time') then return format('%s: kind is ride or time', e ->> 'id'); end if;
    if char_length(coalesce(e -> 'name' ->> 'en', '')) not between 1 and 40
       or char_length(coalesce(e -> 'name' ->> 'pl', '')) not between 1 and 40 then
      return format('%s: name {en, pl}, 1-40 characters each', e ->> 'id');
    end if;
    if jsonb_typeof(e -> 'description') <> 'object' or char_length(coalesce(e -> 'description' ->> 'en', '')) > 160
       or char_length(coalesce(e -> 'description' ->> 'pl', '')) > 160 then
      return format('%s: description {en, pl}, up to 160 characters each', e ->> 'id');
    end if;
    if char_length(coalesce(e ->> 'icon', '')) not between 1 and 40 then return format('%s: icon, 1-40 characters', e ->> 'id'); end if;
    if jsonb_typeof(e -> 'enabled') <> 'boolean' or jsonb_typeof(e -> 'needsPlace') <> 'boolean' then
      return format('%s: enabled and needsPlace are true or false', e ->> 'id');
    end if;
    if e -> 'price' is not null and jsonb_typeof(e -> 'price') <> 'null' and not (
         (jsonb_typeof(e -> 'price' -> 'perHour') = 'number' and (e -> 'price' ->> 'perHour')::numeric > 0)
         or (jsonb_typeof(e -> 'price' -> 'fixed') = 'number' and (e -> 'price' ->> 'fixed')::numeric >= 0)) then
      return format('%s: price is null, {"perHour": n} or {"fixed": n}', e ->> 'id');
    end if;
    -- 2.8 (V70): a YOLO event — section "yolo", a base entry of kind time (its own id excluded), a
    -- yearly date "MM-DD" or null, "when" {en, pl} or null.
    if coalesce(e ->> 'section', 'yolo') <> 'yolo' then return format('%s: section is "yolo" or null', e ->> 'id'); end if;
    if e ->> 'base' is not null and (e ->> 'base' = e ->> 'id' or not exists (
         select 1 from jsonb_array_elements(p) b where b ->> 'id' = e ->> 'base' and b ->> 'kind' = 'time' and b ->> 'base' is null)) then
      return format('%s: base is the id of another time entry without a base', e ->> 'id');
    end if;
    if e ->> 'date' is not null and (e ->> 'date' !~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$') then
      return format('%s: date is "MM-DD" or null', e ->> 'id');
    end if;
    if e -> 'when' is not null and jsonb_typeof(e -> 'when') <> 'null' and (jsonb_typeof(e -> 'when') <> 'object'
         or char_length(coalesce(e -> 'when' ->> 'en', '')) not between 1 and 24 or char_length(coalesce(e -> 'when' ->> 'pl', '')) not between 1 and 24) then
      return format('%s: when {en, pl}, 1-24 characters each', e ->> 'id');
    end if;
    if e ->> 'kind' = 'ride' then
      v_rides := v_rides + 1;
      if e ->> 'id' <> 'ride' then return 'the ride entry has the id "ride"'; end if;
    else
      d := e -> 'duration';
      if jsonb_typeof(d) <> 'object' or jsonb_typeof(d -> 'min') <> 'number' or jsonb_typeof(d -> 'max') <> 'number'
         or jsonb_typeof(d -> 'default') <> 'number' or jsonb_typeof(d -> 'step') <> 'number'
         or (d ->> 'step')::int not in (15, 30)
         or not (15 <= (d ->> 'min')::int and (d ->> 'min')::int <= (d ->> 'default')::int
                 and (d ->> 'default')::int <= (d ->> 'max')::int and (d ->> 'max')::int <= 1440)
         or ((d ->> 'default')::int - (d ->> 'min')::int) % (d ->> 'step')::int <> 0 then
        return format('%s: duration {default, min, max, step}: 15 ≤ min ≤ default ≤ max ≤ 1440, step 15 or 30', e ->> 'id');
      end if;
    end if;
  end loop;
  if v_rides <> 1 then return 'exactly one entry has kind "ride"'; end if;
  return null;
end $$;

-- Operator only (SQL editor): replaces the catalog. Entries are disabled, never deleted, so old
-- appointments still resolve their names.
create or replace function public.siosia_set_services(p_services jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_problem text := siosia_catalog_problem(p_services); v_missing text;
begin
  if v_problem is not null then raise exception 'Catalog not saved: %', v_problem; end if;
  select string_agg(o ->> 'id', ', ') into v_missing
    from app_config c, jsonb_array_elements(coalesce(c.services, '[]'::jsonb)) o
   where c.id = 1 and not exists (select 1 from jsonb_array_elements(p_services) n where n ->> 'id' = o ->> 'id');
  if v_missing is not null then
    raise exception 'Catalog not saved: keep every entry (set "enabled": false instead of removing): %', v_missing;
  end if;
  update app_config set services = p_services where id = 1;
  return format('Catalog saved: %s entries.', jsonb_array_length(p_services));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.0: appointments — internal machinery
-- ---------------------------------------------------------------------------------------------

-- Queue an appointment notification for a user who turned them on: in their language, with the
-- service named in that language, tagged with the appointment (§8, V18).
create or replace function public.siosia_push_appt(p_user uuid, p_kind text, p_appt uuid, p_params jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_lang text;
begin
  if p_user is null or not exists (select 1 from push_subscriptions where user_id = p_user)
     or not siosia_member_ok(p_user) then
    return;
  end if;
  v_lang := coalesce((select language from profiles where user_id = p_user), 'en');
  insert into push_outbox (user_id, kind, ride_id, appointment_id, params, lang, tz)
  values (p_user, p_kind, null, p_appt,
          coalesce(p_params, '{}'::jsonb)
            || case when p_params ? 'serviceId'
                    then jsonb_build_object('service', siosia_service_name(p_params ->> 'serviceId', v_lang))
                    else '{}'::jsonb end
            -- 2.3 (FR-202): the provider hears who comes ("with Zosia and Kuba"); the client knows their own kids.
            || case when exists (select 1 from appointments a join appointment_kids ak on ak.appointment_id = a.id
                                  where a.id = p_appt and a.provider_id = p_user)
                    then jsonb_build_object('kids', siosia_kid_names(p_appt)) else '{}'::jsonb end,
          v_lang, coalesce((select timezone from app_config where id = 1), 'Europe/Warsaw'));
  perform siosia_kick_push();
end $$;

-- What every appointment notification names: the service, the range, both parties, the place.
create or replace function public.siosia_appt_params(a public.appointments)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'serviceId', a.service_id, 'at', a.starts_at, 'end', a.starts_at + make_interval(mins => a.duration_min),
    'client', siosia_nick(a.client_id), 'provider', siosia_nick(a.provider_id), 'place', coalesce(a.place_label, ''));
$$;

-- A series' rule for "{range}": every Tue 16:00–17:00, 28 Oct – 16 Dec (8×).
create or replace function public.siosia_series_params(p_series uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('rule', s.rule, 'count', s.count, 'first', s.first_start, 'last', s.until)
                     from appointment_series s where s.id = p_series), '{}'::jsonb);
$$;

-- Attached rides in the words of reminders and P1 (V8): [{leg, status, driver}].
create or replace function public.siosia_ride_lines(p_appt uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('leg', x ->> 'leg', 'status', x ->> 'status', 'driver', x -> 'driver' ->> 'nickname')
                            order by x ->> 'scheduledFor'), '[]'::jsonb)
    from jsonb_array_elements(siosia_attached_json(p_appt, null, (select client_id from appointments where id = p_appt))) x;
$$;

-- A reminder for one party (V7, V8): lead slot, the other party, the status words, the ride lines.
-- An open request (2.1, V37) has only its client, still waiting for someone to take it: "open".
create or replace function public.siosia_reminder_params(a public.appointments, p_slot int, p_role text)
returns jsonb language sql stable security definer set search_path = public as $$
  select siosia_appt_params(a) || jsonb_build_object(
    'lead', p_slot, 'role', p_role,
    'other', siosia_nick(case when p_role = 'client' then a.provider_id else a.client_id end),
    'status', case when a.status = 'accepted' then 'confirmed' when a.provider_id is null then 'open'
                   when p_role = 'client' then 'waiting' else 'answer' end,
    'rides', siosia_ride_lines(a.id));
$$;

-- The provider is busy then: an accepted appointment or a booked ride taken as driver overlaps.
create or replace function public.siosia_provider_busy(p_user uuid, p_start timestamptz, p_min int, p_except uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from appointments x
                  where x.provider_id = p_user and x.status = 'accepted' and x.id <> p_except
                    and x.starts_at < p_start + make_interval(mins => p_min)
                    and p_start < x.starts_at + make_interval(mins => x.duration_min))
      or exists (select 1 from rides r
                  where r.driver_id = p_user and r.scheduled_for is not null
                    and r.status in ('scheduled', 'accepted', 'arrived', 'in_progress')
                    and r.scheduled_for < p_start + make_interval(mins => p_min)
                    and p_start < r.scheduled_for + make_interval(mins => greatest(r.est_min, 1)));
$$;

-- Cancelling appointments cancels their rides that are not under way yet (V10): drivers who took
-- one hear "Booking cancelled"; a ride already in progress finishes as a normal ride.
create or replace function public.siosia_cascade_rides(p_appts uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare r rides;
begin
  for r in select * from rides where appointment_id = any (p_appts)
             and status in ('scheduled', 'requested', 'accepted', 'arrived') for update loop
    if r.driver_id is not null then
      perform siosia_push(r.driver_id, 'booking_cancelled', r.id,
                          jsonb_build_object('at', r.scheduled_for, 'pickup', r.pickup_label));
    end if;
    perform siosia_end_ride(r.id, 'cancelled', 'system', 'appointment_cancelled',
                            array['scheduled', 'requested', 'accepted', 'arrived']);
  end loop;
end $$;

-- A booked ride for p_uid (v1 rules: lead, horizon, open bookings, fare frozen), optionally as
-- part of an appointment (V9): the passenger is a party, the appointment is accepted, the leg is
-- free, "there" before the start and "back" at or after it. Template bookings (series) do not
-- count against the daily limit. No caller checks here: the API wrappers and the sweep call it.
create or replace function public.siosia_book_for(p_uid uuid, p_pickup jsonb, p_dropoff jsonb, p_est_km float8, p_est_min float8,
                                                  p_fare_is_estimate boolean, p_scheduled_for timestamptz,
                                                  p_appointment uuid, p_leg text, p_template boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c app_config; r rides; a appointments;
  plat float8; plng float8; dlat float8; dlng float8; v_km float8; v_min float8; v_fixed numeric;
begin
  if siosia_master_role(p_uid) = 'driver' then return siosia_err('driver_only'); end if;
  begin
    plat := (p_pickup ->> 'lat')::float8;  plng := (p_pickup ->> 'lng')::float8;
    dlat := (p_dropoff ->> 'lat')::float8; dlng := (p_dropoff ->> 'lng')::float8;
  exception when others then return siosia_err('bad_input');
  end;
  if plat is null or plng is null or dlat is null or dlng is null
     or abs(plat) > 90 or abs(dlat) > 90 or abs(plng) > 180 or abs(dlng) > 180
     or p_est_km is null or p_est_min is null or p_est_km <= 0 or p_est_min < 0
     -- a day at most: a bigger one overflows est_min / the fare and, from a series template,
     -- would fail every sweep (NaN counts as bigger)
     or p_est_min > 1440 or p_est_km = 'Infinity'::float8 then
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
  if p_appointment is not null then
    select * into a from appointments where id = p_appointment and (client_id = p_uid or provider_id = p_uid);
    if a.id is null then return siosia_err('not_found'); end if;
    if a.status <> 'accepted' then return siosia_err('not_accepted'); end if;
    if p_leg is null or p_leg not in ('there', 'back') then return siosia_err('bad_leg'); end if;
    if (p_leg = 'there' and p_scheduled_for >= a.starts_at) or (p_leg = 'back' and p_scheduled_for < a.starts_at) then
      return siosia_err('bad_time');
    end if;
    if exists (select 1 from rides where appointment_id = a.id and rider_id = p_uid and leg = p_leg
               and status not in ('cancelled', 'expired')) then
      return siosia_err('ride_exists');
    end if;
  elsif p_leg is not null then
    return siosia_err('bad_leg');
  end if;
  -- At most booking_max_open open, and 10 new bookings a day (each one notifies drivers);
  -- bookings a series template makes on its own do not count against the daily limit.
  if (select count(*) from rides where rider_id = p_uid and status = 'scheduled') >= c.booking_max_open
     or (not coalesce(p_template, false)
         and (select count(*) from rides where rider_id = p_uid and scheduled_for is not null and not auto_booked
              and requested_at > now() - interval '1 day') >= 10) then
    return siosia_err('too_many');
  end if;
  v_fixed := case when (siosia_master_of(p_uid)).role = 'rider' then (siosia_master_of(p_uid)).fixed_fare end;
  insert into rides (rider_id, status, scheduled_for, dispatch_started_at, pickup_lat, pickup_lng, pickup_label,
                     dropoff_lat, dropoff_lng, dropoff_label, est_km, est_min, fare, currency, fare_is_estimate,
                     appointment_id, leg, auto_booked)
  values (p_uid, 'scheduled', p_scheduled_for, p_scheduled_for,
          plat, plng, left(btrim(coalesce(p_pickup ->> 'label', '')), 120),
          dlat, dlng, left(btrim(coalesce(p_dropoff ->> 'label', '')), 120),
          round(v_km::numeric, 1), round(v_min)::int,
          coalesce(v_fixed, siosia_fare(v_km::numeric, v_min::numeric)), c.currency,
          v_fixed is null and coalesce(p_fare_is_estimate, false),
          p_appointment, case when p_appointment is null then null else p_leg end, coalesce(p_template, false))
  returning * into r;
  -- Everyone who can take it and turned notifications on hears about it.
  insert into push_outbox (user_id, kind, ride_id, params, lang, tz)
  select distinct s.user_id, 'booking_new', r.id,
         jsonb_build_object('at', r.scheduled_for, 'pickup', r.pickup_label, 'dropoff', r.dropoff_label),
         p.language, c.timezone
    from push_subscriptions s
    join vehicles v on v.user_id = s.user_id
    join profiles p on p.user_id = s.user_id and not p.deleted
   where s.user_id <> p_uid and siosia_master_role(s.user_id) is distinct from 'rider' and siosia_member_ok(s.user_id)
     and siosia_same_realm(p_uid, s.user_id);
  perform siosia_kick_push();
  -- The other party hears that a ride was added (a series template tells once, when it is set).
  if a.id is not null and not coalesce(p_template, false) then
    perform siosia_push_appt(case when a.client_id = p_uid then a.provider_id else a.client_id end, 'appt_ride_added', a.id,
                             siosia_appt_params(a) || jsonb_build_object('leg', p_leg, 'time', r.scheduled_for, 'who', siosia_nick(p_uid)));
  end if;
  return siosia_ok(siosia_ride_json(r, p_uid));
exception when unique_violation then
  return siosia_err('ride_exists');
end $$;

-- Bookings from a series' ride templates (V26): every accepted future occurrence whose pickup time
-- is within the booking horizon gets its booking once; a ride its passenger removed stays removed.
create or replace function public.siosia_materialize_templates(p_series uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s appointment_series; t jsonb; a appointments; v_user uuid; v_at timestamptz; c app_config;
begin
  select * into c from app_config where id = 1;
  select * into s from appointment_series where id = p_series;
  if s.id is null then return; end if;
  for t in select value from jsonb_array_elements(case when jsonb_typeof(s.ride_templates) = 'array'
                                                      then s.ride_templates else '[]'::jsonb end) loop
    v_user := case when t ->> 'passenger' = 'client' then s.client_id else s.provider_id end;
    for a in select * from appointments where series_id = s.id and status = 'accepted' and starts_at > now() order by starts_at loop
      begin
        v_at := case when t ->> 'leg' = 'there' then a.starts_at else a.starts_at + make_interval(mins => a.duration_min) end
                + make_interval(mins => (t ->> 'offsetMin')::int);
        continue when v_at < now() + make_interval(mins => c.booking_min_lead_min)
                   or v_at > now() + make_interval(days => c.booking_max_days);
        continue when exists (select 1 from rides where appointment_id = a.id and rider_id = v_user and leg = t ->> 'leg');
        perform siosia_book_for(v_user, t -> 'pickup', t -> 'dropoff', (t ->> 'estKm')::float8, (t ->> 'estMin')::float8,
                                coalesce((t ->> 'fareIsEstimate')::boolean, false), v_at, a.id, t ->> 'leg', true);
      exception when others then
        -- A bad template (or booking) must never stop the sweep, which runs inside every API call.
        raise warning 'siosia_materialize_templates: series % occurrence % skipped: %', s.id, a.id, sqlerrm;
      end;
    end loop;
  end loop;
  update appointment_series set templates_at = now() where id = s.id;
end $$;

-- Appointments of the sweep (before the v1 steps, under the same lock): unanswered series and
-- requests expire at their (first) start, accepted ones are done at their end, reminders go out
-- once per party and slot (marked in the same statement), template rides enter the horizon daily.
create or replace function public.siosia_sweep_appointments()
returns void language plpgsql security definer set search_path = public as $$
declare a appointments; s appointment_series; c app_config; v_slot int; v_max int;
begin
  select * into c from app_config where id = 1;
  -- Every row below is handled in its own block: one bad row is skipped with a warning and never
  -- fails the sweep, which runs inside every API call (and every 10 s from pg_cron).
  -- An unanswered series expires as a whole when its first occurrence starts (one notification).
  for s in select * from appointment_series where status = 'requested' and first_start <= now() for update skip locked loop
    begin
      update appointments set status = 'expired', ended_at = now() where series_id = s.id and status = 'requested';
      update appointment_series set status = 'expired' where id = s.id;
      select * into a from appointments where series_id = s.id order by seq limit 1;
      -- An open series nobody took (2.1, V37): the client is told "nobody took it".
      perform siosia_push_appt(s.client_id, 'appt_expired', a.id, siosia_appt_params(a) || siosia_series_params(s.id)
                               || case when s.provider_id is null then '{"open": true}'::jsonb else '{}'::jsonb end);
    exception when others then
      raise warning 'siosia_sweep_appointments: series % skipped: %', s.id, sqlerrm;
    end;
  end loop;
  -- A request unanswered at its start expires; the client is told.
  for a in select * from appointments where status = 'requested' and series_id is null and starts_at <= now()
           for update skip locked loop
    begin
      update appointments set status = 'expired', ended_at = now() where id = a.id;
      perform siosia_push_appt(a.client_id, 'appt_expired', a.id, siosia_appt_params(a)
                               || case when a.provider_id is null then '{"open": true}'::jsonb else '{}'::jsonb end);
    exception when others then
      raise warning 'siosia_sweep_appointments: appointment % skipped: %', a.id, sqlerrm;
    end;
  end loop;
  -- An accepted appointment is done at its end ("in progress" is derived, never stored); 2.6
  -- (FR-271): with a price, its summary goes out once.
  for a in update appointments set status = 'done', ended_at = starts_at + make_interval(mins => duration_min)
            where status = 'accepted' and starts_at + make_interval(mins => duration_min) <= now() returning * loop
    begin
      perform siosia_announce_cost(a, false);
    exception when others then
      raise warning 'siosia_sweep_appointments: summary of % skipped: %', a.id, sqlerrm;
    end;
  end loop;
  -- Reminders: once per slot for both parties (an open request: its client only, V37); none for a
  -- moment that had passed at the request.
  select coalesce(max(x), 0) into v_max from unnest(c.appt_reminder_min) x;
  for a in select * from appointments where status in ('requested', 'accepted') and starts_at > now()
             and starts_at <= now() + make_interval(mins => v_max) for update skip locked loop
    begin
      foreach v_slot in array c.appt_reminder_min loop
        if now() >= a.starts_at - make_interval(mins => v_slot) and a.requested_at <= a.starts_at - make_interval(mins => v_slot)
           and not (v_slot = any (a.reminded)) then
          update appointments set reminded = reminded || v_slot where id = a.id and not (v_slot = any (reminded));
          if found then
            perform siosia_push_appt(a.client_id, 'appt_reminder', a.id, siosia_reminder_params(a, v_slot, 'client'));
            if a.provider_id is not null then
              perform siosia_push_appt(a.provider_id, 'appt_reminder', a.id, siosia_reminder_params(a, v_slot, 'provider'));
            end if;
          end if;
        end if;
      end loop;
    exception when others then
      raise warning 'siosia_sweep_appointments: reminders of % skipped: %', a.id, sqlerrm;
    end;
  end loop;
  -- Series rides: occurrences that came within the booking horizon (once a day per series).
  for s in select * from appointment_series where status = 'answered' and ride_templates <> '[]'::jsonb
             and (templates_at is null or templates_at < now() - interval '1 day') for update skip locked loop
    begin
      perform siosia_materialize_templates(s.id);
    exception when others then
      raise warning 'siosia_sweep_appointments: templates of series % skipped: %', s.id, sqlerrm;
      -- Still counts as this day's run, so a broken series is not retried on every call.
      update appointment_series set templates_at = now() where id = s.id;
    end;
  end loop;
end $$;

-- Every member with a profile refetches (2.1: an open request is on everyone's list).
create or replace function public.siosia_notify_members()
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  for u in select user_id from profiles where not deleted loop
    perform siosia_notify(u.user_id);
  end loop;
end $$;

-- Realtime: any change of an appointment tells both parties to refetch (no new channels). An open
-- request that appears, is taken or ends (withdrawn, expired, its client gone) changes every
-- member's list and badge (V36); siosia_send keeps it to one message per member and transaction.
create or replace function public.siosia_appointments_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 2.6 (FR-256): the families of both parties refetch too.
  perform siosia_notify_household(new.client_id);
  perform siosia_notify_household(new.provider_id);
  if (tg_op = 'INSERT' and new.provider_id is null)
     or (tg_op = 'UPDATE' and old.provider_id is null
         and (new.provider_id is not null or new.status is distinct from old.status)) then
    perform siosia_notify_members();
  end if;
  return null;
end $$;

drop trigger if exists siosia_appointments_notify on public.appointments;
create trigger siosia_appointments_notify after insert or update on public.appointments
  for each row execute function public.siosia_appointments_trigger();

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.0: client API — catalog, requests, answers, cancellations, rides, schedule, history
-- ---------------------------------------------------------------------------------------------

-- The enabled catalog with who offers each "time" entry (public ids, never user ids), without the caller.
create or replace function public.siosia_catalog()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(false); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(coalesce((
    select jsonb_agg(x.e || jsonb_build_object('providers',
             case when x.e ->> 'kind' <> 'time' then '[]'::jsonb else coalesce((
               -- 2.3 (FR-211): a provider's photo is shown in the catalog
               -- 2.6 (FR-262): with the viewer's family's contract rate for this entry
               select jsonb_agg(siosia_public_party(p.user_id, true)
                                || jsonb_build_object('contractRate', (select r.per_hour from siosia_contract_rate(v_uid, p.user_id, x.e ->> 'id') r))
                                order by p.nickname)
                 from profiles p
                where not p.deleted and p.user_id <> v_uid
                  -- 2.8 (V68, V70): who offers it (or its base), or has a contract for it with my family
                  and (siosia_offers_service(p.user_id, x.e ->> 'id')
                       or exists (select 1 from siosia_contract_rate(v_uid, p.user_id, x.e ->> 'id')))
                  and siosia_member_ok(p.user_id) and siosia_same_realm(v_uid, p.user_id)
                  and siosia_listed(p.user_id, v_uid)), '[]'::jsonb) end)
           order by x.ord)
      from app_config c, jsonb_array_elements(coalesce(c.services, '[]'::jsonb)) with ordinality as x(e, ord)
     where c.id = 1 and coalesce((x.e ->> 'enabled')::boolean, false)), '[]'::jsonb));
end $$;

-- Send request (V3, V4, V23): one provider, a time entry they offer, start and duration within the
-- rules, a place unless the entry allows none; optionally repeating weekly / every 2 weeks.
-- 2.1 (FR-160, V34): no provider (p_provider null) = an open request to anyone in the group —
-- every other rule and limit the same, only the checks of a provider skipped.
-- 2.3 (FR-201): p_kids = the client's own kids to attach, to every occurrence of a series (the
-- 2.0 signature below passes none; cached apps keep working).
create or replace function public.siosia_request_service(p_service text, p_provider text, p_starts_at timestamptz,
                                                         p_duration int, p_place jsonb, p_note text, p_repeat jsonb,
                                                         p_kids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text := siosia_guard(true); v_uid uuid := auth.uid(); c app_config; e jsonb; d jsonb; v_prov uuid; v_kids uuid[];
  v_note text := btrim(coalesce(p_note, '')); v_price numeric; v_rate numeric; v_contract uuid; v_every int; v_count int; v_until timestamptz;
  v_starts timestamptz[] := '{}'; v_t timestamptz; k int; s appointment_series; a appointments; v_first appointments;
  v_place jsonb := case when p_place is null or jsonb_typeof(p_place) = 'null' then null else p_place end; u record;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  select * into c from app_config where id = 1;
  e := siosia_service(p_service);
  if e is null or e ->> 'kind' <> 'time' or not coalesce((e ->> 'enabled')::boolean, false) then
    return siosia_err('bad_service');
  end if;
  if p_provider is not null then
    select user_id into v_prov from profiles where public_id = p_provider and not deleted;
    if v_prov is null or v_prov = v_uid or not siosia_member_ok(v_prov) or not siosia_same_realm(v_uid, v_prov) then
      return siosia_err('no_provider');
    end if;
    -- 2.8 (V68, V70): offered (itself or its base), or on a contract between my family and them.
    if not siosia_offers_service(v_prov, p_service) and not exists (select 1 from siosia_contract_rate(v_uid, v_prov, p_service)) then
      return siosia_err('not_offered');
    end if;
  end if;
  if p_starts_at is null or p_starts_at < now() + make_interval(mins => c.booking_min_lead_min)
     or p_starts_at > now() + make_interval(days => c.booking_max_days) then
    return siosia_err('bad_time');
  end if;
  d := e -> 'duration';
  if p_duration is null or p_duration < (d ->> 'min')::int or p_duration > (d ->> 'max')::int
     or (p_duration - (d ->> 'min')::int) % (d ->> 'step')::int <> 0 then
    return siosia_err('bad_duration');
  end if;
  if (v_place is null and coalesce((e ->> 'needsPlace')::boolean, true))
     or (v_place is not null and (not siosia_valid_place(v_place) or v_place -> 'lat' is null))
     or char_length(v_note) > 200 then
    return siosia_err('bad_input');
  end if;
  -- The kids to attach are the caller's own, each once (bad_input otherwise); none = an empty list.
  v_kids := siosia_own_kids(v_uid, p_kids);
  if v_kids is null then return siosia_err('bad_input'); end if;
  v_price := case when jsonb_typeof(e -> 'price' -> 'perHour') = 'number'
                    then round((e -> 'price' ->> 'perHour')::numeric * p_duration / 60, 2)
                  when jsonb_typeof(e -> 'price' -> 'fixed') = 'number' then (e -> 'price' ->> 'fixed')::numeric end;
  -- 2.6 (FR-262, V62): an active contract between my family and the provider sets the rate.
  select r.contract_id, r.per_hour into v_contract, v_rate from siosia_contract_rate(v_uid, v_prov, p_service) r;
  if v_contract is not null then
    v_price := round(v_rate * p_duration / 60.0, 2);
  else
    v_rate := case when jsonb_typeof(e -> 'price' -> 'perHour') = 'number' then (e -> 'price' ->> 'perHour')::numeric end;
  end if;
  -- The occurrences: one, or a weekly / every-2-weeks series (2…seriesMaxCount, within seriesMaxDays).
  if p_repeat is null or jsonb_typeof(p_repeat) = 'null' then
    v_starts := array[p_starts_at];
  else
    v_every := case when p_repeat ->> 'every' in ('1', '2') then (p_repeat ->> 'every')::int end;
    if v_every is null then return siosia_err('bad_repeat'); end if;
    if jsonb_typeof(p_repeat -> 'count') = 'number' then
      v_count := (p_repeat ->> 'count')::int;
      if v_count not between 2 and c.appt_series_max_count then return siosia_err('bad_repeat'); end if;
      for k in 0 .. v_count - 1 loop
        v_starts := v_starts || siosia_add_weeks(p_starts_at, k * v_every, c.timezone);
      end loop;
    elsif jsonb_typeof(p_repeat -> 'until') = 'number' then
      v_until := to_timestamp((p_repeat ->> 'until')::float8 / 1000);
      k := 0;
      loop
        v_t := siosia_add_weeks(p_starts_at, k * v_every, c.timezone);
        exit when (v_t at time zone c.timezone)::date > (v_until at time zone c.timezone)::date
               or k > c.appt_series_max_count;
        v_starts := v_starts || v_t;
        k := k + 1;
      end loop;
      if cardinality(v_starts) not between 2 and c.appt_series_max_count then return siosia_err('bad_repeat'); end if;
    else
      return siosia_err('bad_repeat');
    end if;
    if v_starts[cardinality(v_starts)] > now() + make_interval(days => c.appt_series_max_days) then
      return siosia_err('bad_repeat');
    end if;
  end if;
  -- Limits: ≤ 10 open single appointments, ≤ 3 open series, ≤ 20 new a day (a series counts once).
  if cardinality(v_starts) = 1 then
    if (select count(*) from appointments where client_id = v_uid and series_id is null
          and status in ('requested', 'accepted') and starts_at > now()) >= 10 then
      return siosia_err('too_many');
    end if;
  elsif (select count(*) from appointment_series x where x.client_id = v_uid and x.status in ('requested', 'answered')
           and exists (select 1 from appointments y where y.series_id = x.id
                        and y.status in ('requested', 'accepted') and y.starts_at > now())) >= 3 then
    return siosia_err('too_many');
  end if;
  if (select count(*) from appointments where client_id = v_uid and series_id is null and requested_at > now() - interval '1 day')
     + (select count(*) from appointment_series where client_id = v_uid and requested_at > now() - interval '1 day') >= 20 then
    return siosia_err('too_many');
  end if;
  -- The place as siosia_clean_place keeps it: the label trimmed and cut to the columns' 120.
  if cardinality(v_starts) > 1 then
    insert into appointment_series (client_id, provider_id, service_id, rule, first_start, duration_min, count, until,
                                    place_lat, place_lng, place_label, note, price, currency)
    values (v_uid, v_prov, p_service, case when v_every = 1 then 'weekly' else 'biweekly' end, v_starts[1], p_duration,
            cardinality(v_starts), v_starts[cardinality(v_starts)],
            (v_place ->> 'lat')::float8, (v_place ->> 'lng')::float8, left(btrim(v_place ->> 'label'), 120),
            v_note, v_price, c.currency)
    returning * into s;
  end if;
  for k in 1 .. cardinality(v_starts) loop
    insert into appointments (client_id, provider_id, service_id, starts_at, duration_min, place_lat, place_lng, place_label,
                              note, price, currency, series_id, seq, rate, contract_id)
    values (v_uid, v_prov, p_service, v_starts[k], p_duration,
            (v_place ->> 'lat')::float8, (v_place ->> 'lng')::float8, left(btrim(v_place ->> 'label'), 120),
            v_note, v_price, c.currency, s.id, case when s.id is null then null else k end, v_rate, v_contract)
    returning * into a;
    insert into appointment_kids (appointment_id, kid_id) select a.id, x from unnest(v_kids) x;
    if k = 1 then v_first := a; end if;
  end loop;
  if v_prov is not null then
    perform siosia_push_appt(v_prov, 'appt_new', v_first.id, siosia_appt_params(v_first) || siosia_series_params(s.id));
  else
    -- Every other member hears of an open request once (V36), tagged with its (first) date; their
    -- lists change (siosia_appointments_trigger).
    for u in select user_id from profiles where not deleted and user_id <> v_uid and siosia_same_realm(v_uid, user_id) loop
      perform siosia_push_appt(u.user_id, 'appt_open', v_first.id,
                               siosia_appt_params(v_first) || siosia_series_params(s.id) || '{"open": true}'::jsonb);
    end loop;
  end if;
  return siosia_ok(siosia_appointment_json(v_first, v_uid));
end $$;

-- The 2.0 call (NFR-18: cached apps): the same request, no kids.
create or replace function public.siosia_request_service(p_service text, p_provider text, p_starts_at timestamptz,
                                                         p_duration int, p_place jsonb, p_note text, p_repeat jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return siosia_request_service(p_service, p_provider, p_starts_at, p_duration, p_place, p_note, p_repeat, null::uuid[]);
end $$;

-- The answer itself (V5, V24), for siosia_answer_appointment and siosia_take_request: only the
-- provider, only while requested (atomic). A series is answered as a whole: Accept takes every
-- occurrence that does not clash and declines the rest. Returns an error code, or null when done;
-- nothing is changed before an error.
create or replace function public.siosia_answer_as(p_uid uuid, p_id uuid, p_decision text)
returns text language plpgsql security definer set search_path = public as $$
declare a appointments; o appointments; v_declined timestamptz[] := '{}'; v_accepted int := 0;
begin
  select * into a from appointments where id = p_id and provider_id = p_uid;
  if a.id is null then return 'not_found'; end if;
  if a.status <> 'requested' then return 'illegal_transition'; end if;
  if a.series_id is null then
    if p_decision = 'accept' then
      if siosia_provider_busy(p_uid, a.starts_at, a.duration_min, a.id) then return 'overlap'; end if;
      update appointments set status = 'accepted', answered_at = now()
       where id = a.id and status = 'requested' and provider_id = p_uid;
      if not found then return 'illegal_transition'; end if;
      perform siosia_push_appt(a.client_id, 'appt_accepted', a.id, siosia_appt_params(a));
    else
      update appointments set status = 'declined', answered_at = now(), ended_at = now()
       where id = a.id and status = 'requested' and provider_id = p_uid;
      if not found then return 'illegal_transition'; end if;
      perform siosia_push_appt(a.client_id, 'appt_declined', a.id, siosia_appt_params(a));
    end if;
  else
    perform 1 from appointment_series where id = a.series_id for update;
    for o in select * from appointments where series_id = a.series_id and status = 'requested' order by seq for update loop
      if p_decision = 'accept' and not siosia_provider_busy(p_uid, o.starts_at, o.duration_min, o.id) then
        update appointments set status = 'accepted', answered_at = now() where id = o.id;
        v_accepted := v_accepted + 1;
      else
        update appointments set status = 'declined', answered_at = now(), ended_at = now() where id = o.id;
        if p_decision = 'accept' then v_declined := v_declined || o.starts_at; end if;
      end if;
    end loop;
    update appointment_series set status = 'answered', answered_at = now() where id = a.series_id;
    perform siosia_push_appt(a.client_id, case when v_accepted > 0 then 'appt_accepted' else 'appt_declined' end, a.id,
                             siosia_appt_params(a) || siosia_series_params(a.series_id)
                             || jsonb_build_object('accepted', v_accepted, 'declined', to_jsonb(v_declined)));
  end if;
  return null;
end $$;

-- Accept / Decline (V5, V24): the provider answers a request addressed to them.
create or replace function public.siosia_answer_appointment(p_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if p_decision is null or p_decision not in ('accept', 'decline') then return siosia_err('bad_input'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  v_err := siosia_answer_as(v_uid, p_id, p_decision);
  if v_err is not null then return siosia_err(v_err); end if;
  select * into a from appointments where id = p_id;
  return siosia_ok(siosia_appointment_json(a, v_uid));
end $$;

-- I can do it (2.1, FR-163, V35): the caller takes someone's open request — becomes its provider
-- and accepts it in one transaction. The claim is atomic (… WHERE provider_id IS NULL): the first
-- taker wins, the others get taken. A series is taken as a whole and answered like any series
-- (dates clashing with the taker's schedule declined) — unless every open date clashes (B6): then,
-- as for a single request that clashes, it fails with overlap and stays open, untouched (no claim,
-- no decline, nothing told). The client is told as for an accept; every member's list changes
-- (siosia_appointments_trigger), nothing more is pushed to them.
create or replace function public.siosia_take_request(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments; o appointments;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  select * into a from appointments where id = p_id;
  if a.id is null or not siosia_same_realm(v_uid, a.client_id) then return siosia_err('not_found'); end if;
  -- 2.6 (FR-254): my family's open request is ours, not one to take.
  if a.client_id = v_uid or siosia_same_family(v_uid, a.client_id) then return siosia_err('forbidden'); end if;
  if a.provider_id is not null then return siosia_err('taken'); end if;
  if a.status <> 'requested' or a.starts_at <= now() then return siosia_err('illegal_transition'); end if;
  -- Before the claim (twin of takeRequest): the caller is free for the request, or for at least
  -- one open date of the series — otherwise nothing is claimed, changed or told.
  if not exists (select 1 from appointments x
                  where (x.id = a.id or x.series_id = a.series_id)
                    and x.provider_id is null and x.status = 'requested'
                    and not siosia_provider_busy(v_uid, x.starts_at, x.duration_min, x.id)) then
    return siosia_err('overlap');
  end if;
  begin
    -- The claim locks the series row first, then its occurrences (the order of siosia_answer_as
    -- and siosia_cancel_appointment). A concurrent taker waits on the row, then finds it no longer open.
    if a.series_id is null then
      update appointments set provider_id = v_uid where id = a.id and provider_id is null and status = 'requested';
      o := a;
    else
      update appointment_series set provider_id = v_uid where id = a.series_id and provider_id is null and status = 'requested';
      if found then
        update appointments set provider_id = v_uid where series_id = a.series_id and provider_id is null and status = 'requested';
        -- A series row with no open date left: its claim is undone with this block.
        if not found then raise exception using errcode = 'P0001', message = 'illegal_transition'; end if;
        -- The Accept is for a date actually claimed: the one asked for may have been withdrawn meanwhile.
        select * into o from appointments
         where series_id = a.series_id and provider_id = v_uid and status = 'requested' order by seq limit 1;
      end if;
    end if;
    if not found then
      -- Lost to someone faster, or the client withdrew it meanwhile (nothing of ours to undo).
      select * into a from appointments where id = p_id;
      return siosia_err(case when a.provider_id is not null then 'taken' else 'illegal_transition' end);
    end if;
    v_err := siosia_answer_as(v_uid, o.id, 'accept');
    -- overlap (a single request): the claim is undone with this block, the request stays open.
    if v_err is not null then raise exception using errcode = 'P0001', message = v_err; end if;
    -- The second guard for a series (V35): had every open date come to clash since the check above
    -- (a withdrawal racing the claim), nothing was accepted — the claim, the declines and the
    -- notification are undone with this block and the series stays open.
    if a.series_id is not null and not exists (select 1 from appointments
                                                where series_id = a.series_id and provider_id = v_uid and status = 'accepted') then
      raise exception using errcode = 'P0001', message = 'overlap';
    end if;
  exception when raise_exception then
    return siosia_err(sqlerrm);
  end;
  -- 2.6 (FR-262): the taker's contract with the client's family reprices what was accepted.
  update appointments x set rate = r.per_hour, contract_id = r.contract_id, price = round(r.per_hour * x.duration_min / 60.0, 2)
    from siosia_contract_rate(a.client_id, v_uid, a.service_id) r
   where (x.id = a.id or x.series_id = a.series_id) and x.provider_id = v_uid and x.status = 'accepted';
  if a.series_id is not null then
    update appointment_series s set price = round(r.per_hour * s.duration_min / 60.0, 2)
      from siosia_contract_rate(a.client_id, v_uid, a.service_id) r where s.id = a.series_id;
  end if;
  -- The date asked for — or, when that one was withdrawn as the claim landed, the first date taken.
  select * into a from appointments where id = p_id;
  if a.provider_id is distinct from v_uid then select * into a from appointments where id = o.id; end if;
  return siosia_ok(siosia_appointment_json(a, v_uid));
end $$;

-- Cancel (FR-102, V25): the client may withdraw a request; either party may cancel an accepted
-- appointment before it starts. A series offers this one or all remaining (future) occurrences.
-- Rides follow (V10); the other party is told once; nothing is counted (decision Q11).
create or replace function public.siosia_cancel_appointment(p_id uuid, p_reason text, p_scope text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments; v_who text;
  v_ids uuid[]; v_from timestamptz; v_series boolean; v_sid uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  -- Locks in the order of siosia_take_request and siosia_answer_as — the series row first, then
  -- the occurrence — so a take of an open series and its client withdrawing it never deadlock.
  select series_id into v_sid from appointments where id = p_id and (client_id = v_uid or provider_id = v_uid);
  if v_sid is not null then perform 1 from appointment_series where id = v_sid for update; end if;
  select * into a from appointments where id = p_id and (client_id = v_uid or provider_id = v_uid) for update;
  if a.id is null then return siosia_err('not_found'); end if;
  v_who := case when a.client_id = v_uid then 'client' else 'provider' end;
  v_series := coalesce(p_scope, 'one') = 'series' and a.series_id is not null;
  if v_series then
    select array_agg(id order by starts_at), min(starts_at) into v_ids, v_from from appointments
     where series_id = a.series_id and starts_at > now()
       and (status = 'accepted' or (status = 'requested' and v_who = 'client'));
    if v_ids is null then return siosia_err('illegal_transition'); end if;
  else
    if now() >= a.starts_at or not (a.status = 'accepted' or (a.status = 'requested' and v_who = 'client')) then
      return siosia_err('illegal_transition');
    end if;
    v_ids := array[a.id];
    v_from := a.starts_at;
  end if;
  update appointments set status = 'cancelled', ended_at = now(), cancelled_by = v_who,
                          cancel_reason = nullif(left(btrim(coalesce(p_reason, '')), 60), '')
   where id = any (v_ids) and status in ('requested', 'accepted');
  perform siosia_cascade_rides(v_ids);
  if a.series_id is not null and not exists (select 1 from appointments where series_id = a.series_id
                                               and status in ('requested', 'accepted') and starts_at > now()) then
    update appointment_series set status = 'cancelled' where id = a.series_id and status in ('requested', 'answered');
  end if;
  perform siosia_push_appt(case when v_who = 'client' then a.provider_id else a.client_id end, 'appt_cancelled', a.id,
                           siosia_appt_params(a) || jsonb_build_object('who', siosia_nick(v_uid))
                           || case when v_series then jsonb_build_object('from', v_from, 'left', cardinality(v_ids))
                                   else '{}'::jsonb end);
  return siosia_ok('true'::jsonb);
end $$;

-- A booked ride, now also as part of an appointment (new overload; the v1 signature stays).
create or replace function public.siosia_book_ride(p_pickup jsonb, p_dropoff jsonb, p_est_km float8, p_est_min float8,
                                                   p_fare_is_estimate boolean, p_scheduled_for timestamptz,
                                                   p_appointment uuid, p_leg text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  return siosia_book_for(v_uid, p_pickup, p_dropoff, p_est_km, p_est_min, p_fare_is_estimate, p_scheduled_for,
                         p_appointment, p_leg, false);
end $$;

-- A series ride template (V26): the caller is the passenger; one template per passenger and leg.
-- offsetMin: from the start for "there" (negative), from the end for "back". Bookings within the
-- horizon are made at once; the sweep adds the rest daily.
create or replace function public.siosia_set_ride_template(p_series uuid, p_template jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); s appointment_series; a appointments;
  v_role text; v_leg text := p_template ->> 'leg'; v_off int; t jsonb; c app_config; v_same boolean;
  v_km numeric; v_min numeric;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if siosia_master_role(v_uid) = 'driver' then return siosia_err('driver_only'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  select * into s from appointment_series where id = p_series and (client_id = v_uid or provider_id = v_uid) for update;
  if s.id is null then return siosia_err('not_found'); end if;
  if s.status <> 'answered' or not exists (select 1 from appointments where series_id = s.id and status = 'accepted') then
    return siosia_err('not_accepted');
  end if;
  if v_leg is null or v_leg not in ('there', 'back') then return siosia_err('bad_leg'); end if;
  -- Null-safe: a missing field is a bad template, never a pass (null <> 'number' is not true).
  if jsonb_typeof(p_template -> 'offsetMin') is distinct from 'number' or jsonb_typeof(p_template -> 'estKm') is distinct from 'number'
     or jsonb_typeof(p_template -> 'estMin') is distinct from 'number'
     or jsonb_typeof(p_template -> 'pickup') is distinct from 'object' or jsonb_typeof(p_template -> 'dropoff') is distinct from 'object'
     or not siosia_valid_place(p_template -> 'pickup') or not siosia_valid_place(p_template -> 'dropoff') then
    return siosia_err('bad_input');
  end if;
  -- Bounded like a booking (siosia_book_for): what the sweep books later must never overflow
  -- there. All in numeric (max_trip_km too), so no number however huge or tiny fails a cast: the
  -- estimates are kept to 3 decimals (round3 in the engine) and a trip that rounds to 0 km is none.
  select * into c from app_config where id = 1;
  v_km := (p_template ->> 'estKm')::numeric;
  v_min := (p_template ->> 'estMin')::numeric;
  if round(v_km, 3) <= 0 or v_min < 0 or v_min > 1440 then return siosia_err('bad_input'); end if;
  -- Over the longest trip is too far, as for a booking (not a bad template).
  if v_km > c.max_trip_km::numeric then return siosia_err('too_far'); end if;
  if abs((p_template ->> 'offsetMin')::numeric) > 1440 then return siosia_err('bad_time'); end if;
  -- Whole minutes, cut toward 0 like Math.trunc (a text cast to int refuses -30.5).
  v_off := trunc((p_template ->> 'offsetMin')::numeric)::int;
  if (v_leg = 'there' and v_off not between -1440 and -1) or (v_leg = 'back' and v_off not between -s.duration_min and 1440) then
    return siosia_err('bad_time');
  end if;
  v_role := case when s.client_id = v_uid then 'client' else 'provider' end;
  -- Stored clean (only the known keys, places as siosia_save_home keeps them), never the caller's JSON.
  t := jsonb_build_object('passenger', v_role, 'leg', v_leg,
                          'pickup', siosia_clean_place(p_template -> 'pickup'), 'dropoff', siosia_clean_place(p_template -> 'dropoff'),
                          'offsetMin', v_off, 'estKm', round(v_km, 3)::float8, 'estMin', round(v_min, 3)::float8,
                          'fareIsEstimate', coalesce(p_template -> 'fareIsEstimate' = 'true'::jsonb, false));
  -- The same template again changes nothing and tells nobody (a party cannot flood the other).
  -- (case, not and: only a list is read as one, whatever the planner does)
  v_same := case when jsonb_typeof(s.ride_templates) = 'array'
                 then exists (select 1 from jsonb_array_elements(s.ride_templates) x
                               where x ->> 'passenger' = v_role and x ->> 'leg' = v_leg and x = t)
                 else false end;
  if not v_same then
    update appointment_series
       set ride_templates = coalesce((select jsonb_agg(x)
                                        from jsonb_array_elements(case when jsonb_typeof(ride_templates) = 'array'
                                                                       then ride_templates else '[]'::jsonb end) x
                                       where not (x ->> 'passenger' = v_role and x ->> 'leg' = v_leg)), '[]'::jsonb) || t
     where id = s.id;
  end if;
  perform siosia_materialize_templates(s.id);
  select * into a from appointments where series_id = s.id and status in ('requested', 'accepted') and starts_at > now()
   order by starts_at limit 1;
  if a.id is null then select * into a from appointments where series_id = s.id order by seq desc limit 1; end if;
  if not v_same then
    perform siosia_push_appt(case when v_role = 'client' then s.provider_id else s.client_id end, 'appt_ride_added', a.id,
                             siosia_appt_params(a) || siosia_series_params(s.id)
                             || jsonb_build_object('leg', v_leg, 'who', siosia_nick(v_uid), 'repeat', true));
  end if;
  return siosia_ok(siosia_appointment_json(a, v_uid));
end $$;

-- No more rides for this series (the caller's template for a leg); existing bookings stay.
create or replace function public.siosia_drop_ride_template(p_series uuid, p_leg text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); s appointment_series; v_role text;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  select * into s from appointment_series where id = p_series and (client_id = v_uid or provider_id = v_uid) for update;
  if s.id is null then return siosia_err('not_found'); end if;
  v_role := case when s.client_id = v_uid then 'client' else 'provider' end;
  update appointment_series
     set ride_templates = coalesce((select jsonb_agg(x)
                                      from jsonb_array_elements(case when jsonb_typeof(ride_templates) = 'array'
                                                                     then ride_templates else '[]'::jsonb end) x
                                     where not (x ->> 'passenger' = v_role and x ->> 'leg' = p_leg)), '[]'::jsonb)
   where id = s.id;
  perform siosia_notify(s.client_id);
  perform siosia_notify(s.provider_id);
  return siosia_ok('true'::jsonb);
end $$;

-- Planned (V17): everything upcoming in both roles — appointments (requested / accepted, until
-- their end; my open requests among them) and rides (booked as rider, taken as driver, the active
-- one) — and (2.1, FR-161) the open requests of others I could take.
create or replace function public.siosia_planned()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(false); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  return siosia_ok(jsonb_build_object(
    'appointments', coalesce((select jsonb_agg(siosia_appointment_json(a, v_uid) order by a.starts_at)
                                from appointments a
                               where siosia_sees(v_uid, a) and a.status in ('requested', 'accepted')
                                 and a.starts_at + make_interval(mins => a.duration_min) > now()), '[]'::jsonb),
    'rides', coalesce((select jsonb_agg(siosia_ride_json(x, v_uid) order by coalesce(x.scheduled_for, x.requested_at))
                         from rides x
                        where (x.rider_id = v_uid or x.driver_id = v_uid)
                          and x.status in ('scheduled', 'requested', 'accepted', 'arrived', 'in_progress')), '[]'::jsonb),
    'open', siosia_open_requests(v_uid)));
end $$;

-- History (FR-133): finished appointments and rides of both roles, the last 50 of each, newest first.
create or replace function public.siosia_timeline()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(false); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(coalesce((
    select jsonb_agg(item order by at desc) from (
      select a.starts_at as at, jsonb_build_object('kind', 'appointment', 'at', siosia_ms(a.starts_at),
                                                   'appointment', siosia_appointment_json(a, v_uid)) as item
        from (select * from appointments x
               where siosia_sees(v_uid, x) and x.status in ('done', 'declined', 'cancelled', 'expired')
               order by x.starts_at desc limit 50) a
      union all
      select coalesce(x.scheduled_for, x.requested_at), jsonb_build_object('kind', 'ride',
               'at', siosia_ms(coalesce(x.scheduled_for, x.requested_at)), 'ride', siosia_ride_json(x, v_uid))
        from (select * from rides
               where (rider_id = v_uid or driver_id = v_uid) and status in ('completed', 'cancelled', 'expired')
               order by coalesce(scheduled_for, requested_at) desc limit 50) x
    ) t), '[]'::jsonb));
end $$;

-- Services I offer (FR-093): enabled "time" entries only; a master profile's preset cannot change here.
create or replace function public.siosia_set_offers(p_ids text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_id text;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if exists (select 1 from profiles where user_id = v_uid and master_id is not null) then return siosia_err('forbidden'); end if;
  foreach v_id in array coalesce(p_ids, '{}'::text[]) loop
    if siosia_service(v_id) is null or siosia_service(v_id) ->> 'kind' <> 'time'
       or not coalesce((siosia_service(v_id) ->> 'enabled')::boolean, false) then
      return siosia_err('bad_service');
    end if;
  end loop;
  update profiles set offers = (select coalesce(array_agg(distinct x), '{}'::text[]) from unnest(coalesce(p_ids, '{}'::text[])) x)
   where user_id = v_uid;
  perform siosia_notify(v_uid);
  return siosia_ok(siosia_profile_json(v_uid));
end $$;

-- My place (FR-140): the default appointment place and ride pickup; null clears it.
create or replace function public.siosia_save_home(p_place jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_place jsonb := case when p_place is null or jsonb_typeof(p_place) = 'null' then null else p_place end;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if v_place is not null and (not siosia_valid_place(v_place) or v_place -> 'lat' is null) then return siosia_err('bad_input'); end if;
  update profiles set home = case when v_place is null then null else siosia_clean_place(v_place) end
   where user_id = auth.uid();
  return siosia_ok(siosia_profile_json(auth.uid()));
end $$;

-- Rate a done appointment once within 24 h (FR-106); feeds the same rating summary as rides.
create or replace function public.siosia_rate_appointment(p_id uuid, p_stars int, p_comment text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into a from appointments where id = p_id and (client_id = v_uid or provider_id = v_uid);
  if a.id is null then return siosia_err('not_found'); end if;
  if a.status <> 'done' then return siosia_err('illegal_transition'); end if;
  if now() > coalesce(a.ended_at, a.starts_at + make_interval(mins => a.duration_min)) + interval '24 hours' then
    return siosia_err('window_closed');
  end if;
  if p_stars is null or p_stars not between 1 and 5 then return siosia_err('bad_input'); end if;
  insert into ratings (appointment_id, from_user, to_user, stars, comment)
  values (a.id, v_uid, case when a.client_id = v_uid then a.provider_id else a.client_id end, p_stars,
          left(btrim(coalesce(p_comment, '')), 140));
  perform siosia_notify(a.client_id);
  perform siosia_notify(a.provider_id);
  return siosia_ok('true'::jsonb);
exception when unique_violation then
  return siosia_err('already_rated');
end $$;

-- One appointment for one of its parties (C3 opened from a notification or a link), or (2.1, V34)
-- an open request for a member with a profile who could take it (the candidate view).
create or replace function public.siosia_get_appointment(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(false); v_uid uuid := auth.uid(); a appointments;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into a from appointments x
   where x.id = p_id and (siosia_sees(v_uid, x) -- 2.6: my family's too
                          or (x.provider_id is null and x.status = 'requested' and x.starts_at > now()
                              and siosia_same_realm(v_uid, x.client_id)
                              and exists (select 1 from profiles where user_id = v_uid and not deleted)));
  if a.id is null then return siosia_err('not_found'); end if;
  return siosia_ok(siosia_appointment_json(a, v_uid));
end $$;

-- The calendar function's read (FR-136, NFR-20): one appointment ('a'), series ('s', as its first
-- live occurrence with the series dates) or booked ride ('r') as one of its two parties sees it — only
-- with that viewer's valid token, otherwise null (the function answers 404). Service role only.
create or replace function public.siosia_calendar_view(p_kind text, p_id uuid, p_public text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_viewer uuid; v_lang text; v_view jsonb; a appointments; r rides; s appointment_series; c app_config;
begin
  if p_kind is null or p_kind not in ('a', 's', 'r') or p_id is null
     or coalesce(p_public, '') = '' or coalesce(p_token, '') = '' then return null; end if;
  if siosia_ics_token(p_id, p_public) is distinct from p_token then return null; end if;
  select user_id, language into v_viewer, v_lang from profiles where public_id = p_public and not deleted;
  if v_viewer is null then return null; end if;
  if p_kind = 'a' then
    select * into a from appointments where id = p_id and v_viewer in (client_id, provider_id);
    if a.id is null then return null; end if;
    v_view := siosia_appointment_json(a, v_viewer);
  elsif p_kind = 's' then
    select * into s from appointment_series where id = p_id and v_viewer in (client_id, provider_id);
    if s.id is null then return null; end if;
    -- The first live occurrence stands for the series: a declined / cancelled first date must not
    -- mark every date of a confirmed series as cancelled.
    select * into a from appointments where series_id = s.id
     order by (status in ('declined', 'cancelled', 'expired')), seq limit 1;
    if a.id is null then return null; end if;
    v_view := siosia_appointment_json(a, v_viewer);
  else
    select * into r from rides where id = p_id and v_viewer in (rider_id, driver_id) and scheduled_for is not null;
    if r.id is null then return null; end if;
    v_view := siosia_ride_json(r, v_viewer);
  end if;
  select * into c from app_config where id = 1;
  return jsonb_build_object('kind', p_kind, 'lang', coalesce(v_lang, 'en'), 'timezone', c.timezone,
                            'reminderMin', to_jsonb(c.appt_reminder_min), 'siteUrl', c.site_url, 'view', v_view);
end $$;

-- 12-month retention (§9) + housekeeping. Scheduled daily when pg_cron is available.
create or replace function public.siosia_retention()
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  delete from rides where coalesce(ended_at, requested_at) < now() - interval '12 months';
  -- 2.5 (FR-235): the photo objects of the updates that go with these appointments.
  for r in select u.photo_path as p from appointment_updates u join appointments a on a.id = u.appointment_id
            where u.photo_path is not null
              and coalesce(a.ended_at, a.starts_at + make_interval(mins => a.duration_min)) < now() - interval '12 months' loop
    perform siosia_drop_photo_object(r.p);
  end loop;
  delete from appointments where coalesce(ended_at, starts_at + make_interval(mins => duration_min)) < now() - interval '12 months';
  delete from appointment_series s where s.until < now() - interval '12 months'
     and not exists (select 1 from appointments a where a.series_id = s.id);
  delete from invite_failures where at < now() - interval '1 day';
  delete from push_outbox where created_at < now() - interval '2 days';
  delete from account_transfers where expires_at < now();
  -- 2.3: presence matters for 45 s; a day-old mark is noise.
  delete from chat_presence where seen_at < now() - interval '1 day';
  -- 2.6: answered invitations and finished contracts after 12 months.
  delete from family_invites where status <> 'pending' and coalesce(answered_at, created_at) < now() - interval '12 months';
  delete from member_invites where coalesce(used_at, expires_at) < now() - interval '12 months'; -- 2.8
  delete from contracts where status not in ('proposed', 'active')
     and coalesce(ended_at, answered_at, created_at) < now() - interval '12 months';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.3: kids, kid ratings, photos, chat (siosia-spec-v2.0.md "Amendment 2.3", SPEC.md
-- V44–V48). Twin of the Engine's 2.3 methods; the rules are the same on both sides.
-- ---------------------------------------------------------------------------------------------

-- A kid as the app sends it (FR-200): {name 1–30 (trimmed), bornYear null | 1900…this year, note ≤ 200}.
-- Never null itself: a missing name is false (jsonb_typeof of nothing is null, not 'string').
create or replace function public.siosia_valid_kid(p jsonb)
returns boolean language sql stable as $$
  select coalesce(p is not null and jsonb_typeof(p) = 'object'
     and jsonb_typeof(p -> 'name') = 'string' and char_length(btrim(p ->> 'name')) between 1 and 30
     and (p -> 'bornYear' is null or jsonb_typeof(p -> 'bornYear') = 'null'
          or (jsonb_typeof(p -> 'bornYear') = 'number'
              and (p ->> 'bornYear')::numeric = trunc((p ->> 'bornYear')::numeric)
              and (p ->> 'bornYear')::numeric between 1900 and siosia_year()))
     and (p -> 'note' is null or jsonb_typeof(p -> 'note') = 'null'
          or (jsonb_typeof(p -> 'note') = 'string' and char_length(btrim(p ->> 'note')) <= 200)), false);
$$;

-- The providers of upcoming appointments a kid is attached to refetch (its card changed or went).
create or replace function public.siosia_notify_kid_providers(p_kid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  for u in select distinct a.provider_id from appointment_kids ak join appointments a on a.id = ak.appointment_id
            where ak.kid_id = p_kid and a.provider_id is not null and a.status in ('requested', 'accepted') loop
    perform siosia_notify(u.provider_id);
  end loop;
end $$;

-- My kids (S2 → My kids), with every rating they got (FR-200, FR-203).
create or replace function public.siosia_kids()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(coalesce((select jsonb_agg(siosia_kid_json(k, v_uid) order by k.created_at, k.id)
                               from kids k where k.owner_id = any (siosia_household(v_uid))), '[]'::jsonb));
end $$;

-- A new kid (FR-200): valid input, at most 8 per member.
create or replace function public.siosia_add_kid(p_kid jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); k kids;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if not siosia_valid_kid(p_kid) then return siosia_err('bad_input'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7)); -- the count below, race-free
  if (select count(*) from kids where owner_id = v_uid) >= 8 then return siosia_err('too_many'); end if;
  insert into kids (owner_id, name, born_year, note)
  values (v_uid, btrim(p_kid ->> 'name'), ((p_kid ->> 'bornYear')::numeric)::int, btrim(coalesce(p_kid ->> 'note', '')))
  returning * into k;
  perform siosia_notify_household(v_uid);
  return siosia_ok(siosia_kid_json(k, v_uid));
end $$;

-- Changes one of my kids (name, year of birth, note); the photo is set with siosia_set_photo.
create or replace function public.siosia_update_kid(p_id uuid, p_kid jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); k kids;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  select * into k from kids where id = p_id and owner_id = any (siosia_household(v_uid)) for update;
  if k.id is null then return siosia_err('not_found'); end if;
  if not siosia_valid_kid(p_kid) then return siosia_err('bad_input'); end if;
  update kids set name = btrim(p_kid ->> 'name'), born_year = ((p_kid ->> 'bornYear')::numeric)::int,
                  note = btrim(coalesce(p_kid ->> 'note', ''))
   where id = k.id returning * into k;
  perform siosia_notify_household(k.owner_id);
  perform siosia_notify_kid_providers(k.id);
  return siosia_ok(siosia_kid_json(k, v_uid));
end $$;

-- Removes one of my kids (FR-204): its attachments and ratings go by cascade, and its photo object
-- is dropped here (V49) — nothing of the kid stays readable even if the app never gets to remove
-- the file. Returns the photo's path (or null) so the app removes the file too.
create or replace function public.siosia_remove_kid(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); k kids;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  select * into k from kids where id = p_id and owner_id = any (siosia_household(v_uid)) for update;
  if k.id is null then return siosia_err('not_found'); end if;
  perform siosia_notify_kid_providers(k.id);
  delete from kids where id = k.id;
  perform siosia_drop_photo_object(k.photo_path);
  perform siosia_notify_household(v_uid);
  return siosia_ok(to_jsonb(k.photo_path));
end $$;

-- The client attaches (replaces) their kids on an appointment (FR-201): their own kids only
-- (bad_input otherwise), while it is requested or accepted — not once it ended; the provider or
-- anyone else may not (forbidden). A series occurrence: that one.
create or replace function public.siosia_set_appointment_kids(p_id uuid, p_kids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments; v_kids uuid[];
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into a from appointments where id = p_id for update;
  if a.id is null then return siosia_err('not_found'); end if;
  if a.client_id <> v_uid then return siosia_err('forbidden'); end if;
  if a.status not in ('requested', 'accepted') then return siosia_err('illegal_transition'); end if;
  -- A list, possibly empty — never null (the engine's rule: not a list → bad_input).
  if p_kids is null then return siosia_err('bad_input'); end if;
  v_kids := siosia_own_kids(v_uid, p_kids);
  if v_kids is null then return siosia_err('bad_input'); end if;
  delete from appointment_kids where appointment_id = a.id;
  insert into appointment_kids (appointment_id, kid_id) select a.id, x from unnest(v_kids) x;
  perform siosia_notify(a.client_id);
  perform siosia_notify(a.provider_id);
  return siosia_ok(siosia_appointment_json(a, v_uid));
end $$;

-- The provider rates an attached kid once, within 24 h after a done appointment (FR-203): 1–5
-- stars, a comment kept to 140. The owner's own rating (FR-060) is another table, untouched.
create or replace function public.siosia_rate_kid(p_id uuid, p_kid uuid, p_stars int, p_comment text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into a from appointments where id = p_id and (client_id = v_uid or provider_id = v_uid);
  if a.id is null then return siosia_err('not_found'); end if;
  if a.client_id = v_uid then return siosia_err('forbidden'); end if;
  if not exists (select 1 from appointment_kids where appointment_id = a.id and kid_id = p_kid) then return siosia_err('not_found'); end if;
  if a.status <> 'done' then return siosia_err('illegal_transition'); end if;
  if now() > coalesce(a.ended_at, a.starts_at + make_interval(mins => a.duration_min)) + interval '24 hours' then
    return siosia_err('window_closed');
  end if;
  if p_stars is null or p_stars not between 1 and 5 then return siosia_err('bad_input'); end if;
  insert into kid_ratings (appointment_id, kid_id, from_user, stars, comment)
  values (a.id, p_kid, v_uid, p_stars, left(btrim(coalesce(p_comment, '')), 140));
  perform siosia_notify(a.client_id);
  perform siosia_notify(a.provider_id);
  return siosia_ok('true'::jsonb);
exception when unique_violation then
  return siosia_err('already_rated');
end $$;

-- A photo object's path (FR-210, V49): profile/<public id>/<file>.jpg or kid/<public id>/<kid>/<file>.jpg
-- — the folder is the owner's PUBLIC id (never the auth uid: a signed URL carries the path and the
-- viewer sees it), the file a random name. The folder key, or null for anything else (a URL, say — V46).
create or replace function public.siosia_photo_folder(p_path text)
returns text language sql immutable as $$
  select case when p_path ~ ('^(profile/' || f || '|kid/' || f || '/' || u || '|update/' || f || '/' || u || ')/[A-Za-z0-9_-]{1,64}\.jpg$')
              then split_part(p_path, '/', 2) end
    from (select '[A-Za-z0-9_-]{10,24}' as f,
                 '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' as u) x;
$$;

-- The kid a kid/ path names (its shape only — whose kid it is, the rows say).
create or replace function public.siosia_photo_kid(p_path text)
returns uuid language sql immutable as $$
  select case when p_path like 'kid/%' and siosia_photo_folder(p_path) is not null then split_part(p_path, '/', 3)::uuid end;
$$;

-- 2.5: the appointment an update/ path names (update/<public id>/<appointment id>/<key>.jpg).
create or replace function public.siosia_photo_appt(p_path text)
returns uuid language sql immutable as $$
  select case when p_path like 'update/%' and siosia_photo_folder(p_path) is not null then split_part(p_path, '/', 3)::uuid end;
$$;

-- Who owns an object (V49): the ROW that holds its path — a profile's photo → that user, a kid's →
-- the kid's owner — so an account that moved to another phone keeps every photo. An object no row
-- holds yet or any more (just uploaded, replaced) belongs to the profile whose public id is its
-- folder. Null for a path of another shape or nobody's.
create or replace function public.siosia_photo_owner(p_path text)
returns uuid language sql stable security definer set search_path = public as $$
  select case when siosia_photo_folder(p_path) is null then null else coalesce(
    (select p.user_id from profiles p where p.photo_path = p_path limit 1),
    (select k.owner_id from kids k where k.photo_path = p_path limit 1),
    (select u.author from appointment_updates u where u.photo_path = p_path limit 1), -- 2.5
    (select p.user_id from profiles p where p.public_id = siosia_photo_folder(p_path) and not p.deleted)) end;
$$;

-- Stores the path of a photo the app uploaded for my profile or one of my kids — or null to clear
-- it (FR-210, FR-212: the path, never a URL; one photo each). Returns the OLD path (or null): the
-- app removes that object. The path must be under my public id's folder, under the right kid.
create or replace function public.siosia_set_photo(p_kind text, p_kid uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_old text; k kids;
  -- under my public id's folder (false, never null, for a path of another shape or anyone else's folder)
  v_mine boolean := coalesce(siosia_photo_folder(p_path) = (select public_id from profiles where user_id = auth.uid()), false);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if p_kind = 'profile' then
    if p_path is not null and (p_path not like 'profile/%' or not v_mine) then
      return siosia_err('bad_input');
    end if;
    select photo_path into v_old from profiles where user_id = v_uid for update;
    update profiles set photo_path = p_path where user_id = v_uid;
  elsif p_kind = 'kid' then
    select * into k from kids where id = p_kid and owner_id = any (siosia_household(v_uid)) for update;
    if k.id is null then return siosia_err('not_found'); end if;
    if p_path is not null and (not v_mine or siosia_photo_kid(p_path) is distinct from k.id) then
      return siosia_err('bad_input');
    end if;
    v_old := k.photo_path;
    update kids set photo_path = p_path where id = k.id;
    perform siosia_notify_kid_providers(k.id);
  else
    return siosia_err('bad_input');
  end if;
  perform siosia_notify_household(v_uid);
  -- An old object whose folder is nobody's any more (a profile replaced by a move) is beyond the
  -- client's delete policy: the server drops it. The client still removes objects it owns.
  if v_old is not null and v_old is distinct from p_path
     and coalesce(siosia_photo_folder(v_old) = (select public_id from profiles where user_id = v_uid), false) = false then
    perform siosia_drop_photo_object(v_old);
  end if;
  return siosia_ok(to_jsonb(v_old));
end $$;

-- The paths of my photo objects (profile and kids): the app removes them from the bucket before
-- it deletes the profile.
create or replace function public.siosia_my_photo_paths()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(coalesce((select jsonb_agg(x.p) from (
    select photo_path as p from profiles where user_id = v_uid and photo_path is not null
    union all
    select photo_path from kids where owner_id = v_uid and photo_path is not null
    union all
    select photo_path from appointment_updates where author = v_uid and photo_path is not null) x), '[]'::jsonb));
end $$;

-- Drops one photo object's row (siosia_remove_kid, a replaced profile): nothing stays readable even
-- when the app never gets to remove the file. Skipped where there is no Storage (tests); a bucket
-- error must never stop the deletion it is part of.
create or replace function public.siosia_drop_photo_object(p_path text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_path is null or to_regclass('storage.objects') is null then return; end if;
  begin
    execute 'delete from storage.objects where bucket_id = $1 and name = $2' using 'photos', p_path;
  exception when others then
    raise warning 'siosia_drop_photo_object: %', sqlerrm;
  end;
end $$;

-- Drops every photo object row left under an account's folders (siosia_delete_profile): the folders
-- are keyed by the profile's public id (V49; the uid-keyed shape of the first 2.3 builds is covered
-- too). The app removed the files first; this makes sure nothing stays readable.
create or replace function public.siosia_drop_photo_objects(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_key text;
begin
  if to_regclass('storage.objects') is null then return; end if;
  begin
    for v_key in select p_user::text union select public_id from profiles where user_id = p_user and public_id is not null loop
      execute 'delete from storage.objects where bucket_id = $1 and (name like $2 or name like $3 or name like $4)'
        using 'photos', 'profile/' || v_key || '/%', 'kid/' || v_key || '/%', 'update/' || v_key || '/%';
    end loop;
  exception when others then
    raise warning 'siosia_drop_photo_objects: %', sqlerrm; -- the bucket must never stop a deletion
  end;
end $$;

-- A chat room (FR-220, V47) and who may use it: 'ride:<id>' once the ride has a driver (the rider
-- and the CURRENT driver — a re-dispatched driver is no party any more), 'appt:<id>' once accepted
-- (client and provider: an answered one that was not declined). Open while live and for 24 h
-- after the end (FR-223). No row for anything else.
create or replace function public.siosia_room(p_room text)
returns table (ride_id uuid, appointment_id uuid, party_a uuid, party_b uuid, open boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid; r rides; a appointments;
begin
  -- The id in lower case only, as the rows name their room (messages.room): an upper-case spelling
  -- is no room — not_found, as in the engine, never a check violation on insert.
  if coalesce(p_room, '') !~ '^(ride|appt):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return; end if;
  v_id := substr(p_room, 6)::uuid;
  if p_room like 'ride:%' then
    select * into r from rides where id = v_id and driver_id is not null;
    if r.id is null then return; end if;
    return query select r.id, null::uuid, r.rider_id, r.driver_id,
                        r.ended_at is null or now() <= r.ended_at + interval '24 hours';
  else
    select * into a from appointments
     where id = v_id and provider_id is not null and answered_at is not null and status not in ('declined', 'expired');
    if a.id is null then return; end if;
    return query select null::uuid, a.id, a.client_id, a.provider_id,
                        a.ended_at is null or now() <= a.ended_at + interval '24 hours';
  end if;
end $$;

-- Queues a chat notification (FR-222) for a user who turned them on, tagged with the ride or
-- appointment. The words are the push-text module's; only the params are set here.
create or replace function public.siosia_push_chat(p_user uuid, p_ride uuid, p_appt uuid, p_params jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or not exists (select 1 from push_subscriptions where user_id = p_user)
     or not siosia_member_ok(p_user) then
    return;
  end if;
  insert into push_outbox (user_id, kind, ride_id, appointment_id, params, lang, tz)
  values (p_user, 'chat_message', p_ride, p_appt, coalesce(p_params, '{}'::jsonb),
          coalesce((select language from profiles where user_id = p_user), 'en'),
          coalesce((select timezone from app_config where id = 1), 'Europe/Warsaw'));
  perform siosia_kick_push();
end $$;

-- A room's thread as one of its parties sees it (FR-221, FR-224): the other party (with their
-- photo), the messages oldest first, whether sending is still allowed, the unread count. With
-- p_mark_read — the thread is open and visible — the other party's messages are marked read now
-- (they refetch their read marks, the reader's other tabs drop the badge) and the reader's presence
-- in the room is stamped (FR-222: no push to someone looking at the thread; the app re-stamps every 20 s).
create or replace function public.siosia_chat(p_room text, p_mark_read boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); rm record; v_other uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into rm from siosia_room(p_room);
  if rm.party_a is null or (v_uid is distinct from rm.party_a and v_uid is distinct from rm.party_b) then
    return siosia_err('not_found');
  end if;
  v_other := case when rm.party_a = v_uid then rm.party_b else rm.party_a end;
  if coalesce(p_mark_read, false) then
    insert into chat_presence (user_id, room, seen_at) values (v_uid, p_room, now())
    on conflict (user_id, room) do update set seen_at = now();
    update messages set read_at = now() where room = p_room and sender <> v_uid and read_at is null;
    if found then
      perform siosia_notify(v_other);
      perform siosia_notify(v_uid);
    end if;
  end if;
  return siosia_ok(jsonb_build_object(
    'room', p_room,
    'other', siosia_party_for(v_other, true),
    'messages', coalesce((select jsonb_agg(siosia_message_json(m, v_uid) order by m.sent_at, m.id)
                            from messages m where m.room = p_room), '[]'::jsonb),
    'open', rm.open,
    'unread', siosia_unread(p_room, v_uid)));
end $$;

-- Sends to the other party of a room I belong to (FR-221–225): not_found outside the room's two
-- parties, illegal_transition once it is read-only (24 h after the end), bad_input for a blank or
-- over-long text, too_many past 30 messages in 10 minutes. Stored; both parties' screens refetch
-- (realtime); one notification to the other party — unless they are driving right now, or have
-- the thread open (seen in the room within 45 s — FR-222, V48). The notification carries the whole
-- text; the sender (push-text) cuts it to the first words.
create or replace function public.siosia_send_message(p_room text, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); rm record; v_other uuid;
  v_text text := btrim(coalesce(p_text, ''), E' \t\n\r\f' || chr(11)); m messages;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into rm from siosia_room(p_room);
  if rm.party_a is null or (v_uid is distinct from rm.party_a and v_uid is distinct from rm.party_b) then
    return siosia_err('not_found');
  end if;
  if not rm.open then return siosia_err('illegal_transition'); end if;
  if char_length(v_text) not between 1 and 500 then return siosia_err('bad_input'); end if;
  if (select count(*) from messages where room = p_room and sender = v_uid and sent_at > now() - interval '10 minutes') >= 30 then
    return siosia_err('too_many');
  end if;
  v_other := case when rm.party_a = v_uid then rm.party_b else rm.party_a end;
  insert into messages (room, ride_id, appointment_id, sender, text)
  values (p_room, rm.ride_id, rm.appointment_id, v_uid, v_text) returning * into m;
  perform siosia_notify(v_other);
  perform siosia_notify(v_uid); -- my other tabs
  -- No phone at the wheel: a driver with a ride under way reads it in the thread later. Someone
  -- looking at the thread right now sees it land live and needs no notification either.
  if not exists (select 1 from rides x where x.driver_id = v_other and x.status = 'in_progress')
     and not exists (select 1 from chat_presence c where c.user_id = v_other and c.room = p_room
                      and c.seen_at > now() - interval '45 seconds') then
    perform siosia_push_chat(v_other, rm.ride_id, rm.appointment_id,
                             jsonb_build_object('sender', siosia_nick(v_uid), 'text', v_text, 'room', p_room,
                                                'messageId', m.id));
  end if;
  return siosia_ok(siosia_message_json(m, v_uid));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.5: session updates and heading home (siosia-spec-v2.0.md "Amendment 2.5", SPEC.md
-- V54–V56). Twin of the Engine's 2.5 methods; the rules are the same on both sides.
-- ---------------------------------------------------------------------------------------------

-- One update as a party sees it (SessionUpdate): the author with their photo, "mine", the kid it is
-- about (the name as it was when posted), the text, the photo (its path, for the app to sign —
-- FR-212) and when.
create or replace function public.siosia_update_json(u public.appointment_updates, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', u.id, 'appointmentId', u.appointment_id,
    'author', siosia_party_for(u.author, true),
    'mine', u.author = p_viewer,
    'kid', case when u.kid_name is null then null else jsonb_build_object('id', u.kid_id, 'name', u.kid_name) end,
    'text', u.text, 'photo', null,
    'createdAt', siosia_ms(u.created_at))
    || siosia_photo_path_json(u.photo_path, true);
$$;

-- The appointment behind a feed, for one of its two parties — null for anyone else (an open request
-- has no feed yet; a candidate, a driver, another member see nothing, FR-234).
create or replace function public.siosia_feed_appt(p_appt uuid, p_uid uuid)
returns public.appointments language sql stable security definer set search_path = public as $$
  select a from appointments a
   where a.id = p_appt and a.provider_id is not null and siosia_sees(p_uid, a); -- 2.6: their families read too
$$;

-- The feed of an appointment I am a party of (FR-231, FR-233): the updates oldest first, and whether
-- posting is still allowed. With p_seen — the feed is in front — my presence in it is stamped
-- (FR-232: no notification for what I am looking at; the app re-stamps every 20 s, V55).
create or replace function public.siosia_updates(p_appt uuid, p_seen boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  a := siosia_feed_appt(p_appt, v_uid);
  if a.id is null then return siosia_err('not_found'); end if;
  if coalesce(p_seen, false) then
    insert into chat_presence (user_id, room, seen_at) values (v_uid, 'feed:' || p_appt::text, now())
    on conflict (user_id, room) do update set seen_at = now();
  end if;
  return siosia_ok(jsonb_build_object(
    'appointmentId', a.id,
    'open', siosia_feed_open(a),
    'items', coalesce((select jsonb_agg(siosia_update_json(u, v_uid) order by u.created_at, u.id)
                         from appointment_updates u where u.appointment_id = a.id), '[]'::jsonb)));
end $$;

-- Posts an update to the feed (FR-230, FR-232): not_found outside the two parties,
-- illegal_transition outside the window (30 min before the start … 7 days after the end, accepted or
-- done), bad_input for a blank text without a photo, an over-long text, a kid not attached to this
-- appointment or a photo path not under my folder for this appointment, too_many past 60 in an hour.
-- Stored; both parties' screens refetch; one notification to the other party — unless they have the
-- feed in front or are driving right now (V55). The text is queued whole; push-text cuts it.
create or replace function public.siosia_post_update(p_appt uuid, p_text text, p_kid uuid, p_photo text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments; u appointment_updates;
  v_text text := btrim(coalesce(p_text, ''), E' \t\n\r\f' || chr(11)); v_kid_name text; v_other uuid; v_room text;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  a := siosia_feed_appt(p_appt, v_uid);
  if a.id is null then return siosia_err('not_found'); end if;
  -- 2.6 (FR-255): of a party's family only the client's posts (the parent's side).
  if a.client_id <> v_uid and a.provider_id <> v_uid and not siosia_same_family(v_uid, a.client_id) then
    return siosia_err('forbidden');
  end if;
  if not siosia_feed_open(a) then return siosia_err('illegal_transition'); end if;
  if char_length(v_text) > 500 or (v_text = '' and p_photo is null) then return siosia_err('bad_input'); end if;
  if p_photo is not null and not (p_photo like 'update/%' and siosia_photo_appt(p_photo) = a.id
       and coalesce(siosia_photo_folder(p_photo) = (select public_id from profiles where user_id = v_uid), false)) then
    return siosia_err('bad_input');
  end if;
  -- One object, one update: deleting either would drop the object under the other.
  if p_photo is not null and exists (select 1 from appointment_updates x where x.photo_path = p_photo) then
    return siosia_err('bad_input');
  end if;
  if p_kid is not null then
    select k.name into v_kid_name from appointment_kids ak join kids k on k.id = ak.kid_id
     where ak.appointment_id = a.id and ak.kid_id = p_kid;
    if v_kid_name is null then return siosia_err('bad_input'); end if;
  end if;
  if (select count(*) from appointment_updates x where x.appointment_id = a.id and x.author = v_uid
       and x.created_at > now() - interval '1 hour') >= 60 then
    return siosia_err('too_many');
  end if;
  insert into appointment_updates (appointment_id, author, kid_id, kid_name, text, photo_path)
  values (a.id, v_uid, p_kid, v_kid_name, v_text, p_photo) returning * into u;
  perform siosia_notify_household(a.client_id);
  perform siosia_notify_household(a.provider_id);
  v_room := 'feed:' || a.id::text;
  -- 2.6 (V60): everyone on the parent's side and the provider, but the author — each unless driving
  -- or looking at the feed.
  for v_other in select distinct x from unnest(siosia_household(a.client_id) || a.provider_id) x where x <> v_uid loop
    if not exists (select 1 from rides x where x.driver_id = v_other and x.status = 'in_progress')
       and not exists (select 1 from chat_presence c where c.user_id = v_other and c.room = v_room
                        and c.seen_at > now() - interval '45 seconds') then
      perform siosia_push_appt(v_other, 'session_update', a.id,
                               siosia_appt_params(a) || jsonb_build_object('sender', siosia_nick(v_uid), 'text', v_text,
                                                                           'kid', v_kid_name, 'photo', p_photo is not null,
                                                                           'updateId', u.id));
    end if;
  end loop;
  return siosia_ok(siosia_update_json(u, v_uid));
end $$;

-- Removes my own update (FR-231) while the feed is open — the same window as posting (V54): its
-- photo object is dropped here as well (the app removes the file too, best effort — the OLD path
-- comes back for that). Both parties refetch.
create or replace function public.siosia_delete_update(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); u appointment_updates; a appointments;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  select * into u from appointment_updates where id = p_id and author = v_uid;
  if u.id is null then return siosia_err('not_found'); end if;
  select * into a from appointments where id = u.appointment_id;
  if not siosia_feed_open(a) then return siosia_err('illegal_transition'); end if; -- while posting is (V54)
  delete from appointment_updates where id = u.id;
  if u.photo_path is not null then perform siosia_drop_photo_object(u.photo_path); end if;
  perform siosia_notify_household(a.client_id);
  perform siosia_notify_household(a.provider_id);
  return siosia_ok(to_jsonb(u.photo_path));
end $$;

-- The client is heading home (FR-240–242): minutes 0–600 — the app computed them from its own
-- location and the road; no position reaches here (FR-043) — give coming_at = now and eta_at. Only
-- while live: accepted (or just done), from 30 min before the start until 2 h after the end
-- (illegal_transition otherwise); repeating replaces the estimate. One client_coming notification
-- to the provider.
create or replace function public.siosia_coming_home(p_appt uuid, p_minutes int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments; v_prev timestamptz;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into a from appointments where id = p_appt and client_id = v_uid for update;
  if a.id is null then return siosia_err('not_found'); end if;
  if p_minutes is null or p_minutes not between 0 and 600 then return siosia_err('bad_input'); end if;
  if a.status not in ('accepted', 'done') or a.provider_id is null or now() < a.starts_at - interval '30 minutes'
     or now() > a.starts_at + make_interval(mins => a.duration_min) + interval '2 hours' then
    return siosia_err('illegal_transition');
  end if;
  v_prev := a.coming_at;
  update appointments set coming_at = now(), eta_at = now() + make_interval(mins => p_minutes)
   where id = a.id returning * into a;
  perform siosia_notify(a.client_id);
  perform siosia_notify(a.provider_id);
  -- A notice repeated within a minute replaces the previous one on screen but rings no second time.
  if v_prev is null or v_prev < now() - interval '60 seconds' then
    perform siosia_push_appt(a.provider_id, 'client_coming', a.id,
                             siosia_appt_params(a) || jsonb_build_object('minutes', p_minutes, 'etaAt', a.eta_at));
  end if;
  return siosia_ok(siosia_appointment_json(a, v_uid));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Siosia 2.6: family, contracts, cost summaries, weekly reports (siosia-spec-v2.0.md "Amendment
-- 2.6", SPEC.md V58–V65). Twin of the Engine's 2.6 methods; the rules are the same on both sides.
-- ---------------------------------------------------------------------------------------------

-- The active contract line between the client's family and the provider for a service (V62) —
-- 2.8 (FR-305): else the line of its base (a YOLO event takes the Childcare rate).
create or replace function public.siosia_contract_rate(p_client uuid, p_provider uuid, p_service text)
returns table (contract_id uuid, per_hour numeric) language sql stable security definer set search_path = public as $$
  select k.id, (r ->> 'perHour')::numeric from contracts k, jsonb_array_elements(k.rates) r
   where k.family_id = siosia_family_of(p_client) and k.provider_id = p_provider and k.status = 'active'
     and (r ->> 'serviceId' = p_service or r ->> 'serviceId' = siosia_service(p_service) ->> 'base')
   order by (r ->> 'serviceId' = p_service) desc
   limit 1;
$$;

-- Is p_user on the side that answers this proposal — the provider of a family's proposal, any member
-- of the family of a provider's?
create or replace function public.siosia_contract_answers(p_user uuid, k public.contracts)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(case when k.proposed_side = 'family' then k.provider_id = p_user
                       else k.family_id = siosia_family_of(p_user) and k.provider_id <> p_user end, false);
$$;

create or replace function public.siosia_invite_json(i public.family_invites)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', i.id, 'from', siosia_public_party(i.from_user, true), 'to', siosia_public_party(i.to_user, true),
                            'createdAt', siosia_ms(i.created_at), 'expiresAt', siosia_ms(i.created_at + interval '7 days'));
$$;

-- My family (FamilyView): its people first joined first, the invitations it sent that still wait,
-- and those waiting for me.
create or replace function public.siosia_family_json(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', x.f,
    'members', coalesce((select jsonb_agg(siosia_public_party(m.user_id, true)
                                          || jsonb_build_object('me', m.user_id = p_user, 'joinedAt', siosia_ms(m.joined_at))
                                          order by m.joined_at, m.user_id)
                           from family_members m where m.family_id = x.f), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(siosia_invite_json(i) order by i.created_at, i.id)
                           from family_invites i where i.family_id = x.f and i.status = 'pending'), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(siosia_invite_json(i) order by i.created_at, i.id)
                            from family_invites i where i.to_user = p_user and i.status = 'pending'), '[]'::jsonb))
  from (select siosia_family_of(p_user) as f) x;
$$;

-- A contract as one of its sides sees it (ContractView).
create or replace function public.siosia_contract_json(k public.contracts, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', k.id, 'version', k.version, 'status', k.status, 'side', v.side,
    'provider', siosia_public_party(k.provider_id, true),
    'family', coalesce((select jsonb_agg(coalesce(p.nickname, '') order by m.joined_at, m.user_id)
                          from family_members m left join profiles p on p.user_id = m.user_id
                         where m.family_id = k.family_id), '[]'::jsonb),
    'to', case when v.side = 'family' then (select public_id from profiles where user_id = k.provider_id and not deleted)
               else (select p.public_id from family_members m join profiles p on p.user_id = m.user_id and not p.deleted
                      where m.family_id = k.family_id order by m.joined_at, m.user_id limit 1) end,
    'rates', k.rates, 'note', k.note, 'currency', k.currency,
    'proposedByMe', k.proposed_side = v.side,
    'canAnswer', k.status = 'proposed' and siosia_contract_answers(p_viewer, k),
    'createdAt', siosia_ms(k.created_at), 'answeredAt', siosia_ms(k.answered_at), 'endedAt', siosia_ms(k.ended_at))
  from (select case when k.provider_id = p_viewer then 'provider' else 'family' end as side) v;
$$;

-- A contract's provider and family refetch.
create or replace function public.siosia_notify_contract(k public.contracts)
returns void language plpgsql security definer set search_path = public as $$
declare m uuid;
begin
  perform siosia_notify(k.provider_id);
  for m in select user_id from family_members where family_id = k.family_id loop
    perform siosia_notify(m);
  end loop;
end $$;

-- A family made with its first member.
create or replace function public.siosia_new_family(p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into families default values returning id into v_id;
  insert into family_members (user_id, family_id) values (p_user, v_id);
  return v_id;
end $$;

-- Takes p_user out of their family (FR-252); a family nobody is left in goes, its waiting invitations
-- are withdrawn and its contracts end (the provider of an active one is told).
create or replace function public.siosia_leave_family(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_fid uuid := siosia_family_of(p_user); v_before uuid[]; m uuid; k contracts;
begin
  if v_fid is null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_fid::text, 7));
  v_before := siosia_household(p_user);
  delete from family_members where user_id = p_user;
  foreach m in array v_before loop perform siosia_notify(m); end loop;
  if cardinality(v_before) > 1 then return; end if;
  for m in update family_invites set status = 'withdrawn' where family_id = v_fid and status = 'pending' returning to_user loop
    perform siosia_notify(m);
  end loop;
  for k in select * from contracts where family_id = v_fid and status in ('active', 'proposed') loop
    update contracts set status = case when k.status = 'active' then 'ended' else 'withdrawn' end, ended_at = now(), ended_by = p_user
     where id = k.id;
    if k.status = 'active' then
      perform siosia_push(k.provider_id, 'contract_ended', null, jsonb_build_object('sender', siosia_nick(p_user)));
    end if;
  end loop;
  delete from families where id = v_fid;
end $$;

-- A deleted (or replaced) profile: its invitations go, its contracts as a provider end (the families
-- are told), and it leaves its family.
create or replace function public.siosia_drop_from_families(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m uuid; k contracts;
begin
  for m in update family_invites set status = case when to_user = p_user then 'declined' else 'withdrawn' end, answered_at = now()
            where status = 'pending' and (to_user = p_user or from_user = p_user) returning to_user loop
    perform siosia_notify(m);
  end loop;
  for k in select * from contracts where provider_id = p_user and status in ('active', 'proposed') loop
    update contracts set status = case when k.status = 'active' then 'ended' else 'withdrawn' end, ended_at = now(), ended_by = p_user
     where id = k.id;
    if k.status = 'active' then
      for m in select user_id from family_members where family_id = k.family_id loop
        perform siosia_push(m, 'contract_ended', null, jsonb_build_object('sender', siosia_nick(p_user)));
      end loop;
    end if;
  end loop;
  perform siosia_leave_family(p_user);
end $$;

-- My family (FR-250–252).
create or replace function public.siosia_family()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true);
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  return siosia_ok(siosia_family_json(auth.uid()));
end $$;

-- The members I could invite or contract with: everyone else with a profile, by nickname.
create or replace function public.siosia_members()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(coalesce((select jsonb_agg(siosia_public_party(p.user_id, true) order by p.nickname, p.user_id)
                               from profiles p where not p.deleted and p.user_id <> v_uid and siosia_member_ok(p.user_id)
                                and siosia_same_realm(v_uid, p.user_id) and siosia_listed(p.user_id, v_uid)), '[]'::jsonb));
end $$;

-- Invites a member into my family (FR-250): not_found for nobody / myself, in_family for someone
-- already in it, family_full at 6; the same invitation twice is one. Without a family, one is made.
create or replace function public.siosia_family_invite(p_public text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_to uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  perform siosia_sweep();
  select user_id into v_to from profiles where public_id = p_public and not deleted;
  v_err := siosia_family_invite_as(v_uid, v_to);
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(siosia_family_json(v_uid));
end $$;

-- The invitation itself (FR-250, V58), for siosia_family_invite and (2.8) a member who came by an
-- invite link: an error code, or null when invited (or already invited).
create or replace function public.siosia_family_invite_as(p_from uuid, p_to uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_fid uuid;
begin
  if p_to is null or p_to = p_from or not siosia_member_ok(p_to) or not siosia_same_realm(p_from, p_to)
     or not exists (select 1 from profiles where user_id = p_from and not deleted) then
    return 'not_found';
  end if;
  if siosia_same_family(p_from, p_to) then return 'in_family'; end if;
  v_fid := siosia_family_of(p_from);
  if v_fid is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_fid::text, 7));
    if (select count(*) from family_members where family_id = v_fid) >= 6 then return 'family_full'; end if;
    if exists (select 1 from family_invites where family_id = v_fid and to_user = p_to and status = 'pending') then
      return null;
    end if;
  else
    v_fid := siosia_new_family(p_from);
  end if;
  insert into family_invites (family_id, from_user, to_user) values (v_fid, p_from, p_to);
  perform siosia_push(p_to, 'family_invite', null, jsonb_build_object('sender', siosia_nick(p_from)));
  perform siosia_notify_household(p_from);
  perform siosia_notify(p_to);
  return null;
end $$;

-- 2.8 (FR-301, V69): a personal link into Siosia — the app shares <site>#join=<token>. 24 random
-- URL-safe characters; only their SHA-256 is kept; 14 days, once; at most 10 open per member.
create or replace function public.siosia_create_member_invite()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_token text; v_exp timestamptz := now() + interval '14 days';
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  if (select count(*) from member_invites where from_user = v_uid and used_by is null and expires_at > now()) >= 10 then
    return siosia_err('too_many');
  end if;
  v_token := translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');
  insert into member_invites (token_hash, from_user, expires_at) values (encode(digest(v_token, 'sha256'), 'hex'), v_uid, v_exp);
  return siosia_ok(jsonb_build_object('token', v_token, 'expiresAt', siosia_ms(v_exp)));
end $$;

-- 2.8 (FR-302, V69): opening a link admits this phone like the invite code — into the inviter's
-- realm (V66) — and spends the link; a member who opens one gets the family invitation at once.
-- A wrong, used or expired link counts as a failed invite attempt (10 an hour).
create or replace function public.siosia_join_link(p_token text, p_device text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); i member_invites;
begin
  if v_uid is null then return siosia_err('forbidden'); end if;
  if coalesce(char_length(p_device), 0) not between 1 and 80 then return siosia_err('bad_input'); end if;
  if (select count(*) from invite_failures where user_id = v_uid and at > now() - interval '1 hour') >= 10 then
    return siosia_err('rate_limited');
  end if;
  select * into i from member_invites where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if i.token_hash is null or i.used_by is not null or i.expires_at <= now()
     or not exists (select 1 from profiles where user_id = i.from_user and not deleted) or not siosia_member_ok(i.from_user) then
    insert into invite_failures (user_id) values (v_uid);
    return siosia_err('bad_link');
  end if;
  update member_invites set used_by = v_uid, used_at = now() where token_hash = i.token_hash;
  if not siosia_member_ok(v_uid) then
    insert into memberships (user_id, device_id, sandbox) values (v_uid, p_device, siosia_sandbox(i.from_user))
    on conflict (user_id, device_id) do update set sandbox = memberships.sandbox or excluded.sandbox;
  end if;
  perform siosia_link_family_invites(v_uid);
  return siosia_ok('true'::jsonb);
end $$;

-- The family invitations owed to someone who joined by link, once they have a profile (silently
-- none when not allowed: in a family already, a full family, a gone inviter).
create or replace function public.siosia_link_family_invites(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare i member_invites;
begin
  if not exists (select 1 from profiles where user_id = p_user and not deleted) then return; end if;
  for i in select * from member_invites where used_by = p_user and not family_sent order by used_at for update loop
    update member_invites set family_sent = true where token_hash = i.token_hash;
    perform siosia_family_invite_as(i.from_user, p_user);
  end loop;
end $$;

-- Join or decline an invitation (FR-250, FR-251). Joining: in_family while in a family with someone
-- else; family_full at 6; a family of me alone merges in — its contracts move along unless the new
-- family has one with that provider, or the provider is in it (then that one ends) — and a contract
-- the new family has with me as its provider ends. Other invitations to me lapse.
create or replace function public.siosia_family_answer(p_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); i family_invites; v_mine uuid; m uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if p_decision is null or p_decision not in ('join', 'decline') then return siosia_err('bad_input'); end if;
  perform siosia_sweep();
  select * into i from family_invites where id = p_id and to_user = v_uid for update;
  if i.id is null then return siosia_err('not_found'); end if;
  if i.status <> 'pending' or not exists (select 1 from families where id = i.family_id) then return siosia_err('illegal_transition'); end if;
  perform pg_advisory_xact_lock(hashtextextended(i.family_id::text, 7));
  if p_decision = 'decline' then
    update family_invites set status = 'declined', answered_at = now() where id = i.id;
    for m in select user_id from family_members where family_id = i.family_id loop perform siosia_notify(m); end loop;
    perform siosia_notify(v_uid);
    return siosia_ok(siosia_family_json(v_uid));
  end if;
  v_mine := siosia_family_of(v_uid);
  if v_mine = i.family_id or (v_mine is not null and (select count(*) from family_members where family_id = v_mine) > 1) then
    return siosia_err('in_family');
  end if;
  if (select count(*) from family_members where family_id = i.family_id) >= 6 then return siosia_err('family_full'); end if;
  if v_mine is not null then
    update contracts k set status = case when k.status = 'active' then 'ended' else 'withdrawn' end, ended_at = now(), ended_by = null
     where k.family_id = v_mine and k.status in ('active', 'proposed')
       and (k.provider_id in (select user_id from family_members where family_id = i.family_id)
            or exists (select 1 from contracts x where x.family_id = i.family_id and x.provider_id = k.provider_id
                        and x.status in ('active', 'proposed')));
    update contracts set family_id = i.family_id where family_id = v_mine;
    update family_invites set status = 'withdrawn' where family_id = v_mine and status = 'pending';
    delete from family_members where user_id = v_uid;
    delete from families where id = v_mine;
  end if;
  update contracts set status = case when status = 'active' then 'ended' else 'withdrawn' end, ended_at = now(), ended_by = null
   where family_id = i.family_id and provider_id = v_uid and status in ('active', 'proposed');
  for m in select user_id from family_members where family_id = i.family_id loop
    perform siosia_push(m, 'family_joined', null, jsonb_build_object('sender', siosia_nick(v_uid)));
  end loop;
  insert into family_members (user_id, family_id) values (v_uid, i.family_id);
  update family_invites set status = 'joined', answered_at = now() where id = i.id;
  update family_invites set status = 'declined' where to_user = v_uid and status = 'pending';
  perform siosia_notify_household(v_uid);
  return siosia_ok(siosia_family_json(v_uid));
end $$;

-- The family takes back an invitation that still waits.
create or replace function public.siosia_family_withdraw(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); i family_invites;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  select * into i from family_invites where id = p_id and family_id = siosia_family_of(v_uid) for update;
  if i.id is null then return siosia_err('not_found'); end if;
  if i.status <> 'pending' then return siosia_err('illegal_transition'); end if;
  update family_invites set status = 'withdrawn', answered_at = now() where id = i.id;
  perform siosia_notify_household(v_uid);
  perform siosia_notify(i.to_user);
  return siosia_ok(siosia_family_json(v_uid));
end $$;

-- I leave my family (FR-252): my kids leave with me (they stay mine).
create or replace function public.siosia_family_leave()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid();
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if siosia_family_of(v_uid) is null then return siosia_err('not_found'); end if;
  perform siosia_leave_family(v_uid);
  return siosia_ok(siosia_family_json(v_uid));
end $$;

-- My family's contracts and mine as a provider (FR-264): waiting first, then active (newest first),
-- then the last 10 others.
create or replace function public.siosia_contracts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_fid uuid := siosia_family_of(auth.uid());
begin
  if v_err is not null then return siosia_err(v_err); end if;
  return siosia_ok(coalesce((select jsonb_agg(siosia_contract_json(k, v_uid) order by q.grp, q.at desc, k.version desc) from (
      select x.id, case when x.status = 'proposed' then 0 else 1 end as grp, x.created_at as at from contracts x
       where (x.provider_id = v_uid or x.family_id = v_fid) and x.status in ('proposed', 'active')
      union all
      (select x.id, 2, coalesce(x.ended_at, x.answered_at, x.created_at) from contracts x
        where (x.provider_id = v_uid or x.family_id = v_fid) and x.status not in ('proposed', 'active')
        order by coalesce(x.ended_at, x.answered_at, x.created_at) desc, x.version desc limit 10)) q
      join contracts k on k.id = q.id), '[]'::jsonb));
end $$;

-- Proposes rates (FR-260, FR-261, V61): as 'family' to a provider, or as 'provider' to a member (who
-- gets a family of one without one). 1–12 lines, each a different time entry the provider offers
-- (not_offered), 0–10 000 per hour to the cent, a note ≤ 200; not with my own family (forbidden). A
-- newer proposal withdraws the waiting one of the pair.
create or replace function public.siosia_propose_contract(p_to text, p_as text, p_rates jsonb, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); v_other uuid; v_provider uuid; v_client uuid; v_fid uuid;
  v_note text := btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)); r jsonb; v_rate numeric; v_seen text[] := '{}';
  v_rates jsonb := '[]'::jsonb; e jsonb; k contracts; m uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  if p_as is null or p_as not in ('family', 'provider') then return siosia_err('bad_input'); end if;
  select user_id into v_other from profiles where public_id = p_to and not deleted;
  if v_other is null or v_other = v_uid or not siosia_member_ok(v_other) or not siosia_same_realm(v_uid, v_other) then
    return siosia_err('not_found');
  end if;
  if siosia_same_family(v_uid, v_other) then return siosia_err('forbidden'); end if;
  v_provider := case when p_as = 'family' then v_other else v_uid end;
  v_client := case when p_as = 'family' then v_uid else v_other end;
  if char_length(v_note) > 200 then return siosia_err('bad_input'); end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'array' or jsonb_array_length(p_rates) not between 1 and 12 then
    return siosia_err('bad_input');
  end if;
  for r in select x from jsonb_array_elements(p_rates) x loop
    if jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'serviceId') <> 'string' or jsonb_typeof(r -> 'perHour') <> 'number'
       or (r ->> 'serviceId') = any (v_seen) then
      return siosia_err('bad_input');
    end if;
    v_rate := (r ->> 'perHour')::numeric;
    if v_rate < 0 or v_rate > 10000 or v_rate <> round(v_rate, 2) then return siosia_err('bad_input'); end if;
    e := siosia_service(r ->> 'serviceId');
    -- 2.8 (V68): any enabled service — a contract is how a person who lists nothing takes one on.
    if e is null or e ->> 'kind' <> 'time' or not coalesce((e ->> 'enabled')::boolean, false) then
      return siosia_err('not_offered');
    end if;
    v_seen := v_seen || (r ->> 'serviceId');
    v_rates := v_rates || jsonb_build_array(jsonb_build_object('serviceId', r ->> 'serviceId', 'perHour', v_rate));
  end loop;
  v_fid := coalesce(siosia_family_of(v_client), siosia_new_family(v_client));
  perform pg_advisory_xact_lock(hashtextextended(v_fid::text || v_provider::text, 7));
  update contracts set status = 'withdrawn', ended_at = now(), ended_by = v_uid
   where family_id = v_fid and provider_id = v_provider and status = 'proposed';
  insert into contracts (family_id, provider_id, version, rates, note, currency, proposed_by, proposed_side)
  values (v_fid, v_provider,
          coalesce((select max(version) from contracts where family_id = v_fid and provider_id = v_provider), 0) + 1,
          v_rates, v_note, (select currency from app_config where id = 1), v_uid, p_as)
  returning * into k;
  for m in select x from unnest(case when p_as = 'family' then array[v_provider]
                                     else (select array_agg(user_id) from family_members where family_id = v_fid) end) x loop
    perform siosia_push(m, 'contract_proposed', null, jsonb_build_object('sender', siosia_nick(v_uid)));
  end loop;
  perform siosia_notify_contract(k);
  return siosia_ok(siosia_contract_json(k, v_uid));
end $$;

-- The other side accepts (binding; an active contract of the pair is replaced) or declines (FR-261).
create or replace function public.siosia_answer_contract(p_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); k contracts; m uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  if p_decision is null or p_decision not in ('accept', 'decline') then return siosia_err('bad_input'); end if;
  select * into k from contracts where id = p_id and (provider_id = v_uid or family_id = siosia_family_of(v_uid)) for update;
  if k.id is null then return siosia_err('not_found'); end if;
  if k.status <> 'proposed' then return siosia_err('illegal_transition'); end if;
  if not siosia_contract_answers(v_uid, k) then return siosia_err('forbidden'); end if;
  if p_decision = 'accept' then
    update contracts set status = 'replaced', ended_at = now(), ended_by = v_uid
     where family_id = k.family_id and provider_id = k.provider_id and status = 'active' and id <> k.id;
    update contracts set status = 'active', answered_at = now() where id = k.id returning * into k;
  else
    update contracts set status = 'declined', answered_at = now() where id = k.id returning * into k;
  end if;
  for m in select x from unnest(case when k.proposed_side = 'family'
                                     then (select array_agg(user_id) from family_members where family_id = k.family_id)
                                     else array[k.provider_id] end) x loop
    perform siosia_push(m, case when p_decision = 'accept' then 'contract_accepted' else 'contract_declined' end, null,
                        jsonb_build_object('sender', siosia_nick(v_uid)));
  end loop;
  perform siosia_notify_contract(k);
  return siosia_ok(siosia_contract_json(k, v_uid));
end $$;

-- The proposing side takes back a proposal that still waits.
create or replace function public.siosia_withdraw_contract(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); k contracts;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  select * into k from contracts where id = p_id and (provider_id = v_uid or family_id = siosia_family_of(v_uid)) for update;
  if k.id is null then return siosia_err('not_found'); end if;
  if k.status <> 'proposed' then return siosia_err('illegal_transition'); end if;
  if siosia_contract_answers(v_uid, k) then return siosia_err('forbidden'); end if;
  update contracts set status = 'withdrawn', ended_at = now(), ended_by = v_uid where id = k.id;
  perform siosia_notify_contract(k);
  return siosia_ok('true'::jsonb);
end $$;

-- Either side ends an active contract (FR-263); appointments keep their frozen prices.
create or replace function public.siosia_end_contract(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); k contracts; m uuid;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  select * into k from contracts where id = p_id and (provider_id = v_uid or family_id = siosia_family_of(v_uid)) for update;
  if k.id is null then return siosia_err('not_found'); end if;
  if k.status <> 'active' then return siosia_err('illegal_transition'); end if;
  update contracts set status = 'ended', ended_at = now(), ended_by = v_uid where id = k.id;
  for m in select x from unnest(case when k.provider_id = v_uid
                                     then (select array_agg(user_id) from family_members where family_id = k.family_id)
                                     else array[k.provider_id] end) x loop
    perform siosia_push(m, 'contract_ended', null, jsonb_build_object('sender', siosia_nick(v_uid)));
  end loop;
  perform siosia_notify_contract(k);
  return siosia_ok('true'::jsonb);
end $$;

-- The summary notification (FR-271, FR-272): with a total, once when done — to the client, their
-- family and the provider — and again on a correction (the client's side only).
create or replace function public.siosia_announce_cost(a public.appointments, p_corrected boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_cost jsonb := siosia_cost_json(a); m uuid;
begin
  if v_cost is null or jsonb_typeof(v_cost -> 'total') = 'null' or (not p_corrected and a.summary_sent) then return; end if;
  update appointments set summary_sent = true where id = a.id;
  for m in select distinct x from unnest(siosia_household(a.client_id)
                                         || case when p_corrected then '{}'::uuid[] else array[a.provider_id] end) x
            where x is not null loop
    perform siosia_push_appt(m, 'appt_summary', a.id,
                             siosia_appt_params(a) || jsonb_build_object('minutes', v_cost -> 'minutes', 'total', v_cost -> 'total',
                                                                         'currency', a.currency, 'corrected', p_corrected));
  end loop;
end $$;

-- The provider corrects the time within 24 h after the end (FR-272): 15–1440 minutes on the quarter
-- hour; the booked time clears it. The client's side hears the new total.
create or replace function public.siosia_set_actual(p_id uuid, p_minutes int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); a appointments;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into a from appointments x where x.id = p_id and siosia_sees(v_uid, x) for update;
  if a.id is null then return siosia_err('not_found'); end if;
  if a.provider_id is distinct from v_uid then return siosia_err('forbidden'); end if;
  if a.status <> 'done' then return siosia_err('illegal_transition'); end if;
  if now() > coalesce(a.ended_at, a.starts_at + make_interval(mins => a.duration_min)) + interval '24 hours' then
    return siosia_err('window_closed');
  end if;
  if p_minutes is null or p_minutes not between 15 and 1440 or p_minutes % 15 <> 0 then return siosia_err('bad_input'); end if;
  update appointments set actual_min = case when p_minutes = duration_min then null else p_minutes end
   where id = a.id returning * into a;
  perform siosia_announce_cost(a, true);
  return siosia_ok(siosia_appointment_json(a, v_uid));
end $$;

-- One side of a week (ReportSide, V64): done appointments by their start — as the client (spent) or
-- the provider (earned) — grouped by the other side's nickname and the service; completed rides by
-- their end — as the rider or the driver.
create or replace function public.siosia_report_side(p_people uuid[], p_start timestamptz, p_end timestamptz, p_earned boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  with ap as (
    select a.service_id, siosia_cost_json(a) as cost,
           coalesce(nullif((select p.nickname from profiles p
                             where p.user_id = case when p_earned then a.client_id else a.provider_id end), ''), 'Deleted user') as who
      from appointments a
     where a.status = 'done' and a.starts_at >= p_start and a.starts_at < p_end
       and case when p_earned then a.provider_id = any (p_people) else a.client_id = any (p_people) end),
  lines as (
    select who, service_id, count(*)::int as n, sum((cost ->> 'minutes')::int)::int as minutes,
           round(sum(coalesce((cost ->> 'total')::numeric, 0)), 2) as total
      from ap group by who, service_id),
  rd as (
    select count(*)::int as n, round(coalesce(sum(r.fare), 0), 2) as total from rides r
     where r.status = 'completed' and r.ended_at >= p_start and r.ended_at < p_end
       and case when p_earned then r.driver_id = any (p_people) else r.rider_id = any (p_people) end)
  select jsonb_build_object(
    'total', round(coalesce((select sum(total) from lines), 0) + (select total from rd), 2),
    'services', coalesce((select jsonb_agg(jsonb_build_object('who', who, 'serviceId', service_id, 'count', n,
                                                              'minutes', minutes, 'total', total)
                                           order by total desc, who, service_id) from lines), '[]'::jsonb),
    'servicesTotal', round(coalesce((select sum(total) from lines), 0), 2),
    'rides', (select jsonb_build_object('count', n, 'total', total) from rd));
$$;

-- A week (Monday p_monday, local) for these people: its bounds, spent, earned and the net.
create or replace function public.siosia_week_json(p_people uuid[], p_monday date, p_tz text, p_currency text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'week', to_char(p_monday, 'YYYY-MM-DD'), 'weekStart', siosia_ms(t.s), 'weekEnd', siosia_ms(t.e), 'currency', p_currency,
    'spent', x.sp, 'earned', x.ea, 'net', round((x.ea ->> 'total')::numeric - (x.sp ->> 'total')::numeric, 2))
  from (select p_monday::timestamp at time zone p_tz as s, (p_monday + 7)::timestamp at time zone p_tz as e) t
  cross join lateral (select siosia_report_side(p_people, t.s, t.e, false) as sp, siosia_report_side(p_people, t.s, t.e, true) as ea) x;
$$;

-- The weekly report (FR-280, FR-281): p_week = any day of the week "YYYY-MM-DD" (null = this week),
-- within the last 52 weeks; 'family' sums my family's current members, one line per member.
create or replace function public.siosia_report(p_week text, p_scope text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err text := siosia_guard(true); v_uid uuid := auth.uid(); c app_config; v_cur date; v_mon date; v_day date;
  v_family boolean; v_people uuid[]; v_on boolean;
begin
  if v_err is not null then return siosia_err(v_err); end if;
  perform siosia_sweep();
  select * into c from app_config where id = 1;
  v_cur := date_trunc('week', now() at time zone c.timezone)::date;
  if p_week is null then
    v_mon := v_cur;
  else
    if p_week !~ '^\d{4}-\d{2}-\d{2}$' then return siosia_err('bad_input'); end if;
    begin
      v_day := p_week::date;
    exception when others then
      return siosia_err('bad_input');
    end;
    v_mon := date_trunc('week', v_day::timestamp)::date;
  end if;
  if v_mon > v_cur or v_mon < v_cur - 7 * 52 then return siosia_err('bad_input'); end if;
  if p_scope is null or p_scope not in ('me', 'family') then return siosia_err('bad_input'); end if;
  v_family := cardinality(siosia_household(v_uid)) > 1;
  v_on := p_scope = 'family' and v_family;
  v_people := case when v_on then siosia_household(v_uid) else array[v_uid] end;
  return siosia_ok(siosia_week_json(v_people, v_mon, c.timezone, c.currency) || jsonb_build_object(
    'scope', case when v_on then 'family' else 'me' end,
    'hasFamily', v_family,
    'members', case when v_on then (
      select jsonb_agg(jsonb_build_object('nickname', siosia_nick(m),
                                          'spent', (w -> 'spent' ->> 'total')::numeric, 'earned', (w -> 'earned' ->> 'total')::numeric)
                       order by o)
        from unnest(v_people) with ordinality as u(m, o)
        cross join lateral (select siosia_week_json(array[u.m], v_mon, c.timezone, c.currency) as w) q) end));
end $$;

-- The sweep's family step (V58, V65): lapsed invitations expire; Monday from 08:00 (local) last week's
-- report goes once to everyone who had anything in it. p_now is the clock (now(); tests pass one).
create or replace function public.siosia_sweep_family(p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare c app_config; v_mon date; v_last date; u record; w jsonb; m uuid;
begin
  for m in update family_invites set status = 'expired', answered_at = p_now
            where status = 'pending' and created_at + interval '7 days' <= p_now returning to_user loop
    perform siosia_notify(m);
  end loop;
  select * into c from app_config where id = 1;
  v_mon := date_trunc('week', p_now at time zone c.timezone)::date;
  if c.report_week is not distinct from v_mon or p_now < (v_mon::timestamp + interval '8 hours') at time zone c.timezone then
    return;
  end if;
  update app_config set report_week = v_mon where id = 1;
  v_last := v_mon - 7;
  for u in select user_id from profiles where not deleted order by user_id loop
    begin
      if not siosia_member_ok(u.user_id) then continue; end if;
      w := siosia_week_json(array[u.user_id], v_last, c.timezone, c.currency);
      if jsonb_array_length(w -> 'spent' -> 'services') = 0 and (w -> 'spent' -> 'rides' ->> 'count')::int = 0
         and jsonb_array_length(w -> 'earned' -> 'services') = 0 and (w -> 'earned' -> 'rides' ->> 'count')::int = 0 then
        continue;
      end if;
      perform siosia_push(u.user_id, 'weekly_report', null,
                          jsonb_build_object('spent', w -> 'spent' -> 'total', 'earned', w -> 'earned' -> 'total',
                                             'currency', c.currency, 'week', to_char(v_last, 'YYYY-MM-DD')));
    exception when others then
      raise warning 'siosia_sweep_family: report of % skipped: %', u.user_id, sqlerrm; -- V30
    end;
  end loop;
end $$;

-- A deployment upgraded to 2.6 starts its weekly reports next Monday (none for the weeks before).
update public.app_config set report_week = date_trunc('week', now() at time zone timezone)::date
 where id = 1 and report_week is null;

-- ---------------------------------------------------------------------------------------------
-- Photos in Storage (FR-212, V46): who may read an object — which is what signing its URL takes —
-- and who may write one. Evaluated by the policies on storage.objects as the calling user.
-- ---------------------------------------------------------------------------------------------

-- May p_viewer see p_user's photo? Themselves; the other party of a ride or appointment they
-- share (any status — history shows them too); someone who offers a service (in the catalog).
create or replace function public.siosia_can_see_person(p_user uuid, p_viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not null and p_viewer is not null and (
       p_user = p_viewer
    or exists (select 1 from appointments a
                where (a.client_id = p_user and a.provider_id = p_viewer) or (a.client_id = p_viewer and a.provider_id = p_user))
    or exists (select 1 from rides r
                where (r.rider_id = p_user and r.driver_id = p_viewer) or (r.rider_id = p_viewer and r.driver_id = p_user))
    or (cardinality(coalesce(siosia_offers_of(p_user), '{}'::text[])) > 0 and siosia_member_ok(p_user))
    -- 2.6 (FR-254): my family, and the parties of an appointment my family sees
    or siosia_same_family(p_user, p_viewer)
    or exists (select 1 from appointments a where (a.client_id = p_user or a.provider_id = p_user) and siosia_sees(p_viewer, a)));
$$;

-- May p_viewer see a kid? Its owner's family (2.6), and whoever sees an appointment it is attached
-- to (the provider, FR-202; 2.6: the families of both parties).
create or replace function public.siosia_can_see_kid(p_kid uuid, p_viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_kid is not null and p_viewer is not null and (
       exists (select 1 from kids k where k.id = p_kid and p_viewer = any (siosia_household(k.owner_id)))
    or exists (select 1 from appointment_kids ak join appointments a on a.id = ak.appointment_id
                where ak.kid_id = p_kid and siosia_sees(p_viewer, a)));
$$;

-- Read (sign) an object: its owner always (the row that holds it, else the folder's profile);
-- anyone else only the CURRENT photo of a person or kid they may see — the row that holds the path
-- says whose it is — so a replaced photo is dead at once. Members only; never for a path of another
-- shape. The 2-argument form is the rule itself, for the server and the tests (never granted to
-- clients: an oracle on anyone's photos otherwise — V49); the policies call the 1-argument form.
create or replace function public.siosia_can_see_photo(p_path text, p_viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_viewer is not null and siosia_member_ok(p_viewer) and siosia_photo_folder(p_path) is not null and (
       siosia_photo_owner(p_path) = p_viewer
    or exists (select 1 from profiles p where p.photo_path = p_path and not p.deleted and siosia_can_see_person(p.user_id, p_viewer))
    or exists (select 1 from kids k where k.photo_path = p_path and siosia_can_see_kid(k.id, p_viewer))
    -- 2.5 (FR-234): a session update's photo, to the two parties of its appointment.
    or exists (select 1 from appointment_updates u join appointments a on a.id = u.appointment_id
                where u.photo_path = p_path and siosia_sees(p_viewer, a))), false);
$$;

create or replace function public.siosia_can_see_photo(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select siosia_can_see_photo(p_path, auth.uid());
$$;

-- Write (upload, replace, remove) an object: a member, under the folder of their own public id —
-- profile/<public id>/ or kid/<public id>/<their kid>/ — or an object a row of theirs holds (a
-- merged account's kid under its former folder). Never null (a path of another shape has no owner).
create or replace function public.siosia_photo_upload_ok(p_path text, p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_uid is not null and siosia_member_ok(p_uid) and siosia_photo_folder(p_path) is not null and (
       (exists (select 1 from profiles p where p.user_id = p_uid and not p.deleted and p.public_id = siosia_photo_folder(p_path))
        and (p_path like 'profile/%'
             or exists (select 1 from kids k where k.id = siosia_photo_kid(p_path) and p_uid = any (siosia_household(k.owner_id)))
             -- 2.5 (FR-234): update/<my public id>/<an accepted or done appointment I am a party of>/
             -- (2.6, FR-255: or in the family of its client)
             or exists (select 1 from appointments a where a.id = siosia_photo_appt(p_path)
                         and (a.client_id = p_uid or a.provider_id = p_uid or siosia_same_family(p_uid, a.client_id))
                         and a.status in ('accepted', 'done'))))
    or exists (select 1 from profiles p where p.user_id = p_uid and not p.deleted and p.photo_path = p_path)
    or exists (select 1 from kids k where p_uid = any (siosia_household(k.owner_id)) and k.photo_path = p_path)
    or exists (select 1 from appointment_updates u where u.author = p_uid and u.photo_path = p_path)), false);
$$;

create or replace function public.siosia_photo_upload_ok(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select siosia_photo_upload_ok(p_path, auth.uid());
$$;

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
grant execute on function public.siosia_save_push(text, text, text) to authenticated;
-- 2.0
grant execute on function public.siosia_catalog() to authenticated;
grant execute on function public.siosia_request_service(text, text, timestamptz, int, jsonb, text, jsonb) to authenticated;
grant execute on function public.siosia_answer_appointment(uuid, text) to authenticated;
grant execute on function public.siosia_cancel_appointment(uuid, text, text) to authenticated;
grant execute on function public.siosia_book_ride(jsonb, jsonb, float8, float8, boolean, timestamptz, uuid, text) to authenticated;
grant execute on function public.siosia_set_ride_template(uuid, jsonb) to authenticated;
grant execute on function public.siosia_drop_ride_template(uuid, text) to authenticated;
grant execute on function public.siosia_planned() to authenticated;
grant execute on function public.siosia_timeline() to authenticated;
grant execute on function public.siosia_set_offers(text[]) to authenticated;
grant execute on function public.siosia_save_home(jsonb) to authenticated;
grant execute on function public.siosia_rate_appointment(uuid, int, text) to authenticated;
grant execute on function public.siosia_get_appointment(uuid) to authenticated;
grant execute on function public.siosia_delete_push(text) to authenticated;
-- 2.1
grant execute on function public.siosia_take_request(uuid) to authenticated;
grant execute on function public.siosia_set_car_colour(text, text) to authenticated;
-- 2.3
grant execute on function public.siosia_request_service(text, text, timestamptz, int, jsonb, text, jsonb, uuid[]) to authenticated;
grant execute on function public.siosia_kids() to authenticated;
grant execute on function public.siosia_add_kid(jsonb) to authenticated;
grant execute on function public.siosia_update_kid(uuid, jsonb) to authenticated;
grant execute on function public.siosia_remove_kid(uuid) to authenticated;
grant execute on function public.siosia_set_appointment_kids(uuid, uuid[]) to authenticated;
grant execute on function public.siosia_rate_kid(uuid, uuid, int, text) to authenticated;
grant execute on function public.siosia_set_photo(text, uuid, text) to authenticated;
grant execute on function public.siosia_my_photo_paths() to authenticated;
grant execute on function public.siosia_chat(text, boolean) to authenticated;
grant execute on function public.siosia_send_message(text, text) to authenticated;
-- 2.5
grant execute on function public.siosia_updates(uuid, boolean) to authenticated;
grant execute on function public.siosia_post_update(uuid, text, uuid, text) to authenticated;
grant execute on function public.siosia_delete_update(uuid) to authenticated;
grant execute on function public.siosia_coming_home(uuid, int) to authenticated;
-- 2.6
grant execute on function public.siosia_family() to authenticated;
grant execute on function public.siosia_members() to authenticated;
grant execute on function public.siosia_family_invite(text) to authenticated;
grant execute on function public.siosia_family_answer(uuid, text) to authenticated;
grant execute on function public.siosia_family_withdraw(uuid) to authenticated;
grant execute on function public.siosia_family_leave() to authenticated;
grant execute on function public.siosia_contracts() to authenticated;
grant execute on function public.siosia_propose_contract(text, text, jsonb, text) to authenticated;
grant execute on function public.siosia_answer_contract(uuid, text) to authenticated;
grant execute on function public.siosia_withdraw_contract(uuid) to authenticated;
grant execute on function public.siosia_end_contract(uuid) to authenticated;
grant execute on function public.siosia_set_actual(uuid, int) to authenticated;
grant execute on function public.siosia_report(text, text) to authenticated;
-- 2.8
grant execute on function public.siosia_create_member_invite() to authenticated;
grant execute on function public.siosia_join_link(text, text) to authenticated;
-- evaluated by the Storage policies as the reading / uploading user — about themselves only (the
-- 2-argument rules stay the server's: revoked above with everything else)
grant execute on function public.siosia_can_see_photo(text) to authenticated;
grant execute on function public.siosia_photo_upload_ok(text) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.siosia_claim_push(int) to service_role;
    grant execute on function public.siosia_calendar_view(text, uuid, text, text) to service_role;
  end if;
end $$;
grant execute on function public.siosia_set_online(boolean) to authenticated;
grant execute on function public.siosia_heartbeat(float8, float8) to authenticated;
grant execute on function public.siosia_refresh_offers(float8, float8) to authenticated;
grant execute on function public.siosia_decide_offer(uuid, text) to authenticated;
grant execute on function public.siosia_advance(uuid, text, float8) to authenticated;
grant execute on function public.siosia_depart(uuid) to authenticated;
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
-- Photos (FR-210–212, V46): the private bucket 'photos'. Objects live at profile/<public id>/<file>.jpg,
-- kid/<public id>/<kid id>/<file>.jpg and (2.5) update/<public id>/<appointment id>/<file>.jpg (never
-- an account id, V49); only their owner writes them,
-- and an object can be read — which is what signing its URL takes (the app signs for 1 h at most) —
-- only by a viewer the app would show that person or kid to (siosia_can_see_photo). No public
-- access, ever. Skipped where there is no Storage schema (PGlite tests).
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Storage not found: the photos bucket is not set up here.';
    return;
  end if;
  execute $q$insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
             on conflict (id) do update set public = false$q$;
  -- JPEG only, resized in the browser to 150 KB at most; the cap leaves a little room.
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    execute $q$update storage.buckets set file_size_limit = 262144, allowed_mime_types = array['image/jpeg'] where id = 'photos'$q$;
  end if;
  execute 'drop policy if exists siosia_photos_read on storage.objects';
  execute 'drop policy if exists siosia_photos_insert on storage.objects';
  execute 'drop policy if exists siosia_photos_update on storage.objects';
  execute 'drop policy if exists siosia_photos_delete on storage.objects';
  execute $q$create policy siosia_photos_read on storage.objects for select to authenticated
             using (bucket_id = 'photos' and public.siosia_can_see_photo(name))$q$;
  execute $q$create policy siosia_photos_insert on storage.objects for insert to authenticated
             with check (bucket_id = 'photos' and public.siosia_photo_upload_ok(name))$q$;
  execute $q$create policy siosia_photos_update on storage.objects for update to authenticated
             using (bucket_id = 'photos' and public.siosia_photo_upload_ok(name))
             with check (bucket_id = 'photos' and public.siosia_photo_upload_ok(name))$q$;
  execute $q$create policy siosia_photos_delete on storage.objects for delete to authenticated
             using (bucket_id = 'photos' and public.siosia_photo_upload_ok(name))$q$;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Scheduled jobs (optional): server-side expiry every 10 s and daily retention. If pg_cron is not
-- available the expiry still runs on every API call ("expiry check on read").
-- ---------------------------------------------------------------------------------------------

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net not available (%); notifications are sent only when push-dispatch is called.', sqlerrm;
end $$;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname in ('siosia-sweep', 'siosia-retention');
  perform cron.schedule('siosia-sweep', '10 seconds', 'select public.siosia_sweep()');
  perform cron.schedule('siosia-retention', '17 3 * * *', 'select public.siosia_retention()');
  -- Notifications left over (sender busy or down) are retried every minute.
  perform cron.unschedule(jobid) from cron.job where jobname = 'siosia-push';
  perform cron.schedule('siosia-push', '* * * * *',
    'select public.siosia_kick_push() where exists (select 1 from public.push_outbox where sent_at is null and attempts < 5)');
exception when others then
  raise notice 'pg_cron not available (%); expiry runs on read instead.', sqlerrm;
end $$;
