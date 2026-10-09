# Field test — two phones on real streets (spec §11)

Automated tests cover the logic on the mock backend and the SQL rules in PGlite; this checklist is
the part only real phones can prove. Copy it into `docs/field-tests/YYYY-MM-DD.md`, fill it in and
commit it (Definition of Done).

| | Driver phone | Rider phone |
| --- | --- | --- |
| Device / OS / browser | | |
| Network | | |
| Tester | | |
| Deployed commit / URL | | |

## Canonical acceptance test

| # | Step | Expected | ✓ |
| --- | --- | --- | --- |
| 1 | Driver: open link → invite code → nickname → **Drive** → vehicle → **Go online** | S4 green bar visible; no "keep the screen on" warning (wake lock on) | |
| 2 | Rider: open link → invite code → nickname → **Ride**; pickup from GPS; dropoff 2–3 km away by **address search** | Fare, distance and ETA shown; accuracy circle if GPS > 50 m | |
| 3 | Rider: **Request ride** | Driver: offer card ≤ 1 s with chime/vibration, distance to pickup, 20 s countdown → **Accept** | |
| 4 | Driver walks/drives 200 m | Rider: driver card, car, **plate**; car marker moves & rotates; ETA refreshes ≥ every 5 s | |
| 5 | Driver: **I've arrived** | Rider status changes ≤ 1 s | |
| 5b | Driver: **Start trip** | Rider pin disappears on driver; route to dropoff on both; rider's S4 bar disappears | |
| 6 | Driver: **Complete trip** | Receipt (rider) and summary (driver); both S4 bars gone; other phone's live marker gone ≤ 10 s | |
| 7 | Both rate each other; rider marks paid, driver collected | History shows the ride; driver's today earnings include the fare | |
| 8 | Repeat 3–4, then **kill the driver's browser tab** | Rider sees "Finding another driver…" within ~60 s (§12) and the car disappears ≤ 10 s | |
| 9 | Operator: Supabase → Table Editor → `rides` | Row has endpoints, totals, timestamps, fare — no positions | |

## Teardown paths (US4)

| Path | Expected | ✓ |
| --- | --- | --- |
| Driver taps **Stop** on S4 while idle | Goes offline; S4 gone; car vanishes from riders' maps | |
| Rider taps **Stop** while waiting for the driver | Driver sees "Rider stopped sharing", navigates to the pin | |
| Rider cancels after acceptance | Driver back to idle with a notice; S4 gone on rider | |
| Driver locks the screen 40 s during the trip | Rider sees "Last seen … s ago"; resumes after unlock | |
| Airplane mode 30 s on the driver | Rider sees stale marker / reconnecting; recovers after | |
| Airplane mode 30 s on the rider | Ride continues; rider app catches up on reconnect | |

## Degradation (US6)

| Case | Expected | ✓ |
| --- | --- | --- |
| Deny location on the rider | S3 explainer; pins can be placed by hand | |
| Deny location on the driver | Cannot go online; explainer shown | |
| Address search with no network to the geocoder | Message + pin fallback | |
| Supabase project paused | "Service unavailable — retry" with operator contact | |

Notes / issues found:
