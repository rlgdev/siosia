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
| > 60 s, accepted/arrived | the ride is re-dispatched without them (§12); an `in_progress` ride waits |

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
