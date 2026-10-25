# Architecture

Static PWA + managed backend on free tiers, exactly the class of system Rubber proved (spec §2,
§10). This page records the decisions that are not obvious from the code.

## One interface, two backends

`src/backend/types.ts` defines `Backend`. Every screen talks only to it.

| | Mock (`src/backend/mock`) | Supabase (`src/backend/supabase`) |
| --- | --- | --- |
| Server rules | `Engine` (`src/core/engine.ts`) run in the browser | SQL functions (`supabase/migrations/0001_siosia.sql`) |
| Durable state | one JSON document in `localStorage`, every call under a Web Lock (atomic across tabs) | Postgres tables, RLS, all writes through `SECURITY DEFINER` functions |
| Realtime | `BroadcastChannel` + in-tab bus with presence TTL | private Realtime channels, Broadcast from Database |
| Identity | per tab (`sessionStorage`) → two tabs = two users | anonymous auth, optional email/Google linking |
| Used by | demo deployments (`?backend=mock`), unit/integration/e2e tests | production |

The `Engine` is the reference implementation; the SQL is its twin. Both are tested: the engine by
`tests/unit/engine.test.ts`, the SQL by `tests/unit/sql-backend.test.ts` (the real migration in
PGlite). Change a rule → change both.

## Dispatch without storing positions: ping + pull

The spec wants broadcast dispatch to every idle driver within 8 km (§6) **and** no stored
positions (FR-043). The server therefore never learns where drivers are except for an instant:

1. `request_ride` inserts the ride; a trigger sends a **data-less `ping`** on the `drivers` topic.
2. Every online driver's phone answers immediately with `heartbeat(coarse lat, lng)`.
3. The function computes the distance to each open request's pickup, creates an offer when the
   driver is eligible (online, fresh, idle, not the rider, not excluded, ≤ 8 km) and forgets the
   position. Offers reach the driver as a `changed` event on `user:<id>`.

Heartbeats also run every 4 s while online, so a driver who comes online or finishes a trip pulls
open requests (§6 rule 4) and liveness is known:

| Silence | Effect |
| --- | --- |
| > 12 s | the driver's cards are withdrawn; a request from the same user is no longer refused (FR-005 applies to live sessions only) |
| > 60 s, idle | the driver is set offline (a short screen lock is tolerated) |
| > 15 min, accepted/arrived (booked: also not before 15 min after the booked time) | the ride is re-dispatched without them (§12 says 60 s; iPhones pause the app — see the deviations); an `in_progress` ride waits |

A card withdrawn for a driver-side reason (went offline, went silent, won another ride) is offered
again once the driver is eligible; a lapsed countdown comes back after `offer_retry_s`
(0 = never); a decline holds for the rest of that online session. Going online (offline → online)
and **Show requests** (`siosia_refresh_offers`) clear the driver's declined/lapsed cards on open
requests, so every pending request in range is offered again at once (one card, the rest queued).
Only a driver who cancelled after accepting stays excluded from that ride. Heartbeats and Show
requests also return `nearbyRequests` — open requests within the dispatch radius of the coarse
position sent with that call (counted, never stored).
`driver_status` holds only `online` and `last_seen` — no coordinates. Dispatch pings are never
dropped on the client: a ping that arrives while a heartbeat is in flight triggers one more.

## Server-side guarantees

- **Atomic claim**: `UPDATE rides SET status='accepted', driver_id=… WHERE id=… AND status='requested' AND round=…`.
  The loser gets `taken`. Partial unique indexes: one active ride per rider and per driver, one
  `offered` card per driver.
- **Lifecycle**: every transition checks the current status and the caller (§5 table).
- **Fare** computed in SQL from the estimate (never shorter than the straight line), frozen on the
  row; re-dispatch keeps it.
- **Expiry** "on read": every API call runs `siosia_sweep()` (offer timeouts, request expiry,
  stale and lost drivers); `pg_cron` also runs it every 10 s when available.
- **Clock skew**: countdowns use `serverNow` returned with every state (smoothed offset).
- **Access**: clients cannot read or write any table directly (RLS is enabled as a second line);
  the functions return only what each party may see, so no other user's id ever reaches a client.
  Realtime topics are private — `ride:<id>:<round>` only for that assignment's two parties while
  active (a re-dispatch opens a new topic, so a removed driver hears nothing more), `user:<id>`
  only for that user, `drivers` presence writable only by online drivers.
