import { defineConfig, devices } from "@playwright/test";

// Siosia E2E (spec §11 "End-to-end"): builds the app forced onto the in-browser MOCK backend and
// drives the P1 stories with two pages of one browser context (rider + driver) and mocked
// geolocation. The mock keeps state in localStorage and talks over BroadcastChannel, so the pages
// must share a context; each page has its own sessionStorage, i.e. its own user. No credentials.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    geolocation: { latitude: 52.2297, longitude: 21.0122, accuracy: 10 },
    permissions: ["geolocation"],
    locale: "en-GB"
  },
  projects: [{ name: "mobile-chromium", use: { ...devices["Pixel 7"] } }],
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { VITE_BACKEND: "mock" }
  }
});
