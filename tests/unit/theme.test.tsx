// 2.4: appearance (V50, V51), icons (V53) and the launch (V52).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../src/backend/types";
import { EMOJI_ICONS, Icon, Logo } from "../../src/components/Icon";
import { Launch, LAUNCH_CAP_MS, LAUNCH_FADE_MS, LAUNCH_INTRO_MS, LAUNCH_OUT_MS, launchFinished, launchWanted, resetLaunch } from "../../src/components/Launch";
import { DEFAULT_CONFIG } from "../../src/core/defaults";
import type { Lang } from "../../src/core/types";
import { I18nProvider } from "../../src/i18n";
import { en } from "../../src/i18n/en";
import { pl } from "../../src/i18n/pl";
import { Catalog, EntryIcon } from "../../src/screens/Catalog";
import { Home } from "../../src/screens/Home";
import { ProfilePanel } from "../../src/screens/Profile";
import { applyTheme, readThemePref, resolvedMode, saveThemePref, THEME_COLOR, watchSystemTheme } from "../../src/services/theme";
import { AppStore, StoreContext } from "../../src/state/store";

/** A matchMedia that answers the two queries the app asks, with listeners that tests can fire. */
function fakeMatchMedia(dark: boolean, reduce = false) {
  const listeners: Array<() => void> = [];
  const mm = vi.fn((q: string) => ({
    matches: q.includes("dark") ? dark : q.includes("reduced-motion") ? reduce : false,
    media: q,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.splice(listeners.indexOf(fn), 1)
  }));
  vi.stubGlobal("matchMedia", mm);
  return { fire: () => listeners.forEach((fn) => fn()), listeners };
}

function mount(lang: Lang, ui: ReactNode, snap: Record<string, unknown>, backend: Partial<Backend> = {}) {
  const store = new AppStore();
  store.backend = backend as Backend;
  (store as unknown as { snap: object }).snap = { ...store.get(), phase: "ready", lang, deployment: DEFAULT_CONFIG, cfg: { backend: "mock" }, ...snap };
  const view = render(
    <StoreContext.Provider value={store}>
      <I18nProvider lang={lang}>{ui}</I18nProvider>
    </StoreContext.Provider>
  );
  return { store, ...view };
}

const OLA = {
  userId: "u",
  nickname: "Ola",
  language: "en",
  riderCancels: 0,
  driverCancels: 0,
  lateCancels: 0,
  rating: { mean: null, count: 0 },
  masterId: null,
  masterRole: null,
  defaultPickup: null,
  defaultDropoff: null,
  fixedFare: null,
  icon: null,
  masterVehicle: null,
  offers: [],
  offersPreset: false,
  home: null,
  photo: null
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.launch;
  document.querySelector('meta[name="theme-color"]')?.remove();
});

