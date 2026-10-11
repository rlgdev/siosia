# Requirement → verification

Every functional requirement of the spec (§7) mapped to an automated test or a field-test step
([FIELD-TEST.md](FIELD-TEST.md)). Test files: `core` = `tests/unit/core.test.ts`, `engine` =
`tests/unit/engine.test.ts`, `sql` = `tests/unit/sql-backend.test.ts` (real migration in PGlite),
`services`, `components`, `e2e` = `tests/e2e/ride-loop.spec.ts`.

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
| 020 | Online switch, location, wake lock, S4 | e2e (S4 "online as a driver"); field step 1 |
| 021 | 3 s / 25 m and 30 s / 200 m cadences | core "position throttling" |
| 022 | Offer card, chime, 20 s countdown | components "D2" (countdown, timeout once); e2e accept |
| 007+ | Master-profile link: shared rider (nickname, icon), no invite, rider only, fixed fare | engine + sql "master profile"; e2e "master-profile link … fixed 18", "wrong master-profile link" |
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
| 034 | Marker ≥ every 5 s, gone ≤ 10 s | e2e (car marker appears for a parked driver via keep-alive); field step 4/6 |
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
