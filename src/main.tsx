import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { applyTheme, readThemePref } from "./services/theme";
import { AppStore, captureAuthReturn } from "./state/store";
import "@fontsource-variable/geist";
import "./styles/theme.css";

// Appearance before the first paint (V50): the fixed choice on <html>, the meta colour of the mode.
applyTheme(readThemePref());

// 2.12: what a Google sign-in left in the address, kept before supabase-js reads and removes it.
captureAuthReturn();

const store = new AppStore();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>
);

// Installable PWA with an offline shell (FR-071). 2.9: an installed app can stay in memory for days,
// so besides the launch it also looks for a new version whenever it comes back to the front (at most
// every 5 minutes) — both parties then run the same version (the same screens and icons).
const UPDATE_CHECK_MS = 5 * 60_000;
if ("serviceWorker" in navigator && import.meta.env.PROD)
  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      let checked = Date.now();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || Date.now() - checked < UPDATE_CHECK_MS) return;
        checked = Date.now();
        void reg.update().catch(() => {});
      });
    }
  });