- **Race-safe sweep**: expiry and lost-driver re-dispatch lock their candidate rows
  (`FOR UPDATE SKIP LOCKED`) and update only if the ride is still in the expected status, so a
  concurrent Accept, Start or Cancel always wins.
- **Presence privacy**: nearby-car presence uses a random key per idle period, never the user id,
  so a rider cannot follow one driver over time.

## Client cadences (budget levers, `src/core/defaults.ts`)

| Stream | Cadence |
| --- | --- |
| Live position to the other party | every 3 s or 25 m, keep-alive 5 s, immediate resend when the peer joins. A peer that leaves the channel loses its marker within 10 s; a silent rider's pin is also dropped after 10 s, while a silent driver stays as a greyed "last seen" car (§12 screen lock) |
| Nearby-cars presence (coarse ~100 m) | every 30 s or 200 m, idle drivers only |
| Driver heartbeat | every 4 s while online |
| Rider state poll (backs up realtime, runs expiry) | every 5 s during an active request/ride |
| Routing | ≤ 1 req/s; during a trip re-route only on > 100 m deviation, ≤ 1 per 10 s |
| Geocoding | explicit Search / pin drop only, ≤ 1 req/s, cached per session |

## Deviations from the spec, on purpose

- **Requests stay open 20 minutes** (spec: 3 min), set per deployment by
  `app_config.request_expiry_s` (30 s – 2 h) — operator decision of 2026-10-10. Because requests
  live that long, a card a driver *let lapse* is offered to them again after
  `app_config.offer_retry_s` (default 120 s, 0 = never) while the request is open. The rider's
  screen shows until when it keeps looking.
- **Declines are not permanent** (spec §6: final) — operator decision of 2026-10-10. A driver who
  goes online reviews every pending request nearby again, including ones they declined or missed
  earlier, and **Show requests** on the driver screen does the same on demand, next to a live
  count of pending requests nearby. Within one online session a Decline holds until the driver
  taps Show requests.

- **Master profiles** (operator decisions of 2026-10-11; the spec has one profile per device): a
  shared identity opened by a link `#master=<token>` (`master_profiles`, token stored as SHA-256,
  `siosia_join_master`). The link replaces the invite code; the phone's own anonymous user joins
  the profile (`profiles.master_id`) and takes its nickname and icon in one `role`: a **rider**
  profile cannot drive (`rider_only`), rides at `fixed_fare` and starts from
  `default_pickup` / `default_dropoff`; a **driver** profile cannot ride (`driver_only`) and gets
  its preset `vehicle`. The other party sees the icon next to the nickname and as the map marker.
  The fragment never reaches the web server and is removed from the address bar on arrival.

- **Home Screen app on iOS** (operator request of 2026-10-11): iOS gives a Home Screen web app its
  own storage, so the browser's anonymous session is not there. A one-time **move code**
  (`account_transfers`, SHA-256, 30 min, rate-limited like invite codes) moves the profile, history,
  ratings, vehicle and master link to the app's account (`siosia_redeem_transfer`). Web apps get no
  background execution on iOS; drivers keep the app open while on duty.
- **A driver's app going quiet on a ride** (fix of 2026-10-20, after a rider lost a booked ride's
  driver twice): an iPhone pauses Siosia whenever its screen locks or another app (Apple Maps from
  *Navigate*) is in front, and that drops the realtime connection exactly like a closed app. So (1)
  an *accepted* / *arrived* ride is re-dispatched only after **15 min** without contact (spec §12:
  60 s; `SERVER.rideDriverLostS`, a booked ride also not before 15 min after its time); (2) the
  rider keeps the driver's car greyed at its last position with *last seen … ago* and a note that
  the ride is still on (spec §12 "driver's screen locks") — it disappears only on an explicit stop
  or when the ride ends; (3) a rider's cancellation is not counted once Siosia has given up on the
  driver (the ride searches again with `cancel_reason = 'driver_lost'`); before that it counts as
  usual.
- **Rides booked in advance** (operator request of 2026-10-11): status `scheduled` with
  `scheduled_for`; drivers take bookings (`driver_id` while still scheduled, no overlaps); the sweep
  starts a taken booking (`accepted`, driver on duty) `booking_lead_min` before, opens an untaken one
  to normal dispatch `booking_open_min` before, and gives up 15 min after the booked time.
