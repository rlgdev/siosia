# Siosia

A mobile-first ride-hailing web app: **one HTTPS link, two modes**. Anyone can *Ride* (request a car
to a real pickup point and track it live) or *Drive* (go online, accept requests, run the trip).
Real maps and GPS, no payments, no app store, **zero running cost** on free tiers.

Built from [`siosia-spec-v0.1.md`](siosia-spec-v0.1.md); the earlier Rubber project is the reference
architecture.

| I want to… | Read |
| --- | --- |
| Try it right now, no setup | Open the demo link with `?backend=mock`, or run `npm run dev` |
| Run my own deployment (operator) | [docs/SETUP.md](docs/SETUP.md) — ≈ 45 min, free |
| Use it on my phone (rider / driver) | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — EN + PL |
| Run the acceptance test on real streets | [docs/FIELD-TEST.md](docs/FIELD-TEST.md) |
| See which test covers which requirement | [docs/TRACEABILITY.md](docs/TRACEABILITY.md) |
| Understand the design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173 — DEMO MODE (in-browser backend + robot drivers)
```

With no Supabase configured, Siosia runs on an in-browser **mock backend**: open two tabs to be
rider and driver, or ride alone — two **robot drivers** cruise near your pickup and accept requests.
On a desktop without GPS add `?sim=52.2297,21.0122` to give a tab a simulated position.

## What a user needs

- **Rider:** a nickname. That's the whole profile (plus the operator's invite code, once per device).
- **Driver:** a nickname and the vehicle (make, model, colour, plate, seats) — shown to the rider
  only after acceptance.

## Stack

React 18 + Vite + TypeScript · Leaflet + OpenStreetMap tiles · OSRM routing · Nominatim search ·
Supabase Free (Postgres functions + RLS + Realtime + anonymous auth) · PWA · GitHub Pages ·
GitHub Actions. No custom server.

## Scripts

```bash
npm run dev         # dev server (demo mode unless .env.local points to Supabase)
npm run build       # typecheck + production build → dist/ (relative paths: any static host)
npm test            # unit, component, integration and SQL-rules tests (SQL runs in PGlite)
npm run e2e         # Playwright: full rider+driver loop on the mock backend (npm run e2e:install once)
npm run lint        # ESLint
npm run typecheck   # tsc
npm run icons       # regenerate PWA icons from the vector design
```

## Layout

```
src/core/            pure rules: fare, lifecycle, geo, throttle, ratings, the server Engine
src/backend/         Backend interface + mock (localStorage/BroadcastChannel/robots) + supabase
src/services/        geolocation, routing (OSRM + fallback), geocoding, device helpers
src/state/           app store, runtime hooks (driver loop, rider sharing, live route), S4 registry
src/screens/         S1–S3, R1–R5, D1–D6
supabase/migrations/ the whole backend: tables, RLS, functions, realtime policies, cron
tests/unit/          vitest (incl. SQL backend in PGlite)     tests/e2e/  Playwright
docs/                setup, user guide, field test, traceability, architecture
```

## Privacy in one paragraph

A device sends its position only while it is an online driver or a rider whose driver is assigned,
with a persistent banner and one-tap stop. Live positions travel over private realtime channels and
are **never stored**: no table has a column for them, and drivers' positions reach the server only
as a call argument used for matching. A ride record keeps pickup, dropoff, totals, times, fare,
statuses and ratings. The nickname is the only personal field.
