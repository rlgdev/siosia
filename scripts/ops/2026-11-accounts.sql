-- =============================================================================================
-- Siosia 2.12 → 2.13: operator SQL for moving the real people to accounts (Supabase SQL editor).
-- docs/plans/2026-10-29-accounts-ultraplan.md (§0 = decisions of 2026-10-30), docs/SETUP.md step 4.
-- Paste ONE block at a time (each starts with "-- @block"). Read-only blocks are marked so.
-- People: Toria (master 'master'), Roman (master 'roman'), Karol, Ań. Everyone signs in on their
-- own phones (self-service absorb); the operator only merges phones nobody has any more (B3).
-- =============================================================================================

-- @block A0-safety (read-only): GoTrue may delete anonymous users older than 30 days; the oldest
-- real account must be migrated before it gets there.
select count(*) as anonymous_older_than_30_days
  from auth.users where is_anonymous and created_at < now() - interval '30 days';
select min(u.created_at) as oldest_real_account
  from auth.users u join public.profiles p on p.user_id = u.id
 where not p.deleted and not public.siosia_sandbox(u.id);
select conname from pg_constraint where conrelid = 'storage.objects'::regclass;  -- expect no *_owner_fkey

-- @block B0-who (read-only): who is who — one row per account of a real (non-sandbox) person.
select p.master_id, p.nickname, count(*) as phones, max(p.seen_at) as last_seen
  from public.profiles p join public.memberships mb using (user_id)
 where not p.deleted and not mb.sandbox
 group by 1, 2 order by 1 nulls last, 2;
select p.public_id, p.nickname, p.master_id, p.seen_at, u.is_anonymous, u.email,
       (select count(*) from public.push_subscriptions s where s.user_id = p.user_id) as push,
       (select count(*) from public.kids k where k.owner_id = p.user_id) as kids,
       (select count(*) from public.family_members f where f.user_id = p.user_id) as family,
       (select count(*) from public.appointments a where a.client_id = p.user_id or a.provider_id = p.user_id) as appts,
       (select count(*) from public.rides r where r.rider_id = p.user_id or r.driver_id = p.user_id) as rides
  from public.profiles p join auth.users u on u.id = p.user_id
 where not p.deleted and not public.siosia_sandbox(p.user_id)
 order by p.master_id nulls last, p.nickname, p.seen_at desc nulls last;
select id, email, is_anonymous, created_at from auth.users where not is_anonymous order by created_at;  -- already signed in
select id, nickname, role, active, joinable from public.master_profiles order by id;
select family_id, provider_id, status from public.contracts where status in ('active', 'proposed');

-- @block B1-snapshot: the only undo on Supabase Free (no backups). Run once, before any merge.
create schema if not exists backup_2026_11;
do $$ declare t text; begin
  foreach t in array array['families','profiles','memberships','vehicles','driver_status','kids','appointment_series',
    'appointments','appointment_kids','rides','offers','ratings','kid_ratings','messages','chat_presence',
    'appointment_updates','family_members','family_invites','contracts','member_invites','notifications','settlements',
    'push_subscriptions','push_outbox','account_transfers','invite_failures','master_profiles'] loop
    execute format('drop table if exists backup_2026_11.%I', t);
    execute format('create table backup_2026_11.%I as select * from public.%I', t, t);
  end loop;
end $$;
select (select count(*) from public.appointments) as appts, (select count(*) from public.rides) as rides,
       (select count(*) from public.kids) as kids, (select count(*) from public.notifications) as bells,
       (select count(*) from public.settlements) as settlements, (select count(*) from public.push_subscriptions) as push;

-- @block B2-nudge (2.12.1): ask the phones still without an account to sign in — a bell entry and a
-- push that opens ☰ → Account. Ask yourself first (the master_id line), check it on your phone, then
-- run it again without that line for everyone. Each anonymous account is asked on its own phones.
select p.nickname, p.public_id, p.master_id, public.siosia_push(p.user_id, 'sign_in', null, '{}'::jsonb)
  from public.profiles p join auth.users u on u.id = p.user_id
 where not p.deleted and p.merged_into is null and u.is_anonymous and not public.siosia_sandbox(p.user_id)
   and p.master_id = 'roman'                                  -- drop this line to ask everyone
 order by p.nickname;

-- @block B3-merge-gone-phone: a phone nobody has any more → the person's account (both by public id
-- from B0). Read the answer: {"ok": {"shape": …}} or {"error": "two_families" | "two_masters" | …}.
select public.siosia_merge_into('<old public id>', '<their public id>');

-- @block B4-verify (read-only): after each person, and at the end.
select p.master_id, p.nickname, count(*) as live_profiles
  from public.profiles p where not p.deleted and not public.siosia_sandbox(p.user_id)
 group by 1, 2 order by 1 nulls last, 2;                                             -- one per person
select p.public_id, p.nickname from public.profiles p join auth.users u on u.id = p.user_id
 where not p.deleted and u.is_anonymous and not public.siosia_sandbox(p.user_id);    -- 0 rows at the end
select from_party, to_party, count(*) from public.settlements group by 1, 2 order by 1, 2;
select (select count(*) from public.appointments) as appts, (select count(*) from public.rides) as rides,
       (select count(*) from public.kids) as kids, (select count(*) from public.notifications) as bells,
       (select count(*) from public.settlements) as settlements;                    -- = the B1 numbers

-- @block C-lockdown: after everyone moved (B4 clean). Undo: auth_mode = 'anonymous'.
update public.master_profiles set joinable = false;
update public.app_config set auth_mode = 'accounts', membership_mode = 'open' where id = 1;
-- then: Authentication → Sign In / Providers → Allow anonymous sign-ins OFF.

-- @block C5-cleanup: at least 30 days after the lockdown. Refuses while a real person is anonymous.
do $$ begin
  if exists (select 1 from public.profiles p join auth.users u on u.id = p.user_id
              where u.is_anonymous and not p.deleted and not public.siosia_sandbox(p.user_id)) then
    raise exception 'a live, real anonymous profile is left — merge it first';
  end if;
end $$;
delete from auth.users u
 where u.is_anonymous
   and (exists (select 1 from public.profiles p where p.user_id = u.id and p.merged_into is not null)
        or public.siosia_sandbox(u.id)
        or not exists (select 1 from public.profiles p where p.user_id = u.id));
select count(*) as anonymous_left from auth.users where is_anonymous;
-- days later, once every phone works: drop schema backup_2026_11 cascade;

-- @block RESTORE: abort the evening — everything back as at B1 (what happened since is lost).
do $$ declare t text;
  tabs text[] := array['families','profiles','memberships','vehicles','driver_status','kids','appointment_series',
    'appointments','appointment_kids','rides','offers','ratings','kid_ratings','messages','chat_presence',
    'appointment_updates','family_members','family_invites','contracts','member_invites','notifications','settlements',
    'push_subscriptions','push_outbox','account_transfers','invite_failures','master_profiles'];
begin
  execute 'truncate ' || (select string_agg(format('public.%I', x), ', ') from unnest(tabs) x) || ' cascade';
  -- master profiles first (profiles and memberships point at them), then in dependency order
  foreach t in array array['master_profiles','families','profiles','memberships','vehicles','driver_status','kids',
    'appointment_series','appointments','appointment_kids','rides','offers','ratings','kid_ratings','messages',
    'chat_presence','appointment_updates','family_members','family_invites','contracts','member_invites','notifications',
    'settlements','push_subscriptions','push_outbox','account_transfers','invite_failures'] loop
    execute format('insert into public.%I select * from backup_2026_11.%I', t, t);
  end loop;
end $$;
