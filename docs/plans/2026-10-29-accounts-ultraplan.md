# Ultraplan — Siosia 3.0 accounts: sign up by email or Google

**Executive summary**
1. Today every browser storage is its own anonymous Supabase user; a person with three phones is three accounts glued together by `master_id`. After this plan a person is **one permanent Supabase user** (email and/or Google) on every phone, Safari and Home Screen app alike.
2. Sign-in is a **6-digit code typed in the app** (never a magic link, because a link tapped in iOS Mail opens Safari, not the Home Screen app) or **Google via the OAuth redirect** in the implicit flow the installed supabase-js already uses (now pinned explicitly).
3. Migration is **one path on every phone, in any order**: the person signs in; the app has quietly created a transfer code for the phone's old anonymous account, bound to the email typed, and "absorbs" it into the signed-in account with a keep-both merge. Dead phones are merged by the operator by public id. The operator never pairs uuids by hand for phones in hand.
4. Membership becomes **per person**: the invite code or `#join=` link is entered once; a member's new phone goes straight in. `siosia_is_member(p_device)` keeps its signature but answers for the user.
5. Master profiles survive as **presets** (`profiles.master_id` stays, so fixed fare, role lock and the `p:<master>` settlement keys keep working); the master **link** is closed per master the same evening with `master_profiles.joinable = false`, without deactivating masters (which would void memberships **and** hide the presets).
6. Lockdown is **server-side and reversible in seconds**: `app_config.auth_mode = 'accounts'` (read through anon-granted `siosia_config`) makes the client stop minting anonymous sessions and makes `siosia_guard` answer `sign_in_required` to any anonymous JWT; then the dashboard toggle goes OFF. Merged-away anonymous accounts are frozen **by the guard** (`merged_into` → `account_merged`), never by an auth ban, and deleted only after a 14-day soak with a count-guarded, scoped delete.
7. Three releases: **2.12 "accounts"** (code + merge + sign-in while anonymous still works), **migration evening** (no deploy), **2.13 "lockdown"**.
8. Zero cost: Supabase Free, GitHub Pages, Gmail app-password SMTP (or Brevo free), a free Google OAuth client with basic scopes published to production.
9. Demo (`?backend=mock`) and the Playwright suite never see a sign-in screen; smoke/live tests move to three password test users created in Phase A.
10. Before any merge: the mail path proven to all four real addresses (A0), a `backup_2026_11` schema snapshot (restorable, rehearsed), a PGlite rehearsal on realm-shaped data that also rehearses the freeze, the scoped delete and the restore, per-person verification queries, saved before/after weekly-report JSON.

Facts re-checked in the working tree today (2026-10-29) are cited as `file:line`. Reader findings are cited as *(web-auth)*, *(sql-identity)*, *(client-flow)*, *(ops-tests)*; adversarial verification as *(V-n)* with the claim number of §10. Anything that rests on an external fact not verified in this repo or by the verifiers is marked **(verify)**.

Synthesis decisions (why this plan differs from the three candidates and the first draft):
- Base = Plan 3 (one path per phone, server-side switches, `joinable`, `whoami`, `merged_into`).
- From Plan 1: `{{ .Token }}` in the email templates (GoTrue sends the **Confirm signup** template to a first-time OTP user while *Confirm email* is ON — confirmed from `internal/api/magic_link.go` *(V-2, V-3)*); `storage.objects.owner` re-pointed inside the merge (harmless belt and braces: the FK to `auth.users` was dropped in 2023 *(V-11)*); password test users in Phase A; `via_master` nulled on the four survivors; the `sql-backend.test.ts:118` expectation that flips.
- From Plan 2: Roman-first migration order, the per-person verification block and `DO`-block snapshot, the error-mapping table, `auth.jwt()` + `storage.objects` stubs in the PGlite harness, the `googleSignIn` deployment flag that hides Google per platform until the device test passes.
- Fixed flaws named by the judges: `siosia_create_transfer` calls `siosia_guard(true)` (`0001_siosia.sql:2073`), so the straggler exemption is a separate lenient guard, not a comment; `siosia_same_realm` is `siosia_sandbox(a) = siosia_sandbox(b)` (`:914-917`), so the absorb precondition is "same realm **or** the target has no membership yet"; `boot()` today runs `start()` before `getConfig()` (`store.ts:300-301`), so the order is swapped (`siosia_config` reads no `auth.uid()` and is anon-granted, `:1912-1935`, `:5673`); the merge takes an explicit `p_mode`, not a pseudo-device; Polish follows the app's own voice ("Siosi", "od operatora", `pl.ts:32,35`).
- Changed after adversarial verification (§10): the soak **does not use `auth.users.banned_until`** — `'infinity'` cannot be scanned by GoTrue's pgx driver (HTTP 500 on every load of that row) and any ban is one-way on the phone (auth-js removes the session, `start()` mints a new anonymous user) *(V-13)*. The freeze is a guard check on `profiles.merged_into`, immediate and reversible with one `update`. "No auth email contains a link" was narrowed to the emails Siosia's own flows trigger, and the Reset Password / Invite / Reauthentication templates are made link-free too *(V-3)*.
- Added after the completeness critique: the absorb code is bound to the signing-in identity; the iPhone Safari-vs-Home-Screen rule and the B2.0 instruction card; bookmarked `#master=` links become harmless no-ops; the C5 delete is scoped and count-guarded; the snapshot includes `families`, `appointment_kids`, `invite_failures` and is restorable in FK order; the before-JSON recipe is exact; merged-away phones that reappear land on sign-in, not on the invite code; cached 2.12 clients handle `sign_in_required` from any RPC; a visible build stamp; the A0 mail gate; Google Auth Platform console names; profile deletion ≠ account deletion; `two_families` resolution; two more open questions; spec paperwork.
- Deliberately **not** taken from Plan 1: in-place conversion of the canonical phone (`updateUser({email})` + `verifyOtp type 'email_change'`). It moves no data but creates two different buttons, makes the phone order matter and dead-ends with `email_exists` when another phone signed in first. One path for every phone wins for a family audience; the price is that the first phone's profile row moves to a new uid inside one transaction, with the same body that `siosia_redeem_transfer` has exercised in production since 2.x.

---

## 0. Decisions taken by the user on 2026-10-30 (override the sections below where they differ)

| # | Question (§8) | Decision | What changes in this plan |
|---|---|---|---|
| 1 | Who are the 4 accounts | **Toria, Roman, Karol, Ań.** No children’s phones. Toria’s ~10 accounts are mostly leftovers (1–3 real phones) | B0 table rows: Roman, Toria, Karol, Ań; most Toria rows go to B3 (operator merge by public id); open questions 1, 3, 4, 14 closed |
| 2 | Emails per person | **Not collected upfront.** Each person opens Profile → *Sign in* (the *Keep my account* card / S1 banner) and types their own login details | A0 tests delivery with addresses the operator controls (Gmail, iCloud, Outlook test inboxes), not the four real ones; the B0 sheet gets the emails after the fact from `auth.users` |
| 3 | Mail sender | **Gmail with an app password** | 4.5 row “Custom SMTP” as written; Brevo only as fallback |
| 4 | Google sign-in | **Deferred until after the migration**; possible for everyone later; the Google Cloud owner account is decided then | Phase A ships **email codes only**: no Google button, `google_sign_in` stays `off`, no Google provider / OAuth client / redirect-URL work, no *Add Google* in the Account card, no device matrix. Google (4.6, *Add Google*, `linkIdentity`, manual linking) becomes **Phase E “Google”** after Phase C. `flowType: 'implicit'` is still pinned in Phase A so the later Google work changes no auth settings |
| 5 | Canonical phone rule | **No rule; a migration window instead.** Any phone may sign in first; the rest merge into it. People get time to move; after the window there is no anonymous (“generic phone”) option at all | B2 “canonical phone first” becomes “any phone first”; the person’s own order; the operator only verifies (B4). The window = Phase A live → Phase C lockdown |
| 6 | Master links | **Keep working during the migration window; close at lockdown** | `joinable = false` moves from the migration evening (B2 step n+1, B4 “all false”) to **Phase C step 4** (before `auth_mode = 'accounts'`). A phone that opens a master link during the window creates one more anonymous account, merged later like any other; C0 pre-flight re-runs the B0 leftover query for that reason |
| 7 | Invite gate | **Keep the invite code / join link during the migration; retire it after. After lockdown anyone who signs up becomes a member** | New `app_config.membership_mode` (`'invite'` default, `'open'` after lockdown), served by `siosia_config`; in `open` mode `siosia_whoami` inserts the membership row for any signed-in, non-anonymous, non-merged caller and the client never shows the Invite screen. Flipped in Phase C **after** the four are migrated (same evening as `auth_mode`). The test invite code keeps working through `siosia_join` so smoke/live accounts still land in the sandbox; a stray real sign-up is moved with `siosia_set_sandbox`. **Caveat recorded:** in open mode anyone holding the URL and an email address joins the real realm and sees the member list and catalog; the email gate stops anonymous bots, not people. The user accepted this. Reversible in seconds (`membership_mode = 'invite'`) |
| 8 | One role per person | accepted | — |
| 9 | Sign out | **Keep** | — |
| 10 | Migration order vs Google | codes only (follows from 4) | — |
| 11 | Soak | **30 days** | B5 / C5: delete anonymous auth users and drop `backup_2026_11` no earlier than 30 days after lockdown |
| 12 | Demo | sign-in free | — |
| 13 | Anyone linked email/Google before | **Unknown** | B0 query `select id, email, is_anonymous from auth.users where not is_anonymous` decides; such an account is that person’s account already |
| 15 | Google Cloud owner | later (with 4) | — |

Resulting release train: **2.12 accounts (email codes)** → migration window (self-service, operator merges leftovers) → **2.13 lockdown** (`joinable = false`, `auth_mode = 'accounts'`, `membership_mode = 'open'`, anonymous OFF) → 30-day soak → C5 cleanup → **Phase E Google** (optional, later). Spec paperwork: `membership_mode` joins V86; FR-329 gains the open-membership clause; the invite screen stays in the code for `invite` mode and the demo.

---

## 1. Goal and non-goals

**Goal**
- A person signs up / signs in with an **email address (6-digit code)** or a **Google account**. One real account per person, working on all their phones.
- The 4 existing people (to be confirmed: Toria, Roman, Karol, +1) keep everything: rides, appointments, feed photos and notes, tips, contracts, family seat, settlements and comments, kids and kid photos, profile photo, notification bell, push subscription on every phone.
- After migration no anonymous account can be created (dashboard) **or used** (SQL guard); new people register only via email or Google and still need the **invite code or a `#join=` link** to become members (two gates, as today).
- Zero running cost (SPEC §C). EN + PL for every string. Engine twin rule kept (V19).
- Demo (`?backend=mock`) never shows a sign-in screen; e2e stays credential-free.

**Non-goals (this release train)**
- Passwords for members (only the 3 smoke/live **test** users get passwords, created by the operator in the dashboard).
- Email in app tables (NFR-06 stays: the email lives only in `auth.users`; the operator looks people up in Authentication → Users).
- An email allow-list instead of the invite code.
- Google One Tap: N/A on iOS Safari and its redirect mode POSTs to a server GitHub Pages cannot receive *(web-auth 5b)*. The in-page GIS button with `signInWithIdToken` is **not** shipped either; it is only an optional item of the Phase A device matrix (§5, Phase A live check) because it is equally unproven on iOS standalone *(V-16)*.
- Rewriting `siosia_redeem_transfer` (`0001_siosia.sql:2091-2220`). It stays untouched for cached PWAs and its four test suites; its UI ("Move to the app") is retired in Phase C. Removing it is optional Phase D.
- Removing `siosia_same_person` / `siosia_person_accounts` / `siosia_listed` / `seen_at` (30+ call sites): they degenerate safely to the trivial case *(sql-identity 3)*; cleanup is optional Phase D.
- GDPR-style self-service deletion of the auth user (operator action in the dashboard; `siosia_delete_profile` keeps anonymising — see FR-331).

---

## 2. Target identity model

