# Siosia — operator setup guide

From an empty account to a working link on two phones in about **45 minutes**, at **zero cost**.
Written for someone who has never used Supabase or GitHub Pages. Each step says where to click and
what to copy. Phone-side instructions for your riders and drivers are in
[USER-GUIDE.md](USER-GUIDE.md).

```
 phones ──HTTPS──▶ GitHub Pages (static app)          ← you deploy here (step 7)
   │
   ├──────────────▶ Supabase Free (database, auth,    ← you create this (steps 1–6)
   │                realtime, server rules)
   └──────────────▶ OpenStreetMap tiles · OSRM routing · Nominatim search (free, nothing to set up)
```

> **Just want to look at it?** The deployed link works without any backend in **demo mode**: add
> `?backend=mock` to the URL. Everything then runs inside one browser, with two robot drivers.

---

## 0. What you need (2 min)

- A **GitHub** account (free) — hosts the code and the website.
- A **Supabase** account (free) — sign up at <https://supabase.com> with your GitHub account.
  The free plan allows 2 active projects; Siosia uses one.
- An **invite code** you will give to your pilot group, e.g. `WAW-PILOT-26`.
- Two phones for the final test (Android Chrome or iOS Safari).

## 1. Create the Supabase project (5 min)

1. <https://supabase.com/dashboard> → **New project**.
2. **Name** `siosia` · **Database password** → *Generate*, store it in your password manager (the
   app never needs it) · **Region** closest to your city (e.g. *Central EU (Frankfurt)*) · plan
   **Free** → **Create new project**. Wait ~2 minutes.

## 2. Create the database (3 min)

1. Left sidebar → **SQL Editor** → **New query**.
2. Open [`supabase/migrations/0001_siosia.sql`](../supabase/migrations/0001_siosia.sql), copy
   **all** of it, paste, press **Run**.
3. Expect *Success. No rows returned.* (A notice about pg_cron is fine.) It created the tables,
   the access rules (RLS), the server functions (atomic accept, request expiry, re-dispatch …),
   the private-realtime policies and two scheduled jobs.

The script is safe to run again later (e.g. after an update). **Upgrading from 1.x to 2.0:** run
the whole file again — it adds the catalog, appointments, series and the new functions and keeps
every ride, profile and setting.

## 3. Set your invite code and contact (2 min)

Still in the SQL editor, run (edit the values):

```sql
select public.siosia_set_invite_code('WAW-PILOT-26');      -- FR-007: stored only as a bcrypt hash
update public.app_config set operator_contact = 'Ola · ola@example.com' where id = 1;
```

Optional — change the tariff, timers or service area. Defaults: PLN, 5.00 + 2.50/km + 0.50/min,
minimum 10.00; a request stays open **20 min**; each offer card counts down 20 s; a driver who
let a card lapse gets it again after 2 min; no-show after 5 min; dispatch radius 8 km; no area
limit.

```sql
update public.app_config set
  request_expiry_s = 1200,   -- how long a ride request waits for a driver: 30 s … 2 h (1200 = 20 min)
  offer_retry_s    = 120,    -- re-offer a missed card after this many seconds (0 = never; going online / Show requests always re-offer)
  offer_timeout_s  = 20,     -- countdown on each driver's offer card: 5 … 120 s
  no_show_wait_s   = 300,    -- wait at the pickup before "Rider no-show": 0 … 3600 s
  currency = 'PLN', fare_base = 5.00, fare_per_km = 2.50, fare_per_min = 0.50, fare_minimum = 10.00,
  service_lat = 52.2297, service_lng = 21.0122, service_radius_km = 25   -- one city
where id = 1;
```

Changes take effect at once, **including for requests already waiting** — lowering
`request_expiry_s` can expire them right away. Riders see the new deadline on their next refresh;
other settings show in the apps after their next launch.

### Optional: master profiles — shared links for a rider or a driver

A master profile is an identity you share as a link. Whoever opens the link becomes that profile
on their phone — no invite code, no nickname step — with the nickname and icon you chose, in
**one role**:

- a **rider** profile rides only, **every ride at the fixed fare** (whatever the distance) and
  starting from a **default pickup and dropoff** (the rider can still change them);
- a **driver** profile drives only, with a **preset car** (without a plate, each phone adds the
  plate once). Riders see its icon on the driver card and as the car on their map.

Several phones can use one link at the same time; each phone keeps its own rides.

