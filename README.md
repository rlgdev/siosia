# Siosia

A mobile-first web app for a group of people who help each other: **one HTTPS link**. Ask for a
**ride** (now or booked for later, tracked live), a **lesson** or **someone with the kids**; offer
what you can do; see everything coming up in **Planned** and what's done in **History**, with
reminders a day and two hours before and *Add to calendar*. Real maps and GPS, no payments, no app
store, **zero running cost** on free tiers.

Version 2.1 — 2.0 plus open requests (ask *Anyone who can*; every member can take it) and the car
colour picked on the car icon — built from [`siosia-spec-v2.0.md`](siosia-spec-v2.0.md) (the task list is in
[`SPEC.md`](SPEC.md)) on top of the 1.x ride app of [`siosia-spec-v0.1.md`](siosia-spec-v0.1.md);
the earlier Rubber project is the reference architecture. Users only ever see "Siosia".

| I want to… | Read |
| --- | --- |
| Try it right now, no setup | Open the demo link with `?backend=mock`, or run `npm run dev` |
| Run my own deployment (operator) | [docs/SETUP.md](docs/SETUP.md) — ≈ 45 min, free |
| Use it on my phone | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — EN + PL (also in the app: *How it works*) |
| Run the acceptance test on real streets | [docs/FIELD-TEST.md](docs/FIELD-TEST.md) |
| See which test covers which requirement | [docs/TRACEABILITY.md](docs/TRACEABILITY.md) |
| Understand the design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173 — DEMO MODE (in-browser backend + robot drivers)
```

With no Supabase configured, Siosia runs on an in-browser **mock backend**: open two tabs to be
rider and driver (or client and provider), or play alone — two **robot drivers** cruise near your
pickup and accept requests, and a **robot Siosia** offers Learning and Childcare, accepts your
request within seconds and books a ride there (`?siosia=0` turns her off, `?robots=0` the drivers).
On a desktop without GPS add `?sim=52.2297,21.0122` to give a tab a simulated position.

## What a user needs

- **Rider:** a nickname. That's the whole profile (plus the operator's invite code, once per device).
- **Driver:** a nickname and the vehicle (make, model, colour, plate, seats) — shown to the rider
  only after acceptance.
- **Provider:** a nickname and the services they offer turned on (☰ → *Services I offer*). The
  catalog itself is deployment configuration (`app_config.services`, see SETUP).

## Stack

React 18 + Vite + TypeScript · Leaflet + OpenStreetMap tiles · OSRM routing · Nominatim search ·
Supabase Free (Postgres functions + RLS + Realtime + anonymous auth + two Edge Functions: Web Push
sender, calendar `.ics`) · PWA · GitHub Pages · GitHub Actions. No custom server.

## Scripts

```bash
npm run dev         # dev server (demo mode unless .env.local points to Supabase)
npm run build       # typecheck + production build → dist/ (relative paths: any static host)
npm test            # unit, component, integration and SQL-rules tests (SQL runs in PGlite)
npm run e2e         # Playwright: full rider+driver loop on the mock backend (npm run e2e:install once)
npm run lint        # ESLint
npm run typecheck   # tsc
npm run icons       # regenerate PWA icons from the vector design
npm run push:bundle      # one-file bundle of the push-dispatch Edge Function (dashboard deploy)
npm run calendar:bundle  # the same for the calendar Edge Function
```

## Layout

```
src/core/            pure rules: fare, lifecycle, geo, throttle, ratings, the server Engine
src/backend/         Backend interface + mock (localStorage/BroadcastChannel/robots) + supabase
src/services/        geolocation, routing (OSRM + fallback), geocoding, device helpers
src/state/           app store, runtime hooks (driver loop, rider sharing, live route), S4 registry
src/screens/         S1 start, C1 catalog, C2 request, C3 appointment, P1 planned, H1 history, S2 profile, R1–R5, D1–D6
supabase/migrations/ the whole backend: tables, RLS, functions, realtime policies, cron
supabase/functions/  push-dispatch, calendar, and _shared (notification texts, .ics — also used by the app)
tests/unit/          vitest (incl. SQL backend in PGlite)     tests/e2e/  Playwright
docs/                setup, user guide, field test, traceability, architecture
```

## Privacy in one paragraph

A device sends its position only while it is an online driver or a rider whose driver is assigned,
with a persistent banner and one-tap stop. Live positions travel over private realtime channels and
are **never stored**: no table has a column for them, and drivers' positions reach the server only
as a call argument used for matching. A ride record keeps pickup, dropoff, totals, times, fare,
statuses and ratings. An appointment keeps its service, time, place and note, seen only by its two
people (a driver taking a ride to it sees just the ride); *My place* is seen only by its owner, and
providers are listed by a random public id, never a user id. The nickname is the only personal
field.