| Thing | Today | Target |
|---|---|---|
| Auth user | one **anonymous** `auth.users` row per browser storage (`src/backend/supabase/index.ts:263-284`) | one **permanent** row per person: email identity, optionally a Google identity. Same verified email on both → Supabase auto-links into one user *(web-auth, identity linking)* **(verify on live)**; a different Google email → a second account, merged by the "Merge another account here" path (§3) |
| Membership | per `(user_id, device_id)` (`memberships` PK `:157-172`); boot checks the device (`siosia_is_member(p_device)` `:2274-2277`, `store.ts:305`); every RPC checks the user (`siosia_guard` → `siosia_member_ok(uid)` with no device, `:1896-1906`) | **per person**: `siosia_is_member(p_device)` keeps its signature (§C: v1 rpc names kept for cached PWAs; `create or replace` cannot change a parameter list and would leave two overloads *(V-8)*) but returns `siosia_member_ok(auth.uid()) and not siosia_anon_blocked()`. New `siosia_whoami(p_device)` records the device as a membership row of the signed-in member (audit of "which phones") and bumps `seen_at`. The invite code / join link is entered **once per person** (FR-007 amended). `Engine.isMember(uid, deviceId?)` already has the device-less branch (`src/core/engine.ts:650-657`): the mirror is in the adapters — `Backend.isMember` ignores the device (`src/backend/types.ts:109`, `mock/index.ts:119-121`, `supabase/index.ts:321-323`), `store.ts:305/:720` stop passing it. Flips exactly `tests/unit/sql-backend.test.ts:118` (`'other-device'` becomes `true`); no engine test flips *(V-8)* |
| Master profiles | a join path (`#master=`, `siosia_join_master` `:2029-2068`) that makes one anonymous account per phone **and** a preset (locked nickname, icon, fixed fare, rider/driver role, default places, vehicle, offers; 59 readers) | **preset survives** on the merged account: `profiles.master_id` kept → `siosia_profile_json`, role rules, fixed fare and settlement keys `p:<master id>` (`siosia_side` `:5159-5163`) unchanged. **Join path retired** with a new column `master_profiles.joinable boolean not null default true` checked only in the `siosia_join_master` token lookup (`:2036-2038`) and its engine twin (`engine.ts:730`). Masters stay `active = true` and tokens are **not** rotated: `active = false` voids `via_master` memberships (`siosia_member_ok` `:1855-1860`) **and hides the presets** (`siosia_master_of` joins `and m.active`, `:833-836`); a new token in `siosia_set_master` **deletes** `via_master` rows (`:2248-2250`); dropping the master row cascades (`:175-177`) *(V-9)*. `siosia_set_master`'s upsert (`:2251-2258`) must not list `joinable`, or the documented "re-run with the same token to rename" (`SETUP.md:108-110`) would reopen the link. After migration the four survivors get `via_master = null` so their membership no longer depends on any master row |
| `siosia_same_person` / `person_accounts` / `listed` / `seen_at` | glue ~14 anonymous accounts into 3 people (`:1864-1893`) | left in place; with one account per person `same_person(a,b) ⇔ a=b`, `person_accounts(u) = {u}`, `listed = true` |
| Device id | `localStorage 'siosia.device'` (`src/services/device.ts:63-75`) | unchanged; used for membership audit rows, `p_device` of kept rpc signatures and the absorb step |
| Push | `push_subscriptions(endpoint PK, user_id)` (`:192-199`); dispatch fans out by `user_id` (`supabase/functions/push-dispatch/index.ts:47`) | unchanged shape: N phones under one user each get every push. The merge **re-points** `user_id` (never deletes, unlike `siosia_redeem_transfer` `:2215`); `siosia_save_push` already re-homes a phone's own endpoint on every `pushState()` (`src/services/push.ts:33-35`) |
| Realtime | one private `user:<uid>` channel per client; policy `'user:'||auth.uid()` (`:5795-5803`) | unchanged; N phones subscribe to the same topic. Drivers presence key is random per session (`index.ts:735-745`), fine |
| `driver_status`, `chat_presence`, `profiles.seen_at` | per user = per phone | per user = per person. Consequence: one person cannot be online as a driver on phone A and request a ride on phone B (`siosia_set_online` → `active_ride` `:2709-2711`; requests → `online_as_driver`). Toria rides, Roman drives; stated in the user guide. Two phones of one driver on D1 both heartbeat `last_seen` — documented limitation |
| Realm (`sandbox`) | per membership row, read as "any row" (`siosia_sandbox` `:909-912`) | unchanged; the merge ORs it; a fresh account (no membership) inherits the realm of the first phone it absorbs, exactly as `siosia_redeem_transfer` does (`:2203-2206`); every later absorb is checked by strict `same_realm`, so a mixed account is impossible *(V-7)* |
| Settlement sides | `'f:<family>'` else `'p:' || coalesce(master_id, uid)` (`:5159-5163`) | unchanged: `master_id` survives (explicit precondition, checked in B0: every phone of a person carries the same `master_id` or all null *(V-10)*), so `p:<master>` keys stay valid; only `p:<losing uid>` keys of plain accounts are rewritten (as `redeem_transfer` already does `:2181-2185`). `master_profiles` rows are never deleted (FK `on delete set null` `:171-173` would silently re-key every side) |
| Photos | private bucket `photos`, folders by `public_id`, ownership by the row holding the path (`siosia_photo_owner` `:4193-4200`; policies read bucket + name only `:5855-5867`) | unchanged: first-phone absorb moves the whole profile row (its `public_id` and folders come along); later phones keep their kid/update rows pointing at the survivor, so their folders stay readable/writable; losing rows keep `public_id` so the folder fallback still resolves. `storage.objects.owner` / `owner_id` are read by no Siosia policy and the FK `objects_owner_fkey` → `auth.users` was dropped by Storage tenant migration 0017 (2023) *(V-11)*; the merge still re-points them (guarded by `to_regclass`) and C5 verifies with `pg_constraint` before deleting users. Objects under a merged-away folder that no row holds (abandoned uploads) become ownerless: listed in B0 and dropped with `siosia_drop_photo_objects` in C5 |
| Test identity | 42 anonymous sandbox accounts; `scripts/smoke-supabase.mjs:40` and `tests/unit/supabase-live.test.ts` call `signInAnonymously()` | 3 permanent **email+password** sandbox users (`smoke-rider`, `smoke-driver`, `smoke-outsider`) created in the dashboard in Phase A; scripts use `signInWithPassword`; secrets in `.env.local` only, CI stays credential-free |
| Build identity | none visible (`package.json:4` is `1.0.0`, nothing rendered) | `__SIOSIA_BUILD__` = `2.12+<short sha>` from `vite.config.ts` (`GITHUB_SHA` in CI, `dev` locally), shown on Profile → About (`profile.build`). Two gates ("everyone updated" before the evening, "cached clients" before lockdown) depend on it |

---

## 3. Sign-in UX