- **Driver standby**: iOS gives web apps no background execution, so an online driver whose
  app went quiet stays on standby (`driver_status.standby_until`, extended by heartbeats,
  `driver_standby_h` hours, ended by explicit offline) and gets a `request_new` push for each new
  or re-opened request (no position needed — positions are never stored); opening the app brings
  them back online. Drivers whose app is in front (heartbeat < 6 s ago) are skipped.
- **Notifications** (Web Push): `push_subscriptions` per device, events queued in `push_outbox` by
  the server functions and the sweep (only for users with a subscription), sent by the Edge Function
  `push-dispatch` (VAPID secrets there) every minute or on insert. Texts EN/PL live in
  `supabase/functions/_shared/push-text.ts`, shared with the demo backend, which shows its events in
  the page.

- Rider position is sent from **acceptance** (not while still `requested`): nobody can receive it
  before a driver is assigned, so sending earlier would only spend budget and widen exposure.
- An extra offer status `queued` implements "one card at a time, others queue" (§6 rule 5).
- A driver cancelling after *I've arrived* for a reason other than no-show re-dispatches the ride
  (same as before arrival) — the diagram only lists no-show; the reason list of FR-024 implies it.
- Membership is enforced per user server-side; the per-device invite prompt is enforced by the
  client (the device id is not part of the JWT).

## 2.0: a schedule of services next to the rides

Siosia 2.0 (`siosia-spec-v2.0.md`) adds appointments — *Learning*, *Childcare* — between people
of the group, with rides as part of them. The ride engine of 1.x is unchanged; everything new sits
beside it and reuses its bookings.

**Screens.** The start screen S1 is *Siosia* (catalog C1) / *Planned* (P1) / *History* (H1); the
v1 rider and driver screens are reached from the catalog. Navigation is a screen stack in the
store (`home | catalog | planned | history | ride | drive`, browser back returns to S1); requests,
appointments, the profile and the vehicle are panels over it. An active ride, an offer card or an
online driver *holds* its screen (V1): links and buttons that would leave it are ignored, and
leaving D1 online asks to go offline first. Launch opens S1 unless a held screen applies; `?open=`
(planned / history / siosia) and `?mode=` open a screen once and are removed from the address bar.
A notification tapped while the app is open reaches it as a `siosia-open` message from the
service worker.

**Catalog.** `app_config.services` (jsonb, set by the operator with `siosia_set_services`; entries
are disabled, never deleted) holds `ride` (kind `ride`) and the `time` entries with names and
descriptions in EN and PL, icon, duration rule, optional price and whether a place is needed.
Providers turn `time` entries on in `profiles.offers` (a master profile's preset in
`master_profiles.offers` wins). The catalog lists who offers what by **public id**
(`profiles.public_id`, random) — no user id ever reaches a client (FR-143).

**Appointments and series.** `appointments` (client, provider, entry, wall-clock start, duration,
place, note, frozen price, status `requested → accepted | declined | expired → done`, `cancelled`
with who and why, reminders sent) and `appointment_series` (rule weekly / every 2 weeks, count,
ride templates). A repeating request creates the series and every occurrence at once, wall-clock
in the deployment's time zone (`siosia_add_weeks` / `addWeeksWallClock`: a weekly 16:00 stays
16:00 across the DST change). Accept on a series accepts every occurrence that doesn't clash with
the provider's accepted appointments or taken bookings and declines the others, in one
notification each way. *All remaining* cancels every future occurrence (FR-109). "In progress" is
derived; `done` and `expired` are set by the sweep (`siosia_sweep_appointments`, first thing in
`siosia_sweep`).

**Rides as part of a service.** An attached ride is a v1 advance booking with `appointment_id`,
`leg` (there / back) and the passenger being one of the two parties
(`siosia_book_ride` 8-argument overload, at most one live ride per leg and passenger). It lives
the v1 booking life untouched; the appointment shows a summary per ride — pending, confirmed,
done, failed — and the rides trigger tells the *other* party when it changes
(`appt_ride_taken` / `_lost` / `_failed`). Drivers see a plain booking. On a series the ride is a
**template** (passenger, leg, places, offset from the start or end); the sweep books it for every
accepted occurrence once its pickup is within `booking.maxDays` (`siosia_materialize_templates`,
bookings marked `auto_booked`, outside the daily booking limit). Cancelling an appointment cancels
its rides that have not started, with reason `appointment_cancelled`.

