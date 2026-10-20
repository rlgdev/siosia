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
| 1 | Driver: open link → invite code → nickname → **Drive** → vehicle → **Go online** | S4 green bar visible; no "keep the screen on" warning (wake lock on); top-bar *Keep the screen on* checked and locked. iPhone Home Screen app: leave the phone untouched > 2 min — the screen stays on; side button → unlock → still stays on without a tap | |
| 2 | Rider: open link → invite code → nickname → **Ride**; pickup from GPS; dropoff 2–3 km away by **address search** | Fare, distance and ETA shown; accuracy circle if GPS > 50 m | |
| 3 | Rider: **Request ride** | Driver: offer card ≤ 1 s with chime/vibration, distance to pickup, 20 s countdown → **Accept** | |
| 4 | Driver walks/drives 200 m | Rider: driver card, car, **plate**; car marker moves & rotates; ETA refreshes ≥ every 5 s | |
| 5 | Driver: **I've arrived** | Rider status changes ≤ 1 s | |
| 5b | Driver: **Start trip** | Rider pin disappears on driver; route to dropoff on both; rider's S4 bar disappears | |
| 6 | Driver: **Complete trip** | Receipt (rider) and summary (driver); both S4 bars gone; other phone's live marker gone ≤ 10 s | |
| 7 | Both rate each other; rider marks paid, driver collected | History shows the ride; driver's today earnings include the fare | |
| 8 | Repeat 3–4, then **lock the driver's phone** (or open Maps with *Navigate*) for 2–3 min, then unlock | Rider keeps the car greyed with "Last seen … ago" and "Your driver's Siosia is paused … Your ride is still on"; the ride stays with the driver; after unlocking the car moves again. (Silent for 15 min — e.g. the driver's tab killed — the rider sees "Your driver's phone stopped answering — we're finding you another one.") | |
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

## Siosia 2.0 — two phones plus one (spec §13)

Siosia phone (provider), client phone, driver phone. Notifications on in the iPhone app on both
the client and the Siosia phone.

| # | Step | Expected | ✓ |
| --- | --- | --- | --- |
| 1 | Siosia: ☰ → *Services I offer* → Learning + Childcare on; *My place* set. Client: *My place* set | Client's *Siosia* lists Siosia under both | |
| 2 | Client: *Siosia → Childcare* → tomorrow 14:00, 3 h, My place, a note → *Send request* | Planned: "Waiting for an answer from Siosia"; Siosia gets *New request* | |
| 3 | Siosia: tap the notification → *Planned → To answer → Accept* → *I need a ride there* → *Confirm* | Opens on Planned; pickup prefilled from her place; client gets *Siosia accepted*, sees "Confirmed · Ride there: no driver yet" | |
| 4 | Driver: *Planned → Rides to take (1) → Take this ride* | Both others show "Ride there: Roman ✓" within seconds; client gets *Ride confirmed* | |
| 5 | Operator: set `appt_reminder_min` to `{30,10}` in `app_config` | Both phones get two reminders at the right minutes with "Confirmed · Ride there: Roman ✓" | |
| 6 | Driver: *Give back*, then take it again | Both: "no driver yet", then the name again; client gets *Ride needs a driver* | |
| 7 | Let the ride run; the appointment starts and ends | *Now until 17:00*, then History on both; both rate | |
| 8 | Client: a second request; Siosia *Decline* | Client notified; History "Declined" | |
| 9 | Client: a third request accepted, then *Cancel* 2 h before | Siosia notified; her ride cancelled, the driver gets *Booking cancelled*; no counter changes | |
| 10 | Client: *Learning*, weekly, 4 times; Siosia accepts with a ride there; client *Cancel → All remaining* on one date | Four items with "↻ every week" on both; then the future ones gone, one notification | |
| 11 | Both: *Add to calendar* on a confirmed appointment and on a series | Android: Google Calendar prefilled; iPhone app: the .ics with *Add All*; alarms present; series repeats without the cancelled dates | |
| 12 | Operator: inspect `appointments`, `appointment_series`, `rides` | Parties, times, place, note, statuses, reminders sent, templates; no positions | |
| — | Operator: restore `appt_reminder_min` to `{1440,120}` | | |
