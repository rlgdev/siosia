# SPEC — Siosia 2.0 service catalog

Prose spec for review: `siosia-spec-v2.0.md` (§n & FR-nnn below = that doc). v1: `siosia-spec-v0.1.md`. Code baseline: commit `619544e`.

## §G goal

App opens S1 w/ 3 btns: **Siosia** (catalog) | **Planned** | **History**. Client requests service (entry, date, start, duration, place, note) from one provider ("Siosia"). Provider accepts | declines; on accept ? attach ride (there | back) = v1 advance booking linked to appt. Both sides: schedule (P1), history (H1), reminders @ start−24h & start−2h w/ appt status (Confirmed | Waiting for answer | Please answer) & ride status (confirmed(driver) | no driver yet | no driver found). v1 ride loop unchanged = catalog entry `ride`. Series: request ? repeat weekly|biweekly 2–12×, answered as whole, rides via templates on series. Add to calendar on appt|series|booked ride: Google template link | `.ics` via Edge Function `calendar` (Apple/any), alarms = reminder slots. Decisions 2026-10-20: Q9 yes, Q11 no late-cancel counting, Q17 yes.

## §C constraints

- Zero cost, free tiers, no custom server (v0.1 §10). pg_cron sweep 10 s live → reminders ride on `siosia_sweep()`.
- Engine `src/core/engine.ts` = SQL twin `supabase/migrations/0001_siosia.sql` ! change together; both tested (`tests/unit/engine.test.ts`, `tests/unit/sql-backend.test.ts` PGlite).
- All writes via SECURITY DEFINER fns; RLS read own rows; ⊥ other user's auth uid to client → providers referenced by `profiles.public_id`.
- Live positions ⊥ stored (FR-043). Appt stores place + note only (§11).
- Times wall-clock as picked (timestamptz), shown as picked; server = clock (§6).
- EN+PL ∀ strings; `src/i18n/pl.ts` typed vs `en.ts`. Push texts in `supabase/functions/_shared/push-text.ts` shared w/ demo.
- v1 rpc names+signatures kept during transition (cached PWA); new shapes → new fn names (NFR-18, §12).
- Mobile-first 360 px, 44 px targets, AA, reduced motion (v0.1 §8).
- Migration idempotent: re-run whole SQL on live DB (ref `ksnsblfngzlqfdfdaken`); after push-text change `npm run push:bundle` + redeploy `push-dispatch`.
- Demo `?backend=mock` ! full loop incl. robot Siosia; e2e no credentials.
- Budget: ≤ 200 appts/mo, ≤ 10 pushes/appt (NFR-17); calendar fn = user taps only.
- `.ics` link = record id + HMAC(viewer) w/ `push_secret`; viewer's view only; ⊥ positions, ⊥ other uid (NFR-20).

## §I interfaces

screen: S1 Home → btns `start-siosia` | `start-planned` | `start-history` + lang, guide, profile (§3)
screen: C1 Catalog, C2 Request form, C3 Appointment, C4 Accept sheet, P1 Planned (+P2 Rides to take), H1 History; R1–R5, D1–D6 unchanged (§3)
url: `?open=siosia|planned|history`; `?mode=ride|drive` kept; push tap → `./?open=planned`
api `Backend` (`src/backend/types.ts`, §12):
  getConfig() → DeploymentConfig + {services: CatalogEntry[], appointment: {reminderMin: number[], seriesMaxDays, seriesMaxCount}, calendarUrl: string|null, booking.maxOpen}
  catalog() → CatalogEntry[] {id, kind: "ride"|"time", name{en,pl}, description{en,pl}, icon, duration{default,min,max,step}, price: null|{perHour}|{fixed}, needsPlace, enabled, providers: PublicProvider[]{publicId, nickname, icon, rating}}
  requestService({serviceId, providerId, startsAt, durationMin, place|null, note, repeat?: {every: 1|2, count?|until?}}) → AppointmentView (first occurrence, series set)
  answerAppointment(id, "accept"|"decline") → AppointmentView; on series answers whole series, series.declined = clashing dates
  cancelAppointment(id, reason?, scope?: "one"|"series") → void
  planned() → {appointments: AppointmentView[], rides: RideView[]}
  timeline() → HistoryItem[] (merged, ≤ 50 each kind)
  setOffers(ids[]) → Profile; saveHome(Place|null) → Profile
  bookRide(BookingInput & {appointmentId?, leg?: "there"|"back"}) → RideView
  setRideTemplate(seriesId, {leg, pickup, dropoff, offsetMin}) → AppointmentView (creates bookings within horizon at once); dropRideTemplate(seriesId, leg) → void
  calendar links: AppointmentView.calendar & RideView.calendar = {google: string, ics: string|null}; google built client-side, ics = `<calendarUrl>?a|s|r=<id>&u=<public id>&t=<hmac>` (null w/o calendarUrl)
  edge fn `calendar` (supabase/functions/calendar, `npm run calendar:bundle`): GET ?a|s|r,u,t → text/calendar | 404; shared `supabase/functions/_shared/ics.ts` (also demo browser download)
  rateAppointment(id, stars, comment) → void
  myState() → MyState + {toAnswer, planned, nextPlanned: {kind, at, title}|null}
  AppointmentView: id, status, role client|provider, serviceId, startsAt, durationMin, endsAt, place|null, note, price|null, client, provider (PublicParty), requestedAt, answeredAt, endedAt, cancelledBy, cancelReason, rides: AttachedRide[]{rideId, leg, passenger, scheduledFor, status pending|confirmed|done|failed, driver|null, pickup?/dropoff? (passenger only)}, reminders: number[], myRating, series: {id, rule weekly|biweekly, seq, count, until, remaining, declined: number[], rideTemplates[]}|null, calendar; RideView + appointmentId, leg, calendar
