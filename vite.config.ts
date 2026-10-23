import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// BASE_PATH "./" keeps every asset path relative, so the same build works on any static host,
// including a GitHub Pages sub-path (D-01). Override with an absolute path if a host needs it.
const base = process.env.BASE_PATH || "./";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"],
      manifest: {
        name: "Siosia",
        short_name: "Siosia",
        description: "Ride or drive — one link, no app store.",
        theme_color: "#0b1020",
        background_color: "#0b1020",
        display: "standalone",
        orientation: "portrait",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
        ]
      },
      workbox: {
        // App shell only. Tiles, routing, geocoding and the backend are always network (D-03: no
        // offline tile storage). config.json is never cached so operators can change it live.
        // woff2: the bundled Geist font (2.4), so the installed app has its type offline too.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,woff2}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/config\.json$/, /guide\.html$/],
        // A new version takes over at once instead of waiting until every tab is closed.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Web Push: show notifications and open the app on tap (public/push-sw.js).
        importScripts: ["push-sw.js"],
        runtimeCaching: []
      }
    })
  ],
  build: {
    target: "es2020",
    sourcemap: false,
    chunkSizeWarningLimit: 600
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["tests/unit/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"]
  }
});
