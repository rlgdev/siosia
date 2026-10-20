# Requirement → verification

Every functional requirement of the spec (§7) mapped to an automated test or a field-test step
([FIELD-TEST.md](FIELD-TEST.md)). Test files: `core` = `tests/unit/core.test.ts`, `engine` =
`tests/unit/engine.test.ts`, `sql` = `tests/unit/sql-backend.test.ts` (real migration in PGlite),
`services`, `components`, `wakeLock` = `tests/unit/wakeLock.test.tsx`, `e2e` = `tests/e2e/ride-loop.spec.ts`.

| FR | Requirement (short) | Verified by |
| --- | --- | --- |
| 001 | One URL, Ride/Drive, `?mode=` | e2e (mode cards); field step 1–2; `?mode=` handled in `state/store.ts` |
| 002 | Anonymous session + nickname only | sql "onboards with a nickname only"; engine "requires the invite code, then only a nickname"; e2e |
| 003 | Link email / Google keeps data | field (Supabase only; uses Supabase identity linking, same user id) |
| 004 | Vehicle required before going online | sql (`no_vehicle`); e2e (vehicle form on first Drive) |
| 005 | No request while online as driver, no online with a ride | engine + sql (`online_as_driver`, `active_ride`) |
| 006 | Server-enforced reads/writes | sql "denies direct table writes and cross-user reads", outsiders can't read a ride/channel |
| 007 | Invite code verified server-side | sql (hash only, normalisation, rate limit); engine |
| 010 | Street map, GPS pickup, accuracy circle | e2e (pickup "My location"); field step 2 |
| 011 | Pins, long-press, address search | e2e (long-press dropoff); field step 2 (search) |
| 012 | Distance, duration, fare before request | e2e (`estimate`, `fare`) |
| 013 | Disabled until valid; shown fare frozen | e2e (receipt fare = R1 fare); sql fare freeze; engine area/max-trip guards |
| 014 | R2 elapsed, notified, cancel, Try again | components "R2 Searching"; e2e cancel |
| 015 | R3 driver, vehicle, plate, marker, ETA, status | e2e (driver card, plate, car marker, statuses) |
| 016 | Rider cancel with confirmation | e2e cancel; engine late-cancel; sql illegal cancel in progress |
| 017 | R4 receipt, paid, 1–5 stars + comment | components "R4"; e2e |
| 018 | Nearby anonymous cars | e2e "demo robots" (`Cars nearby`); presence carries no nickname/plate |
| 020 | Online switch, location, wake lock, S4 | e2e (S4 "online as a driver", "Keep the screen on"); wakeLock "either a driver is online or the box is ticked"; field step 1 |
| 021 | 3 s / 25 m and 30 s / 200 m cadences | core "position throttling" |
| 022 | Offer card, chime, 20 s countdown | components "D2" (countdown, timeout once); e2e accept |
| 007+ | Master-profile link: shared identity (nickname, icon), no invite, one role — rider (fixed fare, default places) or driver (preset car) | engine + sql "master profile", "one role"; e2e "Toria link", "Roman link", "wrong master-profile link", "asks before replacing" |
| app+ | iOS Home Screen app: one-time move code (profile, history, vehicle, master link) | engine + sql "moving a profile"; e2e "one-time code moves a profile" |
| book+ | Book for later; drivers take ahead; start / open / give up timings; cancel; give back | engine "rides booked in advance"; sql "books rides in advance", "starts a taken booking"; e2e "books a ride for later" |
| push+ | Notifications: who hears what, queue only for subscribers, EN/PL texts, sender retries/drops | engine "notifications"; sql "queues notifications"; push.test.ts; e2e booking banners |
| wake+ | "Keep the screen on" checkbox (top bar + ☰ → app): remembered per phone, re-taken on return and on the next tap (iOS), hint while a tap is needed, iOS Home Screen < 18.4 unsupported | wakeLock (all); e2e "Keep the screen on"; field step 1 |
| 022+ | Going online / *Show requests* re-offer every pending request nearby (incl. declined), with a count | engine + sql "review declined and missed requests again"; e2e "goes online later … Show requests" |
| 023 | Route to pickup then dropoff, rider pin | e2e; field steps 4–5b |
| 024 | Arrived → Start → Complete, Navigate, Cancel reasons | e2e; engine/sql re-dispatch on cancel |
| 025 | No-show only after 5 min | engine + sql (`too_early`) |
| 026 | D4 fare, collected, rate rider | components (PL driver summary); e2e |
| 027 | Today / month earnings, last 50 | engine + sql earnings; e2e (today earnings) |
| 028 | No offline during a trip | engine + sql (`active_trip`) |
| 030 | High-accuracy GPS, circle > 50 m | `services/geolocation.ts`; field |
| 031 | Road routing, re-route > 100 m | services "parses an OSRM route"; core polyline deviation; `useLiveRoute` |
| 032 | Fallback × 1.3 at 30 km/h within 2 s | services (hang → fallback < 1.5 s, HTTP error); core; e2e "estimate" label |
| 033 | Attribution, provider policies | `MapView` attribution control; core `RateGate`; geocoding only on Search/pin |
| 034 | Marker ≥ every 5 s, gone ≤ 10 s | e2e (car marker appears for a parked driver via keep-alive); field step 4/6. A driver who goes quiet keeps a greyed "last seen" car (§12): e2e "the rider keeps the driver's car"; components "R3 Active ride: the driver's app goes quiet" |
| §12 | Silent driver on a ride: re-dispatch after 15 min (deviation, iPhones), rider cancel then not counted | engine "their ride waits 15 min before it is re-dispatched"; sql "re-dispatches when the assigned driver has been silent for 15 min"; engine + sql "rider's cancellation … once Siosia gave up on the driver"; sql "starts a taken booking"; field step 8 |
| 035 | Actual distance/duration, totals only | engine (actualKm/actualMin); sql (`actual_km`) |
| 040 | Sharing only while allowed; stops at in_progress | core `riderMayShare`; e2e (rider S4 gone at start) |
| 041 | S4 on every screen with one-tap stop | components "S4"; e2e |
| 042 | Stream ends ≤ 10 s on every exit path | e2e (offline → S4 gone); bus presence TTL test; field teardown table |
| 043 | No live coordinates stored | sql (no lat/lng columns except ride endpoints; driver position only an argument); engine (no trail in state) |
| 044 | Plate after assignment only | sql + engine (offer/ride views without vehicle before accept) |
| 050 | Fare formula, rounding, minimum, config | core "fare"; sql (17.725 → 17.50) |
| 051 | Fare unchanged incl. re-dispatch | engine + sql re-dispatch tests |
| 052 | Receipt shows frozen fare + actuals | components "R4"; sql |
| 053 | No payments; flags only | sql mark paid/collected; components |
| 060 | Rate once within 24 h, immutable | engine (`already_rated`, `window_closed`); sql |
| 061 | Mean of last 20, "New" under 3 | core "ratings"; sql (`mean: null`) |
| 062 | History 50 newest first | engine (55 rides → 50); sql; e2e history |
| 063 | Earnings from completed only, deployment timezone | engine; sql |
| 064 | Cancellation counts shown on S2 | engine + sql counters; Profile panel |
| 070 | Demo mode + robot driver, two tabs | e2e (two pages) + e2e "demo robots"; services mock backend loop |
| 071 | Installable PWA, offline shell | build emits manifest + service worker; field (install) |
| 072 | Mobile-first 360 px, 44 px targets | e2e runs on a Pixel 7 viewport; `theme.css` |
| 073 | EN + PL, browser default | components EN/PL; services i18n completeness |
| 074 | Reduced motion, AA contrast | `theme.css` (`prefers-reduced-motion`, contrast tokens) |
| 075 | S3 explainers | `RiderHome`, `DriverApp`, `Boot` (denied, poor accuracy, wake lock, backend down); field degradation table |
| 076 | Config at build time or one file, no secrets | `src/config.ts`, `.env.example`, `config.example.json`; only the publishable key is read |

