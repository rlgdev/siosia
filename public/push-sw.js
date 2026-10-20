/* global self, URL */
// Web Push for Siosia — imported into the generated service worker (vite.config.ts → importScripts).
// Shows what the push-dispatch Edge Function sent ({title, body, tag, url}); tapping the
// notification focuses the open app or opens it. iOS requires every push to show a notification.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Siosia", {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: data.url || "./" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows)
        if (w.url.startsWith(self.registration.scope) && "focus" in w) {
          // The app is open: bring it to the front and show the screen the notification is about.
          w.postMessage({ type: "siosia-open", url });
          return w.focus();
        }
      return self.clients.openWindow(url);
    })()
  );
});