**Reminders.** The sweep queues one `appt_reminder` per party per slot of
`app_config.appt_reminder_min` (default `{1440,120}`) once `now ≥ start − slot`, skipping slots
already past when the appointment was requested, and records them in `appointments.reminded`.
The words of every notification — and of the status chips and ride lines in Planned — come from
one module, `supabase/functions/_shared/push-text.ts` (V8), so the app shows exactly what the
reminder says.

**Calendar.** `supabase/functions/_shared/ics.ts` writes the `.ics` of an appointment, a series
or a booked ride as one viewer may see it, and the Google Calendar template link; the app, the
demo download and the Edge Function `calendar` all use it. The server gives each party a link
`<calendar_function_url>?a|s|r=<id>&u=<public id>&t=<token>`, the token being an HMAC of the id
and the viewer keyed with `push_secret` (`siosia_ics_token`); the function reads through
`siosia_calendar_view` (service role only: checks the token and the party, returns that viewer's
view) and answers `text/calendar` or 404, logging nothing. The calendar entry is a copy; there is
no subscription feed.

**Demo.** The mock backend runs a robot **Siosia** next to the robot drivers
(`src/backend/mock/siosiaRobot.ts`, one tab per browser under a Web Lock): she offers Learning and
Childcare, accepts within 5 s and books a ride there when the start is at least 1 h ahead.
`?siosia=0` turns her off.

**Tests.** The engine's appointment rules (`tests/unit/appointments.test.ts`) and the SQL twin
(`tests/unit/sql-v2.test.ts`, the real migration in PGlite) run the same cases; `ics.test.ts`
covers the calendar module and function; `screens-v2.test.tsx` the new screens;
`tests/e2e/v2.spec.ts` the flows across three pages.

**2.1: open requests and the car colour** (2026-10-21, `siosia-spec-v2.0.md` "Amendment 2.1",
SPEC.md V34–V38). A request may have no provider (`appointments.provider_id` and
`appointment_series.provider_id` nullable): it is *open*. Every other member sees it as a
*candidate* (`siosia_planned().open`, `MyState.openRequests`; the candidate view carries no rides,
ratings or calendar links, and never anyone's My place or user id) and gets one `appt_open`
notification. `siosia_take_request` claims and accepts in one transaction: the first taker wins
(`taken` for the rest), the client cannot take their own, a clash with the taker's accepted
appointments or taken bookings fails with `overlap` and leaves the request open — for a series only
when no date is free (SPEC B6); otherwise the series is taken as a whole with clashing dates
declined. Locks are taken series-first everywhere (take, answer, cancel) so a take racing a withdraw
cannot deadlock. The accept body moved into the internal `siosia_answer_as`; the public
`siosia_answer_appointment` keeps its signature. Open requests expire and remind the client only.
`vehicles.paint` (`#rrggbb`, set with `siosia_set_car_colour`) travels in every public party as
`paint`, so a car icon is drawn in that colour wherever the person appears; the icon's SVG derives
its shades from the paint (`src/components/profileIcons.ts`). The demo's robot Siosia takes open
requests for her services after 15 s, so a person in another tab sees them first.

**2.2: the car sets off, Google Maps, info icons** (2026-10-22, "Amendment 2.2", SPEC.md V40–V42).
The server never sees a driver's live position during a ride (it travels rider-ward over the
private channel), so "the car started moving" is detected on the driver's phone: once the fix is
150 m from where the ride began there (`DEPART_M`, `src/state/runtime.ts`), the phone calls
`siosia_depart` once; the server sets `rides.departed_at`, pushes `driver_departed` to the rider
and R3 reads "Your driver has set off". Repeats are no-ops, so a reload simply measures again.
Directions open Google Maps on every phone (`navigationUrl`). Explanations live behind a round *i*
(`src/components/InfoTip.tsx`: 5 s popup, closes on a second tap or a tap elsewhere).