sql rpc: siosia_catalog(), siosia_request_service(text, text, timestamptz, int, jsonb, text, jsonb), siosia_answer_appointment(uuid, text), siosia_cancel_appointment(uuid, text, text), siosia_set_ride_template(uuid, jsonb), siosia_drop_ride_template(uuid, text), siosia_planned(), siosia_timeline(), siosia_set_offers(text[]), siosia_save_home(jsonb), siosia_book_ride(… , uuid, text) overload, siosia_rate_appointment(uuid, int, text), siosia_my_state() ext; views add calendar.ics via pgcrypto hmac; operator: siosia_set_services(jsonb), siosia_set_master(…, offers text[]), app_config.calendar_function_url / booking_max_open by update
db (§11): `appointments`(id, client_id, provider_id, service_id, status, starts_at, duration_min, place_lat, place_lng, place_label, note, price, currency, requested_at, answered_at, ended_at, cancelled_by, cancel_reason, reminded int[], series_id, seq); `appointment_series`(id, client_id, provider_id, service_id, rule weekly|biweekly, first_start, duration_min, count 2–12, until, place, note, price, currency, status requested|answered|cancelled|expired, ride_templates jsonb, requested_at, answered_at); `rides` + appointment_id, leg, unique(appointment_id, rider_id, leg); `profiles` + offers text[], home jsonb, public_id (⊥ cancel counters for appts); `master_profiles` + offers; `app_config` + services jsonb, appt_reminder_min int[] '{1440,120}', appt_series_max_days 91, appt_series_max_count 12, booking_max_open 12 (replaces const 5), calendar_function_url; `ratings` + appointment_id (ride_id nullable, xor); `push_outbox` + appointment_id
push kinds (§8): appt_new, appt_accepted, appt_declined, appt_cancelled, appt_expired, appt_reminder, appt_ride_added, appt_ride_taken, appt_ride_lost, appt_ride_failed — texts EN/PL in §8 table
err new: bad_service, not_offered, no_provider, bad_duration, not_accepted, bad_leg, ride_exists, bad_repeat; reuse bad_time, too_many, overlap, illegal_transition, not_found, forbidden, rider_only, driver_only, already_rated, window_closed
realtime: `user:<uid>` "changed" on appointments insert|update → both parties; no new channels
cfg: live `app_config.services` + cols + calendar_function_url; demo `config.json` deployment.services + deployment.appointment (calendarUrl null → browser-built ics)
push `{range}` for series: "every Tue 16:00–17:00, 28 Oct – 16 Dec (8×)"; clashes "7 of 8 confirmed; declined: 11 Nov"; All remaining "from 25 Nov, 4 left" (EN/PL §8)
catalog seed: ride (kind ride), learning (60, 30–240, 30), childcare (180, 60–720, 30); ≤ 12 entries; disable ⊥ delete
i18n key groups: start.*, catalog.*, appt.*, planned.*, offers.*, place.*

## §V invariants