Pick a random token of 16–128 characters using only letters, digits, `-` and `_` (other
characters are refused because they break in links), then in the SQL editor:

```sql
-- id, link token, nickname, icon (null or 'taycan-ct-green'), fixed fare, role, pickup, dropoff, car
select public.siosia_set_master('master', '<long random token>', 'Toria', null, 18, 'rider',
  '{"lat": 52.2504843, "lng": 20.8253459, "label": "Warszawsa 269, Stare Babice"}',
  '{"lat": 52.2663135, "lng": 20.814317,  "label": "Husarska 16, Lipków"}');
select public.siosia_set_master('roman', '<another token>', 'Roman', 'taycan-ct-green', null, 'driver',
  null, null, '{"make": "Porsche", "model": "Taycan Cross Turismo", "colour": "Green", "seats": 4}');
-- add "plate": "WX 12345" to the car to preset the plate for every phone on that profile
```

The link is your site address plus `#master=<token>`, e.g.
`https://<you>.github.io/siosia/#master=<token>`. Only a SHA-256 of the token is stored; keep the
link itself like a key.

- **Change name, icon, fare, places, car or role:** run `siosia_set_master` again with the
  **same token** — the link stays the same and the change applies at once to every phone on that
  profile (turning a driver profile into a rider profile takes its phones offline).
- **Replace a leaked link:** run it with a **new token**. The old link stops working and phones
  that joined only through it are signed out of Siosia until they open the new link.
- **Switch a profile off:** `update public.master_profiles set active = false where id = 'roman';`
  — the link stops working and phones that joined only through it lose access (phones that also
  entered the invite code stay, rider-only, at the normal tariff). Running `siosia_set_master`
  again switches it back on.
- A phone that already has its own profile asks before switching to the shared one. A phone
  leaves a master profile with ☰ → *Delete my profile* (it then needs the invite code or a link
  again).

### Optional: rides booked in advance — timings

Riders can book a ride for later; drivers take bookings ahead of time. Defaults (minutes / days):

```sql
update public.app_config set
  booking_min_lead_min = 30,  -- earliest booking: 30 min from now
  booking_max_days     = 30,  -- latest booking: 30 days ahead
  booking_lead_min     = 30,  -- a taken booking starts (driver gets "Time to go") 30 min before
  booking_open_min     = 20   -- an untaken booking goes to drivers nearby 20 min before
where id = 1;
```

A booking whose rider or driver is still busy waits and gives up 15 minutes after its time.

**Driver standby** (needs notifications): after an online driver's app goes quiet (phone locked,
app closed) they still get a notification for every new request for `driver_standby_h` hours
(default 4; 0 = off); tapping it brings them back online. *Go offline* ends it.
`update public.app_config set driver_standby_h = 4 where id = 1;`

### Optional: notifications (Web Push) — 5 min

Notifications tell riders when a driver takes their booking, is coming or has arrived, and tell
drivers about new bookings, new requests (standby) and when it is time to go. On iPhone they work
only in the **Home Screen app** (iOS 16.4 or newer) after the user taps *Turn on notifications*.
There are **no keys to create or paste**: the database makes the sender's secret, and the sender
makes its Web Push key pair on its first run.

