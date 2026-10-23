import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { applyTheme, readThemePref } from "./services/theme";
import { AppStore } from "./state/store";
import "@fontsource-variable/geist";
import "./styles/theme.css";

// Appearance before the first paint (V50): the fixed choice on <html>, the meta colour of the mode.
applyTheme(readThemePref());

const store = new AppStore();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>
);

// Installable PWA with an offline shell (FR-071); updates apply on the next launch.
if ("serviceWorker" in navigator && import.meta.env.PROD) registerSW({ immediate: true });
