// 2.12 accounts in the app (FR-326, FR-327, V81): the boot routes a session to sign in, the invite
// code or the app; before signing in, a phone's anonymous account is parked (a transfer code) and
// the signed-in account takes it in after the reload — only for the sign-in it was parked for
// (the email typed, or Google in the same page load); the sign-in screen offers what the operator
// switched on. The demo never shows any of it (tests/e2e run on the mock backend).

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../../src/App";
import type { Backend } from "../../src/backend/types";
import { buildConfig } from "../../src/config";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import type { DeploymentConfig, MyState, Profile, WhoAmI } from "../../src/core/types";
import { ServerError } from "../../src/core/types";
import { markGoogleStart } from "../../src/services/authReturn";
import { AppStore, captureAuthReturn, readAbsorb } from "../../src/state/store";

const PROFILE = {
  userId: "u", nickname: "Toria", language: "en", riderCancels: 0, driverCancels: 0, lateCancels: 0,
  rating: { mean: null, count: 0 }, masterId: null, masterRole: null, defaultPickup: null, defaultDropoff: null,
  masterVehicle: null, icon: null, fixedFare: null, publicId: "pub-toria", photo: null, offers: [], offersPreset: false, home: null
} as Profile;
const MY = {
  serverNow: Date.now(), ride: null, offer: null, queuedOffers: 0, driverOnline: false, hasVehicle: false, nearbyRequests: null,
  pendingReceipt: null, bookings: 0, driverBookings: 0, hasProfile: true, standby: false, openBookings: 0, toAnswer: 0,
  openRequests: 0, unreadChats: 0, familyPending: 0, unreadNotifications: 0, planned: 0, nextPlanned: null
} as MyState;

interface FakeOpts {
  deployment?: Partial<DeploymentConfig>;
  uid?: string | null;
  sessionLost?: boolean;
  who?: Partial<WhoAmI>;
  email?: string | null;
  absorbError?: string;
  /** sessionEmail() fails (a storage error): the take-over must wait, not be dropped. */
  emailFails?: boolean;
}

function fake(o: FakeOpts = {}) {
  const calls = { start: [] as unknown[], absorb: [] as string[], transfers: 0, sent: [] as string[] };
  const backend = {
    kind: "supabase",
    needsInvite: true,
    ping: async () => {},
    getConfig: async () => ({ ...DEFAULT_CONFIG, emailSignIn: true, ...o.deployment }),
    start: async (opts?: { anonymousOk?: boolean }) => {
      calls.start.push(opts);
      return { uid: o.uid === undefined ? "u" : o.uid, sessionLost: !!o.sessionLost };
    },
    whoami: async () => ({ member: true, hasProfile: true, anonymous: false, signInRequired: false, mergedInto: null, sandbox: false, ...o.who }),
    absorb: async (code: string) => {
      calls.absorb.push(code);
      if (o.absorbError) throw new ServerError(o.absorbError as never);
      return PROFILE;
    },
    account: async () => ({ isAnonymous: !!o.who?.anonymous, email: o.email ?? null, providers: o.email ? ["email"] : [] }),
    sessionEmail: async () => {
      if (o.emailFails) throw new Error("storage");
      return o.email ?? null;
    },
    sendCode: async (email: string) => {
      calls.sent.push(email);
    },
    verifyCode: async () => {},
    signInWithGoogle: async () => {},
    createTransfer: async () => {
      calls.transfers++;
      return { code: `CODE-000${calls.transfers}`, expiresAt: Date.now() + 30 * 60_000 };
    },
    getProfile: async () => PROFILE,
    getVehicle: async () => null,
    onMyChanges: () => () => {},
    myState: async () => ({ ...MY, serverNow: Date.now() }),
    notifications: async () => ({ items: [], unread: 0 })
  } as unknown as Backend;
  return { backend, calls };
}

const stores: AppStore[] = [];
async function boot(o: FakeOpts = {}) {
  const f = fake(o);
  const store = new AppStore(async () => f.backend);
  stores.push(store);
  await store.boot(buildConfig(null, ""));
  return { store, ...f };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  if (!("geolocation" in navigator)) Object.defineProperty(navigator, "geolocation", { value: {}, configurable: true });
  history.replaceState(null, "", "/?launch=0");
});
afterEach(() => {
  stores.forEach((s) => s.dispose());
  stores.length = 0;
});

