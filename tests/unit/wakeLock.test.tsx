// "Keep the screen on": the wake lock is held while something wants it (the checkbox, a driver
// online), taken again when Siosia is back on screen or on the next tap, and the checkbox is
// remembered on this phone. With a fake Screen Wake Lock API (jsdom has none).

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenWake, iosVersion, wakeLockWorks } from "../../src/services/wakeLock";

class FakeSentinel extends EventTarget {
  released = false;
  readonly type = "screen";
  async release() {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

function stubWakeLock() {
  const ctl = { allow: true, held: [] as FakeSentinel[] };
  const request = vi.fn(async () => {
    if (!ctl.allow) throw new DOMException("not now", "NotAllowedError");
    const s = new FakeSentinel();
    ctl.held.push(s);
    return s;
  });
  Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
  return { ctl, request, last: () => ctl.held[ctl.held.length - 1] };
}

function setVisible(visible: boolean) {
  Object.defineProperty(document, "visibilityState", { value: visible ? "visible" : "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

const settle = () => act(async () => {});

/** Instances made by a test; each one listens on the document, so they are let go afterwards. */
const made: ScreenWake[] = [];
function make() {
  const w = new ScreenWake();
  made.push(w);
  return w;
}

beforeEach(() => setVisible(true));
afterEach(async () => {
  for (const w of made.splice(0)) {
    await w.want("online", false);
    await w.want("checkbox", false);
  }
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  delete (navigator as { userAgent?: unknown }).userAgent;
  delete (navigator as { standalone?: unknown }).standalone;
  localStorage.clear();
  vi.useRealTimers();
});

describe("keeping the screen on", () => {
  it("holds the lock while ticked, remembers the choice, and lets go when unticked", async () => {
    const wl = stubWakeLock();
    const w = make();
    expect(w.getState()).toMatchObject({ supported: true, checked: false, held: false });
    expect(await w.setChecked(true)).toBe(true);
    expect(w.getState()).toMatchObject({ checked: true, held: true });
    expect(localStorage.getItem("siosia.keepScreenOn")).toBe("true");

    // Next launch: ticked already, so it asks at once.
    const next = make();
    await settle();
    expect(next.getState()).toMatchObject({ checked: true, held: true });
    expect(wl.request).toHaveBeenCalledTimes(2);

    await w.setChecked(false);
    expect(w.getState()).toMatchObject({ checked: false, held: false });
    expect(wl.ctl.held[0].released).toBe(true);
    expect(localStorage.getItem("siosia.keepScreenOn")).toBeNull();
  });

  it("takes the lock again when Siosia comes back on screen", async () => {
    const wl = stubWakeLock();
    const w = make();
    await w.setChecked(true);
    setVisible(false);
    await wl.last().release(); // the phone drops it when Siosia leaves the screen
    await settle();
    expect(w.getState().held).toBe(false);
    expect(wl.request).toHaveBeenCalledTimes(1); // not while hidden
    setVisible(true);
    await settle();
    expect(w.getState().held).toBe(true);
    expect(wl.request).toHaveBeenCalledTimes(2);
  });

  it("keeps it while either a driver is online or the box is ticked", async () => {
    const wl = stubWakeLock();
    const w = make();
    await w.want("online", true);
    expect(w.getState()).toMatchObject({ forced: true, checked: false, held: true });
    await w.setChecked(true);
    await w.want("online", false);
    expect(w.getState()).toMatchObject({ forced: false, checked: true, held: true });
    expect(wl.request).toHaveBeenCalledTimes(1);
    await w.setChecked(false);
    expect(w.getState().held).toBe(false);
    expect(wl.ctl.held[0].released).toBe(true);
  });

  it("asks again on the next tap when the phone said no; a no to a tap is shown", async () => {
    const wl = stubWakeLock();
    wl.ctl.allow = false;
    const w = make();
    expect(await w.want("online", true)).toBe(false);
    // iOS: the first lock after a launch needs a tap — ask for one.
    expect(w.getState()).toMatchObject({ held: false, waiting: true, refused: false });
    document.dispatchEvent(new Event("click"));
    await settle();
    expect(w.getState()).toMatchObject({ held: false, waiting: false, refused: true }); // a tap did not help either
    wl.ctl.allow = true;
    document.dispatchEvent(new Event("touchend"));
    await settle();
    expect(w.getState()).toMatchObject({ held: true, waiting: false, refused: false });
    const calls = wl.request.mock.calls.length;
    document.dispatchEvent(new Event("click")); // held: taps no longer ask
    await settle();
    expect(wl.request).toHaveBeenCalledTimes(calls);
  });

  it("re-takes a lock the phone took back while visible, without looping on instant drops", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const wl = stubWakeLock();
    const w = make();
    await w.setChecked(true);
    vi.setSystemTime(1_000_000 + 60_000);
    await wl.last().release(); // dropped after a minute: take it again
    await settle();
    expect(wl.request).toHaveBeenCalledTimes(2);
    expect(w.getState().held).toBe(true);
    await wl.last().release(); // dropped at once: wait for a tap instead of asking in a loop
    await settle();
    expect(wl.request).toHaveBeenCalledTimes(2);
    expect(w.getState()).toMatchObject({ held: false, waiting: true });
    document.dispatchEvent(new Event("click"));
    await settle();
    expect(w.getState().held).toBe(true);
  });

  it("counts Home Screen apps before iOS 18.4 as unsupported (the lock does nothing there)", () => {
    stubWakeLock();
    expect(iosVersion("Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15")).toEqual([18, 3]);
    expect(iosVersion("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBeNull();
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", configurable: true });
    expect(wakeLockWorks()).toBe(true); // a Safari tab
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    expect(wakeLockWorks()).toBe(false); // the Home Screen app
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", configurable: true });
    expect(wakeLockWorks()).toBe(true);
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    expect(wakeLockWorks()).toBe(false);
  });
});

describe("Keep the screen on checkbox", () => {
  it("is in the top bar, asks from the tap, and is locked on while online", async () => {
    const wl = stubWakeLock();
    vi.resetModules(); // the app's instance reads the (stubbed) browser when it loads
    const { ScreenOnToggle } = await import("../../src/components/ScreenOn");
    const { screenWake } = await import("../../src/services/wakeLock");
    const { I18nProvider } = await import("../../src/i18n");
    render(
      <I18nProvider lang="pl">
        <ScreenOnToggle />
      </I18nProvider>
    );
    const box = screen.getByRole("checkbox", { name: "Nie wygaszaj ekranu" });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(box).toBeChecked();
    expect(wl.request).toHaveBeenCalledTimes(1);
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    await act(() => screenWake.want("online", true));
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    await act(() => screenWake.want("online", false));
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();

    // After a launch iOS wants a tap first: the hint asks for one and goes once the lock is held.
    wl.ctl.allow = false;
    await act(() => screenWake.want("online", true));
    const hint = screen.getByRole("button", { name: "Dotknij raz, aby ekran nie gasł" });
    wl.ctl.allow = true;
    await userEvent.click(hint);
    expect(screen.queryByTestId("screen-on-tap")).toBeNull();
    expect(screenWake.getState()).toMatchObject({ held: true, waiting: false });
    await act(() => screenWake.want("online", false));
  });

  it("is hidden where the phone can't keep the screen on", async () => {
    vi.resetModules();
    const { ScreenOnToggle } = await import("../../src/components/ScreenOn");
    const { I18nProvider } = await import("../../src/i18n");
    render(
      <I18nProvider lang="en">
        <ScreenOnToggle />
      </I18nProvider>
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