1. **Deploy the sender** — either with the [Supabase CLI](https://supabase.com/docs/guides/cli):
   `supabase functions deploy push-dispatch --no-verify-jwt`, or in the dashboard: *Edge
   Functions → Deploy a new function → Via editor*, name `push-dispatch`, paste the contents of
   `supabase/functions/push-dispatch/dist-bundle.ts` (`npm run push:bundle` makes it), deploy, then
   in its *Details* turn **Enforce JWT verification** off.
2. **Tell the database where it is** (SQL editor; `pg_net` and `pg_cron` are enabled by the
   migration where available):
   ```sql
   update public.app_config set
     push_function_url = 'https://<project ref>.supabase.co/functions/v1/push-dispatch',
     site_url = 'https://<you>.github.io/siosia/'
   where id = 1;
   select public.siosia_kick_push();   -- first run: the sender makes its keys
   ```
3. Re-open the app: ☰ → *Siosia as an app* → *Turn on notifications*.

The database calls the sender right after it queues a notification, and every minute while some
are left.

### Optional: services and appointments — the catalog (2.0)

The catalog of what people can ask for is seeded with **Ride**, **Learning** and **Childcare**.
People turn the services they offer on themselves (☰ → *Services I offer*); there is nothing to
do for the defaults. To change the catalog, read it, edit it and save it whole:

```sql
select services from public.app_config where id = 1;      -- the current catalog (JSON)
select public.siosia_set_services('[ … the edited JSON … ]'::jsonb);
```

Each entry: `id` (lowercase, fixed once used), `kind` (`ride` — exactly one — or `time`), `name`
and `description` as `{"en": …, "pl": …}`, `icon` (one emoji), `duration` (`default`, `min`,
`max`, `step` in minutes; `null` for the ride), `price` (`null`, `{"perHour": 80}` or
`{"fixed": 50}`, in the tariff's currency), `needsPlace` (false allows an online lesson) and
`enabled`. Entries are never deleted — set `"enabled": false` to hide one (its appointments stay).
The function refuses a malformed catalog and says why.

Appointment settings (defaults shown):

```sql
update public.app_config set
  appt_reminder_min     = '{1440,120}',  -- reminders a day and two hours before (minutes)
  appt_series_max_days  = 91,            -- a repeating request ends within ~3 months
  appt_series_max_count = 12,            -- at most 12 dates per series
  booking_max_open      = 12             -- open bookings per rider (series rides included)
where id = 1;
```

Reminders are sent by the same server sweep that expires requests — every 10 s under `pg_cron`
(enabled by the migration where available) and on every app call — so without `pg_cron` a
reminder may come late on a quiet evening. For the field test set `appt_reminder_min = '{30,10}'`
for an appointment soon, then put it back.

A master profile can preset what its phones offer — the 10th argument of `siosia_set_master`,
e.g. `array['childcare']`; its phones then see no *Services I offer* toggles.

### Optional: Add to calendar — the calendar function (3 min)

*Add to calendar* always offers **Google Calendar** (a prefilled link, nothing to set up). The
**Apple Calendar / .ics** choice needs the small Edge Function `calendar`, next to `push-dispatch`
on the same free tier:

1. Deploy it — CLI: `supabase functions deploy calendar --no-verify-jwt`; or the dashboard editor:
   name `calendar`, paste `supabase/functions/calendar/dist-bundle.ts` (`npm run calendar:bundle`
   makes it), deploy, then turn **Enforce JWT verification** off (a phone's calendar opens the link
   without signing in; each link carries its own token).
2. Tell the database (and set `site_url` if you haven't for notifications — events link back to it):
   ```sql
   update public.app_config set
     calendar_function_url = 'https://<project ref>.supabase.co/functions/v1/calendar',
     site_url = 'https://<you>.github.io/siosia/'
   where id = 1;
   ```

Each link is `…/calendar?a=<appointment id>&u=<viewer>&t=<token>` (series `s=`, rides `r=`); the
token is an HMAC with the deployment's `push_secret`, so only the two people who see the link in
the app can open it, and each sees only their own view. The function stores and logs nothing.
Added events are copies — they don't update by themselves.

### Optional: photos — the private bucket (2 min)

Profiles and kids may carry a photo (2.3). The migration creates the private Storage bucket
`photos` with its access rules when the project's Storage schema exists; if the SQL editor shows
a notice that it could not, create it by hand: **Storage → New bucket**, name `photos`, *Public
bucket* **off**, then re-run the migration (it adds the object policies). Nothing else: photos are
resized on the phone (≤ 512 px, ≤ 150 KB), uploaded by their owner only, and shown through signed
links that expire within an hour — the bucket must stay private. Objects sit under
`profile/<public id>/…`, `kid/<public id>/<kid id>/…` and (2.5) `update/<public id>/<appointment
id>/…` (never the account id), and a member may only write under their own folders; removing a
kid, an update or a profile removes its objects. The demo keeps photos in the browser.

Session updates and "heading home" (2.5) need nothing new either: re-run the migration (the
`appointment_updates` table, two columns on `appointments`) and redeploy `push-dispatch` (two new
notification kinds, `session_update` and `client_coming`).

Chat (2.3) needs nothing new: messages live in the `messages` table and travel over the private
realtime channels already set up; the `chat_message` notification goes out through `push-dispatch`
(redeploy it after this upgrade, as for every release).

## 4. Authentication settings (4 min, + 15 min for email codes and Google)

Since 2.12 a person signs in with a **6-digit code by email** or with **Google** and has **one
account on all their phones** (FR-326). Until you switch a method on, nobody is asked to sign in and
every phone starts with an anonymous session, as before.

1. **Authentication → Sign In / Providers** (sometimes *Providers*): turn **Allow anonymous
   sign-ins** **ON** → *Save* — for now (see *Lockdown* below). Supabase rate-limits anonymous
   sign-ins per IP (Authentication → Rate Limits); keep it. Do **not** enable CAPTCHA — the app
   doesn't send CAPTCHA tokens.
2. **Authentication → URL Configuration**: set **Site URL** to your site address from step 7
   (e.g. `https://<github-user>.github.io/siosia/`) and add the same with `**` to **Redirect URLs**
   (`https://<github-user>.github.io/siosia/**`; for local testing also `http://localhost:5173/**`
   and `http://localhost:4173/**`). Google comes back to this address. You can come back after step 7.

### Email codes (needs a mail sender)

The built-in Supabase mailer sends a couple of emails an hour and **only to members of your Supabase
team** — your users would never get a code. Use your own sender (free):

1. A Google account with **2-Step Verification** → <https://myaccount.google.com/apppasswords> →
   create an app password "Siosia" (16 characters).
2. **Project Settings → Authentication → SMTP Settings** → *Enable custom SMTP*: host
   `smtp.gmail.com`, port `587`, user = that Gmail address, password = the app password, sender
   email = **the same address** (Gmail rewrites any other), sender name `Siosia` → *Save*.
   **Authentication → Rate Limits** → emails per hour: 30. (Alternative: Brevo's free plan.)
3. **Authentication → Emails → Templates** — Siosia never sends links, only codes:
   - **Confirm signup** (a new address), **Magic Link** (an address seen before), **Change Email
     Address**: subject `Siosia: {{ .Token }}`; body e.g.
     `<h2>{{ .Token }}</h2><p>Your Siosia code. / Twój kod do Siosi.</p>` — no `{{ .ConfirmationURL }}`.
   - **Reset Password**, **Invite user**, **Reauthentication**: replace the body with
     `<p>Siosia never sends links. If you did not expect this email, ignore it. / Siosia nie wysyła
     linków. Jeśli nie spodziewałeś się tego e-maila, zignoruj go.</p>`.
4. **Authentication → Sign In / Providers → Email**: enabled, *Confirm email* ON, *Allow new users
   to sign up* ON (the invite code still decides who becomes a member), OTP length 6, expiry 1800 s.
5. Switch it on — for everyone, so do it right after the SMTP steps, at a quiet moment: in the SQL
   editor `update public.app_config set email_sign_in = true;`, open the site, ☰ → *Account*, and
   send yourself a code. It must arrive within a minute (check Spam); if not, switch it back off
   (`= false`) until the sender works.

### Google

1. <https://console.cloud.google.com> → a new project "Siosia" (no billing) → **APIs & Services →
   Google Auth Platform**:
   - **Branding**: app name `Siosia`, support and developer email (no logo — a logo needs a review);
   - **Audience**: External → **Publish app** (In production; the basic scopes need no
     verification; *Testing* would cap sign-in at 100 listed users with grants that expire);
   - **Data access**: only `openid`, `…/auth/userinfo.email`, `…/auth/userinfo.profile`;
   - **Clients → Create client → Web application** "Siosia web": *Authorized JavaScript origins*
     `https://<github-user>.github.io` (and `http://localhost:5173` for local tests); *Authorized
     redirect URIs*: the **Callback URL** shown in Supabase → Authentication → Providers → Google
     (`https://<project-ref>.supabase.co/auth/v1/callback`). Copy the client ID and secret.
2. **Supabase → Authentication → Providers → Google**: enable, paste the client ID and secret,
   *Skip nonce check* OFF → *Save*. **Allow manual linking** ON (same Sign In / Providers page) lets
   a signed-in person add Google to their account.
3. Switch it on in the SQL editor — where Google is offered:
   `update public.app_config set google_sign_in = 'on';` (`'no_standalone'` hides it in the
   installed Home Screen app, where Google may not come back; `'no_ios'` on iPhones; `'off'`).

### Moving everyone to accounts (the migration window)

With a method switched on, a phone with an anonymous account shows *Sign in to keep your history on
every phone* on the start screen and *Keep my account* in ☰ → *Account*. Signing in takes that
phone's old account along: its profile, history, family seat, contracts, kids, photos, bell and
notifications join the person's account (`siosia_absorb`). Each further phone signs in with the
**same email** and joins the same account. A phone the person no longer has: merge it in the SQL
editor by public ids — `select public.siosia_merge_into('<old public id>', '<their public id>');`
(it refuses two different families, two master profiles or a ride in progress; nothing changes then).

### Lockdown (after everyone moved)

1. `update public.master_profiles set joinable = false;` — master links let no new phone in (phones
   already on a profile keep it, presets included; never use `active = false` for this, it signs
   their phones out).
2. `update public.app_config set auth_mode = 'accounts', membership_mode = 'open';` — anonymous
   sessions must sign in (`sign_in_required`); every signed-in account is a member (no invite code).
   Keep `membership_mode = 'invite'` if new people should still need the code or a `#join=` link.
3. **Authentication → Sign In / Providers → Allow anonymous sign-ins OFF** → *Save*.
4. Undo in seconds: `auth_mode = 'anonymous'` (and the toggle back ON).

## 5. Realtime: private channels only (1 min)

**Realtime → Settings** (or *Project Settings → Realtime*): turn **Allow public access** **OFF** and
save. Live positions then flow only on private channels authorised by the policies from step 2:
a ride's channel is readable only by its rider and driver.

## 6. Copy the two public values (1 min)

**Project Settings → API Keys** (or the **Connect** button):

- **Project URL** — `https://abcdefghijkl.supabase.co`
- **Publishable key** — `sb_publishable_…` (older projects: the **anon / public** key)

> Never copy the **secret** / `service_role` key anywhere. The app only needs the publishable key,
> which is safe in a browser: every rule is enforced in the database.

## 7. Publish the website on GitHub Pages (10 min)

1. Put the code in a GitHub repository under your account — **public** (GitHub Pages is free for
   public repositories). E.g. create `siosia`, then from this folder:
   ```bash
   git remote add origin https://github.com/<github-user>/siosia.git
   git push -u origin main
   ```
2. Repository → **Settings → Pages** → *Build and deployment* → **Source: GitHub Actions**.
3. Repository → **Settings → Secrets and variables → Actions → Variables** tab →
   **New repository variable**, three times:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | Project URL from step 6 |
   | `SUPABASE_PUBLISHABLE_KEY` | publishable key from step 6 |
   | `OPERATOR_CONTACT` | shown when the service is down, e.g. `Ola · ola@example.com` |

4. **Actions → CI → Run workflow** (or push any commit). The workflow lints, type-checks, runs all
   tests (none need credentials), builds with your variables and deploys. After ~4 minutes the
   *deploy* job shows the URL: `https://<github-user>.github.io/siosia/`.
5. Go back to step 4.3 if you skipped the URL configuration.

Other free hosts work too (Cloudflare Pages, Netlify, Vercel): build command `npm run build`,
output folder `dist`, and the environment variables `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_OPERATOR_CONTACT`. The build uses relative paths, so any
sub-path works.

## 8. First run and the two-phone test (10 min)

1. Open the URL on your phone → enter the **invite code** → nickname → **Drive** → vehicle →
   **Go online** (allow location; keep the screen on).
2. Second phone → same URL → invite code → nickname → **Ride** → pickup = your GPS position,
   dropoff by search or long-press → **Request ride**.
3. Accept on the driver phone and follow [FIELD-TEST.md](FIELD-TEST.md) for the full checklist.
4. Share the link and the invite code with your group, together with
   [USER-GUIDE.md](USER-GUIDE.md).

### Optional: live smoke test of the backend (2 min)

First set a **test invite code** once (SQL editor, different from the real one):

```sql
select public.siosia_set_test_invite_code('YOUR-TEST-CODE');
```

Whoever joins with it is a *test account*: test accounts see only each other, and real members
never see them — not in the member list, the catalog, open requests, ride offers or bookings.
Then, from your computer, with the project values and that test code:

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_KEY=sb_publishable_… SIOSIA_TEST_INVITE=YOUR-TEST-CODE npm run smoke
```

It signs in three throwaway anonymous test users (rider, driver, outsider), checks 18 things end
to end (invite gate, private realtime channels, the driver ping, the offer, the atomic accept, live
positions over the ride channel with the outsider refused, lifecycle rules, receipts, RLS) and
deletes the three users again. Expect *All live checks passed.*

An account made with the real code by mistake can be moved into the sandbox (or back) by its
public id: `select public.siosia_set_sandbox('<public id>', true);`

## Running it day to day

| Task | Where |
| --- | --- |
| See rides, offers, ratings | Supabase → **Table Editor** → `rides` (endpoints, totals, times — never live positions) |
| See appointments | **Table Editor** → `appointments` (parties, time, place, note, status, reminders sent) and `appointment_series` (rule, count, ride templates) |
| Kids, kid ratings, chat | `kids` (owner, name, year, note, photo path), `appointment_kids`, `kid_ratings`, `messages`, `chat_presence` (who has which thread open, so no notification interrupts a chat they are reading) — all removed with their appointment / ride / owner, and all moved with the account by a move code; photos in **Storage → photos** |
| Change the catalog or reminders | `siosia_set_services(…)` / `update public.app_config set appt_reminder_min = …` (see *services and appointments* above) |
| Errors and logs | Supabase → **Logs** (API, Postgres, Realtime); browser console on the phone |
| Usage vs. free limits | Supabase → **Settings → Usage**. At the pilot ceiling (§10 of the spec) Siosia stays well inside the free tier; if realtime messages ever run hot, raise the presence cadence in `src/core/defaults.ts` |
| Change the invite code | `select public.siosia_set_invite_code('NEW-CODE');` — existing devices stay joined |
| Change tariff / timers / area | `update public.app_config set … where id = 1;` — applies to new requests |
| Paused project | Free projects pause after 7 quiet days. The **Keep backend awake** workflow pings weekly once `SUPABASE_URL` is set. If it paused anyway: Supabase dashboard → project → **Restore**. The app shows *Service unavailable — retry* (with your contact) meanwhile |
| Remove a user | Authentication → Users → delete; their rides stay, anonymised. (Deleting the profile in the app keeps the sign-in.) |
| Merge a phone someone no longer has (2.12) | `select public.siosia_merge_into('<old public id>', '<their public id>');` — public ids are in `profiles.public_id`; refuses two families, two master profiles, a ride in progress |
| Switch sign-in methods (2.12) | `update public.app_config set email_sign_in = true, google_sign_in = 'on';` (see step 4) |
| Close a master link (2.12) | `update public.master_profiles set joinable = false where id = '<id>';` — its phones keep the profile |
| Update the app | push to `main`; CI tests and redeploys. Re-run the SQL file if `supabase/migrations` changed; redeploy `push-dispatch` / `calendar` (`npm run push:bundle`, `npm run calendar:bundle`) if `supabase/functions` changed |

## Local development against your project

```bash
cp .env.example .env.local      # fill VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY
npm install
npm run dev                     # http://localhost:5173 (add it to Auth → Redirect URLs for Google)
```

`?backend=mock` forces the demo backend at any time. Phones need HTTPS for GPS, so test on phones
with the deployed link.

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| *Service unavailable* right after deploy | Variables missing/typo (step 7.3) → fix and re-run the workflow. Or the project is paused → **Restore** |
| Stuck on *Service unavailable* although the project is up | SQL from step 2 not run (the app calls `siosia_config`) → run it |
| *That invite code is not valid* | Step 3 not run, or a different code. Spaces and letter case don't matter |
| Session error on first launch | Anonymous sign-ins disabled while `auth_mode` is still `anonymous` → step 4.1, or finish the lockdown (step 4) |
| *This Siosia cannot email that address yet* | No custom SMTP: the built-in mailer reaches only your Supabase team → step 4, *Email codes* |
| No sign-in code arrives | Spam / Promotions; Authentication → Logs; the SMTP sender address must be the Gmail account itself |
| Google comes back to the start screen, not signed in | Redirect URL missing (step 4.2) or the Google client's redirect URI is not the Supabase callback URL |
| Driver never gets requests | Driver must be **online**, within 8 km of the pickup, with location allowed and the app open. Check step 5 isn't blocking: the policies come from step 2 |
| Rider never sees the car move | Driver phone screen locked or app in background → keep it open (the app warns). Check Realtime isn't disabled |
| Map tiles/route missing sometimes | Community servers (OSM/OSRM) are best-effort; the app falls back to a straight-line estimate and keeps working |

## Security checklist

- [ ] Only the **publishable** key is in GitHub variables / `.env.local`.
- [ ] Anonymous sign-ins ON during the migration window (OFF after the lockdown, step 4), CAPTCHA OFF, rate limit kept.
- [ ] Email templates send codes only (no `{{ .ConfirmationURL }}` anywhere).
- [ ] Realtime **Allow public access** OFF.
- [ ] Invite code set and shared only with your group.
- [ ] SQL file ran without errors (it revokes direct table writes; all writes go through checked functions).