describe("boot routing (V81)", () => {
  it("anonymous mode: a phone may still start anonymously and goes to the app", async () => {
    const { store, calls } = await boot();
    expect(calls.start).toEqual([{ anonymousOk: true }]);
    expect(store.get().phase).toBe("ready");
  });

  it("accounts mode: no session means sign in — and says when this phone was signed out", async () => {
    const a = await boot({ deployment: { authMode: "accounts" }, uid: null });
    expect(a.calls.start).toEqual([{ anonymousOk: false }]);
    expect(a.store.get()).toMatchObject({ phase: "signin", signInNotice: null });
    const b = await boot({ deployment: { authMode: "accounts" }, uid: null, sessionLost: true });
    expect(b.store.get()).toMatchObject({ phase: "signin", signInNotice: "session_lost" });
  });

  it("a merged-away account and an anonymous one that must sign in go to the sign-in screen", async () => {
    const a = await boot({ who: { mergedInto: "pub-toria", member: false } });
    expect(a.store.get()).toMatchObject({ phase: "signin", signInNotice: "account_merged", signInDetail: "pub-toria" });
    const b = await boot({ who: { anonymous: true, signInRequired: true, member: false } });
    expect(b.store.get()).toMatchObject({ phase: "signin", signInNotice: "sign_in_required" });
  });

  it("a signed-in account that is no member yet is asked for the invite code", async () => {
    const { store } = await boot({ who: { member: false, hasProfile: false } });
    expect(store.get().phase).toBe("invite");
  });

  it("Google's error is said in fixed words — only for a round trip this tab started — and leaves the address", async () => {
    markGoogleStart("signin");
    history.replaceState(null, "", "/?launch=0#error=access_denied&error_code=access_denied&error_description=Pwned+call+0800");
    captureAuthReturn();
    expect(location.hash).toBe("");
    const { store } = await boot({ deployment: { authMode: "accounts" }, uid: null });
    expect(store.get()).toMatchObject({ phase: "signin", signInNotice: "google_failed", signInDetail: "signin.googleCancelled|signin.useEmail" });
    // a link carrying an error this tab never asked for says nothing
    history.replaceState(null, "", "/?launch=0#error=server_error&error_description=Pwned");
    captureAuthReturn();
    const other = await boot({ deployment: { authMode: "accounts" }, uid: null });
    expect(other.store.get().signInNotice).toBeNull();
  });

  it("the sign-in screen steps back to the invite code only for a session that is not frozen", async () => {
    const a = await boot({ who: { member: false, hasProfile: false } });
    a.store.showSignIn();
    expect(a.store.canSkipSignIn()).toBe(true);
    const b = await boot({ who: { mergedInto: "pub-toria", member: false } });
    expect(b.store.canSkipSignIn()).toBe(false);
    const c = await boot({ deployment: { authMode: "accounts" }, who: { anonymous: true, signInRequired: true, member: false } });
    expect(c.store.canSkipSignIn()).toBe(false);
  });
});

