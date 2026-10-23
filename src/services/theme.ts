// Appearance (2.4, V50): light, dark, or the phone's own setting — this device's choice, kept in
// localStorage like the language. "system" follows `prefers-color-scheme` live; a fixed choice
// goes on `<html data-theme>`, which theme.css keys its token set on. The `theme-color` meta
// (the browser chrome / PWA status bar) always names the mode that is shown.

import { readPref, writePref } from "./device";

export type ThemePref = "system" | "light" | "dark";
export type ThemeMode = "light" | "dark";

export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];

/** The ground colour of each mode, for the `theme-color` meta (the same values as theme.css). */
export const THEME_COLOR: Record<ThemeMode, string> = { light: "#eef2f7", dark: "#0b1020" };

export const isThemePref = (v: unknown): v is ThemePref => v === "system" || v === "light" || v === "dark";

/** This device's choice; anything unknown or missing means "system". */
export function readThemePref(): ThemePref {
  const v = readPref<unknown>("theme", null);
  return isThemePref(v) ? v : "system";
}

/** "system" is the default, so it is kept as the absence of a preference. */
export function saveThemePref(pref: ThemePref): void {
  writePref("theme", pref === "system" ? null : pref);
}

export function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolvedMode(pref: ThemePref): ThemeMode {
  return pref === "system" ? (systemDark() ? "dark" : "light") : pref;
}

/** Puts the choice on `<html>` and the shown mode's colour on the `theme-color` meta. */
export function applyTheme(pref: ThemePref): ThemeMode {
  const mode = resolvedMode(pref);
  if (typeof document === "undefined") return mode;
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[mode];
  return mode;
}

/**
 * While the choice is "system", the phone switching modes re-applies the meta colour: on the
 * media query's change event, and again whenever the app comes back to the front (a phone that
 * went dark at sunset while the app was in the background, or a browser that never sent the event).
 */
export function watchSystemTheme(pref: () => ThemePref): () => void {
  const on = () => {
    if (pref() === "system") applyTheme("system");
  };
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  mq?.addEventListener?.("change", on);
  const onVisible = () => {
    if (document.visibilityState === "visible") on();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    mq?.removeEventListener?.("change", on);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