### Decisions
- **Email = 6-digit code typed in the app; never a magic link.** The iOS Home Screen app has storage separate from Safari; a link tapped in Mail opens Safari, so the session (implicit flow) lands in the wrong storage *(web-auth 3; client-flow)*; Apple's WWDC23 guidance for Home Screen apps is one-time codes *(web-auth 3)*. `verifyOtp({email, token, type:'email'})` POSTs straight to `/auth/v1/verify`, reads no verifier, follows no redirect, and serves first sign-up (GoTrue matches `confirmation_token`) and returning login (`recovery_token`) alike *(V-2, confirmed from `internal/api/verify.go`)*. `signInWithOtp({ email })` with **`shouldCreateUser: true`** (today's `index.ts:795` passes `false`, which refuses new addresses with "Signups not allowed for otp"). Templates **Confirm signup** (what a brand-new address receives while *Confirm email* is ON), **Magic Link** (returning users) and **Change Email Address** carry `{{ .Token }}` and **no** `{{ .ConfirmationURL }}`; **Reset Password**, **Invite user** and **Reauthentication** are rewritten to an inert "Siosia never sends links — ignore this email" body with no URL, because `/auth/v1/recover` is callable by anyone holding the publishable key (it is in the Pages bundle) and would otherwise mail a link to any migrated address *(V-3)*. Defence in depth, not a guarantee. Code field: `inputMode="numeric" autoComplete="one-time-code"`, auto-submit at 6 digits.
- **Google = `signInWithOAuth({provider:'google'})` redirect in the implicit flow, pinned.** `createClient` passes no `flowType` (`index.ts:189-194`) and supabase-js / auth-js 2.117.3 default to `'implicit'` (`node_modules/@supabase/supabase-js/dist/index.mjs:36-40`, `auth-js/dist/module/GoTrueClient.js:14-28`) — the task brief's "PKCE default" is wrong; 2.12 passes `flowType: 'implicit'` explicitly so a library upgrade cannot flip it *(V-1)*. PKCE would need the verifier in the **same** storage the redirect returns to, which iOS Home Screen ↔ Safari sheet does not give. `redirectTo()` = origin + pathname (`index.ts:68`) drops the app's own hash; `#master=`/`#join=` are parked in sessionStorage before the client is constructed (`store.ts:290-297`), so no hash collision *(client-flow)*; the hash readers must keep preserving foreign params until auth-js has consumed `#access_token` (they do today). `queryParams: { prompt: 'select_account' }` for shared phones. Google is **secondary** and **expected to fail from the iOS Home Screen app** (the OAuth round trip runs in a separate Safari sheet with its own storage; `disallowed_useragent` was reported historically; Supabase discussion #12227 still unanswered) *(V-16)*; the deployment flag `googleSignIn` (`'off' | 'no_standalone' | 'no_ios' | 'on'`, from `app_config` through `siosia_config`) hides the button per platform without a release (`src/services/device.ts:51` already detects standalone). The email code is the universal path; with the same Gmail address Google on Android and the code on iPhone land in the same account anyway.
- **Boot order**: `ping()` → `getConfig()` (anon-granted `siosia_config`, now with `authMode` and `googleSignIn`; `ping()` already fetches it before any session, `index.ts:297`) → `start({ anonymousOk: authMode === 'anonymous' })` → … This swaps today's `start()`/`getConfig()` order (`store.ts:300-301`); nothing between them depends on the uid *(V-5)*.
- **`start()` never forges an identity in accounts mode**: no session (fresh storage, or a stored session whose refresh failed — reuse detection, paused iOS PWA) → return `null` with `sessionLost: true` when the `siosia.auth` key existed; the sign-in screen says `signin.sessionLost`. In anonymous mode the behaviour stays as today *(V-12, V-13)*.
- **Membership asked once per person** after the first sign-in, unless the person arrived through `#join=` or an absorb (the old phone was already a member). A member's new phone: sign in → app.
- **Sign out stays** (families share phones), behind a confirmation; it drops the parked absorb entry, unsubscribes this browser's push subscription (`siosia_remove_push` or the existing delete path) so the previous person's notifications stop on that phone, then clears the session; afterwards the device lands on the sign-in screen (accounts mode) or mints a new anonymous session (anonymous mode, as today).
- **Add Google** in the Account card = `auth.linkIdentity({provider:'google'})` for an account that has no Google identity yet (same uid, no reload); needs *Allow manual linking* ON during Phases A–C, turned OFF after the four accounts are set (optional, Phase C step 6). After linking, call `refreshSession()` so a fresh JWT is in hand (claims reflect the state at issuance) *(V-12)*.

### Boot flow (Phase A onwards)
`boot()` (`src/state/store.ts:282-313`): unsupported check → `takeMasterToken()` / `takeJoinToken()` → `loadConfig` → `api.ping()` → `deployment = await api.getConfig()` → `uid = await api.start({ anonymousOk })` → if `uid === null` → `patch({ phase: 'signin', authError, sessionLost })` and return (tokens wait in sessionStorage; the OAuth error, if any, was captured in `main.tsx` before the client cleared the hash) → `who = await api.whoami(deviceId())` → **if `who.mergedInto`** → `patch({ phase: 'signin', linkNotice: 'account_merged' })` and return (both auth modes; the notice names the survivor's public id) → **if `who.signInRequired`** (straggler in accounts mode) → `phase 'signin'` with `linkNotice 'sign_in_required'` and return → `openMaster` / `openJoinLink` if tokens → if a parked absorb entry exists in `localStorage['siosia.absorb']` and is bound to this sign-in (see handshake) → `api.absorb(code, deviceId())` (notice `signin.merged`, or `signin.absorbFailed` with the reason and a Retry; the entry stays parked until it expires) — otherwise the entry is dropped with notice `signin.absorbSkipped` → if `!who.member` → `phase 'invite'` → else `afterMember()`.

Cached-client path (shipped in **2.12**, used on lockdown day): `refresh()` and `applyMy` treat `ServerError('sign_in_required')` and `ServerError('account_merged')` like `not_member` → `lostProfile()` → `boot()`, which ends on the sign-in screen with the notice. `siosia_is_member` returns `false` when `siosia_anon_blocked()`, so even a cached **2.11** build falls into its invite screen (where `siosia_join` refuses with `sign_in_required`) instead of showing `common.error` in a loop; the SW checks for a new build on visibilitychange every ≥5 min (`vite.config.ts:13-49`).

### Absorb handshake (the per-phone migration, automatic, bound to the person)
Parking happens in **one place**, `store.signIn.prepare()`, called by the S1 banner path, the *Keep my account* card and the sign-in screen (straggler case) whenever `who.anonymous && who.member && who.hasProfile`, **before** `sendCode` / `signInWithGoogle`: call `siosia_create_transfer()` (lenient guard `siosia_guard_any`, §4.1.5 — in accounts mode it and `siosia_whoami` are the only RPCs an anonymous caller can still complete) and park `{ code, exp, oldPublicId, forEmail }` in `localStorage['siosia.absorb']` (30 min, the code's own lifetime, `:2075`), where `forEmail` is the lower-cased address typed, or `null` for Google. After sign-in the uid changes → `onAuthStateChange` reloads (`index.ts:273-282`) → `boot()` as the new user absorbs **only when** `account().email` (lower-cased) equals `forEmail`, or `forEmail` is null and `sessionStorage['siosia.authReturn']` shows a Google return in this boot cycle. Otherwise (shared phone, Sign out followed by someone else's sign-in inside the window) the entry is dropped and `signin.absorbSkipped` shows the old public id; the operator then uses `siosia_merge_into` by public id. If the old account is not a member or has no profile, nothing is parked and nothing is absorbed.

### Screens (new `SignInScreen` in `src/screens/Boot.tsx`; phase `signin` in `src/App.tsx`)
1. **Sign in** — title, email field, *Send me a code*, divider *or*, *Continue with Google* (hidden per `googleSignIn`), *Try demo mode* (existing link). A notice line when `linkNotice` is `sign_in_required`, `account_merged`, `google_failed`, `session_lost` or `absorb_skipped`.
2. **Enter the code** — the email shown, 6-box code field, *Continue*, *Resend code* after a 60 s countdown, *Use another email*, spam hint.
3. **Invite** (existing `InviteScreen`, wording "once"), **Nickname** (existing). `MoveHere` stays embedded in Phase A, removed in Phase C.
4. **Profile → Account card** (`src/screens/Profile.tsx:139-196`, rewritten): "Signed in with {list}" + email; *Add Google sign-in* (when no Google identity); *Merge another account here* (paste a code shown in the other account's Account card → `siosia_absorb`; covers "I used a different Google email by mistake"); *Show code* (existing `move.*` strings); *Sign out* with confirm. **About** line shows `profile.build`. **Delete my profile** confirm gains `profile.deleteNote` (sign-in stays). **Anonymous users (Phases A–B):** a *Keep my account* card at the top of S2 and a one-line S1 banner leading to the same two screens; on success the old account is absorbed automatically.

### What each case looks like
| Case | What the person does | What happens |
|---|---|---|
| Existing phone, Phase A/B (anonymous member with profile) | S1 banner → email → code | reload under the new user → absorb in **move** shape (new account has no profile: the whole profile row moves, `public_id`, photo, kids, `master_id`, family seat, contracts, settlements, bell, push subscription, device row) → S1 as before, Account card shows the email. Active ride on the old account → `active_ride`, try after the ride |
| Second phone of the same person | same taps, **same email** | absorb in **merge** shape (account already has a profile): this phone's history, kids, bell, push subscription, device row are added; its profile row is marked `deleted`, `merged_into` set |
| Returning phone | nothing | session persists via refresh tokens; `whoami` records the device |
| Storage cleared / signed out | sign in | `whoami.member = true` → app, no invite code |
| New phone of a member (after lockdown) | sign in | app |
| Brand-new person | sign in → invite code or `#join=` → nickname | member |
| Straggler after lockdown (old anonymous session alive) | taps anything | `siosia_guard` → `sign_in_required` → sign-in screen with notice; `prepare()` parks a code (`create_transfer` uses the lenient guard), so the absorb still works |
| Merged-away phone reappears (operator-merged in B3, or absorbed from Safari while the Home Screen app kept its session) | opens the app | `whoami.mergedInto` → sign-in screen with `account_merged`; `siosia_join` / `siosia_join_link` refuse `already_merged`, so the invite code cannot resurrect it |
| Cached old build on a fresh storage after lockdown | opens the app | `signInAnonymously` → 422 `anonymous_provider_disabled` → Unavailable → Retry pulls the new build (SW `autoUpdate`, `skipWaiting`, `vite.config.ts:13-49`) |
| Bookmarked `#master=` link after `joinable = false` | opens the bookmark | own master → `noop`, nothing shown; anyone else → `bad_link` without an `invite_failures` row (no rate-limit lockout) |
| Demo | nothing | `MockBackend.start()` returns the tab uid (`src/backend/mock/index.ts:109-111`), `getConfig()` serves `authMode = 'anonymous'` from `DEFAULT_CONFIG`, `api.account` undefined → no sign-in screen; Account card shows `profile.accountsDemo` *(V-15)* |

### Error mapping (`authError`, `src/backend/supabase/index.ts:125-134`)
| Supabase code / status | `ServerError` code | EN | PL |
|---|---|---|---|
| `otp_expired` (also the message "Token has expired or is invalid" — GoTrue does not distinguish wrong from expired) | `bad_code` | That code is not right or has expired — ask for a new one. | Ten kod jest nieprawidłowy albo wygasł — poproś o nowy. |
| 429 / `over_email_send_rate_limit` / `over_request_rate_limit` | `rate_limited` (exists) | Too many tries — wait a minute. | Za dużo prób — odczekaj minutę. |
| `email_address_not_authorized` | `email_not_allowed` | This Siosia cannot email that address yet — tell the operator. | Ta Siosia nie może jeszcze wysłać e-maila na ten adres — powiedz operatorowi. |
| `signup_disabled` / `user_not_found` / `otp_disabled` | `no_account` (exists; retext) | Sign-ups are closed. Ask the operator for an invitation. | Rejestracja jest zamknięta. Poproś operatora o zaproszenie. |
| `provider_disabled` / `email_provider_disabled` / `manual_linking_disabled` | `not_enabled` (exists) | keep | keep |
| `identity_already_exists` / `email_exists` | `email_in_use` (retext) | This email belongs to another account. Sign in with it instead. | Ten e-mail należy do innego konta. Zaloguj się nim. |
| OAuth error in the return hash (`#error_code=…`, swallowed by auth-js `_initialize` *(client-flow)*) | `google_failed` | Google sign-in did not finish ({reason}). Use the email code instead. | Logowanie Google nie powiodło się ({reason}). Użyj kodu z e-maila. |
| `anonymous_provider_disabled` (old client only) | `unavailable` (exists) | — | — |
| `sign_in_required` (new guard code) | `sign_in_required` | Please sign in to continue. Your history is safe. | Zaloguj się, aby kontynuować. Twoja historia jest bezpieczna. |
| `account_merged` (new guard code; also `whoami.mergedInto`) | `account_merged` | This phone's old account was moved into your account. Sign in with your email to continue. | Stare konto z tego telefonu przeniesiono do Twojego konta. Zaloguj się e-mailem, aby kontynuować. |
| `already_merged` (joins) | `already_merged` | same text as `account_merged` | same |
| stored session gone (accounts mode) | `session_lost` | You were signed out on this phone. Sign in again — nothing is lost. | Zostałeś wylogowany na tym telefonie. Zaloguj się ponownie — nic nie przepadło. |

### Strings (`src/i18n/en.ts` is the key source; `pl.ts` is `Record<MessageKey,string>`, CI fails on a missing twin)
| key | EN | PL |
|---|---|---|
| signin.title | Sign in to Siosia | Zaloguj się do Siosi |
| signin.body | Use the same email on every phone — your history follows you. | Używaj tego samego e-maila na każdym telefonie — historia idzie za Tobą. |
| signin.email | Email | E-mail |
| signin.sendCode | Send me a code | Wyślij mi kod |
| signin.or | or | albo |
| signin.google | Continue with Google | Kontynuuj z Google |
| signin.googleHint | Opens Google in this window and comes back here. | Otwiera Google w tym oknie i wraca tutaj. |
| signin.codeTitle | Enter the code | Wpisz kod |
| signin.codeBody | We sent a 6-digit code to {email}. It is valid for 30 minutes. | Wysłaliśmy 6-cyfrowy kod na {email}. Jest ważny 30 minut. |
| signin.code | Code | Kod |
| signin.verify | Continue | Dalej |
| signin.resend | Resend code | Wyślij kod ponownie |
| signin.resendIn | Resend in {s} s | Ponownie za {s} s |
| signin.otherEmail | Use another email | Użyj innego e-maila |
| signin.checkSpam | Not there? Check Spam and Promotions. | Nie ma? Sprawdź Spam i Oferty. |
| signin.keepTitle | Keep my account | Zachowaj moje konto |
| signin.keepBody | Sign in with your email or Google so your history works on every phone. | Zaloguj się e-mailem lub przez Google, aby historia działała na każdym telefonie. |
| signin.banner | Sign in to keep your history on every phone | Zaloguj się, aby zachować historię na każdym telefonie |
| signin.absorbing | Joining this phone to your account… | Dołączanie tego telefonu do Twojego konta… |
| signin.merged | This phone's old account was joined to your account. | Stare konto z tego telefonu dołączono do Twojego konta. |
| signin.absorbFailed | This phone's old account ({publicId}) could not be joined yet: {reason}. Try again or tell the operator. | Nie udało się jeszcze dołączyć starego konta z tego telefonu ({publicId}): {reason}. Spróbuj ponownie albo powiedz operatorowi. |
| signin.absorbSkipped | This phone's old account ({publicId}) was not joined — it was for another email. Tell the operator. | Stare konto z tego telefonu ({publicId}) nie zostało dołączone — było dla innego e-maila. Powiedz operatorowi. |
| signin.retryAbsorb | Try again | Spróbuj ponownie |
| signin.required | Siosia now needs you to sign in. Your history is safe. | Siosia prosi teraz o zalogowanie. Twoja historia jest bezpieczna. |
| signin.sessionLost | You were signed out on this phone. Sign in again — nothing is lost. | Zostałeś wylogowany na tym telefonie. Zaloguj się ponownie — nic nie przepadło. |
| profile.providers | Signed in with {list} | Zalogowano przez {list} |
| profile.addGoogle | Add Google sign-in | Dodaj logowanie Google |
| profile.mergeTitle | Merge another account here | Połącz tu inne konto |
| profile.mergeBody | Show a code in the other account (Account → Show code) and paste it here. | Pokaż kod na drugim koncie (Konto → Pokaż kod) i wklej go tutaj. |
| profile.signOutConfirm | Sign out on this phone? Notifications for this account stop here until you sign in again. | Wylogować na tym telefonie? Powiadomienia dla tego konta przestaną tu przychodzić do ponownego zalogowania. |
| profile.build | Build {id} | Wersja {id} |
| profile.deleteNote | Your sign-in stays; to remove it completely ask the operator. | Logowanie zostaje; aby usunąć je całkiem, poproś operatora. |
| invite.body (changed) | This Siosia is private. Enter the code from the operator — once. | Ta Siosia jest prywatna. Wpisz kod od operatora — raz. |
| err.bad_code, err.email_not_allowed, err.google_failed, err.sign_in_required, err.account_merged, err.already_merged, err.session_lost, err.no_account (retext), err.email_in_use (retext) | see the table above | |

Removed keys: `profile.linkEmail` ("Link email (magic link)", `en.ts:65`), `profile.signInEmail`, `profile.emailSent`, `profile.linkGoogle`, `profile.signInGoogle`, `profile.anonymous` (replaced by `signin.keep*`). `tests/unit/services.test.ts` i18n completeness must still pass.

---

## 4. Backend changes

### 4.1 SQL (`supabase/migrations/0001_siosia.sql`, idempotent, whole file re-run)
1. **Config columns + `siosia_config`**: `alter table app_config add column if not exists auth_mode text not null default 'anonymous' check (auth_mode in ('anonymous','accounts'))`, `add column if not exists google_sign_in text not null default 'off' check (google_sign_in in ('off','no_standalone','no_ios','on'))`; `siosia_config()` adds `'authMode', auth_mode, 'googleSignIn', google_sign_in`. Both values are public to anyone with the publishable key (like `vapidPublicKey`); plain enums only. Operator switch: `update app_config set auth_mode = 'accounts' where id = 1;` (rollback `'anonymous'`). `auth_mode` is informational for the client; enforcement is the guard (5) plus the dashboard toggle *(V-5)*.
2. **`master_profiles.joinable boolean not null default true`**; `siosia_join_master` looks the token up with `and active` as today (`:2036-2038`); if the master is found and `joinable = false`: when the caller's live profile already has `master_id = m.id` → `siosia_ok('noop')` (no `invite_failures` row, no notice); otherwise → `bad_link` **without** inserting into `invite_failures` (`:2041`), so a bookmarked link cannot lock a user out of `siosia_join` / `siosia_absorb` / `siosia_redeem_transfer` with `rate_limited`. `siosia_set_master`'s `on conflict do update` list (`:2254-2257`) does **not** touch `joinable`. Operator: `update master_profiles set joinable = false where id = '<master>';` per master, same evening as that person's migration. Client `openMaster` treats `noop` as nothing to confirm.
3. **`siosia_is_member(p_device text)`** → `select siosia_member_ok(auth.uid()) and not siosia_anon_blocked()` (same signature; grant at `:5678` unchanged). Update `tests/unit/sql-backend.test.ts:118`.
4. **`profiles.merged_into uuid`** (null; set on the losing row by the merge). `profiles.deleted` rows with `merged_into` keep their `public_id` so `siosia_photo_owner`'s folder fallback still resolves.
5. **Guards** (no overload of `siosia_guard(boolean)` — a second overload with a default would make `siosia_guard(true)` ambiguous):
   ```sql
   create or replace function siosia_anon_blocked() returns boolean ... as $$
     select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
        and (select auth_mode from app_config where id = 1) = 'accounts' $$;
   create or replace function siosia_merged_away(p_uid uuid) returns boolean ... as $$
     select exists (select 1 from profiles where user_id = p_uid and merged_into is not null) $$;
   create or replace function siosia_guard_any(p_need_profile boolean) returns text ...  -- today's body of siosia_guard (:1896-1906)
   create or replace function siosia_guard(p_need_profile boolean) returns text ... as $$
     begin
       if siosia_merged_away(auth.uid()) then return 'account_merged'; end if;   -- the soak freeze (V-13)
       if siosia_anon_blocked() then return 'sign_in_required'; end if;
       return siosia_guard_any(p_need_profile);
     end $$;
   ```
   `siosia_create_transfer` switches to `siosia_guard_any(true)` (the straggler's way out; a merged-away caller fails there on `no_profile`, which is right). `siosia_join`, `siosia_join_link`, `siosia_join_master`, `siosia_redeem_transfer` (which calls no guard today, only `auth.uid() is null`, `:2091-2096`) and `siosia_whoami` check `siosia_anon_blocked()` and `siosia_merged_away()` explicitly (`:1978, :2034, :2095, :4791`). The freeze is immediate (PostgREST evaluates it on every call, unlike a ban that bites only after JWT expiry), keeps the old session alive for `whoami`, and is undone with `update profiles set merged_into = null, deleted = false where user_id = …`. RLS: no rewrite — all policies are `to authenticated` + `member_ok` (`:5797-5872`); an anonymous straggler can at most read its own rows and its own `user:<uid>` broadcasts until merged/deleted. A PGlite test asserts `has_function_privilege('anon', 'siosia_config()')` after the revoke loop (`:5665-5671`), since the plan now depends on that grant.
6. **`siosia_whoami(p_device text) returns jsonb`** (granted to authenticated; **not guarded**, answers anonymous and merged-away callers): returns `{member, hasProfile, anonymous, signInRequired: siosia_anon_blocked(), mergedInto: <survivor public_id or null>, sandbox}`; `member` is false for a merged-away caller; when `member` and not blocked and not merged: `insert into memberships (user_id, device_id, via_master, sandbox) select auth.uid(), p_device, (via_master preferring null), siosia_sandbox(auth.uid()) on conflict do nothing` and `update profiles set seen_at = now() where user_id = auth.uid() and seen_at < now() - interval '1 minute'`.
7. **`siosia_merge_accounts(p_from uuid, p_into uuid, p_mode text) returns jsonb`** — internal, `security definer`, never granted. `p_mode in ('absorb','operator')` ('operator' skips the realm test). Modelled line by line on `siosia_redeem_transfer` `:2117-2218` with these differences:
   - preconditions: both in `auth.users`; `p_from <> p_into`; `p_from` has a live profile and `siosia_member_ok(p_from)`; `siosia_same_realm(p_from, p_into) or not exists (select 1 from memberships where user_id = p_into)` (tested explicitly — no-membership and real-realm both read as `sandbox = false` *(V-7)*); advisory locks in uid order; `siosia_sweep()`; `active_ride` if either has a live ride; `siosia_go_offline` both;
   - **profile**: if `p_into` has no live profile → `update profiles set user_id = p_into where user_id = p_from` (first-phone case: `public_id`, photo folders, nickname, `master_id`, counters survive). Else `p_into` keeps its row and copies missing fields (`photo_path`, `home`, `offers`, `master_id`, `language`), `created_at = least(...)`, cancel counters summed; `p_from`'s profile photo object dropped only if `p_into` already had one (`siosia_drop_photo_object` `:4258-4269`); `p_from`'s row → `deleted = true, merged_into = p_into, master_id = null, photo_path = null`. Never finish with a plain, master-less row on the survivor when any phone of the person carried `master_id` *(V-10)*;
   - **kids** re-pointed, never deleted (unlike `:2157-2161`); **notifications** re-pointed, `p_into`'s kept (unlike `:2178`);
   - **family**: only `p_from` has a seat → `update family_members set user_id = p_into` without `siosia_drop_from_families` (which can end contracts `:4664-4673`); both in the same family → delete `p_from`'s row; different families → `raise exception 'two_families'`. Pending `family_invites` to `p_from` for a family `p_into` already belongs to are deleted, others re-pointed;
   - **dedupe before every uid update**: offers `(ride_id, driver_id, round)` and `offers_one_offered`; ratings per ride / per appointment; `chat_presence` per room; `rides_appointment_leg` (cancel `p_from`'s duplicate live leg); `contracts_active_uq` / `contracts_proposed_uq` (mark `p_from`'s duplicate `withdrawn` / `replaced`, re-point its `appointments.contract_id`); duplicate pending `family_invites` to the same family → decline `p_from`'s;
   - rides (`rider_id`, `driver_id`, `excluded[]`), appointments (`client_id`, `provider_id`, `tip_by`), series, kid_ratings, messages, appointment_updates, family_invites, contracts (`provider_id`, `proposed_by`, `ended_by`), member_invites (`from_user`, `used_by`) as in redeem;
   - **settlements**: `by_user` / `with_user` / `comment_by` and `'p:'||p_from → 'p:'||p_into`; `'p:<master id>'` untouched (`master_id` survives);
   - **memberships**: all of `p_from`'s rows re-keyed (`insert … select p_into, device_id, via_master, sandbox … on conflict (user_id, device_id) do update set sandbox = memberships.sandbox or excluded.sandbox, via_master = case when memberships.via_master is null then null else excluded.via_master end`), then `p_from`'s deleted;
   - **push_subscriptions**, **push_outbox**: `user_id` re-pointed; `vehicles`: `p_into`'s wins if present; `driver_status` and `account_transfers` of `p_from` deleted;
   - **storage**: `if to_regclass('storage.objects') is not null then update storage.objects set owner = p_into, owner_id = p_into::text where owner = p_from; end if;` (no policy reads these; harmless belt and braces *(V-11)*);
   - `siosia_notify` both; returns jsonb of row counts per table plus `warnings[]`; a second call finds no live `p_from` profile → `already_merged`.
   - **Resolution for `two_families`** (operator, same evening): decide which family is the real one from B0 (`select f.user_id, p.nickname, f.family_id from family_members f join profiles p using (user_id)`), then `delete from family_members where user_id = <losing uid>` **only if** that family has other members; if it would become a family of one, end its contracts by hand (`update contracts set status = 'ended', ended_by = <uid>, ended_at = now() where family_id = … and status in ('active','proposed')`) and delete the family; re-run `siosia_merge_into`. Never `siosia_leave_family` (can end contracts the survivor needs).
8. **`siosia_absorb(p_code text, p_device text) returns jsonb`** (granted to authenticated): validates the code exactly like redeem (hash, expiry, `invite_failures` rate limit, `for update` re-check under the locks); caller must not be `siosia_anon_blocked()` nor `siosia_merged_away()`; `v_old = auth.uid()` → no-op ok; `perform siosia_merge_accounts(v_old, auth.uid(), 'absorb')`; delete the code; insert `(auth.uid(), p_device)` membership; return `siosia_profile_json(auth.uid())`. Errors surface as `{error: 'active_ride' | 'two_families' | 'bad_transfer' | 'rate_limited'}`.
9. **`siosia_merge_into(p_from_public text, p_into_public text) returns jsonb`** (operator, never granted; SQL editor): resolves public ids → uids (raise if missing or if `p_into` is deleted), calls `siosia_merge_accounts(from, into, 'operator')`.
10. **Grants**: `siosia_whoami(text)`, `siosia_absorb(text, text)` to authenticated; `siosia_merge_accounts`, `siosia_merge_into` left out of the grant block (all `siosia_%` are revoked first, `:5665-5671`).
11. `siosia_redeem_transfer` (apart from the two explicit checks in 5), `siosia_delete_profile`, `siosia_sweep`, Edge Functions: unchanged.
12. **Operator SQL lives in a file**: `scripts/ops/2026-11-accounts.sql` holds, in order and clearly labelled, A0 checks, B0, B0.1, B1, B4, B5, C0, C5 and the restore block. The rehearsal (§5 Phase A) executes the file's blocks with `fs.readFileSync`; the operator pastes from the file, never retypes.

### 4.2 Engine twin (`src/core/engine.ts`)
- `isMember(uid, deviceId?)`: any membership counts (adapters stop passing the device); `whoami(uid, device)`: `{member, hasProfile, anonymous:false, signInRequired:false, mergedInto}` + device row; `joinMaster` honours `cfg.masters[*].joinable !== false` with the `noop` / silent `bad_link` semantics of 4.1.2; `join` / `joinLink` refuse `already_merged`.
- `absorb(uid, code, device)`: mirror of `siosia_absorb` + the keep-both merge, modelled on `redeemTransfer` (`:781-901`) with the differences of 4.1.7 (`DbState.profiles[uid].mergedInto`, push subs re-pointed if modelled, memberships union, settlements `p:<uid>` rewrite, dedupes, `two_families`); `guard` returns `account_merged` for a merged-away uid.
- `siosia_merge_into` has no twin (operator-only precedent: `siosia_set_master`, `siosia_set_sandbox`); its body is shared with the twinned absorb; the `'operator'` realm bypass is covered by a PGlite test only.
- The engine has no notion of email/provider/anonymous; `authMode` and `googleSignIn` are `DeploymentConfig` fields (`DEFAULT_CONFIG` keeps `'anonymous'`, `'off'`), served by `MockBackend.getConfig()` (`src/backend/mock/index.ts:113-117`) so the demo stays sign-in-free by construction *(V-15)*.

### 4.3 PGlite harness (`tests/unit/sql-harness.ts`) — **lands before any SQL change**
- Every `sql-*.test.ts` runs the whole migration; a `language sql` body or policy that mentions `auth.jwt()` fails at **CREATE** and takes all six harness suites down, a plpgsql body fails at call time *(V-14)*. So: PRELUDE adds `auth.jwt()` = `coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)`; `auth.users (id uuid primary key, email text unique, is_anonymous boolean not null default true, banned_until timestamptz, created_at timestamptz default now())`; `as(uid, sql, params, {anonymous, email})` sets **both** `request.jwt.claim.sub` and `request.jwt.claims` = `{"sub": uid, "role": "authenticated", "is_anonymous": bool, "email": …}` (default `is_anonymous: false`, so existing tests are untouched); `createHarness` gains `asAnon()`, `asRole('anon', sql)` and `addUser({email})`; a `storage.buckets` / `storage.objects (id, bucket_id, name, owner uuid, owner_id text)` stub (pattern from the scratchpad `upgrade25.test.ts.txt`) so the merge's storage branch and `siosia_can_see_photo` can be asserted.
- **Two copies**: `tests/unit/sql-backend.test.ts:13-34` duplicates the prelude and its own `as()` at `:57-64`; switch it to `import { PRELUDE, createHarness } from './sql-harness'` in the same commit.

### 4.4 Client (`src/backend/types.ts`, `src/backend/supabase/index.ts`, `src/backend/mock/index.ts`, `src/state/store.ts`, `src/App.tsx`, `src/screens/Boot.tsx`, `src/screens/Profile.tsx`, `src/main.tsx`, `vite.config.ts`)
- `Backend.start(opts: { anonymousOk: boolean }): Promise<{ uid: string | null, sessionLost: boolean }>`; `whoami(device)`; `absorb(code, device)`; `sendCode(email)` = `signInWithOtp({ email, options: { shouldCreateUser: true } })` (no `emailRedirectTo`); `verifyCode(email, token)` = `verifyOtp({ email, token, type: 'email' })`; `signInWithGoogle()` = `signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo(), queryParams: { prompt: 'select_account' } } })`; `linkGoogle()` (+ `refreshSession()`), `signOut()` (drop parked absorb, push unsubscribe, then sign out), `account()`, `createTransfer()` (exists). `createClient` gains `flowType: 'implicit'`. Mock: `start()` returns the tab uid; `whoami` from the engine; no auth methods; `getConfig()` serves `authMode`/`googleSignIn` from `DEFAULT_CONFIG`.
- `SupabaseBackend.start()`: `getSession()`; none and `anonymousOk` → `signInAnonymously()` as today; none and not → `{ uid: null, sessionLost: localStorage had 'siosia.auth' }` (the `onAuthStateChange` listener is registered in both cases; `'' → uid` after `verifyOtp` triggers the existing reload, which is the carrier of the absorb; `linkIdentity` keeps the uid and does not reload).
- `src/main.tsx`: copy `location.hash` into `sessionStorage['siosia.authReturn']` before the backend is constructed; `boot()` reads `error_code` / `error_description` → `google_failed`, and `access_token` presence → "Google return in this boot cycle" for the absorb binding.
- Store: phase union gains `'signin'`; `boot()` as in §3; `signIn.prepare / sendCode / verify / google / retryAbsorb` actions; `refresh()` / `applyMy` map `sign_in_required` and `account_merged` to `lostProfile()`; `theme.test.tsx:312` Launch-overlay expectation gains `'signin'`.
- `App.tsx`: `case 'signin': <SignInScreen/>`.
- `vite.config.ts`: `define: { __SIOSIA_BUILD__: JSON.stringify('2.12+' + (process.env.GITHUB_SHA ?? 'dev').slice(0, 7)) }`; Profile → About renders `profile.build`.
- Delete-profile confirm text gains `profile.deleteNote` (FR-331: profile deletion ≠ account deletion; `siosia_delete_profile` still deletes all memberships `:2394` and push subscriptions, the auth user stays).
- Phase C: `MoveHere` and the Move section of Profile removed (RPCs stay).

### 4.5 Supabase dashboard (project `ksnsblfngzlqfdfdaken`, operator in Chrome)
| Setting | Where | Value | Phase |
|---|---|---|---|
| Custom SMTP | Project Settings → Authentication → SMTP Settings | **Gmail SMTP with an App Password** (`smtp.gmail.com`, 587, user = a Gmail with 2-Step Verification, password = 16-char app password, sender email = **that same address** (Gmail rewrites any other From), sender name "Siosia") **(verify: app passwords available on that account; ~500 mails/day)**. Fallback **Brevo free** (300/day, verified single sender, Brevo footer) *(web-auth 4)*. Alternative with the same effect: the Send Email auth hook (Free) in front of an Edge Function + Resend — more moving parts, not chosen. Mandatory: the built-in mailer sends 2/hour project-wide and **only to Supabase team addresses** ("Email address not authorized" for Toria/Karol) *(V-4, confirmed)*; `docs/SETUP.md:255` ("works out of the box") is stale since 26 Sep 2024 and is rewritten | A0 |
| Emails per hour | Authentication → Rate Limits | 30 (default after custom SMTP) | A0 |
| Email provider | Authentication → Providers → Email | enabled; *Confirm email* ON (keeps first-time OTP on the Confirm-signup template; OFF would route them to Magic Link — both are token-only anyway); *Allow new users to sign up* ON (membership is the gate); OTP length 6; *Email OTP Expiration* 1800 s; *Secure email change* irrelevant (no in-place email change in this plan) | A0 |
| Templates | Authentication → Email Templates | **Confirm signup**, **Magic Link**, **Change Email Address**: subject `Siosia: {{ .Token }}`, body with the code large, EN + PL in one mail, **no `{{ .ConfirmationURL }}`**. **Reset Password**, **Invite user**, **Reauthentication**: inert body "Siosia never sends links. If you did not expect this email, ignore it. / Siosia nie wysyła linków…", no URL | A0 |
| Google provider | Authentication → Providers → Google | enabled; client ID + secret from 4.6; default scopes only (adding scopes triggers Google verification); *Skip nonce check* OFF | A |
| Manual linking | Authentication → Sign In / Providers → Allow manual linking | ON (for *Add Google*); may go OFF after the 4 accounts are set | A → C |
| URL configuration | Authentication → URL Configuration | Site URL `https://rlgdev.github.io/siosia/`; Redirect URLs `https://rlgdev.github.io/siosia/**`, `http://localhost:4173/**`, `http://localhost:5173/**` (`**` crosses `/`, `*` does not *(web-auth 7)*); needed for Google only | A |
| Test users | Authentication → Users → Add user (auto-confirm) | `smoke-rider@…`, `smoke-driver@…`, `smoke-outsider@…` on addresses the operator controls (Gmail `+` aliases); passwords in `.env.local` only | A |
| Anonymous sign-ins | Authentication → Sign In / Providers → Allow anonymous sign-ins | ON through A and B; **OFF in C** after `auth_mode = 'accounts'`; confirm with `GET /auth/v1/settings` → `external.anonymous_users: false` (a restart was needed in one reported case) *(V-12)* | C |
| CAPTCHA | Authentication → Sign In / Providers | OFF (unchanged) | — |

### 4.6 Google Cloud (free) — numbered, current console names
1. `console.cloud.google.com` with the operator's Google account (open question 15: it becomes the only admin; recommended: the account that holds the Supabase org) → **New project** "Siosia", no billing.
2. **APIs & Services → Google Auth Platform** → **Branding**: app name "Siosia", support email, developer email (no logo: a logo triggers brand review and is withheld until then); **Audience**: External → **Publish app** → In production (basic scopes need no verification; leaving it in Testing caps sign-in at 100 listed users with grants expiring after 7 days); **Data access**: `openid`, `…/auth/userinfo.email`, `…/auth/userinfo.profile` only, identical to what the Supabase provider requests (a mismatch triggers the "unverified app" interstitial). Without brand verification (needs a verified home-page domain + privacy policy) the consent page reads "to continue to ksnsblfngzlqfdfdaken.supabase.co" — cosmetic; a Supabase custom domain is paid, excluded by SPEC §C *(V-16)*.
3. **Clients → Create client → Web application** → name "Siosia web"; Authorized JavaScript origins `https://rlgdev.github.io`, `http://localhost:4173`, `http://localhost:5173`; Authorized redirect URI: copy the **Callback URL (for OAuth)** shown in Supabase → Authentication → Providers → Google (expected `https://ksnsblfngzlqfdfdaken.supabase.co/auth/v1/callback`).
4. Paste Client ID and Client secret into that Supabase page; Save.

### 4.7 Edge functions, realtime, storage
No change: push-dispatch / calendar use the service role; realtime and storage policies are `to authenticated` + `member_ok`. The merge's only storage write is the `owner` re-point (4.1.7), guarded by `to_regclass` so PGlite without the stub still runs.

---

## 5. Phases

### Phase A — release 2.12 "accounts": ship sign-in while anonymous still works
Order: **A0 mail path + safety checks (user + operator, before any code)** → harness 4.3 → SQL 4.1 (with `auth_mode = 'anonymous'`, `joinable = true` defaults) → engine 4.2 → client 4.4 → remaining dashboard rows (Google, redirect URLs, test users) + Google Cloud 4.6 → smoke/live scripts rewritten on password users → tests → PGlite upgrade rehearsal (incl. freeze, delete, restore) → multi-agent review → release: whole SQL in the SQL editor → **`npm run smoke` + opt-in live test green against the live DB** (they call `siosia_whoami` / `siosia_absorb`, which exist only after the migration) → no `_shared` change so no Edge redeploy → `git push origin main` → CI → Pages → live check.

**A0 — Prove the mail path and the safety facts (30 min, user + operator)**
1. Pick the sender: a Google account with 2-Step Verification → Security → App passwords → "Siosia" → 16 chars (or a dedicated `siosia…@gmail.com`).
2. Supabase → Project Settings → Authentication → SMTP: host `smtp.gmail.com`, port 587, user = that Gmail, password = app password, sender email = same, sender name "Siosia"; Save. Authentication → Rate Limits → emails/hour 30.
3. Email Templates as in 4.5 (three token-only, three inert).
4. Send a code to each of the four real addresses (with their consent) using a 10-line node script calling `signInWithOtp({ email, options: { shouldCreateUser: true } })` with the publishable key — the live app changes nothing yet, and the created auth users are harmless (they get no membership) — then check inbox / Spam / Promotions on Gmail, iCloud and Outlook. Also send one `resetPasswordForEmail` to a test address to confirm the Reset Password template is inert. Expect the **Confirm signup** template for a never-seen address and **Magic Link** for a seen one.
5. If any address does not receive within 2 min, switch to Brevo (verified single sender) and repeat. Record the result in the B0 sheet.
6. Safety checks in the SQL editor: `select count(*) from auth.users where is_anonymous and created_at < now() - interval '30 days';` and `select min(created_at) from auth.users u join profiles p on p.user_id = u.id where not p.deleted and not siosia_sandbox(u.id);` — GoTrue carries a cleanup statement that deletes anonymous users older than 30 days when DB cleanup is enabled and the anonymous toggle is ON; with `on delete cascade` from `auth.users` that would erase a real person *(V-12)*. The oldest live accounts date from ~2026-10-12 → 30 days ≈ 2026-11-11. If old anonymous users exist, cleanup is off; either way **the migration evening happens before any real account reaches 30 days**. Also `select conname from pg_constraint where conrelid = 'storage.objects'::regclass;` (expect no `*_owner_fkey`) and the `owner` / `owner_id` column list from `information_schema.columns` *(V-11)*.
7. Only then start §4 coding.

- **Smoke/live**: `scripts/smoke-supabase.mjs:38-46` and `tests/unit/supabase-live.test.ts:15-41` replace `signInAnonymously()` with `signInWithPassword({ email, password })` from `SIOSIA_TEST_EMAIL_{RIDER,DRIVER,OUTSIDER}` / `SIOSIA_TEST_PASSWORD` (`.env.local`, never CI); the live test signs in on the client before `start()`, which already prefers `getSession()`.
- **SPEC.md** (via /spec, caveman): `T56|x|2.12 accounts: email code + Google sign-in (signin phase, Account card, auth_mode + googleSignIn in config, whoami, build stamp), membership per person (SQL + engine), absorb = merge keep-both bound to email + operator merge_into, guard_any / anon_blocked / merged_away, joinable noop, harness auth.jwt + auth.users cols + storage stub, i18n EN+PL, tests|V81,V82,V83,V19` ; `T57|x|2.12 operator setup + release: A0 mail gate (SMTP, 6 templates, 4 addresses), Google Auth Platform client, redirect URLs, password test users, smoke/live on passwords, SETUP §4, upgrade rehearsal incl. freeze/delete/restore, device matrix|V81,V84`.
- **§V**: `V81: sign-in (FR-326): authMode anonymous | accounts (app_config → siosia_config, anon-granted); accounts → no session = S0 sign-in (email → 6-digit code typed in app, verifyOtp type email, shouldCreateUser; Google = OAuth redirect, implicit pinned, redirectTo origin+pathname, prompt select_account, shown per googleSignIn off|no_standalone|no_ios|on) ⊥ magic link ⊥ PKCE ⊥ signInAnonymously after a lost session; demo ⊥ sign-in; member = ∃ membership of the user on any device (is_member(device) ≡ member_ok(uid) ∧ ¬anon_blocked); whoami records the device, mergedInto → sign-in; new phone of a member → app; else invite code | join link once per person`. `V82: absorb (FR-327): anonymous member phone with profile signs in → create_transfer (guard_any) parked with forEmail before, absorb(code, device) after only when the signed-in email matches (Google: same boot cycle); merge old → me: my profile row if I have one (missing fields copied) else old row moves whole (public_id, photos, master_id); kids, bell, family seat (⊥ drop_from_families), memberships ∪ devices, push_subscriptions + outbox re-pointed, storage owner re-pointed, dedupe ∀ unique index, 'p:<old>' → 'p:<me>', old row deleted + merged_into; refuse active_ride | two_families | bad_transfer; same realm ∨ me ⊥ membership (then I inherit the realm); idempotent (already_merged); no-op when old = me; merged-away uid: guard → account_merged, joins → already_merged; twin`. `V83: master preset (FR-328): master_id survives a merge (fixed fare, role, p:<master> keys); joinable = false → join_master noop for own master | bad_link ⊥ invite_failures row, while active & presets stay; set_master ⊥ joinable; ⊥ deactivate | rotate | delete to close a link`. `V84: test identity (FR-330): smoke/live = email+password sandbox users; secrets local only; CI credential-free`.
- **Prose**: `siosia-spec-v2.0.md` `## Amendment 2.12 (2026-11-xx): accounts — sign in with an email code or Google` with FR-326 sign-in, FR-327 absorb, FR-328 master preset / joinable, FR-329 lockdown mode (shipped in 2.13), FR-330 test users, FR-331 profile deletion ≠ account deletion; US8 rewritten. In `siosia-spec-v0.1.md` mark FR-002 ("anonymous session on first launch"), FR-003, FR-007 ("once per device") and NFR-07 (anonymous sign-up rate-limited / CAPTCHA) as "superseded by Amendment 2.12 (FR-326–FR-331)". `docs/TRACEABILITY.md` rows FR-002/003/007 point at the new tests (`sql-accounts.test.ts` titles, `navigation.test.ts` "signin phase", the `SignInScreen` component test). `docs/FIELD-TEST.md` steps 1–2 become "open link → sign in (code) → invite code → nickname".
- **Tests**: engine (`tests/unit/engine.test.ts`: isMember any device, whoami device row, absorb first phone = move shape, second phone = keep-both, dedupes, `two_families`, `joinable` noop/bad_link, `already_merged`); PGlite (`tests/unit/sql-accounts.test.ts`: same via `siosia_absorb`, operator `siosia_merge_into` incl. the realm bypass, `whoami` for anonymous/merged callers, `joinable` next to the `active = false` case of `sql-backend.test.ts:433-444` incl. `set_master` same-token re-run keeping `joinable = false` and `master_of` still returning presets, `sign_in_required` via `asAnon()` with `auth_mode = 'accounts'` and `guard_any` still passing for `create_transfer`, `account_merged` from the guard and its undo, sandbox phone absorbed into a fresh account OK and a sandbox phone into an account that absorbed a real phone refused (V66), photos via `siosia_can_see_photo` with the storage stub, `anon` can execute `siosia_config()`, `siosia_settlements_json` / `siosia_comment_settlement` on the merged account match pre-merge values; `sql-backend.test.ts:118` updated; existing redeem suites untouched); store (`tests/unit/navigation.test.ts` pattern: `start()` → null ⇒ `signin`; `sessionLost` notice; absorb pending and bound ⇒ absorb then ready; absorb pending for another email ⇒ skipped notice; absorb failure ⇒ notice + retry; `whoami.mergedInto` ⇒ signin + notice; anonymous uid + `signInRequired` ⇒ signin and `sendCode` preceded by `createTransfer` + parked entry; `refresh()` on `sign_in_required` ⇒ boot ⇒ signin; MockBackend boot ⇒ phase `nickname`); component (`SignInScreen` EN/PL render, auto-submit, resend countdown; Account card states; About build line); `theme.test.tsx` phase list; `services.test.ts` i18n; e2e on mock unchanged + one assertion in `launch.spec.ts` that the demo lands on Nickname and never shows "Sign in"; optional opt-in e2e of the sign-in screen on mock behind `?auth=required` with mock stubs minting a per-tab uid (nice to have — the lockdown itself can only be verified live). **PGlite upgrade rehearsal** (temporary `tests/unit/zz-upgrade212.tmp.test.ts` from the scratchpad pattern, previous live file via `git show 0b234e9:supabase/migrations/0001_siosia.sql`): seed masters `master` (rider, fixed fare, offers) and `roman` (driver + vehicle), 10 Toria phones with varied `seen_at` (two of them in two different trial families, one with a pending `family_invites` row to Toria's real family), 2 Roman, 2 plain Karol, a family + active contract, done appointments with kids/photos/updates/tips, rides, settlements (remind + dobry Pancio + comment), bells and push subs per phone, the unique-index collisions (two offers, two ratings, duplicate contract, same chat room, two live legs) → MIGRATION twice → run the exact Phase B blocks from `scripts/ops/2026-11-accounts.sql` (snapshot, `siosia_merge_into` per stale phone incl. one `two_families` resolved by the documented SQL, absorb for phones in hand via `siosia_create_transfer` + `siosia_absorb`, B4, B5) → assert counts conserved per table, `siosia_person_accounts(canonical) = {canonical}`, `siosia_side`, `siosia_report` and `siosia_settlements_json` unchanged (V78), photos visible, memberships ∪ devices, push subs moved, merged rows `deleted + merged_into`, guard answers `account_merged` for a merged uid, re-run no-op, migration re-run idempotent → run the exact **C5** batch and assert every row keyed by a survivor uid is untouched and sandbox / merged rows vanished → run the exact **restore** block and assert the pre-merge state is back; delete the file after.
- **Live check** (test accounts): desktop browser sign-in by code (mail arrives via the new SMTP); anonymous sandbox test phone (test code) → sign in with a throwaway email → absorb → profile intact, push still arrives; a second throwaway sign-in on the same phone within 30 min → `absorbSkipped`; sign a kid/profile/update photo URL from the merged test account; **device matrix** for Google: Safari tab, iPhone Home Screen app, Android Chrome, Android installed PWA — check that the redirect **returns into** the Home Screen app (not the sheet or Safari) and that `account().providers` includes `google` there; optionally try the GIS in-page button + `signInWithIdToken` on the same client the same way → set `google_sign_in` to `'on'`, `'no_standalone'`, `'no_ios'` or leave `'off'` accordingly; new-phone auto-entry; one push reaching two phones of one user.
- Users see: nothing changes except the *Keep my account* card, the S1 banner and the About build line. No one is forced yet; hand out no new master links.

**Done when**
- [ ] A0 passed: a code reached each of the four real addresses within 2 min; templates contain no link; the 30-day cleanup and storage FK facts recorded in the B0 sheet.
- [ ] `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e` green; new suites listed above exist.
- [ ] Upgrade rehearsal (merge + freeze + C5 + restore) passed and deleted; multi-agent review findings fixed (B12 if any real).
- [ ] Remaining dashboard rows marked A set; Google client created and pasted.
- [ ] SQL live; `npm run smoke` and the opt-in live test green on the three password users; then main pushed.
- [ ] 2.12 live (`siosia_config` returns `authMode: 'anonymous'`), device matrix recorded, `google_sign_in` set, `T56`/`T57` released commit.

### Phase B — migrate the 4 people (prep session + one evening, no deploy)
**B0 Confirm who is who** (own session before the evening, SQL editor, read-only):
```sql
select p.master_id, p.nickname, count(*) phones, max(p.seen_at) last_seen, bool_or(mb.sandbox) sandbox
  from profiles p join memberships mb using (user_id) where not p.deleted group by 1,2 order by 1 nulls last, 2;
select p.user_id, p.public_id, p.nickname, p.master_id, p.seen_at, p.photo_path, u.is_anonymous, u.email,
       array_agg(distinct mb.device_id) devices, bool_or(mb.via_master is not null) via_master,
       (select count(*) from push_subscriptions s where s.user_id = p.user_id) subs,
       (select count(*) from kids k where k.owner_id = p.user_id) kids,
       (select count(*) from family_members f where f.user_id = p.user_id) fam,
       (select count(*) from contracts c where c.provider_id = p.user_id and c.status in ('active','proposed')) contracts,
       (select count(*) from appointments a where a.client_id = p.user_id or a.provider_id = p.user_id) appts,
       (select count(*) from rides r where r.rider_id = p.user_id or r.driver_id = p.user_id) rides
  from profiles p join memberships mb using (user_id) join auth.users u on u.id = p.user_id
 where not p.deleted and not mb.sandbox
 group by p.user_id, p.public_id, p.nickname, p.master_id, p.seen_at, p.photo_path, u.is_anonymous, u.email
 order by p.master_id nulls last, p.seen_at desc nulls last;
select id, email, is_anonymous from auth.users where not is_anonymous;      -- anyone who already linked email/Google (open question 13)
select id, nickname, role, active, joinable from master_profiles;
select family_id, provider_id, status from contracts where status in ('active','proposed');
select f.family_id, f.user_id, p.nickname from family_members f join profiles p using (user_id) order by 1;
select (select count(*) from appointments) appts, (select count(*) from rides) rides, (select count(*) from kids) kids,
       (select count(*) from notifications) bells, (select count(*) from settlements) settle, (select count(*) from push_subscriptions) subs;
-- ownerless-object candidates: objects whose folder belongs to a profile that will be merged away and that no row holds
select name from storage.objects o where bucket_id = 'photos' and siosia_photo_owner(name) is null;
```
Write the result into the table below (one row per person). Rows sharing a `master_id` are one person — confirm every phone of a person shares one `master_id` or all null *(V-10)*; plain rows (Karol, the 4th) are paired by the user. Rows with no rides/appointments/kids/photos and `seen_at` older than 30 days are **leftovers** (Safari tab beside the Home Screen app, reinstalls) to be operator-merged in B3, never left live; the B0 "storage" column holds the operator's guess (an iPhone has two storages, so device counts exceed physical phones). An already-permanent account (`is_anonymous = false`) is the canonical one for that person and needs no absorb on that phone. Two active contracts from one family to two phones of one provider would be deduped by the merge (older → `replaced`) — decide which one should win beforehand.

| Person | Canonical phone (public_id, in hand, richest: family seat / contract / kids / photo) | Other phones in hand (public_id, storage) | Phones gone / leftovers (public_id) | Email / Google |
|---|---|---|---|---|
| Roman | | | | |
| Toria | | | | |
| Karol | | | | |
| 4th | | | | |

**B0.1 Before-JSON** (`siosia_report(p_week, p_scope)` runs under `auth.uid()` through `siosia_guard(true)`; `p_week` is `null` for the current week or `'YYYY-MM-DD'` of any day in the week, `p_scope` is `'me'` or `'family'`, `:5375-5410`; the result embeds `due` and `settlements`):
```sql
begin;
select set_config('request.jwt.claim.sub', '<Roman canonical uid>', true);
select siosia_report(null, 'me');  select siosia_report(null, 'family');
select siosia_report('<Monday of last week>', 'me');  select siosia_report('<Monday of last week>', 'family');
select siosia_due_json('<Roman canonical uid>');  select siosia_settlements_json('<Roman canonical uid>');
rollback;
```
Repeat for Toria. Save each result as a file next to `scripts/ops/2026-11-accounts.sql` (`before-roman.json`, `before-toria.json`); after B2–B3 re-run with the **new** uids and diff. Any difference other than uid fields is a stop condition.

**B2.0 Instructions handed to each person (EN/PL card)**: 1. Close and reopen the app so it updates — Profile → About must show build 2.12. 2. On iPhone do everything inside the Siosia icon on the Home Screen, never in Safari. 3. Finish any ride first (the merge refuses `active_ride`). 4. Type exactly the same email on every phone; spelling differences make two accounts. 5. After the code screen wait for the green "joined" notice before touching anything. 6. Turn notifications back on if the bell asks. 7. Delete the old Siosia link from bookmarks afterwards.

**B1 Snapshot** (evening, one transaction, from the ops file):
```sql
create schema if not exists backup_2026_11;  -- not exposed by PostgREST, needs no grants
do $$ declare t text; begin
  foreach t in array array['families','profiles','memberships','vehicles','driver_status','kids','appointment_series','appointments',
    'appointment_kids','rides','offers','ratings','kid_ratings','messages','chat_presence','appointment_updates','family_members',
    'family_invites','contracts','member_invites','notifications','settlements','push_subscriptions','push_outbox',
    'account_transfers','invite_failures','master_profiles'] loop
    execute format('create table backup_2026_11.%I as select * from public.%I', t, t);
  end loop; end $$;
create table backup_2026_11.auth_users as select id, email, is_anonymous, banned_until, created_at from auth.users;
select t, (xpath('/row/c/text()', query_to_xml(format('select count(*) c from backup_2026_11.%I', t), false, true, '')))[1]::text::int
  from unnest(array['families','profiles','memberships','rides','appointments','appointment_kids','kids','notifications','settlements','push_subscriptions']) t;
```
Paste the counts into the B0 sheet as the baseline.

**B2 Per person, phones in hand** (self-service; the person taps, the operator watches the SQL editor). Order: **Roman first** (2 phones, provider side of the contract), then Toria, then Karol, then the 4th; between persons all of that person's phones must look right.

| Step | Phone | The person does | The app does | Operator checks |
|---|---|---|---|---|
| 1 | canonical (Home Screen app on iPhone) | S1 banner → email → code (or Google if the matrix allowed it) | `prepare()` parks the code bound to the email → reload → absorb (move shape: whole profile row moves to the new uid) → S1 as before | `select user_id, public_id, nickname, master_id, merged_into from profiles where public_id = '<canonical>'` → new uid, not deleted; `select is_anonymous, email from auth.users where id = '<new uid>'` |
| 2…n | each other phone in hand, any order | same taps, **same email** | reload → absorb (merge shape) → notice `signin.merged` | returned row counts (browser console + SQL `select public_id from profiles where merged_into = '<new uid>'`); `select count(*) from push_subscriptions where user_id = '<new uid>'` grows by one per phone with push |
| n+1 | operator | — | — | `update master_profiles set joinable = false where id = '<this person's master>';` (Toria, Roman) |
| n+2 | any one phone | Account card → *Add Google* (optional) | `linkIdentity` + `refreshSession` | `select provider from auth.identities where user_id = '<new uid>'` |

Spacing: 60 s per-address resend, 30 mails/hour on custom SMTP — one person at a time is well inside the limits.

**B3 Phones gone / leftovers** (operator): `select siosia_merge_into('<old public id>', '<canonical public id>');` per stale account; read the returned summary; `two_families` → resolve by the 4.1.7 recipe and re-run.

**B4 Verify** after each person and once at the end:
```sql
select user_id, public_id, nickname, master_id from profiles where not deleted and master_id = 'master';  -- exactly 1 row (Toria)
select siosia_person_accounts('<new uid>'), siosia_side('<new uid>');                                      -- {new uid}, 'f:…' or 'p:master'
select count(*) from memberships where user_id = '<new uid>';                                              -- = phones (+ leftovers' devices)
select status, provider_id from contracts where family_id = '<Toria family>';                              -- provider = Roman's new uid
select from_party, to_party, count(*) from settlements group by 1,2;                                       -- no 'p:<old uid>' left
select p.public_id from profiles p join auth.users u on u.id = p.user_id
 where not p.deleted and u.is_anonymous and not siosia_sandbox(p.user_id);                                 -- 0 rows at the end
select id, joinable from master_profiles;                                                                  -- all false at the end
-- totals equal the B1 baseline:
select (select count(*) from appointments), (select count(*) from rides), (select count(*) from kids),
       (select count(*) from notifications), (select count(*) from settlements), (select count(*) from push_subscriptions);
```
Plus: before/after report JSON identical (B0.1 re-run with the new uids); the person opens Planned / History / Family / weekly report on each phone; one test push (a chat message or remind) reaches every phone.

**B5 Finish**: `update memberships set via_master = null where user_id in (<4 new uids>) and via_master is not null;`. **No auth ban** *(V-13)*: merged-away accounts are already frozen by the guard (`merged_into` → `account_merged`), their sessions stay alive so a reappearing phone lands on the sign-in notice, and the freeze is undone per account with `update profiles set merged_into = null, deleted = false where user_id = …` (plus restoring that row's re-pointed data from the snapshot if needed). Keep the snapshot. Soak 7–14 days with anonymous still allowed so a forgotten phone can still self-serve.
- **SPEC.md**: `T58|x|migrate the 4 people: A0 facts, B0 sheet + before-JSON in own session, B2.0 card, snapshot (restorable), self-service absorb per phone (Roman → Toria → Karol → 4th), joinable off per master same evening, merge_into for gone phones, verification, via_master null, guard freeze (⊥ ban), soak|V82,V85`; `V85: after migration ∀ real person: exactly one live profile, person_accounts = {u}, memberships of all phones under it, ⊥ live non-sandbox anonymous profile, merged rows deleted + merged_into (guard → account_merged) not auth-banned, not deleted until soak; ∀ master: joinable = false, active = true`.

**Done when**
- [ ] B0 table filled and confirmed by the user in the prep session; before-JSON saved; snapshot schema exists with baseline counts.
- [ ] Every person: one live profile, all phones in hand signed in and absorbed from the right storage, gone phones merged, B4 queries clean, totals equal, report JSON equal, push on every phone, their master `joinable = false`.
- [ ] `via_master` nulled for the four; no live non-sandbox anonymous profile.

### Phase C — release 2.13 "lockdown"
1. Client: `MoveHere` / Move section retired; docs (SETUP §4 rewritten: SMTP, six templates, Google Auth Platform, anonymous OFF, test users, "close a master link" = `joinable`, "Remove a user" = Authentication → Users → delete (cascades profile, kids, memberships, push subscriptions; rides and appointments keep an anonymised uid); troubleshooting rows `docs/SETUP.md:377, 386`; USER-GUIDE EN/PL "sign in once per phone with the same email", "one role at a time", master links "historical"; ARCHITECTURE identity row `:15, 99-115`; README `:47`; TRACEABILITY; `public/guide.html`; FIELD-TEST steps 1-2).
2. Deploy code first (migration file re-run — no functional SQL change expected — → `git push main` → CI → Pages).
3. **C0 pre-flight** (SQL editor): re-run the B4 "zero live non-sandbox anonymous profiles" query and the `joinable` query (the soak may have produced new anonymous phones — merge them first); every one of the four phones showed build ≥ 2.12 in Profile → About.
4. SQL editor: `update app_config set auth_mode = 'accounts' where id = 1;` (cached PWAs now get `sign_in_required`; the new build shows the sign-in screen) → dashboard **Allow anonymous sign-ins OFF** → `GET /auth/v1/settings` shows `anonymous_users: false` → optionally *Allow manual linking* OFF once nobody needs *Add Google*.
5. Live check: fresh private window → sign-in screen → test email code → test invite code → sandbox profile; an old anonymous tab → `sign_in_required` → sign in → absorb still works; `#master=` link → `bad_link` without a failure row; `#join=` works for a signed-in user; `npm run smoke` green; `signInAnonymously()` from the console → 422.
6. **C5, after 14 more days, as two separate sessions**. Session 1 (from the ops file, rehearsed in Phase A):
   ```sql
   -- refuse if any live, non-sandbox anonymous profile remains
   do $$ begin if exists (select 1 from profiles p join auth.users u on u.id = p.user_id
      where u.is_anonymous and not p.deleted and not siosia_sandbox(p.user_id)) then raise exception 'live anonymous profile left'; end if; end $$;
   select conname from pg_constraint where conrelid = 'storage.objects'::regclass;   -- expect no *_owner_fkey; if present: null owner first
   select siosia_drop_photo_objects(p.user_id) from profiles p where p.merged_into is not null;   -- ownerless leftovers under merged-away folders
   update storage.objects set owner = null, owner_id = null where owner in (select id from auth.users where is_anonymous);
   delete from auth.users u where u.is_anonymous
      and (exists (select 1 from profiles p where p.user_id = u.id and p.merged_into is not null)
           or siosia_sandbox(u.id)
           or not exists (select 1 from profiles p where p.user_id = u.id));
   select count(*) from auth.users where is_anonymous;  -- whatever is left is reviewed by hand
   ```
   Cascades reach only rows of merged / deleted / sandbox accounts (profiles, memberships, push_subscriptions, kids, chat_presence, family_members, member_invites.from_user, notifications; settlement actor columns → null — all already re-pointed for real people). Deleting sandbox accounts also removes their rides/appointments actors from the sandbox history — acceptable. Keep the three password test users (not anonymous). Session 2, days later, once the app has been used on every phone: `drop schema backup_2026_11 cascade;`.
- **SPEC.md**: `T59|x|2.13 lockdown: Move UI retired, docs|V86` ; `T60|x|release 2.13 + operator lockdown: deploy, C0 pre-flight, auth_mode accounts, anonymous OFF (+ settings check), live check, soak, scoped count-guarded delete of anonymous auth users, drop backup schema in a later session|§15,V86`. `V86: lockdown (FR-329): authMode accounts → client ⊥ signInAnonymously; guard: anonymous jwt → sign_in_required (guard_any only for create_transfer), merged_into → account_merged; joins & whoami refuse anonymous / merged; dashboard anonymous OFF; join_master ⊥ (joinable=false, noop for own); sign-up open at auth, membership = gate; anonymous auth users deleted after soak only when merged | sandbox | profile-less, never a live non-sandbox profile`. §B rows only if the review/rehearsal finds bugs.

**Done when**
- [ ] 2.13 live; `siosia_config` returns `authMode: 'accounts'`; dashboard toggle OFF and confirmed in `/auth/v1/settings`; smoke green; the four people open the app on every phone without a prompt.
- [ ] Soak passed; scoped delete run with the count guard; backup schema dropped in a later session; T59/T60 released commit; memory note updated.

### Phase D — optional cleanup (later, T61)
Trivialise `siosia_listed` / `same_person` / `person_accounts`, drop `seen_at` ordering, remove `siosia_redeem_transfer` and the engine `redeemTransfer`, `siosia_bind_master(p_id, p_user)` operator function, copy presets into profile columns. Pure refactor, twin-tested, no data migration.

---

## 6. Data safety
- **Before any merge**: the `backup_2026_11` snapshot (B1) in one transaction (now including `families`, `appointment_kids`, `invite_failures`) plus the before-JSON reports. Supabase Free has no backups / PITR *(ops-tests)*; this is the only undo.
- **Merge** = one transaction under both advisory locks; a raise leaves nothing half-done; idempotent (`already_merged`); the losing row stays as a deleted profile with `merged_into`, so a failed absorb leaves the old account intact and the operator can `siosia_merge_into` later.
- **Freeze** of merged-away accounts is the guard check, not an auth ban: immediate, reversible with one `update`, and it never removes a phone's session (an auth ban would make auth-js delete the session once the JWT expires and today's `start()` would then mint a fresh anonymous user — one-way on the phone) *(V-13)*.
- **Rollback per phase**: A — redeploy previous main; the SQL is additive (`auth_mode` default `'anonymous'`, `joinable` default true, `is_member` widened; re-run the 2.11 file from `git show 0b234e9:…` only if `is_member` must be device-scoped again). B — whole-snapshot restore, rehearsed in PGlite, from the ops file: one transaction, `truncate public.families, public.profiles, public.memberships, … , public.master_profiles;` (all snapshot tables in one `truncate` statement, which resolves the FKs among them), then `insert into public.<t> select * from backup_2026_11.<t>` in FK order: families, profiles, memberships, vehicles, driver_status, kids, appointment_series, appointments, appointment_kids, rides, offers, ratings, kid_ratings, messages, chat_presence, appointment_updates, family_members, family_invites, contracts, member_invites, notifications, settlements, push_subscriptions, push_outbox, account_transfers, invite_failures, master_profiles. Everything written after the snapshot that evening is lost — acceptable for a same-evening abort; a per-person undo is `merged_into = null` on that person's rows plus the operator re-pointing from the snapshot by uid. C — `update app_config set auth_mode = 'anonymous'`, dashboard anonymous ON; `joinable = true` per master if a link is needed again; all in seconds, no redeploy.
- **Irreversible**: deleting `auth.users` rows and dropping the backup schema (C5, after the soak, by the operator, in two separate sessions, never by the app). Deleting a real person's auth user cascades through 11 FKs, so the C5 delete is scoped to merged / sandbox / profile-less users and guarded by a count check inside the same batch.
- Supabase Auth audit logs live 1 hour on Free *(web-auth)*: during the evening the sign-in screen shows the `error_code` under the friendly text and the merge summary is logged to the console.

---

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Magic link / PKCE across Safari ↔ Home Screen app | not used: code-only templates, `signInWithOtp` without `emailRedirectTo`, implicit flow pinned |
| Google redirect from the iOS standalone app lands in the Safari sheet (expected) or fails `disallowed_useragent` | Google secondary; device matrix in Phase A live check; `google_sign_in` flag per platform (`no_standalone`); same-email auto-linking means nothing is lost if a person uses Google on Android and the code on iPhone |
| First-time OTP user receives the Confirm-signup template | confirmed from GoTrue source; `{{ .Token }}` in Confirm signup, Magic Link and Change Email Address; A0 checks a never-seen address |
| A link email still reachable through `/auth/v1/recover` or the dashboard Invite button | Reset Password / Invite / Reauthentication templates made inert; A0 sends one `resetPasswordForEmail` to prove it |
| Email never arrives (built-in mailer team-only; Gmail → spam) | A0 is the gate: custom SMTP, a code to each of the 4 addresses before coding; `signin.checkSpam`; Brevo fallback |
| Rate limits (60 s resend, 30 mails/h, 30 OTP req / 5 min per IP) | one person at a time; countdown; `rate_limited` message; operator merge needs no email |
| Wrong-person absorb on a shared phone | parked code bound to the typed email (Google: same boot cycle); otherwise skipped with a notice; Sign out drops the parked entry |
| Person migrates from Safari instead of the Home Screen app | B2.0 card; the Home Screen app then reappears as a second absorb (merge shape) or as `account_merged` — data safe either way |
| Cached PWA clients after lockdown | `auth_mode` flips server-side only after the new build is live; 2.12 maps `sign_in_required` from any RPC to the sign-in screen; `is_member` false for a 2.11 build; old build on a fresh storage → Unavailable → Retry pulls the new build (`autoUpdate`, `skipWaiting`) |
| Existing anonymous sessions survive the dashboard toggle (refresh grant ignores it, confirmed *(V-12)*) | `sign_in_required` in `siosia_guard` is the hard stop; merged ones frozen by `merged_into`; deleted after soak |
| GoTrue's 30-day anonymous cleanup erases a real account | A0 check; the evening happens before the oldest real account turns 30 days (~2026-11-11); after migration the four are permanent |
| Lost sessions (storage cleared, sign-out, refresh reuse detection) | nothing lost: sign in again → same account; `whoami` re-records the device; accounts mode never forges a new identity |
| Bookmarked `#master=` link after `joinable = false` | `noop` for the own master, `bad_link` without an `invite_failures` row for others; card tells people to delete the bookmark |
| Sandbox / smoke / live tests break on lockdown | password users and switched scripts in Phase A; CI credential-free |
| Wrong pairing (plain accounts cannot be tied by SQL) | self-service absorb is correct by construction once bound to the email; operator merge only for named stale public ids from the confirmed B0 table; snapshot first |
| Unique indexes abort the merge | dedupe steps per index; rehearsal seeds the collisions |
| `two_families` mid-evening (chain of absorbs bringing two trial families) | raised, never auto-resolved; documented operator recipe; seeded in the rehearsal |
| Settlement party keys | `master_id` survives (B0 precondition, merge rule) → `p:<master>` stable; `p:<uid>` rewritten; `master_profiles` never deleted; rehearsal asserts report and settlements_json equality |
| Photos | row-based ownership; first-phone row moves with its `public_id`; losing rows keep `public_id`; ownerless leftovers listed in B0 and dropped in C5; rehearsal asserts `siosia_can_see_photo`; live check signs a URL after the merge |
| Realtime / push on many phones | per user / per endpoint already; merge re-points subs; two phones of one driver heartbeat the same row — documented |
| Family sharing one phone | Sign out with confirm + push unsubscribe; `prompt=select_account`; absorb binding |
| `pl.ts` typing / lint gate | strings table; `npm run lint && npm run typecheck` before push |
| Project pauses after 7 idle days | `keepalive.yml` already covers it |

---

## 8. Open questions for the user
1. **Who exactly are the 4 accounts?** Memory says Toria ~10 phones (`master`), Roman 2 (`roman`), Karol 2 — who is the 4th, and does Karol have a master or two plain invite-code accounts? Run B0 together in the prep session.
2. **Which email address per person, and who wants Google as well?** Are any of Toria's ~10 "phones" children's devices that should become **their own** accounts instead of Toria's?
3. **Do all of Toria's accounts still exist as phones in hand**, or are most reinstalls / Safari leftovers (→ operator merge by public id)?
4. **Canonical phone per person**: the one in daily use (max `seen_at`) holding the family seat / contract — agreed?
5. **Email sender**: Gmail SMTP with an app password from your Google account (or a dedicated `siosia…@gmail.com`) vs Brevo free (footer)? Do you own any domain (then Resend is possible)?
6. **Master links**: retire as a join path per master on the evening (`joinable = false`, recommended) and keep the presets — or keep one link as an emergency entry during the soak only?
7. **Invite gate**: keep the invite code / join link for new people with sign-ups open at the auth layer (recommended) — or have the operator create each new member by hand (sign-ups OFF)?
8. **One role at a time per person** (one account cannot drive on one phone and ride on another) — acceptable?
9. Keep **Sign out** (shared phones) — yes/no? Keep **Add Google** permanently (manual linking stays ON) or turn it off after setup?
10. Should the migration evening **wait for the Google-on-iPhone test**, or go with email codes only and add Google later (recommended: codes only)?
11. **Soak length** before deleting anonymous auth users and the backup schema (suggest 14 days)?
12. **Demo** stays sign-in-free (recommended) — confirm.
13. **Has anyone ever tapped Link email / Link Google in Profile → Account (2.x)?** B0 runs `select id, email, is_anonymous from auth.users where not is_anonymous` — such an account is permanent already and must be the canonical one for that person.
14. **Children's phones**: separate accounts (own email, invite code, no fixed fare) or Toria's? If separate, their old anonymous accounts are **not** merged; they sign in with their own email and the operator clears `master_id` on their profile (`update profiles set master_id = null where public_id = …`) so settlements stop keying them as Toria.
15. **Which Google account owns the Google Cloud project** (it becomes the only admin; recommended: the one holding the Supabase org)?

---

## 9. Effort estimate (sessions)
| Phase | Work | Sessions |
|---|---|---|
| A0 — mail gate + safety facts | SMTP, six templates, codes to 4 addresses, 30-day / storage FK checks | 0.25 (+ user time) |
| A — harness + SQL + engine twin + PGlite suite | harness first, config columns, joinable, is_member, whoami, merge_accounts, absorb, merge_into, guards + freeze, tests, SPEC V81–V84 | 2 |
| A — client | start/boot order, signin phase, screens, Account card, absorb binding, main.tsx hash capture, build stamp, i18n EN/PL, unit/component tests | 1.5 |
| A — ops + release 2.12 | Google Auth Platform, test users, smoke/live scripts, docs, ops SQL file, upgrade rehearsal incl. freeze/delete/restore, review, deploy, device matrix | 1 (+ user time on phones) |
| B — migration | prep session (B0 sheet, before-JSON, B2.0 card), evening (snapshot, 4 persons × phones, stale merges, joinable, verification) | 1 prep + 1 evening with the family |
| C — lockdown + release 2.13 | Move UI retired, docs, review, deploy, C0, SQL switch, toggle, live check; 0.25 after the soak (two short sessions) | 1.5 |
| D — optional cleanup | trivialise person helpers, drop redeem, bind_master | 1 |
| **Total (A–C)** | | **≈ 8.5 sessions** |

---

## 10. Verification notes (adversarial check of the draft's load-bearing claims)
| # | Claim (short) | Verdict | What changed in the plan |
|---|---|---|---|
| 1 | supabase-js in this repo runs the implicit OAuth flow | confirmed (high, both) | `flowType: 'implicit'` now passed explicitly so an upgrade cannot flip it; hash readers must keep preserving foreign params; `linkIdentity` = same uid, no reload; `signInWithOAuth` = new uid → reload (the absorb carrier) |
| 2 | `verifyOtp type 'email'` serves new and returning users, no redirect/verifier | confirmed (high, both; mechanism from GoTrue source) | `shouldCreateUser: true` stated explicitly (today's `index.ts:795` passes `false`); "(verify on live)" dropped; A0 proves delivery, not the mechanism |
| 3 | Token-only templates ⇒ no auth email contains a link | **refuted as stated** (high / medium) | narrowed to "no email Siosia's own flows trigger"; Reset Password, Invite, Reauthentication templates made inert; `/auth/v1/recover` reachability named as the reason; A0 sends one recover to prove it |
| 4 | Built-in mailer team-only, 2/hour ⇒ custom SMTP prerequisite | confirmed (high, both) | "(verify)" dropped; A0 made the first step of Phase A; Send Email hook noted as an alternative; Gmail From-rewrite and `SETUP.md:255` stale note added |
| 5 | `siosia_config` anon-granted, readable before `start()` | confirmed (high, both) | boot order kept; `auth_mode` declared informational, enforcement = guard + toggle; PGlite test that `anon` can execute `siosia_config()` added |
| 6 | `siosia_create_transfer` needs a lenient guard, not a comment | confirmed (high, both) | kept `siosia_guard_any`; `siosia_redeem_transfer` (no guard today) gets explicit anonymous/merged checks; harness needs `auth.jwt()` first |
| 7 | absorb precondition must be "same realm or target has no membership" | confirmed (high, both) | explicit `not exists (memberships)` test; the fresh account inherits the first phone's realm; V66 twin test "sandbox → fresh OK, sandbox → real-absorbed refused" added |
| 8 | `is_member` change flips exactly `sql-backend.test.ts:118` | confirmed empirically (high, both) | signature kept (overload trap named); mirror moved to the adapters since `Engine.isMember` already has the device-less branch |
| 9 | deactivating / rotating a master voids or deletes memberships; `joinable` closes the link cleanly | confirmed (high, both) | citations fixed (`:2248-2250`, `:175-177`); `active = false` also hides presets; `set_master` must not list `joinable`; test next to `sql-backend.test.ts:433-444` |
| 10 | `master_id` surviving keeps `p:<master>` keys valid | confirmed (high, both) | survival made an explicit B0 precondition and merge rule; `master_profiles` never deleted; rehearsal asserts `siosia_settlements_json` / comment rights |
| 11 | photo access is row-based; `storage.objects.owner` matters only for deleting users | confirmed (high, both); column names resolved | lines fixed (`:4193-4200`, `:5855-5867`); FK dropped in 2023 so the owner re-point is harmless belt and braces; C5 checks `pg_constraint`; ownerless leftovers listed in B0 and dropped in C5; live photo-URL check added |
| 12 | refresh grant ignores the anonymous toggle | confirmed (high / medium) | `start()` never forges an identity in accounts mode (`session_lost`); 30-day GoTrue cleanup risk → A0 check and evening deadline; `/auth/v1/settings` confirmation; `refreshSession()` after linking |
| 13 | `banned_until = 'infinity'` gives a reversible soak | **refuted** (high, both) | **decision changed**: no auth ban at all; the soak freeze is `profiles.merged_into` checked in `siosia_guard` (`account_merged`), immediate, reversible, session-preserving; `whoami.mergedInto` routes reappearing phones to sign-in; B5 and V85 rewritten; §6 explains why |
| 14 | the PGlite harness fakes only `auth.uid()` | confirmed (high, both) | harness lands **before** any SQL change; `request.jwt.claims` set per call; `auth.users` stub gains `email`, `is_anonymous`, `banned_until`, `created_at`; the duplicate prelude in `sql-backend.test.ts` unified |
| 15 | the mock never reaches a sign-in phase | confirmed (high, both) | `authMode` served from `DeploymentConfig` / `DEFAULT_CONFIG` by `MockBackend.getConfig()`; e2e must build without `public/config.json`; optional opt-in e2e for the sign-in screen noted |
| 16 | basic-scope consent screen needs no verification; Google from iOS Home Screen must be proven | confirmed (medium, both) | Google Auth Platform console steps rewritten; brand-verification cosmetics stated; iOS standalone treated as expected-to-fail → `no_standalone` flag value, email code the baseline; GIS `signInWithIdToken` only as a field-test option |

Completeness critique: all seven ordering fixes applied (A0 first, harness before SQL, `joinable` per master on the evening, B0 in a prep session, C0 pre-flight re-check, C5 delete and schema drop in separate sessions, smoke after SQL-live before push) and all missing pieces folded in (absorb binding, Safari vs Home Screen card, harmless bookmarked master links, scoped count-guarded C5, restorable snapshot with `families` / `appointment_kids` / `invite_failures`, before-JSON recipe with the real `siosia_report(p_week, p_scope)` signature, `mergedInto` branch and `already_merged` joins, `prepare()` parking for stragglers, cached-2.12 handling of `sign_in_required`, build stamp, Google Auth Platform names, FR-331 delete note, `two_families` recipe, open questions 13–15, superseded spec lines).