describe("taking the phone's old account along (FR-327)", () => {
  it("parks the anonymous account before the code is sent, and the account signed in with that email takes it in", async () => {
    const before = await boot({ who: { anonymous: true } });
    await before.store.sendCode("  Toria@Example.com ");
    expect(before.calls.sent).toEqual(["toria@example.com"]);
    expect(readAbsorb()).toMatchObject({ code: "CODE-0001", oldPublicId: "pub-toria", forEmail: "toria@example.com", bound: false });
    // the page reloads as the signed-in account
    const after = await boot({ email: "toria@example.com" });
    expect(after.calls.absorb).toEqual(["CODE-0001"]);
    expect(after.store.get()).toMatchObject({ phase: "ready", linkNotice: "merged", absorbIssue: null });
    expect(readAbsorb()).toBeNull();
  });

  it("a signed-in phone parks nothing", async () => {
    const { store, calls } = await boot();
    await store.sendCode("toria@example.com");
    expect(calls.transfers).toBe(0);
    expect(readAbsorb()).toBeNull();
  });

  it("another person signing in on the same phone does not get it (shared phones)", async () => {
    const before = await boot({ who: { anonymous: true } });
    await before.store.sendCode("toria@example.com");
    const after = await boot({ email: "karol@example.com" });
    expect(after.calls.absorb).toEqual([]);
    expect(after.store.get().absorbIssue).toEqual({ publicId: "pub-toria", reason: null, retry: false });
    expect(readAbsorb()).toBeNull();
  });

  it("Google takes it in only when Google came back in this page load", async () => {
    const before = await boot({ who: { anonymous: true } });
    await before.store.signInWithGoogle();
    expect(readAbsorb()).toMatchObject({ forEmail: null });
    const stale = await boot({ email: "toria@gmail.com" });
    expect(stale.calls.absorb).toEqual([]);
    expect(stale.store.get().absorbIssue).toMatchObject({ reason: null });

    const again = await boot({ who: { anonymous: true } });
    await again.store.signInWithGoogle();
    history.replaceState(null, "", "/?launch=0#access_token=abc&refresh_token=def&token_type=bearer");
    captureAuthReturn();
    const back = await boot({ email: "toria@gmail.com" });
    expect(back.calls.absorb).toEqual(["CODE-0001"]);
    expect(back.store.get().linkNotice).toBe("merged");
  });

  it("a session planted by a link (login CSRF) is wiped from the address and takes nothing in", async () => {
    const before = await boot({ who: { anonymous: true } });
    await before.store.signInWithGoogle();
    sessionStorage.clear(); // the link opens in a new tab: no Google round trip started there
    history.replaceState(null, "", "/?launch=0#access_token=evil&refresh_token=evil&token_type=bearer&expires_in=3600");
    captureAuthReturn();
    expect(location.hash).toBe("");
    const after = await boot({ email: "attacker@example.com" });
    expect(after.calls.absorb).toEqual([]);
    expect(readAbsorb()).toBeNull();
  });

  it("a failure that can pass (a ride in progress) keeps the code for Try again; a final one drops it", async () => {
    const before = await boot({ who: { anonymous: true } });
    await before.store.sendCode("toria@example.com");
    const busy = await boot({ email: "toria@example.com", absorbError: "active_ride" });
    expect(busy.store.get().absorbIssue).toEqual({ publicId: "pub-toria", reason: "active_ride", retry: true });
    expect(readAbsorb()).toMatchObject({ bound: true });
    const gone = await boot({ email: "toria@example.com", absorbError: "bad_transfer" });
    expect(gone.store.get().absorbIssue).toEqual({ publicId: "pub-toria", reason: "bad_transfer", retry: false });
    expect(readAbsorb()).toBeNull();
  });

  it("a session that cannot be read waits (Try again) instead of dropping the old account", async () => {
    const before = await boot({ who: { anonymous: true } });
    await before.store.sendCode("toria@example.com");
    const flaky = await boot({ email: "toria@example.com", emailFails: true });
    expect(flaky.calls.absorb).toEqual([]);
    expect(flaky.store.get().absorbIssue).toEqual({ publicId: "pub-toria", reason: "unavailable", retry: true });
    expect(readAbsorb()).toMatchObject({ bound: false });
    const ok = await boot({ email: "toria@example.com" });
    expect(ok.calls.absorb).toEqual(["CODE-0001"]);
  });
});

describe("the sign-in screen (FR-326)", () => {
  const show = async (deployment: Partial<DeploymentConfig>) => {
    const f = fake({ deployment: { authMode: "accounts", ...deployment }, uid: null });
    const store = new AppStore(async () => f.backend);
    stores.push(store);
    (store as unknown as { snap: object }).snap = { ...store.get(), cfg: buildConfig(null, "") };
    render(<App store={store} />);
    await screen.findByTestId("signin-screen");
  };

  it("offers the email code and Google when both are switched on", async () => {
    await show({ emailSignIn: true, googleSignIn: "on" });
    expect(screen.getByTestId("signin-email")).toBeInTheDocument();
    expect(screen.getByTestId("signin-google")).toBeInTheDocument();
  });

  it("offers only Google when the mail sender is not switched on", async () => {
    await show({ emailSignIn: false, googleSignIn: "on" });
    expect(screen.queryByTestId("signin-email")).toBeNull();
    expect(screen.getByTestId("signin-google")).toBeInTheDocument();
  });

  it("says sign-in is not switched on when nothing is", async () => {
    await show({ emailSignIn: false, googleSignIn: "off" });
    await waitFor(() => expect(screen.getByText(/not switched on/i)).toBeInTheDocument());
  });
});