## Siosia 2.0 (`siosia-spec-v2.0.md`, FR-080 – FR-153)

Test files: `appt` = `tests/unit/appointments.test.ts` (engine), `sql2` = `tests/unit/sql-v2.test.ts`
(the same cases against the real migration in PGlite), `screens` = `tests/unit/screens-v2.test.tsx`,
`components` = `tests/unit/components.test.tsx`, `push` = `tests/unit/push.test.ts`, `ics` =
`tests/unit/ics.test.ts`, `services` = `tests/unit/services.test.ts`, `e2e2` = `tests/e2e/v2.spec.ts`,
`e2e` = `tests/e2e/ride-loop.spec.ts`; *field* = the 2.0 steps in [FIELD-TEST.md](FIELD-TEST.md).

| FR | Requirement (short) | Verified by |
| --- | --- | --- |
| 080 | S1: Siosia / Planned / History + v1 footer | components "S1 Home"; e2e (every test starts on S1) |
| 081 | Each opens its screen, Back and browser back return | e2e2 "opening rules" (page back); e2e navigation steps |
| 082 | Launch on S1 unless a ride / offer / online driver holds a screen; offline → S1 | e2e2 "opening rules" (online driver reopens on D1, leaving asks); e2e "Keep the screen on" (offline → S1, reload → S1) |
| 083 | Badges: to answer, upcoming, next item | components "badges requests to answer and names the next planned item" |
| 084 | `?mode=` and `?open=` open once | e2e2 "opening rules" (`?open=planned`, `?open=history`, removed from the address bar) |
| 085 | Master restrictions on the Ride entry only | appt + sql2 "master profile preset its offers"; screens "no drive card to a rider profile" |
| 090 | C1 entries, who offers, nobody → disabled | screens "C1 Catalog" (EN, PL) |
| 091 | Catalog is configuration, validated | sql2 "validates the catalog"; services "config.example.json" |
| 092 | Ride entry → R1 unchanged; Go online card with rides to take | screens "Ride — Go online"; e2e (all ride tests open R1 / D1 from C1) |
| 093 | Services I offer on S2; master preset hides it | appt + sql2 "offers only enabled time entries"; screens "S2" |
| 094 | C2 form, validation, price | screens "C2 Request form" (both tests) |
| 100 | Send request validated, limits | appt + sql2 "validates a request", "refuses an 11th open request" |
| 101 | Accept / Decline, overlap refused | appt + sql2 "accepts atomically, refuses overlaps"; screens P1 decline, C4; e2e2 three pages |
| 102 | Cancel until start, other party told, rides cascade, nothing counted | appt + sql2 "withdraw / cancel"; e2e2 "cancel cascades" |
| 103 | Expired at start, done at end, in progress derived | appt + sql2 "expires an unanswered request"; screens P1 ("Now until") |
| 104 | Server-validated transitions, twin backends | appt and sql2 run the same cases (V19) |
| 105 | Stored fields only | sql2 "keeps appointments out of clients' direct reach"; schema review |
| 106 | Rating a done appointment once in 24 h | appt + sql2 "lets both rate a done appointment once"; screens "rates a done appointment once from C3", H1 Rate |
| 107 | Repeat weekly / 2 weeks, 2–12 times | appt + sql2 "creates a weekly series"; screens C2 weekly; e2e2 "weekly series" |
| 108 | Series accepted as a whole, clashes declined | appt + sql2 "answers it as a whole with clashes"; push "dates declined on answer" |
| 109 | This one / All remaining | appt + sql2 "cancels all remaining"; screens "Cancel offers This one / All remaining"; e2e2 "weekly series" |
| 110 | Rides there / back, guards | appt + sql2 "adds a ride to an accepted appointment with every guard" |
| 111 | Prefilled places and times | screens "derives the pickup", "accepts with a ride back: places and time prefilled" |
| 112 | Too soon → refuse, point to Ride | screens "refuses a ride there that would be under 30 min ahead" |
| 113 | v1 booking lifecycle, summary per ride | appt + sql2 ride summary; e2e2 "Ride there: Adam ✓" |
| 114 | Non-passenger sees leg, time, status, driver only | appt + sql2 "shows it to each party as allowed"; ics "no user ids … no positions" |
| 115 | Passenger removes a ride | appt + sql2 ride guards (cancel by passenger) |
| 116 | Other party told of taken / lost / failed | appt + sql2 "tells both parties when an attached ride finds no driver" |
| 117 | Series ride templates within 30 days | appt + sql2 "books the series' rides from a template"; screens series template; services robot Siosia (series) |
| 120 | Reminders 24 h and 2 h, each once | appt + sql2 "reminds both parties once per slot"; *field* step 5 |
| 121 | Reminder words = Planned words | push "reminds with the status and the ride lines"; apptWords uses push-text |
| 122 | Late slots skipped, none after cancel | appt + sql2 reminders test |
| 123 | Same information without notifications | screens P1 (In 2 h, chips, ride line); S2 hint text test |
| 124 | Right recipient, language, tag | push "tags appointment notifications"; services "2.0 round trip … her language" |
| 125 | Notification tap opens P1 | push (open URL `?open=planned`); store `openFromUrl`; *field* step 3 |
| 130 | P1 lists everything upcoming, grouped by day | screens "P1 Planned" (day groups, in progress first) |
| 131 | To answer, Rides to take, Give back | screens P1 (To answer, Rides to take in Polish); e2e booking test |
| 132 | Tap → C3 / booking card | screens "opens C3 when an appointment is tapped" |
| 133 | H1 merged history + earnings; v1 panels replaced | screens "H1 History"; e2e "earnings and history" (D1 panel, S1 History) |
| 134 | Refresh, loading / empty / error states | screens P1 / H1 empty states (EN, PL); refresh on state + 30 s in code |
| 135 | Add to calendar: Google and .ics, the note | screens "Add to calendar"; ics "Google Calendar link"; e2e2 robot test (link + demo download) |
| 136 | .ics content, token, 404 | ics ".ics (V27)", "calendar function"; sql2 "serves the calendar view only to a party"; *field* step 11 |
| 140 | My place | appt + sql2 "saves My place"; screens "saves My place with a name" |
| 141 | Switch mode removed from S2 | screens S2 (no switch); code review of `Profile.tsx` |
| 142 | Delete cancels upcoming appointments | appt + sql2 "cancels a deleted provider's upcoming appointments"; screens S2 delete text |
| 143 | Public ids, never user ids | appt + sql2 "by public id, never a user id"; ics "no user ids" |
| 150 | Catalog and settings as configuration | sql2 config test; services "config.example.json" |
| 151 | Robot Siosia in the demo | services "demo: the robot Siosia …"; e2e2 "one tab" |
| 152 | EN and PL for every string | services "i18n" (keys used, error codes, status families, placeholders) |
| 153 | Guide and docs describe 2.0 | services "in-app guide"; this file, USER-GUIDE, ARCHITECTURE, SETUP, README |