V1: launch → S1; ∃ active ride | offer card → that ride screen; driver online → D1; offline | ride end → S1; ⊥ sticky mode (FR-082)
V2: appt status ∈ {requested, accepted, declined, cancelled, expired, done}; transitions only per §6 table; server validates status & caller; engine = SQL
V3: request ! entry enabled & kind time & provider offers it & provider ≠ client & starts_at ∈ [now+booking.minLeadMin, now+booking.maxDays] & duration ∈ [min,max] on step & (place | ¬needsPlace) & note ≤ 200; price frozen
V4: client open appts (requested|accepted, future) ≤ 10 & new per day ≤ 20 → else `too_many`
V5: accept → ⊥ overlap w/ provider's accepted appts | taken bookings as driver → `overlap`; atomic `WHERE status='requested' AND provider_id=…`
V6: sweep: requested & now ≥ starts_at → expired (+ push client); accepted & now ≥ starts_at+duration → done; in-progress derived, ⊥ stored
V7: ∀ appt ∈ {requested, accepted} ∀ party ∀ slot ∈ reminderMin: now ≥ starts_at−slot & requested_at ≤ starts_at−slot & slot ∉ reminded → push appt_reminder once; reminded marked in same statement; ⊥ for declined|cancelled|expired|done (FR-120–122)
V8: reminder & P1 words identical, one source each side (client, push-text), tested EN+PL: Confirmed | Waiting for an answer from {provider} | Please answer; per ride: Ride {leg}: {driver} ✓ | no driver yet | no driver found (NFR-16)
V9: attached ride ! appt accepted & passenger ∈ parties & ≤ 1 per (appt, passenger, leg) & there: scheduled_for < starts_at & back: scheduled_for ≥ starts_at & v1 booking rules (lead, overlap, fare frozen); derived pickup < minLeadMin ahead → refuse, point to Ride→Now (FR-110–112)
V10: cancel appt → attached rides ∈ {scheduled, requested, accepted, arrived} → cancelled `appointment_cancelled`, drivers pushed booking_cancelled; in_progress untouched; passenger may remove ride alone
V11: non-passenger sees of ride only leg, scheduled_for, status, driver{nickname, icon}; driver sees plain booking, ⊥ appt (FR-114, NFR-19)
V12: ride summary none|pending|confirmed|done|failed per §7.7; pending↔confirmed, →failed → push other party appt_ride_taken|lost|failed; passenger ⊥ doubles (keeps v1 kinds)
V13: dropped 2026-10-20 (Q11): appt cancel ⊥ counted anywhere; row keeps cancelled_by + at + reason; v1 ride counters unchanged
V14: ⊥ auth uid of another user reaches any client; catalog/request use `public_id`
V15: appt row = parties, service_id, times, place|null, note, price, statuses, reminded; ⊥ other location; retention 12 mo; delete profile → upcoming cancelled `user_gone` (+ push), finished anonymised
V16: master rule on Ride only: rider-master ⊥ offer ride (`rider_only`), driver-master ⊥ request ride (`driver_only`); other entries per `offers`; master `offers` null → driver {ride} | rider {}
V17: P1 = all upcoming both roles (appts requested|accepted incl. Now first; rides scheduled as rider|driver; active ride) grouped Today|Tomorrow|date, soonest first; providers: To answer first; drivers: Rides to take (N); H1 = finished both kinds newest first ≤ 50 each + driver earnings
V18: push only to subscribers (v1), recipient lang + deployment tz, tag `<kind>:<appt id>`, url `./?open=planned`; demo shows in page
V19: ∀ §V: engine test + SQL test (PGlite) same cases
V20: v1 rpc signatures unchanged; v1 unit + e2e green
V21: catalog: ids `^[a-z][a-z0-9_]{1,23}$` unique, exactly one kind ride (id ride), ≤ 12, 15 ≤ min ≤ default ≤ max ≤ 1440, step ∈ {15,30}; `siosia_set_services` rejects else
V22: S1 badges from MyState (toAnswer, planned, nextPlanned) refresh on `changed`
V23: series ! rule ∈ {weekly, biweekly} & count ∈ [2, seriesMaxCount] & first start ∈ [now+minLeadMin, now+booking.maxDays] & last ≤ now+seriesMaxDays & same provider/duration/place/note/price ∀ occurrence; 1 `appt_new` per series; limits: open single ≤ 10 & open series ≤ 3 & new/day ≤ 20 (series = 1) → else too_many | bad_repeat
V24: accept on requested series → ∀ occurrence: ¬clash → accepted, clash (provider's accepted appts | taken bookings) → declined; 1 push each party listing declined dates; decline → all declined; unanswered & now ≥ first start → whole series expired, 1 push client
V25: cancel scope one → that occurrence; scope series → ∀ future requested|accepted occurrence cancelled + series cancelled; 1 push other party; cascade rides per V10; cancelled|declined occurrence stays as gap (EXDATE)
V26: ride template on series (passenger, leg, pickup, dropoff, offsetMin) → booking ∀ accepted occurrence w/ pickup ≤ now+booking.maxDays: at once on set, then sweep ≤ daily; per-occurrence remove keeps template; drop template keeps existing bookings; open bookings per rider ≤ booking.maxOpen (12); template bookings ∉ new/day limit
V27: `.ics` (shared module, server & demo): UID = record id, SUMMARY "{service} with {other}" | "Ride: {pickup} → {dropoff}", DTSTART/DTEND UTC (single appt, ride; series per V29), LOCATION+GEO from place, DESCRIPTION = note + ride lines per V11, URL `?open=planned`, VALARM ∀ reminder slot (ride: −30 min), series → single VEVENT w/ RRULE FREQ=WEEKLY;INTERVAL=1|2;COUNT=n + EXDATE per cancelled|declined, cancelled → STATUS:CANCELLED; served only w/ valid HMAC token for that viewer else 404; ⊥ positions, ⊥ other uid
V28: Google link = calendar.google.com/calendar/render?action=TEMPLATE&text&dates(start/end)&ctz=deployment tz&location&details(+ link)&recur=RRULE… for series; built client-side from the view; offered always; Apple/.ics offered iff calendarUrl | demo; action says once "events don't update by themselves"
V29: series `.ics` & Google link keep wall-clock ∀ date across DST: series VEVENT DTSTART/DTEND/EXDATE = local time `;TZID=<deployment tz>` + VTIMEZONE from tz's real offset changes over series range (⊥ UTC + RRULE); Google `dates` = local wall-clock + `ctz`
V30: sweep (∀ API call + cron) ⊥ abort: ∀ per-row step (expiry, reminders, template materialize, booking start/open) isolated (exception → warning, row marked done/skipped); client numbers bounded at entry (estMin ≤ 1440, estKm ≤ max_trip_km → too_far, offsetMin |·| ≤ 1440); bad input → {error}, ⊥ raise
V31: history stack ∈ {[S1], [S1, screen]} (+ 1 panel entry): launch on non-S1 screen (link, notification, held screen) seeds S1 below unless already there; reload ⊥ extra entries; go home ⊥ leave app; held-screen prompt keeps its target
V32: user text in `.ics` (note, nickname, label, vehicle) escaped: ∀ line break (CRLF, CR, LF, U+0085, U+2028, U+2029) → `\n`, other control chars dropped; ids/URLs stripped of breaks; GEO only w/ finite lat & lng
V33: stored place = {lat, lng, btrim(label) cut to 120}; ⊥ extra keys; label non-blank; same rule both twins
V34: open request = appointment requested ∧ provider null; ∀ FR-100–109 rules apply (limits, window, place, note, repeat, expiry, withdraw); visible ∀ other member (role candidate: service, times, client, place label, note, series rule, price; ⊥ rides, ⊥ My place, ⊥ user ids); series listed once
V35: take = atomic claim (provider null → caller, first wins else taken) + accept in 1 tx; series whole (clashes declined per V24) unless ∀ date clashes → overlap (⊥ claim, ⊥ push); single clash → overlap; own request → forbidden; after start → illegal_transition; client told as accept
V36: open request created → 1 appt_open ∀ other member (recipient lang, ?open=planned); taken/withdrawn → candidates' lists + badges update (notify), ⊥ further push to them
V37: open request reminders & expiry → client only ("nobody took it"); provider-less views/texts/ics ⊥ crash (provider null ∀ code paths: chips, push-text, ics, history, calendar)
V38: car icon tap (own driver icon) → colour swatches (10); choose → vehicle.colour (driver lang) + vehicle.paint #rrggbb, server-validated; icon drawn in paint ∀ places (S1, D1, profile, rider's driver card, booking card)
V39: no <form> nested in a <form>: PlaceInput (C2, ride sheets, S2) searches w/ a plain button + Enter; ∀ screen form submits only its own action; e2e covers address search inside C2
V40: booked ride accepted ∧ car moved ≥ DEPART_M (150 m) from first fix on driver phone → 1 depart call → departed_at set once, 1 driver_departed push to rider, R3 status "set off"; repeats/other statuses/non-driver → no-op|forbidden; rider's view carries departedAt
V41: ∀ directions link = google.com/maps/dir/?api=1 (driver Navigate, rider Walk) on every OS; ⊥ maps.apple.com
V42: screen explanations live behind round i (InfoTip): popup ≤ 5 s, closes on 2nd tap / tap elsewhere, aria-label + role=tooltip; ⊥ standing paragraph for: vehicle.intro, profile.privacy/myPlaceHint/offersHint, wake.help, move.body, app.codeIntro, request.openNote, book.waiting/startsAt, driver.keepOpen/standbyInfo
V43: a <button> inside a <label> → the label must carry htmlFor (else the button becomes the labelled control: unnamed input, label tap toggles the button); set-off judged only from fixes with accuracy ≤ 50 m and distance − both accuracies ≥ DEPART_M; a failed depart retries after ≥ 20 s, not per fix; re-dispatch clears departed_at (both twins); push-dispatch dist-bundle.ts contains every PushKind (tested)
V44: kids: owner-only rows (name 1–30, photo?, born year?, note ≤200), ≤ 8/member; attached to appt by its client only (per occurrence); provider of that appt sees name/photo/age/note; candidate sees count only; drivers/others ⊥; deleting profile → kids + photos gone
V45: kid rating: provider of a done appt, per attached kid, once, ≤ 24 h, 1–5 + comment ≤140; owner reads all; summary (mean,count) to owner + to provider of a later appt w/ that kid; ⊥ owner's own rating
V46: photos: client-resized (≤512 px, JPEG ≤150 KB) → private bucket `photos` (demo: data URL); tables hold object path only; read via signed URL ≤ 1 h issued by server to an allowed viewer; one per profile/kid, replace deletes old; shown wherever the nickname is (icon = fallback)
V47: chat room = ride:<id> (driver assigned) | appt:<id> (accepted); parties only (RLS + server; re-dispatched driver loses room); text ≤500; stored + live; writable while live + 24 h after end, then read-only; deleted with the ride/appt; ≤ 30 msgs / room / sender / 10 min → too_many
V48: chat push `chat_message` to the other party (tag per room, opens the chat) unless they have the thread open; ⊥ to a driver while in_progress; read receipts (read_at) set when the thread is visible
V49: ∀ per-user table (kids, kid_ratings, messages, photo paths, chat_presence) is re-keyed by the account move (redeem_transfer) and removed by delete_profile — both twins, tested together; photo ownership row-based (profile/kid row → path), object folders keyed by public_id (⊥ auth uid in any URL a viewer gets); 2-arg policy helpers ⊥ granted to clients (1-arg auth.uid() wrappers); chat push suppressed by server-side presence (chat_presence, 45 s) + dispatch read-check; removing a kid drops its object server-side

## §T tasks

id|status|task|cites
T1|x|SQL schema: `appointments` (+ series_id, seq), `appointment_series`, rides.appointment_id/leg + unique, profiles.offers/home/public_id (⊥ counters), master_profiles.offers, app_config.services + appt_reminder_min + appt_series_max_days + appt_series_max_count + booking_max_open + calendar_function_url, ratings.appointment_id xor, push_outbox.appointment_id; RLS, indexes, backfill public_id & offers, catalog seed, `siosia_set_services`|V14,V15,V21,V23,I.db
T2|x|SQL fns: siosia_catalog, request_service (+ repeat → series), answer_appointment (series clashes), cancel_appointment (scope), set_ride_template, drop_ride_template, planned, timeline, set_offers, save_home, book_ride overload (maxOpen), rate_appointment, my_state ext, config ext, set_master offers; views + calendar.ics (hmac); appointments trigger → user:<uid>; sweep: user_gone, expire (single & series), done, reminders, template bookings daily, ride cascade & appt_ride_* events; retention; grants|V2–V12,V16,V17,V18,V20,V23–V26,I.sql
T3|x|engine twin of T1–T2: `src/core/engine.ts`, types `src/core/types.ts`, defaults `src/core/defaults.ts` (maxBookings → cfg maxOpen), robot hooks|V19,V2–V12,V16,V17,V23–V26
T4|x|push-text: 10 kinds EN/PL per §8, {lead}/{leg}/{status}/{rides} vars, tag, url `./?open=planned`; `public/push-sw.js` opens url; `npm run push:bundle`|V8,V18,I.push
T5|x|Backend iface + supabase adapter + mock adapter: catalog, requestService (+ repeat), answerAppointment, cancelAppointment (scope), setRideTemplate, dropRideTemplate, planned, timeline, setOffers, saveHome, bookRide ext, rateAppointment, MyState ext, getConfig ext (calendarUrl, maxOpen), calendar links on views|I.api,V20,V28
T6|x|S1: 3 btns + badges + footer; store: screen stack rooted S1, opening rules, `?open=`, `?mode=` compat, drop mode pref; remove S1 mode cards & S2 switch|V1,V22,FR-080–085,FR-141
T7|x|C1 catalog (entries, providers, disabled, You offer: Ride—Go online + rides-to-take count) + C2 request form (provider pick, datetime step 15, duration, repeat none|weekly|biweekly + until|times, place w/ My place + pin/address, note, price preview per occurrence, validation msgs)|V3,V4,V21,V23,FR-090–094,FR-107
T8|x|P1 Planned (To answer, Rides to take = v1 BookingsPanel driver tab, day groups, repeat marker, chips, ride line incl. "booked when within 30 days", Tomorrow/In 2 h markers, actions) + C3 details (visibility per V11, series line, Cancel This one|All remaining, Add ride … for all remaining) + C4 accept sheet & Add ride (prefill §7.3, derived times, too-soon refusal; series → templates) + Remove ride, Cancel confirm|V9,V10,V11,V12,V17,V24–V26,FR-110–117,FR-130–132
T9|x|H1 merged history + earnings; replace History/earnings panels; rating of done appts|V17,FR-133,FR-106
T10|x|S2: My place (label + pin/address), Services I offer toggles (hidden for masters), notifications hint mentions reminders; delete profile cascade msg|FR-140–143,V16
T11|x|demo: robot Siosia (offers learning+childcare, accepts ≤ 5 s, attaches there-ride when start ≥ 1 h), `config.example.json` deployment.services + appointment|FR-151
T12|x|i18n EN/PL keys (start, catalog, appt, planned, offers, place, err new codes); catalog names from config; `public/guide.html` 2.0 sections|FR-152,FR-153
T13|x|tests: engine (lifecycle, limits, overlap, expiry/done, reminders faked clock & words, ride guards/visibility/cascade/events, delete cascade, master rules, series create/answer-clashes/cancel scopes/expiry/templates across horizon/maxOpen); sql twin PGlite (+ RLS third user, no uid in catalog, calendar.ics token, v1 signatures); ics.test (UID, alarms, RRULE/EXDATE, STATUS, visibility) + google link builder; calendar fn (bad token 404); components (S1, C1, C2 repeat, P1, H1, C3 series, C4); e2e (3 contexts request→accept+ride→take→chips; cancel cascade; weekly series → All remaining; Add to calendar google params + demo ics download; robot Siosia; opening rules; `?open=`); push.test texts; v1 suites green|V19,V20,V23–V28,§13
T14|x|docs: USER-GUIDE (EN+PL: series, Add to calendar), ARCHITECTURE (deviations: appointments, series, reminders, calendar fn), TRACEABILITY rows FR-080–153, SETUP (catalog, reminder cfg, pg_cron note, calendar fn deploy + url), README|FR-153,NFR-15
T15|~|release: re-run migration on live DB, redeploy push fn, deploy calendar fn + set calendar_function_url, push main (Pages), `npm run smoke` + live test, field test (short reminder slots, iPhone .ics Add All, Android google) then restore slots|§15,§13,V30–V33
T16|x|calendar: shared `supabase/functions/_shared/ics.ts` (appt, series, ride; viewer visibility), Edge Function `supabase/functions/calendar/` (hmac check, service role read, text/calendar, 404), `npm run calendar:bundle`, client Add to calendar action (google link builder, ics link | demo browser download via blob, share-sheet fallback on iOS, one-time "doesn't update" note)|V27,V28,V29,FR-135,FR-136,NFR-20
T17|x|open requests backend: SQL + engine twin (provider_id null, candidates' list, take, appt_open push, notify all, expiry/reminders client-only, limits) + mock/supabase adapters + sql/engine tests|V34,V35,V36,V37,V19,FR-160–164
T18|x|open requests UI: C1 entries never disabled + hint, C2 "Anyone who can" + visibility note, P1 "You could help (N)" + I can do it (take sheet w/ ride ticks), S1 badge, C3 candidate view, chips/texts for provider null, i18n EN/PL, robot Siosia takes open requests, component + e2e tests|V34–V37,FR-090,FR-094,FR-161,FR-163
T19|x|car colour: vehicles.paint + set_car_colour (SQL + engine), icon tint (ProfileIcon paint), colour sheet on car icon tap, rider views tinted, i18n, tests|V38,FR-170
T20|x|release 2.1: review, re-run migration on live DB, push-dispatch bundle redeploy, push main, verify live|§15,V30–V38
T21|x|2.2: departed_at + siosia_depart (SQL+engine+adapters), driver_departed texts EN/PL, driver-phone detector (runtime, DEPART_M), R3 status, Google Maps everywhere, InfoTip component + 11 descriptions behind it, i18n short lines, tests (engine, sql, push, components, e2e)|V40,V41,V42,FR-180,FR-181,FR-190
T22|x|release 2.2: review, live DB migration (departed_at + siosia_depart), push-dispatch bundle, main|§15,V40–V42
T23|x|2.3 backend: kids + kid_ratings + messages tables, photos bucket + signed-URL read, RPCs (kids CRUD, attach, rate kid, photo set/clear, chat send/list/read, room access), push kind chat_message, retention, RLS; engine twin (mock photos as data URLs, mock realtime chat); adapters; sql + engine tests|V44–V48,FR-200–225
T24|x|2.3 UI: S2 My kids + photo pickers (resize), C2/C3 attach kids, provider's kid cards + rate-kid after done, kid card w/ ratings, photos everywhere nickname is, chat sheet (R3/D3/C3/P1 badge, live, read marks), i18n EN/PL, robot Siosia chat reply, tests (components, e2e)|V44–V48,FR-200–225
T25|x|release 2.3: review, live DB migration + bucket, push-dispatch bundle, main, live check|§15,V44–V48

## §B bugs

id|date|cause|fix
B1|2026-10-20|series .ics spec'd UTC DTSTART + RRULE WEEKLY → every date after DST change (ends 25 Oct 2026) shifts 1 h in phone calendar, series itself keeps wall-clock (§7)|V29
B2|2026-10-20|pre-release review: ride template estMin unbounded + materialize/sweep_appointments w/o per-row handler → one crafted template makes siosia_sweep raise → every API call + cron fails ∀ users|V30
B3|2026-10-20|pre-release review: launch straight on non-S1 screen (notification ?open=, held D1) overwrote first history entry → ← trapped (PWA) or left app; goFromPanel left stale entry; reload added S1 copies|V31
B4|2026-10-20|pre-release review: escapeText only mapped `\r?\n` → lone CR / U+2028 in user text could inject .ics properties|V32
B5|2026-10-20|pre-release review: templates stored client JSON verbatim, null-unsafe checks passed missing fields, valid_place NULL on missing lng, label rules differ by twin|V33
B6|2026-10-21|2.1 review: take of open series w/ every date clashing for taker 'succeeded' → all dates declined, client told declined, request gone ∀ members (single clash already → overlap)|V35
B7|2026-10-21|live check on public site: PlaceInput's own <form> nested in C2's <form> → Search button submitted the page, app reloaded w/o ?backend=mock (found only by driving the published app; unit/e2e used Here)|V39
B8|2026-10-22|2.2 review: InfoTip <button> inside <label> stole the label (a11y, e2e getByLabel); set-off detector trusted coarse indoor fixes (false 'set off' while parked); retry per GPS fix on failure; re-dispatch kept departed_at (new driver shown as 'set off'); push bundle not rebuilt (driver_departed would send the booking_open text)|V43
B9|2026-10-22|2.3 review (22 findings): account move left kids/kid ratings/messages/photos on the old uid (child data orphaned, un-deletable; engine twin moved them); kid removal orphaned its photo object; photo paths exposed the auth uid; 2-arg policy helpers were a membership oracle; chat push not suppressed on the live stack while the thread is open; deleteProfile wiped the bucket before the server could refuse; capture=environment hid the gallery|V49