**2.3: kids, kid ratings, photos, chat** (2026-10-22, "Amendment 2.3", SPEC.md V44–V48). This
widens the 1.x "nickname is the only personal field" rule on purpose, member by member: `kids`
rows belong to their owner and reach only the provider of an appointment they are attached to
(`appointment_kids`; a candidate of an open request sees a count, drivers nothing); the provider
rates each attached kid once after the appointment (`kid_ratings`, never touching the owner's own
rating). Photos are resized on the phone (`src/components/photo.ts`) and uploaded by their owner to
the private bucket `photos`; tables keep only the object path, and every view that may show a
person or a kid turns the path into a signed URL (≤ 1 h) in the adapter — the mock keeps data URLs.
Chat rooms are `ride:<id>` (rider + current driver; a re-dispatch drops the old driver) and
`appt:<id>` (client + provider): `messages` rows written through `siosia_send_message` (party
check, 24 h after the end, 30 per 10 min), delivered live over the existing private per-user
channel and pushed as `chat_message` (tag per room) unless the recipient is driving an
`in_progress` ride. Read marks are set when the thread is visible.

**2.5: session updates and heading home** (2026-10-23, "Amendment 2.5", SPEC.md V54–V57).
`appointment_updates` rows (author, an optional kid — its name copied at post time — a text and/or
a photo path under `update/<author's public id>/<appointment id>/`) are written through
`siosia_post_update` by the two parties of an accepted or done appointment, from 30 min before the
start until 7 days after the end, and read through `siosia_updates`, which also stamps the reader's
presence (`chat_presence`, room `feed:<id>`) so a `session_update` push skips a feed that is in
front — the chat's mechanics, reused. Photo ownership stays row-based (V49): the Storage policies
accept the new path shape for a party of that appointment. "Heading home" stores only two
timestamps on the appointment (`coming_at`, `eta_at`): the phone computes the driving minutes
(`services/routing.ts`: OSRM with the straight-line fallback) from its own fix or a searched
address, and `siosia_coming_home` turns them into the notice and one `client_coming` push. The
engine mirrors all of it; the demo robot answers a parent's first note and a heading-home notice.

### 2.0 deviations, on purpose

- **A series in the calendar is written in local time** (spec V27 said UTC): `DTSTART`, `DTEND`
  and `EXDATE` carry `TZID=<deployment time zone>` with a `VTIMEZONE` built from the zone's real
  offset changes, because a weekly rule on a UTC start would move every date after a DST change
  by an hour (SPEC.md B1 → V29). Single events stay in UTC. The Google link uses local dates with
  `ctz`.
- **An online driver keeps D1** (V1) yet still has the v1 *Booked rides → Browse* and *Earnings &
  history* links: they open the same Rides-to-take list and History as panels over D1 instead of
  leaving it, so going online never hides them.
- **Rider's own attached rides** appear inside the appointment's ride line in Planned rather than
  as separate booking cards, to show each item once; Remove ride is on the appointment.

## 2.6: family, contracts, cost summaries, weekly reports

- **Family** = `families` + `family_members` (user_id is the key: one family each) + `family_invites`.
  Everything "for my family" goes through three helpers, twins in the engine: `siosia_household(uid)`
  (me and everyone in my family, first joined first), `siosia_same_family(a, b)` and
  `siosia_sees(uid, appointment)` (a party, or in the family of one). Planned, History, C3, the feed,
  the kids and the photo policies use them; the appointments trigger notifies both parties' households.
  A contract always belongs to a family: a provider proposing to someone without one gives them a
  family of one, which merges into a family they join later.
- **Role `family`** on AppointmentView: party data (kids, rides as a non-passenger, feed, notice,
  cost) with no actions — the existing guards (`client_id = uid` / `provider_id = uid`) already refuse
  them; the UI hides the buttons. A family member of the *client* may post to the feed.
- **Contracts** (`contracts`, one active + one proposed per family and provider by partial unique
  indexes) only set the rate at request time: `appointments.rate` + `contract_id` are frozen with the
  price; ending or replacing a contract never touches booked appointments.
- **Cost** is derived (`siosia_cost_json`): rate × (provider's `actual_min` ?? duration), else the
  fixed price; `summary_sent` makes the done-transition notification once.
- **Weekly report** is computed on read (`siosia_report` / `siosia_week_json`), nothing stored; the
  Monday push is a sweep step gated by `app_config.report_week` (the migration sets it to the current
  Monday, so an upgraded deployment starts next week). `siosia_sweep_family(p_now)` takes the clock
  as an argument so the PGlite test can move it.