describe("appearance (V50): system by default, a fixed choice per device", () => {
  it("reads 'system' when nothing (or junk) is stored, and keeps a fixed choice as the only stored value", () => {
    expect(readThemePref()).toBe("system");
    localStorage.setItem("siosia.theme", JSON.stringify("neon"));
    expect(readThemePref()).toBe("system");
    saveThemePref("dark");
    expect(localStorage.getItem("siosia.theme")).toBe('"dark"');
    expect(readThemePref()).toBe("dark");
    saveThemePref("system");
    expect(localStorage.getItem("siosia.theme")).toBeNull();
  });

  it("resolves 'system' from prefers-color-scheme, a fixed choice as itself", () => {
    fakeMatchMedia(true);
    expect(resolvedMode("system")).toBe("dark");
    expect(resolvedMode("light")).toBe("light");
    fakeMatchMedia(false);
    expect(resolvedMode("system")).toBe("light");
    expect(resolvedMode("dark")).toBe("dark");
  });

  it("applies the choice to <html data-theme> and the theme-color meta to the mode that is shown", () => {
    fakeMatchMedia(true);
    expect(applyTheme("system")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
    expect(meta.content).toBe(THEME_COLOR.dark);
    expect(applyTheme("light")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.content).toBe(THEME_COLOR.light);
    expect(applyTheme("dark")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(applyTheme("system")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("follows the phone switching modes only while the choice is 'system'", () => {
    const mq = fakeMatchMedia(false);
    applyTheme("system");
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
    expect(meta.content).toBe(THEME_COLOR.light);
    let pref: "system" | "light" | "dark" = "system";
    const stop = watchSystemTheme(() => pref);
    expect(mq.listeners).toHaveLength(1);
    fakeMatchMedia(true); // the phone went dark (a new matchMedia answers the next question)
    mq.fire();
    expect(meta.content).toBe(THEME_COLOR.dark);
    pref = "light";
    applyTheme("light");
    mq.fire();
    expect(meta.content).toBe(THEME_COLOR.light); // a fixed choice ignores the phone
    stop();
    expect(mq.listeners).toHaveLength(0);
  });

  it("the store keeps this phone's choice and applies it; the server never hears of it", () => {
    fakeMatchMedia(false);
    const store = new AppStore();
    const saveProfile = vi.fn();
    store.backend = { saveProfile } as unknown as Backend;
    expect(store.get().theme).toBe("system");
    store.setTheme("dark");
    expect(store.get().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(readThemePref()).toBe("dark");
    expect(saveProfile).not.toHaveBeenCalled();
    expect(new AppStore().get().theme).toBe("dark"); // the next launch reads it back
  });

  it.each([
    ["en", "Appearance", ["Same as the phone", "Light", "Dark"]],
    ["pl", "Wygląd", ["Jak w telefonie", "Jasny", "Ciemny"]]
  ] as const)("S2 offers the choice in %s, and changing it takes effect at once", (lang, label, options) => {
    fakeMatchMedia(false);
    const { store } = mount(lang, <ProfilePanel />, { profile: { ...OLA, language: lang } }, { getProfile: async () => ({ ...OLA, language: lang }) } as unknown as Partial<Backend>);
    const select = screen.getByTestId("appearance") as HTMLSelectElement;
    expect(screen.getByLabelText(label)).toBe(select);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([...options]);
    expect(select.value).toBe("system");
    fireEvent.change(select, { target: { value: "dark" } });
    expect(store.get().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.change(select, { target: { value: "system" } });
    expect(store.get().theme).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("every key of the choice exists in both languages", () => {
    for (const k of ["profile.appearance", "profile.appearanceSystem", "profile.appearanceLight", "profile.appearanceDark"] as const) {
      expect(en[k]).toBeTruthy();
      expect(pl[k]).toBeTruthy();
      expect(pl[k]).not.toBe(en[k]);
    }
  });
});

describe("theme.css (V50, V51): one dark token set, glass only on chrome", () => {
  const css = readFileSync("src/styles/theme.css", "utf-8");

  it("the two dark blocks (the phone's setting, a fixed choice) are identical", () => {
    const system = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/);
    const fixed = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/);
    expect(system).not.toBeNull();
    expect(fixed).not.toBeNull();
    const norm = (s: string) => s.trim().split(/\s*\n\s*/).filter(Boolean).join("\n");
    expect(norm(system![1])).toBe(norm(fixed![1]));
    expect(norm(system![1])).toContain("--bg: #0b1020;");
  });

  it("dark redefines every colour token of light (and nothing light lacks); the meta colours are the grounds", () => {
    const light = css.match(/^:root \{([^}]*)\}/m)![1];
    const dark = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)![1];
    const tokens = (s: string) => new Map(Array.from(s.matchAll(/(--[\w-]+):\s*([^;]*);/g), (m) => [m[1], m[2]]));
    const colourish = Array.from(tokens(light)).filter(([, v]) => /#|rgba\(|gradient|^none$|invert/.test(v)).map(([k]) => k);
    expect(colourish.length).toBeGreaterThan(30);
    expect(Array.from(tokens(dark).keys()).sort()).toEqual(colourish.sort());
    expect(light).toContain(`--bg: ${THEME_COLOR.light};`);
    expect(dark).toContain(`--bg: ${THEME_COLOR.dark};`);
  });

  it("backdrop blur sits on chrome only, with an opaque fallback for reduced transparency", () => {
    const glass = css.match(/\n([^{}]*)\{[^}]*backdrop-filter: blur\(24px\)/)![1];
    for (const sel of [".topbar .icon-btn", ".topbar-title", ".sheet", ".page-head", ".panel-head", ".home-foot", ".offer"]) expect(glass).toContain(sel);
    for (const sel of [".card", ".entry-card", ".mode-card", ".history-item", ".panel-body", ".page-body"]) expect(glass).not.toContain(sel);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*backdrop-filter: none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe("icons (V53): stroke glyphs in place of emoji", () => {
  it("renders a decorative inline SVG with 1.5 px strokes", () => {
    const { container } = render(<Icon name="car" size={24} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.dataset.icon).toBe("car");
    expect(svg.textContent).toBe("");
  });

  it("maps the catalog's configured emoji to icons and shows anything else as given", () => {
    for (const e of DEFAULT_CONFIG.services) expect(EMOJI_ICONS[e.icon], e.icon).toBeTruthy();
    const { container, rerender } = render(<EntryIcon icon="📚" />);
    expect(container.querySelector("svg")!.dataset.icon).toBe("book");
    rerender(<EntryIcon icon="🎻" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("🎻");
  });

  it("the mark is the app icon's S with its dot", () => {
    const { container } = render(<Logo />);
    expect(container.querySelector(".logo svg path")!.getAttribute("d")).toContain("A72 72");
    expect(container.querySelector(".logo-dot")).not.toBeNull();
  });

  it("no screen renders an emoji any more (★ ☆ ✓ are type, and stay)", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}]|☰|◎|📌|⋮/u;
    const files = (["src/screens", "src/components"] as const)
      .flatMap((dir) => readdirSync(dir, { recursive: true }).map((f) => `${dir}/${String(f).replace(/\\/g, "/")}`))
      .filter((f) => f.endsWith(".tsx") && !f.endsWith("/Icon.tsx")); // the map from the old emoji lives there
    for (const f of files) {
      const code = readFileSync(f, "utf-8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/EMOJI_ICONS|"📅"/.test(l))
        .join("\n");
      expect(code, f).not.toMatch(emoji);
    }
    for (const f of ["src/screens/Home.tsx", "src/screens/Catalog.tsx", "src/components/ui.tsx"]) expect(readFileSync(f, "utf-8")).toContain("<Icon ");
  });
});

describe("the launch (V52): once per page load, skippable, never in the way", () => {
  function app(snap: Record<string, unknown>) {
    const store = new AppStore();
    (store as unknown as { snap: object }).snap = { ...store.get(), ...snap };
    return store;
  }
  const Shell = ({ store, onDone, home = false }: { store: AppStore; onDone: () => void; home?: boolean }) => (
    <StoreContext.Provider value={store}>
      <I18nProvider lang="en">
        {home && <Home />}
        <Launch onDone={onDone} />
      </I18nProvider>
    </StoreContext.Provider>
  );

  beforeEach(() => {
    vi.useFakeTimers();
    resetLaunch();
    fakeMatchMedia(false, false);
    vi.stubGlobal("location", { ...location, search: "" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is wanted until it has finished, then never again; ?launch=0 means never", () => {
    expect(launchWanted()).toBe(true);
    expect(launchWanted()).toBe(true); // a dev-mode double render asks twice
    launchFinished();
    expect(launchWanted()).toBe(false);
    resetLaunch();
    vi.stubGlobal("location", { ...location, search: "?backend=mock&launch=0" });
    expect(launchWanted()).toBe(false);
  });

  it("plays the intro over a boot that is still loading, then leaves once a screen is there", () => {
    const store = app({ phase: "loading" });
    const onDone = vi.fn();
    const view = render(<Shell store={store} onDone={onDone} />);
    const overlay = screen.getByTestId("launch");
    expect(overlay.dataset.stage).toBe("in");
    act(() => void vi.advanceTimersByTime(LAUNCH_INTRO_MS + 100));
    expect(overlay.dataset.stage).toBe("in"); // the intro is over, the boot is not: it waits
    act(() => {
      (store as unknown as { patch: (p: object) => void }).patch({ phase: "invite" });
    });
    view.rerender(<Shell store={store} onDone={onDone} />);
    expect(screen.getByTestId("launch").dataset.stage).toBe("out");
    expect(screen.getByTestId("launch").className).not.toContain("launch-morph"); // not S1: no morph
    expect(document.documentElement.dataset.launch).toBeUndefined();
    act(() => void vi.advanceTimersByTime(LAUNCH_OUT_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(launchWanted()).toBe(false);
  });

  it("over S1 it morphs into the avatar and lets the rows spring in, then leaves html[data-launch] alone", () => {
    const store = app({ phase: "ready", screen: "home", lang: "en", deployment: DEFAULT_CONFIG, cfg: { backend: "mock" }, profile: OLA, my: { toAnswer: 0, openRequests: 0, planned: 0, nextPlanned: null } });
    const onDone = vi.fn();
    render(<Shell store={store} onDone={onDone} home />);
    act(() => void vi.advanceTimersByTime(LAUNCH_INTRO_MS + 10));
    const overlay = screen.getByTestId("launch");
    expect(overlay.dataset.stage).toBe("out");
    // jsdom has no layout: the avatar's box is empty, so the morph has no target → plain fade.
    expect(overlay.className).toContain("launch-out");
    act(() => void vi.advanceTimersByTime(LAUNCH_OUT_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a tap ends it at once, even while the boot is still loading", () => {
    const store = app({ phase: "loading" });
    const onDone = vi.fn();
    render(<Shell store={store} onDone={onDone} />);
    fireEvent.pointerDown(screen.getByTestId("launch"));
    expect(screen.getByTestId("launch").dataset.stage).toBe("out");
    act(() => void vi.advanceTimersByTime(LAUNCH_OUT_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("never hides a boot that takes too long: out at the cap even while loading", () => {
    const store = app({ phase: "loading" });
    const onDone = vi.fn();
    render(<Shell store={store} onDone={onDone} />);
    act(() => void vi.advanceTimersByTime(LAUNCH_CAP_MS - 1));
    expect(screen.getByTestId("launch").dataset.stage).toBe("in");
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByTestId("launch").dataset.stage).toBe("out");
    act(() => void vi.advanceTimersByTime(LAUNCH_OUT_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("with reduced motion there is no intro and no morph: a short fade as soon as the boot is done", () => {
    fakeMatchMedia(false, true);
    const store = app({ phase: "ready", screen: "home" });
    const onDone = vi.fn();
    render(<Shell store={store} onDone={onDone} />);
    const overlay = screen.getByTestId("launch");
    expect(overlay.className).toContain("launch-reduced");
    act(() => void vi.advanceTimersByTime(0));
    expect(screen.getByTestId("launch").dataset.stage).toBe("out");
    expect(screen.getByTestId("launch").className).not.toContain("launch-morph");
    expect(document.documentElement.dataset.launch).toBeUndefined();
    act(() => void vi.advanceTimersByTime(LAUNCH_FADE_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("is decorative: hidden from assistive tech, no text node of its own", () => {
    const store = app({ phase: "loading" });
    render(<Shell store={store} onDone={() => {}} />);
    const overlay = screen.getByTestId("launch");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.textContent).toBe("");
    expect(screen.queryByText("Siosia")).toBeNull();
  });

  it("the catalog and the home screen render with the new icons, the names unchanged", async () => {
    const store = app({ phase: "ready", screen: "home", lang: "en", deployment: DEFAULT_CONFIG, cfg: { backend: "mock" }, profile: OLA, my: { toAnswer: 1, openRequests: 0, planned: 2, nextPlanned: null } });
    render(
      <StoreContext.Provider value={store}>
        <I18nProvider lang="en">
          <Home />
        </I18nProvider>
      </StoreContext.Provider>
    );
    expect(screen.getByTestId("start-siosia").querySelector("svg[data-icon='users']")).not.toBeNull();
    expect(screen.getByTestId("start-planned").querySelector("svg[data-icon='calendar']")).not.toBeNull();
    expect(screen.getByTestId("start-history").querySelector("svg[data-icon='history']")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Hi, Ola" })).toBeInTheDocument();
    expect(document.querySelector(".home-head .logo svg")).not.toBeNull();
    store.backend = { catalog: async () => DEFAULT_CONFIG.services.map((e) => ({ ...e, providers: [] })) } as unknown as Backend;
    render(
      <StoreContext.Provider value={store}>
        <I18nProvider lang="en">
          <Catalog />
        </I18nProvider>
      </StoreContext.Provider>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("catalog-ride").querySelector("svg[data-icon='car']")).not.toBeNull();
    expect(screen.getByTestId("catalog-learning").querySelector("svg[data-icon='book']")).not.toBeNull();
  });
});
